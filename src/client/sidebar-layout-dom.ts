/**
 * Sidebar layout DOM glue: slot hosts, entry discovery, mirror rendering and
 * hiding of the native rows.
 *
 * Native nodes are never moved. They stay where React put them and are only
 * hidden with `visibility: hidden` + `aria-hidden`; a mirror button inside the
 * plugin's own slot host forwards the click to the native node. Worst case a
 * mirror shows stale state — the native control is still there.
 *
 * Fail open: a native node is hidden only after its mirror is in the DOM, and a
 * round that throws leaves every native node visible (see `applyLayout`).
 *
 * The DOM shape is DSH's own (class names matched by substring, same convention
 * as `sidebar.tsx`):
 *
 *   div._root
 *     div._topStrip        (darwin desktop: platform toggle)
 *     div._logoRow         (brand / new session)
 *     div[data-dsh-sidebar-scroll]   (inserted by sidebar.tsx)
 *       button._newSession
 *       nav._panelList     (plugin panels: plugins, schedules, …)
 *       div._regionArea    (workspaces — never an entry)
 *     div[data-dsh-sidebar-submenu]  (this module: 下菜单 layer)
 *     div._footArea
 *       div._footerActions  (sidebar.footer.action registrants)
 *       div._settingsArea   (account row — never movable)
 */
import css from './AgentTeam.module.css'
import {
  SLOT_ORDER,
  deriveKey,
  hidesAfterRender,
  isToolLabel,
  type EntryKey,
  type LayoutEntry,
  type LayoutMirror,
  type LayoutPlan,
  type SlotId,
} from './sidebar-layout-data.js'

const HOST_ATTR = 'data-dsh-sidebar-mirror'
const SUBMENU_ATTR = 'data-dsh-sidebar-submenu'
const KEY_ATTR = 'data-dsh-layout-key'
const BADGE_ATTR = 'data-dsh-layout-badge'
/** Marks a native node this plugin hid, so restoring needs no bookkeeping. */
const HIDDEN_ATTR = 'data-dsh-sidebar-layout-hidden'

const TOP_SELECTOR = '[class*="_topStrip"]'
const LOGO_SELECTOR = '[class*="_logoRow"]'
const PANEL_SELECTOR = '[class*="_panelList"]'
const FOOTER_SELECTOR = '[class*="_footerActions"]'
const SETTINGS_SELECTOR = '[class*="_settingsArea"]'
const FOOT_SELECTOR = '[class*="_footArea"]'
const REGION_SELECTOR = '[class*="_regionArea"]'

const CONTAINER_SELECTOR = [
  TOP_SELECTOR,
  LOGO_SELECTOR,
  PANEL_SELECTOR,
  FOOTER_SELECTOR,
  SETTINGS_SELECTOR,
].join(', ')

/** Clickable, navigation-shaped nodes only; icon-only controls without a name are skipped. */
const CANDIDATE_SELECTOR = 'button, [role="button"], a[tabindex]'

const BADGE_SELECTOR = '[class*="badge"], [class*="count"]'

export interface SlotHosts {
  /** Mirror container right after `_topStrip`. */
  top?: HTMLElement
  /** Mirror container appended to `_panelList`. */
  panels?: HTMLElement
  /** The 下菜单 layer itself, inserted between the workspace region and the foot. */
  submenu?: HTMLElement
  /** Mirror container appended to `_footerActions`. */
  footer?: HTMLElement
  /**
   * Native node per entry key. Filled by `discoverEntries` so that
   * `applyLayout` and `syncMirrorState` need no extra argument.
   */
  nodes: Map<EntryKey, HTMLElement>
}

export interface DiscoveredEntries {
  entries: LayoutEntry[]
  nodes: Map<EntryKey, HTMLElement>
}

/** Sidebar column root: the parent of the fixed foot area (see `sidebar.tsx`). */
export function readSidebarRoot(doc: Document): HTMLElement | undefined {
  const foot = doc.querySelector<HTMLElement>(FOOT_SELECTOR)
  const topStrip = doc.querySelector<HTMLElement>(TOP_SELECTOR)
  return foot?.parentElement ?? topStrip?.parentElement ?? undefined
}

/**
 * Locate and create the four mirror hosts. A slot whose native container is
 * missing is simply left out — its entries then stay at their origin, which is
 * the fail-open behaviour the spec asks for.
 */
