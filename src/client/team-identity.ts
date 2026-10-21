/** Fixed palette for stable per-slot member identity colours. */
export const TEAM_IDENTITY_COLORS = [
  // Sampled from AionUI's team header names: neutral leader, muted teal, tan.
  'light-dark(#5F5E5A, #B9B7B0)',
  'light-dark(#689BA3, #9FC6CC)',
  'light-dark(#AF8D63, #D3B58C)',
  'light-dark(#8C8AA6, #B7B4CE)',
  'light-dark(#7A9A7A, #B2CDB2)',
  'light-dark(#A06A6A, #D0A3A3)',
  'light-dark(#7E8CA0, #B0BFD4)',
  'light-dark(#9A8C7A, #CBBBA4)',
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
