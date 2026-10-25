import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TeamGoal, TeamTask } from '../src/domain/types.js'
import type { TeamView } from '../src/transport/contracts.js'
import {
  filterGoalGroups,
  GOAL_FILTER_ALL,
  GOAL_FILTER_UNGROUPED,
  GOAL_TASK_RENDER_LIMIT,
  goalModeLabel,
  goalStatusLabel,
  hasTeamGoals,
  taskDependencyView,
  teamGoalGroups,
} from '../src/client/labels.js'

const liveState = vi.hoisted(() => ({
  current: null as null | {
    teams: unknown[]
    catalog: undefined
    assistants: unknown[]
    load: () => Promise<void>
  },
}))

vi.mock('../src/client/components.js', () => ({
  useAgentTeamData: () => liveState.current,
}))

// The shipped primitives package expects browser peers (clsx) that this node
// test does not install; the live view assertions target the Goal UI, which
// uses plain <button>/<section> elements, so stub the primitives.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (): null => null
  return {
    Button: Stub,
    IconAgentPresetOutlineRegular: Stub,
    IconArchiveOutlineMedium: Stub,
    IconArchiveOutlineRegular: Stub,
    IconBranchOutlineRegular: Stub,
    IconChecklistOutlineRegular: Stub,
    IconChevronDownOutlineRegular: Stub,
    IconChevronLeftOutlineRegular: Stub,
    IconChevronRightOutlineRegular: Stub,
    IconChevronsUpDownOutlineRegular: Stub,
    IconClockOutlineRegular: Stub,
    IconCloseFillRegular: Stub,
    IconCloseOutlineRegular: Stub,
    IconEditOutlineRegular: Stub,
    IconEllipsisOutlineRegular: Stub,
    IconFolderCloseRegular: Stub,
    IconFolderOpenOutlineRegular: Stub,
    IconFolderOpenRegular: Stub,
    IconLoadingOutlineRegular: Stub,
    IconNewChatOutlineRegular: Stub,
    IconPaperclipOutlineRegular: Stub,
    IconPinFillRegular: Stub,
    IconPinOutlineRegular: Stub,
    IconPlusOutlineRegular: Stub,
    IconProjectAddOutlineRegular: Stub,
    IconRefreshOutlineRegular: Stub,
    IconRightUpOutlineRegular: Stub,
    IconSearchOutlineRegular: Stub,
    IconSendOutlineRegular: Stub,
    IconSlidersTwoOutlineRegular: Stub,
    IconSparkleRegular: Stub,
    IconStopFillRegular: Stub,
    IconThinkOutlineRegular: Stub,
    IconUsersOutlineRegular: Stub,
    IconWarningOutlineRegular: Stub,
    IconWarningTriangleOutlineRegular: Stub,
    Input: Stub,
    MarkdownText: Stub,
    Menu: Stub,
    Modal: Stub,
    Tag: Stub,
    Tooltip: Stub,
    UserTextRun: Stub
  }
})

import { TeamManageView } from '../src/client/team-manage.js'

const NOW = '2026-01-01T00:00:00.000Z'

