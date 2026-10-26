import { isCoordinatorInstance } from '../domain/types.js'
import type { AssistantInstance, AssistantSession } from '../domain/types.js'
import type { AssistantInstanceView } from '../transport/contracts.js'
import { isAssistantUnread } from './assistant-read-state.js'
import { assistantInstanceStatusLabel } from './labels.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** Upload and stored-value bounds shared by the avatar editor and snapshot schema. */
export const ASSISTANT_AVATAR_MAX_FILE_BYTES = 256 * 1024
export const ASSISTANT_AVATAR_MAX_DATA_URL_LENGTH = 400_000

export type AssistantRowStatus = 'needs_input' | 'running' | 'queued' | 'none'

/**
 * What a row actually reads. An instance that failed or is still waking up
 * outranks its task activity: a broken assistant is never 空闲.
 */
export type AssistantRowState = AssistantRowStatus | 'error' | 'starting'

export interface AssistantRowActivity {
  status: AssistantRowStatus
  /** Number of tasks in the state that determines the row. */
  count: number
  /** Lifecycle status when known; omitted values read from task activity only. */
  instanceStatus?: AssistantInstance['status']
}

const ASSISTANT_TASK_STATUS_LABELS: Record<AssistantSession['status'], string> = {
  queued: '排队中',
  running: '运行中',
  needs_input: '待你处理',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** Sidebar-facing name; the snapshot name is the only display name Phase 0 stores. */
export function assistantInstanceName(instance: AssistantInstance): string {
  const name = instance.assistantSnapshot.name.trim()
  return name === '' ? '助手' : name
}

/**
 * The coordinating assistant (总协调机器人): pinned at the top of the DeepBot
 * sidebar instead of sitting in the 单聊 list. Only the `coordinator` field
 * decides — a name or a shipped template is never evidence of the role, because
 * guessing would resurrect a ghost pinned row whenever the field is empty.
 */
export function coordinatorAssistant<T extends Pick<AssistantInstance, 'coordinator'>>(
  instances: readonly T[],
): T | undefined {
  return instances.find(isCoordinatorInstance)
}

/** Its id, for the 单聊 list that keeps the pinned row out of the list. */
export function coordinatorAssistantId(
  instances: readonly Pick<AssistantInstance, 'id' | 'coordinator'>[],
): string | undefined {
  return coordinatorAssistant(instances)?.id
}

/** Fallback glyph for an assistant without a usable avatar. */
export function assistantInitial(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase() || '?'
}

/** True for a bounded inline image URL; anything else falls back to the initial. */
export function isAssistantAvatarDataUrl(value: string): boolean {
  return value.startsWith('data:image/') && value.length <= ASSISTANT_AVATAR_MAX_DATA_URL_LENGTH
}

/** Only bounded inline image URLs are rendered as avatars. */
export function assistantAvatarSource(instance: AssistantInstance): string | undefined {
  const avatar = instance.assistantSnapshot.avatar
  return avatar !== undefined && isAssistantAvatarDataUrl(avatar) ? avatar : undefined
}

const ASSISTANT_AVATAR_FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

/** Validate one local avatar upload before reading it into a data URL. */
export function assistantAvatarFileError(file: { type: string; size: number }): string | undefined {
  if (!ASSISTANT_AVATAR_FILE_TYPES.includes(file.type)) return '请选择 PNG、JPEG 或 WebP 图片'
  if (file.size > ASSISTANT_AVATAR_MAX_FILE_BYTES) return '头像图片不能超过 256KB'
  return undefined
}

/**
 * Validate a draft/stored avatar value. An empty string is the explicit
 * “clear avatar” action, so it is valid; everything else must be a bounded
 * inline image URL.
 */
export function assistantAvatarDataUrlError(value: string): string | undefined {
  if (value === '') return undefined
  if (!value.startsWith('data:image/')) return '头像必须是内嵌图片'
  if (value.length > ASSISTANT_AVATAR_MAX_DATA_URL_LENGTH) return '头像图片过大'
  return undefined
}

/** The non-archived instance whose bound main Session matches, if any. */
export function assistantInstanceForSession(
  instances: readonly AssistantInstance[],
  sessionId: string | undefined,
): AssistantInstance | undefined {
  if (sessionId === undefined || sessionId === '') return undefined
  return instances.find(item => item.mainSessionId === sessionId && item.status !== 'archived')
}

/** Assistant name for the Session whose mainSessionId matches, if any. */
export function assistantNameForSession(
  instances: readonly AssistantInstance[],
  sessionId: string | undefined,
): string | undefined {
  const instance = assistantInstanceForSession(instances, sessionId)
  return instance === undefined ? undefined : assistantInstanceName(instance)
}

/**
 * Compact “last activity” label for assistant rows. Mirrors the team rows so
 * both sections read the same, but stays a pure function for tests.
 */
export function relativeAssistantTime(iso: string, now: number = Date.now()): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''
  const diff = Math.max(0, now - timestamp)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}天`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/**
 * Row-level task state for one Assistant, in urgency order. Only active worker
 * tasks belonging to this instance count; terminal tasks never contribute, and
 * an archived instance reads as idle even if stale active rows remain.
 */
export function assistantRowActivity(
  tasks: readonly Pick<AssistantSession, 'assistantId' | 'status'>[],
  instance: Pick<AssistantInstance, 'id' | 'status'>,
): AssistantRowActivity {
  if (instance.status === 'archived') {
    return { status: 'none', count: 0, instanceStatus: instance.status }
  }
  let needsInput = 0
  let running = 0
  let queued = 0
  for (const task of tasks) {
    if (task.assistantId !== instance.id) continue
    if (task.status === 'needs_input') needsInput += 1
    else if (task.status === 'running') running += 1
    else if (task.status === 'queued') queued += 1
  }
  const instanceStatus = instance.status
  if (needsInput > 0) return { status: 'needs_input', count: needsInput, instanceStatus }
  if (running > 0) return { status: 'running', count: running, instanceStatus }
  if (queued > 0) return { status: 'queued', count: queued, instanceStatus }
  return { status: 'none', count: 0, instanceStatus }
}

/**
 * The row's effective state. Error and startup come from the instance, so a
 * failed or waking assistant never borrows the quiet 空闲 word from an empty
 * task list — and its dot/tone can follow the same single decision.
 */
export function assistantRowState(activity: AssistantRowActivity): AssistantRowState {
  if (activity.instanceStatus === 'error') return 'error'
  if (activity.instanceStatus === 'starting') return 'starting'
  return activity.status
}

/** Compact second-line preview for an Assistant row; words come from labels.ts. */
export function assistantRowStatusText(activity: AssistantRowActivity): string {
  switch (assistantRowState(activity)) {
    case 'error': return assistantInstanceStatusLabel('error')
    case 'starting': return assistantInstanceStatusLabel('starting')
    case 'needs_input': return '待你处理'
    case 'running': return '思考中'
    case 'queued': return '排队中'
    case 'none': return assistantInstanceStatusLabel('idle')
  }
}

/** Accessible title for the Assistant status dot; the preview omits counts. */
export function assistantRowStatusTitle(activity: AssistantRowActivity): string {
  const state = assistantRowState(activity)
  if (state === 'error' || state === 'starting') {
    const head = state === 'error'
      ? assistantInstanceStatusLabel('error')
      : assistantInstanceStatusLabel('starting')
    return activity.count === 0 ? head : `${head} · ${activity.count} 个任务未结束`
  }
  if (state === 'needs_input') return `${activity.count} 个任务待你处理`
  if (state === 'running') return `${activity.count} 个任务正在思考`
  if (state === 'queued') return `${activity.count} 个任务排队中`
  return assistantInstanceStatusLabel('idle')
}

/** One pending decision: the Assistant and the task waiting on the user. */
export interface AssistantPendingDecision {
  instance: AssistantInstanceView
  task: AssistantSession
}

/**
 * Every decision waiting in the workspace, independent of the sidebar search:
 * a query narrows the ordinary row list, never the 待你处理 block or its count.
 * Archived instances and archived tasks never contribute.
 */
export function assistantPendingDecisions(
  instances: readonly AssistantInstanceView[],
  tasks: readonly AssistantSession[],
): AssistantPendingDecision[] {
  const pending: AssistantPendingDecision[] = []
  for (const instance of instances) {
    if (instance.status === 'archived' || instance.archivedAt !== undefined) continue
    for (const task of assistantThreadTasks(tasks, instance)) {
      if (task.status !== 'needs_input' || task.archivedAt !== undefined) continue
      pending.push({ instance, task })
    }
  }
  return pending
}

export interface AssistantSidebarSummary {
  /** Assistants with a task waiting for the user. */
  waiting: number
  /** Assistants thinking on a task. */
  working: number
  /** Assistants with queued work only. */
  queued: number
  unread: number
}

/**
 * Sidebar counts over every listed Assistant. There is no query parameter on
 * purpose: the summary describes the workspace, so typing in the search box can
 * never hide a pending decision from it.
 */
export function assistantSidebarSummary(
  instances: readonly AssistantInstanceView[],
  tasks: readonly AssistantSession[],
  readState: Readonly<Record<string, number>>,
): AssistantSidebarSummary {
  let waiting = 0
  let working = 0
  let queued = 0
  let unread = 0
  for (const instance of instances) {
    if (instance.status === 'archived' || instance.archivedAt !== undefined) continue
    const activity = assistantRowActivity(tasks, instance)
    if (activity.status === 'needs_input') waiting += 1
    else if (activity.status === 'running') working += 1
    else if (activity.status === 'queued') queued += 1
    if (isAssistantUnread(instance, readState)) unread += 1
  }
  return { waiting, working, queued, unread }
}

/** Human label for one worker task status. */
export function assistantTaskStatusLabel(status: AssistantSession['status']): string {
  return ASSISTANT_TASK_STATUS_LABELS[status]
}

/**
 * Tasks belonging to one Assistant, newest first. The list API does not sort,
 * so the task dialog owns this stable ordering; the id tie-break keeps equal
 * timestamps deterministic across SSE refreshes.
 */
export function assistantTasksFor(
  tasks: readonly AssistantSession[],
  assistantId: string,
): AssistantSession[] {
  return tasks
    .filter(task => task.assistantId === assistantId)
    .slice()
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      || right.id.localeCompare(left.id))
}

/**
 * Rows rendered inline under one Assistant in advanced mode. The list keeps the
 * dialog's newest-first ordering but never repeats the assistant's main Session
 * as a task, even if a stale task record points at it.
 */
export function assistantThreadTasks(
  tasks: readonly AssistantSession[],
  instance: Pick<AssistantInstance, 'id' | 'mainSessionId'>,
): AssistantSession[] {
  return assistantTasksFor(tasks, instance.id)
    .filter(task => instance.mainSessionId === undefined || task.sessionId !== instance.mainSessionId)
}

/**
 * Archived instances are never listed. Pinned rows lead, then the most recent
 * activity; the id tie-break keeps the order stable across SSE refreshes.
 */
export function visibleAssistantInstances<T extends AssistantInstance>(
  instances: readonly T[],
  query = '',
): T[] {
  const normalized = query.trim().toLocaleLowerCase()
  return instances
    .filter(instance => instance.status !== 'archived')
    .filter(instance => normalized === ''
      || assistantInstanceName(instance).toLocaleLowerCase().includes(normalized))
    .slice()
    .sort((left, right) => Number(right.pinned === true) - Number(left.pinned === true)
      || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      || left.id.localeCompare(right.id))
}
