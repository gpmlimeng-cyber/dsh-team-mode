import { useSyncExternalStore } from 'react'

export type TeamConversationView = 'parallel' | 'board'

const views = new Map<string, TeamConversationView>()
const listeners = new Set<() => void>()

export function setTeamConversationView(sessionId: string | undefined, view: TeamConversationView | undefined): void {
  if (sessionId === undefined) return
  const current = views.get(sessionId)
  if (view === undefined) {
    if (current === undefined) return
    views.delete(sessionId)
  } else {
    if (current === view) return
    views.set(sessionId, view)
  }
  for (const listener of listeners) listener()
}

export function useTeamConversationView(sessionId: string | undefined): TeamConversationView | undefined {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => (sessionId === undefined ? undefined : views.get(sessionId)),
    () => undefined,
  )
}
