import { useEffect } from 'react'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { hiddenAssistantSessionIds } from './assistant-instances.js'

const ROW_PREFIX = 'session:'

/**
 * Assistant main Sessions and their hidden worker Sessions are ordinary DSH
 * Sessions, so their native Sidebar rows would duplicate the “单聊” entry. The
 * hider unions both sets in one load; event-driven reloads keep worker rows
 * hidden as soon as the main assistant creates them.
 */
export function AssistantSessionHider(): null {
  useEffect(() => {
    let hiddenSessionIds = new Set<string>()
    const hidden = new Set<HTMLElement>()
    let live = true

    const apply = (): void => {
      for (const row of document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]')) {
        const key = row.dataset.rowKey
        const sessionId = key?.slice(ROW_PREFIX.length)
        if (sessionId !== undefined && hiddenSessionIds.has(sessionId)) {
          row.style.display = 'none'
          hidden.add(row)
        } else if (hidden.delete(row)) {
          row.style.display = ''
        }
      }
    }

    const load = async (): Promise<void> => {
      try {
        const [instances, tasks] = await Promise.all([
          callAgentTeam('assistant.instance.list'),
          callAgentTeam('assistant.task.list', undefined),
        ])
        if (!live) return
        hiddenSessionIds = hiddenAssistantSessionIds(instances.items, tasks.items)
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
