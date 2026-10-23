import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TeamOverview, sessionForTask } from '../src/client/team-overview.js'
import type { TeamMemberSlot, TeamMessage, TeamTask } from '../src/domain/types.js'
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

function task(id: string, status: TeamTask['status'], overrides: Partial<TeamTask> = {}): TeamTask {
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

function message(id: string, overrides: Partial<TeamMessage> = {}): TeamMessage {
  return {
    schemaVersion: 1,
    id,
    teamId: 'team-overview',
    sender: { kind: 'member', id: 'helper' },
    recipient: { kind: 'leader', slotId: 'leader' },
    type: 'progress',
    content: id,
    attachments: [],
    readBy: [],
    deliveryState: 'delivered',
    idempotencyKey: `key-${id}`,
    createdAt: ISO,
    ...overrides,
  }
}

function team(input: {
  members?: TeamMemberSlot[]
  tasks?: TeamTask[]
  leaderSlotId?: string
  name?: string
} = {}): TeamView {
  return {
    schemaVersion: 2,
    id: 'team-overview',
    name: input.name ?? '总览测试团队',
    workspaceId: 'workspace-overview',
    workspacePath: '/tmp/overview',
    leaderSlotId: input.leaderSlotId ?? 'leader',
    state: 'active',
    directMemberChat: false,
    members: Object.fromEntries((input.members ?? []).map(entry => [entry.id, entry])),
    retiredSessions: {},
    tasks: Object.fromEntries((input.tasks ?? []).map(entry => [entry.id, entry])),
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
  }
}

function render(options: {
  team: TeamView
  tasks?: TeamTask[]
  messages?: TeamMessage[]
  selectedTaskId?: string
  messagesLoading?: boolean
  messagesError?: string
  onSelectTask?: (taskId: string) => void
  onOpenSession?: (sessionId: string) => void
}): string {
  return renderToStaticMarkup(createElement(TeamOverview, {
    team: options.team,
    tasks: options.tasks ?? [],
    messages: options.messages ?? [],
    ...(options.selectedTaskId === undefined ? {} : { selectedTaskId: options.selectedTaskId }),
    ...(options.messagesLoading === undefined ? {} : { messagesLoading: options.messagesLoading }),
    ...(options.messagesError === undefined ? {} : { messagesError: options.messagesError }),
    onSelectTask: options.onSelectTask ?? (() => undefined),
    onOpenSession: options.onOpenSession ?? (() => undefined),
  }))
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The first element carrying one `data-overview-region` marker. */
function region(html: string, name: string): string {
  const marker = `data-overview-region="${name}"`
  const index = html.indexOf(marker)
  if (index < 0) return ''
  const start = html.lastIndexOf('<', index)
  const end = html.indexOf('</section>', index)
  return end < 0 ? html.slice(start) : html.slice(start, end + '</section>'.length)
}

function source(name: string): string {
  return readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
}

const leader = member('leader', {
  role: 'leader',
  displayName: '小码',
  lastRuntimeState: 'running',
})
const helper = member('helper', {
  displayName: '小测',
  lastRuntimeState: 'idle',
  assistantSnapshot: {
    ...member('helper').assistantSnapshot,
    model: 'deepseek-reasoner',
  },
})
const idle = member('idle', { displayName: '小空' })

const impl = task('impl', 'running', {
  title: '实现总览',
  ownerSlotId: 'leader',
  updatedAt: '2026-01-01T04:00:00.000Z',
})
const verify = task('verify', 'blocked', {
  title: '验收总览',
  ownerSlotId: 'helper',
  dependencyIds: ['impl'],
  updatedAt: '2026-01-01T03:00:00.000Z',
})
const deep = task('deep', 'pending', {
  title: '补齐测试',
  ownerSlotId: 'helper',
  dependencyIds: ['verify'],
  updatedAt: '2026-01-01T02:00:00.000Z',
})
const split = task('split', 'assigned', {
  title: '补齐样式',
  dependencyIds: ['impl'],
  updatedAt: '2026-01-01T01:00:00.000Z',
})

const populated = team({
  members: [leader, helper, idle],
  tasks: [impl, verify, deep, split],
})

describe('TeamOverview summary and progress', () => {
  it('summarizes dispatch and counts all four progress buckets', () => {
    const view = text(render({ team: populated, tasks: [impl, verify, deep, split] }))

    expect(view).toContain('Leader 摘要')
    expect(view).toContain('任务进度')
    expect(view).toContain('小码')
    expect(view).toContain('已派发 4 项任务给 2 名成员')
    expect(view).toContain('共 4 个任务，已完成 0，进行中 1，等待 2，异常 1')
    expect(view).toContain('已完成 0')
    expect(view).toContain('进行中 1')
    expect(view).toContain('等待 2')
    expect(view).toContain('异常 1')
  })

  it('renders member chips with owner and model, and a no-task member honestly', () => {
    const view = text(render({ team: populated, tasks: [impl, verify, deep, split] }))

    expect(view).toContain('小测')
    expect(view).toContain('deepseek-reasoner')
    expect(view).toContain('实现总览')
    expect(view).toContain('小空')
    expect(view).toContain('暂无任务')
  })

  it('shows explicit empty states for a team with no tasks or messages', () => {
    const html = render({ team: team({ members: [leader] }) })
    const view = text(html)

    expect(view).toContain('还没有任务，Leader 派发后会出现在这里')
    expect(view).toContain('暂无任务')
    expect(view).toContain('暂无待处理消息')
    expect(view).toContain('共 0 个任务，已完成 0，进行中 0，等待 0，异常 0')
    expect(html).not.toContain('undefined')
  })
})

describe('TeamOverview dependency graph', () => {
  it('layers a chain and a split by dependency depth', () => {
    const html = render({ team: populated, tasks: [impl, verify, deep, split] })
    const graph = region(html, 'dependency-graph')

    expect(graph.match(/data-depth="\d+"/g)).toEqual([
      'data-depth="0"',
      'data-depth="1"',
      'data-depth="2"',
    ])
    expect(graph).toContain('data-task-id="impl"')
    expect(graph).toContain('data-task-id="verify"')
    expect(graph).toContain('data-task-id="deep"')
    expect(graph).toContain('data-task-id="split"')
  })

  it('says when tasks have no dependencies but keeps the nodes', () => {
    const view = text(render({ team: populated, tasks: [impl] }))

    expect(view).toContain('任务暂无依赖')
    expect(view).toContain('实现总览')
  })

  it('keeps cycle members and their dependents in the unlayered area with a warning', () => {
    const cycleA = task('a', 'running', { title: '循环甲', dependencyIds: ['b'] })
    const cycleB = task('b', 'running', { title: '循环乙', dependencyIds: ['a'] })
    const downstream = task('c', 'pending', { title: '循环下游', dependencyIds: ['a'] })
    const free = task('free', 'pending', { title: '自由任务' })
    const html = render({ team: populated, tasks: [cycleA, cycleB, downstream, free] })
    const view = text(html)
    const graph = region(html, 'dependency-graph')

    expect(view).toContain('循环依赖')
    expect(view).toContain('未分层')
    expect(view).toContain('循环甲')
    expect(view).toContain('循环乙')
    expect(view).toContain('循环下游')
    expect(graph).toContain('data-depth="0"')
    expect(graph.match(/data-task-id=/g)).toHaveLength(4)
  })
})

describe('TeamOverview task detail', () => {
  it('shows owner, dependencies and unlocks for the selected task', () => {
    const html = render({
      team: populated,
      tasks: [impl, verify, deep, split],
      selectedTaskId: 'verify',
    })
    const detail = text(region(html, 'task-detail'))

    expect(detail).toContain('验收总览')
    expect(detail).toContain('小测')
    expect(detail).toContain('依赖')
    expect(detail).toContain('实现总览')
    expect(detail).toContain('被依赖')
    expect(detail).toContain('补齐测试')
    expect(detail).toContain('打开成员会话')
    expect(sessionForTask(populated, verify)).toBe('session-helper')
  })

  it('falls back to the newest running task when the selection is gone', () => {
    const detail = text(region(render({
      team: populated,
      tasks: [impl, verify, deep, split],
      selectedTaskId: 'deleted-task',
    }), 'task-detail'))

    expect(detail).toContain('实现总览')
    expect(detail).toContain('原选中任务已移除')
  })

  it('offers no session action for an unassigned task', () => {
    const detail = region(render({
      team: populated,
      tasks: [split],
      selectedTaskId: 'split',
    }), 'task-detail')

    expect(detail).toContain('未分配')
    expect(sessionForTask(populated, split)).toBeUndefined()
    expect(detail).not.toContain('打开成员会话')
  })
})

describe('TeamOverview leader inbox', () => {
  const mail = [
    message('one', { content: '消息一', createdAt: '2026-01-01T01:00:00.000Z' }),
    message('two', { content: '消息二', createdAt: '2026-01-01T02:00:00.000Z' }),
    message('three', { content: '消息三', createdAt: '2026-01-01T03:00:00.000Z' }),
    message('four', { content: '消息四', createdAt: '2026-01-01T04:00:00.000Z' }),
    message('five', { content: '消息五', createdAt: '2026-01-01T05:00:00.000Z' }),
    message('six', { content: '消息六', createdAt: '2026-01-01T06:00:00.000Z' }),
    message('seven', { content: '消息七', createdAt: '2026-01-01T07:00:00.000Z' }),
    message('system', {
      type: 'system',
      content: '系统通知',
      createdAt: '2026-01-01T08:00:00.000Z',
    }),
    message('broadcast', {
      recipient: { kind: 'broadcast' },
      content: '全体通知',
      createdAt: '2026-01-01T08:00:00.000Z',
    }),
    message('member-mail', {
      recipient: { kind: 'member', slotId: 'helper' },
      content: '给成员的通知',
      createdAt: '2026-01-01T08:00:00.000Z',
    }),
  ]

  it('shows only Leader-addressed non-system mail, newest five', () => {
    const view = text(region(render({ team: populated, tasks: [impl], messages: mail }), 'leader-inbox'))

    expect(view).toContain('消息七')
    expect(view).toContain('消息六')
    expect(view).toContain('消息五')
    expect(view).toContain('消息四')
    expect(view).toContain('消息三')
    expect(view).not.toContain('消息一')
    expect(view).not.toContain('系统通知')
    expect(view).not.toContain('全体通知')
    expect(view).not.toContain('给成员的通知')
  })

  it('shows an explicit empty state, loading state and error state', () => {
    expect(text(render({ team: populated }))).toContain('暂无待处理消息')
    expect(text(render({ team: populated, messagesLoading: true }))).toContain('正在加载收件箱')
    expect(text(render({ team: populated, messagesError: '网络错误' }))).toContain('收件箱加载失败')
  })
})

describe('board switch and static layout contract', () => {
  it('wires the persisted overview/tasks switch and the overview panel into the board', () => {
    const board = source('team-board.tsx')

    expect(board).toContain("const VIEW_STORAGE_KEY = 'dsh-team-mode:team-board:view'")
    expect(board).toContain('defaultBoardMode(tasks)')
    expect(board).toContain('readStorageJson(VIEW_STORAGE_KEY)')
    expect(board).toContain('reviveBoardMode')
    expect(board).toContain('writeStorageJson(VIEW_STORAGE_KEY, next)')
    expect(board).toContain('<TeamOverview')
    expect(board).toContain("aria-pressed={mode === 'overview'}")
    expect(board).toContain("aria-pressed={mode === 'tasks'}")
    expect(board).toContain("mode === 'overview'")
  })

  it('keeps the task column board behind the tasks mode', () => {
    const board = source('team-board.tsx')

    expect(board).toContain("mode === 'overview' ? (")
    expect(board).toContain('<div className={css.memberColumns}')
    expect(board).toContain("mode === 'tasks' && (")
  })

  it('stacks at narrow widths and lets only the dependency graph scroll horizontally', () => {
    const moduleCss = source('AgentTeam.module.css')
    const main = moduleCss.match(/\.overviewMain \{([^}]*)\}/)?.[1] ?? ''
    const viewport = moduleCss.match(/\.overviewGraphViewport \{([^}]*)\}/)?.[1] ?? ''
    const layers = moduleCss.match(/\.overviewLayers \{([^}]*)\}/)?.[1] ?? ''

    expect(main).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(viewport).toContain('overflow-x: auto')
    expect(viewport).not.toContain('overflow: hidden')
    expect(layers).toContain('min-width: max-content')
    expect(moduleCss).toContain('@container board (min-width: 50rem)')
  })
})
