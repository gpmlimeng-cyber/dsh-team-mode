import { describe, expect, it } from 'vitest'
import { hiddenSessionIds } from '../src/client/session-rows.js'
import { teamRosterRows } from '../src/client/team-sidebar-data.js'
import type { TeamView } from '../src/transport/contracts.js'

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

  it('hides Leader Sessions retired by an explicit handoff', () => {
    const ids = hiddenSessionIds(
      [
        {
          members: { leader: { sessionId: 'team-leader' } },
          retiredLeaderSessionIds: ['old-leader', ''],
        },
        { members: { leader: { sessionId: 'other-leader' } }, retiredLeaderSessionIds: ['old-leader'] },
      ],
      [],
      [],
    )
    // Blank entries are skipped and cross-team duplicates collapse to one row.
    expect([...ids].sort()).toEqual(['old-leader', 'other-leader', 'team-leader'])
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

describe('sidebar roster stays outside the native Session list', () => {
  const ISO = '2026-01-01T00:00:00.000Z'

  function member(id: string): Record<string, unknown> {
    return {
      id,
      assistantId: `assistant-${id}`,
      displayName: id,
      role: 'member',
      assistantSnapshot: {
        assistantId: `assistant-${id}`,
        revision: 1,
        name: id,
        instructions: '',
        provider: 'deepseek',
        model: 'deepseek-chat',
        agentPresetId: 'default',
        permissionPresetId: 'default',
        skillAllowlist: [],
        mcpServers: [],
        prompts: [],
      },
      permissionPresetId: 'default',
      sessionId: `session-${id}`,
      desiredState: 'online',
      lastRuntimeState: 'running',
      joinedAt: ISO,
    }
  }

  it('renders every roster Session that the hider already removed from native rows', () => {
    // The roster is the only sidebar entry to a member Session: adding rows must
    // not resurrect a native duplicate (SessionRowHider unchanged).
    const team = {
      id: 'team-1',
      name: '测试团队',
      members: Object.fromEntries(['leader', 'a'].map(id => [id, member(id)])),
      tasks: {},
    } as unknown as TeamView
    const roster = teamRosterRows(team)
    const hidden = hiddenSessionIds([team], [], [])
    expect(roster.map(row => row.sessionId)).toEqual(['session-leader', 'session-a'])
    expect(roster.filter(row => !hidden.has(row.sessionId))).toEqual([])
  })
})
