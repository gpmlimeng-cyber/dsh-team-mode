import { describe, expect, it } from 'vitest'
import { TEAM_IDENTITY_COLORS } from '../src/client/team-identity.js'
import {
  TEAM_AVATAR_TILE_COUNT,
  teamAvatarColor,
  teamAvatarIndex,
  teamAvatarTiles,
} from '../src/client/team-avatar.js'

describe('team avatar identity', () => {
  it('uses the first four visible characters for a long team name', () => {
    expect(teamAvatarTiles('软件研发团队')).toEqual(['软', '件', '研', '发'])
    expect(TEAM_AVATAR_TILE_COUNT).toBe(4)
  })

  it('pads three characters with 群', () => {
    expect(teamAvatarTiles('运维组')).toEqual(['运', '维', '组', '群'])
  })

  it('pads two characters with 团队', () => {
    expect(teamAvatarTiles('论文')).toEqual(['论', '文', '团', '队'])
  })

  it('pads one character with 的团队', () => {
    expect(teamAvatarTiles('研')).toEqual(['研', '的', '团', '队'])
  })

  it('ignores whitespace and falls back for an empty name', () => {
    expect(teamAvatarTiles('  Alpha Team  ')).toEqual(['A', 'l', 'p', 'h'])
    expect(teamAvatarTiles('\u3000论文\u3000')).toEqual(['论', '文', '团', '队'])
    expect(teamAvatarTiles('')).toEqual(['团', '队'])
    expect(teamAvatarTiles('   ')).toEqual(['团', '队'])
  })

  it('counts visible characters by code point, not UTF-16 unit', () => {
    expect(teamAvatarTiles('🚀星')).toEqual(['🚀', '星', '团', '队'])
  })

  it('derives a stable palette slot from the team id alone', () => {
    const index = teamAvatarIndex('team-1')
    expect(index).toBe(teamAvatarIndex('team-1'))
    expect(Number.isInteger(index)).toBe(true)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThan(TEAM_IDENTITY_COLORS.length)
    expect(teamAvatarColor('team-1')).toBe(TEAM_IDENTITY_COLORS[index])
    expect(teamAvatarColor('team-1')).toBe(teamAvatarColor('team-1'))
  })

  it('separates different team ids', () => {
    const values = new Set(
      ['team-1', 'team-2', 'team-3', 'team-4', 'team-5'].map(teamAvatarIndex),
    )
    expect(values.size).toBeGreaterThan(1)
  })
})
