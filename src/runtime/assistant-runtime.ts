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
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import type { Config } from '../config.js'
import { AgentTeamError } from '../domain/errors.js'
import {
  MEMORY_ASK_MAX_TEXT_CHARS,
  MEMORY_ASK_MAX_TOKENS,
  MEMORY_ASK_SYSTEM_PROMPT,
  memoryAskPrompt,
  parseMemoryAskReply,
  type MemoryAskResult,
  type MemoryChangeProposal,
} from '../domain/memory.js'
import {
  isCoordinatorInstance,
  type AssistantInstance,
  type AssistantMemory,
  type AssistantSession,
  type AssistantSnapshot,
  type AssistantPreview,
  type ContextCheckpoint,
  type MemoryEntry,
} from '../domain/types.js'
import type { InteractionResponseInput, PendingInteractionView } from '../transport/contracts.js'
import type { AgentTeamService } from '../service/dsh-team-mode-service.js'
import {
  registerAssistantMemoryTools,
  registerAssistantTaskTools,
  type AssistantTaskSummaryMessage,
} from './assistant-tools.js'
import { buildCheckpointFacts, checkpointHandoffMessage } from './checkpoint-facts.js'
import { projectConversation } from './conversation-projector.js'
import { TeamInteractionBridge } from './team-interaction-bridge.js'
import { coordinatorPrompt, groupBriefPrompt, serviceGroupBrief } from './team-prompts.js'
import type { ConversationNode } from '../transport/contracts.js'
import { readStoredSessionEvents } from './session-log.js'
import { createThreadSession, type CreatedThreadSession } from './thread-session.js'

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

