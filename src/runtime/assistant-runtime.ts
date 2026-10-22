import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentOptions,
  type AgentSetup,
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
  AssistantMemory,
  AssistantSession,
  AssistantSnapshot,
  AssistantPreview,
} from '../domain/types.js'
import type { InteractionResponseInput, PendingInteractionView } from '../transport/contracts.js'
import type { AgentTeamService } from '../service/dsh-team-mode-service.js'
import {
  registerAssistantMemoryTools,
  registerAssistantTaskTools,
  type AssistantTaskSummaryMessage,
} from './assistant-tools.js'
import { projectConversation } from './conversation-projector.js'
import { TeamInteractionBridge } from './team-interaction-bridge.js'
import type { ConversationNode } from '../transport/contracts.js'
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
  /** False when the Session is live but another lifecycle owns its handle. */
  owned: boolean
}

const TERMINAL_TASK_STATUSES: ReadonlySet<AssistantSession['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
])

const ACTIVE_TASK_STATUSES: ReadonlySet<AssistantSession['status']> = new Set([
  'queued',
  'running',
  'needs_input',
])

const DEFAULT_WORKER_CONCURRENCY = 4
const DIGEST_ACTIVE_LIMIT = 5
const DIGEST_TERMINAL_LIMIT = 3
const DIGEST_TITLE_LIMIT = 80

