import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_GROUP_MAX_CHARS,
  UNGROUPED_PARTITION_ID,
  groupMembershipCandidates,
  groupMembershipChanges,
  insertGroupOrder,
  movedGroupOrder,
  resolveDropTarget,
  sidebarGroupNameError,
  sidebarPartitions,
  type SidebarGroupCandidate,
} from '../src/client/sidebar-groups.js'

interface Row {
  id: string
  name: string
  group?: string
}

const row = (id: string, group?: string): Row => ({ id, name: id, ...(group === undefined ? {} : { group }) })
const project = (value: Row): SidebarGroupCandidate => ({
  id: value.id,
  name: value.name,
  ...(value.group === undefined ? {} : { group: value.group }),
})
const labels = <T>(partitions: ReturnType<typeof sidebarPartitions<T>>): Array<string | undefined> =>
  partitions.map(partition => partition.group)
const ids = <T>(partitions: ReturnType<typeof sidebarPartitions<T>>): string[][] =>
  partitions.map(partition => partition.items.map(item => (item as unknown as Row).id))

describe('sidebarPartitions', () => {
  it('keeps one unlabelled partition when no group exists, so the list is untouched', () => {
    const partitions = sidebarPartitions([], [row('a'), row('b')], value => value.group)

    expect(partitions).toHaveLength(1)
    expect(partitions[0]?.group).toBeUndefined()
    expect(partitions[0]?.id).toBe(UNGROUPED_PARTITION_ID)
    expect(ids(partitions)).toEqual([['a', 'b']])
  })

  it('follows the Host order and puts the ungrouped rows last', () => {
    const items = [row('loose'), row('b1', 'b'), row('a1', 'a')]
    const partitions = sidebarPartitions(['a', 'b'], items, value => value.group)

    expect(labels(partitions)).toEqual(['a', 'b', undefined])
    expect(ids(partitions)).toEqual([['a1'], ['b1'], ['loose']])
    expect(partitions[0]?.id).toBe('group:a')
  })

  it('renders an empty group as its own section', () => {
    const partitions = sidebarPartitions(['a', 'empty'], [row('a1', 'a')], value => value.group)

    expect(labels(partitions)).toEqual(['a', 'empty'])
    expect(ids(partitions)).toEqual([['a1'], []])
  })

  it('drops an empty ungrouped section instead of leaving a bare header', () => {
    const partitions = sidebarPartitions(['a'], [row('a1', 'a')], value => value.group)

    expect(labels(partitions)).toEqual(['a'])
  })

  it('falls back to ungrouped when a row names a group the list lost', () => {
    const partitions = sidebarPartitions(['a'], [row('ghost', 'gone'), row('a1', 'a')], value => value.group)

    expect(ids(partitions)).toEqual([['a1'], ['ghost']])
  })

  it('keeps row order inside a partition', () => {
    const partitions = sidebarPartitions(['a'], [row('a1', 'a'), row('a2', 'a')], value => value.group)

    expect(ids(partitions)).toEqual([['a1', 'a2']])
  })
})

describe('groupMembershipCandidates', () => {
  it('offers the group members first, then every ungrouped row, and no other group', () => {
    const items = [
      row('member', 'work'),
      row('loose'),
      row('elsewhere', 'play'),
      row('member2', 'work'),
    ]

    expect(groupMembershipCandidates('work', items, project).map(candidate => candidate.id))
      .toEqual(['member', 'member2', 'loose'])
  })
})

describe('groupMembershipChanges', () => {
  const candidates = groupMembershipCandidates(
    'work',
    [row('member', 'work'), row('loose'), row('newcomer')],
    project,
  )

  it('submits nothing when the checklist is untouched', () => {
    expect(groupMembershipChanges('work', candidates, new Set(['member']))).toEqual({ add: [], remove: [] })
  })

  it('adds a newly ticked ungrouped row and removes an unticked member', () => {
    const changes = groupMembershipChanges('work', candidates, new Set(['newcomer']))

    expect(changes.add.map(candidate => candidate.id)).toEqual(['newcomer'])
    expect(changes.remove.map(candidate => candidate.id)).toEqual(['member'])
  })

  it('treats every unticked row as a removal from the group', () => {
    const changes = groupMembershipChanges('work', candidates, new Set())

    expect(changes.add).toEqual([])
    expect(changes.remove.map(candidate => candidate.id)).toEqual(['member'])
  })
})

