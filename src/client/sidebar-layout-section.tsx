import { useEffect, useState } from 'react'
import css from './AgentTeam.module.css'
import {
  EMPTY_LAYOUT,
  SLOT_LABELS,
  SLOT_ORDER,
  deriveKey,
  isToolLabel,
  parseLayoutConfig,
  serializeLayoutConfig,
  type EntryKey,
  type LayoutConfig,
  type LayoutEntry,
  type LayoutTarget,
  type SlotId,
} from './sidebar-layout-data.js'

/** The only place the layout is persisted (spec: version 1, one key). */
export const SIDEBAR_LAYOUT_STORAGE_KEY = 'dsh-team-mode:sidebar-layout'
/** Emitted after every write so the sidebar side effect re-applies the layout. */
export const SIDEBAR_LAYOUT_CHANGED_EVENT = 'dsh-team-mode:sidebar-layout-changed'

/** `origin` is the unset state: the entry stays where DSH renders it. */
export type EntryChoice = 'origin' | LayoutTarget

export interface LayoutOption {
  value: EntryChoice
  label: string
}

/** A tool button has nowhere to go, so its only option is staying put. */
export function entryOptions(entry: LayoutEntry): LayoutOption[] {
  if (!entry.movable) return [{ value: 'origin', label: `原位置（${SLOT_LABELS[entry.originSlot]}）` }]
  return [
    { value: 'origin', label: `原位置（${SLOT_LABELS[entry.originSlot]}）` },
    ...SLOT_ORDER.map(slot => ({ value: slot, label: SLOT_LABELS[slot] })),
    { value: 'hidden', label: '隐藏' },
  ]
}

/** Returns a new config: `origin` means "no assignment", never a stored value. */
export function withAssignment(
  config: LayoutConfig,
  key: EntryKey,
  value: EntryChoice,
): LayoutConfig {
  const assignment: Record<EntryKey, LayoutTarget> = { ...config.assignment }
  if (value === 'origin') delete assignment[key]
  else assignment[key] = value
  return { version: 1, assignment }
}

/** Restricted WebView or no storage at all: the layout just stays native. */
export function readStoredLayout(): LayoutConfig {
  try {
    return parseLayoutConfig(localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY))
  } catch {
    return EMPTY_LAYOUT
  }
}

function writeStoredLayout(config: LayoutConfig): void {
  try {
    localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, serializeLayoutConfig(config))
  } catch {
    return
  }
  window.dispatchEvent(new CustomEvent(SIDEBAR_LAYOUT_CHANGED_EVENT))
}

/** Native containers that hold navigable entries, mapped to their origin slot. */
const ORIGIN_CONTAINERS: ReadonlyArray<{ selector: string, slot: SlotId }> = [
  { selector: '[class*="_topStrip"]', slot: 'top' },
  { selector: '[class*="_logoRow"]', slot: 'top' },
  { selector: '[class*="_panelList"]', slot: 'panels' },
  { selector: '[class*="_footerActions"]', slot: 'footer' },
]

const CANDIDATE_SELECTOR = 'button, [role="button"], a[tabindex]'

/**
 * Read-only scan for the settings list. It never hides or moves anything; a
 * missing sidebar simply yields no rows. Task 4 can swap in the DOM layer's
 * `readSidebarEntries` once that module lands — the signature is identical.
 */
export function readSidebarEntries(doc: Document = document): LayoutEntry[] {
  const entries: LayoutEntry[] = []
  const seen = new Set<EntryKey>()
  for (const { selector, slot } of ORIGIN_CONTAINERS) {
    const container = doc.querySelector(selector)
    if (container === null) continue
    let order = 0
    for (const node of container.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)) {
      const label = (node.getAttribute('aria-label')?.trim()
        || node.title.trim()
        || node.textContent?.trim()
        || '')
      if (label === '') continue
      const key = deriveKey(slot, label)
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({ key, label, originSlot: slot, order, movable: !isToolLabel(label) })
      order += 1
    }
  }
  return entries
}

function selectedChoice(entry: LayoutEntry, config: LayoutConfig): EntryChoice {
  if (!entry.movable) return 'origin'
  return config.assignment[entry.key] ?? 'origin'
}

export function SidebarLayoutSection(): JSX.Element {
  const [entries, setEntries] = useState<LayoutEntry[]>([])
  const [config, setConfig] = useState<LayoutConfig>(EMPTY_LAYOUT)

  useEffect(() => {
    setConfig(readStoredLayout())
    setEntries(readSidebarEntries())
  }, [])

  const assign = (key: EntryKey, value: EntryChoice): void => {
    const next = withAssignment(config, key, value)
    setConfig(next)
    writeStoredLayout(next)
  }

  const reset = (): void => {
    setConfig(EMPTY_LAYOUT)
    writeStoredLayout(EMPTY_LAYOUT)
  }

  return (
    <section className={css.settingsSection} aria-label="侧栏布局">
      <div className={css.settingsHeading}>
        <div>
          <h2 className={css.settingsTitle}>侧栏布局</h2>
          <p className={css.settingsDescription}>
            把侧栏的导航条目放到顶部工具栏、上菜单、下菜单或底部工具栏；改动即时生效，原位置只隐藏不搬动。
          </p>
        </div>
        <button
          type="button"
          className={css.secondaryButton}
          onClick={reset}
          disabled={Object.keys(config.assignment).length === 0}
        >
          恢复默认
        </button>
      </div>
      {entries.length === 0
        ? <p className={css.hint}>当前侧栏没有可分配的条目</p>
        : (
          <div className={css.field}>
            {entries.map(entry => (
              <div key={entry.key} className={css.field}>
                <div className={css.row}>
                  <span className={css.label}>{entry.label}</span>
                  <select
                    className={css.input}
                    style={{ width: 'auto', minWidth: 132 }}
                    aria-label={`${entry.label} 的位置`}
                    value={selectedChoice(entry, config)}
                    disabled={!entry.movable}
                    onChange={event => { assign(entry.key, event.target.value as EntryChoice) }}
                  >
                    {entryOptions(entry).map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                {!entry.movable && <p className={css.hint}>工具按钮，不参与布局</p>}
              </div>
            ))}
          </div>
          )}
    </section>
  )
}
