/**
 * Put the shipped header utilities (preset label, subagent picker, job chip) on
 * the view-tab row's right edge without letting their layout fight that row.
 *
 * Method follows dsh-qol: never append a host container straight into a host
 * flex row — wrap it in our own element first, style the wrapper, and let the
 * host container keep its internal layout inside. Every step is best-effort:
 * a missing marker moves nothing, and the original parent and sibling are
 * restored on cleanup.
 */

const UTILITY_HINTS = ['子智能体', '后台任务', '定时任务']
const WRAPPER_ATTR = 'data-dsh-team-header-utilities'
const MOVED_ATTR = 'data-dsh-team-header-utilities-origin'
const WRAPPER_CLASS = 'dsh-team-mode-header-utilities'

interface Placement {
  cluster: HTMLElement
  wrapper: HTMLElement
  parent: Node
  next: Node | null
}

function containsHint(node: Element, hints: readonly string[]): boolean {
  const text = (node.textContent ?? '').trim()
  if (text === '') return false
  return hints.some(hint => text.includes(hint))
}

/** The smallest ancestor holding every utility the header currently shows. */
export function utilitiesCluster(scope: ParentNode, extra: readonly string[] = []): HTMLElement | null {
  const hints = [...UTILITY_HINTS, ...extra].filter(hint => hint.trim() !== '')
  const holders = [...scope.querySelectorAll<HTMLElement>('*')]
    .filter(node => node.children.length > 0 && containsHint(node, hints))
  if (holders.length === 0) return null
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

/** The row that carries the view tabs. */
export function viewTabRow(scope: ParentNode): HTMLElement | null {
  const list = scope.querySelector<HTMLElement>('[role="tablist"]')
  return list?.parentElement ?? null
}

export function placeHeaderUtilities(extraLabels: readonly string[] = []): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  let placement: Placement | undefined
  let frame: number | undefined
  let disposed = false

  const restore = (): void => {
    if (placement === undefined) return
    const { cluster, wrapper, parent, next } = placement
    cluster.removeAttribute(MOVED_ATTR)
    if (wrapper.parentNode !== null) wrapper.remove()
    if (next !== null && next.parentNode === parent) parent.insertBefore(cluster, next)
    else parent.appendChild(cluster)
    placement = undefined
  }

  const apply = (): void => {
    frame = undefined
    if (disposed) return
    // The slot attribute is the precise scope; a host that renames it still has
    // exactly one view-tab row and one utility cluster on screen, so the whole
    // body is the fallback rather than hiding nothing.
    const precise = document.querySelector<HTMLElement>('[data-slot="conversation.session.header"]')
    const scope: ParentNode = precise ?? document.body
    const row = viewTabRow(scope) ?? viewTabRow(document.body)
    const cluster = utilitiesCluster(scope, extraLabels)
    if (row === null || cluster === null || cluster.contains(row)) { restore(); return }
    if (placement?.cluster === cluster && placement.wrapper.parentElement === row) return
    restore()

    // Our wrapper owns the row's layout; the host container keeps its own inside.
    const wrapper = document.createElement('span')
    wrapper.setAttribute(WRAPPER_ATTR, '')
    wrapper.className = WRAPPER_CLASS
    wrapper.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:8px',
      'min-width:0',
      'margin-inline-start:auto',
      'flex:none',
    ].join(';')
    const parent = cluster.parentNode as Node
    const next = cluster.nextSibling
    wrapper.appendChild(cluster)
    cluster.setAttribute(MOVED_ATTR, '')
    row.appendChild(wrapper)
    placement = { cluster, wrapper, parent, next }
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
