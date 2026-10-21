import { useEffect } from 'react'
import { callAgentTeam, subscribeAgentTeam } from './api.js'

const ROW_PREFIX = 'session:'

/**
 * Assistant main Sessions are ordinary DSH Sessions, so their native Sidebar
 * rows would duplicate the “单聊” entry. Hide only the rows this hider owns;
 * team-hidden rows stay untouched, and both hiders can restore independently.
 */
export function AssistantSessionHider(): null {
  useEffect(() => {
    let mainSessionIds = new Set<string>()
    const hidden = new Set<HTMLElement>()
    let live = true

    const apply = (): void => {
      for (const row of document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]')) {
        const key = row.dataset.rowKey
        const sessionId = key?.slice(ROW_PREFIX.length)
        if (sessionId !== undefined && mainSessionIds.has(sessionId)) {
          row.style.display = 'none'
          hidden.add(row)
        } else if (hidden.delete(row)) {
          row.style.display = ''
        }
      }
    }

    const load = async (): Promise<void> => {
      try {
        const value = await callAgentTeam('assistant.instance.list')
        if (!live) return
        mainSessionIds = new Set(value.items
          .map(instance => instance.mainSessionId)
          .filter((id): id is string => id !== undefined))
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
