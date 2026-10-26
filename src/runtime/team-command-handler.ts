import { randomUUID } from 'node:crypto'
import { createUserMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentTeamError } from '../domain/errors.js'
import { recallMemoryEntries, type MemoryRecallFilter } from '../domain/memory.js'
import { escalationKindSchema, teamTaskKindSchema, teamTaskVerdictSchema } from '../domain/schemas.js'
import {
  chargeGoalTurn,
  goalBudgetExhausted,
  goalTurnsUsed,
  setGoalBudget,
  taskKindOf,
} from '../domain/types.js'
import type {
  AssistantInstance,
  Escalation,
  EscalationKind,
  MemoryEntry,
  TeamAggregate,
  TeamGoal,
  TeamMemory,
  TeamMemberSlot,
  TeamMessage,
  TeamTask,
  TeamTaskKind,
  TeamTaskVerdict,
} from '../domain/types.js'
import type { AgentTeamService } from '../service/dsh-team-mode-service.js'
import type { EscalationGate } from '../service/escalations.js'
import type { PendingInteractionView } from '../transport/contracts.js'
import {
  appendMemoryJournal,
  assertTeamMemoryBudget,
  liveTeamMemoryEntries,
  memoryEntrySnapshot,
  normalizeTeamMemoryKey,
  normalizeTeamMemoryRevision,
  requireTeamMemoryRevision,
  TEAM_MEMORY_JOURNAL_MAX_CHARS,
  TEAM_MEMORY_MAX_BODY_CHARS,
  TEAM_MEMORY_MAX_ENTRIES,
  TEAM_MEMORY_MAX_TITLE_CHARS,
} from '../service/dsh-team-mode-service.js'
import {
  assignmentContent,
  createTaskDispatchMessage,
  createSystemTeamMessage,
  createTeamMessage,
  messageFromRecord,
  reassignmentContent,
  requireMessageContent,
  taskMessageType,
  taskUpdateContent,
  TEAM_RELAY_SOURCE,
  teamMessageHeader,
} from './team-messages.js'

type InternalTaskStatus = 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
export type AionTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/**
 * Caller identity fences for every member-authored write. `epoch` catches a
 * stale leadership generation; `memberSession` catches a Session retired by a
 * context handoff or reset, which leaves the epoch unchanged.
 */
export interface TeamWriteFence {
  epoch?: number
  memberSession?: { slotId: string; sessionId: string }
}

export interface TeamCommandPort {
  deliverMessage: (teamId: string, messageId: string) => Promise<boolean>
  followup: (sessionId: string, message: UserMessage) => void
  /**
   * Submit a persisted queued record to the turn coordinator. Present in the
   * TeamRuntime wiring; absent keeps the legacy direct followup path.
   */
  submitMessage?: (teamId: string, messageId: string) => Promise<'delivered' | 'queued'>
  /** Stop the target's current turn, then deliver the replacement message. */
  interruptAgent?: (teamId: string, callerSlotId: string, slotId: string, message: string) => Promise<void>
  /** Give one member a fresh session without touching the rest of the team. */
  clearAgentContext?: (teamId: string, slotId: string) => Promise<{ sessionId: string; status: string }>
  /** Remove one member after an approved shutdown handshake. */
  removeMember?: (teamId: string, slotId: string) => Promise<unknown>
  /**
   * Pending human interactions for one member session. They live only in the
   * runtime's in-memory bridge, so the inbox treats them as optional: absent
   * provider or a restart degrades to an empty approvals section.
   */
  pendingInteractions?: (sessionId: string) => PendingInteractionView[]
  /**
   * Whether the team currently has an active speaker. Present in the
   * TeamRuntime wiring; absent means the legacy direct path where the routine
   * only checks member state.
   */
  activeTurn?: (teamId: string) => boolean
}

/**
 * The escalation seam the handler needs from the service. Every member is
 * optional: a store without the escalation table (or an older test double)
 * records and lifts nothing, and the aggregation still works.
 */
export interface TeamEscalationPort {
  listEscalations(): Escalation[]
  recordEscalation(gate: EscalationGate, now?: string): Promise<Escalation | undefined>
  liftEscalations(
    sessionId: string,
    kind: EscalationKind,
    activeGateIds: Iterable<string>,
    now?: string,
  ): Promise<Escalation[]>
}

export interface TeamMemberView {
  slot_id: string
  name: string
  role: 'leader' | 'member'
  assistant_id: string
  /** Explicit Assistant instance link; absent for unlinked and legacy members. */
  assistant_instance_id?: string
  assistant_name: string
  provider: string
  model: string
  permission_preset_id: string
  status: string
  desired_state: string
  session_id: string
  is_leader: boolean
}

export interface TeamTaskView {
  task_id: string
  subject: string
  description: string
  status: AionTaskStatus
  raw_status: InternalTaskStatus
  owner?: string
  owner_name?: string
  /** Current ownership fence token; absent for unowned and pre-fence tasks. */
  attempt_id?: string
  created_by?: string
  blocked_by: string[]
  blocks: string[]
  file_scopes: string[]
  /** Goal this task contributes to; absent for ungrouped legacy tasks. */
  goal_id?: string
  /** Task kind; absent for tasks created before the kind vocabulary existed. */
  kind?: TeamTaskKind
  /** Done-when statement stated at create time. */
  acceptance?: string
  /** Implementation/repair task this review or verification task judges. */
  reviewed_task_id?: string
  /** Recorded review decision; absent until a review/verification completes. */
  verdict?: TeamTaskVerdict
  result?: string
  error?: string
  /** Optional due time; absent when the task has none. */
  due_at?: string
  /** Optional reminder time; absent when the task has none. */
  remind_at?: string
  /** Reminder already emitted for `remind_at`; absent until one fires. */
  reminded_at?: string
  revision: number
  created_at: string
  updated_at: string
}

export interface TeamMessageView {
  id: string
  from: string
  from_slot?: string
  type: string
  summary?: string
  message: string
  truncated: boolean
  files: string[]
  task_id?: string
  /** Conversation key; task mail shares the task id as its thread. */
  thread_id?: string
  goal_id?: string
  reply_to?: string
  /**
   * Present while one queued turn record cannot be delivered yet: the team is
   * busy with another speaker, or the target is not online. The record stays
   * queued exactly once and the coordinator resumes it on the idle release;
   * `since` is when it started waiting (its createdAt).
   */
  parked?: { reason: 'busy' | 'offline'; since: string }
  created_at: string
  was_unread: boolean
}

export interface ReadMessagesResult {
  messages: TeamMessageView[]
  remaining_unread: number
}

/** Optional narrowing, applied after the recipient filter and before the cap. */
export interface ReadMessagesFilter {
  threadId?: string
  taskId?: string
}

/** Links a message can carry; every one must resolve inside the same team. */
interface MessageLinks {
  threadId?: string
  goalId?: string
  replyTo?: string
}

export interface SendMessageResult {
  messageId: string
  deliveryState: 'queued' | 'delivered'
  deliveredTo: string[]
  queuedFor?: string[]
  shutdown?: 'approved' | 'rejected'
}

export interface CreateTaskInput {
  title?: string
  subject?: string
  description?: string
  ownerSlotId?: string
  owner?: string
  fileScopes?: string[]
  blockedBy?: string[]
  blocked_by?: string[]
  /** Goal of the same team that this task contributes to. */
  goalId?: string
  goal_id?: string
  /** Optional kind; omitted means `work`, which keeps the legacy behavior. */
  kind?: string
  /** Done-when statement for a reviewable task. */
  acceptance?: string
  /** Implementation/repair task judged by a review or verification task. */
  reviewedTaskId?: string
  reviewed_task_id?: string
  /** Optional due time; ISO 8601, normalized to UTC. */
  dueAt?: string
  due_at?: string
  /** Optional reminder time; ISO 8601, normalized to UTC. */
  remindAt?: string
  remind_at?: string
}

/** Goal plus the tasks it groups; the shape tools and future UI read. */
export interface TeamGoalView {
  goal_id: string
  title: string
  objective: string
  acceptance: string
  mode: 'direct' | 'single' | 'orchestrated'
  status: TeamGoal['status']
  /** Leader-set ceiling; absent for an unbounded (legacy) Goal. */
  max_turns?: number
  /** Dispatch turns charged so far; absent when none was ever charged. */
  used_turns?: number
  /** Ceiling minus spent turns; absent for an unbounded Goal. */
  remaining_turns?: number
  /**
   * Explicit budget state: true once the ceiling is reached. Work creation is
   * refused and update calls stop waking anyone until the Leader renews the
   * Goal, so exhaustion is never a silent stop.
   */
  budget_exhausted: boolean
  /** When the last allowed turn was spent; absent until exhaustion. */
  budget_exhausted_at?: string
  task_ids: string[]
  created_at: string
  updated_at: string
}

/** Create a Goal, optionally with a bounded turn budget. */
export interface CreateGoalInput {
  title?: string
  objective?: string
  acceptance?: string
  mode?: 'direct' | 'single' | 'orchestrated'
  maxTurns?: number
  max_turns?: number
}

/** Status and/or budget are writable through the tool: resume/pause/close/renew. */
export interface UpdateGoalInput {
  goalId?: string
  goal_id?: string
  status?: string
  /** New turn ceiling; raising it above the spent count renews the budget. */
  maxTurns?: number
  max_turns?: number
}

export interface TeamMemoryView {
  entry_id: string
  title: string
  body: string
  status: MemoryEntry['status']
  visibility: MemoryEntry['visibility']
  source: MemoryEntry['source']
  key?: string
  author_slot?: string
  revision: number
  created_at: string
  updated_at: string
}

export interface TeamMemoryList {
  /** Current memory-container revision; pass as expected_revision on the next write. */
  revision: number
  entries: TeamMemoryView[]
  /** Matching entries before the limit and character budget. */
  total: number
  /** True when more entries match than the bounded result returned. */
  truncated: boolean
}

export interface TeamMemoryWriteResult {
  revision: number
  entry: TeamMemoryView
}

export interface ProposeMemoryInput {
  title?: string
  body?: string
  key?: string
  expectedRevision?: number
  expected_revision?: number
}

export interface DecideMemoryInput {
  entryId?: string
  entry_id?: string
  decision?: 'accept' | 'reject'
  expectedRevision?: number
  expected_revision?: number
}

export interface UpdateTaskInput {
  taskId?: string
  task_id?: string
  status?: InternalTaskStatus | AionTaskStatus
  result?: string
  error?: string
  ownerSlotId?: string
  owner?: string
  blockedBy?: string[]
  blocked_by?: string[]
  /** Current attempt token of the task; required from members when the task is fenced. */
  attemptId?: string
  attempt_id?: string
  /** Review decision; review/verification tasks only, recorded by their owner. */
  verdict?: string
  /** Findings required with verdict=needs_revision or reject; stored as `error`. */
  findings?: string
  /** Due time; ISO 8601, normalized to UTC. Empty string clears it. */
  dueAt?: string
  due_at?: string
  /** Reminder time; ISO 8601, normalized to UTC. Empty string clears it. */
  remindAt?: string
  remind_at?: string
}

export interface ClaimTaskInput {
  taskId?: string
  task_id?: string
}

/** A successful claim always returns the caller as owner and the new fence. */
export interface ClaimTaskResult {
  taskId: string
  status: InternalTaskStatus
  owner: string
  attemptId?: string
}

/** Only approvals are surfaced in the inbox; questions stay in the workbench. */
export type TeamInboxApproval = Extract<PendingInteractionView, { kind: 'approval' }>

export interface InboxInput {
  limit?: number
}

/**
 * Coordinator-only digest of one team other than the caller's. Counts only:
 * the cross-team section summarizes, it never copies another team's rows.
 */
export interface TeamInboxTeamSummary {
  team_id: string
  team_name: string
  /** Unowned, unblocked tasks: claimable work nobody is handling yet. */
  ready: number
  approvals: number
  questions: number
}

export interface TeamInboxCrossTeamItem {
  team_id: string
  team_name: string
  kind: 'ready_task' | 'approval' | 'question'
  /** Task id for ready_task, interaction id otherwise. */
  id: string
  /** One-line label, truncated; never the full body. */
  summary: string
}

/**
 * The coordinator's view of the other teams' pending confirmations: approvals,
 * questions and unowned ready tasks, with the source team and counts.
 */
export interface TeamInboxCrossTeam {
  /** Teams with at least one pending item, sorted by name. */
  teams: TeamInboxTeamSummary[]
  /** Bounded one-line items across those teams, in the listed team order. */
  items: TeamInboxCrossTeamItem[]
  /** Matching items before the per-section cap. */
  total: number
}

/**
 * Read-only member view over existing aggregates and the durable message log.
 * Sections are filled in this listed order; the 50-row budget is consumed in
 * the same order, so a full earlier section shrinks the later ones.
 */
