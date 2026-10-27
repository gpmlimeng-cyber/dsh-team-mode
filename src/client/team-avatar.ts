import { TEAM_IDENTITY_COLORS, teamIdentityColor } from './team-identity.js'

/** The four tiles of a team mark, in reading order. */
export const TEAM_AVATAR_TILE_COUNT = 4

/**
 * A stable, name-derived mark for a team row. Teams are durable entities, so
 * this must not follow the current Leader or the member order.
 *
 * A name shorter than four visible characters is padded so the 2x2 mark always
 * reads as a complete four-cell identity:
 *   1 char  → `X 的团队`
 *   2 chars → `XY 团队`
 *   3 chars → `XYZ 群`
 */
export function teamAvatarTiles(name: string): string[] {
  const visible = Array.from(name.replace(/\s+/g, ''))
  if (visible.length === 0) return ['团', '队']
  if (visible.length >= TEAM_AVATAR_TILE_COUNT) {
    return visible.slice(0, TEAM_AVATAR_TILE_COUNT)
  }
  if (visible.length === 3) return [...visible, '群']
  if (visible.length === 2) return [...visible, '团', '队']
  return [visible[0]!, '的', '团', '队']
}

/** FNV-1a is enough here: the only requirement is a stable palette index. */
export function teamAvatarIndex(teamId: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < teamId.length; index += 1) {
    hash ^= teamId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % TEAM_IDENTITY_COLORS.length
}

export function teamAvatarColor(teamId: string): string {
  return teamIdentityColor(teamAvatarIndex(teamId))
}

/** One face in a team's stacked avatar: the member's picture, else a mascot. */
export interface TeamAvatarFace {
  id: string
  name: string
  avatar?: string
  /** Seed and colour for the mascot drawn when the member uploaded no picture. */
  mascotSeed: string
  mascotColor: string
}

/**
 * The faces a team row stacks, in the order DeepSeek-Bot draws them: the Leader
 * first, then members. The grid is always 2×2 and filled in reading order, so
 * ≤4 people are all drawn (2 = a diagonal, 3 = an upright triangle), and past
 * that the last cell becomes a `+N` chip with N = total − 3.
 */
export function teamAvatarStack(
  members: Readonly<Record<string, {
    id: string
    displayName: string
    role: string
    assistantSnapshot?: { name?: string; avatar?: string | undefined }
  }>>,
): { faces: TeamAvatarFace[]; extra: number; total: number; size: number } {
  const ordered = Object.values(members)
    .slice()
    .sort((left, right) => {
      if (left.role !== right.role) return left.role === 'leader' ? -1 : 1
      return left.id.localeCompare(right.id)
    })
  const named = ordered.map(member => {
    const avatar = member.assistantSnapshot?.avatar
    const label = member.displayName.trim() === '' ? member.assistantSnapshot?.name ?? '' : member.displayName
    return {
      id: member.id,
      name: label.trim() === '' ? '助手' : label.trim(),
      // Deterministic per member: the same face on every render and reload.
      mascotSeed: member.id,
      mascotColor: teamAvatarColor(member.id),
      ...(avatar !== undefined && avatar.startsWith('data:') ? { avatar } : {}),
    }
  })
  // Four or fewer: draw them all. Past that the fourth cell is the counter.
  const overflow = named.length > 4
  // Face size follows the grid that is actually drawn: two faces get a bigger
  // tile than a full 2×2 (DeepSeek-Bot: 24 / 20 / 18 px).
  const size = named.length <= 2 ? 24 : named.length === 3 ? 20 : 18
  return {
    faces: overflow ? named.slice(0, 3) : named.slice(0, 4),
    extra: overflow ? named.length - 3 : 0,
    total: named.length,
    size,
  }
}
