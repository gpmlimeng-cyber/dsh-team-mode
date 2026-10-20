import type { ConversationNode } from '../transport/contracts.js'

export function mergeConversationNodes(
  committed: readonly ConversationNode[],
  pending: readonly ConversationNode[],
): ConversationNode[] {
  const committedIds = new Set(committed.map(node => node.id))
  return [...committed, ...pending.filter(node => !committedIds.has(node.id))]
}
