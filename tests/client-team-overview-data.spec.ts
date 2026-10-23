import { describe, expect, it } from 'vitest'
import type { TeamMessage, TeamTask } from '../src/domain/types.js'
import {
  defaultBoardMode,
  dependencyGraph,
  leaderInbox,
  pickOverviewTask,
} from '../src/client/team-overview-data.js'

const BASE = '2026-01-01T00:00:00.000Z'
const LEADER = 'leader-1'

function task(id: string, overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id,
    title: `任务 ${id}`,
    description: '',
    status: 'pending',
    dependencyIds: [],
    fileScopes: [],
    revision: 1,
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides,
  }
}

function message(id: string, overrides: Partial<TeamMessage> = {}): TeamMessage {
  return {
    schemaVersion: 1,
    id,
    teamId: 'team-1',
    sender: { kind: 'member', id: 'worker' },
    recipient: { kind: 'leader', slotId: LEADER },
    type: 'progress',
    content: `内容 ${id}`,
    attachments: [],
    readBy: [],
    deliveryState: 'delivered',
    idempotencyKey: `key-${id}`,
    createdAt: BASE,
    ...overrides,
  }
}

function ids(entries: ReadonlyArray<{ id: string }>): string[] {
  return entries.map(entry => entry.id)
}

function layerIds(graph: ReturnType<typeof dependencyGraph>): Array<{ depth: number; ids: string[] }> {
  return graph.layers.map(layer => ({ depth: layer.depth, ids: ids(layer.tasks) }))
}

describe('defaultBoardMode', () => {
  it('defaults to tasks for an empty board', () => {
    expect(defaultBoardMode([])).toBe('tasks')
  })

  it.each(['overview', 'tasks'] as const)('keeps a stored %s preference', stored => {
    expect(defaultBoardMode([task('a', { status: 'running' })], stored)).toBe(stored)
    expect(defaultBoardMode([], stored)).toBe(stored)
  })

  it('ignores an unknown stored value and derives the default', () => {
    expect(defaultBoardMode([task('a', { status: 'running' })], 'board')).toBe('overview')
    expect(defaultBoardMode([], '')).toBe('tasks')
  })

  it.each(['running', 'blocked', 'failed'] as const)(
    'opens the overview when a %s task exists',
    status => {
      expect(defaultBoardMode([task('a'), task('b', { status })])).toBe('overview')
    },
  )

  it.each(['pending', 'assigned', 'completed', 'cancelled'] as const)(
    'stays on tasks when only %s tasks exist',
    status => {
      expect(defaultBoardMode([task('a', { status })])).toBe('tasks')
    },
  )
})