/** One in-flight worker recovery, tagged with the generation it started under. */
interface PendingWorkerStart {
  assistantId: string
  generation: number
  promise: Promise<OwnedWorker>
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
const MEMORY_ENTRY_PROMPT_LIMIT = 20
const MEMORY_ENTRY_TITLE_LIMIT = 80
const MEMORY_ENTRY_BODY_LIMIT = 200
/** One opt-in capture run proposes at most this many entries. */
const MEMORY_CAPTURE_MAX_ENTRIES = 3
const MEMORY_CAPTURE_MAX_TITLE_CHARS = 160
const MEMORY_CAPTURE_MAX_BODY_CHARS = 2_000
const MEMORY_CAPTURE_MAX_TOKENS = 800
/** Bounds on the completed turn copied into the single capture call. */
const MEMORY_CAPTURE_MAX_TEXT_CHARS = 4_000
const MEMORY_CAPTURE_PROMPT_CHARS = 4_000
const MEMORY_CAPTURE_PROJECT_LIMIT = 60
/**
 * Prefix/containment dedupe only runs when both sides are this long: a short
 * phrase such as "ok" would otherwise match unrelated entries.
 */
const MEMORY_CAPTURE_DEDUPE_MIN_CHARS = 12

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
  private readonly startingWorkers = new Map<string, PendingWorkerStart>()
  /**
   * Per-task recovery fence, in-memory only. A release bumps it so a recovery
   * already awaiting `agents.resume` cannot reattach the released task. Entries
   * are deliberately kept as tombstones and stay bounded by the task rows this
   * runtime has touched.
   */
  private readonly workerGenerations = new Map<string, number>()
  private readonly assistantLocks = new Map<string, Promise<void>>()
  /**
   * Last completed turn already handled per Session. A turn's `turn/end` may be
   * observed more than once by a resumed Session, so the highest handled turn is
   * remembered instead of counting events.
   */
  private readonly capturedTurnBySession = new Map<string, number>()
  /** Assistants whose one capture model call is in flight; never two at once. */
  private readonly capturingAssistants = new Set<string>()
  /** Opt-in auto-capture per assistant instance; absence means off. */
  private readonly autoCaptureAssistants = new Set<string>()
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
      const sessionId = String(session.id)
      if (this.closing) return
      const taskId = this.workerBySession.get(sessionId)
      if (taskId !== undefined) {
        if (event.type !== 'turn/end' || event.data.reason.kind !== 'error') return
        void this.markTaskFailed(taskId, event.data.reason.error.message).catch(error => {
          this.ctx.logger.warn('dsh-team-mode: failed to record worker turn failure', error)
        })
        return
      }
      // Only a completed conversational turn is worth capturing; an aborted,
      // blocked, or failed turn has no trustworthy result to remember.
      if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
      const assistantId = this.assistantIdForSession(sessionId)
      if (assistantId === undefined) return
      void this.captureTurnMemory(
        assistantId,
        sessionId,
        session.snapshotEvents(),
        Number(event.seq),
        event.data.turn,
      ).catch(error => {
        this.ctx.logger.warn(
          `dsh-team-mode: memory auto-capture failed for assistant '${assistantId}'`,
          error,
        )
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
    // Capture bookkeeping is runtime-local; a disposing runtime must not keep a
    // turn memory or an opt-in switch alive.
    this.capturedTurnBySession.clear()
    this.capturingAssistants.clear()
    this.autoCaptureAssistants.clear()
    const pending = [...this.starting.values(), ...this.startingWorkers.values()]
    this.starting.clear()
    this.startingWorkers.clear()
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
    return this.withAssistantLock(assistantId, async () => {
      // Re-read under the lock: archive may have won it while ensureInstance
      // ran, and a worker must never start for an archived assistant.
      const instance = this.service.getAssistantInstance(assistantId)
      if (instance.status === 'archived') {
        throw new AgentTeamError(
          'ASSISTANT_INSTANCE_ARCHIVED',
          `Assistant instance '${assistantId}' is archived`,
        )
      }
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
   * Create one additional visible Session for an instance and attach it as a
   * thread. It goes through the same create → attach → flush path as the main
   * Session, so the Host owns it natively before the instance lists it. `cwd`
   * defaults to the instance workspace; an explicit directory becomes the
   * thread's working folder.
   *
   * The thread reuses the same setup as the main Session, so the same assistant
   * answers in it. It registers neither the team task tools nor the memory
   * tools: both write as the main Session, and a thread must not offer a tool it
   * may never call.
   */
  async createAssistantThread(
    rawAssistantId: string,
    cwd?: string,
  ): Promise<AssistantEnsureResult> {
    if (this.closing) throw new AgentTeamError('INVALID_REQUEST', 'Assistant runtime is closing')
    const id = requireText(rawAssistantId, 'Assistant instance id')
    const instance = this.service.getAssistantInstance(id)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${id}' is archived`,
      )
    }

    const directory = cwd?.trim() ?? ''
    let session: CreatedThreadSession
    try {
      // One factory with the team thread path: create, attach, flush.
      session = await createThreadSession(this.ctx, {
        workspaceId: instance.workspaceId,
        cwd: directory === '' ? instance.workspacePath : directory,
        agentPresetId: instance.assistantSnapshot.agentPresetId,
        agentOptions: agentOptionsFor(instance.assistantSnapshot),
        setup: this.assistantSetup(id, instance, 'thread'),
      })
    } catch (error) {
      throw this.startupError(instance, error)
    }

    try {
      const bound = await this.service.attachAssistantThread(id, session.sessionId)
      this.owned.set(session.sessionId, session.handle)
      return { instance: bound, sessionId: session.sessionId }
    } catch (error) {
      await this.disposeQuietly(session.handle, `thread Session '${session.sessionId}' failed to attach`)
      throw this.startupError(instance, error)
    }
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

  /**
   * Capture one deterministic checkpoint of the instance's main Session. A
   * live Agent owned by this runtime is read through its Session; a stopped
   * Session is read from its durable log. No model runs and no tool result is
   * copied; the service persists the bounded facts.
   */
  async createCheckpoint(assistantId: string, note: string): Promise<ContextCheckpoint> {
    const instance = this.service.getAssistantInstance(assistantId)
    const sourceSessionId = instance.mainSessionId
    if (sourceSessionId === undefined) {
      throw new AgentTeamError(
        'ASSISTANT_SESSION_NOT_READY',
        `Assistant '${instance.assistantSnapshot.name}' has no main Session yet; open it once before creating a checkpoint`,
        { instanceId: instance.id },
      )
    }
    const live = this.ctx.agents.get(SessionId(sourceSessionId))
    const events = live === undefined
      ? await readStoredSessionEvents(this.ctx, sourceSessionId)
      : live.session.snapshotEvents()
    const { facts, capturedThroughSeq } = buildCheckpointFacts({
      events,
      tasks: this.service.listAssistantSessions(assistantId).items,
      workspacePath: instance.workspacePath,
      note,
    })
    return this.service.createContextCheckpoint({
      assistantId: instance.id,
      sourceSessionId,
      capturedThroughSeq,
      facts,
      note,
    })
  }

  /**
   * One explicit ask-or-change request over this assistant's structured memory.
   *
   * Exactly one model call runs, and its reply decides the outcome: an answer
   * writes nothing, while a change is written only as `status: proposed`
   * through the same {@link AgentTeamService.writeAssistantMemoryEntry} path a
   * user write uses, fenced by the memory revision the write is based on. The
   * change is never written as `active`, so the entry state machine stays the
   * only way a proposal takes effect. Nothing here polls or schedules work: one
   * call per invoked operation.
   *
   * A revision proposal never rewrites the entry it revises: it is written as
   * its own pending entry naming that target, so the target keeps its accepted
   * body and stays prompt-injected until the user accepts, and 采纳 is the only
   * path that applies the proposal. A failure part-way through a change leaves
   * the earlier proposals stored as `proposed`, so the caller must re-read the
   * document when the request fails; nothing here can ever write an `active`
   * entry.
   */
  async askAssistantMemory(assistantId: string, text: string): Promise<MemoryAskResult> {
    const instance = this.service.getAssistantInstance(assistantId)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${instance.id}' is archived`,
        { instanceId: instance.id },
      )
    }
    const request = requireText(text, 'Memory request')
    if (request.length > MEMORY_ASK_MAX_TEXT_CHARS) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Memory request must be at most ${MEMORY_ASK_MAX_TEXT_CHARS} characters`,
        { limit: MEMORY_ASK_MAX_TEXT_CHARS },
      )
    }
    const entries = this.service.getAssistantMemory(instance.id)?.entries ?? []
    const reply = parseMemoryAskReply(
      await this.completeMemoryAsk(instance, memoryAskPrompt(entries, request)),
    )
    if (reply.kind === 'answer') return reply
    return {
      kind: 'change',
      entries: await this.proposeMemoryEntries(instance.id, reply.proposals),
    }
  }

  /**
   * The single model call behind ask-or-change: the assistant's own provider and
   * model, one hand-built one-shot request, no tools and no Session turn. A
   * provider failure is surfaced with its own reason instead of being read as an
   * unusable reply.
   */
  private async completeMemoryAsk(
    instance: AssistantInstance,
    prompt: string,
  ): Promise<string> {
    const snapshot = instance.assistantSnapshot
    let text = ''
    const chunks = this.ctx.llm.stream({
      provider: snapshot.provider,
      model: snapshot.model,
      ...(snapshot.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(snapshot.reasoningEffort) }),
      system: MEMORY_ASK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: MEMORY_ASK_MAX_TOKENS,
    })
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Memory ask model call failed: ${chunk.reason.failure.message}`,
            { reason: chunk.reason.failure.code },
          )
        }
        break
      }
    }
    return text
  }

  /**
   * Write every proposal as `proposed` through the entry write path, one call
   * per proposal. The first write is fenced by the revision read after the model
   * call, and each following write by the revision the previous write returned,
   * so a concurrent user write rejects the proposal instead of being overwritten.
   *
   * A proposal that names an existing entry is written as its own pending entry
   * with `supersedes`, never in place: rewriting the target to `proposed` would
   * drop it out of the prompt and destroy the accepted body before the user
   * decided anything. Only 采纳 applies the proposal, and the service does that
   * in one revision-fenced write that also supersedes the target.
   */
  private async proposeMemoryEntries(
    assistantId: string,
    proposals: readonly MemoryChangeProposal[],
  ): Promise<MemoryEntry[]> {
    let expectedRevision = this.service.getAssistantMemory(assistantId)?.revision ?? 0
    const written: MemoryEntry[] = []
    for (const proposal of proposals) {
      const { memory, entry } = await this.service.writeAssistantMemoryEntry(assistantId, {
        ...(proposal.entryId === undefined ? {} : { supersedes: proposal.entryId }),
        ...(proposal.key === undefined ? {} : { key: proposal.key }),
        ...(proposal.visibility === undefined ? {} : { visibility: proposal.visibility }),
        status: 'proposed',
        title: proposal.title,
        body: proposal.body,
      }, { expectedRevision })
      expectedRevision = memory.revision
      written.push(entry)
    }
    return written
  }

  /** Auto-capture is an explicit per-assistant switch and is off until set. */
  getMemoryAutoCapture(assistantId: string): boolean {
    return this.autoCaptureAssistants.has(this.service.getAssistantInstance(assistantId).id)
  }

  /**
   * Turn auto-capture on or off for one assistant. The switch is read again on
   * every completed turn and once more before a run writes, so turning it off
   * stops both later turns and an in-flight run's write; nothing keeps polling.
   */
  setMemoryAutoCapture(assistantId: string, enabled: boolean): boolean {
    const instance = this.service.getAssistantInstance(assistantId)
    if (enabled) this.autoCaptureAssistants.add(instance.id)
    else this.autoCaptureAssistants.delete(instance.id)
    return this.autoCaptureAssistants.has(instance.id)
  }

  /**
   * Bulk-ignore proposals: archive them through the same revision-fenced entry
   * write path, so the decision persists in the memory document and a later
   * capture sees the archived text as already handled. Ids that are no longer
   * proposed (accepted, or already archived) are skipped instead of failing the
   * whole batch; the returned entries are the ones actually archived.
   */
  async ignoreMemoryProposals(
    assistantId: string,
    entryIds?: readonly string[],
  ): Promise<MemoryEntry[]> {
    const instance = this.service.getAssistantInstance(assistantId)
    const wanted = entryIds === undefined ? undefined : new Set(entryIds)
    const proposed = (this.service.getAssistantMemory(instance.id)?.entries ?? [])
      .filter(entry => entry.status === 'proposed')
      .filter(entry => wanted === undefined || wanted.has(entry.id))
    let expectedRevision = this.service.getAssistantMemory(instance.id)?.revision ?? 0
    const archived: MemoryEntry[] = []
    for (const entry of proposed) {
      const { memory, entry: written } = await this.service.writeAssistantMemoryEntry(
        instance.id,
        {
          id: entry.id,
          ...(entry.key === undefined ? {} : { key: entry.key }),
          visibility: entry.visibility,
          status: 'archived',
          title: entry.title,
          body: entry.body,
        },
        { expectedRevision },
      )
      expectedRevision = memory.revision
      archived.push(written)
    }
    return archived
  }

  /**
   * The assistant an assistant-owned conversation Session belongs to: its main
   * Session or one of its threads. Absence means the Session is not an
   * Assistant conversation this runtime should capture from.
   */
  private assistantIdForSession(sessionId: string): string | undefined {
    return this.service.listAssistantInstances().items.find(instance =>
      instance.mainSessionId === sessionId
      || (instance.threadSessionIds ?? []).includes(sessionId))?.id
  }

  /**
   * One opt-in capture run for one completed turn: at most one model call, at
   * most three proposals, every one written as `proposed` through the M3 write
   * path. The turn is claimed before the first await so a repeated `turn/end`
   * cannot start a second run, and the switch is re-read after the model call so
   * disabling mid-turn still stops the write.
   */
  private async captureTurnMemory(
    assistantId: string,
    sessionId: string,
    events: readonly SessionEvent[],
    turnEndSeq: number,
    turn: number,
  ): Promise<void> {
    if (!this.autoCaptureAssistants.has(assistantId)) return
    const instance = this.service.getAssistantInstance(assistantId)
    if (instance.status === 'archived') return
    const handled = this.capturedTurnBySession.get(sessionId)
    if (handled !== undefined && turn <= handled) return
    if (this.capturingAssistants.has(assistantId)) return
    this.capturedTurnBySession.set(sessionId, turn)
    this.capturingAssistants.add(assistantId)
    try {
      const transcript = captureTurnTranscript(events, turnEndSeq)
      if (transcript === '') return
      const entries = this.service.getAssistantMemory(assistantId)?.entries ?? []
      const reply = await this.completeMemoryCapture(
        instance,
        memoryCapturePrompt(entries, transcript),
      )
      if (!this.autoCaptureAssistants.has(assistantId)) return
      const proposals = captureProposals(reply, entries)
        .slice(0, MEMORY_CAPTURE_MAX_ENTRIES)
      if (proposals.length === 0) return
      await this.proposeMemoryEntries(assistantId, proposals)
    } finally {
      this.capturingAssistants.delete(assistantId)
    }
  }

  /**
   * The one capture model call: the assistant's own provider and model, a
   * hand-built one-shot request, no tools and no Session turn.
   */
  private async completeMemoryCapture(
    instance: AssistantInstance,
    prompt: string,
  ): Promise<string> {
    const snapshot = instance.assistantSnapshot
    let text = ''
    const chunks = this.ctx.llm.stream({
      provider: snapshot.provider,
      model: snapshot.model,
      ...(snapshot.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(snapshot.reasoningEffort) }),
      system: MEMORY_CAPTURE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: MEMORY_CAPTURE_MAX_TOKENS,
    })
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          throw new Error(`memory auto-capture model call failed: ${chunk.reason.failure.message}`)
        }
        break
      }
    }
    return text
  }

  /**
   * Hand one ready checkpoint into a brand-new main Session and retire the
   * previous one. The new binding commits only after the fresh Agent accepted
   * the checkpoint message; before that every failure disposes the fresh
   * handle and leaves the old binding untouched. The old Session log is never
   * deleted, and a failure after the instance update is reported without
   * blindly rolling the committed binding back.
   */
  async handoff(checkpointId: string): Promise<{ checkpoint: ContextCheckpoint; sessionId: string }> {
    const checkpoint = this.service.getContextCheckpoint(checkpointId)
    const instance = this.service.getAssistantInstance(checkpoint.assistantId)
    if (checkpoint.status !== 'ready') {
      throw new AgentTeamError(
        'CHECKPOINT_NOT_READY',
        `Checkpoint '${checkpoint.id}' is ${checkpoint.status}; create a new checkpoint before handing off`,
        { checkpointId: checkpoint.id, status: checkpoint.status },
      )
    }
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${instance.id}' is archived`,
      )
    }
    const active = this.service.listAssistantSessions(instance.id).items
      .filter(task => ACTIVE_TASK_STATUSES.has(task.status))
    if (active.length > 0) {
      throw new AgentTeamError(
        'ASSISTANT_TASKS_ACTIVE',
        `Assistant '${instance.assistantSnapshot.name}' has ${active.length} active task(s); wait for them to finish before handing off`,
        { instanceId: instance.id, taskIds: active.map(task => task.id) },
      )
    }
    const previousSessionId = instance.mainSessionId
    if (previousSessionId === undefined) {
      throw new AgentTeamError(
        'ASSISTANT_SESSION_NOT_READY',
        `Assistant '${instance.assistantSnapshot.name}' has no main Session to hand off from`,
        { instanceId: instance.id },
      )
    }
    const live = this.ctx.agents.get(SessionId(previousSessionId))
    if (live !== undefined && !this.owned.has(previousSessionId)) {
      throw new AgentTeamError(
        'AGENT_HANDLE_OWNERSHIP_CONFLICT',
        `Assistant '${instance.id}' main Session '${previousSessionId}' is live under another lifecycle; retry after a reloading plugin releases it, or restart the DSH host if native ownership persists`,
        { instanceId: instance.id, sessionId: previousSessionId },
      )
    }
    if (live?.status === 'running') {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Assistant '${instance.assistantSnapshot.name}' is running a turn; wait for it to finish before handing off`,
        { instanceId: instance.id },
      )
    }
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(instance.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError(
        'WORKSPACE_UNAVAILABLE',
        `Workspace '${instance.workspaceId}' is unavailable`,
      )
    }

    const sessionId = `session-${randomUUID()}`
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: {
          cwd: instance.workspacePath,
          agentPreset: instance.assistantSnapshot.agentPresetId,
        },
        agentOptions: agentOptionsFor(instance.assistantSnapshot),
        setup: this.assistantSetup(instance.id, instance, 'main'),
      })
    } catch (error) {
      throw this.startupError(instance, error)
    }

    try {
      handle.agent.followup(checkpointHandoffMessage(checkpoint))
      await workspace.attachSession(SessionId(sessionId))
      await this.ctx.sessions.flush(handle.agent.session)
      await this.service.advanceAssistantMainSession(instance.id, sessionId, previousSessionId)
    } catch (error) {
      // The instance still points at the old Session: drop the fresh handle.
      await this.disposeQuietly(handle, `handoff Session '${sessionId}' failed`)
      throw this.startupError(instance, error)
    }

    // The new binding is committed from here on; a later failure is reported
    // without disposing the Session the Assistant now points at. The retired
    // handle is disposed before the checkpoint is consumed so a failing
    // consume cannot leave a live handle nothing owns.
    const previous = this.owned.get(previousSessionId)
    this.owned.set(sessionId, handle)
    this.owned.delete(previousSessionId)
    if (previous !== undefined) {
      await this.disposeQuietly(previous, `retired main Session '${previousSessionId}'`)
    }
    const consumed = await this.service.consumeContextCheckpoint(checkpoint.id, sessionId)
    return { checkpoint: consumed, sessionId }
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
    // Archive can complete between reading the task and driving its worker.
    // Re-read first so an already-mapped handle is never driven for an archived
    // assistant; the fast path below must not bypass this gate.
    const instance = this.service.getAssistantInstance(task.assistantId)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${task.assistantId}' is archived`,
      )
    }
    const existing = this.workers.get(task.id)
    if (existing !== undefined) return existing
    const generation = this.workerGeneration(task.id)
    const pending = this.startingWorkers.get(task.id)
    if (
      pending !== undefined
      && pending.assistantId === task.assistantId
      && pending.generation === generation
    ) {
      return pending.promise
    }
    // A pending entry from an older generation was fenced by a release. Joining
    // it would return a worker that release already tried to stop; a stale
    // recovery meanwhile disposes its own handle instead of mapping it.
    const promise = this.recoverWorker(task, generation)
    const entry: PendingWorkerStart = { assistantId: task.assistantId, generation, promise }
    this.startingWorkers.set(task.id, entry)
    try {
      return await promise
    } finally {
      if (this.startingWorkers.get(task.id) === entry) {
        this.startingWorkers.delete(task.id)
      }
    }
  }

  private async recoverWorker(
    task: AssistantSession,
    generation: number,
  ): Promise<OwnedWorker> {
    if (this.closing) throw new AgentTeamError('INVALID_REQUEST', 'Assistant runtime is closing')
    const instance = this.service.getAssistantInstance(task.assistantId)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${task.assistantId}' is archived`,
      )
    }
    if (this.ctx.agents.get(SessionId(task.sessionId)) !== undefined) {
      // Another lifecycle owns this worker Session. This runtime never drives
      // or disposes an Agent it does not own, and adopting one passively would
      // run the task through a handle it cannot tear down, so fail explicitly.
      throw new AgentTeamError(
        'AGENT_HANDLE_OWNERSHIP_CONFLICT',
        `Task '${task.title}' worker Session '${task.sessionId}' is live under another lifecycle; retry after that lifecycle releases the Session, or restart the DSH host if native ownership persists`,
        { taskId: task.id, sessionId: task.sessionId },
      )
    }

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

    // Release and archive can both win while `agents.resume` is in flight. The
    // handle belongs to this recovery, so dispose it rather than attach a
    // released worker or one on an archived assistant.
    const afterResume = this.recoveryInvalidation(task, generation)
    if (afterResume !== undefined) {
      await this.disposeQuietly(handle, `stale resumed worker Session '${task.sessionId}'`)
      throw afterResume
    }

    try {
      await workspace.attachSession(SessionId(task.sessionId))
      await this.ctx.sessions.flush(handle.agent.session)
      // Re-check after attach/flush and immediately before mapping: either may
      // have raced a release or archive that landed during the resume.
      const beforeMap = this.recoveryInvalidation(task, generation)
      if (beforeMap !== undefined) throw beforeMap
    } catch (error) {
      await this.disposeQuietly(handle, `resumed worker Session '${task.sessionId}' failed to attach`)
      throw this.workerStartupError(instance, task.title, error)
    }

    const worker: OwnedWorker = {
      assistantId: task.assistantId,
      sessionId: task.sessionId,
      handle,
    }
    this.mapWorker(task.id, worker)
    return worker
  }

  /**
   * Why a recovery that already awaited must not map its handle, or undefined
   * when it may still attach. Generation is checked first because a release is
   * the more specific outcome; an archived assistant is then still rejected.
   */
  private recoveryInvalidation(
    task: AssistantSession,
    generation: number,
  ): AgentTeamError | undefined {
    if (this.workerGeneration(task.id) !== generation) {
      return new AgentTeamError(
        'ASSISTANT_TASK_NOT_ACTIVE',
        `Task '${task.title}' was released while it was being recovered; retry the task`,
        { taskId: task.id, reason: 'released' },
      )
    }
    if (this.service.getAssistantInstance(task.assistantId).status === 'archived') {
      return new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${task.assistantId}' is archived`,
      )
    }
    return undefined
  }

  private workerGeneration(taskId: string): number {
    return this.workerGenerations.get(taskId) ?? 0
  }

  private bumpWorkerGeneration(taskId: string): void {
    this.workerGenerations.set(taskId, this.workerGeneration(taskId) + 1)
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
   * Stop every worker of one Assistant and mark the instance archived before
   * the assistant lock is released. Active tasks are marked cancelled so a
   * later idle transition cannot resurrect them; a worker mapped for an
   * already terminal task keeps that status but is still flushed and disposed.
   * Only workers this runtime owns are interrupted, and the main Session is
   * never touched by this method.
   */
  async stopForArchive(rawAssistantId: string): Promise<AssistantInstance> {
    const assistantId = requireText(rawAssistantId, 'Assistant instance id')
    return this.withAssistantLock(assistantId, async () => {
      // Fence every recovery this runtime still has in flight for this
      // assistant: each re-checks its generation after resume and disposes its
      // own handle instead of reattaching an archived assistant.
      for (const [taskId, pending] of this.startingWorkers) {
        if (pending.assistantId === assistantId) this.bumpWorkerGeneration(taskId)
      }
      const tasks = this.service.listAssistantSessions(assistantId).items
      for (const task of tasks) {
        if (!ACTIVE_TASK_STATUSES.has(task.status)) continue
        try {
          await this.service.updateAssistantSession(task.id, { status: 'cancelled' })
        } catch (error) {
          // The worker is still stopped below: archive must not leave one live
          // even when the status write fails.
          this.ctx.logger.warn(
            `dsh-team-mode: failed to cancel task '${task.id}' while archiving assistant '${assistantId}'`,
            error,
          )
        }
        const worker = this.workers.get(task.id)
        if (worker !== undefined) {
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
      // Workers can also be mapped for tasks that are already terminal, for
      // example when openTask resumes a completed task without changing its
      // status. Release every remaining worker of this assistant so archive
      // never leaves a live worker behind.
      for (const [taskId, worker] of [...this.workers]) {
        if (worker.assistantId !== assistantId) continue
        await this.releaseWorker(taskId, 'archived')
      }
      // Persist while the lock is still held: a createTask queued behind this
      // barrier re-reads the row, sees 'archived', and rejects before it can
      // create a worker, so no worker starts or survives after archive wins.
      return this.service.persistAssistantArchived(assistantId)
    })
  }

  /**
   * Release a terminal worker: fence any recovery still in flight, flush its
   * Session log, drop every runtime map entry, and dispose the handle. Only
   * handles created by this runtime are ever mapped, so no foreign Agent can
   * reach this path.
   */
  private async releaseWorker(taskId: string, reason: string): Promise<void> {
    // Bump first: a recovery already awaiting `agents.resume` must observe the
    // fence before its handle can be attached, and a fresh recovery for the
    // same task then starts under the new generation.
    const releasedGeneration = this.workerGeneration(taskId)
    this.bumpWorkerGeneration(taskId)
    const pending = this.startingWorkers.get(taskId)
    if (pending !== undefined && pending.generation === releasedGeneration) {
      this.startingWorkers.delete(taskId)
    }
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
    await this.captureTaskMemory(task)
    await this.releaseWorker(taskId, 'completed')
  }

  /**
   * Optional memory capture runs after completion (and before the worker is
   * released). It is opt-in, never calls a model, and its failure must not
   * change the task outcome.
   */
  private async captureTaskMemory(task: AssistantSession): Promise<void> {
    if (this.config.memoryAutoCapture !== true) return
    try {
      await this.service.captureAssistantTaskMemory(task.assistantId, task.id)
    } catch (error) {
      this.ctx.logger.warn(
        `dsh-team-mode: memory capture failed for task '${task.id}'`,
        error,
      )
    }
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
        // The worker prompt carries the user-authored group brief, so literal
        // braces must stay literal instead of failing interpolation.
        interpolate: false,
        text: () => {
          const current = this.service.getAssistantInstance(assistantId)
          return workerPrompt(
            current.assistantSnapshot,
            title,
            groupBriefPrompt(current.group, serviceGroupBrief(this.service, current.group)),
          )
        },
      })
      this.ctx.permissionPresets.set(agent.session, snapshot.permissionPresetId)
      // Deliberately no registerAssistantTaskTools or registerAssistantMemoryTools:
      // workers cannot delegate and cannot mutate the shared memory note.
    }
  }

  /**
   * Bounded task status for the prompt, so routing decisions can see the latest
   * active and finished titles without reading any transcript. A main Session
   * gets the delegation contract; a thread gets the same board read-only and is
   * pointed at the main conversation, because it registers no task tools.
   */
  private taskDigest(assistantId: string, role: 'main' | 'thread'): string {
    const tasks = this.service.listAssistantSessions(assistantId).items
    const active = tasks
      .filter(task => ACTIVE_TASK_STATUSES.has(task.status))
      .slice(0, DIGEST_ACTIVE_LIMIT)
    const terminal = tasks
      .filter(task => isTerminalTaskStatus(task.status))
      .slice(0, DIGEST_TERMINAL_LIMIT)
    const lines = [role === 'main'
      ? 'Background task routing:'
      : 'Background tasks of this assistant (read-only in this conversation):']
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
    if (role === 'thread') {
      lines.push(
        'This is an additional conversation of the assistant, not its main Session: '
        + 'starting, steering, and finishing background work happens in the main '
        + 'conversation, so summarize what you see here and let the user make changes there.',
      )
      return lines.join('\n')
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

  /**
   * The coordinator roster and duties, or an empty string for every other
   * Session. Both the flag and the teams are read live on each assembly: an
   * empty section contributes nothing to the rendered prompt, so a
   * non-coordinator Session assembles exactly what it did before, while a
   * coordinator handover reaches the next turn without a Session restart.
   *
   * A thread gets no roster or duties: those duties name team tools a thread
   * does not register, so it carries one line of fact instead.
   */
  private coordinatorPromptFor(assistantId: string, role: 'main' | 'thread'): string {
    const instance = this.service.getAssistantInstance(assistantId)
    if (!isCoordinatorInstance(instance)) return ''
    if (role === 'thread') {
      return 'You are the workspace coordinator, but coordinator duties run in your main Session. This is an additional conversation of the same assistant.'
    }
    return coordinatorPrompt(
      this.service.listTeams().items
        .filter(team => team.workspaceId === instance.workspaceId),
    )
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
    const setup = this.assistantSetup(id, instance, 'main')
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

  /**
   * Setup shared by every Session of one Assistant: preset mount, model
   * selection, permission preset, and the memory/identity/task/coordinator
   * prompt sections. Only a main Session also registers the task and memory
   * tools: both act as the main Session, and a thread is an additional visible
   * conversation whose team identity stays bound to the main one. A handoff
   * reuses the main role so a fresh Session is configured exactly like a normal
   * main-Session start.
   */
  private assistantSetup(
    id: string,
    instance: AssistantInstance,
    role: 'main' | 'thread',
  ): AgentSetup {
    const snapshot = instance.assistantSnapshot
    const modelSelection = modelSelectionFor(snapshot)
    return async (agentCtx, agent): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, snapshot.agentPresetId)
      installModelSelection(agentCtx, modelSelection)
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-memory:${instance.id}`,
        order: 9,
        text: () => memoryPrompt(this.service.getAssistantMemory(id), role),
      })
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-identity:${instance.id}`,
        order: 10,
        // Shared by the main and thread Sessions, and the group brief it
        // carries is user prose: keep literal braces literal.
        interpolate: false,
        text: () => {
          const current = this.service.getAssistantInstance(id)
          return assistantPrompt(
            current.assistantSnapshot,
            groupBriefPrompt(current.group, serviceGroupBrief(this.service, current.group)),
          )
        },
      })
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-tasks:${instance.id}`,
        order: 11,
        text: () => this.taskDigest(id, role),
      })
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-coordinator:${instance.id}`,
        order: 12,
        text: () => this.coordinatorPromptFor(id, role),
      })
      this.ctx.permissionPresets.set(agent.session, snapshot.permissionPresetId)
      // Task and memory tools act as the main Session; a thread has no identity
      // of its own there, so it registers neither instead of failing on call.
      if (role === 'thread') return
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
        writeEntry: (input, expectedRevision) =>
          this.service.writeAssistantMemoryEntry(id, input, { expectedRevision }),
      })
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
 * their delegation contract are described by each tool definition. A group
 * brief, when present, sits between identity and instructions.
 */
