import { useCallback, useEffect, useState } from 'react'
import { callAgentTeam } from './api.js'

/**
 * The Host's own bound (`SIDEBAR_GROUP_MAX_CHARS`); the name input repeats it so
 * an over-long label is refused before the round trip instead of after it.
 */
export const SIDEBAR_GROUP_MAX_CHARS = 40

/** Id of the trailing partition that owns every row without a usable group. */
export const UNGROUPED_PARTITION_ID = 'ungrouped'

/** One rendered section of the sidebar: a named group, or the ungrouped rows. */
export interface SidebarPartition<T> {
  /** React key. Never the bare label, so a group named "ungrouped" cannot collide. */
  id: string
  /** Group label; absent on the ungrouped partition. */
  group?: string
  items: T[]
}

/**
 * Split rows into the sidebar's partitions.
 *
 * `groups` is the Host's ordered list and it alone decides the order and which
 * empty groups exist. With no group defined the result is one unlabelled
 * partition, so the caller renders exactly the pre-group list: no headers, no
 * empty rows, no second code path for "all ungrouped".
 *
 * A row whose label the Host no longer lists falls back to the ungrouped
 * partition instead of vanishing (the Host cascades deletes, so this only covers
 * a sidebar that read a list older than its rows).
 */
export function sidebarPartitions<T>(
  groups: readonly string[],
  items: readonly T[],
  groupOf: (item: T) => string | undefined,
): SidebarPartition<T>[] {
  const ungrouped: T[] = []
  if (groups.length === 0) {
    ungrouped.push(...items)
    return [{ id: UNGROUPED_PARTITION_ID, items: ungrouped }]
  }
  const buckets = new Map<string, T[]>()
  for (const group of groups) buckets.set(group, [])
  for (const item of items) {
    const group = groupOf(item)
    const bucket = group === undefined ? undefined : buckets.get(group)
    if (bucket === undefined) ungrouped.push(item)
    else bucket.push(item)
  }
  const partitions: SidebarPartition<T>[] = groups.map(group => ({
    id: `group:${group}`,
    group,
    items: buckets.get(group) as T[],
  }))
  // An empty ungrouped section is not a section: it would be one header with
  // nothing under it, while empty named groups must stay visible to be managed.
  return ungrouped.length === 0
    ? partitions
    : [...partitions, { id: UNGROUPED_PARTITION_ID, items: ungrouped }]
}

/** A row the membership dialog can move in or out of one group. */
export interface SidebarGroupCandidate {
  id: string
  name: string
  /** Label of the group this row currently sits in; absent when ungrouped. */
  group?: string
}

export interface SidebarGroupMembership {
  /** Rows that move into the group. */
  add: SidebarGroupCandidate[]
  /** Rows that move back to ungrouped. */
  remove: SidebarGroupCandidate[]
}

/**
 * The rows a membership dialog offers for one group: its own members first, then
 * everything still ungrouped. Rows of other groups are deliberately absent — the
 * checklist moves rows in and out of one group, it is not a bulk re-assignment.
 */
export function groupMembershipCandidates<T>(
  group: string,
  items: readonly T[],
  project: (item: T) => SidebarGroupCandidate,
): SidebarGroupCandidate[] {
  const members: SidebarGroupCandidate[] = []
  const ungrouped: SidebarGroupCandidate[] = []
  for (const item of items) {
    const candidate = project(item)
    if (candidate.group === group) members.push(candidate)
    else if (candidate.group === undefined) ungrouped.push(candidate)
  }
  return [...members, ...ungrouped]
}

/**
 * What the checklist changed. The dialog submits this difference only, so a save
 * never rewrites a row the user did not touch.
 */
export function groupMembershipChanges(
  group: string,
  candidates: readonly SidebarGroupCandidate[],
  checked: ReadonlySet<string>,
): SidebarGroupMembership {
  const add: SidebarGroupCandidate[] = []
  const remove: SidebarGroupCandidate[] = []
  for (const candidate of candidates) {
    const member = candidate.group === group
    if (checked.has(candidate.id)) {
      if (!member) add.push(candidate)
    } else if (member) remove.push(candidate)
  }
  return { add, remove }
}

/**
 * Why a typed group name cannot be saved, or undefined when it can. Mirrors the
 * Host's rules so the dialog answers without a round trip; the Host still owns
 * the final decision and its message is shown as-is when it refuses.
 */
