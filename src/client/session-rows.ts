/** Minimal structural shapes for the three sources the row hider unions. */
export interface TeamSessionSource {
  members: Record<string, { sessionId: string }>
  /** Leader Sessions retired by an explicit handoff; kept hidden but never deleted. */
  retiredLeaderSessionIds?: readonly string[] | undefined
}

export interface AssistantInstanceSessionSource {
  mainSessionId?: string | undefined
  /** Main Sessions retired by a checkpoint handoff; kept hidden but never deleted. */
  retiredMainSessionIds?: readonly string[] | undefined
}

export interface AssistantTaskSessionSource {
  sessionId: string
}

/**
 * Every native Sidebar row the hider owns: team member Sessions, the bound main
 * Session of each Assistant (plus every retired one), and every Assistant task
 * worker Session. A single Set deduplicates the sources so one Session always
 * has one hiding decision, regardless of which source also references it.
 */
export function hiddenSessionIds(
  teams: readonly TeamSessionSource[],
  instances: readonly AssistantInstanceSessionSource[],
  tasks: readonly AssistantTaskSessionSource[],
): Set<string> {
  const ids = new Set<string>()
  for (const team of teams) {
    for (const member of Object.values(team.members)) {
      if (member.sessionId !== '') ids.add(member.sessionId)
    }
    for (const retired of team.retiredLeaderSessionIds ?? []) {
      if (retired !== '') ids.add(retired)
    }
  }
  for (const instance of instances) {
    const sessionId = instance.mainSessionId
    if (sessionId !== undefined && sessionId !== '') ids.add(sessionId)
    for (const retired of instance.retiredMainSessionIds ?? []) {
      if (retired !== '') ids.add(retired)
    }
  }
  for (const task of tasks) {
    if (task.sessionId !== '') ids.add(task.sessionId)
  }
  return ids
}