function assistantPrompt(snapshot: AssistantSnapshot, groupBrief = ''): string {
  const instructions = snapshot.instructions.trim()
  const identity = `You are ${snapshot.name}, a persistent assistant for one workspace.`
  return [identity, groupBrief, instructions]
    .filter(part => part !== '')
    .join('\n\n')
}

/**
 * Durable memory is injected before identity so every turn starts from the same
 * shared note. The stored document may hold 16k characters, but only a 4k
 * excerpt enters the prompt to keep the context bounded. Structured entries are
 * main-only: a worker is the same assistant but cannot mutate them. Linked team
 * members instead receive only active, assistant-scoped, team-safe entries,
 * read-only, from their explicitly linked instance; main sessions keep the
 * existing assistant memory view. A thread reads the same background without
 * being offered the write tools, so its intro names none.
 */
export function memoryPrompt(
  memory: AssistantMemory | undefined,
  role: 'main' | 'thread' | 'worker',
): string {
  const intro = role === 'main'
    ? 'Durable assistant memory: a persistent note plus structured entries shared by every Session of this assistant. Use assistant_memory_read to inspect it, assistant_memory_write for the legacy note, and assistant_memory_entry_write for structured entries. Keep it to lasting preferences and facts, not transcripts.'
    : role === 'thread'
      ? 'Durable assistant memory: a persistent note shared by every Session of this assistant and maintained by its main Session. Treat it as background context; changes belong to the main conversation.'
      : 'Durable assistant memory: a short persistent note shared by every Session of this assistant and maintained by its main Session. Treat it as background context; this worker cannot change it.'
  const content = memory?.content.trim() ?? ''
  const lines = [intro]
  lines.push(content === '' ? 'No memory has been saved yet.' : boundedText(content, MEMORY_PROMPT_LIMIT))
  if (role === 'main') {
    const entries = (memory?.entries ?? []).filter(entry => entry.status === 'active')
    if (entries.length > 0) {
      lines.push('Structured memory entries (use assistant_memory_entry_write with the entry_id to revise one):')
      for (const entry of entries.slice(-MEMORY_ENTRY_PROMPT_LIMIT)) {
        lines.push(`- ${entryLine(entry)}`)
      }
      if (entries.length > MEMORY_ENTRY_PROMPT_LIMIT) {
        lines.push(`(${entries.length - MEMORY_ENTRY_PROMPT_LIMIT} older active entries are stored but omitted from this prompt; use assistant_memory_read.)`)
      }
    }
  }
  return lines.join('\n')
}

