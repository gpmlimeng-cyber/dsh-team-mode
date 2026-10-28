import { useEffect } from 'react'
import type { AssistantInstance, AssistantSession } from '../domain/types.js'
import type { TeamView } from '../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { isolatedWorkspaceIds } from './assistant-instances.js'
import { hiddenSessionIds } from './session-rows.js'

const SESSION_ROW_PREFIX = 'session:'
const WORKSPACE_ROW_PREFIX = 'workspace:'

/**
 * Single owner of native Session and Workspace row visibility. Team member
 * Sessions, Assistant main Sessions, Assistant task worker Sessions, and the
 * private workspace registration of an isolated Assistant all render as
 * ordinary rows in the native Workspace/Session browser, but independent
 * hiders mutating the same `style.display` could restore a row one still
 * needed hidden.
 *
 * This component records the original inline display value of every row it owns
 * and restores exactly that value when the row stops needing hiding or the
 * component unmounts. Rows it never hid are left untouched.
 */
export function SessionRowHider(): null {
  useEffect(() => {
    // One array per source: a rejected source keeps its last successful payload
    // while the other sources still update, so a partial failure never blanks
    // the whole hidden set.
    let teamItems: TeamView[] = []
    let instanceItems: AssistantInstance[] = []
    let taskItems: AssistantSession[] = []
    let hiddenIds = new Set<string>()
    let hiddenWorkspaceIds = new Set<string>()
    const ownedRows = new Map<HTMLElement, string>()
    let generation = 0
    let live = true

    const applyPrefix = (prefix: string, hidden: Set<string>): void => {
      for (const row of document.querySelectorAll<HTMLElement>(`[data-row-key^="${prefix}"]`)) {
        const key = row.dataset.rowKey
        if (key === undefined) continue
        if (hidden.has(key.slice(prefix.length))) {
          if (!ownedRows.has(row)) ownedRows.set(row, row.style.display)
          if (row.style.display !== 'none') row.style.display = 'none'
        } else {
          const original = ownedRows.get(row)
          if (original !== undefined) {
            row.style.display = original
            ownedRows.delete(row)
          }
        }
      }
    }

    const apply = (): void => {
      applyPrefix(SESSION_ROW_PREFIX, hiddenIds)
      applyPrefix(WORKSPACE_ROW_PREFIX, hiddenWorkspaceIds)
    }

    const load = async (): Promise<void> => {
      const current = ++generation
      const [teams, instances, tasks] = await Promise.allSettled([
        callAgentTeam('team.list'),
        callAgentTeam('assistant.instance.list'),
        callAgentTeam('assistant.task.list', undefined),
      ])
      // A newer load owns the result; dropping stale resolution keeps an older
      // response from overwriting a fresher snapshot.
      if (!live || current !== generation) return
      if (teams.status === 'fulfilled') teamItems = teams.value.items
      if (instances.status === 'fulfilled') instanceItems = instances.value.items
      if (tasks.status === 'fulfilled') taskItems = tasks.value.items
      hiddenIds = hiddenSessionIds(teamItems, instanceItems, taskItems)
      hiddenWorkspaceIds = new Set(isolatedWorkspaceIds(instanceItems))
      apply()
    }

    void load()
    const unsubscribe = subscribeAgentTeam(() => { void load() }, () => {}, () => { void load() })
    const observer = new MutationObserver(apply)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-row-key'],
    })
    return () => {
      live = false
      generation += 1
      observer.disconnect()
      unsubscribe()
      // Restore only the rows this component hid, using the value captured when
      // it first took ownership.
      for (const [row, original] of ownedRows) row.style.display = original
      ownedRows.clear()
    }
  }, [])
  return null
}
