import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The primitives bundle ships without its own runtime dependencies in this
// checkout; the guards below only need the element shape, not the styling.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: h } = await import('react')
  const passthrough = (props: { children?: unknown }) => (props.children ?? null) as never
  const api: Record<string, unknown> = {
    Button: (props: Record<string, unknown>) => h('button', {
      'aria-pressed': props['aria-pressed'],
      disabled: props.disabled,
    }, props.children as never),
    Input: (props: Record<string, unknown>) => h('input', { placeholder: props.placeholder as string }),
    // Modals render their children and footer so dialog bodies stay inspectable.
    Modal: (props: Record<string, unknown>) => h('div', null, props.children as never, props.footer as never),
    Tooltip: passthrough,
    // The native Menu always renders its anchor; the list only exists while open.
    Menu: (props: { anchor?: unknown; open?: boolean; children?: unknown }) =>
      (props.open === true ? h('div', { role: 'menu' }, props.children as never) : props.anchor ?? null),
    Tag: passthrough,
  }
  // Icons are irrelevant here; unknown names resolve to a null component. The
  // module must never look thenable, or `await import()` never settles.
  return new Proxy(api, {
    get: (target, key) => {
      if (typeof key !== 'string' || key === 'then' || key === '__esModule') return undefined
      if (!(key in target)) target[key] = () => null
      return target[key]
    },
  })
})

import type { TeamMemberSlot, TeamTask } from '../src/domain/types.js'
import { TEAM_ANNOUNCEMENT_MAX_CHARS } from '../src/domain/schemas.js'
import type { AssistantView, CatalogView, TeamView } from '../src/transport/contracts.js'
import { callAgentTeam, invalidateTeamListSnapshot } from '../src/client/api.js'
import {
  TeamAnnouncementSection,
  TeamForm,
  teamTemplateBrief,
  teamTemplatePrefill,
  templateRoleRenames,
} from '../src/client/teams/TeamPanel.js'
import {
  AnnouncementDialog,
  TEAM_ANNOUNCEMENT_UI_LIMIT,
  announcementDirty,
  announcementError,
  announcementUsage,
  teamAnnouncementError,
  teamAnnouncementText,
  teamAnnouncementUsage,
} from '../src/client/announcement-dialog.js'
import { SIDEBAR_GROUP_BRIEF_MAX_CHARS } from '../src/client/sidebar-groups.js'
import { TEAM_TEMPLATES } from '../src/client/team-templates.js'
import { teamMentionInsertion, teamMentionText } from '../src/client/labels.js'
import {
  TeamMentionAction,
  TeamMentionContext,
  teamMentionCandidates,
} from '../src/client/team-parallel.js'
import { resolveTeamTarget } from '../src/runtime/team-turn-routing.js'
import {
  compareTeamSidebar,
  recentTeamTasks,
  rosterSubtitle,
  taskWaitsOnDependency,
  teamRosterRows,
  teamScopeCounts,
  teamSidebarStatusText,
  teamSidebarSummary,
} from '../src/client/team-sidebar-data.js'
import { teamPanelView } from '../src/client/team-main-agent-data.js'
import { globalOverviewModel } from '../src/client/global-overview-data.js'
import { isTeamExecuting } from '../src/client/team-status.js'
import {
  UsageSection,
  installUsageSessions,
  teamUsageScope,
  usageReport,
} from '../src/client/usage.js'

const NOW = '2026-01-01T00:00:00.000Z'

type SidebarFixture = Partial<Pick<
  TeamView,
  'members' | 'tasks' | 'pinned' | 'updatedAt' | 'id' | 'name' | 'archivedAt' | 'state' | 'memberOrder' | 'announcement'
>>

function team(overrides: SidebarFixture = {}): TeamView {
  return {
    members: {},
    tasks: {},
    pinned: false,
    updatedAt: NOW,
    id: 'team-1',
    name: '测试团队',
    ...overrides,
  } as TeamView
}

function members(states: Record<string, string>): TeamView['members'] {
  return Object.fromEntries(Object.entries(states).map(([slotId, lastRuntimeState]) => [
    slotId,
    { lastRuntimeState },
  ])) as TeamView['members']
}

