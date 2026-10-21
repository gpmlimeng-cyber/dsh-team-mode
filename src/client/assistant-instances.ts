import type { AssistantInstance } from '../domain/types.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

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
