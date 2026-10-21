import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentOptions,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Config } from '../config.js'
import { AgentTeamError } from '../domain/errors.js'
import type {
  AssistantInstance,
  AssistantSession,
  AssistantSnapshot,
} from '../domain/types.js'
import type { AgentTeamService } from '../service/dsh-team-mode-service.js'
import { registerAssistantTaskTools, type AssistantTaskSummaryMessage } from './assistant-tools.js'
import { projectConversation } from './conversation-projector.js'
import { readStoredSessionEvents } from './session-log.js'

export interface AssistantEnsureResult {
  instance: AssistantInstance
  sessionId: string
}

export interface AssistantTaskBrief {
  title: string
  brief: string
}

export interface AssistantTaskWaitResult {
  task: AssistantSession
  timedOut: boolean
}

export interface AssistantTaskSummaryResult {
  task: AssistantSession
  summary: string
  messages: AssistantTaskSummaryMessage[]
}

interface OwnedWorker {
  assistantId: string
  sessionId: string
  handle: AgentHandle
}

const TERMINAL_TASK_STATUSES: ReadonlySet<AssistantSession['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
])

const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const MAX_WAIT_TIMEOUT_MS = 120_000
const WAIT_POLL_MS = 250
const SUMMARY_MESSAGE_LIMIT = 1_200
const SUMMARY_TEXT_LIMIT = 4_000
const ERROR_TEXT_LIMIT = 2_000

/**
 * Owns every Agent Session one Assistant instance needs: the visible main
 * Session (Phase 0) and hidden worker Sessions (Phase 1). Workers run one task
 * each and never receive the `assistant_task_*` tools, so delegation stays one
 * level deep. Worker status is projected from real `agent/status` and
 * `turn/end` events; no progress or completion event is fabricated.
 */
