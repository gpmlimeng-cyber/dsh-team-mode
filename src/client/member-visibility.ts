export function initialVisibleMemberSlots(memberIds: readonly string[]): string[] {
  return [...memberIds]
}

export function reconcileVisibleMemberSlots(
  current: readonly string[],
  previousMemberIds: readonly string[],
  memberIds: readonly string[],
): string[] {
  const available = new Set(memberIds)
  const previous = new Set(previousMemberIds)
  const valid = current.filter(slotId => available.has(slotId))
  const added = memberIds.filter(slotId => !previous.has(slotId))
  const next = [...new Set([...valid, ...added])]
  return next.length > 0 ? next : [...memberIds]
}

export function toggleVisibleMemberSlot(current: readonly string[], slotId: string): string[] {
  if (!current.includes(slotId)) return [...current, slotId]
  return current.length === 1 ? [...current] : current.filter(value => value !== slotId)
}