export function sidebarGroupNameError(
  name: string,
  groups: readonly string[],
): string | undefined {
  const label = name.trim()
  if (label === '') return '分组名不能为空'
  if (label.length > SIDEBAR_GROUP_MAX_CHARS) return `分组名最多 ${SIDEBAR_GROUP_MAX_CHARS} 个字`
  if (groups.includes(label)) return '已存在同名分组'
  return undefined
}

/**
 * The list one 上移/下移 press produces: two neighbours swapped, nothing else
 * touched. An unknown group or an end of the list returns the list unchanged,
 * so a disabled menu row that somehow fires cannot reorder anything.
 */
export function movedGroupOrder(
  groups: readonly string[],
  group: string,
  delta: -1 | 1,
): string[] {
  const index = groups.indexOf(group)
  const target = index + delta
  if (index < 0 || target < 0 || target >= groups.length) return [...groups]
  const next = [...groups]
  next[index] = groups[target] as string
  next[target] = group
  return next
}

/** What is being dragged: a sidebar row, or a named group's header. */
export type SidebarDragKind = 'row' | 'group'

/** What the pointer is over. `row` exists only so an invalid target is explicit. */
export type SidebarDropOverKind = 'group' | 'ungrouped' | 'row' | 'none'

/** Which half of the element the pointer sits in, exactly like the native list. */
export type SidebarDropHalf = 'before' | 'after'

/**
 * The one action a drop can mean here. There is deliberately no
 * `reorder-row`: rows carry no order field, so ordering inside a group would be
 * a second, invented state the Host cannot store.
 */
export type SidebarDropIntent =
  | { kind: 'assign'; ungrouped: boolean }
  | { kind: 'insert'; half: SidebarDropHalf }
  | { kind: 'none' }

/**
 * Resolve one drag/over/half combination into an action.
 *
 * Two semantics only, as designed: a row dropped on any header changes its
 * group (the ungrouped header included), and a group header dropped on another
 * header inserts itself on that half. Everything else — a row on a row, a group
 * on the ungrouped header (which is not a group in the list) — is `none`, and
 * the caller then reports `dropEffect = 'none'` instead of pretending.
 */
export function resolveDropTarget(
  dragKind: SidebarDragKind | undefined,
  overKind: SidebarDropOverKind,
  half: SidebarDropHalf,
): SidebarDropIntent {
  if (dragKind === undefined || overKind === 'none' || overKind === 'row') return { kind: 'none' }
  if (dragKind === 'row') {
    if (overKind === 'ungrouped') return { kind: 'assign', ungrouped: true }
    return { kind: 'assign', ungrouped: false }
  }
  // A group header can only be dropped on another group header.
  return overKind === 'group' ? { kind: 'insert', half } : { kind: 'none' }
}

/**
 * The list after inserting `moving` beside `target`. Mirrors the native insert
 * line: the moving group leaves its old slot first, then takes the target's
 * `before`/`after` position. A no-op (same slot, unknown label) returns the same
 * order so the caller can skip a pointless write.
 */
export function insertGroupOrder(
  groups: readonly string[],
  moving: string,
  target: string,
  half: SidebarDropHalf,
): string[] {
  if (moving === target || !groups.includes(moving) || !groups.includes(target)) return [...groups]
  const rest = groups.filter(group => group !== moving)
  rest.splice(rest.indexOf(target) + (half === 'after' ? 1 : 0), 0, moving)
  return rest
}

export interface SidebarGroups {
  /** Ordered labels, exactly as the Host returned them. */
  groups: string[]
  /** Re-read the list; for a mount or a resync. */
  refresh: () => Promise<void>
  /** Adopt a write's returned list — the Host's order, never a local guess. */
  adopt: (groups: string[]) => void
}

/**
 * The sidebar's own group list. A Host without the group transport answers
 * nothing here, and the two plugin sections then render exactly as before.
 */
export function useSidebarGroups(): SidebarGroups {
  const [groups, setGroups] = useState<string[]>([])
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setGroups(await callAgentTeam('sidebar.groups.list'))
    } catch {
      // No group list is a valid sidebar: it is what every install had before
      // groups existed, so an old Host degrades to that instead of an error.
    }
  }, [])
  const adopt = useCallback((next: string[]): void => { setGroups(next) }, [])
  useEffect(() => { void refresh() }, [refresh])
  return { groups, refresh, adopt }
}