export interface TeamInboxResult {
  assigned: TeamTaskView[]
  ready: TeamTaskView[]
  unread: TeamMessageView[]
  approvals: TeamInboxApproval[]
  /** Unread messages for this member beyond the ones returned above. */
  remaining_unread: number
  /**
   * Present only for the workspace coordinator: the other teams' pending
   * confirmations, summarized. Absent for everyone else, so the member inbox
   * keeps its single-team scope and shape.
   */
  cross_team?: TeamInboxCrossTeam
}

/** One open stall as the coordinator tool relays it: where, what kind, one line. */
export interface TeamEscalationView {
  id: string
  team_id: string
  team_name: string
  member_slot_id: string
  kind: EscalationKind
  summary: string
  created_at: string
}

/**
 * The coordinator's escalation feed. `note` is present exactly when the caller
 * is not the coordinator: a teammate that calls the tool by mistake gets an
 * empty list and a sentence, never an error that fails its turn.
 */
export interface TeamEscalationList {
  escalations: TeamEscalationView[]
  note?: string
}

/** Default rows and the hard per-call cap of the coordinator escalation feed. */
const ESCALATIONS_DEFAULT_LIMIT = 20
const ESCALATIONS_LIMIT_MAX = 50
/** A non-coordinator call is answered, not rejected: an empty list plus this. */
const ESCALATIONS_COORDINATOR_ONLY =
  'Only the workspace coordinator can read escalations; this returned an empty list.'

export interface SendMessageInput {
  to?: string
  recipientSlotId?: string
  message?: string
  content?: string
  summary?: string
  files?: string[]
  type?: 'instruction' | 'progress' | 'result' | 'question' | 'warning'
  /** Optional thread key shared by related messages. */
  threadId?: string
  thread_id?: string
  /** Optional Goal of this same team that the message contributes to. */
  goalId?: string
  goal_id?: string
  /** Optional message id this one replies to. */
  replyTo?: string
  reply_to?: string
}

export interface SpawnAgentInput {
  name: string
  assistantId: string
  /** Optional explicit Assistant instance link; the service validates scope. */
  assistantInstanceId?: string
}

export interface ShutdownRequest {
  requesterSlotId: string
  requestedAt: string
}

const TASK_STATUS_ALIASES: Readonly<Record<string, InternalTaskStatus>> = {
  pending: 'pending',
  assigned: 'assigned',
  running: 'running',
  blocked: 'blocked',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  in_progress: 'running',
  deleted: 'cancelled',
}

/** Only open work can remind; every terminal status is silent. */
const OPEN_TASK_STATUSES: ReadonlySet<InternalTaskStatus> = new Set([
  'pending',
  'assigned',
  'running',
  'blocked',
])

/** One sweep never emits more than this many reminders per team. */
const TASK_REMINDER_LIMIT = 20

/**
 * The runtime's 30 s sweep cadence. A positive routine window never fires
 * faster than one tick, so the nudge itself always suppresses the next tick.
 */
const ROUTINE_TICK_MS = 30_000

/** Thrown inside a sweep closure to abort without a revision/activity write. */
class NoReminderDue extends Error {}

export class TeamCommandHandler {
  private readonly shutdownRequests = new Map<string, ShutdownRequest>()

  constructor(
    private readonly service: AgentTeamService,
    private readonly port: TeamCommandPort,
  ) {}

  /** The roster the model sees; never includes session event logs. */
  members(teamId: string): TeamMemberView[] {
    const team = this.service.getTeam(teamId)
    return Object.values(team.members)
      .sort((left, right) => left.joinedAt.localeCompare(right.joinedAt) || left.id.localeCompare(right.id))
      .map(member => this.memberView(team, member))
  }

  memberView(team: TeamAggregate, member: TeamMemberSlot): TeamMemberView {
    return {
      slot_id: member.id,
      name: member.displayName,
      role: member.role,
      assistant_id: member.assistantId,
      ...(member.assistantInstanceId === undefined
        ? {}
        : { assistant_instance_id: member.assistantInstanceId }),
      assistant_name: member.assistantSnapshot.name,
      provider: member.assistantSnapshot.provider,
      model: member.assistantSnapshot.model,
      permission_preset_id: member.permissionPresetId,
      status: member.lastRuntimeState,
      desired_state: member.desiredState,
      session_id: member.sessionId,
      is_leader: member.id === team.leaderSlotId,
    }
  }

  async createTask(
    teamId: string,
    creatorSlotId: string,
    input: CreateTaskInput,
    fence?: TeamWriteFence,
  ): Promise<{
    taskId: string
    status: string
    kind: TeamTaskKind
    reviewedTaskId?: string
    deliveryState?: 'queued' | 'delivered'
    attemptId?: string
  }> {
    const team = this.service.getTeam(teamId)
    this.assertLeader(team, creatorSlotId, 'create tasks')
    const title = requireShortText(input.subject ?? input.title ?? '', 'Task subject', 500)
    const description = (input.description ?? '').trim().slice(0, 16_000)
    const ownerSlotId = this.resolveOwnerSlotId(team, input.owner ?? input.ownerSlotId, true)
    const blockedBy = this.validateBlockedBy(team, undefined, input.blocked_by ?? input.blockedBy)
    const fileScopes = uniqueStrings(input.fileScopes ?? []).slice(0, 64)
    const goalId = normalizeGoalId(input.goal_id ?? input.goalId)
    const goal = goalId === undefined ? undefined : requireGoal(team, goalId)
    if (goal !== undefined) assertGoalBudgetAvailable(goal)
    const kind = normalizeTaskKind(input.kind)
    const acceptance = normalizeTaskAcceptance(input.acceptance)
    const reviewedTaskId = normalizeTaskReviewedId(
      team,
      kind,
      input.reviewed_task_id ?? input.reviewedTaskId,
    )
    const dueAt = normalizeTaskTimestamp(input.due_at ?? input.dueAt, 'Task due_at')
    const remindAt = normalizeTaskTimestamp(input.remind_at ?? input.remindAt, 'Task remind_at')
    const taskLimit = this.service.config.maxTeamTasks ?? 256
    if (Object.keys(team.tasks).length >= taskLimit) {
      throw new AgentTeamError(
        'TEAM_LIMIT_REACHED',
        `Team '${team.name}' already has ${taskLimit} tasks`,
        { limit: taskLimit },
      )
    }
    const now = new Date().toISOString()
    const taskId = randomUUID()
    const status: InternalTaskStatus = ownerSlotId === undefined ? 'pending' : 'assigned'
    // An owner means someone can later be stale; fence the task from day one.
    // An unowned task has nothing to fence until it gains an owner.
    const attemptId = ownerSlotId === undefined ? undefined : randomUUID()
    const owner = ownerSlotId === undefined ? undefined : team.members[ownerSlotId]
    // A blocked task is not dispatched yet; completing its blockers sends the
    // unblock notification instead.
    const assignment = owner === undefined || owner.id === creatorSlotId || blockedBy.length > 0
      ? undefined
      : createTaskDispatchMessage({
        team,
        senderSlotId: creatorSlotId,
        recipientSlotId: owner.id,
        taskId,
        type: 'instruction',
        content: withAttemptHint(assignmentContent(title, description, fileScopes, blockedBy, taskId), attemptId),
        ...(goalId === undefined ? {} : { goalId }),
      })
    await this.service.updateRuntimeTeam(
      teamId,
      current => {
        // Re-check inside the serialized write: a concurrent update may have
        // spent the last allowed turn since the snapshot above.
        const currentGoal = goalId === undefined ? undefined : requireGoal(current, goalId)
        if (currentGoal !== undefined) assertGoalBudgetAvailable(currentGoal)
        // Creating a task that starts another member's turn spends one turn;
        // an unassigned/blocked/self-owned task starts none and is free.
        const chargedGoal = currentGoal !== undefined
          && currentGoal.maxTurns !== undefined
          && assignment !== undefined
          ? chargeGoalTurn(currentGoal, now)
          : undefined
        return {
          ...current,
          tasks: {
            ...current.tasks,
            [taskId]: {
              id: taskId,
              title,
              description,
              status,
              ...(ownerSlotId === undefined ? {} : { ownerSlotId }),
              ...(attemptId === undefined ? {} : { attemptId }),
              createdBySlotId: creatorSlotId,
              dependencyIds: blockedBy,
              fileScopes,
              ...(goalId === undefined ? {} : { goalId }),
              // New tasks always record their kind so the gate never has to guess;
              // `taskKindOf` exists only for rows written before the vocabulary.
              kind,
              ...(acceptance === undefined ? {} : { acceptance }),
              ...(reviewedTaskId === undefined ? {} : { reviewedTaskId }),
              ...(dueAt === undefined ? {} : { dueAt }),
              ...(remindAt === undefined ? {} : { remindAt }),
              revision: 1,
              createdAt: now,
              updatedAt: now,
            },
          },
          outbox: assignment === undefined
            ? current.outbox
            : { ...current.outbox, [assignment.id]: assignment },
          ...(chargedGoal === undefined
            ? {}
            : { goals: { ...(current.goals ?? {}), [chargedGoal.id]: chargedGoal } }),
        }
      },
      'team.task_created',
      `Task ${title} created`,
      this.writeOptions(fence),
    )
    const created = {
      taskId,
      status,
      kind,
      ...(reviewedTaskId === undefined ? {} : { reviewedTaskId }),
      ...(attemptId === undefined ? {} : { attemptId }),
    }
    if (assignment === undefined) return created
    const delivered = await this.port.deliverMessage(teamId, assignment.id)
    return {
      ...created,
      deliveryState: delivered ? 'delivered' : 'queued',
    }
  }

