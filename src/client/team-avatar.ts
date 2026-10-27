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

/** The 36px slot a team row gives its members, as DeepSeek-Bot's row does. */
export const TEAM_AVATAR_FRAME = 36

/** One seat of the cluster: its frame-relative box and what it draws. */
export interface TeamAvatarSeat {
  key: string
  kind: 'face' | 'more' | 'empty' | 'you'
  left: number
  top: number
  size: number
  /** `mask-image` layers cutting the gap a later seat presses into this one. */
  holes: string[]
  face?: TeamAvatarFace
  /** Only on the `more` seat: `+N`. */
  label?: string
}

/**
 * Where DeepSeek-Bot seats a group's faces (`mark.js:126-136`), copied as-is:
 * two people on a diagonal, three in an upright triangle (one above, two
 * below), four in a 2×2 grid. `frame` is the 36px slot the row hands over.
 */
export function clusterSeats(
  count: number,
  frame: number = TEAM_AVATAR_FRAME,
): Array<{ left: number; top: number; size: number }> {
  if (count <= 1) return [{ left: 0, top: 0, size: frame }]
  if (count === 2) {
    const size = frame * 2 / 3
    return [
      { left: 0, top: 0, size },
      { left: frame / 3, top: frame / 3, size },
    ]
  }
  if (count === 3) {
    const size = frame * 5 / 9
    const rest = frame - size
    return [
      { left: rest / 2, top: 0, size },
      { left: 0, top: rest, size },
      { left: rest, top: rest, size },
    ]
  }
  const half = frame / 2
  return [
    { left: 0, top: 0, size: half },
    { left: half, top: 0, size: half },
    { left: 0, top: half, size: half },
    { left: half, top: half, size: half },
  ]
}

/**
 * The transparent gaps between neighbours. DeepSeek-Bot cuts a disc of
 * `size/14` padding out of every earlier seat a later one overlaps
 * (`mark.js:155-163`), so the row's own background shows through — no ring to
 * go the wrong colour on hover. One mask layer per overlapping later seat.
 */
function clusterHoles(
  seats: readonly { left: number; top: number; size: number }[],
): string[][] {
  const gap = TEAM_AVATAR_FRAME / 14
  const rings = seats.map(seat => ({
    cx: seat.left + seat.size / 2,
    cy: seat.top + seat.size / 2,
    r: seat.size * 0.48 + gap,
  }))
  return seats.map((seat, index) => {
    const cx = seat.left + seat.size / 2
    const cy = seat.top + seat.size / 2
    return rings
      .slice(index + 1)
      .filter(ring => Math.hypot(ring.cx - cx, ring.cy - cy) < ring.r + seat.size * 0.46)
      .map(ring => `radial-gradient(circle at ${ring.cx - seat.left}px ${ring.cy - seat.top}px,transparent ${ring.r}px,#000 ${ring.r + 0.5}px)`)
  })
}

/**
 * The faces a team row seats, in `team.members` insertion order — DeepSeek-Bot
 * draws `room.members` as stored and never promotes the Leader, so neither do
 * we. Every member up to four is drawn; past that the fourth seat becomes a
 * `+N` disc with N = total − 3. A member-less team keeps one neutral 36px seat:
 * the reference falls back to a gumdrop there (`mark.js:145`), we use the
 * sidebar's own initial tile in the same seat.
 */
export function teamAvatarStack(
  members: Readonly<Record<string, {
    id: string
    displayName: string
    role: string
    assistantSnapshot?: { name?: string; avatar?: string | undefined }
  }>>,
): { faces: TeamAvatarFace[]; extra: number; total: number; seats: TeamAvatarSeat[] } {
  const named = Object.values(members).map(member => {
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
  const total = named.length
  if (total === 0) {
    return {
      faces: [],
      extra: 0,
      total: 0,
      seats: [{ key: 'empty', kind: 'empty', left: 0, top: 0, size: TEAM_AVATAR_FRAME, holes: [] }],
    }
  }
  const overflow = total > 4
  const extra = overflow ? total - 3 : 0
  const faces = overflow ? named.slice(0, 3) : named.slice(0, 4)
  // A lone member keeps the reference's 24px face and is joined by the 22.08px
  // "you" disc in the opposite corner (t1 doc §1.2-4, mark.js:140-144).
  const solo = total === 1
  const base = clusterSeats(Math.min(total === 1 ? 2 : total, 4))
  // No neighbour cut-outs: the reference masks the earlier face where the next
  // one lands, but with our mascots (which fill their tile) that bite reads as a
  // damaged avatar rather than a seam. The 1px inset ring keeps neighbours
  // readable instead.
  const holes = base.map((): string[] => [])
  // The `+N` disc sits at 92% of its seat with a 4% margin.
  const disc = (seat: { left: number; top: number; size: number }): { left: number; top: number; size: number } => ({
    left: seat.left + seat.size * 0.04,
    top: seat.top + seat.size * 0.04,
    size: seat.size * 0.92,
  })
  const seats = base.map((seat, index): TeamAvatarSeat => {
    if (overflow && index === 3) {
      return { key: 'more', kind: 'more', ...disc(seat), holes: holes[index]!, label: `+${extra}` }
    }
    if (solo && index === 1) {
      // Same 92% disc geometry as the counter, but no label: it stands for the
      // person reading the row, not for a hidden member.
      return { key: 'you', kind: 'you', ...disc(seat), holes: holes[index]! }
    }
    const face = faces[solo ? 0 : index]!
    return { key: face.id, kind: 'face', left: seat.left, top: seat.top, size: seat.size, holes: holes[index]!, face }
  })
  return { faces, extra, total, seats }
}