describe('movedGroupOrder', () => {
  it('swaps one group with its neighbour', () => {
    expect(movedGroupOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(movedGroupOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
  })

  it('returns the same order at either end or for an unknown group', () => {
    expect(movedGroupOrder(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
    expect(movedGroupOrder(['a', 'b'], 'b', 1)).toEqual(['a', 'b'])
    expect(movedGroupOrder(['a', 'b'], 'gone', 1)).toEqual(['a', 'b'])
  })
})

describe('resolveDropTarget', () => {
  it('assigns a row dropped on the ungrouped header', () => {
    expect(resolveDropTarget('row', 'ungrouped', 'after')).toEqual({ kind: 'assign', ungrouped: true })
  })

  it('assigns a row dropped on a named group header, on either half', () => {
    expect(resolveDropTarget('row', 'group', 'before')).toEqual({ kind: 'assign', ungrouped: false })
    expect(resolveDropTarget('row', 'group', 'after')).toEqual({ kind: 'assign', ungrouped: false })
  })

  it('inserts a dragged group on the hovered half of another header', () => {
    expect(resolveDropTarget('group', 'group', 'before')).toEqual({ kind: 'insert', half: 'before' })
    expect(resolveDropTarget('group', 'group', 'after')).toEqual({ kind: 'insert', half: 'after' })
  })

  it('reports none for every invalid combination', () => {
    // Rows carry no order field, so a row never reorders anything.
    expect(resolveDropTarget('row', 'row', 'before')).toEqual({ kind: 'none' })
    // The ungrouped header is not a group in the list: it cannot be reordered onto.
    expect(resolveDropTarget('group', 'ungrouped', 'after')).toEqual({ kind: 'none' })
    expect(resolveDropTarget('group', 'row', 'before')).toEqual({ kind: 'none' })
    expect(resolveDropTarget(undefined, 'group', 'after')).toEqual({ kind: 'none' })
    expect(resolveDropTarget('row', 'none', 'after')).toEqual({ kind: 'none' })
  })
})

describe('insertGroupOrder', () => {
  it('inserts before or after the target after leaving the old slot', () => {
    expect(insertGroupOrder(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(insertGroupOrder(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c'])
    // Moving down past a neighbour lands in the same place as moving it up.
    expect(insertGroupOrder(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
  })

  it('returns the same order for a no-op or an unknown label', () => {
    expect(insertGroupOrder(['a', 'b'], 'a', 'a', 'before')).toEqual(['a', 'b'])
    expect(insertGroupOrder(['a', 'b'], 'a', 'b', 'before')).toEqual(['a', 'b'])
    expect(insertGroupOrder(['a', 'b'], 'gone', 'a', 'after')).toEqual(['a', 'b'])
    expect(insertGroupOrder(['a', 'b'], 'a', 'gone', 'after')).toEqual(['a', 'b'])
  })
})

describe('sidebarGroupNameError', () => {
  it('refuses empty, over-long and duplicate labels', () => {
    expect(sidebarGroupNameError('   ', [])).toBe('分组名不能为空')
    expect(sidebarGroupNameError('x'.repeat(SIDEBAR_GROUP_MAX_CHARS + 1), [])).not.toBeUndefined()
    expect(sidebarGroupNameError('工作', ['工作'])).toBe('已存在同名分组')
    expect(sidebarGroupNameError('工作', ['别的'])).toBeUndefined()
    // The bound itself is allowed.
    expect(sidebarGroupNameError('x'.repeat(SIDEBAR_GROUP_MAX_CHARS), [])).toBeUndefined()
  })
})
