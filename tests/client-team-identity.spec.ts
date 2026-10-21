import { describe, expect, it } from 'vitest'
import { assignTeamIdentityColors, TEAM_IDENTITY_COLORS, teamIdentityColor } from '../src/client/team-identity.js'

describe('team identity colours', () => {
  it('keeps an existing slot colour across reorders', () => {
    const { colors } = assignTeamIdentityColors({ leader: 0, a: 1 }, ['a', 'leader'])
    expect(colors).toEqual({ leader: 0, a: 1 })
    expect(teamIdentityColor(colors.a!)).toBe(TEAM_IDENTITY_COLORS[1])
  })

  it('assigns the lowest free colour to a new slot', () => {
    const { colors, changed } = assignTeamIdentityColors({ leader: 0, a: 2 }, ['leader', 'a', 'b'])
    expect(changed).toBe(true)
    expect(colors.b).toBe(1)
  })

  it('releases a removed slot colour for reuse', () => {
    const { colors } = assignTeamIdentityColors({ leader: 0, a: 1, b: 2 }, ['leader', 'b', 'c'])
    expect(colors.a).toBeUndefined()
    expect(colors.c).toBe(1)
    expect(colors.b).toBe(2)
  })

  it('wraps the palette for teams larger than it', () => {
    const ids = Array.from({ length: TEAM_IDENTITY_COLORS.length + 2 }, (_, index) => `m${index}`)
    const { colors } = assignTeamIdentityColors({}, ids)
    expect(colors.m0).toBe(0)
    expect(colors[`m${TEAM_IDENTITY_COLORS.length}`]).toBe(0)
  })
})