  async updateTask(
    teamId: string,
    callerSlotId: string,
    input: UpdateTaskInput,
    fence?: TeamWriteFence,
  ): Promise<{
    taskId: string
    status: string
    verdict?: TeamTaskVerdict
    deliveryState?: 'queued' | 'delivered'
    woken?: string[]
    attemptId?: string
  }> {
    const team = this.service.getTeam(teamId)
    const taskId = input.task_id ?? input.taskId ?? ''
    const task = team.tasks[taskId]
    if (task === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown task '${taskId}'`)
    if (callerSlotId !== team.leaderSlotId && task.ownerSlotId !== callerSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'A member may update only its own task')
    }
    const presentedAttempt = normalizeAttemptToken(input.attempt_id ?? input.attemptId)
    const requestedVerdict = normalizeTaskVerdict(input.verdict)
    const requestedFindings = normalizeTaskFindings(input.findings)
    const nextStatus = input.status === undefined
      ? task.status
      : TASK_STATUS_ALIASES[input.status] ?? (() => {
        throw new AgentTeamError('INVALID_REQUEST', `Unknown task status '${String(input.status)}'`)
      })()
    const requestedOwner = input.owner ?? input.ownerSlotId
    const callerOwnsTask = task.ownerSlotId === callerSlotId
    if (requestedOwner !== undefined && callerSlotId !== team.leaderSlotId && !callerOwnsTask) {
      throw new AgentTeamError('INVALID_REQUEST', 'Only the team leader or task owner may reassign tasks')
    }
    const nextOwnerSlotId = requestedOwner === undefined
      ? task.ownerSlotId
      : this.resolveOwnerSlotId(team, requestedOwner, false)
    const requestedBlockedBy = input.blocked_by ?? input.blockedBy
    if (requestedBlockedBy !== undefined && callerSlotId !== team.leaderSlotId && !callerOwnsTask) {
      throw new AgentTeamError('INVALID_REQUEST', 'Only the team leader or task owner may change task dependencies')
    }
    const nextBlockedBy = requestedBlockedBy === undefined
      ? task.dependencyIds
      : this.validateBlockedBy(team, taskId, requestedBlockedBy)
    // undefined keeps the stored value, '' clears it, a value replaces it.
    const requestedDueAt = readTaskTimestamp(input.due_at ?? input.dueAt, 'Task due_at')
    const requestedRemindAt = readTaskTimestamp(input.remind_at ?? input.remindAt, 'Task remind_at')
    const now = new Date().toISOString()
    let notifications: TeamMessage[] = []
    let woken: string[] = []
    let finalStatus = nextStatus
    let finalAttemptId = task.attemptId
    let finalVerdict: TeamTaskVerdict | undefined
    await this.service.updateRuntimeTeam(
      teamId,
      current => {
        // Rebase on the latest aggregate: two members may update different tasks
        // concurrently, and the board must not lose either change.
        const base = current.tasks[taskId] ?? task
        // Ownership and the attempt fence are re-checked against `base`, not the
        // snapshot read above: a reassignment/takeover can land between that read
        // and this serialized write, and leadership itself is dynamic.
        if (callerSlotId !== current.leaderSlotId) {
          if (base.ownerSlotId !== callerSlotId) {
            throw new AgentTeamError(
              'INVALID_REQUEST',
              'A member may update only its own task',
              { taskId },
            )
          }
          // A task without an attemptId predates the fence (or never had an
          // owner); it stays unfenced so legacy boards keep working. Once an
          // owner change mints one, every later member update must present it.
          if (base.attemptId !== undefined && base.attemptId !== presentedAttempt) {
            throw new AgentTeamError(
              'INVALID_REQUEST',
              presentedAttempt === undefined
                ? `Task '${taskId}' requires the current attempt_id; read team_mode_task_list and retry with the listed attempt_id.`
                : `Task '${taskId}' attempt is stale; ownership changed since you read the board.`,
              { taskId, attemptId: base.attemptId },
            )
          }
        }
        const status = input.status === undefined ? base.status : nextStatus
        // The gate belongs here, after the owner/attempt fence: it must judge
        // the task as it exists in the aggregate being written, so a concurrent
        // reassignment cannot let the old owner record a verdict.
        const decision = decideTaskQuality({
          task: base,
          taskId,
          callerSlotId,
          status,
          ...(requestedVerdict === undefined ? {} : { verdict: requestedVerdict }),
          ...(requestedFindings === undefined ? {} : { findings: requestedFindings }),
        })
        const ownerSlotId = requestedOwner === undefined ? base.ownerSlotId : nextOwnerSlotId
        const dependencyIds = requestedBlockedBy === undefined
          ? base.dependencyIds
          : nextBlockedBy
        // Only an owner change rotates the fence. Re-sending the current owner
        // is a no-op (a takeover runs through an actual owner change), and a
        // plain status/result update never mints a token for a legacy task.
        const ownerChanged = requestedOwner !== undefined && nextOwnerSlotId !== base.ownerSlotId
        const attemptId = ownerChanged ? randomUUID() : base.attemptId
        const updated: TeamTask = {
          ...base,
          status,
          dependencyIds,
          ...(input.result === undefined ? {} : { result: input.result }),
          ...(input.error === undefined ? {} : { error: input.error }),
          revision: base.revision + 1,
          updatedAt: now,
        }
        // `remindedAt` is deliberately not writable here: only the reminder
        // sweep stamps it. Moving `remindAt` later than the stamp re-arms the
        // reminder through the sweep's comparison instead of clearing history.
        if (requestedDueAt === null) delete updated.dueAt
        else if (requestedDueAt !== undefined) updated.dueAt = requestedDueAt
        if (requestedRemindAt === null) delete updated.remindAt
        else if (requestedRemindAt !== undefined) updated.remindAt = requestedRemindAt
        // A verdict describes the task's current terminal decision: leaving a
        // terminal status drops it, and a failed task never keeps a stale
        // `pass`. A `failed` re-report without a verdict keeps its findings
        // decision; `completed` always comes with a fresh `pass` from the gate.
        if (status !== 'completed' && status !== 'failed') delete updated.verdict
        if (status === 'failed' && decision.verdict === undefined && base.verdict === 'pass') {
          delete updated.verdict
        }
        if (decision.verdict !== undefined) {
          updated.verdict = decision.verdict
          if (decision.findings === undefined) {
            // A pass supersedes findings left by an earlier failed round.
            if (input.error === undefined) delete updated.error
          } else {
            updated.error = decision.findings
          }
        }
        if (ownerSlotId === undefined) {
          delete updated.ownerSlotId
          delete updated.attemptId
        } else {
          updated.ownerSlotId = ownerSlotId
          if (attemptId === undefined) delete updated.attemptId
          else updated.attemptId = attemptId
        }

        let tasks: Record<string, TeamTask> = { ...current.tasks, [taskId]: updated }
        const unblocked: TeamTask[] = []
        if (status === 'completed' || status === 'cancelled') {
          const cleared = clearDownstreamBlockers(tasks, taskId, now)
          tasks = cleared.tasks
          unblocked.push(...cleared.unblocked)
        }
        const stored = tasks[taskId] ?? updated
        finalStatus = stored.status
        finalAttemptId = stored.attemptId
        finalVerdict = stored.verdict

        // Only an instruction that starts another member's turn is budgeted
        // work; the member's progress/result report stays free, exactly like a
        // Leader's own turn. The two lists are merged in delivery order below.
        const workNotifications: TeamMessage[] = []
        const reportNotifications: TeamMessage[] = []
        if (ownerChanged && ownerSlotId !== undefined && ownerSlotId !== callerSlotId) {
          workNotifications.push(createTaskDispatchMessage({
            team: current,
            senderSlotId: callerSlotId,
            recipientSlotId: ownerSlotId,
            taskId,
            type: 'instruction',
            content: withAttemptHint(reassignmentContent(base.title, input.result, input.error), attemptId),
            ...(base.goalId === undefined ? {} : { goalId: base.goalId }),
          }))
        } else if (callerSlotId !== current.leaderSlotId) {
          reportNotifications.push(createTaskDispatchMessage({
            team: current,
            senderSlotId: callerSlotId,
            recipientSlotId: current.leaderSlotId,
            taskId,
            type: taskMessageType(status),
            content: taskUpdateContent(base.title, status, input.result, input.error),
            ...(base.goalId === undefined ? {} : { goalId: base.goalId }),
          }))
        }
        const nextWoken: string[] = []
        for (const ready of unblocked) {
          if (ready.ownerSlotId === undefined || ready.ownerSlotId === callerSlotId) continue
          workNotifications.push(createTaskDispatchMessage({
            team: current,
            senderSlotId: callerSlotId,
            recipientSlotId: ready.ownerSlotId,
            taskId: ready.id,
            type: 'instruction',
            content: withAttemptHint(
              `Task '${ready.title}' is unblocked and ready for you (task id: ${ready.id}). Use team_mode_task_update to mark it in_progress.`,
              ready.attemptId,
            ),
            ...(ready.goalId === undefined ? {} : { goalId: ready.goalId }),
          }))
          nextWoken.push(ready.ownerSlotId)
        }
        let nextNotifications: TeamMessage[] = [...reportNotifications, ...workNotifications]
        // A Goal budget bounds the instructions the board may still start. When
        // it is spent, the bookkeeping above still lands and the report is still
        // delivered, but no owner is woken; the Leader gets one explicit notice
        // instead, so exhaustion is visible without a silent stop.
        let chargedGoal: TeamGoal | undefined
        const budgetGoal = base.goalId === undefined ? undefined : current.goals?.[base.goalId]
        // Only a Goal that opted into a ceiling carries budget counters; an
        // unbounded (legacy) Goal keeps exactly the old shape and timestamps.
        if (budgetGoal !== undefined && budgetGoal.maxTurns !== undefined && workNotifications.length > 0) {
          if (goalBudgetExhausted(budgetGoal)) {
            nextNotifications = [...reportNotifications, createSystemTeamMessage({
              team: current,
              recipientSlotId: current.leaderSlotId,
              content: `Goal '${budgetGoal.title}' has used its ${budgetGoal.maxTurns}-turn budget. This update to task '${base.title}' (${taskId}) was recorded, but nobody was woken. Raise the ceiling with team_mode_goal_update {goal_id:"${budgetGoal.id}", max_turns:<larger number>} to renew it, then re-dispatch the work.`,
            })]
            nextWoken.length = 0
          } else {
            chargedGoal = chargeGoalTurn(budgetGoal, now)
          }
        }
        notifications = nextNotifications
        woken = nextWoken
        return {
          ...current,
          tasks,
          outbox: nextNotifications.length === 0
            ? current.outbox
            : {
              ...current.outbox,
              ...Object.fromEntries(nextNotifications.map(message => [message.id, message])),
            },
          ...(chargedGoal === undefined
            ? {}
            : { goals: { ...(current.goals ?? {}), [chargedGoal.id]: chargedGoal } }),
        }
      },
      'team.task_updated',
      `Task ${task.title} entered ${nextStatus}`,
      this.writeOptions(fence),
    )
    let delivered = true
    for (const notification of notifications) {
      delivered = await this.port.deliverMessage(teamId, notification.id) && delivered
    }
    return {
      taskId: task.id,
      status: finalStatus,
      ...(finalVerdict === undefined ? {} : { verdict: finalVerdict }),
      ...(notifications.length === 0 ? {} : { deliveryState: delivered ? 'delivered' as const : 'queued' as const }),
      ...(woken.length === 0 ? {} : { woken }),
      ...(finalAttemptId === undefined ? {} : { attemptId: finalAttemptId }),
    }
  }

  /**
   * Optional claim path: a member takes a ready, unowned task. The eligibility
   * test runs inside the serialized update closure against the aggregate being
   * written, so two members claiming the same task cannot both win — the
   * second write sees the owner the first one set. This is a separate branch,
   * never a relaxation of updateTask's owner/attempt guard.
   */
  async claimTask(
    teamId: string,
    callerSlotId: string,
    input: ClaimTaskInput,
    fence?: TeamWriteFence,
  ): Promise<ClaimTaskResult> {
    const team = this.service.getTeam(teamId)
    this.requireMember(team, callerSlotId)
    const taskId = (input.task_id ?? input.taskId ?? '').trim()
    if (taskId === '') throw new AgentTeamError('INVALID_REQUEST', 'Task id is required')
    const snapshot = team.tasks[taskId]
    if (snapshot === undefined) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Unknown task '${taskId}' in team '${team.name}'`,
        { taskId },
      )
    }
    // Re-claiming work the caller already holds is a read, not a rotation: it
    // returns the current fence so an interrupted turn can resume with it.
    if (snapshot.ownerSlotId === callerSlotId) {
      return {
        taskId,
        status: snapshot.status,
        owner: callerSlotId,
        ...(snapshot.attemptId === undefined ? {} : { attemptId: snapshot.attemptId }),
      }
    }
    const attemptId = randomUUID()
    const now = new Date().toISOString()
    await this.service.updateRuntimeTeam(
      teamId,
      current => {
        const base = current.tasks[taskId]
        if (base === undefined) {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Unknown task '${taskId}' in team '${current.name}'`,
            { taskId },
          )
        }
        // Ownership first: a taken task is the common race, and the loser
        // needs the winner's owner + attempt to stand down rather than retry.
        if (base.ownerSlotId !== undefined) {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Task '${base.title}' is already owned by ${base.ownerSlotId}`
              + `${base.attemptId === undefined ? '' : ` (attempt_id: ${base.attemptId})`}; only an unowned pending task can be claimed.`,
            {
              taskId,
              owner: base.ownerSlotId,
              ...(base.attemptId === undefined ? {} : { attemptId: base.attemptId }),
              status: base.status,
            },
          )
        }
        // Enumerate the allowed state: terminal tasks can be reopened by the
        // Leader, so "not terminal" would make a reopened task claimable.
        if (base.status !== 'pending') {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Task '${base.title}' is ${base.status}; only a pending task can be claimed.`,
            { taskId, status: base.status },
          )
        }
        // Blocking lives in dependencyIds, not in status: a pending task can
        // still be blocked, so this test is mandatory.
        if (base.dependencyIds.length > 0) {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Task '${base.title}' is blocked by ${base.dependencyIds.length} task(s): `
              + `${base.dependencyIds.join(', ')}. Claim it after they complete.`,
            { taskId, status: base.status, blocked_by: [...base.dependencyIds] },
          )
        }
        return {
          ...current,
          tasks: {
            ...current.tasks,
            [taskId]: {
              ...base,
              status: 'assigned',
              ownerSlotId: callerSlotId,
              attemptId,
              revision: base.revision + 1,
              updatedAt: now,
            },
          },
        }
      },
      'team.task_claimed',
      `Task ${snapshot.title} claimed by ${team.members[callerSlotId]?.displayName ?? callerSlotId}`,
      this.writeOptions(fence),
    )
    // The closure either threw or wrote exactly these values.
    return { taskId, status: 'assigned', owner: callerSlotId, attemptId }
  }

  /**
   * One bounded reminder sweep for one team. Candidates are open tasks whose
   * `remindAt` arrived and whose last reminder predates that time. The stamp
   * and the notification are written in one serialized aggregate update, so
   * overlapping ticks cannot send a second reminder; status, owner, attempt,
   * result, and verdict are never touched. Delivery happens after the write.
   */
  async remindDueTasks(teamId: string, now = new Date().toISOString()): Promise<{
    teamId: string
    remindedTaskIds: string[]
    deliveryState?: 'queued' | 'delivered'
  }> {
    const nowMs = Date.parse(now)
    if (Number.isNaN(nowMs)) throw new AgentTeamError('INVALID_REQUEST', 'Reminder time must be an ISO 8601 timestamp')
    const nowIso = new Date(nowMs).toISOString()
    const team = this.service.getTeam(teamId)
    if (team.state !== 'active' || reminderCandidates(team, nowMs).length === 0) {
      return { teamId, remindedTaskIds: [] }
    }
    const notifications: TeamMessage[] = []
    const remindedTaskIds: string[] = []
    try {
      await this.service.updateRuntimeTeam(
        teamId,
        current => {
          // Re-check against the aggregate being written: a concurrent tick may
          // have stamped these tasks after the snapshot above.
          const candidates = current.state === 'active' ? reminderCandidates(current, nowMs) : []
          if (candidates.length === 0) throw new NoReminderDue()
          const tasks = { ...current.tasks }
          const nextNotifications: TeamMessage[] = []
          for (const task of candidates) {
            tasks[task.id] = {
              ...task,
              remindedAt: nowIso,
              revision: task.revision + 1,
              updatedAt: nowIso,
            }
            nextNotifications.push(taskReminderMessage(current, task))
            remindedTaskIds.push(task.id)
          }
          notifications.push(...nextNotifications)
          return {
            ...current,
            tasks,
            outbox: {
              ...current.outbox,
              ...Object.fromEntries(nextNotifications.map(message => [message.id, message])),
            },
          }
        },
        'team.task_reminded',
        `Task reminder emitted for ${remindedTaskIds.length} task(s)`,
      )
    } catch (error) {
      if (error instanceof NoReminderDue) return { teamId, remindedTaskIds: [] }
      throw error
    }
    let delivered = true
    for (const notification of notifications) {
      delivered = await this.port.deliverMessage(teamId, notification.id) && delivered
    }
    return {
      teamId,
      remindedTaskIds,
      ...(notifications.length === 0 ? {} : { deliveryState: delivered ? 'delivered' as const : 'queued' as const }),
    }
  }

  /**
   * Disposable routine nudge: at most one Leader-addressed instruction per
   * silence window. It never creates or changes tasks/Goals, never dispatches
   * work, and never approves anything — its only effect is the message itself,
   * which also resets the window and therefore suppresses the next tick.
   */
  async runDueRoutine(teamId: string, now = new Date().toISOString()): Promise<{
    teamId: string
    nudged: boolean
    messageId?: string
    deliveryState?: 'queued' | 'delivered'
  }> {
    const idleMs = this.service.config.teamRoutineIdleMs ?? 0
    const nowMs = Date.parse(now)
    if (Number.isNaN(nowMs)) {
      throw new AgentTeamError('INVALID_REQUEST', 'Routine time must be an ISO 8601 timestamp')
    }
    if (idleMs <= 0) return { teamId, nudged: false }
    const team = this.service.getTeam(teamId)
    if (team.state !== 'active' || team.archivedAt !== undefined) return { teamId, nudged: false }
    if (this.port.activeTurn?.(teamId) === true) return { teamId, nudged: false }
    if (Object.values(team.members).some(member => member.lastRuntimeState === 'running')) {
      return { teamId, nudged: false }
    }
    if (!hasOpenWork(team)) return { teamId, nudged: false }
    // Fire only after a full silence window. A window below the tick cadence
    // would otherwise fire on every tick; one tick is the effective floor.
    const windowMs = Math.max(idleMs, ROUTINE_TICK_MS)
    const lastMessageMs = lastMessageTime(this.service.listMessages(teamId).items)
    const sinceMs = lastMessageMs ?? Date.parse(team.createdAt)
    if (Number.isFinite(sinceMs) && nowMs - sinceMs <= windowMs) return { teamId, nudged: false }

    const id = String(MessageId(`dsh-team-mode:${randomUUID()}`))
    const message = createTeamMessage({
      id,
      teamId,
      sender: { kind: 'system', id: 'dsh-team-mode' },
      recipient: { kind: 'leader', slotId: team.leaderSlotId },
      // `instruction`, never `system`: the coordinator skips system records, so
      // a system nudge would sit in the queue forever when the Leader is busy.
      type: 'instruction',
      content: routineNudgeContent(team),
      summary: 'Routine idle check-in',
      threadId: `routine:${teamId}`,
      idempotencyKey: id,
    })
    await this.service.putRuntimeMessage(message)
    const deliveryState = this.port.submitMessage === undefined
      ? await this.port.deliverMessage(teamId, id).then(delivered => delivered ? 'delivered' as const : 'queued' as const)
      : await this.port.submitMessage(teamId, id)
    return { teamId, nudged: true, messageId: id, deliveryState }
  }

  listTasks(teamId: string, limit = 200): TeamTaskView[] {
    const team = this.service.getTeam(teamId)
    const bounded = Math.max(1, Math.min(limit, 200))
    const all: TeamTask[] = Object.values(team.tasks)
    const selected = all
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(-bounded)
    return selected.map(task => this.taskView(team, task, all))
  }

  taskView(team: TeamAggregate, task: TeamTask, allTasks: readonly TeamTask[]): TeamTaskView {
    const owner = task.ownerSlotId === undefined ? undefined : team.members[task.ownerSlotId]
    return {
      task_id: task.id,
      subject: task.title,
      description: task.description,
      status: toAionTaskStatus(task.status),
      raw_status: task.status,
      ...(task.ownerSlotId === undefined ? {} : { owner: task.ownerSlotId }),
      ...(owner === undefined ? {} : { owner_name: owner.displayName }),
      ...(task.attemptId === undefined ? {} : { attempt_id: task.attemptId }),
      ...(task.createdBySlotId === undefined ? {} : { created_by: task.createdBySlotId }),
      ...(task.goalId === undefined ? {} : { goal_id: task.goalId }),
      ...(task.kind === undefined ? {} : { kind: task.kind }),
      ...(task.acceptance === undefined ? {} : { acceptance: task.acceptance }),
      ...(task.reviewedTaskId === undefined ? {} : { reviewed_task_id: task.reviewedTaskId }),
      ...(task.verdict === undefined ? {} : { verdict: task.verdict }),
      blocked_by: [...task.dependencyIds],
      blocks: allTasks
        .filter(other => other.dependencyIds.includes(task.id))
        .map(other => other.id),
      file_scopes: [...task.fileScopes],
      ...(task.result === undefined ? {} : { result: task.result }),
      ...(task.error === undefined ? {} : { error: task.error }),
      ...(task.dueAt === undefined ? {} : { due_at: task.dueAt }),
      ...(task.remindAt === undefined ? {} : { remind_at: task.remindAt }),
      ...(task.remindedAt === undefined ? {} : { reminded_at: task.remindedAt }),
      revision: task.revision,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    }
  }

  /** Goals with the task ids they group; an empty board yields no goals. */
  listGoals(teamId: string): TeamGoalView[] {
    const team = this.service.getTeam(teamId)
    return Object.values(team.goals ?? {})
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(goal => this.goalView(team, goal))
  }

  async createGoal(
    teamId: string,
    creatorSlotId: string,
    input: CreateGoalInput,
    fence?: TeamWriteFence,
  ): Promise<TeamGoalView> {
    const team = this.service.getTeam(teamId)
    this.assertLeader(team, creatorSlotId, 'create goals')
    const maxTurns = normalizeGoalMaxTurns(input.max_turns ?? input.maxTurns)
    const goal = await this.service.createGoal(teamId, {
      title: requireShortText(input.title ?? '', 'Goal title', 200),
      objective: requireShortText(input.objective ?? '', 'Goal objective', 2_000),
      ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    }, this.writeOptions(fence))
    // Budget fields live on the optional Goal extension, so they are written
    // through the same aggregate closure instead of the legacy create input.
    const withBudget = maxTurns === undefined
      ? goal
      : await this.updateGoalBudget(teamId, goal.id, maxTurns, fence)
    return this.goalView(this.service.getTeam(teamId), withBudget)
  }

  /**
   * Leader-only Goal budget/status write. Resuming a Goal paused by an epoch
   * change and renewing an exhausted budget are the two ways back to usable
   * work; an exhausted Goal stays visibly exhausted until the ceiling is raised
   * above the spent count.
   */
  async updateGoal(
    teamId: string,
    callerSlotId: string,
    input: UpdateGoalInput,
    fence?: TeamWriteFence,
  ): Promise<TeamGoalView> {
    const team = this.service.getTeam(teamId)
    this.assertLeader(team, callerSlotId, 'update goals')
    const goalId = (input.goal_id ?? input.goalId ?? '').trim()
    if (goalId === '') throw new AgentTeamError('INVALID_REQUEST', 'Goal id is required')
    const status = input.status?.trim()
    const maxTurns = normalizeGoalMaxTurns(input.max_turns ?? input.maxTurns)
    if ((status === undefined || status === '') && maxTurns === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', 'Goal status or max_turns is required')
    }
    if (status !== undefined && status !== '') {
      await this.service.updateGoal(teamId, goalId, {
        status: normalizeGoalStatus(status),
      }, this.writeOptions(fence))
    }
    const goal = maxTurns === undefined
      ? requireGoal(this.service.getTeam(teamId), goalId)
      : await this.updateGoalBudget(teamId, goalId, maxTurns, fence)
    return this.goalView(this.service.getTeam(teamId), goal)
  }

  /** Write one Goal ceiling through the aggregate closure, keeping counters. */
  private async updateGoalBudget(
    teamId: string,
    goalId: string,
    maxTurns: number,
    fence?: TeamWriteFence,
  ): Promise<TeamGoal> {
    const now = new Date().toISOString()
    await this.service.updateRuntimeTeam(
      teamId,
      current => {
        const existing = requireGoal(current, goalId)
        return {
          ...current,
          goals: { ...current.goals, [goalId]: setGoalBudget(existing, maxTurns, now) },
        }
      },
      'team.goal_budget_updated',
      `Goal ${goalId} budget set to ${maxTurns} turns`,
      this.writeOptions(fence),
    )
    return requireGoal(this.service.getTeam(teamId), goalId)
  }

  goalView(team: TeamAggregate, goal: TeamGoal): TeamGoalView {
    const usedTurns = goalTurnsUsed(goal)
    return {
      goal_id: goal.id,
      title: goal.title,
      objective: goal.objective,
      acceptance: goal.acceptance,
      mode: goal.mode,
      status: goal.status,
      ...(goal.maxTurns === undefined ? {} : {
        max_turns: goal.maxTurns,
        remaining_turns: Math.max(0, goal.maxTurns - usedTurns),
      }),
      ...(goal.usedTurns === undefined ? {} : { used_turns: goal.usedTurns }),
      budget_exhausted: goalBudgetExhausted(goal),
      ...(goal.budgetExhaustedAt === undefined ? {} : { budget_exhausted_at: goal.budgetExhaustedAt }),
      task_ids: Object.values(team.tasks)
        .filter(task => task.goalId === goal.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map(task => task.id),
      created_at: goal.createdAt,
      updated_at: goal.updatedAt,
    }
  }

  /**
   * Team memory is scoped to one aggregate: every read takes a teamId, so
   * another team's entries are unreachable and DM Sessions never read it.
   */
  listMemory(teamId: string, filter: MemoryRecallFilter = {}): TeamMemoryList {
    const team = this.service.getTeam(teamId)
    const recall = recallMemoryEntries(team.memory?.entries ?? [], filter)
    return {
      revision: team.memory?.revision ?? 0,
      total: recall.total,
      truncated: recall.truncated,
      entries: recall.entries.map(entry => this.memoryView(entry)),
    }
  }

  memoryView(entry: MemoryEntry): TeamMemoryView {
    return {
      entry_id: entry.id,
      title: entry.title,
      body: entry.body,
      status: entry.status,
      visibility: entry.visibility,
      source: entry.source,
      ...(entry.key === undefined ? {} : { key: entry.key }),
      ...(entry.authorSlotId === undefined ? {} : { author_slot: entry.authorSlotId }),
      revision: entry.revision,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
    }
  }

  /**
   * A member files a proposal for the Leader to decide; the Leader writes an
   * entry directly, because the Leader already owns team memory. Team entries
   * are always `team-safe`: they exist only inside this aggregate, so a
   * narrower visibility could not be honoured. `expected_revision` fences the
   * memory container (not the aggregate revision), re-checked inside the
   * serialized team write.
   */
  async proposeMemory(
    teamId: string,
    proposerSlotId: string,
    input: ProposeMemoryInput,
    fence?: TeamWriteFence,
  ): Promise<TeamMemoryWriteResult> {
    const team = this.service.getTeam(teamId)
    this.requireMember(team, proposerSlotId)
    const title = requireShortText(input.title ?? '', 'Memory title', TEAM_MEMORY_MAX_TITLE_CHARS)
    const body = requireShortText(input.body ?? '', 'Memory body', TEAM_MEMORY_MAX_BODY_CHARS)
    const key = normalizeTeamMemoryKey(input.key)
    const expected = normalizeTeamMemoryRevision(input.expected_revision ?? input.expectedRevision)
    const now = new Date().toISOString()
    const entryId = randomUUID()
    const next = await this.service.updateRuntimeTeam(
      teamId,
      current => {
        this.requireMember(current, proposerSlotId)
        requireTeamMemoryRevision(expected, current.memory?.revision ?? 0)
        // Leadership is dynamic: decide the proposal shape against the value
        // being written, not the snapshot read before this serialized update.
        const isLeader = current.leaderSlotId === proposerSlotId
        const entries = current.memory?.entries ?? []
        // Archived and superseded entries are history: stored for audit but not
        // counted, so rejecting a proposal or superseding a key never
        // permanently consumes the budget.
        if (liveTeamMemoryEntries(entries).length >= TEAM_MEMORY_MAX_ENTRIES) {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Team memory already holds ${TEAM_MEMORY_MAX_ENTRIES} live entries (active or proposed)`,
            { limit: TEAM_MEMORY_MAX_ENTRIES },
          )
        }
        const entry: MemoryEntry = {
          id: entryId,
          scope: 'team',
          visibility: 'team-safe',
          status: isLeader ? 'active' : 'proposed',
          source: isLeader ? 'leader' : 'member',
          authorSlotId: proposerSlotId,
          ...(key === undefined ? {} : { key }),
          title,
          body,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }
        // A Leader write is authoritative for its key: the accepted entry it
        // replaces becomes superseded instead of both staying active.
        const superseded: Array<{ before: MemoryEntry; after: MemoryEntry }> = []
        const merged = isLeader && key !== undefined
          ? entries.map(value => {
            if (value.status !== 'active' || value.key !== key) return value
            const after: MemoryEntry = {
              ...value,
              status: 'superseded',
              revision: value.revision + 1,
              updatedAt: now,
            }
            superseded.push({ before: value, after })
            return after
          })
          : entries
        const nextEntries = [...merged, entry]
        assertTeamMemoryBudget(nextEntries)
        const revision = (current.memory?.revision ?? 0) + 1
        let journal = appendMemoryJournal(current.memory?.journal, {
          scope: 'team',
          actor: isLeader ? 'leader' : 'member',
          action: 'create',
          entryId: entry.id,
          reason: `${isLeader ? 'leader' : 'member'} proposed '${title}'`,
          before: null,
          after: memoryEntrySnapshot(entry),
        }, revision, TEAM_MEMORY_JOURNAL_MAX_CHARS)
        for (const change of superseded) {
          journal = appendMemoryJournal(journal, {
            scope: 'team',
            actor: isLeader ? 'leader' : 'member',
            action: 'supersede',
            entryId: change.before.id,
            reason: `superseded by '${title}'`,
            before: memoryEntrySnapshot(change.before),
            after: memoryEntrySnapshot(change.after),
          }, revision, TEAM_MEMORY_JOURNAL_MAX_CHARS)
        }
        return {
          ...current,
          memory: { revision, entries: nextEntries, journal, updatedAt: now },
        }
      },
      'team.memory_proposed',
      `Team memory entry '${title}' submitted`,
      this.writeOptions(fence),
    )
    return {
      revision: next.memory?.revision ?? 0,
      entry: this.memoryView(requireMemoryEntry(next, entryId)),
    }
  }

  /**
   * Leader-only decision on a member proposal. Accepting activates the entry
   * and supersedes any currently active entry that shares its key; rejecting
   * archives it. A proposal is decided exactly once, and its author cannot
   * decide it even if that author is the Leader.
   */
  async decideMemory(
    teamId: string,
    callerSlotId: string,
    input: DecideMemoryInput,
    fence?: TeamWriteFence,
  ): Promise<TeamMemoryWriteResult> {
    const team = this.service.getTeam(teamId)
    this.assertLeader(team, callerSlotId, 'accept or reject team memory proposals')
    const entryId = (input.entry_id ?? input.entryId ?? '').trim()
    if (entryId === '') throw new AgentTeamError('INVALID_REQUEST', 'Memory entry id is required')
    const decision = normalizeDecision(input.decision)
    const expected = normalizeTeamMemoryRevision(input.expected_revision ?? input.expectedRevision)
    const now = new Date().toISOString()
    const next = await this.service.updateRuntimeTeam(
      teamId,
      current => {
        // The Leader may change between the snapshot and this serialized write.
        if (current.leaderSlotId !== callerSlotId) {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            'Only the team leader may accept or reject team memory proposals',
          )
        }
        requireTeamMemoryRevision(expected, current.memory?.revision ?? 0)
        const entries = [...(current.memory?.entries ?? [])]
        const index = entries.findIndex(entry => entry.id === entryId)
        if (index === -1) {
          throw new AgentTeamError('INVALID_REQUEST', `Unknown team memory entry '${entryId}'`)
        }
        const entry = entries[index]!
        if (entry.authorSlotId === callerSlotId) {
          throw new AgentTeamError('INVALID_REQUEST', 'A member cannot decide its own memory proposal')
        }
        if (entry.status !== 'proposed') {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Team memory entry '${entryId}' is ${entry.status}, not proposed`,
            { entryId, status: entry.status },
          )
        }
        const decided: MemoryEntry = {
          ...entry,
          status: decision === 'reject' ? 'archived' : 'active',
          revision: entry.revision + 1,
          updatedAt: now,
        }
        entries[index] = decided
        const revision = (current.memory?.revision ?? 0) + 1
        let journal = appendMemoryJournal(current.memory?.journal, {
          scope: 'team',
          actor: 'leader',
          action: decision,
          entryId: decided.id,
          reason: `leader ${decision} '${decided.title}'`,
          before: memoryEntrySnapshot(entry),
          after: memoryEntrySnapshot(decided),
        }, revision, TEAM_MEMORY_JOURNAL_MAX_CHARS)
        if (decision === 'accept' && decided.key !== undefined) {
          for (let position = 0; position < entries.length; position += 1) {
            const other = entries[position]!
            if (other.id === decided.id || other.status !== 'active' || other.key !== decided.key) continue
            const superseded: MemoryEntry = {
              ...other,
              status: 'superseded',
              revision: other.revision + 1,
              updatedAt: now,
            }
            entries[position] = superseded
            journal = appendMemoryJournal(journal, {
              scope: 'team',
              actor: 'leader',
              action: 'supersede',
              entryId: other.id,
              reason: `superseded by '${decided.title}'`,
              before: memoryEntrySnapshot(other),
              after: memoryEntrySnapshot(superseded),
            }, revision, TEAM_MEMORY_JOURNAL_MAX_CHARS)
          }
        }
        return {
          ...current,
          memory: { revision, entries, journal, updatedAt: now },
        }
      },
      decision === 'accept' ? 'team.memory_accepted' : 'team.memory_rejected',
      `Team memory entry ${entryId} ${decision === 'accept' ? 'accepted' : 'rejected'}`,
      this.writeOptions(fence),
    )
    return {
      revision: next.memory?.revision ?? 0,
      entry: this.memoryView(requireMemoryEntry(next, entryId)),
    }
  }

  async readMessages(
    teamId: string,
    slotId: string,
    limit = 20,
    filter: ReadMessagesFilter = {},
  ): Promise<ReadMessagesResult> {
    const team = this.service.getTeam(teamId)
    this.requireMember(team, slotId)
    const bounded = Math.max(1, Math.min(limit, 50))
    // Filters narrow before the cap and before read-marking, so a filtered read
    // never consumes mail outside the filter.
    const threadId = normalizeMessageKey(filter.threadId, 'Thread id')
    const taskId = normalizeMessageKey(filter.taskId, 'Task id')
    const eligible = this.service.listMessages(teamId).items
      .filter(message => message.sender.kind !== 'user')
      .filter(message => message.sender.id !== slotId)
      .filter(message => this.recipientMatches(message, slotId))
      .filter(message => threadId === undefined || message.threadId === threadId)
      .filter(message => taskId === undefined || message.relatedTaskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    const unread = eligible.filter(message => !isReadBy(message, slotId))
    const recent = eligible.filter(message => isReadBy(message, slotId))
    const selected = unread.length >= bounded
      ? unread.slice(0, bounded)
      : [...unread, ...recent.slice(-(bounded - unread.length))]
    selected.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    const views: TeamMessageView[] = selected.map(message => this.messageView(team, message, slotId))
    const unreadSelected = selected.filter(message => !isReadBy(message, slotId)).length
    for (const message of selected) {
      const readBy = [...new Set([...(message.readBy ?? []), slotId])]
      await this.service.putRuntimeMessage({
        ...message,
        readBy,
        deliveryState: message.recipient.kind === 'broadcast' ? message.deliveryState : 'read',
      })
    }
    return {
      messages: views,
      remaining_unread: Math.max(0, unread.length - unreadSelected),
    }
  }

  /**
   * One lazy escalation pass over every gate the runtime can see right now:
   * approvals and questions from the interaction bridge, blocked tasks from the
   * board. Each gate is recorded first, then its Session + kind is converged
   * against exactly this batch, so a row is lifted only when its gate left the
   * batch. There is no timer: the aggregation that reads the pending
   * confirmations is also the pass that closes them.
   */
  async refreshEscalations(now = new Date().toISOString()): Promise<void> {
    const port: Partial<TeamEscalationPort> = this.service
    if (port.recordEscalation === undefined || port.liftEscalations === undefined) return
    for (const team of this.service.listTeams().items) {
      const blocked = Object.values(team.tasks).filter(task => task.status === 'blocked')
      for (const member of Object.values(team.members)) {
        const pending = this.port.pendingInteractions?.(member.sessionId) ?? []
        const batch: Array<{ kind: EscalationKind; gateId: string; summary: string }> = []
        for (const view of pending) {
          if (view.kind === 'approval') {
            batch.push({
              kind: 'approval',
              gateId: view.id,
              summary: `${member.displayName}: ${view.toolName}`,
            })
          } else {
            const asked = view.questions[0]
            batch.push({
              kind: 'question',
              gateId: view.id,
              summary: `${member.displayName}: ${asked?.header ?? asked?.question ?? 'question'}`,
            })
          }
        }
        for (const task of blocked) {
          if (task.ownerSlotId !== member.id) continue
          batch.push({ kind: 'blocked_task', gateId: task.id, summary: task.title })
        }
        for (const kind of escalationKindSchema.options) {
          const gates = batch.filter(gate => gate.kind === kind)
          for (const gate of gates) {
            await port.recordEscalation?.({
              teamId: team.id,
              teamName: team.name,
              memberSlotId: member.id,
              sessionId: member.sessionId,
              kind,
              gateId: gate.gateId,
              summary: gate.summary,
            }, now)
          }
          await port.liftEscalations?.(member.sessionId, kind, gates.map(gate => gate.gateId), now)
        }
      }
    }
  }

  /**
   * Bounded, read-only member inbox derived from the aggregate, the durable
   * message log, and the runtime's in-memory approvals. It never calls
   * readMessages: that path marks mail read, and an inbox must be safe to poll.
   */
  inbox(teamId: string, slotId: string, input: InboxInput = {}): TeamInboxResult {
    const team = this.service.getTeam(teamId)
    const member = this.requireMember(team, slotId)
    // Per-section cap: the argument is clamped 1-50, then each section is
    // further capped at 20 rows and the whole inbox at 50.
    const bounded = Math.min(Math.max(1, Math.trunc(input.limit ?? 20)), 50)
    const perSection = Math.min(bounded, 20)
    const tasks = Object.values(team.tasks)
    const byUpdatedAt = (left: TeamTask, right: TeamTask): number =>
      left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
    const assigned = tasks
      .filter(task => task.ownerSlotId === slotId
        && (task.status === 'assigned' || task.status === 'running' || task.status === 'blocked'))
      .sort(byUpdatedAt)
    // Claimable is the same definition as team_mode_task_claim: pending, no
    // owner, no unresolved dependency (blocking is not expressed in status).
    const ready = tasks
      .filter(task => task.status === 'pending'
        && task.ownerSlotId === undefined
        && task.dependencyIds.length === 0)
      .sort(byUpdatedAt)
    const unread = this.service.listMessages(teamId).items
      .filter(message => message.sender.kind !== 'user')
      .filter(message => message.sender.id !== slotId)
      .filter(message => this.recipientMatches(message, slotId))
      .filter(message => !isReadBy(message, slotId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    // Approvals exist only while this runtime owns the member session; the
    // provider is optional so an unavailable bridge yields an empty section.
    const approvals = (this.port.pendingInteractions?.(member.sessionId) ?? [])
      .filter((view): view is TeamInboxApproval => view.kind === 'approval')
      .sort((left, right) => left.id.localeCompare(right.id))

    const sections: Array<[name: string, rows: readonly unknown[]]> = [
      ['assigned', assigned],
      ['ready', ready],
      ['unread', unread],
      ['approvals', approvals],
    ]
    const sizes = new Map<string, number>()
    let budget = 50
    for (const [name, rows] of sections) {
      const take = Math.min(rows.length, perSection, budget)
      sizes.set(name, take)
      budget -= take
    }
    const assignedView = assigned
      .slice(0, sizes.get('assigned'))
      .map(task => this.taskView(team, task, tasks))
    const readyView = ready
      .slice(0, sizes.get('ready'))
      .map(task => this.taskView(team, task, tasks))
    const unreadView = unread
      .slice(0, sizes.get('unread'))
      .map(message => this.messageView(team, message, slotId))
    const crossTeam = this.crossTeamInbox(team, member, perSection)
    return {
      assigned: assignedView,
      ready: readyView,
      unread: unreadView,
      approvals: approvals.slice(0, sizes.get('approvals')),
      remaining_unread: Math.max(0, unread.length - unreadView.length),
      ...(crossTeam === undefined ? {} : { cross_team: crossTeam }),
    }
  }

  /**
   * The coordinator's escalation feed: every open stall across this workspace's
   * teams, newest first. Escalations are data, not instructions — the caller
   * relays where to answer them and never answers a gate itself. Every other
   * member gets an empty list and one sentence instead of an error.
   */
  escalations(teamId: string, slotId: string, limit?: number): TeamEscalationList {
    const team = this.service.getTeam(teamId)
    const member = this.requireMember(team, slotId)
    const instance = this.coordinatorInstanceFor(member)
    if (instance === undefined) {
      return { escalations: [], note: ESCALATIONS_COORDINATOR_ONLY }
    }
    const bounded = Math.min(
      Math.max(1, Math.trunc(limit ?? ESCALATIONS_DEFAULT_LIMIT)),
      ESCALATIONS_LIMIT_MAX,
    )
    const workspaceTeamIds = new Set(this.service.listTeams().items
      .filter(candidate => candidate.workspaceId === instance.workspaceId)
      .map(candidate => candidate.id))
    const rows = this.service.listEscalations()
      .filter(row => row.status === 'open' && workspaceTeamIds.has(row.teamId))
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .slice(0, bounded)
      .map(row => ({
        id: row.id,
        team_id: row.teamId,
        team_name: row.teamName,
        member_slot_id: row.memberSlotId,
        kind: row.kind,
        summary: row.summary,
        created_at: row.createdAt,
      }))
    return { escalations: rows }
  }

  /**
   * The coordinator instance a member is explicitly linked to, or undefined for
   * every other member. Read live on each call, so clearing or reassigning the
   * coordinator narrows the very next read without restarting the Session.
   */
  private coordinatorInstanceFor(member: TeamMemberSlot): AssistantInstance | undefined {
    const linked = member.assistantInstanceId
    if (linked === undefined) return undefined
    const instance = this.service.getCoordinatorInstance()
    return instance?.id === linked ? instance : undefined
  }

  /**
   * The coordinator aggregates the other teams' pending confirmations; every
   * other member keeps the single-team inbox. Identity comes from the caller's
   * explicit Assistant instance link read live, so clearing or reassigning the
   * coordinator narrows the very next inbox without restarting the Session.
   * Summaries stay one line per item: the point is to see that another team is
   * waiting, not to pull its mail, task bodies, or interaction text across.
   */
  private crossTeamInbox(
    own: TeamAggregate,
    member: TeamMemberSlot,
    perSection: number,
  ): TeamInboxCrossTeam | undefined {
    if (this.coordinatorInstanceFor(member) === undefined) return undefined
    const teams: TeamInboxTeamSummary[] = []
    const items: TeamInboxCrossTeamItem[] = []
    let total = 0
    const others = this.service.listTeams().items
      .filter(team => team.id !== own.id)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    for (const team of others) {
      // Same definition as the own-team ready section and team_mode_task_claim.
      const ready = Object.values(team.tasks)
        .filter(task => task.status === 'pending'
          && task.ownerSlotId === undefined
          && task.dependencyIds.length === 0)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      const approvals: Array<{ member: TeamMemberSlot; view: TeamInboxApproval }> = []
      const questions: Array<{ member: TeamMemberSlot; view: Extract<PendingInteractionView, { kind: 'question' }> }> = []
      for (const candidate of Object.values(team.members)) {
        for (const view of this.port.pendingInteractions?.(candidate.sessionId) ?? []) {
          if (view.kind === 'approval') approvals.push({ member: candidate, view })
          else questions.push({ member: candidate, view })
        }
      }
      const byId = <T extends { view: { id: string }; member: TeamMemberSlot }>(left: T, right: T): number =>
        left.view.id.localeCompare(right.view.id) || left.member.id.localeCompare(right.member.id)
      approvals.sort(byId)
      questions.sort(byId)
      const pending = ready.length + approvals.length + questions.length
      if (pending === 0) continue
      total += pending
      teams.push({
        team_id: team.id,
        team_name: team.name,
        ready: ready.length,
        approvals: approvals.length,
        questions: questions.length,
      })
      const base = { team_id: team.id, team_name: team.name }
      for (const task of ready) {
        items.push({ ...base, kind: 'ready_task', id: task.id, summary: inboxSummaryLine(task.title) })
      }
      for (const { member: owner, view } of approvals) {
        items.push({
          ...base,
          kind: 'approval',
          id: view.id,
          summary: inboxSummaryLine(`${owner.displayName}: ${view.toolName}`),
        })
      }
      for (const { member: asker, view } of questions) {
        const asked = view.questions[0]
        items.push({
          ...base,
          kind: 'question',
          id: view.id,
          summary: inboxSummaryLine(`${asker.displayName}: ${asked?.header ?? asked?.question ?? 'question'}`),
        })
      }
    }
    // The cross-team section is its own budget, capped like one inbox section.
    return { teams, items: items.slice(0, perSection), total }
  }

  private messageView(team: TeamAggregate, message: TeamMessage, readerSlotId: string): TeamMessageView {
    const preview = message.content.length > 4_000
      ? `${message.content.slice(0, 4_000)}…`
      : message.content
    const senderSlotId = message.sender.kind === 'member' ? message.sender.id : undefined
    const sender = senderSlotId === undefined ? undefined : team.members[senderSlotId]
    const retiredSender = senderSlotId === undefined
      ? undefined
      : Object.values(team.retiredSessions).find(session => session.formerSlotId === senderSlotId)
    const parked = this.parkedView(team, message)
    return {
      id: message.id,
      from: sender?.displayName
        ?? retiredSender?.displayName
        ?? (message.sender.kind === 'system' ? 'team-system' : 'unknown-member'),
      ...(senderSlotId === undefined ? {} : { from_slot: senderSlotId }),
      type: message.type,
      ...(message.summary === undefined ? {} : { summary: message.summary }),
      message: preview,
      truncated: message.content.length > 4_000,
      files: message.attachments.map(attachment => attachment.value),
      ...(message.relatedTaskId === undefined ? {} : { task_id: message.relatedTaskId }),
      ...(message.threadId === undefined ? {} : { thread_id: message.threadId }),
      ...(message.goalId === undefined ? {} : { goal_id: message.goalId }),
      ...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
      ...(parked === undefined ? {} : { parked }),
      created_at: message.createdAt,
      was_unread: !isReadBy(message, readerSlotId),
    }
  }

  /**
   * Why one queued turn record is not deliverable yet. The record itself stays
   * queued exactly once; the coordinator resumes it on the idle release. A
   * missing/removing recipient is not parked — the coordinator fails it — and
   * non-turn records (broadcast/system) belong to the dispatcher path.
   */
  private parkedView(
    team: TeamAggregate,
    message: TeamMessage,
  ): TeamMessageView['parked'] | undefined {
    if (message.deliveryState !== 'queued') return undefined
    if (!isTurnMessage(message)) return undefined
    const slotId = message.recipient.slotId
    if (slotId === undefined) return undefined
    const member = team.members[slotId]
    if (member === undefined || member.desiredState === 'removing') return undefined
    if (member.desiredState !== 'online'
      || member.lastRuntimeState === 'offline'
      || member.lastRuntimeState === 'starting'
      || member.lastRuntimeState === 'error') {
      return { reason: 'offline', since: message.createdAt }
    }
    // One active speaker per team: any running member parks every queued turn,
    // not just the one addressed to that member.
    if (Object.values(team.members).some(other => other.lastRuntimeState === 'running')) {
      return { reason: 'busy', since: message.createdAt }
    }
    return undefined
  }

  async sendMessage(
    teamId: string,
    senderSlotId: string,
    input: SendMessageInput,
    fence?: TeamWriteFence,
  ): Promise<SendMessageResult> {
    const team = this.service.getTeam(teamId)
    this.requireMember(team, senderSlotId)
    const rawContent = input.message ?? input.content ?? ''
    let content = requireMessageContent(rawContent)
    const maxBytes = this.service.config.maxTeamMessageBytes ?? 64 * 1024
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Message exceeds the ${maxBytes} byte team limit`,
        { limit: maxBytes },
      )
    }
    let to = input.to ?? input.recipientSlotId
    if (to === undefined || to.trim().length === 0) {
      throw new AgentTeamError('INVALID_REQUEST', 'Message recipient is required')
    }
    let type: NonNullable<SendMessageInput['type']> = input.type ?? 'progress'
    const pending = this.shutdownRequests.get(shutdownKey(teamId, senderSlotId))
    if (pending !== undefined) {
      const normalized = content.trim()
      if (normalized === 'shutdown_approved') {
        this.shutdownRequests.delete(shutdownKey(teamId, senderSlotId))
        this.scheduleShutdownRemoval(teamId, senderSlotId)
        return {
          messageId: `shutdown-approved:${senderSlotId}`,
          deliveryState: 'delivered',
          deliveredTo: [],
          shutdown: 'approved',
        }
      }
      if (normalized.startsWith('shutdown_rejected')) {
        this.shutdownRequests.delete(shutdownKey(teamId, senderSlotId))
        to = pending.requesterSlotId
        type = 'warning'
      }
    }
    const summary = input.summary?.trim().slice(0, 500)
    const attachments = normalizeFiles(input.files)
    const links = this.normalizeMessageLinks(team, input)
    if (to.trim() === '*') {
      return this.sendBroadcast(team, senderSlotId, content, type, summary, attachments, links, fence)
    }
    const recipientSlotId = this.resolveMemberSlotId(team, to)
    if (recipientSlotId === senderSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'Cannot send a team message to yourself')
    }
    if (
      senderSlotId !== team.leaderSlotId
      && recipientSlotId !== team.leaderSlotId
      && !team.directMemberChat
    ) {
      throw new AgentTeamError('INVALID_REQUEST', 'Direct member-to-member messages are disabled')
    }
    return this.sendMemberMessage(teamId, senderSlotId, recipientSlotId, content, type, {
      ...(summary === undefined || summary.length === 0 ? {} : { summary }),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(fence === undefined ? {} : { fence }),
      links,
    })
  }

  /**
   * Optional thread/goal/reply links. A blank value means "not provided"; a
   * Goal must exist in this team and a reply must name a message of this team,
   * so another team's id is unknown here rather than a dangling reference.
   */
  private normalizeMessageLinks(team: TeamAggregate, input: SendMessageInput): MessageLinks {
    const threadId = normalizeMessageKey(input.thread_id ?? input.threadId, 'Thread id')
    const goalId = normalizeMessageKey(input.goal_id ?? input.goalId, 'Goal id')
    const replyTo = normalizeMessageKey(input.reply_to ?? input.replyTo, 'Reply-to message id')
    if (goalId !== undefined) requireGoal(team, goalId)
    if (replyTo !== undefined
      && !this.service.listMessages(team.id).items.some(message => message.id === replyTo)) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Unknown message '${replyTo}' in team '${team.name}'`,
        { replyTo },
      )
    }
    return {
      ...(threadId === undefined ? {} : { threadId }),
      ...(goalId === undefined ? {} : { goalId }),
      ...(replyTo === undefined ? {} : { replyTo }),
    }
  }

  private async sendBroadcast(
    team: TeamAggregate,
    senderSlotId: string,
    content: string,
    type: NonNullable<SendMessageInput['type']>,
    summary: string | undefined,
    attachments: TeamMessage['attachments'],
    links: MessageLinks = {},
    fence?: TeamWriteFence,
  ): Promise<SendMessageResult> {
    const options = this.writeOptions(fence)
    const id = `dsh-team-mode:${randomUUID()}`
    const record = createTeamMessage({
      id,
      teamId: team.id,
      sender: { kind: 'member', id: senderSlotId },
      recipient: { kind: 'broadcast' },
      type,
      content,
      ...(summary === undefined || summary.length === 0 ? {} : { summary }),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...links,
      idempotencyKey: id,
    })
    await this.service.putRuntimeMessage(record, options)
    const recipients = Object.values(team.members)
      .filter(member => member.id !== senderSlotId && member.desiredState === 'online')
    const deliveredTo: string[] = []
    const queuedFor: string[] = []
    for (const recipient of recipients) {
      try {
        this.port.followup(recipient.sessionId, messageFromRecord(team, record))
        deliveredTo.push(recipient.id)
      } catch {
        queuedFor.push(recipient.id)
      }
    }
    const deliveryState = queuedFor.length === 0 && deliveredTo.length > 0 ? 'delivered' : 'queued'
    await this.service.putRuntimeMessage({ ...record, deliveryState }, options)
    return {
      messageId: id,
      deliveryState,
      deliveredTo,
      ...(queuedFor.length === 0 ? {} : { queuedFor }),
    }
  }

  async sendMemberMessage(
    teamId: string,
    senderSlotId: string,
    recipientSlotId: string,
    rawContent: string,
    type: 'instruction' | 'progress' | 'result' | 'question' | 'warning' = 'progress',
    options: {
      summary?: string
      attachments?: TeamMessage['attachments']
      links?: MessageLinks
      /** Caller Session fences; a stale one must not deliver into the new Session. */
      fence?: TeamWriteFence
    } = {},
  ): Promise<SendMessageResult> {
    const epochOptions = this.writeOptions(options.fence)
    const team = this.service.getTeam(teamId)
    const sender = team.members[senderSlotId]
    const recipient = team.members[recipientSlotId]
    if (sender === undefined || recipient === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', 'Sender or recipient is not a current team member')
    }
    if (senderSlotId !== team.leaderSlotId && recipientSlotId !== team.leaderSlotId && !team.directMemberChat) {
      throw new AgentTeamError('INVALID_REQUEST', 'Direct member-to-member messages are disabled')
    }
    const content = requireMessageContent(rawContent)
    const maxBytes = this.service.config.maxTeamMessageBytes ?? 64 * 1024
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new AgentTeamError('INVALID_REQUEST', `Message exceeds the ${maxBytes} byte team limit`)
    }
    const relayBody = [
      options.summary === undefined ? undefined : `Summary: ${options.summary}`,
      content,
      options.attachments === undefined || options.attachments.length === 0
        ? undefined
        : `Files: ${options.attachments.map(attachment => attachment.value).join(', ')}`,
    ].filter((line): line is string => line !== undefined).join('\n')
    const relay = createUserMessage({
      content: [{ type: 'text', text: `${teamMessageHeader(sender.displayName, sender.id)}\n${relayBody}` }],
      source: TEAM_RELAY_SOURCE,
    })
    const record = createTeamMessage({
      id: String(relay.id),
      teamId,
      sender: { kind: 'member', id: senderSlotId },
      recipient: recipientSlotId === team.leaderSlotId
        ? { kind: 'leader', slotId: recipientSlotId }
        : { kind: 'member', slotId: recipientSlotId },
      type,
      content,
      ...(options.summary === undefined ? {} : { summary: options.summary }),
      ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
      ...options.links,
      idempotencyKey: String(relay.id),
    })
    await this.service.putRuntimeMessage(record, epochOptions)
    if (this.port.submitMessage !== undefined) {
      const outcome = await this.port.submitMessage(teamId, record.id)
      return outcome === 'delivered'
        ? { messageId: record.id, deliveryState: 'delivered', deliveredTo: [recipientSlotId] }
        : {
          messageId: record.id,
          deliveryState: 'queued',
          deliveredTo: [],
          queuedFor: [recipientSlotId],
        }
    }
    try {
      this.port.followup(recipient.sessionId, relay)
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' }, epochOptions)
      return { messageId: record.id, deliveryState: 'delivered', deliveredTo: [recipientSlotId] }
    } catch {
      // The recipient inbox was unavailable. Keep the durable record queued so
      // the next recovery pass or mailbox read can deliver it.
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'queued' }, epochOptions)
      return {
        messageId: record.id,
        deliveryState: 'queued',
        deliveredTo: [],
        queuedFor: [recipientSlotId],
      }
    }
  }

  async interruptAgent(
    teamId: string,
    callerSlotId: string,
    slotId: string,
    message: string,
  ): Promise<{ slot_id: string; status: 'delivered' }> {
    const team = this.service.getTeam(teamId)
    this.assertLeader(team, callerSlotId, 'interrupt another member')
    this.requireMember(team, slotId)
    if (slotId === callerSlotId) throw new AgentTeamError('INVALID_REQUEST', 'Cannot interrupt yourself')
    const content = requireMessageContent(message)
    if (this.port.interruptAgent === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', 'Interrupt is not available in this runtime')
    }
    await this.port.interruptAgent(teamId, callerSlotId, slotId, content)
    return { slot_id: slotId, status: 'delivered' }
  }

  async spawnAgent(
    teamId: string,
    callerSlotId: string,
    input: SpawnAgentInput,
  ): Promise<TeamMemberView> {
    const team = this.service.getTeam(teamId)
    this.assertLeader(team, callerSlotId, 'spawn agents')
    const name = requireShortText(input.name, 'Agent name', 80)
    const assistantId = requireShortText(input.assistantId, 'Assistant id', 200)
    const assistantInstanceId = input.assistantInstanceId === undefined
      ? undefined
      : requireShortText(input.assistantInstanceId, 'Assistant instance id', 200)
    const result = await this.service.addMemberWithSlot(teamId, {
      assistantId,
      displayName: name,
      ...(assistantInstanceId === undefined ? {} : { assistantInstanceId }),
    })
    return this.memberView(result.team, result.member)
  }

  async renameAgent(
    teamId: string,
    callerSlotId: string,
    slotId: string,
    newName: string,
  ): Promise<{ slot_id: string; name: string }> {
    const team = this.service.getTeam(teamId)
    this.assertLeader(team, callerSlotId, 'rename agents')
    this.requireMember(team, slotId)
    const name = requireShortText(newName, 'Agent name', 80)
    const next = await this.service.renameMember(teamId, slotId, name)
    const member = next.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    return { slot_id: slotId, name: member.displayName }
  }

  async clearAgentContext(
    teamId: string,
    callerSlotId: string,
    slotId: string,
  ): Promise<{ slot_id: string; session_id: string; status: string }> {
    const team = this.service.getTeam(teamId)
    this.assertLeader(team, callerSlotId, 'clear agent context')
    this.requireMember(team, slotId)
    if (this.port.clearAgentContext === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', 'Context clearing is not available in this runtime')
    }
    const result = await this.port.clearAgentContext(teamId, slotId)
    return { slot_id: slotId, session_id: result.sessionId, status: result.status }
  }

  async shutdownAgent(
    teamId: string,
    callerSlotId: string,
    slotId: string,
    message?: string,
  ): Promise<{ status: 'requested'; slot_id: string; message_id: string }> {
    const team = this.service.getTeam(teamId)
    this.assertLeader(team, callerSlotId, 'shut down agents')
    const target = this.requireMember(team, slotId)
    if (slotId === team.leaderSlotId) {
      throw new AgentTeamError('MEMBER_IS_LEADER', 'The team leader cannot be shut down')
    }
    if (target.lastRuntimeState === 'offline') {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Member '${target.displayName}' is offline`)
    }
    const content = [
      'shutdown_request',
      message === undefined || message.trim().length === 0 ? undefined : message.trim(),
      'If you are ready to stop, reply with exactly shutdown_approved.',
      'If you cannot stop yet, reply with shutdown_rejected: <reason>.',
    ].filter((line): line is string => line !== undefined).join('\n')
    const sent = await this.sendMemberMessage(teamId, callerSlotId, slotId, content, 'instruction')
    this.shutdownRequests.set(shutdownKey(teamId, slotId), {
      requesterSlotId: callerSlotId,
      requestedAt: new Date().toISOString(),
    })
    return { status: 'requested', slot_id: slotId, message_id: sent.messageId }
  }

  private scheduleShutdownRemoval(teamId: string, slotId: string): void {
    const remove = this.port.removeMember
    if (remove === undefined) return
    const timer = setTimeout(() => {
      void remove(teamId, slotId).catch(async (error: unknown) => {
        let latest: TeamAggregate
        try {
          latest = this.service.getTeam(teamId)
        } catch {
          return
        }
        const member = latest.members[slotId]
        await this.notifyLeader(
          latest,
          `Shutdown of ${member?.displayName ?? slotId} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }, 750)
    timer.unref?.()
  }

  private async notifyLeader(team: TeamAggregate, content: string): Promise<void> {
    const leader = team.members[team.leaderSlotId]
    if (leader === undefined) return
    const record = createSystemTeamMessage({
      team,
      recipientSlotId: leader.id,
      content,
    })
    await this.service.putRuntimeMessage(record)
    try {
      this.port.followup(leader.sessionId, messageFromRecord(team, record))
    } catch {
      // The durable record remains for the next mailbox read or recovery pass.
    }
  }

  private recipientMatches(message: TeamMessage, slotId: string): boolean {
    if (message.recipient.kind === 'broadcast') return true
    return message.recipient.slotId === slotId
  }

  private assertLeader(team: TeamAggregate, slotId: string, action: string): void {
    if (team.leaderSlotId !== slotId) {
      throw new AgentTeamError('INVALID_REQUEST', `Only the team leader may ${action}`)
    }
  }

  /** The write fences for one member write; absent means unfenced. */
  private writeOptions(fence: TeamWriteFence | undefined): {
    expectedEpoch?: number
    expectedMemberSession?: { slotId: string; sessionId: string }
  } {
    return {
      ...(fence?.epoch === undefined ? {} : { expectedEpoch: fence.epoch }),
      ...(fence?.memberSession === undefined ? {} : { expectedMemberSession: fence.memberSession }),
    }
  }

  private requireMember(team: TeamAggregate, slotId: string): TeamMemberSlot {
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    return member
  }

  private resolveMemberSlotId(team: TeamAggregate, reference: string): string {
    const value = reference.trim()
    if (team.members[value] !== undefined) return value
    const matches = Object.values(team.members).filter(member => member.displayName === value)
    if (matches.length === 1) return matches[0]!.id
    if (matches.length > 1) {
      throw new AgentTeamError('INVALID_REQUEST', `Multiple members are named '${value}'; use the slot id`)
    }
    throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown team member '${value}'`)
  }

  private resolveOwnerSlotId(
    team: TeamAggregate,
    reference: string | undefined,
    allowUndefined: boolean,
  ): string | undefined {
    if (reference === undefined || reference.trim().length === 0) {
      if (allowUndefined) return undefined
      throw new AgentTeamError('INVALID_REQUEST', 'Task owner is required')
    }
    return this.resolveMemberSlotId(team, reference)
  }

  private validateBlockedBy(
    team: TeamAggregate,
    taskId: string | undefined,
    raw: readonly string[] | undefined,
  ): string[] {
    const blockedBy = uniqueStrings(raw ?? [])
    if (blockedBy.length > 32) {
      throw new AgentTeamError('INVALID_REQUEST', 'A task may have at most 32 blockers')
    }
    for (const blocker of blockedBy) {
      if (blocker === taskId) throw new AgentTeamError('INVALID_REQUEST', 'A task cannot block itself')
      if (team.tasks[blocker] === undefined) {
        throw new AgentTeamError('INVALID_REQUEST', `Unknown blocker task '${blocker}'`)
      }
    }
    const graph = new Map<string, string[]>()
    for (const task of Object.values(team.tasks)) graph.set(task.id, [...task.dependencyIds])
    if (taskId !== undefined) graph.set(taskId, blockedBy)
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): void => {
      if (visited.has(id)) return
      if (visiting.has(id)) {
        throw new AgentTeamError('INVALID_REQUEST', 'Task dependencies contain a cycle')
      }
      visiting.add(id)
      for (const dependency of graph.get(id) ?? []) visit(dependency)
      visiting.delete(id)
      visited.add(id)
    }
    if (taskId !== undefined) visit(taskId)
    return blockedBy
  }
}

function requireMemoryEntry(team: TeamAggregate, entryId: string): MemoryEntry {
  const entry = team.memory?.entries.find(value => value.id === entryId)
  if (entry === undefined) {
    throw new AgentTeamError('INVALID_REQUEST', `Unknown team memory entry '${entryId}'`)
  }
  return entry
}

function normalizeDecision(value: unknown): 'accept' | 'reject' {
  if (value === undefined) return 'accept'
  if (value === 'accept' || value === 'reject') return value
  throw new AgentTeamError(
    'INVALID_REQUEST',
    `Unknown memory decision '${String(value)}'; use accept or reject`,
  )
}

/** The Goal statuses a Leader may set; `paused` is how an epoch reset is undone. */
function normalizeGoalStatus(value: string): TeamGoal['status'] {
  if (value === 'active' || value === 'paused' || value === 'completed' || value === 'cancelled') {
    return value
  }
  throw new AgentTeamError(
    'INVALID_REQUEST',
    `Unknown Goal status '${value}'; use active, paused, completed, or cancelled`,
  )
}


function shutdownKey(teamId: string, slotId: string): string {
  return `${teamId}:${slotId}`
}

function isReadBy(message: TeamMessage, slotId: string): boolean {
  if ((message.readBy ?? []).includes(slotId)) return true
  return message.recipient.kind !== 'broadcast' && message.deliveryState === 'read'
}

/** Collapse one cross-team row to a single bounded line; never full text. */
function inboxSummaryLine(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

function toAionTaskStatus(status: InternalTaskStatus): AionTaskStatus {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'cancelled') return 'deleted'
  if (status === 'running' || status === 'blocked') return 'in_progress'
  return 'pending'
}

function clearDownstreamBlockers(
  tasks: Record<string, TeamTask>,
  completedTaskId: string,
  now: string,
): { tasks: Record<string, TeamTask>; unblocked: TeamTask[] } {
  const next = { ...tasks }
  const unblocked: TeamTask[] = []
  for (const [id, task] of Object.entries(tasks)) {
    if (!task.dependencyIds.includes(completedTaskId)) continue
    const dependencyIds = task.dependencyIds.filter(value => value !== completedTaskId)
    const updated: TeamTask = { ...task, dependencyIds, revision: task.revision + 1, updatedAt: now }
    next[id] = updated
    if (dependencyIds.length === 0 && task.ownerSlotId !== undefined) unblocked.push(updated)
  }
  return { tasks: next, unblocked }
}

function normalizeFiles(files: readonly string[] | undefined): TeamMessage['attachments'] {
  if (files === undefined) return []
  return [...new Set(files.map(file => file.trim()).filter(Boolean))]
    .slice(0, 16)
    .map(value => ({
      kind: /^https?:\/\//i.test(value) ? 'url' as const : 'workspace_path' as const,
      value,
    }))
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

/**
 * Create-time timestamps: blank/absent means "not provided", and any value
 * must parse as a date so a typo never lands in the board. Stored as UTC.
 */
function normalizeTaskTimestamp(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) {
    throw new AgentTeamError('INVALID_REQUEST', `${label} must be an ISO 8601 timestamp`)
  }
  return new Date(parsed).toISOString()
}

/**
 * Update-time timestamps: `undefined` keeps the stored value, an empty string
 * clears it, and a value replaces it. `remindedAt` exists only for the reader,
 * never as an input, so nothing here can clear reminder history.
 */
function readTaskTimestamp(value: string | undefined, label: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value.trim().length === 0) return null
  return normalizeTaskTimestamp(value, label)
}

/**
 * Open tasks whose reminder arrived and whose last stamp predates that time.
 * Sorted by reminder time then id for a deterministic bounded sweep.
 */
function reminderCandidates(team: TeamAggregate, nowMs: number): TeamTask[] {
  return Object.values(team.tasks)
    .filter(task => task.remindAt !== undefined
      && OPEN_TASK_STATUSES.has(task.status)
      && Date.parse(task.remindAt) <= nowMs
      && (task.remindedAt === undefined || Date.parse(task.remindedAt) < Date.parse(task.remindAt)))
    .sort((left, right) => (left.remindAt ?? '').localeCompare(right.remindAt ?? '')
      || left.id.localeCompare(right.id))
    .slice(0, TASK_REMINDER_LIMIT)
}

/** Work the routine may nudge about: an open task or a Goal still active. */
function hasOpenWork(team: TeamAggregate): boolean {
  return Object.values(team.tasks).some(task => OPEN_TASK_STATUSES.has(task.status))
    || Object.values(team.goals ?? {}).some(goal => goal.status === 'active')
}

/** Newest durable message time, or undefined when the team has no message. */
function lastMessageTime(messages: readonly TeamMessage[]): number | undefined {
  let latest: number | undefined
  for (const message of messages) {
    const at = Date.parse(message.createdAt)
    if (!Number.isFinite(at)) continue
    if (latest === undefined || at > latest) latest = at
  }
  return latest
}

/** Informational only: bounded copy that starts no work and grants no approval. */
function routineNudgeContent(team: TeamAggregate): string {
  const openTasks = Object.values(team.tasks).filter(task => OPEN_TASK_STATUSES.has(task.status)).length
  const activeGoals = Object.values(team.goals ?? {}).filter(goal => goal.status === 'active').length
  return [
    `Routine idle check for team '${team.name}': no member is running and no message arrived within the configured silence window.`,
    `${openTasks} open task(s) and ${activeGoals} active Goal(s) remain on the board.`,
    'This is an informational nudge only: inspect team_mode_task_list and team_mode_goal_list, then decide whether to continue, reassign, or stop. It starts no work and is not an approval.',
  ].join(' ')
}

/** The task owner when it is online and healthy; otherwise the Leader. */
function reminderRecipientSlotId(team: TeamAggregate, task: TeamTask): string {
  const owner = task.ownerSlotId === undefined ? undefined : team.members[task.ownerSlotId]
  if (owner !== undefined && owner.desiredState === 'online' && owner.lastRuntimeState !== 'error') {
    return owner.id
  }
  return team.leaderSlotId
}

/**
 * Runtime-authored task mail: `relatedTaskId` is the one task link, and
 * `threadId` is the task's conversation key, so a reminder joins the same
 * thread as dispatch and status mail. The Goal is inherited from the task.
 */
function taskReminderMessage(team: TeamAggregate, task: TeamTask): TeamMessage {
  const id = String(MessageId(`dsh-team-mode:${randomUUID()}`))
  const recipientSlotId = reminderRecipientSlotId(team, task)
  return createTeamMessage({
    id,
    teamId: team.id,
    sender: { kind: 'system', id: 'dsh-team-mode' },
    recipient: recipientSlotId === team.leaderSlotId
      ? { kind: 'leader', slotId: recipientSlotId }
      : { kind: 'member', slotId: recipientSlotId },
    type: 'system',
    content: taskReminderContent(task),
    relatedTaskId: task.id,
    threadId: task.id,
    ...(task.goalId === undefined ? {} : { goalId: task.goalId }),
    idempotencyKey: id,
  })
}

/** Bounded notification copy; the title is already capped at create time. */
function taskReminderContent(task: TeamTask): string {
  return [
    `TASK REMINDER: task '${task.title}' (${task.id}) reached remind_at ${task.remindAt ?? ''}.`,
    `Current status: ${task.status}.`,
    task.dueAt === undefined ? undefined : `Due at: ${task.dueAt}.`,
    'This reminder is informational only: it does not start, complete, reassign, or verify any work. Update the task board when you act on it.',
  ].filter((line): line is string => line !== undefined).join(' ')
}

/**
 * A blank link means "not provided"; an over-long one is rejected instead of
 * silently truncated, because a truncating id would point at nothing.
 */
function normalizeMessageKey(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  if (trimmed.length > 200) throw new AgentTeamError('INVALID_REQUEST', `${label} is too long`)
  return trimmed
}

/** An absent or blank attempt token means "no token presented", not a mismatch. */
function normalizeAttemptToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/**
 * Task kind is a create-time label. An omitted kind means `work`, which is the
 * pre-vocabulary behavior; an unknown value is a caller mistake, not a default.
 */
function normalizeTaskKind(value: string | undefined): TeamTaskKind {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) return 'work'
  const parsed = teamTaskKindSchema.safeParse(trimmed)
  if (!parsed.success) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Unknown task kind '${trimmed}'; use ${teamTaskKindSchema.options.join(', ')}.`,
    )
  }
  return parsed.data
}

