import { describe, expect, it } from 'vitest'
import { TEAM_IDENTITY_COLORS } from '../src/client/team-identity.js'
import {
  TEAM_AVATAR_TILE_COUNT,
  teamAvatarColor,
  teamAvatarIndex,
  teamAvatarStack,
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

  it('draws every member up to four, with the grid size per count', () => {
    const build = (count: number): ReturnType<typeof teamAvatarStack> => teamAvatarStack(
      Object.fromEntries(Array.from({ length: count }, (_, index) => [
        `m${index + 1}`,
        { id: `m${index + 1}`, displayName: `成员${index + 1}`, role: index === 0 ? 'leader' : 'member' },
      ])),
    )
    expect(build(2).faces).toHaveLength(2)
    expect(build(2).size).toBe(24)
    expect(build(3).faces).toHaveLength(3)
    expect(build(3).size).toBe(20)
    expect(build(4).faces).toHaveLength(4)
    expect(build(4).extra).toBe(0)
    expect(build(4).size).toBe(18)
  })

  it('turns the fourth seat into a counter past four members', () => {
    const stack = teamAvatarStack(Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `m${index + 1}`,
        { id: `m${index + 1}`, displayName: `成员${index + 1}`, role: 'member' },
      ]),
    ))
    // 5 people = three faces plus +2 (total − 3), not +1.
    expect(stack.faces).toHaveLength(3)
    expect(stack.extra).toBe(2)
  })

  it('keeps an uploaded picture and ignores a non-data avatar', () => {
    const stack = teamAvatarStack({
      a: { id: 'a', displayName: '甲', role: 'leader', assistantSnapshot: { avatar: 'data:image/png;base64,AA' } },
      b: { id: 'b', displayName: '乙', role: 'member', assistantSnapshot: { avatar: 'https://example.com/x.png' } },
    })
    expect(stack.faces[0]?.avatar).toBe('data:image/png;base64,AA')
    expect(stack.faces[1]?.avatar).toBeUndefined()
    expect(stack.extra).toBe(0)
  })

  it('falls back to a label when a member has no usable name', () => {
    const stack = teamAvatarStack({
      a: { id: 'a', displayName: '   ', role: 'leader', assistantSnapshot: { name: '  ' } },
    })
    expect(stack.faces[0]?.name).toBe('助手')
  })
})
