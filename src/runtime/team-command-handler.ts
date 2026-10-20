import { randomUUID } from 'node:crypto'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentTeamError } from '../domain/errors.js'
import type {
  TeamAggregate,
  TeamMemberSlot,
  TeamMessage,
  TeamTask,
} from '../domain/types.js'
import type { AgentTeamService } from '../service/dsh-team-mode-service.js'
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

export interface TeamCommandPort {
  deliverMessage: (teamId: string, messageId: string) => Promise<boolean>
  followup: (sessionId: string, message: UserMessage) => void
  /** Stop the target's current turn, then deliver the replacement message. */
  interruptAgent?: (teamId: string, callerSlotId: string, slotId: string, message: string) => Promise<void>
  /** Give one member a fresh session without touching the rest of the team. */
  clearAgentContext?: (teamId: string, slotId: string) => Promise<{ sessionId: string; status: string }>
  /** Remove one member after an approved shutdown handshake. */
  removeMember?: (teamId: string, slotId: string) => Promise<unknown>
}

export interface TeamMemberView {
  slot_id: string
  name: string
  role: 'leader' | 'member'
  assistant_id: string
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
  created_by?: string
  blocked_by: string[]
  blocks: string[]
  file_scopes: string[]
  result?: string
  error?: string
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
  created_at: string
  was_unread: boolean
}

export interface ReadMessagesResult {
  messages: TeamMessageView[]
  remaining_unread: number
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
}

export interface SendMessageInput {
  to?: string
  recipientSlotId?: string
  message?: string
  content?: string
  summary?: string
  files?: string[]
  type?: 'instruction' | 'progress' | 'result' | 'question' | 'warning'
}

