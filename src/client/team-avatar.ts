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