function task(overrides: Partial<TeamTask> & Pick<TeamTask, 'id'>): TeamTask {
  return {
    title: `任务 ${overrides.id}`,
    description: '',
    status: 'pending',
    dependencyIds: [],
    fileScopes: [],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as TeamTask
}

describe('teamSidebarSummary', () => {
  it('returns zero counts for an empty team without undefined', () => {
    expect(teamSidebarSummary(team())).toEqual({ members: 0, running: 0, waiting: 0, waitingDependency: 0 })
  })

  it('counts one member slot whatever its runtime state', () => {
    const summary = teamSidebarSummary(team({ members: members({ leader: 'idle' }) }))
    expect(summary).toEqual({ members: 1, running: 0, waiting: 0, waitingDependency: 0 })
  })

  it('counts running and waiting members across many slots', () => {
    const summary = teamSidebarSummary(team({
      members: members({
        leader: 'running',
        a: 'waiting_approval',
        b: 'running',
        c: 'offline',
        d: 'error',
      }),
    }))
    expect(summary).toEqual({ members: 5, running: 2, waiting: 1, waitingDependency: 0, error: 1 })
  })

  it('counts blocked tasks whose prerequisites are not completed', () => {
    const summary = teamSidebarSummary(team({
      tasks: {
        impl: task({ id: 'impl', status: 'running' }),
        review: task({ id: 'review', status: 'blocked', dependencyIds: ['impl'] }),
        verify: task({ id: 'verify', status: 'blocked', dependencyIds: ['review'] }),
      },
    }))
    expect(summary.waitingDependency).toBe(2)
  })

  it('ignores blocked tasks once every prerequisite completed', () => {
    const summary = teamSidebarSummary(team({
      tasks: {
        impl: task({ id: 'impl', status: 'completed' }),
        review: task({ id: 'review', status: 'blocked', dependencyIds: ['impl'] }),
      },
    }))
    expect(summary.waitingDependency).toBe(0)
  })

  it('keeps a reachable prerequisite visible behind a stale id', () => {
    const fixture = team({
      tasks: {
        impl: task({ id: 'impl', status: 'running' }),
        review: task({ id: 'review', status: 'blocked', dependencyIds: ['gone', 'impl'] }),
      },
    })
    expect(teamSidebarSummary(fixture).waitingDependency).toBe(1)
    expect(recentTeamTasks(fixture).find(item => item.id === 'review')?.blockedBy?.id).toBe('impl')
  })

  it('does not count a prerequisite id that no task in the view resolves', () => {
    // Documented behavior: an unreachable id (deleted or foreign) cannot be
    // named in the sidebar, so it is not reported as a wait.
    const fixture = team({
      tasks: { review: task({ id: 'review', status: 'blocked', dependencyIds: ['gone'] }) },
    })
    expect(teamSidebarSummary(fixture).waitingDependency).toBe(0)
    expect(recentTeamTasks(fixture).find(item => item.id === 'review')?.blockedBy).toBeUndefined()
  })

  it('counts queued work held by a prerequisite, not only blocked rows', () => {
    // One rule for every surface: an open task whose prerequisite is unfinished
    // waits, whatever its own status. A pending-only team must not read 空闲.
    const summary = teamSidebarSummary(team({
      tasks: {
        impl: task({ id: 'impl', status: 'running' }),
        pending: task({ id: 'pending', status: 'pending', dependencyIds: ['impl'] }),
        queued: task({ id: 'queued', status: 'assigned', dependencyIds: ['impl'] }),
      },
    }))
    expect(summary.waitingDependency).toBe(2)
    expect(teamSidebarStatusText(summary)).toBe('0 人 · 任务执行中 · 2 等待前置')
  })

  it('counts a running task that still declares an unfinished prerequisite', () => {
    const summary = teamSidebarSummary(team({
      tasks: {
        impl: task({ id: 'impl', status: 'running' }),
        review: task({ id: 'review', status: 'running', dependencyIds: ['impl'] }),
      },
    }))
    // The prerequisite itself has no dependency; only the held task waits.
    expect(summary.waitingDependency).toBe(1)
  })

  it('exposes that one rule for the sidebar count, task rows and the overview', () => {
    const tasks = { impl: task({ id: 'impl', status: 'running' }) }
    expect(taskWaitsOnDependency(task({ id: 'q', status: 'pending', dependencyIds: ['impl'] }), tasks)).toBe(true)
    expect(taskWaitsOnDependency(task({ id: 'q', status: 'failed', dependencyIds: ['impl'] }), tasks)).toBe(false)
    expect(taskWaitsOnDependency(task({ id: 'q', status: 'pending' }), tasks)).toBe(false)
  })

  it('never counts a terminal task as waiting, even with a dependency id', () => {
    const summary = teamSidebarSummary(team({
      tasks: {
        impl: task({ id: 'impl', status: 'running' }),
        failed: task({ id: 'failed', status: 'failed', dependencyIds: ['impl'] }),
        cancelled: task({ id: 'cancelled', status: 'cancelled', dependencyIds: ['impl'] }),
        done: task({ id: 'done', status: 'completed', dependencyIds: ['impl'] }),
      },
    }))
    expect(summary.waitingDependency).toBe(0)
  })

  it('counts a blocked task without declared dependencies as not waiting', () => {
    const summary = teamSidebarSummary(team({
      tasks: { lonely: task({ id: 'lonely', status: 'blocked' }) },
    }))
    expect(summary.waitingDependency).toBe(0)
  })
})

describe('teamSidebarStatusText', () => {
  it('reads an idle team as members plus 空闲', () => {
    expect(teamSidebarStatusText({ members: 3, running: 0, waiting: 0, waitingDependency: 0 })).toBe('3 人 · 空闲')
  })

  it('drops 空闲 once a member is running', () => {
    expect(teamSidebarStatusText({ members: 3, running: 2, waiting: 0, waitingDependency: 0 })).toBe('3 人 · 2 运行')
  })

  it('shows the waiting count last when approvals are pending', () => {
    expect(teamSidebarStatusText({ members: 3, running: 2, waiting: 1, waitingDependency: 0 })).toBe('3 人 · 2 运行 · 1 待审批')
  })

  it('keeps dependency waiting text-only behind the member counts', () => {
    expect(teamSidebarStatusText({ members: 3, running: 2, waiting: 0, waitingDependency: 4 })).toBe('3 人 · 2 运行 · 4 等待前置')
  })

  it('prefers the approval branch when both approvals and dependencies are pending', () => {
    expect(teamSidebarStatusText({ members: 3, running: 2, waiting: 1, waitingDependency: 4 })).toBe('3 人 · 2 运行 · 1 待审批')
  })
})

describe('teamSidebarSummary · member failures and startup', () => {
  it('counts an errored member and never lets the row read 空闲', () => {
    const summary = teamSidebarSummary(team({ members: members({ only: 'error' }) }))

    expect(summary).toMatchObject({ members: 1, running: 0, waiting: 0, error: 1 })
    expect(teamSidebarStatusText(summary)).toBe('1 人 · 异常')
  })

  it('says 异常 once when the team itself is in error', () => {
    const summary = teamSidebarSummary(team({ state: 'error', members: members({ only: 'error' }) }))
    const text = teamSidebarStatusText(summary)

    expect(text).toBe('1 人 · 异常')
    expect(text.match(/异常/g)).toHaveLength(1)
  })

  it('reads a waking member as 启动中 instead of 空闲', () => {
    // Decision: a starting member is transient activity, not leisure, so the
    // row says 启动中; the roster still names the member state per row.
    const summary = teamSidebarSummary(team({ members: members({ only: 'starting' }) }))

    expect(summary).toMatchObject({ members: 1, starting: 1 })
    expect(teamSidebarStatusText(summary)).toBe('1 人 · 启动中')
    expect(teamSidebarStatusText(summary)).not.toContain('空闲')
  })

  it('keeps 空闲 when every member is idle or offline', () => {
    const summary = teamSidebarSummary(team({ members: members({ a: 'idle', b: 'offline' }) }))

    expect(summary).not.toHaveProperty('error')
    expect(summary).not.toHaveProperty('starting')
    expect(teamSidebarStatusText(summary)).toBe('2 人 · 空闲')
  })

  it('puts the error word after approvals and never beside 空闲', () => {
    const summary = teamSidebarSummary(team({ members: members({ a: 'waiting_approval', b: 'error' }) }))

    expect(teamSidebarStatusText(summary)).toBe('2 人 · 1 待审批 · 异常')
  })

  it('agrees with the roster and the overview on the same errored member', () => {
    const fixture = team({
      id: 'team-error',
      members: { only: slot('only', { lastRuntimeState: 'error', lastError: '启动超时' }) },
    })

    expect(teamRosterRows(fixture)[0]).toMatchObject({
      statusLabel: '异常',
      tone: 'error',
      attention: 'error',
    })
    const overview = globalOverviewModel({ teams: [fixture], instances: [], tasks: [] })
    expect(overview.counts.error).toBe(1)
    expect(overview.counts.idle).toBe(0)
    expect(teamSidebarStatusText(teamSidebarSummary(fixture))).toBe('1 人 · 异常')
  })
})

describe('teamSidebarStatusText · pending attention never reads 空闲', () => {
  it('drops 空闲 for one waiting_approval member and zero running', () => {
    const summary = teamSidebarSummary(team({ members: members({ leader: 'waiting_approval' }) }))
    expect(summary).toMatchObject({ members: 1, running: 0, waiting: 1 })
    const text = teamSidebarStatusText(summary)
    expect(text).toBe('1 人 · 1 待审批')
    expect(text).not.toContain('空闲')
  })

  it('drops 空闲 for dependency waiting even when no member or task runs', () => {
    const summary = teamSidebarSummary(team({
      tasks: {
        design: task({ id: 'design', status: 'blocked' }),
        review: task({ id: 'review', status: 'blocked', dependencyIds: ['design'] }),
      },
    }))
    expect(summary).toMatchObject({ members: 0, running: 0, waiting: 0, waitingDependency: 1 })
    const text = teamSidebarStatusText(summary)
    expect(text).toBe('0 人 · 1 等待前置')
    expect(text).not.toContain('空闲')
  })

  it('still reads 空闲 for an active team with nothing running', () => {
    const summary = teamSidebarSummary(team({
      state: 'active',
      members: members({ leader: 'idle' }),
    }))
    expect(teamSidebarStatusText(summary)).toBe('1 人 · 空闲')
  })
})

describe('teamSidebarStatusText · 启动中 is one word', () => {
  it('does not repeat the lifecycle 启动中 with a waking member', () => {
    const summary = teamSidebarSummary(team({
      state: 'starting',
      members: members({ only: 'starting' }),
    }))
    const text = teamSidebarStatusText(summary)

    expect(text).toBe('1 人 · 启动中')
    expect(text.match(/启动中/g)).toHaveLength(1)
  })

  it('keeps a single 启动中 word next to approvals and errors', () => {
    const approving = teamSidebarSummary(team({
      state: 'starting',
      members: members({ a: 'starting', b: 'waiting_approval' }),
    }))
    expect(teamSidebarStatusText(approving)).toBe('2 人 · 启动中 · 1 待审批')
    expect(teamSidebarStatusText(approving).match(/启动中/g)).toHaveLength(1)

    const errored = teamSidebarSummary(team({
      state: 'starting',
      members: members({ a: 'starting', b: 'error' }),
    }))
    expect(teamSidebarStatusText(errored)).toBe('2 人 · 启动中 · 异常')
    expect(teamSidebarStatusText(errored).match(/启动中/g)).toHaveLength(1)
  })

  it('still reads the member word when no lifecycle label speaks', () => {
    const summary = teamSidebarSummary(team({ members: members({ only: 'starting' }) }))
    expect(teamSidebarStatusText(summary)).toBe('1 人 · 启动中')
  })

  it('still reads 启动中 for a starting team without members', () => {
    expect(teamSidebarStatusText(teamSidebarSummary(team({ state: 'starting' })))).toBe('0 人 · 启动中')
  })
})

describe('startup is not idle on any surface', () => {
  const startingTeam = team({
    id: 'team-starting',
    name: '启动团队',
    state: 'starting',
    members: { only: slot('only', { lastRuntimeState: 'starting' }) },
  })
  const wakingMemberTeam = team({
    id: 'team-waking',
    name: '唤醒团队',
    members: { only: slot('only', { lastRuntimeState: 'starting' }) },
  })

  it.each([
    ['a starting team', () => startingTeam, '1 人 · 启动中'],
    ['a team whose member is waking', () => wakingMemberTeam, '1 人 · 启动中'],
  ] as const)('agrees on %s', (_label, build, expected) => {
    const fixture = build()
    const text = teamSidebarStatusText(teamSidebarSummary(fixture))
    const roster = teamRosterRows(fixture)
    const overview = globalOverviewModel({ teams: [fixture], instances: [], tasks: [] })

    expect(text).toBe(expected)
    expect(text).not.toContain('空闲')
    expect(roster[0]).toMatchObject({ statusLabel: '启动中', tone: 'starting' })
    expect(overview.teams[0]).toMatchObject({ starting: true, running: false })
    expect(overview.counts.idle).toBe(0)
  })

  it('keeps a starting team out of idle and out of the attention count', () => {
    const overview = globalOverviewModel({ teams: [startingTeam], instances: [], tasks: [] })

    expect(overview.teams[0]?.categories).toEqual([])
    expect(overview.counts.idle).toBe(0)
    expect(overview.counts.attention).toBe(0)
  })
})

describe('teamSidebarStatusText · team state', () => {
  it('reads an error team as 异常 instead of 空闲', () => {
    expect(teamSidebarStatusText(teamSidebarSummary(team({ state: 'error' })))).toBe('0 人 · 异常')
  })

  it('reads a starting team as 启动中', () => {
    expect(teamSidebarStatusText(teamSidebarSummary(team({ state: 'starting' })))).toBe('0 人 · 启动中')
  })

  it('keeps the member running count while a non-active state stays visible', () => {
    const summary = teamSidebarSummary(team({
      state: 'error',
      members: members({ leader: 'running', helper: 'idle' }),
    }))
    expect(summary.running).toBe(1)
    expect(teamSidebarStatusText(summary)).toBe('2 人 · 1 运行 · 异常')
  })

  it('reads a running task with idle members as 任务执行中, not 空闲', () => {
    const summary = teamSidebarSummary(team({
      state: 'active',
      members: members({ leader: 'idle' }),
      tasks: { work: task({ id: 'work', status: 'running' }) },
    }))
    expect(summary.running).toBe(0)
    expect(teamSidebarStatusText(summary)).toBe('1 人 · 任务执行中')
  })

  it('leaves an active team with idle members reading 空闲', () => {
    expect(teamSidebarStatusText(teamSidebarSummary(team({
      state: 'active',
      members: members({ leader: 'idle' }),
    })))).toBe('1 人 · 空闲')
  })

  it.each([
    ['ownership_conflict', '归属冲突'],
    ['delete_blocked', '删除受阻'],
    ['deleting', '删除中'],
    ['draft', '草稿'],
  ] as const)('labels %s as %s like the team page does', (state, label) => {
    expect(teamSidebarStatusText(teamSidebarSummary(team({ state })))).toBe(`0 人 · ${label}`)
  })
})

describe('compareTeamSidebar', () => {
  const pinned = team({ id: 'pinned', name: '置顶团队', pinned: true, updatedAt: '2026-01-01T00:00:00.000Z' })
  const waiting = team({ id: 'waiting', name: '待审批团队', members: members({ a: 'waiting_approval' }), updatedAt: '2026-01-01T00:00:00.000Z' })
  const running = team({ id: 'running', name: '运行团队', members: members({ a: 'running' }), updatedAt: '2026-01-01T00:00:00.000Z' })
  const stale = team({ id: 'stale', name: '更新团队', updatedAt: '2025-12-01T00:00:00.000Z' })
  const fresh = team({ id: 'fresh', name: '更新团队', updatedAt: '2026-01-01T00:00:00.000Z' })

  it('sorts pinned first, then waiting, then running, then updatedAt', () => {
    expect([fresh, running, pinned, stale, waiting].sort((a, b) => compareTeamSidebar(a, b, 'updated')).map(item => item.id))
      .toEqual(['pinned', 'waiting', 'running', 'fresh', 'stale'])
  })

  it('breaks an updatedAt tie by id ascending', () => {
    const low = team({ id: 'a-team', name: '更新团队', updatedAt: NOW })
    const high = team({ id: 'b-team', name: '更新团队', updatedAt: NOW })
    expect(compareTeamSidebar(high, low, 'updated')).toBeGreaterThan(0)
  })

  it('still puts a pinned team first in name mode', () => {
    expect(compareTeamSidebar(pinned, waiting, 'name')).toBeLessThan(0)
  })

  it('sorts unpinned names with the zh-CN collator the sidebar already uses', () => {
    const alpha = team({ id: 'a', name: 'Alpha 团队' })
    const chinese = team({ id: 'b', name: '软件研发团队' })
    // Node's zh-CN collator ranks 中文 before Latin, matching sidebar.tsx's localeCompare('zh-CN').
    expect([alpha, chinese].sort((a, b) => compareTeamSidebar(a, b, 'name')).map(item => item.name))
      .toEqual(['软件研发团队', 'Alpha 团队'])
    expect(compareTeamSidebar(chinese, alpha, 'name')).toBeLessThan(0)
    expect(compareTeamSidebar(alpha, chinese, 'name')).toBeGreaterThan(0)
  })

})

describe('recentTeamTasks', () => {
  it('returns an empty list for a team with no tasks', () => {
    expect(recentTeamTasks(team())).toEqual([])
  })

  it('keeps the newest three tasks by updatedAt then id', () => {
    const tasks = {
      old: task({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      mid: task({ id: 'mid', updatedAt: '2026-01-02T00:00:00.000Z' }),
      tieB: task({ id: 'tie-b', updatedAt: '2026-01-03T00:00:00.000Z' }),
      tieA: task({ id: 'tie-a', updatedAt: '2026-01-03T00:00:00.000Z' }),
      extra: task({ id: 'extra', updatedAt: '2025-12-31T00:00:00.000Z' }),
    }
    expect(recentTeamTasks(team({ tasks })).map(item => item.id))
      .toEqual(['tie-a', 'tie-b', 'mid'])
  })

  it('honors a custom limit and never returns more than asked', () => {
    const tasks = {
      one: task({ id: 'one', updatedAt: '2026-01-02T00:00:00.000Z' }),
      two: task({ id: 'two', updatedAt: '2026-01-01T00:00:00.000Z' }),
    }
    expect(recentTeamTasks(team({ tasks }), 1).map(item => item.id)).toEqual(['one'])
    expect(recentTeamTasks(team({ tasks }), 0)).toEqual([])
  })

  it.each([
    ['pending', '待处理'],
    ['assigned', '已分配'],
    ['running', '进行中'],
    ['blocked', '已阻塞'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
  ] as const)('maps %s to its Chinese status label', (status, statusLabel) => {
    const tasks = { only: task({ id: 'only', status }) }
    expect(recentTeamTasks(team({ tasks }))[0]).toEqual({
      id: 'only',
      title: '任务 only',
      status,
      statusLabel,
      updatedAt: NOW,
    })
  })

  it('falls back to the task id when the title is blank', () => {
    const tasks = { blank: task({ id: 'blank', title: '   ' }) }
    expect(recentTeamTasks(team({ tasks }))[0]?.title).toBe('未命名任务')
  })

  it('exposes the first unresolved prerequisite on a blocked task', () => {
    const tasks = {
      impl: task({ id: 'impl', title: '实现登录', status: 'running', ownerSlotId: 'engineer' }),
      done: task({ id: 'done', title: '写方案', status: 'completed' }),
      review: task({ id: 'review', title: '评审登录', status: 'blocked', dependencyIds: ['done', 'impl'] }),
    }
    const members = { engineer: { displayName: '实现者' } } as unknown as TeamView['members']
    const review = recentTeamTasks(team({ tasks, members })).find(item => item.id === 'review')
    expect(review?.blockedBy).toEqual({ id: 'impl', title: '实现登录', ownerName: '实现者' })
  })

  it('omits blockedBy when no prerequisite is outstanding', () => {
    const tasks = {
      done: task({ id: 'done', status: 'completed' }),
      review: task({ id: 'review', status: 'blocked', dependencyIds: ['done'] }),
      plain: task({ id: 'plain', status: 'blocked' }),
    }
    const rows = recentTeamTasks(team({ tasks }))
    expect(rows.find(item => item.id === 'review')?.blockedBy).toBeUndefined()
    expect(rows.find(item => item.id === 'plain')?.blockedBy).toBeUndefined()
  })

  it('leaves a task without stored extras with no detail line', () => {
    // Same rule as the board: a legacy row must not grow words it never stored.
    const rows = recentTeamTasks(team({ tasks: { plain: task({ id: 'plain' }) } }))
    expect(rows[0]?.detail).toBeUndefined()
  })

  it('reports the owner, kind and due/reminder facts the board detail shows', () => {
    const tasks = {
      impl: task({
        id: 'impl',
        status: 'running',
        ownerSlotId: 'engineer',
        kind: 'implementation',
        dueAt: '2026-01-02T09:00:00.000Z',
        remindAt: '2026-01-02T08:00:00.000Z',
        remindedAt: '2026-01-02T08:00:00.000Z',
      }),
    }
    const members = { engineer: { displayName: '实现者' } } as unknown as TeamView['members']
    const detail = recentTeamTasks(team({ tasks, members }))[0]?.detail
    expect(detail).toContain('实现者')
    expect(detail).toContain('实现')
    expect(detail).toContain('截止')
    expect(detail).toContain('提醒')
    expect(detail).toContain('已提醒')
  })

  it('reads an undecided review as 待结论 and never invents a verdict', () => {
    const tasks = {
      review: task({ id: 'review', status: 'running', kind: 'review' }),
      verdict: task({ id: 'verdict', status: 'completed', kind: 'review', verdict: 'reject' }),
      work: task({ id: 'work', status: 'running', kind: 'implementation' }),
    }
    const rows = recentTeamTasks(team({ tasks }))
    expect(rows.find(item => item.id === 'review')?.detail).toBe('审核：待结论')
    expect(rows.find(item => item.id === 'verdict')?.detail).toBe('审核：驳回')
    // Only review/verification tasks carry a verdict word at all.
    expect(rows.find(item => item.id === 'work')?.detail).toBe('实现')
  })
})

describe('teamScopeCounts', () => {
  it('splits active and archived teams without double counting', () => {
    expect(teamScopeCounts([
      team({ id: 'a' }),
      team({ id: 'b' }),
      team({ id: 'c', archivedAt: '2025-12-01T00:00:00.000Z' }),
    ])).toEqual({ active: 2, archived: 1 })
  })

  it('reports zero archived teams when nothing is archived', () => {
    expect(teamScopeCounts([])).toEqual({ active: 0, archived: 0 })
    expect(teamScopeCounts([team({ id: 'only' })])).toEqual({ active: 1, archived: 0 })
  })
})


describe('sidebar narrow-width CSS', () => {
  const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')

  /** Every block of one exact media header, brace-matched so nested rules stay intact. */
  function mediaBlocks(source: string, header: string): string[] {
    const blocks: string[] = []
    let from = 0
    while (from < source.length) {
      const start = source.indexOf(header, from)
      if (start < 0) break
      const open = source.indexOf('{', start)
      let depth = 0
      for (let index = open; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1
        else if (source[index] === '}') {
          depth -= 1
          if (depth === 0) {
            blocks.push(source.slice(open + 1, index))
            from = index + 1
            break
          }
        }
      }
      if (depth !== 0) break
    }
    return blocks
  }

  it('hides the team row time on a narrow phone viewport, which covers 320px', () => {
    const narrow = mediaBlocks(css, '@media (max-width: 420px)')
    expect(narrow.some(block => (
      /\.sidebarTeamRowWrapTwoLine\s+\.sidebarTeamTime\s*\{[^}]*display:\s*none/.test(block)
    ))).toBe(true)
  })
})

const AVATAR = 'data:image/png;base64,iVBORw0KGgo='

/** A full member slot; the roster reads the same fields the panel does. */
function slot(id: string, overrides: Partial<TeamMemberSlot> = {}): TeamMemberSlot {
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
    joinedAt: NOW,
    ...overrides,
  } as TeamMemberSlot
}

describe('teamRosterRows', () => {
  it('returns one row per member and nothing at all for an empty team', () => {
    expect(teamRosterRows(team())).toEqual([])
  })

  it('reads avatar, name, role, session and status from the member slot', () => {
    const fixture = team({
      members: {
        leader: slot('leader', {
          displayName: '队长',
          role: 'leader',
          sessionId: 'session-leader',
          assistantSnapshot: { ...slot('leader').assistantSnapshot, avatar: AVATAR },
          lastRuntimeState: 'running',
        }),
      },
    })
    expect(teamRosterRows(fixture)).toEqual([{
      teamId: 'team-1',
      slotId: 'leader',
      sessionId: 'session-leader',
      name: '队长',
      role: 'leader',
      avatar: AVATAR,
      runtimeState: 'running',
      statusLabel: '运行中',
      tone: 'running',
    }])
  })

  it('keeps the projection order: memberOrder, then joinedAt, then id', () => {
    const fixture = team({
      memberOrder: ['b', 'a'],
      members: {
        a: slot('a', { joinedAt: '2026-01-01T00:00:00.000Z' }),
        b: slot('b', { joinedAt: '2026-01-03T00:00:00.000Z' }),
        c: slot('c', { joinedAt: '2026-01-02T00:00:00.000Z' }),
      },
    })
    expect(teamRosterRows(fixture).map(row => row.slotId)).toEqual(['b', 'a', 'c'])
  })

  it.each([
    ['running', '运行中', 'running'],
    ['waiting_approval', '等待审批', 'waiting'],
    ['error', '异常', 'error'],
    ['starting', '启动中', 'starting'],
    ['idle', '空闲', 'idle'],
    ['offline', '离线', 'offline'],
  ] as const)('labels %s as %s with tone %s', (state, statusLabel, tone) => {
    const row = teamRosterRows(team({ members: { a: slot('a', { lastRuntimeState: state }) } }))[0]
    expect(row).toMatchObject({ statusLabel, tone, runtimeState: state })
  })

  it('shows the running task, otherwise the newest assigned one', () => {
    const fixture = team({
      members: { a: slot('a', { lastRuntimeState: 'running' }) },
      tasks: {
        older: task({ id: 'older', title: '旧运行', status: 'running', ownerSlotId: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }),
        newer: task({ id: 'newer', title: '新运行', status: 'running', ownerSlotId: 'a', updatedAt: '2026-01-02T00:00:00.000Z' }),
        assigned: task({ id: 'assigned', title: '已分配', status: 'assigned', ownerSlotId: 'a', updatedAt: '2026-01-03T00:00:00.000Z' }),
      },
    })
    expect(teamRosterRows(fixture)[0]?.currentTask).toEqual({ id: 'newer', title: '新运行' })
  })

  it('falls back to the newest assigned task when nothing runs', () => {
    const fixture = team({
      members: { a: slot('a') },
      tasks: {
        one: task({ id: 'one', title: '先分配', status: 'assigned', ownerSlotId: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }),
        two: task({ id: 'two', title: '后分配', status: 'assigned', ownerSlotId: 'a', updatedAt: '2026-01-02T00:00:00.000Z' }),
      },
    })
    expect(teamRosterRows(fixture)[0]?.currentTask).toEqual({ id: 'two', title: '后分配' })
  })

  it('never invents a task for a member without one', () => {
    const fixture = team({
      members: { a: slot('a') },
      tasks: { other: task({ id: 'other', ownerSlotId: 'b' }) },
    })
    expect(teamRosterRows(fixture)[0]?.currentTask).toBeUndefined()
  })

  it('names a blank task title instead of rendering empty space', () => {
    const fixture = team({
      members: { a: slot('a', { lastRuntimeState: 'running' }) },
      tasks: { blank: task({ id: 'blank', title: '   ', status: 'running', ownerSlotId: 'a' }) },
    })
    expect(teamRosterRows(fixture)[0]?.currentTask).toEqual({ id: 'blank', title: '未命名任务' })
  })

  it('accepts only a bounded inline avatar', () => {
    const valid = team({
      members: { a: slot('a', { assistantSnapshot: { ...slot('a').assistantSnapshot, avatar: AVATAR } }) },
    })
    const invalid = team({
      members: { a: slot('a', { assistantSnapshot: { ...slot('a').assistantSnapshot, avatar: 'https://example.test/x.png' } }) },
    })
    expect(teamRosterRows(valid)[0]?.avatar).toBe(AVATAR)
    expect(teamRosterRows(invalid)[0]?.avatar).toBeUndefined()
  })

  it('marks one approval wait without a count', () => {
    const fixture = team({ members: { a: slot('a', { lastRuntimeState: 'waiting_approval' }) } })
    const row = teamRosterRows(fixture)[0]
    expect(row?.attention).toBe('approval')
    expect(row).not.toHaveProperty('approvalCount')
  })

  it('marks a runtime error and carries its last error text', () => {
    const fixture = team({
      members: { a: slot('a', { lastRuntimeState: 'error', lastError: '启动超时' }) },
    })
    expect(teamRosterRows(fixture)[0]).toMatchObject({
      attention: 'error',
      tone: 'error',
      statusLabel: '异常',
      errorText: '启动超时',
    })
  })

  it('keeps error text on the error tone only', () => {
    const fixture = team({
      members: {
        ok: slot('ok', { lastRuntimeState: 'waiting_approval', lastError: '旧错误' }),
        bare: slot('bare', { lastRuntimeState: 'error' }),
      },
    })
    const rows = teamRosterRows(fixture)
    expect(rows[0]?.attention).toBe('approval')
    expect(rows[0]).not.toHaveProperty('errorText')
    expect(rows[1]).toMatchObject({ attention: 'error' })
    expect(rows[1]).not.toHaveProperty('errorText')
  })

  it('survives an unknown runtime state without inventing a label', () => {
    const fixture = team({ members: { a: slot('a', { lastRuntimeState: 'paused' as never }) } })
    expect(teamRosterRows(fixture)[0]).toMatchObject({ statusLabel: 'paused', tone: 'idle' })
  })

  it('reads the same member fields as the Leader panel projection', () => {
    const fixture = team({
      members: { a: slot('a', { lastRuntimeState: 'running' }), b: slot('b') },
      tasks: { work: task({ id: 'work', title: '实现', status: 'running', ownerSlotId: 'a' }) },
    })
    const panel = teamPanelView(fixture)
    const rows = teamRosterRows(fixture)
    expect(rows.map(row => ({
      id: row.slotId,
      name: row.name,
      role: row.role,
      state: row.runtimeState,
      currentTask: row.currentTask,
    }))).toEqual(panel.members.map(member => ({
      id: member.id,
      name: member.name,
      role: member.role,
      state: member.state,
      currentTask: member.currentTask,
    })))
  })

  it('builds the subtitle from the status word and the current task', () => {
    expect(rosterSubtitle({ statusLabel: '空闲' })).toBe('空闲')
    expect(rosterSubtitle({ statusLabel: '运行中', currentTask: { id: 't', title: '实现登录' } }))
      .toBe('运行中 · 实现登录')
  })
})

describe('sidebar counts agree with the other team surfaces', () => {
  const fixture = team({
    members: {
      leader: slot('leader', { lastRuntimeState: 'waiting_approval' }),
      a: slot('a', { lastRuntimeState: 'running' }),
      b: slot('b', { lastRuntimeState: 'idle' }),
    },
    tasks: {
      impl: task({ id: 'impl', status: 'running', ownerSlotId: 'a' }),
      queued: task({ id: 'queued', status: 'pending', dependencyIds: ['impl'] }),
      done: task({ id: 'done', status: 'completed' }),
    },
  })

  it('counts the same approvals as the global overview', () => {
    const summary = teamSidebarSummary(fixture)
    const overview = globalOverviewModel({ teams: [fixture], instances: [], tasks: [] })
    expect(summary.waiting).toBe(1)
    expect(overview.teams[0]?.approval).toBe(summary.waiting)
  })

  it('counts the same dependency waits as the global overview', () => {
    const summary = teamSidebarSummary(fixture)
    const overview = globalOverviewModel({ teams: [fixture], instances: [], tasks: [] })
    expect(summary.waitingDependency).toBe(1)
    expect(overview.teams[0]?.blocked).toBe(summary.waitingDependency)
  })

  it('keeps 运行 for members that are actually running, unlike the team-level "has activity" rule', () => {
    // F1: one word, one meaning. The sidebar number excludes an approval wait;
    // the team-level flag is a different question ("does anything need me?") and
    // is documented with its own label.
    const summary = teamSidebarSummary(fixture)
    expect(summary.running).toBe(1)
    expect(isTeamExecuting(fixture)).toBe(true)
    expect(teamSidebarStatusText(summary)).toBe('3 人 · 1 运行 · 1 待审批')
  })
})

describe('sidebar structure', () => {
  const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
  const sidebar = readFileSync(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')

  const ALLOWED_TOKENS = new Set([
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-label-quaternary',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-interactive-bg-active',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-business-primary',
    '--dsw-radius-xs',
    '--dsw-radius-sm',
    '--dsw-radius-md',
    '--dsw-focus-ring-width',
    '--dsw-focus-ring-color',
  ])

  function rosterCss(): string {
    const start = css.indexOf('/* Bot roster:')
    const end = css.indexOf('/* The 320px phone drawer', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return css.slice(start, end)
  }

  it('uses only whitelisted semantic tokens', () => {
    const tokens = [...rosterCss().matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(match => match[1]!)
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.filter(token => !ALLOWED_TOKENS.has(token))).toEqual([])
    expect(rosterCss()).not.toContain('--dsw-alias-text-')
  })

  it('lets the roster row shrink into a 320px drawer', () => {
    const row = /\.sidebarRosterRow\s*\{([^}]*)\}/.exec(rosterCss())?.[1] ?? ''
    expect(row).toContain('min-width: 0')
    expect(row).toContain('width: 100%')
    expect(rosterCss()).not.toMatch(/min-width:\s*(?:1[3-9]\d|[2-9]\d\d)px/)
  })

  it('tightens the roster indent on a phone viewport', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 420px)'))
    expect(narrow).toMatch(/\.sidebarRosterList\s*\{[^}]*padding-left:\s*18px/)
  })

  it('renders the first-use card under the row, not inside an expandable roster', () => {
    // A team expands into nothing now: the row is the whole sidebar entry and
    // the one starting action sits directly beneath it.
    expect(sidebar).not.toContain('data-dsh-team-roster-toggle')
    expect(sidebar).not.toContain('data-dsh-team-threads')
    expect(sidebar).toMatch(/<\/div>\n\s*\{\/\* First use:[\s\S]{0,400}<TeamNextStepCard team=\{team\} onOpenLeader/)
  })

  it('opens the conversation the team used last from its row', () => {
    // Threads are still the source of "last used", but they are navigation
    // data now: the newest one wins, and a fresh team falls back to its Leader.
    expect(sidebar).toContain('export function teamLastSessionId')
    expect(sidebar).toContain('const sessionId = teamLastSessionId(team)')
    expect(sidebar).toContain('openSession(sessionId)')
    expect(sidebar).not.toContain('data-dsh-team-thread-row')
  })

  it('stacks the mode row, the coordinator and both lists in one column', () => {
    // The row takes the shipped brand row's slot: same column, normal flow.
    expect(sidebar).toContain('root.insertBefore(element, logoRow)')
    expect(css).toContain("[data-dsh-team-root]:not([class*='_collapsed']) [class*='_logoRow']")
    // 群聊 is a child of the assistant section, which draws the coordinator row
    // above its children: DOM, tab and AT order are 总协调 → 群聊 → 单聊.
    expect(sidebar).toMatch(/<AssistantSidebarSection[\s\S]{0,240}<SidebarTeamSection/)
    // Paint order must not be patched with a CSS `order` again.
    expect(css).not.toMatch(/\.sidebarTeamSection\s*\{[^}]*order:/)
    expect(css).not.toMatch(/\.sidebarAssistantSection\s*\{[^}]*order:/)
    expect(css).not.toMatch(/\.sidebarCoordinatorRow\s*\{[^}]*order:/)
  })

  it('drops the shipped 新会话 box instead of leaving a hole under the row', () => {
    // The pinned row used to sit on that box; in the list's flow the box would
    // only be 38px of blank space.
    expect(sidebar).toMatch(/BOT_DROPPED_ENTRIES[\s\S]{0,400}display = 'none'/)
    expect(sidebar).not.toContain("style.visibility = 'hidden'")
  })

  it('draws an explicit loading and load-failure state instead of an empty list', () => {
    expect(sidebar).toContain('正在加载团队…')
    expect(sidebar).toContain('role="status"')
    expect(sidebar).toContain('团队数据加载失败：')
    expect(sidebar).toContain('setLoaded(true)')
  })

  it('reads only the already-loaded team list, with no new request', () => {
    const data = readFileSync(new URL('../src/client/team-sidebar-data.ts', import.meta.url), 'utf8')
    expect(data).not.toContain('callAgentTeam')
    expect(data).not.toContain('subscribeAgentTeam')
    expect(data).not.toContain("from './api.js'")
  })

  it('leaves no second conversation list in the sidebar', () => {
    // One team row, no nested thread/member rows: the Session header switcher
    // owns that list now.
    expect(sidebar).not.toContain('rosterSubtitle(row)')
    expect(sidebar).not.toContain('teamRosterRows(team)')
    expect(sidebar).not.toContain('data-dsh-team-threads')
    expect(sidebar).not.toContain('data-dsh-team-thread-row')
    expect(sidebar).not.toContain('css.sidebarRosterRow')
  })

  it('keeps the 32px session-row metrics for the assistant list that still uses them', () => {
    expect(css).toMatch(/\.sidebarRosterRow\s*\{[^}]*height: 32px/)
    expect(css).not.toMatch(/\.sidebarTeamThreadRow\s*\{/)
    expect(css).not.toMatch(/\.sidebarTeamExpand\s*\{/)
  })

  it('offers 查看全部会话 in the team row menu, with no per-thread actions', () => {
    expect(sidebar).toContain("{ id: 'sessions', label: '查看全部会话'")
    expect(sidebar).toContain('openTeamSessions(team)')
    expect(sidebar).toContain('keepTeamChatTab(sessionId)')
    expect(sidebar).toMatch(/openTeamSessions[\s\S]{0,300}teamLeaderSessionId\(team\)/)
    expect(sidebar).not.toContain("id: 'open', label: '打开'")
    expect(sidebar).not.toContain("label: '重命名'")
    expect(sidebar).not.toMatch(/id: 'archive',\s+label: '归档'/)
  })

  it('never creates or mutates a thread from the sidebar', () => {
    // Thread writes belong to the header switcher now.
    expect(sidebar).not.toContain('team.thread.create')
    expect(sidebar).not.toContain('team.thread.rename')
    expect(sidebar).not.toContain('team.thread.archive')
    expect(sidebar).not.toContain('data-dsh-team-thread-create')
  })

  it('keeps members reachable from the avatar cluster and the team page', () => {
    expect(sidebar).toContain('teamAvatarStack(team.members)')
    expect(sidebar).toContain('openTeamPage(team.id)')
    expect(sidebar).toContain('const teamCurrent = teamActive')
  })
})

describe('read requests are shared across one mount', () => {
  const respond = (value: unknown) => ({ ok: true, value })
  const stubFetch = (fail = 0) => {
    const calls: string[] = []
    let remainingFailures = fail
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string }
      calls.push(request.method)
      if (remainingFailures > 0) {
        remainingFailures -= 1
        return { json: async () => ({ ok: false, error: { code: 'boom', message: 'boom' } }) }
      }
      return { json: async () => respond({ items: [], total: 0 }) }
    }))
    return calls
  }

  afterEach(() => { vi.unstubAllGlobals() })

  // The settled mount snapshot is module state; start every case without one.
  beforeEach(() => { invalidateTeamListSnapshot() })

  it('shares one team.list between the hosts that mount together', async () => {
    const calls = stubFetch()
    await Promise.all([
      callAgentTeam('team.list'),
      callAgentTeam('team.list'),
      callAgentTeam('team.list'),
    ])
    expect(calls).toEqual(['team.list'])
  })

  it('reuses a settled team.list only inside the page-mount window', async () => {
    const calls = stubFetch()
    await callAgentTeam('team.list')
    // F4: the mount's second reader starts ~450 ms after the first and joins
    // the settled answer instead of POSTing its own team.list.
    await callAgentTeam('team.list')
    expect(calls).toEqual(['team.list'])
    // A team change (or mutation) drops it, so the next read is a real one.
    invalidateTeamListSnapshot()
    await callAgentTeam('team.list')
    expect(calls).toEqual(['team.list', 'team.list'])
  })

  it('keeps different payloads and mutations out of the shared slot', async () => {
    const calls = stubFetch()
    await Promise.all([
      callAgentTeam('team.get', { id: 'team-a' }),
      callAgentTeam('team.get', { id: 'team-b' }),
      callAgentTeam('team.get', { id: 'team-a' }),
      callAgentTeam('team.pin', { teamId: 'team-a', pinned: true }, 1),
      callAgentTeam('team.pin', { teamId: 'team-a', pinned: true }, 1),
    ])
    expect(calls.filter(method => method === 'team.get')).toHaveLength(2)
    expect(calls.filter(method => method === 'team.pin')).toHaveLength(2)
  })

  it('retries after a failed shared read', async () => {
    const calls = stubFetch(1)
    await expect(callAgentTeam('team.list')).rejects.toThrow('boom')
    await callAgentTeam('team.list')
    expect(calls).toEqual(['team.list', 'team.list'])
  })

  it('awaits the catalog instead of firing it and forgetting', () => {
    const source = readFileSync(new URL('../src/client/components.tsx', import.meta.url), 'utf8')
    // Fire-and-forget for the batch, but its own settle state drives the UI.
    expect(source).toContain("void callAgentTeam('catalog.get')")
    expect(source).toContain('setCatalogLoading(true)')
    expect(source).toContain('setCatalogLoading(false)')
    // A change-event burst folds into one reload instead of one per event.
    expect(source).toContain('TEAM_RELOAD_DEBOUNCE_MS')
    // The first connection open is not a recovery: it must not re-read.
    expect(source).toContain('TEAM_RESYNC_SETTLE_MS')
    expect(source).toContain('if (resync && Date.now() - lastLoadAt.current < TEAM_RESYNC_SETTLE_MS) return')
    expect(source).toContain('if (running !== undefined) return running')
  })
})

describe('创建默认成员 waits for the catalog', () => {
  const catalogReady = {
    providers: [{ id: 'xiaomi', name: 'Xiaomi' }],
    models: { xiaomi: [{ id: 'mimo', name: 'MiMo' }] },
    agentPresets: [{ id: 'standard', name: 'Standard' }],
    permissionPresets: [{ value: 'workspace-write', name: 'Workspace write' }],
    workspaces: [],
  } as unknown as CatalogView

  const renderForm = (overrides: { catalog?: CatalogView, catalogLoading?: boolean }) => renderToStaticMarkup(
    createElement(TeamForm, {
      catalog: overrides.catalog,
      ...(overrides.catalogLoading === undefined ? {} : { catalogLoading: overrides.catalogLoading }),
      assistants: [],
      pickWorkspace: async () => null,
      onAssistantsChanged: async () => undefined,
      onCancel: () => undefined,
      onCreated: async () => undefined,
    }),
  )

  it('shows the loading state before the catalog resolves', () => {
    const html = renderForm({ catalogLoading: true })
    expect(html).toContain('正在读取模型与成员模板…')
    expect(html).toContain('data-dsh-team-catalog-loading')
    // The false terminal error and the premature create action are both absent.
    expect(html).not.toContain('当前没有可用的 Provider')
    expect(html).not.toContain('>创建默认成员<')
    expect(html).not.toContain('还没有成员模板。')
  })

  it('offers the create action only after the catalog settled', () => {
    const html = renderForm({ catalogLoading: false })
    expect(html).toContain('还没有成员模板。')
    expect(html).toContain('创建默认成员')
    expect(html).not.toContain('正在读取模型与成员模板…')
  })

  it('keeps the create action enabled when the catalog has a provider', () => {
    const html = renderForm({ catalog: catalogReady, catalogLoading: false })
    expect(html).toContain('创建默认成员')
    expect(html).not.toMatch(/disabled=""[^>]*>创建默认成员/)
  })

  it('never reports a missing provider while the catalog is in flight', () => {
    const panel = readFileSync(new URL('../src/client/teams/TeamPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('if (catalogLoading === true) return')
    // A catalog that never resolved is a load problem, not an empty provider list.
    expect(panel).toContain('还没有读取到模型目录，请稍后重试。')
    expect(panel).toContain("当前没有可用的 Provider")
  })
})

describe('团队模板 in 新建团队', () => {
  const template = TEAM_TEMPLATES[0]!
  const assistants = (ids: string[]): AssistantView[] => ids.map(id => ({
    id,
    name: id.toLocaleUpperCase(),
    enabled: true,
    teamSelectable: true,
  }) as AssistantView)
  const workspaces = [
    { id: 'ws-missing', path: '/missing', title: 'Missing', status: 'missing-dir' },
    { id: 'ws-ok', path: '/ok', title: 'OK', status: 'ok' },
  ] as CatalogView['workspaces']
  const catalog: CatalogView = {
    providers: [],
    models: {},
    agentPresets: [],
    permissionPresets: [],
    workspaces,
  }
  const renderForm = (assistantIds: string[] = []): string => renderToStaticMarkup(
    createElement(TeamForm, {
      catalog,
      catalogLoading: false,
      assistants: assistants(assistantIds),
      pickWorkspace: async () => null,
      onAssistantsChanged: async () => undefined,
      onCancel: () => undefined,
      onCreated: async () => undefined,
    }),
  )

  it('renders 空白 + three templates as one native pressed-button row', () => {
    const html = renderForm()
    expect(html).toContain('团队模板')
    // The picker names each template by its label (队), not its bare team name.
    for (const label of ['空白', '代码库体检队', '功能开发队', '发布检查队']) {
      expect(html).toContain(`>${label}</button>`)
    }
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toContain('aria-pressed="true">空白</button>')
    // Blank creation keeps the form exactly as it was: no brief editor.
    expect(html).not.toContain('首条任务简报')
  })

  it('prefills a template with its name, first usable workspace and ordered assistants', () => {
    const prefill = teamTemplatePrefill(template, assistants(['a1', 'a2', 'a3', 'a4']), workspaces)
    expect(prefill.name).toBe('代码库体检')
    expect(prefill.workspaceId).toBe('ws-ok')
    expect(prefill.assistantIds).toEqual(['a1', 'a2', 'a3', 'a4'])
    expect(prefill.missingAssistants).toBe(false)
  })

  it('repeats assistants only when the template needs more slots than the pool', () => {
    expect(teamTemplatePrefill(template, assistants(['a1', 'a2']), workspaces).assistantIds)
      .toEqual(['a1', 'a2', 'a1', 'a2'])
    const empty = teamTemplatePrefill(template, [], workspaces)
    expect(empty.assistantIds).toEqual([])
    expect(empty.missingAssistants).toBe(true)
    // The name and workspace still prefill; only members are impossible.
    expect(empty.name).toBe('代码库体检')
    expect(empty.workspaceId).toBe('ws-ok')
  })

  it('prefills the brief with all three tasks and every acceptance criterion', () => {
    const brief = teamTemplateBrief(template)
    expect(brief.split('\n').filter(line => /^\d+\./.test(line))).toHaveLength(3)
    for (const task of template.tasks) {
      expect(brief).toContain(task.title)
      for (const criterion of task.acceptance) expect(brief).toContain(criterion)
    }
  })

  it('renames aligned slots to template roles and skips edited membership', () => {
    const started = {
      memberOrder: ['slot-1', 'slot-2', 'slot-3', 'slot-4'],
      members: {
        'slot-1': { id: 'slot-1', assistantId: 'a1', displayName: '通用成员' },
        'slot-2': { id: 'slot-2', assistantId: 'a2', displayName: '审查员' },
        'slot-3': { id: 'slot-3', assistantId: 'a3', displayName: '通用成员' },
        'slot-4': { id: 'slot-4', assistantId: 'a4', displayName: '通用成员' },
      },
    } as unknown as TeamView
    const submitted = [{ assistantId: 'a1' }, { assistantId: 'a2' }, { assistantId: 'a3' }, { assistantId: 'a4' }]
    expect(templateRoleRenames(started, template, submitted)).toEqual([
      { slotId: 'slot-1', displayName: 'Leader' },
      { slotId: 'slot-2', displayName: '审查员 1' },
      { slotId: 'slot-3', displayName: '审查员 2' },
      { slotId: 'slot-4', displayName: '复核员' },
    ])
    // Removing a member makes index-to-role mapping unsafe: rename nothing.
    expect(templateRoleRenames(started, template, submitted.slice(0, 3))).toEqual([])
    expect(templateRoleRenames(started, template, [
      submitted[0]!, submitted[1]!, submitted[2]!, { assistantId: 'other' },
    ])).toEqual([])
  })

  it('gives the two 审查员 slots distinct labels so both renames can land', () => {
    const started = {
      memberOrder: ['slot-1', 'slot-2', 'slot-3', 'slot-4'],
      members: {
        'slot-1': { id: 'slot-1', assistantId: 'a1', displayName: 'Leader' },
        'slot-2': { id: 'slot-2', assistantId: 'a2', displayName: '通用成员' },
        'slot-3': { id: 'slot-3', assistantId: 'a3', displayName: '通用成员' },
        'slot-4': { id: 'slot-4', assistantId: 'a4', displayName: '复核员' },
      },
    } as unknown as TeamView
    const submitted = [{ assistantId: 'a1' }, { assistantId: 'a2' }, { assistantId: 'a3' }, { assistantId: 'a4' }]
    const renames = templateRoleRenames(started, template, submitted)

    expect(renames).toEqual([
      { slotId: 'slot-2', displayName: '审查员 1' },
      { slotId: 'slot-3', displayName: '审查员 2' },
    ])
    // renameMember refuses a name another member owns, and these renames are
    // best effort: distinct labels are what keeps the second one from being
    // swallowed.
    expect(new Set(renames.map(rename => rename.displayName)).size).toBe(renames.length)
  })

  it('sends the brief after start and still opens a created team when it fails', () => {
    const panel = readFileSync(new URL('../src/client/teams/TeamPanel.tsx', import.meta.url), 'utf8')
    const start = panel.indexOf("callAgentTeam('team.start'")
    const send = panel.indexOf("callAgentTeam('team.message.send'")
    const created = panel.indexOf('await onCreated(draft.id)', send)
    expect(start).toBeGreaterThan(0)
    expect(send).toBeGreaterThan(start)
    expect(created).toBeGreaterThan(send)
    expect(panel).toContain('targetSlotId: started.leaderSlotId')
    expect(panel).toContain('Best effort: open the created team even when the brief cannot be sent.')
    // The picker sits before the builder grid, and choosing a template only
    // writes form state through the same helpers tested above.
    const barIndex = panel.indexOf('className={css.teamTemplateBar}')
    const briefIndex = panel.indexOf('className={css.teamTemplateBrief}')
    const gridIndex = panel.indexOf('className={css.teamBuilderGrid}')
    expect(barIndex).toBeGreaterThan(0)
    expect(barIndex).toBeLessThan(briefIndex)
    expect(barIndex).toBeLessThan(gridIndex)
    expect(panel).toContain('onClick={() => { selectTemplate(template.id) }}')
    expect(panel).toContain("onClick={() => { selectTemplate('blank') }}")
    expect(panel).toContain('setName(prefill.name)')
    expect(panel).toContain('setMembers(next)')
    expect(panel).toContain('setBrief(prefill.brief)')
    // The draft payload stays the existing strict shape, with no template link.
    const draftCall = panel.slice(panel.indexOf("callAgentTeam('team.createDraft'"), start)
    expect(draftCall).not.toContain('template')
  })
})

/**
 * The runtime grammar (`resolveTeamTarget`/`findMentions`) is the authority for
 * what a mention means. These tests feed the picker's own output into it, so the
 * affordance cannot drift into writing tokens the router ignores.
 */
describe('@member affordance mirrors the runtime mention grammar', () => {
  const routingTeam = {
    leaderSlotId: 'leader',
    members: {
      leader: { id: 'leader', displayName: 'Leader', role: 'leader' as const },
      alpha: { id: 'alpha', displayName: 'Alpha', role: 'member' as const },
      beta: { id: 'beta', displayName: 'Beta', role: 'member' as const },
    },
  }

  it('writes one token per member and the runtime routes it to that member', () => {
    for (const member of Object.values(routingTeam.members)) {
      const mention = teamMentionText(member.displayName)
      expect(mention).toBe(`@${member.displayName} `)
      expect(resolveTeamTarget({ team: routingTeam, content: `${mention}please take this` }))
        .toEqual({ slotId: member.id, reason: 'mention' })
    }
  })

  it('trims a display name and refuses a blank one', () => {
    expect(teamMentionText('  Alpha  ')).toBe('@Alpha ')
    expect(teamMentionText('')).toBeUndefined()
    expect(teamMentionText('   ')).toBeUndefined()
  })

  it('keeps plain text and unresolvable mentions on the Leader default path', () => {
    expect(resolveTeamTarget({ team: routingTeam, content: 'hello team' }))
      .toEqual({ slotId: 'leader', reason: 'default' })
    // An unknown/blank mention is just text: the runtime must not fail the send.
    expect(resolveTeamTarget({ team: routingTeam, content: '@Ghost hello' }))
      .toEqual({ slotId: 'leader', reason: 'default' })
    expect(resolveTeamTarget({ team: routingTeam, content: '@ hello' }))
      .toEqual({ slotId: 'leader', reason: 'default' })
  })

  it('separates a token inserted right after a word', () => {
    expect(teamMentionInsertion('@Alpha ', '')).toBe('@Alpha ')
    expect(teamMentionInsertion('@Alpha ', 'hello ')).toBe('@Alpha ')
    expect(teamMentionInsertion('@Alpha ', 'hello')).toBe(' @Alpha ')
    // Mirrored end to end: what the picker writes after a word still routes.
    expect(resolveTeamTarget({
      team: routingTeam,
      content: `hello${teamMentionInsertion('@Alpha ', 'hello')}take this`,
    })).toEqual({ slotId: 'alpha', reason: 'mention' })
  })

  it('offers every other member, in roster order, and never the pane itself', () => {
    const team = teamFixture({ members: mentionMembers(), memberOrder: ['beta', 'leader', 'alpha', 'blank'] })
    expect(teamMentionCandidates(team, 'alpha')).toEqual([
      { id: 'beta', name: 'Beta', role: 'member', mention: '@Beta ' },
      { id: 'leader', name: 'Leader', role: 'leader', mention: '@Leader ' },
    ])
    // A blank display name has no routable token, so it is not offered at all.
    expect(teamMentionCandidates(team, 'leader').map(row => row.id)).toEqual(['beta', 'alpha'])
  })
})

describe('@member affordance is an additive composer entry', () => {
  const team = teamFixture({ members: mentionMembers(), memberOrder: ['leader', 'alpha', 'beta'] })

  function renderMention(scope: { team: TeamView; selfSlotId: string } | undefined): string {
    return renderToStaticMarkup(createElement(TeamMentionContext.Provider, { value: scope },
      createElement(TeamMentionAction, {
        inputActions: {
          captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
          insertText: () => true,
          setDraft: () => undefined,
        },
      })))
  }

  it('renders one @ button that opens the native menu inside a group-chat pane', () => {
    const markup = renderMention({ team, selfSlotId: 'leader' })
    expect(markup).toContain('aria-label="提及成员"')
    // The host Menu owns the popover: the trigger advertises a menu, not a
    // bespoke listbox, and stays closed until the composer asks for it.
    expect(markup).toContain('aria-haspopup="menu"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('>@<')
    expect(markup).not.toContain('role="menu"')
    expect(markup).not.toContain('role="listbox"')
  })

  it('renders nothing outside a group-chat pane, or with no one to mention', () => {
    expect(renderMention(undefined)).toBe('')
    const solo = teamFixture({ members: { alpha: mentionMembers().alpha! }, memberOrder: ['alpha'] })
    expect(renderMention({ team: solo, selfSlotId: 'alpha' })).toBe('')
  })
})

function mentionMembers(): TeamView['members'] {
  return {
    leader: {
      id: 'leader',
      displayName: 'Leader',
      role: 'leader',
      sessionId: 'session-leader',
      joinedAt: '2026-01-01T00:00:00.000Z',
    },
    alpha: {
      id: 'alpha',
      displayName: 'Alpha',
      role: 'member',
      sessionId: 'session-alpha',
      joinedAt: '2026-01-01T00:01:00.000Z',
    },
    beta: {
      id: 'beta',
      displayName: 'Beta',
      role: 'member',
      sessionId: 'session-beta',
      joinedAt: '2026-01-01T00:02:00.000Z',
    },
    // A member whose name is only spaces has no routable mention token.
    blank: {
      id: 'blank',
      displayName: '   ',
      role: 'member',
      sessionId: 'session-blank',
      joinedAt: '2026-01-01T00:03:00.000Z',
    },
  } as unknown as TeamView['members']
}

function teamFixture(overrides: Partial<TeamView> & Pick<TeamView, 'members'>): TeamView {
  return {
    id: 'team-mention',
    name: '提及团队',
    leaderSlotId: 'leader',
    tasks: {},
    memberOrder: Object.keys(overrides.members),
    ...overrides,
  } as unknown as TeamView
}

describe('team usage scope', () => {
  it('covers member Sessions, threads, archived threads, removed members and handoffs', () => {
    const team = teamFixture({
      members: {
        leader: {
          id: 'leader',
          displayName: 'Leader',
          role: 'leader',
          sessionId: 'session-leader',
        },
        alpha: {
          id: 'alpha',
          displayName: 'Alpha',
          role: 'member',
          sessionId: 'session-alpha',
        },
      } as unknown as TeamView['members'],
      threads: {
        thread: {
          id: 'thread',
          title: '主线讨论',
          sessionId: 'session-thread',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      retiredThreads: {
        oldThread: {
          id: 'oldThread',
          title: '旧讨论',
          sessionId: 'session-old-thread',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      retiredSessions: {
        gone: {
          formerSlotId: 'gone',
          displayName: '已移除成员',
          sessionId: 'session-gone',
          removedAt: '2026-01-02T00:00:00.000Z',
        },
      },
      // The Leader Session is also a member Session: it must count once.
      retiredLeaderSessionIds: ['session-leader', 'session-old-leader'],
    })

    const scope = teamUsageScope(team)
    expect(scope.map(entry => entry.sessionId)).toEqual([
      'session-leader',
      'session-alpha',
      'session-thread',
      'session-old-thread',
      'session-gone',
      'session-old-leader',
    ])
    expect(scope.filter(entry => entry.retired === true).map(entry => entry.sessionId))
      .toEqual(['session-old-thread', 'session-gone', 'session-old-leader'])
    expect(scope.find(entry => entry.sessionId === 'session-alpha')?.label).toBe('Alpha')
    expect(scope.find(entry => entry.sessionId === 'session-thread')?.label).toBe('主线讨论')
    // The deduplicated Leader row keeps its live label instead of the retired one.
    expect(scope.filter(entry => entry.sessionId === 'session-leader')).toHaveLength(1)
    expect(scope.find(entry => entry.sessionId === 'session-leader')?.retired).toBeUndefined()
  })

  it('rolls the team up from the same host projections as the assistant panel', () => {
    const team = teamFixture({
      members: {
        leader: { id: 'leader', displayName: 'Leader', role: 'leader', sessionId: 'a' },
        alpha: { id: 'alpha', displayName: 'Alpha', role: 'member', sessionId: 'b' },
      } as unknown as TeamView['members'],
      retiredSessions: {},
    })
    const report = usageReport(teamUsageScope(team), {
      phase: 'ready',
      byId: {
        a: {
          projectionValues: {
            tokenUsage: {
              uncachedInputTokens: 100,
              cacheReadTokens: 900,
              cacheWriteTokens: 0,
              outputTokens: 50,
            },
            sessionStats: { turns: 2 },
          },
        },
        b: {
          projectionValues: {
            tokenUsage: {
              uncachedInputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 10,
            },
          },
        },
      },
    })

    expect(report.rollup.tokens).toEqual({
      uncachedInput: 100,
      cacheRead: 900,
      cacheWrite: 0,
      output: 60,
      total: 1060,
    })
    expect(report.rollup.cacheHitPercent).toBe(90)
    expect(report.rollup.turns).toBe(2)
  })
})

describe('team card usage surface', () => {
  const teamPanel = readFileSync(
    new URL('../src/client/teams/TeamPanel.tsx', import.meta.url),
    'utf8',
  )
  const styles = readFileSync(
    new URL('../src/client/AgentTeam.module.css', import.meta.url),
    'utf8',
  )

  it('sits between 团队成员 and TeamMemorySection and reads the host projections', () => {
    const membersAt = teamPanel.indexOf('aria-label="团队成员"')
    const usageAt = teamPanel.indexOf('data-dsh-team-usage')
    const memoryAt = teamPanel.indexOf('<TeamMemorySection')
    expect(membersAt).toBeGreaterThan(-1)
    expect(usageAt).toBeGreaterThan(membersAt)
    expect(memoryAt).toBeGreaterThan(usageAt)
    expect(teamPanel).toContain('scope={teamUsageScope(team)}')
    expect(teamPanel).toContain('emptyHint="团队还没有会话用量"')
    expect(teamPanel).toContain('只读 · 来自宿主会话投影')
  })

  it('renders member rows from the team scope', () => {
    installUsageSessions({
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          byId: {
            a: {
              projectionValues: {
                tokenUsage: {
                  uncachedInputTokens: 100,
                  cacheReadTokens: 900,
                  cacheWriteTokens: 0,
                  outputTokens: 50,
                },
                sessionStats: { turns: 2 },
                contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
              },
            },
          },
        }),
        subscribe: () => () => {},
      },
    })
    try {
      const html = renderToStaticMarkup(createElement(UsageSection, {
        scope: [
          { sessionId: 'a', label: 'Leader' },
          { sessionId: 'gone', label: '已移除成员', retired: true },
        ],
      }))
      const text = html.replace(/<[^>]*>/g, '')
      expect(text).toContain('1.1k')
      expect(text).toContain('缓存命中 90%')
      expect(text).toContain('2 轮')
      expect(text).toContain('上下文 25%')
      expect(text).toContain('已退役')
      expect(html).toContain('data-dsh-usage-row="1"')
      // The team card never prints a Session id; the row keeps it in its click.
      expect(html).not.toContain('data-dsh-usage-session="')
      expect(text).toContain('— tok · 轮数 — · 缓存 — · 上下文 —')
    } finally {
      installUsageSessions(undefined)
    }
  })

  it('styles only with semantic tokens and never fixes or layers the panel', () => {
    const block = styles.slice(styles.indexOf('/* 用量'))
    expect(block).toContain('var(--dsw-alias-label-primary)')
    expect(block).toContain('var(--dsw-radius-md)')
    expect(block).not.toMatch(/position:\s*fixed|z-index|!important|#[0-9a-f]{3,6}\b|rgba?\(/i)
    expect(block).not.toMatch(/(^|\n)\s*body\b/)
  })
})

describe('team usage repair-round edges', () => {
  it('closes the management modal before opening a Session from a usage row', () => {
    const teamPanel = readFileSync(
      new URL('../src/client/teams/TeamPanel.tsx', import.meta.url),
      'utf8',
    )
    const dialogs = readFileSync(
      new URL('../src/client/team-dialogs.tsx', import.meta.url),
      'utf8',
    )

    // The team card threads its host's navigation into the shared panel…
    expect(teamPanel).toContain('{...(onOpenSession === undefined ? {} : { onOpenSession })}')
    // …and the modal host is the one that knows the dialog must close first.
    expect(dialogs).toContain(
      'onOpenSession={sessionId => { closeTeamDialog(); openSession(sessionId) }}',
    )
    expect(dialogs.indexOf('closeTeamDialog()')).toBeLessThan(dialogs.indexOf('openSession(sessionId)'))
    // The team surface never bypasses that ordering through the global opener.
    expect(teamPanel).not.toContain('openAssistantSession(sessionId)')
    // The shared panel prefers the host's navigation and falls back to the bridge.
    const usageSource = readFileSync(new URL('../src/client/usage.ts', import.meta.url), 'utf8')
    expect(usageSource).toContain('if (onOpenSession !== undefined)')
    expect(usageSource.indexOf('onOpenSession(sessionId)'))
      .toBeLessThan(usageSource.indexOf('openAssistantSession(sessionId)'))
  })

  it('renders the unread note and “—” for a failed projection read', () => {
    installUsageSessions({
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          byId: {},
          projectionsBySession: { a: { values: {}, state: 'error' } },
        }),
        subscribe: () => () => {},
      },
    })
    try {
      const html = renderToStaticMarkup(createElement(UsageSection, {
        scope: [{ sessionId: 'a', label: 'Leader' }],
      }))
      const text = html.replace(/<[^>]*>/g, '')

      expect(text).toContain('部分会话暂无法读取，合计只含已读取的 0 个会话')
      expect(text).toContain('缓存命中 —')
      expect(text).toContain('Leader')
      expect(text).toContain('— tok · 轮数 — · 缓存 — · 上下文 —')
    } finally {
      installUsageSessions(undefined)
    }
  })
})

describe('公告 · one editor, team and 分区 scopes', () => {
  const teamPanel = readFileSync(
    new URL('../src/client/teams/TeamPanel.tsx', import.meta.url),
    'utf8',
  )
  const editor = readFileSync(
    new URL('../src/client/announcement-dialog.tsx', import.meta.url),
    'utf8',
  )
  const styles = readFileSync(
    new URL('../src/client/AgentTeam.module.css', import.meta.url),
    'utf8',
  )

  it('renders the current announcement read-only on the team detail', () => {
    const html = renderToStaticMarkup(createElement(TeamAnnouncementSection, {
      announcement: '冻结期：只提交修复。\n第二行保持原样。',
    }))
    expect(html).toContain('aria-label="团队公告"')
    expect(html).toContain('data-dsh-team-announcement')
    expect(html).toContain('每位成员的下一轮对话都会读到')
    expect(html).toContain('冻结期：只提交修复。')
    // The display is read-only: editing lives in the user-only modal.
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('<input')
  })

  it('hides the display when the team has no announcement', () => {
    for (const absent of [undefined, '', '   ']) {
      expect(renderToStaticMarkup(createElement(TeamAnnouncementSection, {
        announcement: absent,
      }))).toBe('')
    }
  })

  it('opens the team scope with the stored text and no revision fence', () => {
    const html = renderToStaticMarkup(createElement(AnnouncementDialog, {
      scope: 'team',
      team: team({ announcement: '提交前跑 npm run check。' }),
      onClose: () => {},
      onChanged: async () => {},
    }))
    expect(html).toContain('团队公告')
    expect(html).toContain('data-dsh-team-announcement-input')
    expect(html).toContain('提交前跑 npm run check。')
    expect(html).toContain(teamAnnouncementUsage('提交前跑 npm run check。'))
    expect(html).toContain('保存公告')
    expect(html).toContain('清除公告')
    // Only the user transport writes; a revision fence would be a second guard
    // the 分区 precedent does not have.
    expect(editor).toContain("callAgentTeam('team.announcement.set', { teamId, announcement })")
    // After the write the aggregate reload finishes before the dialog closes, so
    // the next member turn reads the new text.
    const callAt = editor.indexOf("callAgentTeam('team.announcement.set'")
    expect(callAt).toBeGreaterThan(-1)
    const reloadAt = editor.indexOf('await onTeamChanged?.()', callAt)
    expect(reloadAt).toBeGreaterThan(callAt)
    expect(editor.indexOf('onClose()', reloadAt)).toBeGreaterThan(reloadAt)
    // Clear is the same route with blank text; the service drops the field.
    expect(editor).toContain("void writeTeamAnnouncement('')")
    // TeamCard opens the same editor with the team scope.
    expect(teamPanel).toContain('<AnnouncementDialog')
    expect(teamPanel).toContain('scope="team"')
  })

  it('offers clear only when there is something to clear', () => {
    const empty = renderToStaticMarkup(createElement(AnnouncementDialog, {
      scope: 'team',
      team: team(),
      onClose: () => {},
      onChanged: async () => {},
    }))
    expect(empty).toContain('公告内容')
    expect(empty).not.toMatch(/<button[^>]*>清除公告<\/button>/)
  })

  it('switches caps per scope instead of borrowing one number', () => {
    // The client repeats the number to stay Zod-free; this pin keeps the two
    // copies from drifting apart.
    expect(TEAM_ANNOUNCEMENT_UI_LIMIT).toBe(TEAM_ANNOUNCEMENT_MAX_CHARS)
    expect(TEAM_ANNOUNCEMENT_UI_LIMIT).toBe(2_000)
    expect(announcementUsage('team', '公告')).toBe(`2 / ${TEAM_ANNOUNCEMENT_MAX_CHARS}`)
    expect(announcementUsage('group', '公告')).toBe(`2 / ${SIDEBAR_GROUP_BRIEF_MAX_CHARS}`)
    expect(announcementError('team', 'x'.repeat(TEAM_ANNOUNCEMENT_MAX_CHARS))).toBeUndefined()
    expect(announcementError('team', 'x'.repeat(TEAM_ANNOUNCEMENT_MAX_CHARS + 3)))
      .toBe(`公告最多 ${TEAM_ANNOUNCEMENT_MAX_CHARS} 个字符，请删减 3 个字符`)
    // The 分区 scope keeps the Host's 24 KB brief cap; neither cap leaks.
    expect(SIDEBAR_GROUP_BRIEF_MAX_CHARS).toBe(24_576)
    expect(announcementError('group', 'x'.repeat(SIDEBAR_GROUP_BRIEF_MAX_CHARS))).toBeUndefined()
    expect(announcementError('group', 'x'.repeat(SIDEBAR_GROUP_BRIEF_MAX_CHARS + 1))).toBeDefined()
  })

  it('keeps the blank semantics apart: team trims and deletes, 分区 stores verbatim', () => {
    expect(teamAnnouncementText('   ')).toBe('')
    expect(teamAnnouncementText('  冻结  ')).toBe('冻结')
    // Whitespace-only edits are not dirty for the team, but they are for a
    // brief, which stores the exact text (empty string, never undefined).
    expect(announcementDirty('team', '  ', '')).toBe(false)
    expect(announcementDirty('team', ' 冻结 ', '冻结')).toBe(false)
    expect(announcementDirty('group', '', '')).toBe(false)
    expect(announcementDirty('group', '  ', '')).toBe(true)
    expect(announcementDirty('group', '冻结 ', '冻结')).toBe(true)
  })

  it('opens the 分区 scope for a group with no team', () => {
    const html = renderToStaticMarkup(createElement(AnnouncementDialog, {
      scope: 'group',
      name: '工作',
      onClose: () => {},
    }))
    expect(html).toContain('正在读取公告…')
    expect(html).not.toContain('data-dsh-team-announcement-input')
    // The scope label and the group-only props: no team is required to open it.
    expect(editor).toContain('`「${name}」的公告`')
    expect(editor).toContain("scope: 'group'; name: string; onClose: () => void")
    expect(editor).toContain("callAgentTeam('sidebar.groups.briefs')")
    expect(editor).toContain("callAgentTeam('sidebar.groups.brief.set', {")
  })

  it('wires the user entry point into the team card header and no agent tool', () => {
    expect(teamPanel).toContain('<TeamAnnouncementSection announcement={team.announcement} />')
    // The team card is the only announcement entry left; the removed
    // TeamPanel/TeamWorkbench toolbar took its copy (and its CSS) with it.
    expect(teamPanel.match(/setAnnouncementOpen\(true\)/g)).toHaveLength(1)
    expect(teamPanel).toMatch(/announcement === '' \? '添加公告' : '编辑公告'/)
    expect(teamPanel).not.toContain('css.workbenchAnnouncement')
    expect(styles).not.toContain('.workbenchAnnouncement')
    expect(teamPanel).toContain('每位成员的下一轮对话都会读到')
    // The prompt/tool surface stays untouched: no member-facing announcement tool.
    const tools = readFileSync(new URL('../src/runtime/team-tools.ts', import.meta.url), 'utf8')
    expect(tools).not.toMatch(/announcement/i)
  })

  it('styles the announcement with native tokens only, never a fixed layer', () => {
    const start = styles.indexOf('/* 团队公告')
    const block = styles.slice(start, styles.indexOf('.teamMemorySection', start))
    expect(start).toBeGreaterThan(-1)
    expect(block).toContain('var(--dsw-alias-label-primary)')
    expect(block).toContain('var(--dsw-alias-border-l2)')
    expect(block).toContain('var(--dsw-radius-md)')
    expect(block).not.toMatch(/position:\s*fixed|z-index|!important|#[0-9a-f]{3,6}\b|rgba?\(/i)
    expect(block).not.toMatch(/(^|\n)\s*body\b/)
  })
})
