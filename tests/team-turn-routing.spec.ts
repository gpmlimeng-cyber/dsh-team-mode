import { describe, expect, it } from 'vitest'

import { AgentTeamError, isAgentTeamError } from '../src/domain/errors.js'
import { resolveTeamTarget, type TurnRoutingTeam } from '../src/runtime/team-turn-routing.js'

const team: TurnRoutingTeam = {
  leaderSlotId: 'L',
  members: {
    L: { id: 'L', displayName: 'Leader', role: 'leader' },
    a: { id: 'a', displayName: 'Alpha', role: 'member' },
    b: { id: 'b', displayName: 'Beta One', role: 'member' },
    c: { id: 'c', displayName: 'Beta', role: 'member' },
  },
}

function expectError(code: string, run: () => unknown): void {
  try {
    run()
  } catch (error) {
    expect(isAgentTeamError(error)).toBe(true)
    expect((error as AgentTeamError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

describe('resolveTeamTarget', () => {
  it('routes default content to the leader', () => {
    expect(resolveTeamTarget({ team, content: 'hello team' })).toEqual({
      slotId: 'L',
      reason: 'default',
    })
  })

  it('routes a single known mention to that member', () => {
    expect(resolveTeamTarget({ team, content: '@Alpha please take this' })).toEqual({
      slotId: 'a',
      reason: 'mention',
    })
  })

  it('lets an explicit target win over a mention', () => {
    expect(resolveTeamTarget({ team, content: '@Alpha please take this', explicitSlotId: 'b' })).toEqual({
      slotId: 'b',
      reason: 'explicit',
    })
  })

  it('rejects multiple known mentions', () => {
    expectError('INVALID_REQUEST', () => resolveTeamTarget({ team, content: '@Alpha and @Beta One help' }))
  })

  it('falls back to the leader for unknown mentions', () => {
    expect(resolveTeamTarget({ team, content: '@Ghost hello?' })).toEqual({
      slotId: 'L',
      reason: 'default',
    })
  })

  it('rejects an unknown explicit target', () => {
    expectError('MEMBER_NOT_FOUND', () => resolveTeamTarget({ team, content: 'hi', explicitSlotId: 'ghost' }))
  })

  it('rejects @all from a member', () => {
    expectError('INVALID_REQUEST', () => resolveTeamTarget({ team, content: '@all stand by', senderSlotId: 'a' }))
  })

  it('keeps leader @all leader-addressed without fanout', () => {
    expect(resolveTeamTarget({ team, content: '@all stand by', senderSlotId: 'L' })).toEqual({
      slotId: 'L',
      reason: 'mention',
    })
  })

  it('resolves the longest exact display name mention', () => {
    expect(resolveTeamTarget({ team, content: '@Beta One ship it' })).toEqual({
      slotId: 'b',
      reason: 'mention',
    })
  })

  it('matches mentions only at start or after whitespace, case-insensitively', () => {
    expect(resolveTeamTarget({ team, content: 'mail me at x@y.z then ping @beta' })).toEqual({
      slotId: 'c',
      reason: 'mention',
    })
  })

})
