/**
 * Seat the shipped header utilities (preset label, subagent picker, job chip) on
 * the view-tab row's right edge.
 *
 * Method copied from dsh-web-mobile: the slot tree belongs to the host's React,
 * so a plugin must not move nodes — it tags the host elements and lets CSS do
 * the seating with absolute positioning inside the header. That keeps React's
 * tree intact (no re-render can undo it) and needs no wrapper.
 */

const UTILITY_HINTS = ['子智能体', '后台任务', '定时任务']
const HEADER_ATTR = 'data-dsh-team-header-seat'
const UTILITIES_ATTR = 'data-dsh-team-header-utilities'

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

/** The conversation header: the nearest one above the switcher, else the slot. */
export function headerElement(): HTMLElement | null {
  const switcher = document.querySelector<HTMLElement>('[data-dsh-team-session-switcher]')
  return switcher?.closest<HTMLElement>('header[class*="header"], [class*="header"][class*="root"]')
    ?? document.querySelector<HTMLElement>('[data-slot="conversation.session.header"]')
    ?? null
}

export function seatHeaderUtilities(extraLabels: readonly string[] = []): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  let frame: number | undefined
  let disposed = false
  let seated: { header: HTMLElement; cluster: HTMLElement } | undefined

  const clear = (): void => {
    if (seated === undefined) return
    seated.header.removeAttribute(HEADER_ATTR)
    seated.cluster.removeAttribute(UTILITIES_ATTR)
    seated = undefined
  }

  const apply = (): void => {
    frame = undefined
    if (disposed) return
    const header = headerElement()
    if (header === null) { clear(); return }
    const cluster = utilitiesCluster(header, extraLabels)
    if (cluster === null || cluster === header) { clear(); return }
    if (seated?.header === header && seated.cluster === cluster) return
    clear()
    header.setAttribute(HEADER_ATTR, '')
    cluster.setAttribute(UTILITIES_ATTR, '')
    seated = { header, cluster }
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
    clear()
  }
}
