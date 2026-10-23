import { describe, expect, it } from 'vitest'
import { hiddenSessionIds } from '../src/client/session-rows.js'

describe('hiddenSessionIds', () => {
  it('unions team member, assistant main, and assistant task Sessions', () => {
    const ids = hiddenSessionIds(
      [{
        members: {
          leader: { sessionId: 'team-leader' },
          member: { sessionId: 'team-member' },
        },
      }],
      [{ mainSessionId: 'assistant-main' }],
      [{ sessionId: 'assistant-task' }],
    )
    expect([...ids].sort()).toEqual([
      'assistant-main',
      'assistant-task',
      'team-leader',
      'team-member',
    ])
  })

  it('hides every retired main Session alongside the current one', () => {
    const ids = hiddenSessionIds(
      [],
      [{ mainSessionId: 'main', retiredMainSessionIds: ['old-1', 'old-2'] }],
      [],
    )
    expect([...ids].sort()).toEqual(['main', 'old-1', 'old-2'])
  })

  it('skips blank retired main Session ids', () => {
    const ids = hiddenSessionIds([], [{ retiredMainSessionIds: ['', 'old-1'] }], [])
    expect([...ids]).toEqual(['old-1'])
  })

  it('deduplicates a Session referenced by every source', () => {
    const ids = hiddenSessionIds(
      [{ members: { leader: { sessionId: 'shared' }, member: { sessionId: 'team-only' } } }],
      [{ mainSessionId: 'shared' }],
      [{ sessionId: 'shared' }],
    )
    expect([...ids].sort()).toEqual(['shared', 'team-only'])
  })

  it('deduplicates Sessions across multiple teams and tasks', () => {
    const ids = hiddenSessionIds(
      [
        { members: { a: { sessionId: 'same' } } },
        { members: { b: { sessionId: 'same' }, c: { sessionId: 'other' } } },
      ],
      [{ mainSessionId: 'same' }, { mainSessionId: 'same' }],
      [{ sessionId: 'task' }, { sessionId: 'task' }],
    )
    expect([...ids].sort()).toEqual(['other', 'same', 'task'])
  })

  it('skips missing and blank Session ids', () => {
    const ids = hiddenSessionIds(
      [{ members: { member: { sessionId: '' } } }],
      [{}, { mainSessionId: '' }],
      [{ sessionId: '' }],
    )
    expect(ids.size).toBe(0)
  })

  it('returns an empty set when no source has Sessions', () => {
    expect(hiddenSessionIds([], [], []).size).toBe(0)
  })
})