function goal(overrides: Partial<TeamGoal> & Pick<TeamGoal, 'id'>): TeamGoal {
  return {
    teamId: 'team-1',
    title: `Goal ${overrides.id}`,
    objective: `Objective ${overrides.id}`,
    acceptance: '',
    mode: 'single',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function task(overrides: Partial<TeamTask> & Pick<TeamTask, 'id'>): TeamTask {
  return {
    title: `Task ${overrides.id}`,
    description: '',
    status: 'pending',
    dependencyIds: [],
    fileScopes: [],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('Goal client helpers', () => {
  it('detects a legacy team that never created a Goal', () => {
    expect(hasTeamGoals({})).toBe(false)
    expect(hasTeamGoals({ goals: {} })).toBe(false)
    expect(hasTeamGoals({ goals: { g1: goal({ id: 'g1' }) } })).toBe(true)
    expect(teamGoalGroups({ goals: undefined, tasks: { t1: task({ id: 't1' }) } })).toEqual([])
  })

  it('groups tasks under Goals and keeps ungrouped tasks in a trailing bucket', () => {
    const groups = teamGoalGroups({
      goals: {
        g1: goal({ id: 'g1', title: 'First', mode: 'orchestrated', acceptance: 'Ship it' }),
        g2: goal({ id: 'g2', title: 'Empty goal' }),
      },
      tasks: {
        t1: task({ id: 't1', goalId: 'g1', status: 'completed' }),
        t2: task({ id: 't2', goalId: 'g1', status: 'running' }),
        t3: task({ id: 't3', goalId: 'g1', status: 'assigned' }),
        t4: task({ id: 't4', goalId: 'g1', status: 'blocked' }),
        t5: task({ id: 't5' }),
        t6: task({ id: 't6', goalId: 'missing-goal' }),
      },
    })
    expect(groups.map(group => group.id)).toEqual(['g1', 'g2', GOAL_FILTER_UNGROUPED])
    const first = groups[0]!
    expect(first.goal?.title).toBe('First')
    expect(first.total).toBe(4)
    expect(first.completed).toBe(1)
    expect(first.running).toBe(1)
    expect(first.assigned).toBe(1)
    expect(first.blocked).toBe(1)
    expect(first.completionRate).toBe(0.25)
    expect(first.tasks.map(item => item.id)).toEqual(['t1', 't2', 't3', 't4'])
    expect(groups[1]!.total).toBe(0)
    expect(groups[2]!.tasks.map(item => item.id)).toEqual(['t5', 't6'])
  })

  it('orders active Goals before completed and cancelled ones', () => {
    const groups = teamGoalGroups({
      goals: {
        cancelled: goal({ id: 'cancelled', status: 'cancelled', createdAt: '2025-01-01T00:00:00.000Z' }),
        done: goal({ id: 'done', status: 'completed', createdAt: '2025-01-02T00:00:00.000Z' }),
        activeLate: goal({ id: 'activeLate', createdAt: '2025-01-03T00:00:00.000Z' }),
        activeEarly: goal({ id: 'activeEarly', createdAt: '2025-01-01T12:00:00.000Z' }),
      },
      tasks: {},
    })
    expect(groups.map(group => group.id)).toEqual(['activeEarly', 'activeLate', 'done', 'cancelled'])
  })

  it('filters to one Goal, the ungrouped bucket, or everything', () => {
    const groups = teamGoalGroups({
      goals: { g1: goal({ id: 'g1' }) },
      tasks: {
        grouped: task({ id: 'grouped', goalId: 'g1' }),
        loose: task({ id: 'loose' }),
      },
    })
    expect(filterGoalGroups(groups, GOAL_FILTER_ALL)).toHaveLength(2)
    expect(filterGoalGroups(groups, 'g1').map(group => group.id)).toEqual(['g1'])
    expect(filterGoalGroups(groups, GOAL_FILTER_UNGROUPED).map(group => group.id))
      .toEqual([GOAL_FILTER_UNGROUPED])
    expect(filterGoalGroups(groups, 'missing')).toEqual([])
  })

  it('resolves dependency edges and blocked state against the live board', () => {
    const tasks = {
      root: task({ id: 'root', status: 'running' }),
      waiting: task({ id: 'waiting', status: 'pending', dependencyIds: ['root'] }),
      finished: task({ id: 'finished', status: 'completed' }),
      done: task({ id: 'done', status: 'completed', dependencyIds: ['finished'] }),
      dependent: task({ id: 'dependent', status: 'pending', dependencyIds: ['root'] }),
      blocked: task({ id: 'blocked', status: 'blocked' }),
      missing: task({ id: 'missing', dependencyIds: ['ghost'] }),
    }
    const rootView = taskDependencyView({ tasks }, tasks.root)
    expect(rootView.waitingOn).toEqual([])
    expect(rootView.blocks.map(item => item.id)).toEqual(['waiting', 'dependent'])
    expect(rootView.isBlocked).toBe(false)
    const waitingView = taskDependencyView({ tasks }, tasks.waiting)
    expect(waitingView.waitingOn.map(item => item.id)).toEqual(['root'])
    expect(waitingView.isBlocked).toBe(true)
    expect(taskDependencyView({ tasks }, tasks.blocked).isBlocked).toBe(true)
    expect(taskDependencyView({ tasks }, tasks.done).waitingOn).toEqual([])
    expect(taskDependencyView({ tasks }, tasks.missing).waitingOn).toEqual([
      { id: 'ghost', title: '未知任务', status: 'unknown' },
    ])
  })

  it('keeps rendering caps and Goal labels available to the UI', () => {
    expect(GOAL_TASK_RENDER_LIMIT).toBeGreaterThan(0)
    expect(goalModeLabel('orchestrated')).toBe('编排')
    expect(goalModeLabel('unknown')).toBe('unknown')
    expect(goalStatusLabel('completed')).toBe('已完成')
    // The epoch transition pauses active Goals; the badge has to name the state.
    expect(goalStatusLabel('paused')).toBe('已暂停')
    expect(goalStatusLabel('unknown')).toBe('unknown')
  })
})


describe('live registered team view', () => {
  it('renders Goal cards, the mixed Goal+ungrouped board and dependency state through TeamManageView', () => {
    const leader = {
      id: 'slot-leader',
      assistantId: 'assistant-1',
      displayName: 'Leader',
      role: 'leader' as const,
      assistantSnapshot: {
        provider: 'openai',
        model: 'codex',
        agentPresetId: 'default',
        permissionPresetId: 'standard',
        skillAllowlist: [],
        mcpServers: [],
        prompts: [],
      },
      permissionPresetId: 'standard',
      sessionId: 'session-live',
      desiredState: 'online' as const,
      lastRuntimeState: 'idle' as const,
      joinedAt: NOW,
    }
    const team = {
      schemaVersion: 2,
      id: 'team-live',
      name: 'Live goal team',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/live-workspace',
      leaderSlotId: 'slot-leader',
      state: 'active',
      directMemberChat: true,
      // A changed Leader means a new epoch; the card shows it without session ids.
      epoch: 2,
      members: { 'slot-leader': leader },
      retiredSessions: {},
      tasks: {
        first: task({ id: 'first', goalId: 'live-goal', status: 'completed' }),
        second: task({ id: 'second', goalId: 'live-goal', status: 'running', dependencyIds: ['loose'] }),
        loose: task({ id: 'loose', status: 'pending' }),
      },
      goals: {
        'live-goal': goal({
          id: 'live-goal',
          teamId: 'team-live',
          title: 'Live Goal',
          objective: 'Show the live board',
          acceptance: 'Ship it',
          mode: 'orchestrated',
        }),
      },
      leases: {},
      outbox: {},
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as TeamView
    liveState.current = { teams: [team], catalog: undefined, assistants: [], load: async () => {} }

    const markup = renderToStaticMarkup(createElement(TeamManageView, { sessionId: 'session-live' }))

    expect(markup).toContain('团队目标')
    expect(markup).toContain('Live Goal')
    expect(markup).toContain('编排')
    expect(markup).toContain('验收：Ship it')
    expect(markup).toContain('1 个 · 点击目标筛选任务')
    expect(markup).not.toContain('还有 1 个')
    expect(markup).toContain('未归入目标 · 1')
    expect(markup).toContain('等待依赖')
    expect(markup).toContain('阻塞 1 项后续任务')
    // The team namespace resolves Chinese regardless of the shell locale; the
    // point is that the epoch is visible and the Session id never is.
    expect(markup).toContain('纪元 2')
    expect(markup).not.toContain('session-live')
  })
})
