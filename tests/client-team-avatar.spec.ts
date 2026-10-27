import { describe, expect, it } from 'vitest'
import { TEAM_IDENTITY_COLORS } from '../src/client/team-identity.js'
import {
  TEAM_AVATAR_TILE_COUNT,
  clusterSeats,
  teamAvatarColor,
  teamAvatarIndex,
  teamAvatarStack,
  teamAvatarTiles,
} from '../src/client/team-avatar.js'

describe('team avatar identity', () => {
  /** n members, the first one the Leader unless asked otherwise. */
  const build = (count: number): ReturnType<typeof teamAvatarStack> => teamAvatarStack(
    Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `m${index + 1}`,
      { id: `m${index + 1}`, displayName: `成员${index + 1}`, role: index === 0 ? 'leader' : 'member' },
    ])),
  )

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

  it('seats two on a diagonal, three in an upright triangle, four in a grid', () => {
    expect(clusterSeats(2)).toEqual([
      { left: 0, top: 0, size: 24 },
      { left: 12, top: 12, size: 24 },
    ])
    expect(clusterSeats(3)).toEqual([
      { left: 8, top: 0, size: 20 },
      { left: 0, top: 16, size: 20 },
      { left: 16, top: 16, size: 20 },
    ])
    expect(clusterSeats(4)).toEqual([
      { left: 0, top: 0, size: 18 },
      { left: 18, top: 0, size: 18 },
      { left: 0, top: 18, size: 18 },
      { left: 18, top: 18, size: 18 },
    ])
  })

  it('draws every member up to four, at the size of the grid it draws', () => {
    expect(build(2).faces).toHaveLength(2)
    expect(build(2).seats.map(seat => seat.size)).toEqual([24, 24])
    expect(build(3).faces).toHaveLength(3)
    expect(build(3).seats.map(seat => seat.size)).toEqual([20, 20, 20])
    expect(build(4).faces).toHaveLength(4)
    expect(build(4).seats.map(seat => seat.size)).toEqual([18, 18, 18, 18])
    expect(build(4).extra).toBe(0)
  })

  it('turns the fourth seat into a counter past four members', () => {
    const stack = build(5)
    // 5 people = three faces plus +2 (total − 3), not +1.
    expect(stack.faces.map(face => face.id)).toEqual(['m1', 'm2', 'm3'])
    expect(stack.extra).toBe(2)
    expect(stack.seats).toHaveLength(4)
    expect(stack.seats[3]?.kind).toBe('more')
    expect(stack.seats[3]?.label).toBe('+2')
    // The disc is 92% of the last seat, inset by 4%.
    expect(stack.seats[3]?.size).toBeCloseTo(18 * 0.92, 5)
    expect(stack.seats[3]?.left).toBeCloseTo(18 + 18 * 0.04, 5)
    expect(stack.seats[3]?.top).toBeCloseTo(18 + 18 * 0.04, 5)
  })

  it('keeps team.members order and never promotes the Leader', () => {
    // The reference draws room.members as stored: the Leader is not moved up.
    const stack = teamAvatarStack({
      a: { id: 'a', displayName: '成员一', role: 'member' },
      b: { id: 'b', displayName: '成员二', role: 'leader' },
    })
    expect(stack.seats.map(seat => seat.face?.id)).toEqual(['a', 'b'])
  })

  it('draws a lone member at the reference face size; nobody draws nothing', () => {
    // The 22.08px "you" disc is deferred (t1 doc §1.2-4): one face, no disc.
    const solo = build(1)
    expect(solo.seats.map(seat => seat.kind)).toEqual(['face'])
    expect(solo.seats[0]?.size).toBe(24)
    expect(solo.seats[0]?.holes).toEqual([])
    expect(teamAvatarStack({})).toEqual({ faces: [], extra: 0, total: 0, seats: [] })
  })

  it('cuts the neighbour gap into the earlier seat and draws what it counts', () => {
    const two = build(2)
    expect(two.seats[0]?.holes).toHaveLength(1)
    expect(two.seats[0]?.holes[0]).toContain('radial-gradient')
    expect(two.seats[1]?.holes).toHaveLength(0)
    const four = build(4)
    expect(four.seats[0]?.holes).toHaveLength(2)
    expect(four.seats[3]?.holes).toHaveLength(0)
    // `data-count` is seats.length: every drawn face plus the +N disc.
    for (const count of [1, 2, 3, 4, 5, 12]) {
      const stack = build(count)
      const drawn = stack.faces.length + (stack.extra > 0 ? 1 : 0)
      expect(stack.seats).toHaveLength(drawn)
    }
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
