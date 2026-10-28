import { useCallback, useEffect, useState } from 'react'
import type { GroupImportPreview } from '../domain/group-share.js'
import { callAgentTeam } from './api.js'

/**
 * The Host's own bound (`SIDEBAR_GROUP_MAX_CHARS`); the name input repeats it so
 * an over-long label is refused before the round trip instead of after it.
 */
export const SIDEBAR_GROUP_MAX_CHARS = 40

/**
 * The Host's brief cap (`SIDEBAR_GROUP_BRIEF_MAX_CHARS` in the domain schemas),
 * repeated so the editor can count against it without shipping zod to the
 * client. The Host still refuses over-long text; the counter only warns first.
 * `tests/client-sidebar-groups.spec.ts` pins the two numbers together.
 */
export const SIDEBAR_GROUP_BRIEF_MAX_CHARS = 24_576

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
 * One pickable row of the create-group dialog. `group` is the group the row
 * sits in today, not a target: a row already in another group stays listed and
 * the dialog moves it.
 */
export interface GroupCreateRow extends SidebarGroupCandidate {
  /** Which checklist the row belongs to; the two kinds are written differently. */
  kind: 'team' | 'assistant'
  /** Bounded inline avatar; absent rows fall back to the initial. */
  avatar?: string
}

export interface GroupCreateRows {
  teams: GroupCreateRow[]
  assistants: GroupCreateRow[]
}

/**
 * Everything a new group can receive: every team and every assistant, grouped
 * or not. Nothing is filtered out — the picker is a move, and a row that
 * already belongs somewhere keeps that label as its subtitle.
 */
export function groupCreateRows<T, A>(
  teams: readonly T[],
  assistants: readonly A[],
  projectTeam: (item: T) => Omit<GroupCreateRow, 'kind'>,
  projectAssistant: (item: A) => Omit<GroupCreateRow, 'kind'>,
): GroupCreateRows {
  return {
    teams: teams.map(item => ({ ...projectTeam(item), kind: 'team' })),
    assistants: assistants.map(item => ({ ...projectAssistant(item), kind: 'assistant' })),
  }
}