const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const MAX_WAIT_TIMEOUT_MS = 120_000
const WAIT_POLL_MS = 250
const SUMMARY_MESSAGE_LIMIT = 1_200
const SUMMARY_TEXT_LIMIT = 4_000
const ERROR_TEXT_LIMIT = 2_000
const MEMORY_PROMPT_LIMIT = 4_000

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
  private readonly startingWorkers = new Map<string, Promise<OwnedWorker>>()
  private readonly assistantLocks = new Map<string, Promise<void>>()
  private readonly interactionSessions = new Set<string>()
  private readonly interactions: TeamInteractionBridge
  private readonly disposeStatusListener: () => void
  private readonly disposeSessionListener: () => void
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly service: AgentTeamService,
  ) {
    this.interactions = new TeamInteractionBridge(ctx, {
      acceptsSession: sessionId => this.interactionSessions.has(sessionId),
      onChange: sessionId => {
        const taskId = this.workerBySession.get(sessionId)
          ?? this.service.listAssistantSessions().items.find(task => task.sessionId === sessionId)?.id
        if (taskId !== undefined) this.service.notifyAssistantTaskChanged(taskId)
      },
    })
    this.disposeStatusListener = ctx.on('agent/status', ({ agent, status }) => {
      const taskId = this.workerBySession.get(String(agent.id))
      if (taskId === undefined || this.closing) return
      // DSH 0.2.1 declares AgentStatus as only 'idle' | 'running'. Compare the
      // string form so a newer harness that adds 'waiting_approval' maps to the
      // truthful needs_input state without a type-only break here.
      const observed = String(status)
      if (observed === 'waiting_approval') {
        void this.markTaskNeedsInput(taskId).catch(error => {
          this.ctx.logger.warn('dsh-team-mode: failed to record worker waiting status', error)
        })
        return
      }
      if (observed === 'running') {
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
    await this.interactions.dispose()
    this.interactionSessions.clear()
    const pending = [...this.starting.values(), ...this.startingWorkers.values()]
    this.starting.clear()
    this.startingWorkers.clear()
    await Promise.allSettled(pending)
    const workers = [...this.workers.values()]
    this.workers.clear()
    this.workerBySession.clear()
    for (const worker of workers) {
      // A passive worker is live in another lifecycle; this runtime never
      // owns that AgentHandle, so it must not cancel or dispose it.
      if (!worker.owned) continue
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
    return this.withAssistantLock(assistantId, async () => {
      const instance = this.service.getAssistantInstance(assistantId)
      const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(instance.workspaceId))
      if (workspace === undefined || await workspace.status() !== 'ok') {
        throw new AgentTeamError(
          'WORKSPACE_UNAVAILABLE',
          `Workspace '${instance.workspaceId}' is unavailable`,
        )
      }
      this.assertWorkerCapacity(assistantId)

      const snapshot = instance.assistantSnapshot
      const taskId = randomUUID()
      const sessionId = `session-${randomUUID()}`
      const setup = this.workerSetup(assistantId, taskId, title)

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
        this.mapWorker(task.id, {
          assistantId: instance.id,
          sessionId,
          handle,
          owned: true,
        })
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
    })
  }

  /**
   * Open one stored task's worker Session by task id. The worker is resumed when
   * it is no longer live, so opening a completed or restarted task reattaches
   * instead of failing. Task status is intentionally left untouched.
   */
  async openTask(rawTaskId: string): Promise<{ task: AssistantSession; sessionId: string }> {
    const taskId = requireText(rawTaskId, 'Task id')
    const task = this.service.getAssistantSession(taskId)
    const worker = await this.ensureWorker(task)
    return { task, sessionId: worker.sessionId }
  }

  /** Deliver another instruction to a live worker and mark its task running. */
  async sendTask(
    rawAssistantId: string,
    rawTaskId: string,
    rawMessage: string,
  ): Promise<AssistantSession> {
    const assistantId = requireText(rawAssistantId, 'Assistant instance id')
    const task = this.requireTask(assistantId, rawTaskId)
    const message = requireText(rawMessage, 'Task message')
    const worker = await this.ensureWorker(task)
    worker.handle.agent.followup(workerMessage(message))
    return this.service.updateAssistantSession(task.id, { status: 'running' })
  }

  /**
   * Return an owned worker for one stored task. A host restart or plugin
   * reload drops the handle while the Session may still exist, so the task is
   * resumed lazily instead of being reported as inactive.
   */
  /**
   * Latest visible message in the instance's main Session, used by the
   * Sidebar's one-line preview. Reads a live Session or its durable log; an
   * unreadable or empty Session simply has no preview.
   */
  async latestPreview(assistantId: string): Promise<AssistantPreview | undefined> {
    const instance = this.service.getAssistantInstance(assistantId)
    const sessionId = instance.mainSessionId
    if (sessionId === undefined) return undefined
    const live = this.ctx.agents.get(SessionId(sessionId))
    const events = live !== undefined
      ? live.session.snapshotEvents()
      : await readStoredSessionEvents(this.ctx, sessionId)
    const nodes = projectConversation(events, 80).nodes
    const isVisible = (entry: ConversationNode): entry is Extract<ConversationNode, { kind: 'user' | 'assistant' }> => (
      (entry.kind === 'user' || entry.kind === 'assistant') && entry.text.trim() !== ''
    )
    const visible = [...nodes].reverse().filter(isVisible)
    const node = visible.find(entry => entry.kind === 'assistant') ?? visible.find(entry => entry.kind === 'user')
    if (node === undefined) return undefined
    const text = node.text.replace(/\s+/g, ' ').trim().slice(0, 160)
    return text === '' ? undefined : { role: node.kind, text, time: node.time }
  }

  /** Pending human interactions raised by one hidden worker task. */
  async taskInteractions(taskId: string): Promise<PendingInteractionView[]> {
    const task = this.service.getAssistantSession(taskId)
    if (!this.interactionSessions.has(task.sessionId)) return []
    return this.interactions.list(task.sessionId)
  }

  /** Resolve one pending approval/question from the Assistant sidebar. */
  async respondTaskInteraction(
    taskId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    const task = this.service.getAssistantSession(taskId)
    await this.interactions.respond(task.sessionId, interactionId, response)
    await this.markTaskRunning(taskId)
  }

  private async ensureWorker(task: AssistantSession): Promise<OwnedWorker> {
    const existing = this.workers.get(task.id)
    if (existing !== undefined) return existing
    const pending = this.startingWorkers.get(task.id)
    if (pending !== undefined) return pending
    const starting = this.recoverWorker(task)
    this.startingWorkers.set(task.id, starting)
    try {
      return await starting
    } finally {
      if (this.startingWorkers.get(task.id) === starting) {
        this.startingWorkers.delete(task.id)
      }
    }
  }

  private async recoverWorker(task: AssistantSession): Promise<OwnedWorker> {
    if (this.closing) throw new AgentTeamError('INVALID_REQUEST', 'Assistant runtime is closing')
    const live = this.ctx.agents.get(SessionId(task.sessionId))
    if (live !== undefined) {
      // Another lifecycle created this worker and still owns its handle. Use
      // the bare Agent for follow-ups, but never claim teardown ownership.
      this.ctx.logger.warn(
        `dsh-team-mode: task '${task.id}' is already live without an owned worker handle; attaching passively`,
      )
      const worker: OwnedWorker = {
        assistantId: task.assistantId,
        sessionId: task.sessionId,
        handle: { agent: live, dispose: async () => {} },
        owned: false,
      }
      this.mapWorker(task.id, worker)
      return worker
    }

    const instance = this.service.getAssistantInstance(task.assistantId)
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(instance.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError(
        'WORKSPACE_UNAVAILABLE',
        `Workspace '${instance.workspaceId}' is unavailable`,
      )
    }

    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(task.sessionId),
        agentOptions: agentOptionsFor(instance.assistantSnapshot),
        setup: this.workerSetup(task.assistantId, task.id, task.title),
      })
    } catch (error) {
      const causeMessage = error instanceof Error ? error.message : String(error)
      throw new AgentTeamError(
        'ASSISTANT_TASK_NOT_ACTIVE',
        `Task '${task.title}' could not be resumed: ${causeMessage}`,
        { taskId: task.id, cause: causeMessage },
        { cause: error },
      )
    }

    try {
      await workspace.attachSession(SessionId(task.sessionId))
      await this.ctx.sessions.flush(handle.agent.session)
    } catch (error) {
      await this.disposeQuietly(handle, `resumed worker Session '${task.sessionId}' failed to attach`)
      throw this.workerStartupError(instance, task.title, error)
    }

    const worker: OwnedWorker = {
      assistantId: task.assistantId,
      sessionId: task.sessionId,
      handle,
      owned: true,
    }
    this.mapWorker(task.id, worker)
    return worker
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
    await this.releaseWorker(task.id, 'cancelled')
    return cancelled
  }

  /**
   * Stop every active worker of one Assistant before its instance is archived.
   * Tasks are marked cancelled so a later idle transition cannot resurrect them;
   * only workers this runtime owns are interrupted, and the main Session is
   * never touched by this method.
   */
  async stopForArchive(rawAssistantId: string): Promise<void> {
    const assistantId = requireText(rawAssistantId, 'Assistant instance id')
    await this.withAssistantLock(assistantId, async () => {
      const tasks = this.service.listAssistantSessions(assistantId).items
      for (const task of tasks) {
        if (!ACTIVE_TASK_STATUSES.has(task.status)) continue
        try {
          await this.service.updateAssistantSession(task.id, { status: 'cancelled' })
        } catch (error) {
          this.ctx.logger.warn(
            `dsh-team-mode: failed to cancel task '${task.id}' while archiving assistant '${assistantId}'`,
            error,
          )
          continue
        }
        const worker = this.workers.get(task.id)
        if (worker !== undefined && worker.owned) {
          try {
            worker.handle.agent.cancel({ kind: 'user' })
            await worker.handle.agent.whenIdle()
          } catch (error) {
            this.ctx.logger.warn(
              `dsh-team-mode: failed to cancel worker '${task.id}' while archiving assistant '${assistantId}'`,
              error,
            )
          }
        }
        await this.releaseWorker(task.id, 'archived')
      }
    })
  }

  /**
   * Release a terminal worker: flush its Session log, drop every runtime map
   * entry, and dispose the handle only when this runtime created it. A passive
   * worker belongs to another lifecycle, so it is detached but never disposed.
   */
  private async releaseWorker(taskId: string, reason: string): Promise<void> {
    this.startingWorkers.delete(taskId)
    const worker = this.workers.get(taskId)
    if (worker === undefined) return
    this.workers.delete(taskId)
    this.workerBySession.delete(worker.sessionId)
    this.interactionSessions.delete(worker.sessionId)
    this.interactions.forget(worker.sessionId)
    try {
      await this.ctx.sessions.flush(worker.handle.agent.session)
    } catch (error) {
      this.ctx.logger.warn(
        `dsh-team-mode: failed to flush worker Session for task '${taskId}' (${reason})`,
        error,
      )
    }
    if (!worker.owned) return
    await this.disposeQuietly(
      worker.handle,
      `failed to dispose worker Session for task '${taskId}' (${reason})`,
    )
  }

  private async markTaskRunning(taskId: string): Promise<void> {
    if (this.closing) return
    const task = this.service.getAssistantSession(taskId)
    if (task.status === 'running' || isTerminalTaskStatus(task.status)) return
    // This also resumes a needs_input task after an approval is granted.
    await this.service.updateAssistantSession(taskId, { status: 'running' })
  }

  /**
   * A worker waiting for an approval is genuinely blocked on the user. Mark it
   * needs_input so lists, the prompt digest, and capacity checks stay truthful;
   * this runtime still renders no custom approval UI.
   */
  private async markTaskNeedsInput(taskId: string): Promise<void> {
    if (this.closing) return
    const task = this.service.getAssistantSession(taskId)
    if (task.status === 'needs_input' || isTerminalTaskStatus(task.status)) return
    await this.service.updateAssistantSession(taskId, { status: 'needs_input' })
  }

  private async markTaskIdle(taskId: string): Promise<void> {
    if (this.closing) return
    const task = this.service.getAssistantSession(taskId)
    // An idle worker can be waiting for an approval that the main Session has
    // not resolved yet. Do not turn that into a false completion.
    if (task.status === 'needs_input') return
    if (task.status !== 'running' && task.status !== 'queued') return
    await this.service.updateAssistantSession(taskId, { status: 'completed' })
    await this.releaseWorker(taskId, 'completed')
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
    await this.releaseWorker(taskId, 'failed')
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

  private mapWorker(taskId: string, worker: OwnedWorker): void {
    this.workers.set(taskId, worker)
    this.workerBySession.set(worker.sessionId, taskId)
  }

  private assertWorkerCapacity(assistantId: string): void {
    const limit = this.workerConcurrencyLimit()
    const active = this.service.listAssistantSessions(assistantId).items
      .filter(task => ACTIVE_TASK_STATUSES.has(task.status))
      .length
    if (active < limit) return
    throw new AgentTeamError(
      'ASSISTANT_WORKER_LIMIT',
      `Assistant '${assistantId}' already has ${active} active worker task(s); the limit is ${limit}`,
      { assistantId, active, limit },
    )
  }

  private workerConcurrencyLimit(): number {
    const configured = this.config.assistantWorkerConcurrency
    if (configured === undefined || !Number.isFinite(configured)) {
      return DEFAULT_WORKER_CONCURRENCY
    }
    return Math.min(Math.max(Math.floor(configured), 1), 16)
  }

  /**
   * Serialize task creation per assistant so the capacity check and the new
   * task record cannot race against a second create call.
   */
  private async withAssistantLock<T>(
    assistantId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.assistantLocks.get(assistantId) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.assistantLocks.set(assistantId, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.assistantLocks.get(assistantId) === tail) {
        this.assistantLocks.delete(assistantId)
      }
    }
  }

  private workerSetup(assistantId: string, taskId: string, title: string): AgentSetup {
    const snapshot = this.service.getAssistantInstance(assistantId).assistantSnapshot
    const modelSelection = modelSelectionFor(snapshot)
    return async (agentCtx: Context, agent: Agent): Promise<void> => {
      const sessionId = String(agent.session.id)
      if (typeof agentCtx.on === 'function') {
        this.interactionSessions.add(sessionId)
        this.interactions.attachAgent(agentCtx, sessionId)
      }
      await this.ctx.agentPresets.mount(agentCtx, snapshot.agentPresetId)
      installModelSelection(agentCtx, modelSelection)
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-worker-memory:${taskId}`,
        order: 9,
        text: () => memoryPrompt(this.service.getAssistantMemory(assistantId), 'worker'),
      })
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-worker:${taskId}`,
        order: 10,
        text: () => workerPrompt(
          this.service.getAssistantInstance(assistantId).assistantSnapshot,
          title,
        ),
      })
      this.ctx.permissionPresets.set(agent.session, snapshot.permissionPresetId)
      // Deliberately no registerAssistantTaskTools or registerAssistantMemoryTools:
      // workers cannot delegate and cannot mutate the shared memory note.
    }
  }

  /**
   * Bounded task status for the main prompt, so routing decisions can see the
   * latest active and finished titles without reading any transcript.
   */
  private taskDigest(assistantId: string): string {
    const tasks = this.service.listAssistantSessions(assistantId).items
    const active = tasks
      .filter(task => ACTIVE_TASK_STATUSES.has(task.status))
      .slice(0, DIGEST_ACTIVE_LIMIT)
    const terminal = tasks
      .filter(task => isTerminalTaskStatus(task.status))
      .slice(0, DIGEST_TERMINAL_LIMIT)
    const lines = ['Background task routing:']
    if (active.length === 0) {
      lines.push('Active tasks: none.')
    } else {
      lines.push('Active tasks (newest first):')
      for (const task of active) {
        lines.push(`- [${task.status}] ${truncate(task.title, DIGEST_TITLE_LIMIT)} (id: ${task.id})`)
      }
    }
    if (terminal.length > 0) {
      lines.push('Recently finished tasks (newest first):')
      for (const task of terminal) {
        lines.push(`- [${task.status}] ${truncate(task.title, DIGEST_TITLE_LIMIT)} (id: ${task.id})`)
      }
    }
    lines.push(
      'Routing fallback: answer simple one-step requests directly in this main Session. '
      + 'Use a worker only for multi-step, background, or parallel work. If a request is '
      + 'ambiguous or missing a concrete deliverable, ask the user a clarifying question '
      + 'instead of creating a worker.',
    )
    lines.push(
      'Use assistant_task_list to inspect tasks, assistant_task_create to start a new deliverable, '
      + 'assistant_task_send to continue an existing task, and assistant_task_wait or '
      + 'assistant_task_summary to observe results. Create a new worker for a genuinely new '
      + 'deliverable; continue the existing worker when the user says "continue" or refers to '
      + 'earlier work. Only claim a task is complete after assistant_task_wait or '
      + 'assistant_task_summary reports a terminal status.',
    )
    return lines.join('\n')
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
        // Another lifecycle owns this live Agent: a still-draining previous
        // plugin, or the native session controller resuming the persisted
        // Session. `ctx.agents.get()` hands back a bare Agent whose setup has
        // already run, so the assistant tools, memory note, and model selection
        // cannot be reattached, and this runtime must never dispose an Agent it
        // does not own. Opening it anyway would yield a tool-less assistant, so
        // fail explicitly: the open is retryable once that owner releases the
        // Session.
        throw new AgentTeamError(
          'AGENT_HANDLE_OWNERSHIP_CONFLICT',
          `Assistant '${instance.id}' main Session '${boundSessionId}' is live under another lifecycle; retry after a reloading plugin releases it, or restart the DSH host if native ownership persists`,
          { instanceId: instance.id, sessionId: boundSessionId },
        )
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
        name: `dsh-team-mode:assistant-memory:${instance.id}`,
        order: 9,
        text: () => memoryPrompt(this.service.getAssistantMemory(id), 'main'),
      })
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-identity:${instance.id}`,
        order: 10,
        text: () => assistantPrompt(this.service.getAssistantInstance(id).assistantSnapshot),
      })
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-tasks:${instance.id}`,
        order: 11,
        text: () => this.taskDigest(id),
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
      registerAssistantMemoryTools(agentCtx, {
        assertIdentity: agent => { this.assertMainToolIdentity(id, agent) },
        readMemory: () => this.service.getAssistantMemory(id),
        writeMemory: input => this.service.writeAssistantMemory(id, input.content, input.mode),
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
 * Durable memory is injected before identity so every turn starts from the same
 * shared note. The stored document may hold 16k characters, but only a 4k
 * excerpt enters the prompt to keep the context bounded.
 */
function memoryPrompt(memory: AssistantMemory | undefined, role: 'main' | 'worker'): string {
  const intro = role === 'main'
    ? 'Durable assistant memory: a short persistent note shared by every Session of this assistant. Use assistant_memory_read and assistant_memory_write to inspect or update it. Keep it to lasting preferences and facts, not transcripts.'
    : 'Durable assistant memory: a short persistent note shared by every Session of this assistant and maintained by its main Session. Treat it as background context; this worker cannot change it.'
  const content = memory?.content.trim() ?? ''
  if (content === '') return `${intro}\nNo memory has been saved yet.`
  return `${intro}\n${boundedText(content, MEMORY_PROMPT_LIMIT)}`
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

/** Like {@link truncate}, but the returned string never exceeds `limit`. */
function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(limit - 1, 0))}…`
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
