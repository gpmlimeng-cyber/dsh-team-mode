import type { TeamView } from '../transport/contracts.js'
import { teamSidebarSummary } from './team-sidebar-data.js'

/** What one member Session row needs to know about the team that owns it. */
export interface SessionTeamFacts {
  teamId: string
  teamName: string
  memberName: string
  role: 'leader' | 'member'
  /**
   * Whether THIS member is parked on an approval. Per member, not the team
   * total: summing the member rows reproduces the team badge exactly, because
   * `teamSidebarSummary.waiting` counts the same `waiting_approval` members.
   */
  pending: number
}

/** The numbers the team row's badge may show; absent when the team is empty. */
export interface TeamBadgeCounts {
  /** Members parked on an approval; the badge outranks the running dot. */
  pending: number
  /**
   * Unread mail for the team; always 0. Only assistants carry a read marker
   * (`isAssistantUnread`), and the overview's team row has no `unread`
   * category either, so no team-level count exists to reuse.
   */
  unread: number
  /** Running members, exactly the count the sidebar's state dot already uses. */
  running: number
}

/**
 * One entry per member Session, keyed by Session id. The Leader comes from
 * `leaderSlotId`, never from a per-slot flag, so a Leader change needs no extra
 * bookkeeping here. Every value is read from the single member/task projection
 * in `team-sidebar-data`, so a row cannot invent a second count vocabulary.
 */
export function sessionTeamLookup(teams: readonly TeamView[]): Map<string, SessionTeamFacts> {
  const lookup = new Map<string, SessionTeamFacts>()
  for (const team of teams) {
    for (const member of Object.values(team.members)) {
      lookup.set(member.sessionId, {
        teamId: team.id,
        teamName: team.name,
        memberName: member.displayName,
        role: member.id === team.leaderSlotId ? 'leader' : 'member',
        pending: member.lastRuntimeState === 'waiting_approval' ? 1 : 0,
      })
    }
  }
  return lookup
}

/**
 * The badge numbers for one team row, or undefined for a team with no members
 * and no approval waiting — the caller then renders no badge at all. A team
 * with members reports real counts (zeros included), so an idle team is never
 * confused with an empty one.
 */
export function teamBadgeCounts(team: TeamView): TeamBadgeCounts | undefined {
  const summary = teamSidebarSummary(team)
  if (summary.members === 0 && summary.waiting === 0) return undefined
  return { pending: summary.waiting, unread: 0, running: summary.running }
}
