import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  groupCreateRows,
  groupCreateSelection,
  toggleGroupCreateSelection,
  type GroupCreateRow,
} from '../src/client/sidebar-groups.js'

interface Row {
  id: string
  name: string
  group?: string
  avatar?: string
}

const row = (id: string, group?: string, avatar?: string): Row => ({
  id,
  name: id,
  ...(group === undefined ? {} : { group }),
  ...(avatar === undefined ? {} : { avatar }),
})
const project = (value: Row): Omit<GroupCreateRow, 'kind'> => ({
  id: value.id,
  name: value.name,
  ...(value.group === undefined ? {} : { group: value.group }),
  ...(value.avatar === undefined ? {} : { avatar: value.avatar }),
})

function readClientSource(name: string): string {
  return readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
}

describe('groupCreateRows', () => {
  it('lists every team and assistant, already grouped ones included', () => {
    const rows = groupCreateRows(
      [row('team-a', '已有一个分组'), row('team-b')],
      [row('assistant-a', undefined, 'data:image/png;base64,x')],
      project,
      project,
    )

    expect(rows.teams.map(item => item.id)).toEqual(['team-a', 'team-b'])
    expect(rows.assistants.map(item => item.id)).toEqual(['assistant-a'])
    expect(rows.teams.every(item => item.kind === 'team')).toBe(true)
    expect(rows.assistants.every(item => item.kind === 'assistant')).toBe(true)
  })

  it('keeps the current group as the row subtitle and the avatar when there is one', () => {
    const rows = groupCreateRows(
      [row('team-a', '已有一个分组')],
      [row('assistant-a', undefined, 'data:image/png;base64,x')],
      project,
      project,
    )

    expect(rows.teams[0]).toMatchObject({ id: 'team-a', group: '已有一个分组' })
    expect(rows.assistants[0]).toMatchObject({ id: 'assistant-a', avatar: 'data:image/png;base64,x' })
    expect(rows.teams[0]?.group).toBeDefined()
    expect(rows.assistants[0]?.group).toBeUndefined()
  })
})

describe('toggleGroupCreateSelection', () => {
  it('adds and removes exactly one id without mutating the previous set', () => {
    const empty = new Set<string>()
    const added = toggleGroupCreateSelection(empty, 'team-a')
    const both = toggleGroupCreateSelection(added, 'assistant-a')
    const removed = toggleGroupCreateSelection(both, 'team-a')

    expect([...empty]).toEqual([])
    expect([...added]).toEqual(['team-a'])
    expect([...both].sort()).toEqual(['assistant-a', 'team-a'])
    expect([...removed]).toEqual(['assistant-a'])
  })
})

describe('groupCreateSelection', () => {
  const rows = groupCreateRows(
    [row('team-a'), row('team-b')],
    [row('assistant-a'), row('assistant-b')],
    project,
    project,
  )

  it('splits the picked rows into the two write lists, in list order', () => {
    const plan = groupCreateSelection(rows, new Set(['assistant-b', 'team-b']))

    expect(plan).toEqual({ teamIds: ['team-b'], assistantIds: ['assistant-b'] })
  })

  it('submits an empty selection as a valid empty group', () => {
    expect(groupCreateSelection(rows, new Set())).toEqual({ teamIds: [], assistantIds: [] })
  })
})

describe('one create-group entry', () => {
  it('renders the trailing create row only in the 单聊 section', () => {
    const assistant = readClientSource('assistant-sidebar.tsx')
    const team = readClientSource('sidebar.tsx')

    expect(assistant).toContain('<SidebarGroupCreateRow')
    expect(team).not.toContain('<SidebarGroupCreateRow')
  })
})

describe('create-group dialog source contract', () => {
  const source = readClientSource('sidebar-group-ui.tsx')
  const dialog = source.slice(
    source.indexOf('function GroupCreateDialog'),
    source.indexOf('function GroupDeleteDialog'),
  )

  it('offers the name field, the intro, both lists and the footer actions', () => {
    expect(dialog).toContain('title="新建分组"')
    expect(dialog).toContain('创建空分组，或把现有的团队/助手移进来。移动只影响侧栏排列，不影响它们本身。')
    expect(dialog).toContain('现有团队')
    expect(dialog).toContain('现有助手')
    expect(dialog).toContain('>取消<')
    expect(dialog).toContain('创建分组')
    // The initial focus is the name field.
    expect(dialog).toContain('data-modal-autofocus')
  })

  it('uses the shipped Checkbox and marks the current group', () => {
    expect(dialog).toContain('<Checkbox')
    expect(dialog).toContain('当前分组：')
  })

  it('creates the group first, then moves the picked rows one by one', () => {
    const create = dialog.indexOf("callAgentTeam('sidebar.groups.create'")
    const teamMove = dialog.indexOf("callAgentTeam('team.group.set'")
    const assistantMove = dialog.indexOf("callAgentTeam('assistant.instance.update'")

    expect(create).toBeGreaterThan(-1)
    expect(teamMove).toBeGreaterThan(create)
    expect(assistantMove).toBeGreaterThan(teamMove)
    // A failed row names itself instead of being skipped silently.
    expect(dialog).toContain('failed.push({ name:')
  })
})