export function ensureSlotHosts(root: HTMLElement): SlotHosts {
  const hosts: SlotHosts = { nodes: new Map() }
  const doc = root.ownerDocument
  const hostClass = css.sidebarLayoutHost ?? ''

  const ownHost = (slot: SlotId): HTMLElement => {
    const existing = root.querySelector<HTMLElement>(`[${HOST_ATTR}="${slot}"]`)
    if (existing !== null) return existing
    const host = doc.createElement('div')
    host.setAttribute(HOST_ATTR, slot)
    if (hostClass !== '') host.className = hostClass
    host.hidden = true
    return host
  }

  // A React re-render can append native rows after our host; re-anchoring every
  // round keeps the mirrors at the end of their container instead of in the middle.
  const place = (slot: SlotId, container: Element | null | undefined, at: 'after' | 'end'): void => {
    if (container === null || container === undefined) return
    const host = ownHost(slot)
    if (at === 'end') {
      if (container.lastElementChild !== host) container.append(host)
    } else if (container.nextElementSibling !== host) {
      container.after(host)
    }
    hosts[slot] = host
  }

  place('top', root.querySelector(`:scope > ${TOP_SELECTOR}`), 'after')
  place('panels', root.querySelector(PANEL_SELECTOR), 'end')
  place('footer', root.querySelector(FOOTER_SELECTOR) ?? root.querySelector(FOOT_SELECTOR), 'end')

  const foot = root.querySelector<HTMLElement>(`:scope > ${FOOT_SELECTOR}`)
  const submenu = ownHost('submenu')
  submenu.setAttribute(SUBMENU_ATTR, '')
  if (foot !== null) {
    if (submenu.nextElementSibling !== foot) root.insertBefore(submenu, foot)
  } else if (submenu.parentElement !== root) {
    root.append(submenu)
  }
  hosts.submenu = submenu

  return hosts
}

/** Last non-empty scan, shared with the settings list (see `readSidebarEntries`). */
let lastEntries: LayoutEntry[] = []

/**
 * Collect navigation entries from the native containers. Only those containers
 * are scanned: the workspace region, the foot's account row and this module's
 * own hosts are never sources.
 */
export function discoverEntries(hosts: SlotHosts, doc: Document): DiscoveredEntries {
  const entries: LayoutEntry[] = []
  const nodes = new Map<EntryKey, HTMLElement>()
  const nextOrder = new Map<SlotId, number>()

  for (const element of Array.from(doc.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR))) {
    if (element.closest(`[${HOST_ATTR}]`) !== null) continue
    if (element.closest(REGION_SELECTOR) !== null) continue
    // The plugin's own 原生/团队 switch has its own visibility semantics.
    if (element.closest('[data-dsh-surface-switch]') !== null) continue
    const container = element.closest(CONTAINER_SELECTOR)
    if (container === null) continue
    const slot = slotOf(container)
    if (slot === undefined) continue
    const label = readLabel(element)
    if (label === '') continue
    const key = deriveKey(slot, label)
    // One accessible name per slot: the first node keeps the key, later twins
    // are left alone rather than fighting over the same mirror.
    if (nodes.has(key)) continue
    const order = nextOrder.get(slot) ?? 0
    nextOrder.set(slot, order + 1)
    entries.push({ key, label, originSlot: slot, order, movable: isMovable(element, container, slot, label) })
    nodes.set(key, element)
  }

  hosts.nodes = nodes
  if (entries.length > 0) lastEntries = entries
  return { entries, nodes }
}

/**
 * Render the mirrors, then hide their native nodes.
 *
 * The order is the whole point: mirrors first, hiding second. Swapping the two
 * steps turns a failed mirror into an entry that vanishes with no replacement.
 */
export function applyLayout(hosts: SlotHosts, plan: LayoutPlan, onActivate: (key: EntryKey) => void): void {
  const doc = hostDocument(hosts)
  if (doc === undefined) return

  // Undo the previous round first: MutationObserver rounds can overlap, and a
  // stale hide must never survive into the new layout.
  restoreNative(hosts, doc)

  const slots = new Map<SlotId, HTMLElement>()
  for (const slot of SLOT_ORDER) {
    const host = hosts[slot]
    if (host === undefined) continue
    host.hidden = true
    slots.set(slot, host)
  }

  const rendered = new Set<EntryKey>()
  try {
    for (const mirror of plan.mirrors) {
      const host = slots.get(mirror.slot)
      const native = hosts.nodes.get(mirror.key)
      if (host === undefined || native === undefined) continue
      host.append(createMirror(doc, mirror, native, onActivate))
      rendered.add(mirror.key)
    }
  } catch {
    // A half-built slot must leave every native node visible.
    restoreNative(hosts, doc)
    return
  }

  for (const key of hidesAfterRender(plan, rendered)) {
    const node = hosts.nodes.get(key)
    if (node === undefined) continue
    node.style.visibility = 'hidden'
    node.setAttribute('aria-hidden', 'true')
    node.setAttribute(HIDDEN_ATTR, '')
  }

  // Reveal what has content; empty slots and the empty submenu layer stay at
  // zero height (`display: none` from CSS), so they never take part in layout.
  for (const [slot, host] of slots) {
    host.hidden = host.childElementCount === 0 || (slot === 'submenu' && !plan.submenuVisible)
  }
}

/**
 * Copy the three states a mirror can follow (selection, active class, badge)
 * plus `disabled` — a disabled native button must not look clickable. Hover and
 * transition details stay with the native node: they are not synchronised.
 */
