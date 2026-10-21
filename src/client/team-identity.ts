/** Fixed palette for stable per-slot member identity colours. */
export const TEAM_IDENTITY_COLORS = [
  'var(--dsw-static-blue-450)',
  'var(--dsw-static-green-500)',
  'var(--dsw-static-amber-500)',
  'var(--dsw-static-deepseek-450)',
  'var(--dsw-static-red-400)',
  'var(--dsw-static-blue-600)',
  'var(--dsw-static-green-400)',
  'var(--dsw-static-amber-400)',
] as const

export function teamIdentityColor(index: number): string {
  return TEAM_IDENTITY_COLORS[index % TEAM_IDENTITY_COLORS.length] ?? 'var(--dsw-static-blue-450)'
}

/**
 * Keep an existing slot → colour-index mapping stable while assigning the
 * lowest free index to new slots and releasing indices for removed slots.
 * Reordering the member list therefore never changes an existing colour.
 */
export function assignTeamIdentityColors(
  stored: Readonly<Record<string, number>>,
  memberIds: readonly string[],
): { colors: Record<string, number>, changed: boolean } {
  const colors: Record<string, number> = { ...stored }
  let changed = false
  // Release removed slots first so their colours can be reused immediately.
  for (const id of Object.keys(colors)) {
    if (memberIds.includes(id)) continue
    delete colors[id]
    changed = true
  }
  const used = new Set(Object.values(colors))
  for (const id of memberIds) {
    if (colors[id] !== undefined) continue
    let index = 0
    while (used.has(index) && index < TEAM_IDENTITY_COLORS.length) index += 1
    colors[id] = index % TEAM_IDENTITY_COLORS.length
    used.add(colors[id]!)
    changed = true
  }
  return { colors, changed }
}
