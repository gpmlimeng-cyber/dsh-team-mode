/**
 * Sidebar layout planning: entries, keys, config serialization and the layout
 * plan itself. Pure data only — no DOM, so the whole planning surface is
 * unit-testable without jsdom.
 */

export type SlotId = 'top' | 'panels' | 'submenu' | 'footer'

/** `${originSlot}:${slugLabel(label)}` — stable across reloads, not across label edits. */
export type EntryKey = string

export type LayoutTarget = SlotId | 'hidden'

export const SLOT_ORDER: readonly SlotId[] = ['top', 'panels', 'submenu', 'footer']

export const SLOT_LABELS: Readonly<Record<SlotId, string>> = {
  top: '顶部工具栏',
  panels: '上菜单',
  submenu: '下菜单',
  footer: '底部工具栏',
}

export interface LayoutEntry {
  key: EntryKey
  /** Accessible name: aria-label ?? title ?? textContent. */
  label: string
  originSlot: SlotId
  /** Position inside the native container; keeps relative order after moving. */
  order: number
  /** Tool buttons and the account row stay where they are. */
  movable: boolean
}

export interface LayoutConfig {
  version: 1
  assignment: Record<EntryKey, LayoutTarget>
}

/** No configuration = today's layout: not one native node is touched. */
export const EMPTY_LAYOUT: LayoutConfig = Object.freeze({
  version: 1,
  assignment: Object.freeze({}) as Record<EntryKey, LayoutTarget>,
})

export interface LayoutMirror {
  key: EntryKey
  slot: SlotId
  /** Position inside the target slot host, ascending. */
  order: number
  label: string
}

export interface LayoutPlan {
  /** Native nodes to hide once their mirror rendered (or they are hidden outright). */
  hide: EntryKey[]
  mirrors: LayoutMirror[]
  /** The submenu layer collapses to zero height when it holds nothing. */
  submenuVisible: boolean
}

/** Tool buttons never become layout entries: they are not navigation. */
const TOOL_WORDS = [
  '搜索', '筛选', '排序', '新建', '折叠', '展开', '切换', '视图',
  'search', 'filter', 'sort', 'new', 'collapse', 'expand', 'view',
]

const SLOT_IDS: readonly string[] = SLOT_ORDER

function isSlotId(value: string): value is SlotId {
  return SLOT_IDS.includes(value)
}

export function slugLabel(label: string): string {
  return label.trim().toLowerCase()
}

export function deriveKey(originSlot: SlotId, label: string): EntryKey {
  return `${originSlot}:${slugLabel(label)}`
}

export function isToolLabel(label: string): boolean {
  const normalized = slugLabel(label)
  return TOOL_WORDS.some(word => normalized.includes(word))
}

/**
 * Anything unreadable falls back to the empty config (= current layout). A
 * config written by a newer/foreign version must never hide a native node.
 */
export function parseLayoutConfig(raw: string | null): LayoutConfig {
  if (raw === null) return EMPTY_LAYOUT
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_LAYOUT
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_LAYOUT
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) return EMPTY_LAYOUT
  const rawAssignment = record.assignment
  if (typeof rawAssignment !== 'object' || rawAssignment === null || Array.isArray(rawAssignment)) {
    return EMPTY_LAYOUT
  }
  const assignment: Record<EntryKey, LayoutTarget> = {}
  for (const [key, value] of Object.entries(rawAssignment)) {
    if (key === '' || typeof value !== 'string') continue
    if (value !== 'hidden' && !isSlotId(value)) continue
    assignment[key] = value
  }
  return { version: 1, assignment }
}

/** Stable key order so the stored string only changes when the layout does. */
export function serializeLayoutConfig(config: LayoutConfig): string {
  const assignment: Record<EntryKey, LayoutTarget> = {}
  for (const key of Object.keys(config.assignment).sort()) {
    const value = config.assignment[key]
    if (value !== undefined) assignment[key] = value
  }
  return JSON.stringify({ version: 1, assignment })
}

/** A non-movable entry ignores the config: it always stays at its origin. */
export function resolveSlot(entry: LayoutEntry, config: LayoutConfig): LayoutTarget {
  if (!entry.movable) return entry.originSlot
  return config.assignment[entry.key] ?? entry.originSlot
}

export function planLayout(entries: LayoutEntry[], config: LayoutConfig): LayoutPlan {
  const hide: EntryKey[] = []
  const moved: { entry: LayoutEntry; slot: SlotId }[] = []
  for (const entry of entries) {
    const target = resolveSlot(entry, config)
    if (target === entry.originSlot) continue
    hide.push(entry.key)
    if (target !== 'hidden') moved.push({ entry, slot: target })
  }
  const mirrors: LayoutMirror[] = []
  for (const slot of SLOT_ORDER) {
    const inSlot = moved.filter(m => m.slot === slot).sort((left, right) => left.entry.order - right.entry.order)
    inSlot.forEach((m, order) => {
      mirrors.push({ key: m.entry.key, slot, order, label: m.entry.label })
    })
  }
  return {
    hide,
    mirrors,
    submenuVisible: mirrors.some(mirror => mirror.slot === 'submenu'),
  }
}

/**
 * The fail-open guard: a moved entry keeps its native node visible until its
 * mirror actually rendered. Entries assigned to 'hidden' have no mirror by
 * design and are hidden regardless.
 */
export function hidesAfterRender(plan: LayoutPlan, rendered: ReadonlySet<EntryKey>): EntryKey[] {
  const mirrored = new Set(plan.mirrors.map(mirror => mirror.key))
  return plan.hide.filter(key => !mirrored.has(key) || rendered.has(key))
}