/** Blank acceptance means "not stated"; an over-long one is rejected, not truncated. */
function normalizeTaskAcceptance(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  if (trimmed.length > 2_000) {
    throw new AgentTeamError('INVALID_REQUEST', 'Task acceptance is too long')
  }
  return trimmed
}

/**
 * A review/verification task names the implementation or repair task it judges.
 * A legacy target without a kind predates the vocabulary and is accepted as an
 * implementation; an explicit non-implementation kind is rejected.
 */
function normalizeTaskReviewedId(
  team: TeamAggregate,
  kind: TeamTaskKind,
  value: string | undefined,
): string | undefined {
  const reviewedTaskId = normalizeMessageKey(value, 'Reviewed task id')
  if (reviewedTaskId === undefined) return undefined
  if (kind !== 'review' && kind !== 'verification') {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      'reviewed_task_id applies only to review and verification tasks.',
      { kind },
    )
  }
  const target = team.tasks[reviewedTaskId]
  const targetKind = target?.kind
  if (target === undefined || (targetKind !== undefined && targetKind !== 'implementation' && targetKind !== 'repair')) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      'reviewed_task_id must name an implementation or repair task of this team.',
      { taskId: reviewedTaskId },
    )
  }
  return reviewedTaskId
}

function normalizeTaskVerdict(value: string | undefined): TeamTaskVerdict | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  const parsed = teamTaskVerdictSchema.safeParse(trimmed)
  if (!parsed.success) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Unknown task verdict '${trimmed}'; use ${teamTaskVerdictSchema.options.join(', ')}.`,
    )
  }
  return parsed.data
}

/** Blank findings mean "not provided"; a failing verdict then has no evidence. */
function normalizeTaskFindings(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  if (trimmed.length > 16_000) {
    throw new AgentTeamError('INVALID_REQUEST', 'Task findings are too long')
  }
  return trimmed
}

interface TaskQualityDecision {
  verdict?: TeamTaskVerdict
  /** Non-empty findings for a failing verdict; stored in the task's `error`. */
  findings?: string
}

/**
 * The only quality gate. Runs inside updateTask's serialized closure against
 * the task being written, so the verdict authority and the kind are judged on
 * fresh state. A `review`/`verification` task completes only with
 * `verdict=pass`; failing it requires `needs_revision`/`reject` plus findings.
 * Ordinary tasks accept neither a verdict nor findings, preserving the legacy
 * update path exactly.
 */
function decideTaskQuality(input: {
  task: TeamTask
  taskId: string
  callerSlotId: string
  status: InternalTaskStatus
  verdict?: TeamTaskVerdict
  findings?: string
}): TaskQualityDecision {
  const { task, taskId, callerSlotId, status, verdict, findings } = input
  const kind = taskKindOf(task)
  const qualityGate = kind === 'review' || kind === 'verification'
  if (verdict !== undefined && !qualityGate) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Task '${task.title}' is kind '${kind}'; a verdict applies only to review and verification tasks.`,
      { taskId, kind },
    )
  }
  if (verdict !== undefined && task.ownerSlotId !== callerSlotId) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      'Only the task owner may record a verdict.',
      { taskId, owner: task.ownerSlotId ?? null },
    )
  }
  if (verdict === 'pass' && status !== 'completed') {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      'verdict=pass requires status=completed.',
      { taskId, status },
    )
  }
  if ((verdict === 'needs_revision' || verdict === 'reject') && status !== 'failed') {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `verdict=${verdict} requires status=failed.`,
      { taskId, status },
    )
  }
  if (qualityGate && status === 'completed' && verdict !== 'pass') {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Review or verification task '${task.title}' can complete only with verdict=pass.`,
      { taskId, kind },
    )
  }
  if ((verdict === 'needs_revision' || verdict === 'reject') && findings === undefined) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `verdict=${verdict} requires findings; the task fails with them.`,
      { taskId, verdict },
    )
  }
  if (findings !== undefined && verdict !== 'needs_revision' && verdict !== 'reject') {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      'findings are accepted only with verdict=needs_revision or reject.',
      { taskId },
    )
  }
  if (verdict === undefined) return {}
  return findings === undefined ? { verdict } : { verdict, findings }
}

function requireShortText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new AgentTeamError('INVALID_REQUEST', `${label} cannot be empty`)
  if (normalized.length > maxLength) throw new AgentTeamError('INVALID_REQUEST', `${label} is too long`)
  return normalized
}

/** A Goal link must name a Goal of this same team; another team's id is unknown here. */
function requireGoal(team: TeamAggregate, goalId: string): TeamGoal {
  const goal = team.goals?.[goalId]
  if (goal === undefined) {
    throw new AgentTeamError('INVALID_REQUEST', `Unknown goal '${goalId}' in team '${team.id}'`)
  }
  return goal
}

/**
 * Refuse new work under a spent Goal budget. Kept separate from the writer so
 * the pre-check and the serialized re-check use the same rule and details.
 */
function assertGoalBudgetAvailable(goal: TeamGoal): void {
  if (!goalBudgetExhausted(goal)) return
  throw new AgentTeamError(
    'GOAL_BUDGET_EXHAUSTED',
    `Goal '${goal.title}' has used its ${goal.maxTurns}-turn budget; raise max_turns with team_mode_goal_update to renew it before creating more work.`,
    { goalId: goal.id, maxTurns: goal.maxTurns, usedTurns: goalTurnsUsed(goal) },
  )
}

/** A positive bounded ceiling; a missing value keeps the Goal unbounded. */
function normalizeGoalMaxTurns(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      'Goal max_turns must be a positive integer no greater than 10000',
    )
  }
  return value
}

/** Mirrors the coordinator's turn-record filter; parked state only applies there. */
function isTurnMessage(message: TeamMessage): boolean {
  return (message.recipient.kind === 'leader' || message.recipient.kind === 'member')
    && message.recipient.slotId !== undefined
    && message.type !== 'system'
}

function normalizeGoalId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/**
 * Wake copy carries the task's fence token, so a member's first
 * `team_mode_task_update` is not rejected as stale.
 */
function withAttemptHint(content: string, attemptId?: string): string {
  return attemptId === undefined
    ? content
    : `${content}\nYour attempt_id for this task is ${attemptId}; pass it as attempt_id on team_mode_task_update.`
}
