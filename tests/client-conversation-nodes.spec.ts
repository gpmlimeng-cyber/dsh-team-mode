import { describe, expect, it } from 'vitest'
import { mergeConversationNodes } from '../src/client/conversation-nodes.js'
import type { ConversationNode } from '../src/transport/contracts.js'

function userNode(id: string, text: string): ConversationNode {
  return {
    id,
    kind: 'user',
    seq: 1,
    time: 1,
    text,
  }
}

describe('mergeConversationNodes', () => {
  it('removes an optimistic message after the committed message with the same id arrives', () => {
    const committed = userNode('message-1', '重新获取团队成员')
    const pending = userNode('message-1', '重新获取团队成员')

    expect(mergeConversationNodes([committed], [pending])).toEqual([committed])
  })

  it('keeps an optimistic message until its committed message arrives', () => {
    const pending = userNode('pending:1', '重新获取团队成员')

    expect(mergeConversationNodes([], [pending])).toEqual([pending])
  })
})
