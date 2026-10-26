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
  taskCarriesVerdict,
  taskDependencyView,
  taskKindLabel,
  taskScheduleEntries,
  taskScheduleSummary,
  taskVerdictLabel,
  taskVerdictTone,
  TEAM_TASK_CREATE_HINT,
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
import { TeamOverview } from '../src/client/team-overview.js'

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

  it('states on the manage board that tasks come from the Leader, and shows the verdict', () => {
    const team = {
      schemaVersion: 2,
      id: 'team-review',
      name: 'Review team',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/review-workspace',
      leaderSlotId: 'slot-leader',
      state: 'active',
      directMemberChat: true,
      epoch: 1,
      members: {
        'slot-leader': {
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
          sessionId: 'session-review',
          desiredState: 'online' as const,
          lastRuntimeState: 'idle' as const,
          joinedAt: NOW,
        },
      },
      retiredSessions: {},
      tasks: {
        review: task({ id: 'review', kind: 'review', status: 'completed', verdict: 'pass', goalId: 'g1' }),
      },
      goals: { g1: goal({ id: 'g1', title: 'Review goal' }) },
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as TeamView
    liveState.current = { teams: [team], catalog: undefined, assistants: [], load: async () => {} }

    const markup = renderToStaticMarkup(createElement(TeamManageView, { sessionId: 'session-review' }))
    // A human create control would post nothing; the board says so instead.
    expect(markup).toContain(TEAM_TASK_CREATE_HINT)
    expect(markup).toContain('审核')
    expect(markup).toContain('通过')
  })
})

/** The detail panel is the last right-column panel, before 收件箱. */
function detailRegion(markup: string): string {
  const start = markup.indexOf('data-overview-region="task-detail"')
  if (start < 0) throw new Error('task detail region missing from markup')
  const inbox = markup.indexOf('aria-label="Leader 收件箱"', start)
  return inbox < 0 ? markup.slice(start) : markup.slice(start, inbox)
}

