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
  visibleTasks?: TeamTask[]
  messages?: TeamMessage[]
  selectedTaskId?: string
  messagesLoading?: boolean
  messagesError?: string
  onClearFilters?: () => void
  onSelectTask?: (taskId: string) => void
  onOpenSession?: (sessionId: string) => void
}): string {
  return renderToStaticMarkup(createElement(TeamOverview, {
    team: options.team,
    tasks: options.tasks ?? [],
    ...(options.visibleTasks === undefined ? {} : { visibleTasks: options.visibleTasks }),
    messages: options.messages ?? [],
    ...(options.selectedTaskId === undefined ? {} : { selectedTaskId: options.selectedTaskId }),
    ...(options.messagesLoading === undefined ? {} : { messagesLoading: options.messagesLoading }),
    ...(options.messagesError === undefined ? {} : { messagesError: options.messagesError }),
    ...(options.onClearFilters === undefined ? {} : { onClearFilters: options.onClearFilters }),
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
    const html = render({ team: populated, tasks: [impl, verify, deep, split] })
    const view = text(html)

    expect(html).toContain('aria-valuetext=')
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
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('aria-valuemax="0"')
    expect(html).not.toContain('undefined')
  })

  it('keeps team-wide totals when a filter hides every task', () => {
    const html = render({
      team: populated,
      tasks: [impl, verify, deep, split],
      visibleTasks: [],
      onClearFilters: () => undefined,
    })
    const view = text(html)

    expect(view).toContain('已派发 4 项任务给 2 名成员')
    expect(view).toContain('共 4 个任务，已完成 0，进行中 1，等待 2，异常 1')
    expect(view).toContain('当前筛选下没有任务')
    expect(view).toContain('团队全量')
    expect(view).not.toContain('还没有任务，Leader 派发后会出现在这里')
    expect(view).toContain('实现总览')
    expect(region(html, 'filter-empty')).toContain('清除筛选')
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
    expect(graph).toContain('依赖 · 实现总览')
    expect(graph).toContain('解锁 · 验收总览')
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

    expect(view).toContain('存在循环或缺失依赖')
    expect(view).toContain('未分层')
    expect(view).toContain('循环甲')
    expect(view).toContain('循环乙')
    expect(view).toContain('循环下游')
    expect(graph).toContain('data-depth="0"')
    expect(graph.match(/data-task-id=/g)).toHaveLength(4)
  })

  it('keeps tasks with missing dependencies in the unlayered area', () => {
    const orphan = task('orphan', 'pending', {
      title: '孤儿任务',
      dependencyIds: ['deleted-task'],
    })
    const html = render({ team: populated, tasks: [orphan, impl] })
    const view = text(html)
    const graph = region(html, 'dependency-graph')

    expect(view).toContain('存在循环或缺失依赖')
    expect(graph).toContain('data-task-id="orphan"')
    expect(graph).toContain('缺失 deleted-')
  })

  it('hides filtered-out nodes but keeps the selection in the detail', () => {
    const html = render({
      team: populated,
      tasks: [impl, verify, deep, split],
      visibleTasks: [impl],
      selectedTaskId: 'verify',
    })
    const graph = region(html, 'dependency-graph')
    const detail = text(region(html, 'task-detail'))

    expect(graph).not.toContain('data-task-id="verify"')
    expect(detail).toContain('验收总览')
    expect(detail).toContain('当前筛选已隐藏该任务')
    expect(detail).not.toContain('原选中任务已移除')
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

describe('TeamOverview task timeline', () => {
  const eventAt = (index: number, overrides: Partial<TeamMessage> = {}): TeamMessage => message(
    `event-${index + 1}`,
    {
      relatedTaskId: 'impl',
      content: `第${index + 1}条`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      ...overrides,
    },
  )

  it('shows only the selected task events, oldest first with the newest last', () => {
    const html = render({
      team: populated,
      tasks: [impl],
      selectedTaskId: 'impl',
      messages: [
        message('other-task', { relatedTaskId: 'verify', content: '别的任务' }),
        message('unrelated', { content: '团队闲聊' }),
        message('thread-only', {
          threadId: 'impl',
          content: '线程事件',
          createdAt: '2026-01-01T05:00:00.000Z',
        }),
        eventAt(0),
        eventAt(1),
      ],
    })
    const timeline = region(html, 'task-timeline')
    const view = text(timeline)

    expect(view).toContain('任务动态')
    expect(view).toContain('第1条')
    expect(view).toContain('第2条')
    expect(view).toContain('线程事件')
    expect(view).not.toContain('别的任务')
    expect(view).not.toContain('团队闲聊')
    // Newest-last: the later event prints after the earlier one.
    expect(timeline.indexOf('第1条')).toBeLessThan(timeline.indexOf('第2条'))
    expect(timeline.indexOf('第2条')).toBeLessThan(timeline.indexOf('线程事件'))
  })

  it('caps the collapsed timeline at 20 rows and offers an inline expand-all', () => {
    const html = render({
      team: populated,
      tasks: [impl],
      selectedTaskId: 'impl',
      messages: Array.from({ length: 23 }, (_, index) => eventAt(index)),
    })
    const timeline = region(html, 'task-timeline')
    const rows = timeline.match(/data-dsh-task-event=/g) ?? []

    expect(rows).toHaveLength(20)
    // The collapsed window is the newest 20; the first three scrolled out.
    expect(text(timeline)).not.toContain('第1条')
    expect(text(timeline)).not.toContain('第3条')
    expect(text(timeline)).toContain('第4条')
    expect(text(timeline)).toContain('第23条')
    expect(timeline).toContain('aria-expanded="false"')
    expect(text(timeline)).toContain('展开全部（23）')
    // Expanding is local state, not a second read.
    expect(source('team-overview.tsx')).toContain('setExpanded(value => !value)')
  })

  it('shows sender, type, time, summary, attachments and a failed delivery', () => {
    const html = render({
      team: populated,
      tasks: [impl],
      selectedTaskId: 'impl',
      messages: [message('event', {
        relatedTaskId: 'impl',
        type: 'result',
        summary: '摘要行',
        content: '正文不应出现在摘要里',
        attachments: [
          { kind: 'workspace_path', value: '/tmp/a.txt' },
          { kind: 'url', value: 'https://example.test/b' },
        ],
        deliveryState: 'failed',
        createdAt: '2026-01-01T06:30:00.000Z',
      })],
    })
    const timeline = text(region(html, 'task-timeline'))

    expect(timeline).toContain('小测')
    expect(timeline).toContain('结果')
    expect(timeline).toContain('摘要行')
    expect(timeline).not.toContain('正文不应出现在摘要里')
    expect(timeline).toContain('2 个附件')
    expect(timeline).toContain('投递失败')
    expect(timeline).toMatch(/\d{1,2}:\d{2}/)
  })

  it('keeps empty, loading and error states explicit', () => {
    const base = { team: populated, tasks: [impl], selectedTaskId: 'impl' }

    expect(text(region(render(base), 'task-timeline'))).toContain('暂无任务动态')
    expect(text(region(render({ ...base, messagesLoading: true }), 'task-timeline')))
      .toContain('正在加载任务动态')
    expect(text(region(render({ ...base, messagesError: '网络错误' }), 'task-timeline')))
      .toContain('任务动态加载失败：网络错误')
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

  it('shows only Leader-addressed non-system mail, newest five, with an inline expand', () => {
    const inboxHtml = region(render({ team: populated, tasks: [impl], messages: mail }), 'leader-inbox')
    const view = text(inboxHtml)

    expect(inboxHtml).toContain('aria-expanded="false"')
    expect(view).toContain('查看全部（7）')
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

  it('clamps a long fallback preview to a fixed character budget', () => {
    const longBody = '长'.repeat(200)
    const html = render({
      team: populated,
      tasks: [impl],
      messages: [message('long', { content: longBody, createdAt: '2026-01-01T09:00:00.000Z' })],
    })
    const view = text(html)

    expect(view).toContain(`${'长'.repeat(120)}…`)
    expect(view).not.toContain('长'.repeat(121))
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
    expect(board).toContain('tasks={tasks}')
    expect(board).toContain('visibleTasks={visibleTasks}')
    expect(board).toContain('onClearFilters={clearFilters}')
    expect(board).not.toContain('tasks={baseTasks}')
    expect(board).toContain("aria-pressed={mode === 'overview'}")
    expect(board).toContain("aria-pressed={mode === 'tasks'}")
    expect(board).toContain("mode === 'overview'")
  })

  it('keeps the task column board behind the tasks mode', () => {
    const board = source('team-board.tsx')

    expect(board).toContain("mode === 'overview' ? (")
    expect(board).toContain('<div className={css.memberColumns}')
    expect(board).toContain('<div className={css.toolbar}>')
    expect(board).not.toContain("mode === 'tasks' && (")
  })

  it('loads team messages once and hands them to the task-detail timeline', () => {
    const board = source('team-board.tsx')
    const overview = source('team-overview.tsx')

    // One mailbox read for the whole board; the timeline never refetches.
    expect(board.match(/callAgentTeam\('team\.message\.list'/g) ?? []).toHaveLength(1)
    expect(board).toContain('messages={scopedMessages}')
    expect(board).toContain('messagesLoading={inboxLoading}')
    expect(board).toContain('messagesError={messagesError}')
    expect(overview).not.toContain('callAgentTeam(')
    expect(overview).toContain('function TaskTimeline')
    expect(overview).toContain('message.relatedTaskId === task.id || message.threadId === task.id')
    expect(overview).toContain('messages={messages}')
  })

  it('removed the board feed and the 活动 tab, keeping the Leader inbox', () => {
    const board = source('team-board.tsx')
    const dialogs = source('team-dialogs.tsx')

    expect(() => source('team-activity.tsx')).toThrow()
    expect(board).not.toContain('ActivityRow')
    expect(board).not.toContain('feedResult')
    expect(board).not.toContain('FeedItem')
    expect(dialogs).not.toContain('TeamActivityBoard')
    expect(dialogs).not.toContain('活动')
    // The inbox is still the only mailbox surface in the overview.
    expect(source('team-overview.tsx')).toContain('aria-label="Leader 收件箱"')
  })

  it('stacks at narrow widths and lets only the dependency graph scroll horizontally', () => {
    const moduleCss = source('AgentTeam.module.css')
    const main = moduleCss.match(/\.overviewMain \{([^}]*)\}/)?.[1] ?? ''
    const viewport = moduleCss.match(/\.overviewGraphViewport \{([^}]*)\}/)?.[1] ?? ''
    const layers = moduleCss.match(/\.overviewLayers \{([^}]*)\}/)?.[1] ?? ''
    const inboxText = moduleCss.match(/\.overviewInboxText \{([^}]*)\}/)?.[1] ?? ''

    expect(main).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(viewport).toContain('overflow-x: auto')
    expect(viewport).not.toContain('overflow: hidden')
    expect(layers).toContain('min-width: max-content')
    expect(inboxText).toContain('-webkit-line-clamp: 2')
    expect(moduleCss).not.toContain('.overviewLayer + .overviewLayer::before')
    expect(moduleCss).toContain('@container board (min-width: 50rem)')
  })

  it('records the aligned design decisions', () => {
    const design = readFileSync(
      new URL('../docs/superpowers/specs/2026-10-23-team-collaboration-overview-design.md', import.meta.url),
      'utf8',
    )

    expect(design).toContain('running` / `blocked` / `failed')
    expect(design).not.toContain('running` / `blocked` / `failed` / `assigned')
    expect(design).toContain('缺失依赖')
    expect(design).toContain('分层顺序视图')
    expect(design).toContain('当前筛选已隐藏该任务')
    expect(design).toContain('内联展开全部 Leader 消息')
  })

  it('implements the inline inbox expansion instead of a dead activity link', () => {
    const overview = source('team-overview.tsx')

    expect(overview).toContain('expanded ? allInbox : allInbox.slice(0, INBOX_LIMIT)')
    expect(overview).toContain('setExpanded(value => !value)')
    expect(overview).toContain('aria-expanded={expanded}')
    expect(overview).toContain('查看全部')
    expect(overview).not.toContain('team-view-presence')
  })
})
