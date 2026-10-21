import type { AssistantInstance, AssistantSession } from '../domain/types.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

export type AssistantRowStatus = 'needs_input' | 'running' | 'queued' | 'none'

export interface AssistantRowActivity {
  status: AssistantRowStatus
  /** Number of tasks in the state that determines the row. */
  count: number
}

const ASSISTANT_TASK_STATUS_LABELS: Record<AssistantSession['status'], string> = {
  queued: '排队中',
  running: '运行中',
  needs_input: '待确认',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** Sidebar-facing name; the snapshot name is the only display name Phase 0 stores. */
export function assistantInstanceName(instance: AssistantInstance): string {
  const name = instance.assistantSnapshot.name.trim()
  return name === '' ? '助手' : name
}

/** Fallback glyph for an assistant without a usable avatar. */
export function assistantInitial(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase() || '?'
}

/** Only bounded data URLs are rendered as images; other strings fall back to the initial. */
export function assistantAvatarSource(instance: AssistantInstance): string | undefined {
  const avatar = instance.assistantSnapshot.avatar
  return avatar !== undefined && avatar.startsWith('data:') ? avatar : undefined
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
  if (instance.status === 'archived') return { status: 'none', count: 0 }
  let needsInput = 0
  let running = 0
  let queued = 0
  for (const task of tasks) {
    if (task.assistantId !== instance.id) continue
    if (task.status === 'needs_input') needsInput += 1
    else if (task.status === 'running') running += 1
    else if (task.status === 'queued') queued += 1
  }
  if (needsInput > 0) return { status: 'needs_input', count: needsInput }
  if (running > 0) return { status: 'running', count: running }
  if (queued > 0) return { status: 'queued', count: queued }
  return { status: 'none', count: 0 }
}

/** Compact second-line preview for an Assistant row. */
export function assistantRowStatusText(activity: AssistantRowActivity): string {
  if (activity.status === 'needs_input') return '待确认'
  if (activity.status === 'running') return `${activity.count} 个任务运行中`
  if (activity.status === 'queued') return `${activity.count} 个任务排队中`
  return '空闲'
}

/** Accessible title for the Assistant status dot; the preview omits counts. */
export function assistantRowStatusTitle(activity: AssistantRowActivity): string {
  if (activity.status === 'needs_input') return `${activity.count} 个任务待确认`
  return assistantRowStatusText(activity)
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
 * Archived instances are never listed. Pinned rows lead, then the most recent
 * activity; the id tie-break keeps the order stable across SSE refreshes.
 */
export function visibleAssistantInstances(
  instances: readonly AssistantInstance[],
  query = '',
): AssistantInstance[] {
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