export function syncMirrorState(hosts: SlotHosts, nodes: ReadonlyMap<EntryKey, HTMLElement> = hosts.nodes): void {
  for (const slot of SLOT_ORDER) {
    const host = hosts[slot]
    if (host === undefined) continue
    for (const mirror of Array.from(host.querySelectorAll<HTMLButtonElement>(`button[${KEY_ATTR}]`))) {
      const key = mirror.getAttribute(KEY_ATTR)
      const native = key === null ? undefined : nodes.get(key)
      if (native === undefined) continue
      copyAttribute(native, mirror, 'aria-current')
      copyAttribute(native, mirror, 'aria-pressed')
      const activeClass = css.sidebarLayoutMirrorActive
      if (activeClass !== undefined && activeClass !== '') {
        const nativeClass = typeof native.className === 'string' ? native.className : ''
        mirror.classList.toggle(activeClass, nativeClass.includes('active'))
      }
      mirror.disabled = native.matches('[disabled], [aria-disabled="true"]')
      syncBadge(mirror, native)
    }
  }
}

/** Un-hide every native node and empty the slots. Safe to call when nothing was applied. */
export function restoreNative(hosts: SlotHosts, doc: Document): void {
  for (const node of Array.from(doc.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`))) {
    node.style.visibility = ''
    node.removeAttribute('aria-hidden')
    node.removeAttribute(HIDDEN_ATTR)
  }
  for (const slot of SLOT_ORDER) {
    const host = hosts[slot]
    if (host === undefined) continue
    host.replaceChildren()
    host.hidden = true
  }
}

/**
 * Read-only entry list for the settings section. It has to build the hosts as
 * a side effect so that discovery skips them (a mirror is not an entry).
 *
 * The settings page can render while the sidebar is not (drawer closed, route
 * switch), so an empty scan falls back to the last snapshot this module saw
 * rather than showing an empty list. One scan implementation, one cache.
 */
export function readSidebarEntries(doc: Document = document): LayoutEntry[] {
  const root = readSidebarRoot(doc)
  const entries = root === undefined ? [] : discoverEntries(ensureSlotHosts(root), doc).entries
  return entries.length > 0 ? entries : lastEntries
}

function slotOf(container: Element): SlotId | undefined {
  if (container.matches(PANEL_SELECTOR)) return 'panels'
  if (container.matches(FOOTER_SELECTOR) || container.matches(SETTINGS_SELECTOR)) return 'footer'
  if (container.matches(TOP_SELECTOR) || container.matches(LOGO_SELECTOR)) return 'top'
  return undefined
}

function readLabel(element: HTMLElement): string {
  const named = (element.getAttribute('aria-label') ?? '').trim()
  if (named !== '') return named
  const titled = (element.getAttribute('title') ?? '').trim()
  if (titled !== '') return titled
  return (element.textContent ?? '').trim()
}

function isMovable(element: HTMLElement, container: Element, slot: SlotId, label: string): boolean {
  // Platform/window controls in the top strip and the account row are listed but
  // never move: they are not navigation.
  if (container.matches(TOP_SELECTOR) || container.matches(SETTINGS_SELECTOR)) return false
  if (isToolLabel(label)) return false
  return !(slot === 'footer' && isAccountRow(element))
}

function isAccountRow(element: HTMLElement): boolean {
  const className = typeof element.className === 'string' ? element.className : ''
  if (/account|profile|avatar|user/i.test(className)) return true
  return element.querySelector('img') !== null && (element.textContent ?? '').trim() !== ''
}

function hostDocument(hosts: SlotHosts): Document | undefined {
  for (const slot of SLOT_ORDER) {
    const host = hosts[slot]
    if (host !== undefined) return host.ownerDocument
  }
  return undefined
}

function createMirror(
  doc: Document,
  mirror: LayoutMirror,
  native: HTMLElement,
  onActivate: (key: EntryKey) => void,
): HTMLButtonElement {
  const button = doc.createElement('button')
  button.type = 'button'
  button.setAttribute(KEY_ATTR, mirror.key)
  button.className = css.sidebarLayoutMirror ?? ''
  button.title = mirror.label
  const icon = native.querySelector('svg')
  if (icon !== null) {
    try {
      button.append(icon.cloneNode(true))
    } catch {
      // A third-party icon that refuses cloning degrades to a text button.
    }
  }
  const label = doc.createElement('span')
  label.className = css.sidebarLayoutMirrorLabel ?? ''
  label.textContent = mirror.label
  button.append(label)
  button.addEventListener('click', () => { onActivate(mirror.key) })
  return button
}

function copyAttribute(from: Element, to: Element, name: string): void {
  const value = from.getAttribute(name)
  if (value === null) to.removeAttribute(name)
  else to.setAttribute(name, value)
}

function syncBadge(mirror: HTMLButtonElement, native: HTMLElement): void {
  const text = (native.querySelector(BADGE_SELECTOR)?.textContent ?? '').trim()
  const existing = mirror.querySelector<HTMLElement>(`span[${BADGE_ATTR}]`)
  if (text === '') {
    existing?.remove()
    return
  }
  if (existing === null) {
    const badge = mirror.ownerDocument.createElement('span')
    badge.setAttribute(BADGE_ATTR, '')
    badge.className = css.sidebarLayoutMirrorBadge ?? ''
    mirror.append(badge)
    badge.textContent = text
    return
  }
  existing.textContent = text
}
