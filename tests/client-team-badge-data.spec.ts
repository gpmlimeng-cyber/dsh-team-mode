import { describe, expect, it } from 'vitest'
import type { TeamView } from '../src/transport/contracts.js'
import {
  sessionTeamLookup,
  teamBadgeCounts,
  type TeamBadgeCounts,
} from '../src/client/team-badge-data.js'

const NOW = '2026-01-01T00:00:00.000Z'

function slots(entries: ReadonlyArray<readonly [string, string, string]>): TeamView['members'] {
  return Object.fromEntries(entries.map(([slotId, sessionId, lastRuntimeState]) => [
    slotId,
    {
      id: slotId,
      sessionId,
      displayName: slotId,
      role: slotId === 'leader' ? 'leader' : 'member',
      lastRuntimeState,
    },
  ])) as TeamView['members']
}

function team(overrides: { members?: TeamView['members']; leaderSlotId?: string } = {}): TeamView {
  return {
    id: 'team-1',
    name: '测试团队',
    leaderSlotId: overrides.leaderSlotId ?? 'leader',
    members: overrides.members ?? {},
    tasks: {},
    updatedAt: NOW,
  } as TeamView
}

function countsOf(teamView: TeamView): TeamBadgeCounts {
  const counts = teamBadgeCounts(teamView)
  if (counts === undefined) throw new Error('expected badge counts for a non-empty team')
  return counts
}

describe('teamBadgeCounts', () => {
  it('reports pending approvals ahead of running activity', () => {
    const counts = countsOf(team({
      members: slots([
        ['leader', 'session-leader', 'running'],
        ['member-1', 'session-member-1', 'running'],
        ['member-2', 'session-member-2', 'waiting_approval'],
      ]),
    }))
    // Approvals are their own member state, never also running, so the badge
    // number the row reads is the pending count rather than the running one.
    expect(counts).toEqual({ pending: 1, unread: 0, running: 2 })
    const badge = counts.pending > 0 ? counts.pending : counts.running
    expect(badge).toBe(1)
  })

  it('is stable across calls and member order', () => {
    const forward = slots([
      ['leader', 'session-leader', 'running'],
      ['member-1', 'session-member-1', 'waiting_approval'],
    ])
    const reversed = slots([
      ['member-1', 'session-member-1', 'waiting_approval'],
      ['leader', 'session-leader', 'running'],
    ])

    const first = sessionTeamLookup([team({ members: forward })])
    const again = sessionTeamLookup([team({ members: forward })])
    expect([...again.entries()]).toEqual([...first.entries()])
    expect(countsOf(team({ members: reversed })).pending)
      .toBe(countsOf(team({ members: forward })).pending)
  })

  it('counts each member own approval so the rows sum to the team badge', () => {
    const lookup = sessionTeamLookup([team({
      members: slots([
        ['leader', 'session-leader', 'idle'],
        ['member-1', 'session-member-1', 'waiting_approval'],
      ]),
    })])

    expect(lookup.get('session-leader')).toEqual({
      teamId: 'team-1',
      teamName: '测试团队',
      memberName: 'leader',
      role: 'leader',
      pending: 0,
    })
    expect(lookup.get('session-member-1')?.role).toBe('member')
    expect(lookup.get('session-leader')?.pending).toBe(0)
    expect(lookup.get('session-member-1')?.pending).toBe(1)
    // The invariant the row badge relies on: summing the member rows is the
    // team badge, not a multiple of it.
    const sum = [...lookup.values()].reduce((total, facts) => total + facts.pending, 0)
    expect(sum).toBe(countsOf(team({
      members: slots([
        ['leader', 'session-leader', 'idle'],
        ['member-1', 'session-member-1', 'waiting_approval'],
      ]),
    })).pending)
  })

  it('returns undefined for a team with no members and no pending approval', () => {
    expect(teamBadgeCounts(team())).toBeUndefined()
  })
})
