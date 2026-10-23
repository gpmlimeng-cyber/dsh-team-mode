import { describe, expect, it } from 'vitest'
import type { TeamTask } from '../src/domain/types.js'
import type { TeamView } from '../src/transport/contracts.js'
import {
  compareTeamSidebar,
  recentTeamTasks,
  teamSidebarStatusText,
  teamSidebarSummary,
} from '../src/client/team-sidebar-data.js'

const NOW = '2026-01-01T00:00:00.000Z'

type SidebarFixture = Partial<Pick<TeamView, 'members' | 'tasks' | 'pinned' | 'updatedAt' | 'id' | 'name'>>

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
    expect(teamSidebarSummary(team())).toEqual({ members: 0, running: 0, waiting: 0 })
  })

  it('counts one member slot whatever its runtime state', () => {
    const summary = teamSidebarSummary(team({ members: members({ leader: 'idle' }) }))
    expect(summary).toEqual({ members: 1, running: 0, waiting: 0 })
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
    expect(summary).toEqual({ members: 5, running: 2, waiting: 1 })
  })
})

describe('teamSidebarStatusText', () => {
  it('reads an idle team as members plus 空闲', () => {
    expect(teamSidebarStatusText({ members: 3, running: 0, waiting: 0 })).toBe('3 人 · 空闲')
  })

  it('drops 空闲 once a member is running', () => {
    expect(teamSidebarStatusText({ members: 3, running: 2, waiting: 0 })).toBe('3 人 · 2 运行')
  })

  it('shows the waiting count last when approvals are pending', () => {
    expect(teamSidebarStatusText({ members: 3, running: 2, waiting: 1 })).toBe('3 人 · 2 运行 · 1 待审批')
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
})