export class AssistantRuntime {
  private readonly owned = new Map<string, AgentHandle>()
  private readonly starting = new Map<string, Promise<AssistantEnsureResult>>()
  private readonly workers = new Map<string, OwnedWorker>()
  private readonly workerBySession = new Map<string, string>()
  private readonly disposeStatusListener: () => void
  private readonly disposeSessionListener: () => void
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly service: AgentTeamService,
  ) {
    this.disposeStatusListener = ctx.on('agent/status', ({ agent, status }) => {
      const taskId = this.workerBySession.get(String(agent.id))
      if (taskId === undefined || this.closing) return
      if (status === 'running') {
        void this.markTaskRunning(taskId).catch(error => {
          this.ctx.logger.warn('dsh-team-mode: failed to record worker running status', error)
        })
        return
      }
      void this.markTaskIdle(taskId).catch(error => {
        this.ctx.logger.warn('dsh-team-mode: failed to record worker idle status', error)
      })
    })
    this.disposeSessionListener = ctx.on('session/event', (session, event) => {
      const taskId = this.workerBySession.get(String(session.id))
      if (taskId === undefined || this.closing) return
      if (event.type !== 'turn/end' || event.data.reason.kind !== 'error') return
      void this.markTaskFailed(taskId, event.data.reason.error.message).catch(error => {
        this.ctx.logger.warn('dsh-team-mode: failed to record worker turn failure', error)
      })
    })
  }

  async ensureInstance(rawId: string): Promise<AssistantEnsureResult> {
    if (this.closing) throw new AgentTeamError('INVALID_REQUEST', 'Assistant runtime is closing')
    const id = rawId.trim()
    if (id === '') throw new AgentTeamError('INVALID_REQUEST', 'Assistant instance id cannot be empty')
    const pending = this.starting.get(id)
    if (pending !== undefined) return pending
    const started = this.start(id)
    this.starting.set(id, started)
    try {
      return await started
    } finally {
      if (this.starting.get(id) === started) this.starting.delete(id)
    }
  }

  async dispose(): Promise<void> {
    this.closing = true
    this.disposeStatusListener()
    this.disposeSessionListener()
    const pending = [...this.starting.values()]
    this.starting.clear()
    await Promise.allSettled(pending)
    const workers = [...this.workers.values()]
    this.workers.clear()
    this.workerBySession.clear()
    for (const worker of workers) {
      try {
        worker.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
        await worker.handle.dispose()
      } catch (error) {
        this.ctx.logger.warn('dsh-team-mode: failed to dispose assistant worker Session', error)
      }
    }
    const handles = [...this.owned.values()]
    this.owned.clear()
    for (const handle of handles) {
      try {
        handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
        await handle.dispose()
      } catch (error) {
        this.ctx.logger.warn('dsh-team-mode: failed to dispose assistant main Session', error)
      }
    }
  }

  /**
   * Create one hidden worker Session from the assistant snapshot and deliver
   * the brief as its first follow-up turn. The worker is attached to the same
   * workspace and flushed before any message is sent, so its Session header is
   * durable even if delivery fails.
   */
  async createTask(rawAssistantId: string, input: AssistantTaskBrief): Promise<AssistantSession> {
    if (this.closing) throw new AgentTeamError('INVALID_REQUEST', 'Assistant runtime is closing')
    const assistantId = requireText(rawAssistantId, 'Assistant instance id')
    const title = requireText(input.title, 'Task title')
    const brief = requireText(input.brief, 'Task brief')
    const main = await this.ensureInstance(assistantId)
    const instance = main.instance
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(instance.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError(
        'WORKSPACE_UNAVAILABLE',
        `Workspace '${instance.workspaceId}' is unavailable`,
      )
    }

    const snapshot = instance.assistantSnapshot
    const taskId = randomUUID()
    const sessionId = `session-${randomUUID()}`
    const modelSelection = modelSelectionFor(snapshot)
    const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, snapshot.agentPresetId)
      installModelSelection(agentCtx, modelSelection)
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-worker:${taskId}`,
        order: 10,
        text: () => workerPrompt(
          this.service.getAssistantInstance(assistantId).assistantSnapshot,
          title,
        ),
      })
      this.ctx.permissionPresets.set(agent.session, snapshot.permissionPresetId)
      // Deliberately no registerAssistantTaskTools: workers cannot delegate.
    }

    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: instance.workspacePath, agentPreset: snapshot.agentPresetId },
        agentOptions: agentOptionsFor(snapshot),
        setup,
      })
    } catch (error) {
      throw this.workerStartupError(instance, title, error)
    }

    let task: AssistantSession | undefined
    try {
      await workspace.attachSession(SessionId(sessionId))
      // Persist the empty worker Session before the task record exists, so the
      // native session directory never shows a row without a stored task.
      await this.ctx.sessions.flush(handle.agent.session)
      task = await this.service.createAssistantSession({
        assistantId: instance.id,
        sessionId,
        title,
        brief,
        parentSessionId: main.sessionId,
      })
      this.workers.set(task.id, { assistantId: instance.id, sessionId, handle })
      this.workerBySession.set(sessionId, task.id)
      const running = await this.service.updateAssistantSession(task.id, { status: 'running' })
      handle.agent.followup(workerMessage(brief))
      return running
    } catch (error) {
      if (task !== undefined) {
        this.removeWorker(task.id)
        await this.failTask(task.id, error)
      }
      await this.disposeQuietly(handle, `worker Session '${sessionId}' failed to start`)
      throw error instanceof AgentTeamError
        ? error
        : this.workerStartupError(instance, title, error)
    }
  }

  /** Deliver another instruction to a live worker and mark its task running. */
  async sendTask(
    rawAssistantId: string,
    rawTaskId: string,
    rawMessage: string,
  ): Promise<AssistantSession> {
    const assistantId = requireText(rawAssistantId, 'Assistant instance id')
    const task = this.requireTask(assistantId, rawTaskId)
    const worker = this.requireWorker(task)
    const message = requireText(rawMessage, 'Task message')
    worker.handle.agent.followup(workerMessage(message))
    return this.service.updateAssistantSession(task.id, { status: 'running' })
  }

  /** Newest-first tasks for one assistant, bounded for the tool result. */
  listTasks(rawAssistantId: string, limit?: number): AssistantSession[] {
    const assistantId = requireText(rawAssistantId, 'Assistant instance id')
    this.service.getAssistantInstance(assistantId)
    return this.service.listAssistantSessions(assistantId).items
      .slice(0, boundedLimit(limit, 20, 50))
  }

  /**
   * Bounded polling wait. A timeout returns the last observed task with
   * `timedOut: true` instead of blocking the main conversation.
   */
  async waitTask(
    rawAssistantId: string,
    rawTaskId: string,
    timeoutMs?: number,
  ): Promise<AssistantTaskWaitResult> {
    const assistantId = requireText(rawAssistantId, 'Assistant instance id')
    const task = this.requireTask(assistantId, rawTaskId)
    const timeout = normalizeTimeout(timeoutMs)
    const deadline = Date.now() + timeout
    let current = task
    while (!isTerminalTaskStatus(current.status)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await delay(Math.min(WAIT_POLL_MS, remaining))
      current = this.service.getAssistantSession(task.id)
    }
    return {
      task: current,
      timedOut: !isTerminalTaskStatus(current.status),
    }
  }

  /**
   * Project recent worker messages through the shared conversation projector,
   * persist the newest assistant text as the task result, and return a bounded
   * summary. The full worker transcript never enters the main conversation.
   */
  async summaryTask(
    rawAssistantId: string,
    rawTaskId: string,
  ): Promise<AssistantTaskSummaryResult> {
    const assistantId = requireText(rawAssistantId, 'Assistant instance id')
    const task = this.requireTask(assistantId, rawTaskId)
    const worker = this.workers.get(task.id)
    const events = worker === undefined
      ? await readStoredSessionEvents(this.ctx, task.sessionId)
      : worker.handle.agent.session.snapshotEvents()
    const projection = projectConversation(events, 80)
    const messages: AssistantTaskSummaryMessage[] = []
    for (const node of projection.nodes) {
      if (node.kind !== 'user' && node.kind !== 'assistant') continue
      const text = truncate(node.text.trim(), SUMMARY_MESSAGE_LIMIT)
      if (text !== '') messages.push({ kind: node.kind, text })
    }
    const recent = messages.slice(-8)
    const assistantText = [...recent]
      .reverse()
      .find(message => message.kind === 'assistant')
      ?.text
    const fallback = task.resultSummary
      ?? (task.error === undefined ? '' : `Task failed: ${task.error}`)
    const summary = truncate(assistantText ?? fallback, SUMMARY_TEXT_LIMIT)
    const next = summary !== '' && summary !== task.resultSummary
      ? await this.service.updateAssistantSession(task.id, { resultSummary: summary })
      : task
    return { task: next, summary, messages: recent }
  }

  /**
   * Mark the task cancelled before cancelling the live turn, so the later idle
   * transition cannot overwrite it with `completed`. A task without a live
   * worker (for example after a host restart) is still marked cancelled.
   */
  async cancelTask(rawAssistantId: string, rawTaskId: string): Promise<AssistantSession> {
    const assistantId = requireText(rawAssistantId, 'Assistant instance id')
    const task = this.requireTask(assistantId, rawTaskId)
    if (isTerminalTaskStatus(task.status)) return task
    const cancelled = await this.service.updateAssistantSession(task.id, { status: 'cancelled' })
    const worker = this.workers.get(task.id)
    if (worker !== undefined) {
      try {
        worker.handle.agent.cancel({ kind: 'user' })
        await worker.handle.agent.whenIdle()
      } catch (error) {
        this.ctx.logger.warn(`dsh-team-mode: failed to cancel worker '${task.id}' cleanly`, error)
      }
    }
    return cancelled
  }

  private async markTaskRunning(taskId: string): Promise<void> {
    if (this.closing) return
    const task = this.service.getAssistantSession(taskId)
    if (task.status === 'running' || isTerminalTaskStatus(task.status)) return
    await this.service.updateAssistantSession(taskId, { status: 'running' })
  }

  private async markTaskIdle(taskId: string): Promise<void> {
    if (this.closing) return
    const task = this.service.getAssistantSession(taskId)
    if (task.status !== 'running' && task.status !== 'queued') return
    await this.service.updateAssistantSession(taskId, { status: 'completed' })
  }

  private async markTaskFailed(taskId: string, error: unknown): Promise<void> {
    if (this.closing) return
    const task = this.service.getAssistantSession(taskId)
    if (task.status === 'cancelled') return
    const message = error instanceof Error ? error.message : String(error)
    await this.service.updateAssistantSession(taskId, {
      status: 'failed',
      error: truncate(message, ERROR_TEXT_LIMIT),
    })
  }

  private async failTask(taskId: string, error: unknown): Promise<void> {
    try {
      await this.markTaskFailed(taskId, error)
    } catch (failure) {
      this.ctx.logger.warn(`dsh-team-mode: failed to record task '${taskId}' failure`, failure)
    }
  }

  private removeWorker(taskId: string): void {
    const worker = this.workers.get(taskId)
    if (worker !== undefined) this.workerBySession.delete(worker.sessionId)
    this.workers.delete(taskId)
  }

  private requireTask(assistantId: string, rawTaskId: string): AssistantSession {
    const taskId = requireText(rawTaskId, 'Task id')
    const task = this.service.getAssistantSession(taskId)
    if (task.assistantId !== assistantId) {
      throw new AgentTeamError(
        'ASSISTANT_TASK_NOT_FOUND',
        `Task '${taskId}' does not belong to assistant '${assistantId}'`,
      )
    }
    return task
  }

  private requireWorker(task: AssistantSession): OwnedWorker {
    const worker = this.workers.get(task.id)
    if (worker === undefined) {
      throw new AgentTeamError(
        'ASSISTANT_TASK_NOT_ACTIVE',
        `Task '${task.id}' has no live worker Session in this runtime`,
      )
    }
    return worker
  }

  private assertMainToolIdentity(assistantId: string, agent: Agent | undefined): void {
    const instance = this.service.getAssistantInstance(assistantId)
    if (
      agent === undefined
      || instance.mainSessionId === undefined
      || String(agent.id) !== instance.mainSessionId
    ) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        'Assistant task tool caller identity does not match its main Session',
      )
    }
  }

  private async disposeQuietly(handle: AgentHandle, context: string): Promise<void> {
    try {
      await handle.dispose()
    } catch (error) {
      this.ctx.logger.warn(`dsh-team-mode: ${context}`, error)
    }
  }

  private async start(id: string): Promise<AssistantEnsureResult> {
    const instance = this.service.getAssistantInstance(id)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${id}' is archived`,
      )
    }
    const boundSessionId = instance.mainSessionId
    if (boundSessionId !== undefined) {
      if (this.owned.has(boundSessionId)) {
        return { instance, sessionId: boundSessionId }
      }
      if (this.ctx.agents.get(SessionId(boundSessionId)) !== undefined) {
        // A previous plugin lifecycle can leave the main Agent live without
        // this instance's handle (for example a dev plugin reload). Phase 0
        // only needs navigation, so open the existing native Session instead
        // of blocking the Assistant row; no new Agent is created and this
        // runtime does not claim teardown ownership for it.
        this.ctx.logger.warn(
          `dsh-team-mode: assistant '${instance.id}' is already live without an owned handle; opening it passively`,
        )
        return { instance, sessionId: boundSessionId }
      }
    }

    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(instance.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError(
        'WORKSPACE_UNAVAILABLE',
        `Workspace '${instance.workspaceId}' is unavailable`,
      )
    }

    const sessionId = boundSessionId ?? `session-${randomUUID()}`
    const snapshot = instance.assistantSnapshot
    const modelSelection = modelSelectionFor(snapshot)
    const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, snapshot.agentPresetId)
      installModelSelection(agentCtx, modelSelection)
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-identity:${instance.id}`,
        order: 10,
        text: () => assistantPrompt(this.service.getAssistantInstance(id).assistantSnapshot),
      })
      this.ctx.permissionPresets.set(agent.session, snapshot.permissionPresetId)
      registerAssistantTaskTools(agentCtx, {
        assertIdentity: agent => { this.assertMainToolIdentity(id, agent) },
        createTask: input => this.createTask(id, input),
        sendTask: (taskId, message) => this.sendTask(id, taskId, message),
        listTasks: limit => this.listTasks(id, limit),
        waitTask: (taskId, timeoutMs) => this.waitTask(id, taskId, timeoutMs),
        summaryTask: taskId => this.summaryTask(id, taskId),
        cancelTask: taskId => this.cancelTask(id, taskId),
      })
    }
    const agentOptions = agentOptionsFor(snapshot)

    let handle: AgentHandle
    try {
      handle = boundSessionId === undefined
        ? await this.ctx.agents.create({
          sessionId: SessionId(sessionId),
          meta: { cwd: instance.workspacePath, agentPreset: snapshot.agentPresetId },
          agentOptions,
          setup,
        })
        : await this.ctx.agents.resume({
          resumeSessionId: SessionId(boundSessionId),
          agentOptions,
          setup,
        })
    } catch (error) {
      throw this.startupError(instance, error)
    }

    try {
      await workspace.attachSession(SessionId(sessionId))
      // Persist the Session header immediately: a freshly created Session has
      // no event yet, and the native session browser cannot reveal a Session
      // the Host has never written.
      await this.ctx.sessions.flush(handle.agent.session)
      const bound = await this.service.bindAssistantMainSession(id, sessionId)
      this.owned.set(sessionId, handle)
      return { instance: bound, sessionId }
    } catch (error) {
      try {
        await handle.dispose()
      } catch (disposeError) {
        this.ctx.logger.warn(
          `dsh-team-mode: failed to dispose assistant Session '${sessionId}' after startup failure`,
          disposeError,
        )
      }
      throw this.startupError(instance, error)
    }
  }

  private startupError(instance: AssistantInstance, error: unknown): AgentTeamError {
    if (error instanceof AgentTeamError) return error
    const causeMessage = error instanceof Error ? error.message : String(error)
    return new AgentTeamError(
      'SESSION_CREATE_FAILED',
      `Assistant '${instance.assistantSnapshot.name}' main Session failed: ${causeMessage}`,
      { instanceId: instance.id, cause: causeMessage },
      { cause: error },
    )
  }

  private workerStartupError(
    instance: AssistantInstance,
    title: string,
    error: unknown,
  ): AgentTeamError {
    if (error instanceof AgentTeamError) return error
    const causeMessage = error instanceof Error ? error.message : String(error)
    return new AgentTeamError(
      'SESSION_CREATE_FAILED',
      `Assistant '${instance.assistantSnapshot.name}' task '${title}' failed to start: ${causeMessage}`,
      { instanceId: instance.id, cause: causeMessage },
      { cause: error },
    )
  }
}

/**
 * Phase 0 keeps the prompt to the assistant's stable identity. Task tools and
 * their delegation contract are described by each tool definition.
 */
function assistantPrompt(snapshot: AssistantSnapshot): string {
  const instructions = snapshot.instructions.trim()
  const identity = `You are ${snapshot.name}, a persistent assistant for one workspace.`
  return instructions === '' ? identity : `${identity}\n\n${instructions}`
}

/**
 * A worker is the same assistant but with a deliberately narrower role: one
 * hidden task, no delegation tools, and no direct contact with the user.
 */
function workerPrompt(snapshot: AssistantSnapshot, title: string): string {
  const instructions = snapshot.instructions.trim()
  const identity = `You are ${snapshot.name}, working as a hidden background worker Session on the task “${title}”. The user talks to the assistant's main Session and never sees this Session directly; your final answer is summarized back to that main conversation. Work only on this task, do not ask the user questions, and do not delegate to other Sessions.`
  return instructions === '' ? identity : `${identity}\n\n${instructions}`
}

function workerMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function modelSelectionFor(snapshot: AssistantSnapshot): ModelSelectionRef {
  return {
    current: {
      provider: snapshot.provider,
      model: snapshot.model,
      ...(snapshot.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(snapshot.reasoningEffort) }),
    },
    assembled: undefined,
  }
}

function agentOptionsFor(snapshot: AssistantSnapshot): AgentOptions {
  return {
    provider: snapshot.provider,
    model: snapshot.model,
    ...(snapshot.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(snapshot.reasoningEffort) }),
  }
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new AgentTeamError('INVALID_REQUEST', `${label} cannot be empty`)
  return trimmed
}

function isTerminalTaskStatus(status: AssistantSession['status']): boolean {
  return TERMINAL_TASK_STATUSES.has(status)
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_WAIT_TIMEOUT_MS
  return Math.min(Math.max(Math.floor(value), 0), MAX_WAIT_TIMEOUT_MS)
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), 1), max)
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