function entryLine(entry: MemoryEntry): string {
  const label = entry.key === undefined ? entry.title : `${entry.key}: ${entry.title}`
  return `[${entry.visibility}] ${truncate(label, MEMORY_ENTRY_TITLE_LIMIT)}: ${boundedText(entry.body, MEMORY_ENTRY_BODY_LIMIT)}`
}

/**
 * A worker is the same assistant but with a deliberately narrower role: one
 * hidden task, no delegation tools, and no direct contact with the user.
 */
function workerPrompt(snapshot: AssistantSnapshot, title: string, groupBrief = ''): string {
  const instructions = snapshot.instructions.trim()
  const identity = `You are ${snapshot.name}, working as a hidden background worker Session on the task “${title}”. The user talks to the assistant's main Session and never sees this Session directly; your final answer is summarized back to that main conversation. Work only on this task, do not ask the user questions, and do not delegate to other Sessions.`
  return [identity, groupBrief, instructions]
    .filter(part => part !== '')
    .join('\n\n')
}

function workerMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * The fixed instruction for the single opt-in capture call. The reply is a
 * closed contract with an explicit empty list, so "nothing worth keeping" is a
 * normal answer instead of a missing one.
 */
const MEMORY_CAPTURE_SYSTEM_PROMPT = [
  'You review one completed assistant conversation turn and decide whether it holds durable memory.',
  'Reply with exactly one JSON object and no other text.',
  'Shape: {"entries":[{"title":"<short heading>","body":"<stored text>","key":"<optional stable key>","visibility":"private"}]}',
  `Propose at most ${MEMORY_CAPTURE_MAX_ENTRIES} entries, and reply with {"entries":[]} when the turn holds nothing durable.`,
  'Keep lasting preferences, decisions, and facts about the user or the work; never transcripts, tool output, or one-off details.',
  'Never repeat or rephrase anything already stored, including archived entries.',
  'Every proposal is stored as status "proposed" and takes effect only after the user accepts it, so never claim a write happened.',
].join('\n')

