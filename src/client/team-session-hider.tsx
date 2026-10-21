import { useEffect } from 'react'
import { callAgentTeam, subscribeAgentTeam } from './api.js'

const ROW_PREFIX = 'session:'

/** DSH has no per-Session “hidden” flag, so team conversations are removed
 * from the native Workspace/Session browser rows. The Sessions stay fully
 * addressable through the team page and parallel/board views. */
export function TeamSessionHider(): null {
  useEffect(() => {
    let teamSessionIds = new Set<string>()
    const hidden = new Set<HTMLElement>()
    let live = true

    const apply = (): void => {
      for (const row of document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]')) {
        const key = row.dataset.rowKey
        const sessionId = key?.slice(ROW_PREFIX.length)
        if (sessionId !== undefined && teamSessionIds.has(sessionId)) {
          row.style.display = 'none'
          hidden.add(row)
        } else if (hidden.delete(row)) {
          row.style.display = ''
        }
      }
    }

    const load = async (): Promise<void> => {
      try {
        const value = await callAgentTeam('team.list')
        if (!live) return
        teamSessionIds = new Set(value.items.flatMap(team =>
          Object.values(team.members).map(member => member.sessionId)))
        apply()
      } catch {
        // Keep the previous set; the SSE subscription retries on the next snapshot.
      }
    }

    void load()
    const unsubscribe = subscribeAgentTeam(() => { void load() }, () => {}, () => { void load() })
    const observer = new MutationObserver(apply)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      live = false
      observer.disconnect()
      unsubscribe()
      for (const row of hidden) row.style.display = ''
    }
  }, [])
  return null
}