function overviewTeam(
  tasks: Record<string, TeamTask>,
  goals: Record<string, TeamGoal> = {},
): TeamView {
  return {
    schemaVersion: 2,
    id: 'team-detail',
    name: '详情团队',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/detail-workspace',
    leaderSlotId: 'leader',
    state: 'active',
    directMemberChat: true,
    epoch: 1,
    members: {
      leader: {
        id: 'leader',
        displayName: 'Leader',
        role: 'leader',
        sessionId: 'session-leader',
        assistantSnapshot: { provider: 'openai', model: 'codex' },
      },
      engineer: {
        id: 'engineer',
        displayName: '实现者',
        role: 'member',
        sessionId: 'session-engineer',
        assistantSnapshot: { provider: 'openai', model: 'codex' },
      },
    },
    retiredSessions: {},
    tasks,
    goals,
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as TeamView
}

function renderDetail(team: TeamView, selectedTaskId: string): string {
  return detailRegion(renderToStaticMarkup(createElement(TeamOverview, {
    team,
    tasks: Object.values(team.tasks),
    messages: [],
    selectedTaskId,
    onSelectTask: () => undefined,
    onOpenSession: () => undefined,
  })))
}

describe('task detail helpers', () => {
  it('labels the task kind and reads a legacy row as work', () => {
    expect(taskKindLabel(undefined)).toBe('工作')
    expect(taskKindLabel('implementation')).toBe('实现')
    expect(taskKindLabel('review')).toBe('审核')
    expect(taskKindLabel('verification')).toBe('验证')
    expect(taskKindLabel('unknown-kind')).toBe('unknown-kind')
  })

  it('separates pass, needs_revision, reject and the pending state', () => {
    expect(taskVerdictLabel(task({ id: 'r', kind: 'review', verdict: 'pass' }))).toBe('通过')
    expect(taskVerdictLabel(task({ id: 'r', kind: 'review', verdict: 'needs_revision' }))).toBe('需修订')
    expect(taskVerdictLabel(task({ id: 'r', kind: 'review', verdict: 'reject' }))).toBe('驳回')
    // Undecided is 待结论: a state word, never a fabricated verdict.
    expect(taskVerdictLabel(task({ id: 'r', kind: 'review' }))).toBe('待结论')
    // Only review/verification carry a verdict at all.
    expect(taskVerdictLabel(task({ id: 'w', kind: 'implementation', verdict: 'pass' }))).toBeUndefined()
    expect(taskCarriesVerdict(task({ id: 'v', kind: 'verification' }))).toBe(true)
    expect(taskCarriesVerdict(task({ id: 'w' }))).toBe(false)
    expect(taskVerdictTone(task({ id: 'r', kind: 'review', verdict: 'pass' }))).toBe('success')
    expect(taskVerdictTone(task({ id: 'r', kind: 'review', verdict: 'needs_revision' }))).toBe('warn')
    expect(taskVerdictTone(task({ id: 'r', kind: 'review', verdict: 'reject' }))).toBe('danger')
    expect(taskVerdictTone(task({ id: 'r', kind: 'review' }))).toBe('neutral')
    expect(taskVerdictTone(task({ id: 'w' }))).toBeUndefined()
  })

  it('prints only the due/reminder facts the task actually stores', () => {
    expect(taskScheduleEntries(task({ id: 'none' }))).toEqual([])
    expect(taskScheduleSummary(task({ id: 'none' }))).toBe('')
    const entries = taskScheduleEntries(task({
      id: 'scheduled',
      dueAt: '2026-01-02T09:00:00.000Z',
      remindAt: '2026-01-02T08:00:00.000Z',
      remindedAt: '2026-01-02T08:00:00.000Z',
    }))
    expect(entries.map(entry => entry.label)).toEqual(['截止', '提醒', '已提醒'])
    // An unparseable stamp stays as stored instead of becoming a guess.
    expect(taskScheduleEntries(task({ id: 'bad', dueAt: 'not-a-date' }))).toEqual([
      { label: '截止', value: 'not-a-date' },
    ])
    expect(TEAM_TASK_CREATE_HINT.length).toBeGreaterThan(0)
  })
})

describe('task detail panel', () => {
  const impl = task({
    id: 'impl',
    title: '实现总览',
    status: 'running',
    ownerSlotId: 'engineer',
    kind: 'implementation',
    acceptance: '测试通过',
    attemptId: 'attempt-1234567890abcdef',
    goalId: 'g1',
    dueAt: '2026-01-02T09:00:00.000Z',
    remindAt: '2026-01-02T08:00:00.000Z',
    remindedAt: '2026-01-02T08:00:00.000Z',
  })
  const failingReview = task({
    id: 'review',
    kind: 'review',
    status: 'completed',
    ownerSlotId: 'leader',
    verdict: 'needs_revision',
    reviewedTaskId: 'impl',
    error: '缺少回归测试',
  })
  const pendingReview = task({ id: 'pending-review', kind: 'review', status: 'running', ownerSlotId: 'leader' })
  const work = task({ id: 'work', kind: 'implementation', status: 'running' })
  const team = overviewTeam(
    { impl, review: failingReview, 'pending-review': pendingReview, work },
    { g1: goal({ id: 'g1', title: 'Detail goal' }) },
  )

  it('shows owner, kind, attempt, goal, acceptance and the reminder facts', () => {
    const detail = renderDetail(team, 'impl')
    expect(detail).toContain('实现总览')
    expect(detail).toContain('实现者')
    expect(detail).toContain('实现')
    // The ownership fence is shown short, with the full token only in the title.
    expect(detail).toContain('attempt-')
    expect(detail).toContain('title="attempt-1234567890abcdef"')
    expect(detail).toContain('所属目标')
    expect(detail).toContain('Detail goal')
    expect(detail).toContain('验收')
    expect(detail).toContain('测试通过')
    expect(detail).toContain('截止')
    expect(detail).toContain('提醒')
    expect(detail).toContain('已提醒')
    expect(detail).toContain(TEAM_TASK_CREATE_HINT)
    // An implementation task is not a review; no verdict group is invented.
    expect(detail).not.toContain('审核结论')
  })

  it('shows a failing review verdict together with its findings', () => {
    const detail = renderDetail(team, 'review')
    expect(detail).toContain('审核结论')
    expect(detail).toContain('需修订')
    expect(detail).toContain('审核对象')
    expect(detail).toContain('实现总览')
    // Findings stay visible once, under 审核结论, not as a second 异常 line.
    expect(detail).toContain('问题')
    expect(detail).toContain('缺少回归测试')
    expect(detail).not.toContain('异常')
  })

  it('reads an undecided review as pending instead of guessing a verdict', () => {
    const detail = renderDetail(team, 'pending-review')
    expect(detail).toContain('审核结论')
    expect(detail).toContain('待结论')
    expect(detail).not.toContain('通过')
    expect(detail).not.toContain('驳回')
  })

  it('shows the goal-missing and ungrouped states without inventing a Goal', () => {
    const loose = task({ id: 'loose', status: 'running', goalId: 'missing-goal' })
    const ungrouped = task({ id: 'ungrouped', status: 'running' })
    const scoped = overviewTeam({ loose, ungrouped })
    expect(renderDetail(scoped, 'loose')).toContain('未知目标')
    expect(renderDetail(scoped, 'ungrouped')).toContain('未归入目标')
  })
})