const memoryCaptureEntrySchema = z.object({
  key: z.string().max(200).optional(),
  visibility: z.enum(['private', 'team-safe']).optional(),
  title: z.string().max(MEMORY_CAPTURE_MAX_TITLE_CHARS),
  body: z.string().max(MEMORY_CAPTURE_MAX_BODY_CHARS),
}).strict()

/** A larger list than the cap is accepted and then truncated to three. */
const memoryCaptureReplySchema = z.object({
  entries: z.array(memoryCaptureEntrySchema).max(20),
}).strict()

/**
 * Build the single capture prompt: what is already stored (every status, so an
 * ignored proposal is not offered again), then this turn's visible text.
 */
function memoryCapturePrompt(
  entries: readonly MemoryEntry[],
  transcript: string,
): string {
  const lines = ['Already stored memory (never repeat it):']
  if (entries.length === 0) lines.push('(none)')
  let chars = 0
  let shown = 0
  for (const entry of entries) {
    const body = entry.body.trim()
    const line = `- [${entry.status}] ${truncate(entry.title, MEMORY_ENTRY_TITLE_LIMIT)}`
      + (body === '' ? '' : `: ${boundedText(body, MEMORY_ENTRY_BODY_LIMIT)}`)
    if (chars + line.length > MEMORY_CAPTURE_PROMPT_CHARS) break
    lines.push(line)
    chars += line.length
    shown += 1
  }
  if (shown < entries.length) lines.push(`(${entries.length - shown} more entries are stored but omitted.)`)
  lines.push('', 'Completed turn:', transcript)
  return lines.join('\n')
}