/** One row flips; a fresh Set keeps the dialog's state a value, not a mutation. */
export function toggleGroupCreateSelection(
  selected: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/**
 * The rows a create moves in, teams first. An empty selection is a complete
 * answer: the group is created empty and can be filled later from its header.
 */
export function groupCreateSelection(
  rows: GroupCreateRows,
  selected: ReadonlySet<string>,
): { teamIds: string[]; assistantIds: string[] } {
  return {
    teamIds: rows.teams.filter(row => selected.has(row.id)).map(row => row.id),
    assistantIds: rows.assistants.filter(row => selected.has(row.id)).map(row => row.id),
  }
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

/** The editor's counter: characters used against the Host's cap. */
export function sidebarGroupBriefUsage(brief: string): string {
  return `${brief.length} / ${SIDEBAR_GROUP_BRIEF_MAX_CHARS}`
}

/**
 * Why a typed brief cannot be saved, or undefined when it can. Mirrors the
 * Host's rule: too-long text is refused, never silently truncated, so the
 * counter turns red and the save button stays disabled before the round trip.
 */
export function sidebarGroupBriefError(brief: string): string | undefined {
  if (brief.length <= SIDEBAR_GROUP_BRIEF_MAX_CHARS) return undefined
  return `简报最多 ${SIDEBAR_GROUP_BRIEF_MAX_CHARS} 个字符，请删减 ${brief.length - SIDEBAR_GROUP_BRIEF_MAX_CHARS} 个字符`
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

/** One model reference; the thinking list is the union across these. */
export interface GroupBatchModelRef {
  provider: string
  model: string
}

/**
 * Stable key for one model reference. The NUL separator cannot occur in a
 * provider or model id, so two references can never collide into one key.
 */
export function groupBatchModelKey(ref: GroupBatchModelRef): string {
  return `${ref.provider}\u0000${ref.model}`
}

/** One assistant a group batch write targets, as the result list shows it. */
export interface GroupBatchMember {
  id: string
  name: string
  /**
   * The model this assistant uses today. A thinking level is not a property of
   * the batch: it is validated per assistant against this model, so the dialog
   * needs the references to offer the union and the Host rejects the rows that
   * cannot serve the picked level.
   */
  model: GroupBatchModelRef
}

/** What one batch write did to one assistant; no `error` means it landed. */
export interface GroupBatchResult {
  id: string
  name: string
  error?: string
  /**
   * A retry left this row alone because an earlier apply already landed it.
   * That round changed nothing here, so the row must not read as a second 已更新.
   */
  unchanged?: true
}

/**
 * The rows one batch write may touch: only assistants carrying this group's
 * label, archived rows excluded exactly like the sidebar excludes them.
 *
 * There is deliberately no query input. The sidebar's sections are built from a
 * search-filtered list, so reading membership from a rendered section would let
 * a typed query silently shrink the batch; the dialog reads the full list.
 */
export function groupBatchMembers<T>(
  group: string,
  items: readonly T[],
  project: (item: T) => {
    id: string
    name: string
    group?: string
    status: string
    provider: string
    model: string
  },
): GroupBatchMember[] {
  const members: GroupBatchMember[] = []
  for (const item of items) {
    const row = project(item)
    if (row.group !== group || row.status === 'archived') continue
    members.push({
      id: row.id,
      name: row.name,
      model: { provider: row.provider, model: row.model },
    })
  }
  return members
}

/**
 * The distinct models a batch reads thinking levels from, in list order: the
 * models the group's assistants already use, plus a model the user just picked
 * (so a model change and its levels can travel in one apply). Duplicates are
 * dropped, because one read per model is enough.
 */
export function groupBatchModelRefs(
  members: readonly GroupBatchMember[],
  extra?: GroupBatchModelRef,
): GroupBatchModelRef[] {
  const refs: GroupBatchModelRef[] = []
  const seen = new Set<string>()
  const add = (ref: GroupBatchModelRef): void => {
    const key = groupBatchModelKey(ref)
    if (seen.has(key)) return
    seen.add(key)
    refs.push(ref)
  }
  for (const member of members) add(member.model)
  if (extra !== undefined) add(extra)
  return refs
}

/** One thinking level a batch can send. */
export interface GroupBatchLevel {
  id: string
  name: string
}

/**
 * The thinking levels one batch offers: the union across the models the group's
 * assistants use, in first-seen order with the first name for each id. A level
 * is a plain id the Host validates per assistant, so a row whose own model does
 * not serve it is refused on that row instead of blocking the whole batch.
 */
export function groupBatchLevels(
  capabilities: readonly (readonly GroupBatchLevel[])[],
): GroupBatchLevel[] {
  const levels: GroupBatchLevel[] = []
  const seen = new Set<string>()
  for (const efforts of capabilities) {
    for (const effort of efforts) {
      if (seen.has(effort.id)) continue
      seen.add(effort.id)
      levels.push({ id: effort.id, name: effort.name })
    }
  }
  return levels
}

/**
 * True when a model change must narrow the thinking pick to 模型默认: a concrete
 * level is chosen and the newly picked model, whose capabilities are known, does
 * not serve it. Every row carries the same model+level pair, so leaving an
 * unsupported level in place would get the whole batch refused together.
 *
 * A failed capability read (`undefined` efforts) never narrows: a read error
 * cannot tell anything about the model and must not throw a valid pick away.
 */
export function groupBatchLevelNeedsDefault(
  levelId: string | undefined,
  modelEfforts: readonly GroupBatchLevel[] | undefined,
): boolean {
  if (levelId === undefined || levelId === '') return false
  if (modelEfforts === undefined) return false
  return !modelEfforts.some(level => level.id === levelId)
}

/** The engine fields one apply writes; an absent field keeps its stored value. */
export interface GroupBatchPatch {
  provider?: string
  model?: string
  reasoningEffort?: string
  permissionPresetId?: string
}

/** What the three pickers chose; an untouched picker stays absent. */
export interface GroupBatchDraft {
  /** A picked model; the pair is one field because the Host refuses a lone half. */
  model?: { provider: string; model: string }
  /** A picked thinking level; `''` means the model's own default. */
  reasoningEffort?: string
  /** A picked permission preset. */
  permissionPresetId?: string
}

/**
 * The patch one apply sends, or undefined when nothing was picked. The model
 * pair travels together and a chosen level travels with it, so one assistant is
 * always one atomic write instead of two that could half-land.
 */
export function groupBatchPatch(draft: GroupBatchDraft): GroupBatchPatch | undefined {
  const patch: GroupBatchPatch = {}
  if (draft.model !== undefined) {
    patch.provider = draft.model.provider
    patch.model = draft.model.model
  }
  if (draft.reasoningEffort !== undefined) patch.reasoningEffort = draft.reasoningEffort
  if (draft.permissionPresetId !== undefined) patch.permissionPresetId = draft.permissionPresetId
  return Object.keys(patch).length === 0 ? undefined : patch
}

/**
 * Write one patch to every member, one assistant at a time, and report each
 * outcome in member order. A refusal is recorded and the loop continues: the
 * batch has no rollback, so an already-updated assistant stays updated while a
 * refused one keeps its own values and shows the Host's reason. A batch therefore
 * only needs the ids and names, not the model references it was read from.
 */
export async function applyGroupBatch(
  members: readonly { id: string; name: string }[],
  patch: GroupBatchPatch,
  write: (id: string, patch: GroupBatchPatch) => Promise<unknown>,
): Promise<GroupBatchResult[]> {
  const results: GroupBatchResult[] = []
  for (const member of members) {
    try {
      await write(member.id, patch)
      results.push({ id: member.id, name: member.name })
    } catch (cause) {
      results.push({
        id: member.id,
        name: member.name,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  return results
}

/**
 * The members one apply still has to write: everyone without a landed result.
 * A retry therefore reruns only the rows that were refused, and cannot
 * double-count a row an earlier apply already changed.
 */
export function groupBatchPendingMembers<T extends { id: string }>(
  members: readonly T[],
  results: readonly GroupBatchResult[] | undefined,
): T[] {
  if (results === undefined) return [...members]
  const landed = new Set<string>()
  for (const result of results) {
    if (result.error === undefined) landed.add(result.id)
  }
  return members.filter(member => !landed.has(member.id))
}

/**
 * The result rows after one apply or retry. Written rows carry the new outcome
 * (updated or refused); every row the round left alone reads 未变化 instead of
 * repeating a stale 已更新.
 */
export function groupBatchRoundResults(
  members: readonly { id: string; name: string }[],
  written: readonly GroupBatchResult[],
): GroupBatchResult[] {
  const byId = new Map(written.map(result => [result.id, result]))
  return members.map(member => byId.get(member.id)
    ?? { id: member.id, name: member.name, unchanged: true })
}

/**
 * The Host's portable-document cap (`GROUP_SHARE_MAX_DOCUMENT_BYTES` in
 * `domain/group-share.ts`), repeated so a chosen file is refused before it is
 * read into memory. The Host still enforces the same number on both import
 * methods; `tests/client-sidebar-groups.spec.ts` pins the two together.
 */
export const GROUP_SHARE_MAX_DOCUMENT_BYTES = 1024 * 1024

/** One parsed group export, held by the import dialog from preview to apply. */
export type GroupExportParse =
  | { ok: true; document: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Parse pasted or read portable JSON. Only the shape the transport carries is
 * checked here (one JSON object, byte-for-byte untouched); the Host owns the
 * document schema and answers a malformed one with its own field path, so the
 * dialog never re-serialises what it was given.
 */
export function parseGroupExportText(text: string): GroupExportParse {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: '请粘贴分组导出的 JSON，或选择一个文件' }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, error: `这不是合法的 JSON：${reason}` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '分组导出应该是一个 JSON 对象' }
  }
  return { ok: true, document: value as Record<string, unknown> }
}

/** The download name for one export: unsafe filename characters become '-'. */
export function groupExportFileName(group: string): string {
  const base = group.trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .slice(0, 60)
    .replace(/[. ]+$/, '')
  return `${base === '' ? 'group' : base}.group.json`
}

/** One reviewable row of an import plan; presentation-neutral on purpose. */
export interface GroupImportPlanLine {
  /**
   * Stable unique row key. Document names may repeat (two teams can share a
   * name), so a name-derived React key would collide; the plan order is fixed
   * for one preview, so kind plus position is both stable and unique.
   */
  key: string
  kind: 'group' | 'assistant' | 'template' | 'team'
  /** The name as written in the document. */
  name: string
  /** The name this machine will use (a conflict earns a ` (2)` suffix). */
  plannedName: string
  action: 'create' | 'reuse' | 'skip'
  /** Why the row is skipped, or why the planned name differs. */
  note?: string
  /** A short fact about the row: member count, reused library entry. */
  detail?: string
}

/**
 * Flatten one preview into the rows the dialog lists: the group first, then its
 * assistants, the Assistant templates the teams need, and the teams. Nothing is
 * filtered — a skipped row keeps its reason so the user sees what will not come
 * across instead of finding it missing after the import.
 */
export function groupImportPlanLines(preview: GroupImportPreview): GroupImportPlanLine[] {
  const lines: GroupImportPlanLine[] = []
  const push = (line: Omit<GroupImportPlanLine, 'key'>): void => {
    lines.push({ ...line, key: `${lines.length}:${line.kind}` })
  }
  push({
    kind: 'group',
    name: preview.group.requested,
    plannedName: preview.group.plannedName,
    action: 'create',
    ...(preview.group.renamed
      ? { note: `同名分组已存在，导入为「${preview.group.plannedName}」` }
      : {}),
    ...(preview.group.briefChars === 0 ? {} : { detail: `简报 ${preview.group.briefChars} 字` }),
  })
  for (const row of preview.assistants) {
    push({
      kind: 'assistant',
      name: row.name,
      plannedName: row.plannedName,
      action: row.action,
      ...(row.reason === undefined ? {} : { note: row.reason }),
    })
  }
  for (const row of preview.templates) {
    push({
      kind: 'template',
      name: row.name,
      plannedName: row.plannedName,
      action: row.action,
      ...(row.action === 'reuse' ? { note: '复用本地相同的助手模板' } : {}),
    })
  }
  for (const team of preview.teams) {
    push({
      kind: 'team',
      name: team.name,
      plannedName: team.plannedName,
      action: team.action,
      ...(team.reason === undefined ? {} : { note: team.reason }),
      ...(team.action === 'create' ? { detail: `${team.members.length} 名成员` } : {}),
    })
  }
  return lines
}

/**
 * Revoke one download object URL after the click that used it has returned.
 * Revoking in the same task can cancel the download before the browser starts
 * reading the blob, so the URL outlives the click by one short beat.
 */
export function revokeDownloadUrlLater(url: string, delayMs = 1000): void {
  setTimeout(() => { URL.revokeObjectURL(url) }, delayMs)
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