describe('dependencyGraph', () => {
  it('returns empty layers for an empty board without undefined', () => {
    expect(dependencyGraph([])).toEqual({ layers: [], unlayered: [] })
  })

  it('layers a chain by dependency depth', () => {
    const graph = dependencyGraph([
      task('c', { dependencyIds: ['b'], updatedAt: '2026-01-01T03:00:00.000Z' }),
      task('b', { dependencyIds: ['a'], updatedAt: '2026-01-01T02:00:00.000Z' }),
      task('a', { updatedAt: '2026-01-01T01:00:00.000Z' }),
    ])

    expect(layerIds(graph)).toEqual([
      { depth: 0, ids: ['a'] },
      { depth: 1, ids: ['b'] },
      { depth: 2, ids: ['c'] },
    ])
    expect(graph.unlayered).toEqual([])
  })

  it('puts a split on the same layer and orders it by updatedAt desc then id', () => {
    const graph = dependencyGraph([
      task('root', { updatedAt: '2026-01-01T01:00:00.000Z' }),
      task('old', {
        dependencyIds: ['root'],
        updatedAt: '2026-01-01T01:30:00.000Z',
      }),
      task('new', {
        dependencyIds: ['root'],
        updatedAt: '2026-01-01T02:00:00.000Z',
      }),
      task('root-b', { updatedAt: '2026-01-01T01:15:00.000Z' }),
    ])

    expect(layerIds(graph)).toEqual([
      { depth: 0, ids: ['root-b', 'root'] },
      { depth: 1, ids: ['new', 'old'] },
    ])
  })

  it('orders a layer chronologically across ISO offsets', () => {
    const graph = dependencyGraph([
      task('utc', { updatedAt: '2026-01-01T03:00:00.000Z' }),
      task('shanghai', { updatedAt: '2026-01-01T10:00:00.000+08:00' }),
    ])

    expect(layerIds(graph)).toEqual([{ depth: 0, ids: ['utc', 'shanghai'] }])
  })

  it('takes the deepest dependency for a task with multiple dependencies', () => {
    const graph = dependencyGraph([
      task('a'),
      task('b', { dependencyIds: ['a'] }),
      task('c', { dependencyIds: ['a', 'b'] }),
    ])

    expect(layerIds(graph)).toEqual([
      { depth: 0, ids: ['a'] },
      { depth: 1, ids: ['b'] },
      { depth: 2, ids: ['c'] },
    ])
  })

  it('keeps unknown dependency ids and their dependents in unlayered', () => {
    const graph = dependencyGraph([
      task('alone', { dependencyIds: ['deleted-task', 'other-team-task'] }),
      task('downstream', { dependencyIds: ['alone'] }),
      task('free'),
    ])

    expect(layerIds(graph)).toEqual([{ depth: 0, ids: ['free'] }])
    expect(ids(graph.unlayered)).toEqual(['alone', 'downstream'])
  })

  it('keeps cycle members and their dependents in unlayered', () => {
    const graph = dependencyGraph([
      task('a', { status: 'running', dependencyIds: ['b'], updatedAt: '2026-01-01T04:00:00.000Z' }),
      task('b', { status: 'running', dependencyIds: ['a'], updatedAt: '2026-01-01T03:00:00.000Z' }),
      task('c', { dependencyIds: ['a'], updatedAt: '2026-01-01T02:00:00.000Z' }),
      task('free', { updatedAt: '2026-01-01T01:00:00.000Z' }),
    ])

    expect(layerIds(graph)).toEqual([{ depth: 0, ids: ['free'] }])
    expect(ids(graph.unlayered)).toEqual(['a', 'b', 'c'])
  })

  it('treats a self dependency as a cycle', () => {
    const graph = dependencyGraph([
      task('self', { dependencyIds: ['self'] }),
      task('free'),
    ])

    expect(layerIds(graph)).toEqual([{ depth: 0, ids: ['free'] }])
    expect(ids(graph.unlayered)).toEqual(['self'])
  })

  it('does not drop duplicate dependency ids or duplicate tasks', () => {
    const graph = dependencyGraph([
      task('root'),
      task('child', { dependencyIds: ['root', 'root'] }),
    ])

    expect(layerIds(graph)).toEqual([
      { depth: 0, ids: ['root'] },
      { depth: 1, ids: ['child'] },
    ])
    expect(graph.unlayered).toEqual([])
  })

  it('keeps every task exactly once across layers and unlayered', () => {
    const tasks = [
      task('a', { dependencyIds: ['b'] }),
      task('b', { dependencyIds: ['a'] }),
      task('c', { dependencyIds: ['a'] }),
      task('d'),
      task('e', { dependencyIds: ['d'] }),
    ]
    const graph = dependencyGraph(tasks)
    const kept = [...graph.layers.flatMap(layer => ids(layer.tasks)), ...ids(graph.unlayered)].sort()

    expect(kept).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('leaderInbox', () => {
  it('returns an empty list for no messages', () => {
    expect(leaderInbox([], LEADER)).toEqual([])
  })

  it('keeps only Leader-addressed, non-system messages for this leader slot', () => {
    const inbox = leaderInbox([
      message('for-leader', { createdAt: '2026-01-01T01:00:00.000Z' }),
      message('implicit-leader', {
        recipient: { kind: 'leader' },
        type: 'result',
        createdAt: '2026-01-01T03:00:00.000Z',
      }),
      message('system', { type: 'system', createdAt: '2026-01-01T05:00:00.000Z' }),
      message('other-leader', {
        recipient: { kind: 'leader', slotId: 'leader-2' },
        createdAt: '2026-01-01T05:00:00.000Z',
      }),
      message('broadcast', {
        recipient: { kind: 'broadcast' },
        createdAt: '2026-01-01T05:00:00.000Z',
      }),
      message('member', {
        recipient: { kind: 'member', slotId: 'worker' },
        createdAt: '2026-01-01T05:00:00.000Z',
      }),
      message('warning', { type: 'warning', createdAt: '2026-01-01T02:00:00.000Z' }),
    ], LEADER)

    expect(ids(inbox)).toEqual(['implicit-leader', 'warning', 'for-leader'])
  })

  it('orders ties by id and defaults to the latest five', () => {
    const inbox = leaderInbox([
      message('a'),
      message('b'),
      message('c'),
      message('d'),
      message('e'),
      message('f'),
      message('g'),
      message('h', { createdAt: '2026-01-01T09:00:00.000Z' }),
    ], LEADER)

    expect(ids(inbox)).toEqual(['h', 'a', 'b', 'c', 'd'])
  })

  it('honours an explicit limit without mutating the input', () => {
    const messages = [
      message('old', { createdAt: '2026-01-01T01:00:00.000Z' }),
      message('new', { createdAt: '2026-01-01T02:00:00.000Z' }),
      message('middle', { createdAt: '2026-01-01T01:30:00.000Z' }),
    ]
    const snapshot = ids(messages)

    expect(ids(leaderInbox(messages, LEADER, 2))).toEqual(['new', 'middle'])
    expect(ids(messages)).toEqual(snapshot)
  })

  it('returns nothing for a non-positive limit', () => {
    expect(leaderInbox([message('a')], LEADER, 0)).toEqual([])
    expect(leaderInbox([message('a')], LEADER, -1)).toEqual([])
  })
})

describe('pickOverviewTask', () => {
  it('returns undefined for an empty board', () => {
    expect(pickOverviewTask([])).toBeUndefined()
  })

  it('keeps a selected task while it still exists', () => {
    const selected = task('selected', {
      status: 'completed',
      updatedAt: '2026-01-01T01:00:00.000Z',
    })
    expect(pickOverviewTask([task('newer', { status: 'running' }), selected], 'selected')).toBe(selected)
  })

  it('falls back to the first running task when the selected task is gone', () => {
    const running = task('running', {
      status: 'running',
      updatedAt: '2026-01-01T01:00:00.000Z',
    })
    const tasks = [task('newest-failed', { status: 'failed' }), running]

    expect(pickOverviewTask(tasks, 'deleted')).toBe(running)
  })

  it('falls back to the most recent task when nothing is running', () => {
    const newest = task('newest', {
      status: 'pending',
      updatedAt: '2026-01-01T05:00:00.000Z',
    })
    const tasks = [
      task('older', { status: 'blocked', updatedAt: '2026-01-01T02:00:00.000Z' }),
      newest,
    ]

    expect(pickOverviewTask(tasks, 'deleted')).toBe(newest)
  })

  it('orders equal updatedAt values by id', () => {
    expect(pickOverviewTask([task('b'), task('a')])?.id).toBe('a')
  })
})