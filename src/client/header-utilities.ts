/**
 * Move the shipped header utilities (preset label, subagent picker, job chip)
 * onto the view-tab row's right edge, as they are, instead of hiding them.
 *
 * The host owns those controls and keeps them in the Session header; it offers
 * no slot for repositioning them, so this moves the smallest ancestor that holds
 * them and puts it back exactly where it came from when the surface or the
 * Session changes. Every step is best-effort: if a marker is missing nothing
 * moves, and the header stays as the host drew it.
 */

const MOVED_ATTR = 'data-dsh-team-header-utilities'
const PLACED_ATTR = 'data-dsh-team-header-utilities-placed'

interface Moved {
  node: HTMLElement
  parent: Node
  next: Node | null
  placedIn?: HTMLElement
}

/** Texts that identify a shipped utility; matched exactly after trimming. */
const UTILITY_HINTS = ['子智能体', '后台任务', '定时任务']

function containsHint(node: Element): boolean {
  const text = (node.textContent ?? '').trim()
  if (text === '') return false
  return UTILITY_HINTS.some(hint => text.includes(hint))
}

/** The smallest ancestor that holds every utility the header currently shows. */
export function utilitiesCluster(scope: ParentNode): HTMLElement | null {
  const holders = [...scope.querySelectorAll<HTMLElement>('*')].filter(node =>
    node.children.length > 0 && containsHint(node),
  )
  if (holders.length === 0) return null
  // Deepest holder wins, then climb until one node covers them all.
  let candidate: HTMLElement | null = holders[0] ?? null
  for (const holder of holders.slice(1)) {
    if (candidate === null) { candidate = holder; continue }
    if (candidate.contains(holder)) continue
    if (holder.contains(candidate)) { candidate = holder; continue }
    let shared = candidate.parentElement
    while (shared !== null && !shared.contains(holder)) shared = shared.parentElement
    if (shared !== null) candidate = shared
  }
  return candidate
}

/** The row that carries the view tabs; appended at its end, pushed right. */
export function viewTabRow(scope: ParentNode): HTMLElement | null {
  const list = scope.querySelector<HTMLElement>('[role="tablist"]')
  if (list !== null) return list.parentElement ?? null
  return null
}

export function placeHeaderUtilities(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  let moved: Moved | undefined
  let frame: number | undefined
  let disposed = false

  const restore = (): void => {
    if (moved === undefined) return
    const { node, parent, next } = moved
    node.removeAttribute(MOVED_ATTR)
    node.removeAttribute(PLACED_ATTR)
    node.style.removeProperty('margin-inline-start')
    if (node.parentElement !== null) {
      if (next !== null && next.parentNode === parent) parent.insertBefore(node, next)
      else parent.appendChild(node)
    }
    moved = undefined
  }

  const apply = (): void => {
    frame = undefined
    if (disposed) return
    const scope = document.querySelector<HTMLElement>('[data-slot="conversation.session.header"]')
    if (scope === null) { restore(); return }
    const row = viewTabRow(scope)
    const cluster = utilitiesCluster(scope)
    if (row === null || cluster === null || cluster.contains(row)) { restore(); return }
    if (moved?.node === cluster && cluster.parentElement === row) return
    restore()
    moved = { node: cluster, parent: cluster.parentNode as Node, next: cluster.nextSibling }
    cluster.setAttribute(MOVED_ATTR, '')
    cluster.setAttribute(PLACED_ATTR, '')
    cluster.style.marginInlineStart = 'auto'
    row.appendChild(cluster)
  }

  const schedule = (): void => {
    if (frame !== undefined || disposed) return
    frame = window.requestAnimationFrame(apply)
  }

  apply()
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    disposed = true
    observer.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    restore()
  }
}
