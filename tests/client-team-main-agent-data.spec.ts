import { describe, expect, it } from 'vitest'
import { panelProgressText, teamPanelView } from '../src/client/team-main-agent-data.js'
import type { TeamMemberSlot, TeamTask } from '../src/domain/types.js'
import type { TeamView } from '../src/transport/contracts.js'

const ISO = '2026-01-01T00:00:00.000Z'

function member(id: string, overrides: Partial<TeamMemberSlot> = {}): TeamMemberSlot {
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
    lastRuntimeState: 'idle',
    joinedAt: ISO,
    ...overrides,
  }
}

function task(
  id: string,
  status: TeamTask['status'],
  overrides: Partial<TeamTask> = {},
): TeamTask {
  return {
    id,
    title: id,
    description: '',
    status,
    dependencyIds: [],
    fileScopes: [],
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

function team(input: {
  members?: TeamMemberSlot[]
  tasks?: TeamTask[]
  leaderSlotId?: string
} = {}): TeamView {
  const members = Object.fromEntries((input.members ?? []).map(entry => [entry.id, entry]))
  return {
    schemaVersion: 2,
    id: 'team-panel',
    name: '面板团队',
    workspaceId: 'workspace-panel',
    workspacePath: '/tmp/panel',
    leaderSlotId: input.leaderSlotId ?? 'leader',
    state: 'active',
    directMemberChat: false,
    members,
    retiredSessions: {},
    tasks: Object.fromEntries((input.tasks ?? []).map(entry => [entry.id, entry])),
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
  }
}

describe('teamPanelView empty teams', () => {
  const view = teamPanelView(team())

  it('returns explicit zeros instead of undefined', () => {
    expect(view).toMatchObject({
      leaderName: '',
      memberCount: 0,
      taskTotal: 0,
      completed: 0,
      running: 0,
      waiting: 0,
      error: 0,
      approval: 0,
      blocked: 0,
      members: [],
    })
    expect(view.firstBlocker).toBeUndefined()
    expect(Object.values(view).every(value => value !== undefined)).toBe(true)
  })

  it('renders an empty progress line', () => {
    expect(panelProgressText(view)).toBe('已完成 0/0')
  })
})

describe('teamPanelView task progress', () => {
  it('counts running tasks even when every member is idle', () => {
    const view = teamPanelView(team({
      members: [member('leader', { role: 'leader' })],
      leaderSlotId: 'leader',
      tasks: [task('build', 'running', { ownerSlotId: 'leader' })],
    }))

    expect(view.running).toBe(1)
    expect(view.members[0]?.state).toBe('idle')
    expect(panelProgressText(view)).toContain('进行中 1')
  })

  it('counts a running member without a running task once', () => {
    const view = teamPanelView(team({
      members: [member('leader', { role: 'leader', lastRuntimeState: 'running' })],
      leaderSlotId: 'leader',
      tasks: [
        task('build', 'running', { ownerSlotId: 'leader' }),
        task('extra', 'assigned', { ownerSlotId: 'leader' }),
      ],
    }))

    expect(view.running).toBe(1)
  })

  it('separates waiting, blocked, error, and completed', () => {
    const view = teamPanelView(team({
      members: [member('leader', { role: 'leader' })],
      leaderSlotId: 'leader',
      tasks: [
        task('done', 'completed'),
        task('running', 'running'),
        task('blocked', 'blocked'),
        task('failed', 'failed'),
        task('cancelled', 'cancelled'),
        task('waiting', 'pending', { dependencyIds: ['running'] }),
        task('ready', 'assigned', { dependencyIds: ['done'] }),
      ],
    }))

    expect(view).toMatchObject({
      taskTotal: 7,
      completed: 1,
      running: 1,
      waiting: 1,
      blocked: 1,
      error: 2,
    })
    expect(panelProgressText(view)).toContain('阻塞 1')
    expect(panelProgressText(view)).toContain('异常 2')
  })
})

describe('teamPanelView blockers', () => {
  it('reports the first unresolved dependency title and its owner', () => {
    const view = teamPanelView(team({
      members: [member('leader', { role: 'leader' }), member('测试')],
      leaderSlotId: 'leader',
      tasks: [
        task('deploy', 'assigned', { title: '部署预发环境', ownerSlotId: '测试' }),
        task('verify', 'blocked', { dependencyIds: ['deploy'] }),
      ],
    }))

    expect(view.blocked).toBe(1)
    expect(view.firstBlocker).toEqual({ title: '部署预发环境', ownerName: '测试' })
  })

  it('skips a missing dependency and omits an absent owner', () => {
    const view = teamPanelView(team({
      tasks: [
        task('first', 'blocked', { dependencyIds: ['deleted'] }),
        task('second', 'blocked', { title: '上线', dependencyIds: ['prep'] }),
        task('prep', 'assigned', { title: '准备清单' }),
      ],
    }))

    expect(view.firstBlocker).toEqual({ title: '准备清单' })
    expect('ownerName' in (view.firstBlocker ?? {})).toBe(false)
  })

  it('keeps the blocked count even without a reachable dependency', () => {
    const view = teamPanelView(team({
      tasks: [task('blocked', 'blocked', { dependencyIds: ['deleted'] })],
    }))

    expect(view.blocked).toBe(1)
    expect(view.firstBlocker).toBeUndefined()
  })
})

describe('teamPanelView approvals', () => {
  it('counts only members waiting for approval', () => {
    const view = teamPanelView(team({
      members: [
        member('idle'),
        member('running', { lastRuntimeState: 'running' }),
        member('waiting', { lastRuntimeState: 'waiting_approval' }),
        member('error', { lastRuntimeState: 'error' }),
      ],
      tasks: [task('pending', 'pending', { dependencyIds: ['waiting'] })],
    }))

    expect(view.approval).toBe(1)
    expect(view.waiting).toBe(0)
  })
})

describe('teamPanelView members', () => {
  const longAgo = '2026-01-01T00:00:00.000Z'
  const recent = '2026-01-02T00:00:00.000Z'
  const latest = '2026-01-03T00:00:00.000Z'

  it('derives current task, completed/total, and at most three chips', () => {
    const view = teamPanelView(team({
      members: [member('leader', { role: 'leader', displayName: '小码' })],
      leaderSlotId: 'leader',
      tasks: [
        task('running-first', 'running', { title: '实现面板', ownerSlotId: 'leader', updatedAt: longAgo }),
        task('running-latest', 'running', { title: '联调', ownerSlotId: 'leader', updatedAt: latest }),
        task('assigned', 'assigned', { title: '补测试', ownerSlotId: 'leader', updatedAt: recent }),
        task('done', 'completed', { title: '调研', ownerSlotId: 'leader', updatedAt: longAgo }),
        task('done-two', 'completed', { title: '设计', ownerSlotId: 'leader', updatedAt: recent }),
        task('cancelled', 'cancelled', { title: '弃用', ownerSlotId: 'leader', updatedAt: longAgo }),
        task('other', 'running', { title: '别人的任务', ownerSlotId: 'someone-else' }),
      ],
    }))

    const entry = view.members[0]
    expect(entry).toMatchObject({
      id: 'leader',
      name: '小码',
      role: 'leader',
      model: 'deepseek-chat',
      state: 'idle',
      currentTask: { id: 'running-latest', title: '联调' },
      completed: 2,
      total: 6,
    })
    expect(entry?.chips.map(chip => chip.id)).toEqual(['running-latest', 'running-first', 'assigned'])
    expect(entry?.chips[0]).toMatchObject({ status: 'running', statusLabel: '进行中' })
  })

  it('falls back from running to assigned and then to no current task', () => {
    const assignedView = teamPanelView(team({
      members: [member('leader', { role: 'leader' })],
      leaderSlotId: 'leader',
      tasks: [task('assigned', 'assigned', { ownerSlotId: 'leader' })],
    }))
    expect(assignedView.members[0]?.currentTask).toEqual({ id: 'assigned', title: 'assigned' })

    const emptyView = teamPanelView(team({
      members: [member('leader', { role: 'leader' })],
      leaderSlotId: 'leader',
    }))
    expect(emptyView.members[0]?.currentTask).toBeUndefined()
    expect(emptyView.members[0]?.chips).toEqual([])
    expect(emptyView.members[0]?.completed).toBe(0)
    expect(emptyView.members[0]?.total).toBe(0)
  })

  it('uses a readable fallback for missing titles', () => {
    const view = teamPanelView(team({
      members: [member('leader', { role: 'leader' })],
      leaderSlotId: 'leader',
      tasks: [task('blank', 'running', { title: '   ', ownerSlotId: 'leader' })],
    }))

    expect(view.members[0]?.currentTask).toEqual({ id: 'blank', title: '未命名任务' })
    expect(view.members[0]?.chips[0]?.title).toBe('未命名任务')
  })

  it('orders members by memberOrder and exposes the Leader name', () => {
    const view = teamPanelView({
      ...team({
        members: [
          member('second', { joinedAt: '2026-01-02T00:00:00.000Z' }),
          member('leader', { role: 'leader', displayName: '当前 Leader' }),
        ],
        leaderSlotId: 'leader',
      }),
      memberOrder: ['leader', 'second'],
    })

    expect(view.leaderName).toBe('当前 Leader')
    expect(view.members.map(entry => entry.id)).toEqual(['leader', 'second'])
  })
})