export interface SpawnAgentInput {
  name: string
  assistantId: string
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
  ): Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }> {
    const team = this.service.getTeam(teamId)
    this.assertLeader(team, creatorSlotId, 'create tasks')
    const title = requireShortText(input.subject ?? input.title ?? '', 'Task subject', 500)
    const description = (input.description ?? '').trim().slice(0, 16_000)
    const ownerSlotId = this.resolveOwnerSlotId(team, input.owner ?? input.ownerSlotId, true)
    const blockedBy = this.validateBlockedBy(team, undefined, input.blocked_by ?? input.blockedBy)
    const fileScopes = uniqueStrings(input.fileScopes ?? []).slice(0, 64)
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
    const owner = ownerSlotId === undefined ? undefined : team.members[ownerSlotId]
    const assignment = owner === undefined || owner.id === creatorSlotId
      ? undefined
      : createTaskDispatchMessage({
        team,
        senderSlotId: creatorSlotId,
        recipientSlotId: owner.id,
        taskId,
        type: 'instruction',
        content: assignmentContent(title, description, fileScopes, blockedBy, taskId),
      })
    await this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        tasks: {
          ...current.tasks,
          [taskId]: {
            id: taskId,
            title,
            description,
            status,
            ...(ownerSlotId === undefined ? {} : { ownerSlotId }),
            createdBySlotId: creatorSlotId,
            dependencyIds: blockedBy,
            fileScopes,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          },
        },
        outbox: assignment === undefined
          ? current.outbox
          : { ...current.outbox, [assignment.id]: assignment },
      }),
      'team.task_created',
      `Task ${title} created`,
    )
    if (assignment === undefined) return { taskId, status }
    const delivered = await this.port.deliverMessage(teamId, assignment.id)
    return { taskId, status, deliveryState: delivered ? 'delivered' : 'queued' }
  }

  async updateTask(
    teamId: string,
    callerSlotId: string,
    input: UpdateTaskInput,
  ): Promise<{
    taskId: string
    status: string
    deliveryState?: 'queued' | 'delivered'
    woken?: string[]
  }> {
    const team = this.service.getTeam(teamId)
    const taskId = input.task_id ?? input.taskId ?? ''
    const task = team.tasks[taskId]
    if (task === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown task '${taskId}'`)
    if (callerSlotId !== team.leaderSlotId && task.ownerSlotId !== callerSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'A member may update only its own task')
    }
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
    const ownerChanged = requestedOwner !== undefined && nextOwnerSlotId !== task.ownerSlotId
    const now = new Date().toISOString()
    let updatedTask: TeamTask = {
      ...task,
      status: nextStatus,
      ...(nextOwnerSlotId === undefined ? {} : { ownerSlotId: nextOwnerSlotId }),
      dependencyIds: nextBlockedBy,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.error === undefined ? {} : { error: input.error }),
      revision: task.revision + 1,
      updatedAt: now,
    }
    let tasks: Record<string, TeamTask> = { ...team.tasks, [taskId]: updatedTask }
    const unblocked: TeamTask[] = []
    if (nextStatus === 'completed' || nextStatus === 'cancelled') {
      const cleared = clearDownstreamBlockers(tasks, taskId, now)
      tasks = cleared.tasks
      unblocked.push(...cleared.unblocked)
    }
    updatedTask = tasks[taskId] ?? updatedTask

    const notifications: TeamMessage[] = []
    if (ownerChanged && nextOwnerSlotId !== undefined && nextOwnerSlotId !== callerSlotId) {
      notifications.push(createTaskDispatchMessage({
        team,
        senderSlotId: callerSlotId,
        recipientSlotId: nextOwnerSlotId,
        taskId: task.id,
        type: 'instruction',
        content: reassignmentContent(task.title, input.result, input.error),
      }))
    } else if (callerSlotId !== team.leaderSlotId) {
      notifications.push(createTaskDispatchMessage({
        team,
        senderSlotId: callerSlotId,
        recipientSlotId: team.leaderSlotId,
        taskId: task.id,
        type: taskMessageType(nextStatus),
        content: taskUpdateContent(task.title, nextStatus, input.result, input.error),
      }))
    }
    const woken: string[] = []
    for (const ready of unblocked) {
      if (ready.ownerSlotId === undefined || ready.ownerSlotId === callerSlotId) continue
      const notification = createTaskDispatchMessage({
        team,
        senderSlotId: callerSlotId,
        recipientSlotId: ready.ownerSlotId,
        taskId: ready.id,
        type: 'instruction',
        content: `Task '${ready.title}' is unblocked and ready for you (task id: ${ready.id}). Use team_task_update to mark it in_progress.`,
      })
      notifications.push(notification)
      woken.push(ready.ownerSlotId)
    }
    await this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        tasks,
        outbox: notifications.length === 0
          ? current.outbox
          : {
            ...current.outbox,
            ...Object.fromEntries(notifications.map(message => [message.id, message])),
          },
      }),
      'team.task_updated',
      `Task ${task.title} entered ${nextStatus}`,
    )
    let delivered = true
    for (const notification of notifications) {
      delivered = await this.port.deliverMessage(teamId, notification.id) && delivered
    }
    return {
      taskId: task.id,
      status: updatedTask.status,
      ...(notifications.length === 0 ? {} : { deliveryState: delivered ? 'delivered' as const : 'queued' as const }),
      ...(woken.length === 0 ? {} : { woken }),
    }
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
      ...(task.createdBySlotId === undefined ? {} : { created_by: task.createdBySlotId }),
      blocked_by: [...task.dependencyIds],
      blocks: allTasks
        .filter(other => other.dependencyIds.includes(task.id))
        .map(other => other.id),
      file_scopes: [...task.fileScopes],
      ...(task.result === undefined ? {} : { result: task.result }),
      ...(task.error === undefined ? {} : { error: task.error }),
      revision: task.revision,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    }
  }

  async readMessages(teamId: string, slotId: string, limit = 20): Promise<ReadMessagesResult> {
    const team = this.service.getTeam(teamId)
    this.requireMember(team, slotId)
    const bounded = Math.max(1, Math.min(limit, 50))
    const eligible = this.service.listMessages(teamId).items
      .filter(message => message.sender.kind !== 'user')
      .filter(message => message.sender.id !== slotId)
      .filter(message => this.recipientMatches(message, slotId))
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

  private messageView(team: TeamAggregate, message: TeamMessage, readerSlotId: string): TeamMessageView {
    const preview = message.content.length > 4_000
      ? `${message.content.slice(0, 4_000)}…`
      : message.content
    const senderSlotId = message.sender.kind === 'member' ? message.sender.id : undefined
    const sender = senderSlotId === undefined ? undefined : team.members[senderSlotId]
    const retiredSender = senderSlotId === undefined
      ? undefined
      : Object.values(team.retiredSessions).find(session => session.formerSlotId === senderSlotId)
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
      created_at: message.createdAt,
      was_unread: !isReadBy(message, readerSlotId),
    }
  }

  async sendMessage(
    teamId: string,
    senderSlotId: string,
    input: SendMessageInput,
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
    if (to.trim() === '*') {
      return this.sendBroadcast(team, senderSlotId, content, type, summary, attachments)
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
    })
  }

  private async sendBroadcast(
    team: TeamAggregate,
    senderSlotId: string,
    content: string,
    type: NonNullable<SendMessageInput['type']>,
    summary: string | undefined,
    attachments: TeamMessage['attachments'],
  ): Promise<SendMessageResult> {
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
      idempotencyKey: id,
    })
    await this.service.putRuntimeMessage(record)
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
    await this.service.putRuntimeMessage({ ...record, deliveryState })
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
    options: { summary?: string; attachments?: TeamMessage['attachments'] } = {},
  ): Promise<SendMessageResult> {
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
      idempotencyKey: String(relay.id),
    })
    await this.service.putRuntimeMessage(record)
    try {
      this.port.followup(recipient.sessionId, relay)
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
      return { messageId: record.id, deliveryState: 'delivered', deliveredTo: [recipientSlotId] }
    } catch {
      // The recipient inbox was unavailable. Keep the durable record queued so
      // the next recovery pass or mailbox read can deliver it.
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'queued' })
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
    const result = await this.service.addMemberWithSlot(teamId, {
      assistantId,
      displayName: name,
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

function shutdownKey(teamId: string, slotId: string): string {
  return `${teamId}:${slotId}`
}

function isReadBy(message: TeamMessage, slotId: string): boolean {
  if ((message.readBy ?? []).includes(slotId)) return true
  return message.recipient.kind !== 'broadcast' && message.deliveryState === 'read'
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

function requireShortText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new AgentTeamError('INVALID_REQUEST', `${label} cannot be empty`)
  if (normalized.length > maxLength) throw new AgentTeamError('INVALID_REQUEST', `${label} is too long`)
  return normalized
}
