import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TeamTask } from '../src/domain/types.js'
import type { TeamView } from '../src/transport/contracts.js'
import {
  compareTeamSidebar,
  recentTeamTasks,
  teamScopeCounts,
  teamSidebarStatusText,
  teamSidebarSummary,
} from '../src/client/team-sidebar-data.js'

const NOW = '2026-01-01T00:00:00.000Z'

type SidebarFixture = Partial<Pick<
  TeamView,
  'members' | 'tasks' | 'pinned' | 'updatedAt' | 'id' | 'name' | 'archivedAt' | 'state'
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
    expect(summary).toEqual({ members: 5, running: 2, waiting: 1, waitingDependency: 0 })
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

  it('ignores tasks that carry dependencies but are not blocked', () => {
    const summary = teamSidebarSummary(team({
      tasks: {
        impl: task({ id: 'impl', status: 'running' }),
        pending: task({ id: 'pending', status: 'pending', dependencyIds: ['impl'] }),
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