/**
 * The visible user/assistant text of the turn that just ended: the last user
 * message in the log plus everything after it, bounded. Tool output and
 * reasoning are never copied.
 */
function captureTurnTranscript(events: readonly SessionEvent[], turnEndSeq: number): string {
  const visible = events.filter(event => Number(event.seq) <= turnEndSeq)
  const nodes = projectConversation(visible, MEMORY_CAPTURE_PROJECT_LIMIT).nodes
  const start = nodes.findLastIndex(node => node.kind === 'user' && node.text.trim() !== '')
  if (start === -1) return ''
  const lines: string[] = []
  for (const node of nodes.slice(start)) {
    if (node.kind !== 'user' && node.kind !== 'assistant') continue
    const text = node.text.trim()
    if (text === '') continue
    lines.push(`${node.kind === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }
  return boundedText(lines.join('\n'), MEMORY_CAPTURE_MAX_TEXT_CHARS)
}

/**
 * Turn a capture reply into proposals: unusable JSON throws (the listener logs
 * and keeps the memory untouched), while empty titles and duplicates against
 * stored entries or earlier proposals in the same reply are dropped.
 */
function captureProposals(
  reply: string,
  entries: readonly MemoryEntry[],
): MemoryChangeProposal[] {
  const parsed = memoryCaptureReplySchema.safeParse(captureReplyJson(reply))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(issue === undefined
      ? 'memory auto-capture reply does not match its contract'
      : `memory auto-capture reply ${issue.path.join('.') || ''}: ${issue.message}`)
  }
  const proposals: MemoryChangeProposal[] = []
  const accepted: CaptureCandidate[] = [...entries]
  for (const candidate of parsed.data.entries) {
    const title = candidate.title.trim()
    if (title === '') continue
    const proposal: MemoryChangeProposal = {
      ...(candidate.key === undefined || candidate.key.trim() === ''
        ? {}
        : { key: candidate.key.trim() }),
      ...(candidate.visibility === undefined ? {} : { visibility: candidate.visibility }),
      title,
      body: candidate.body,
    }
    if (isDuplicateCapture(accepted, proposal)) continue
    proposals.push(proposal)
    accepted.push(proposal)
  }
  return proposals
}

function captureReplyJson(reply: string): unknown {
  const text = reply.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('memory auto-capture reply contains no JSON object')
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('memory auto-capture reply is not valid JSON')
  }
}

/** Case-folded, whitespace-collapsed text used for prefix/containment dedupe. */
function captureText(title: string, body: string): string {
  return `${title} ${body}`.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** The text fields dedupe compares; every stored entry and every proposal has them. */
interface CaptureCandidate {
  key?: string | undefined
  title: string
  body: string
}

/**
 * Prefix/containment dedupe against existing entries (every status, so an
 * ignored proposal stays ignored) and against earlier proposals in the same
 * reply.
 */
function isDuplicateCapture(
  entries: readonly CaptureCandidate[],
  candidate: CaptureCandidate,
): boolean {
  const candidateText = captureText(candidate.title, candidate.body)
  const candidateKey = candidate.key?.trim().toLowerCase()
  return entries.some(entry => {
    const entryKey = entry.key?.trim().toLowerCase()
    if (candidateKey !== undefined && candidateKey !== '' && entryKey === candidateKey) return true
    const existing = captureText(entry.title, entry.body)
    if (existing === candidateText) return true
    if (Math.min(existing.length, candidateText.length) < MEMORY_CAPTURE_DEDUPE_MIN_CHARS) return false
    return existing.startsWith(candidateText)
      || candidateText.startsWith(existing)
      || existing.includes(candidateText)
      || candidateText.includes(existing)
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
