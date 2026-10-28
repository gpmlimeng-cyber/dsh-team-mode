import { existsSync, readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GlobalOverviewPanel, openAssistantSession } from '../src/client/global-overview.js'
import type { GlobalFilter } from '../src/client/global-overview-data.js'
import type { AssistantSession, TeamMemberSlot, TeamTask } from '../src/domain/types.js'
import type { AssistantInstanceView, TeamView } from '../src/transport/contracts.js'

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

function team(overrides: {
  id?: string
  name?: string
  leaderSlotId?: string
  members?: TeamMemberSlot[]
  tasks?: TeamTask[]
  archivedAt?: string
  state?: TeamView['state']
} = {}): TeamView {
  const id = overrides.id ?? 'team-1'
  return {
    schemaVersion: 2,
    id,
    name: overrides.name ?? `团队 ${id}`,
    workspaceId: `workspace-${id}`,
    workspacePath: `/tmp/${id}`,
    leaderSlotId: overrides.leaderSlotId ?? 'leader',
    state: overrides.state ?? 'active',
    directMemberChat: false,
    members: Object.fromEntries((overrides.members ?? [member('leader', { role: 'leader' })]).map(entry => [entry.id, entry])),
    retiredSessions: {},
    tasks: Object.fromEntries((overrides.tasks ?? []).map(entry => [entry.id, entry])),
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...(overrides.archivedAt === undefined ? {} : { archivedAt: overrides.archivedAt }),
  }
}

function instance(overrides: {
  id?: string
  name?: string
  model?: string
  status?: AssistantInstanceView['status']
  mainSessionId?: string
  archivedAt?: string
  preview?: AssistantInstanceView['preview']
} = {}): AssistantInstanceView {
  const id = overrides.id ?? 'assistant-1'
  return {
    schemaVersion: 1,
    id,
    assistantSnapshot: {
      assistantId: id,
      revision: 1,
      name: overrides.name ?? id,
      instructions: '',
      provider: 'deepseek',
      model: overrides.model ?? 'deepseek-chat',
      agentPresetId: 'default',
      permissionPresetId: 'default',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: `workspace-${id}`,
    workspacePath: `/tmp/${id}`,
    status: overrides.status ?? 'idle',
    pinned: false,
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...(overrides.preview === undefined ? {} : { preview: overrides.preview }),
    ...(overrides.mainSessionId === undefined ? {} : { mainSessionId: overrides.mainSessionId }),
    ...(overrides.archivedAt === undefined ? {} : { archivedAt: overrides.archivedAt }),
  }
}

function assistantTask(
  id: string,
  status: AssistantSession['status'],
  overrides: Partial<AssistantSession> = {},
): AssistantSession {
  return {
    schemaVersion: 1,
    id,
    assistantId: 'assistant-1',
    sessionId: `session-${id}`,
    role: 'task',
    title: id,
    brief: '',
    parentSessionId: 'parent-session',
    status,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

function render(options: {
  teams?: TeamView[]
  instances?: AssistantInstanceView[]
  tasks?: AssistantSession[]
  filter?: GlobalFilter
  loading?: boolean
  error?: string
  teamsLoading?: boolean
  teamsError?: string
  readState?: Readonly<Record<string, number>>
  onFilterChange?: (filter: GlobalFilter) => void
  onOpenTeam?: (teamId: string) => void
  onOpenAssistant?: (sessionId: string) => void
} = {}): string {
  return renderToStaticMarkup(createElement(GlobalOverviewPanel, {
    teams: options.teams ?? [],
    instances: options.instances ?? [],
    tasks: options.tasks ?? [],
    filter: options.filter ?? 'all',
    loading: options.loading ?? false,
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.teamsLoading === undefined ? {} : { teamsLoading: options.teamsLoading }),
    ...(options.teamsError === undefined ? {} : { teamsError: options.teamsError }),
    ...(options.readState === undefined ? {} : { readState: options.readState }),
    ...(options.onFilterChange === undefined ? {} : { onFilterChange: options.onFilterChange }),
    onOpenTeam: options.onOpenTeam ?? (() => undefined),
    ...(options.onOpenAssistant === undefined ? {} : { onOpenAssistant: options.onOpenAssistant }),
  }))
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Inner HTML of the first element carrying one `data-overview-region` marker. */
function region(html: string, name: string): string {
  const marker = `data-overview-region="${name}"`
  const index = html.indexOf(marker)
  if (index < 0) return ''
  const start = html.lastIndexOf('<', index)
  const tag = html.slice(start + 1).match(/^([a-z]+)/)?.[1] ?? 'div'
  const end = html.indexOf(`</${tag}>`, index)
  return end < 0 ? html.slice(start) : html.slice(start, end + tag.length + 3)
}

function source(name: string): string {
  return readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
}

function cssRule(css: string, className: string): string {
  return css.match(new RegExp(`\\.${className} \\{([^}]*)\\}`))?.[1] ?? ''
}

function buttonTag(html: string, attribute: string, id: string): string {
  return html.match(new RegExp(`<button[^>]*${attribute}="${id}"[^>]*>`))?.[0] ?? ''
}

const runningTeam = team({
  id: 'team-run',
  name: '研发团队',
  members: [
    member('leader', { role: 'leader', displayName: '阿Leader', lastRuntimeState: 'running' }),
    member('approver', { lastRuntimeState: 'waiting_approval' }),
  ],
  tasks: [
    task('t0', 'pending'),
    task('t1', 'assigned', { dependencyIds: ['t0'] }),
  ],
})
const blockedTeam = team({
  id: 'team-blocked',
  name: '阻塞团队',
  tasks: [
    task('b0', 'assigned'),
    task('b1', 'pending', { dependencyIds: ['b0'] }),
  ],
})
const idleTeam = team({ id: 'team-idle', name: '空闲团队' })
const activeAssistant = instance({
  id: 'assistant-run',
  name: '论文助手',
  model: 'deepseek-reasoner',
  status: 'active',
  mainSessionId: 'session-main',
})
const needsAssistant = instance({ id: 'assistant-needs', name: '待输入助手' })
const idleAssistant = instance({ id: 'assistant-idle', name: '空闲助手' })
const activeTask = assistantTask('x1', 'running', { assistantId: 'assistant-run' })
const needsTask = assistantTask('y1', 'needs_input', { assistantId: 'assistant-needs' })

const populated = {
  teams: [runningTeam, blockedTeam, idleTeam],
  instances: [activeAssistant, needsAssistant, idleAssistant],
  tasks: [activeTask, needsTask],
}

describe('GlobalOverview summary and attention', () => {
  it('renders the workspace totals from the real team and assistant data', () => {
    const html = render(populated)
    const summary = text(region(html, 'summary'))

    expect(text(html)).toContain('3 个团队 · 3 个助手')
    expect(summary).toContain('2 有活动')
    expect(summary).toContain('2 需要你')
    expect(summary).toContain('2 等待前置')
    expect(summary).toContain('0 异常')
    expect(summary).toContain('0 未读')
    expect(summary).toContain('2 空闲')
    expect(html).not.toContain('undefined')
  })

  it('shows needs-attention before the filters and filters never move it', () => {
    const html = render({ ...populated, filter: 'running' })
    const attention = text(region(html, 'attention'))

    expect(attention).toContain('需要你')
    expect(attention).toContain('研发团队')
    expect(attention).toContain('1 个待审批')
    expect(attention).toContain('待输入助手')
    expect(attention).toContain('1 个待输入')
    expect(attention).toContain('1 个待输入 · 未创建主会话')
    expect(html.indexOf('data-overview-region="attention"')).toBeLessThan(
      html.indexOf('data-overview-region="filters"'),
    )
    expect(html.indexOf('data-attention-team-id="team-run"')).toBeLessThan(
      html.indexOf('data-attention-assistant-id="assistant-needs"'),
    )
  })

  it('renders team and assistant rows with their models and live state', () => {
    const html = render(populated)
    const teams = text(region(html, 'teams'))
    const assistants = text(region(html, 'assistants'))

    expect(teams).toContain('研发团队')
    expect(teams).toContain('Leader 阿Leader · 2 名成员')
    expect(teams).toContain('有活动 · 1 个待审批 · 1 个等待前置')
    expect(teams).toContain('阻塞团队')
    expect(teams).toContain('1 个等待前置')
    expect(assistants).toContain('论文助手')
    expect(assistants).toContain('deepseek-reasoner · 1 个任务')
    expect(assistants).toContain('待输入助手')
    expect(assistants).toContain('1 个待输入')
  })
})

describe('GlobalOverview navigation', () => {
  it('opens teams and routes every assistant row through the canonical ensure door', () => {
    const html = render({ ...populated, onOpenAssistant: () => undefined })

    expect(text(region(html, 'teams'))).toContain('研发团队')
    expect(text(region(html, 'assistants'))).toContain('未创建主会话')

    const withMain = buttonTag(html, 'data-assistant-id', 'assistant-run')
    const withoutMain = buttonTag(html, 'data-assistant-id', 'assistant-needs')
    expect(withMain).not.toContain('disabled')
    // A row without a main session is not a dead control: the click
    // materializes the canonical chat through assistant.instance.ensure first.
    expect(withoutMain).not.toContain('disabled')
    expect(withoutMain).toContain('未创建主会话')
    expect(buttonTag(html, 'data-team-id', 'team-run')).not.toContain('disabled')

    // Only the absence of a host navigation face disables an assistant row.
    const noHandler = render(populated)
    const noHandlerRow = buttonTag(noHandler, 'data-assistant-id', 'assistant-run')
    expect(noHandlerRow).toContain('disabled')
    expect(noHandlerRow).toContain('当前工作台无法跳转')
    expect(buttonTag(noHandler, 'data-assistant-id', 'assistant-needs')).toContain('disabled')

    const attentionRow = buttonTag(html, 'data-attention-assistant-id', 'assistant-needs')
    expect(attentionRow).not.toContain('disabled')
    expect(attentionRow).toContain('未创建主会话')
  })

  it('closes the workbench before opening an assistant main session', () => {
    const calls: string[] = []
    openAssistantSession(
      'session-main',
      () => { calls.push('close-workbench') },
      sessionId => { calls.push(`open:${sessionId}`) },
    )

    expect(calls).toEqual(['close-workbench', 'open:session-main'])
  })

  it('uses only the existing list calls here and delegates the canonical ensure to the store', () => {
    const overview = source('global-overview.tsx')
    const methods = [...overview.matchAll(/callAgentTeam\('([^']+)'/g)].map(match => match[1]).sort()

    expect(methods).toEqual(['assistant.instance.list', 'assistant.task.list'])
    // The ensure/naming/pin door lives in store.ts, not in this surface.
    expect(overview).toContain('openAssistantMainSession(item.id, sessionId => { onOpenAssistant(sessionId) }')
    expect(overview).not.toContain('team.interaction.respond')
    expect(overview).not.toContain('批量')
    expect(overview).toContain('onClick={() => { onOpenTeam(item.id) }}')
    expect(overview).toContain('onOpenAssistant(sessionId)')
  })

  it('does not register the removed full-screen workbench overlay', () => {
    const entry = source('index.tsx')

    expect(entry).not.toContain("id: 'dsh-team-mode-workbench'")
    expect(entry).not.toContain('<AgentTeamOverlay pickWorkspace={pickWorkspace} openSession={openSession} />')

  })

  it('does not ship the removed workbench id in the built client bundle', () => {
    const bundleUrl = new URL('../lib/client.js', import.meta.url)
    expect(existsSync(bundleUrl), 'lib/client.js is missing: run npm run build first').toBe(true)
    const bundle = readFileSync(bundleUrl, 'utf8')

    expect(bundle).not.toContain('dsh-team-mode-workbench')
  })

  it('mounts only on the default workbench page and forwards the session opener', () => {
    const panel = source('teams/TeamPanel.tsx')

    expect(panel).toContain("import { GlobalOverview, openAssistantSession } from '../global-overview.js'")
    expect(panel).toContain('openSession?: (sessionId: string) => void')
    expect(panel).toContain('{selectedTeam === undefined && (')
    expect(panel).toContain('<GlobalOverview')
    expect(panel).toContain('onOpenTeam={teamId => { openTeam(teamId) }}')
    expect(panel).toContain('openAssistantSession(sessionId, closeAgentTeam, openSession)')
    expect(panel).toContain('teamCountUnknown ? \'…\' : teams.length')
    expect(panel).toContain('teamsError !== undefined && teams.length === 0')
    expect(panel).toContain('正在读取团队列表…')
    expect(panel).toContain('团队列表加载失败：{teamsError}')
  })
})

describe('GlobalOverview filters', () => {
  it('filters rows while leaving every summary count untouched', () => {
    const all = render(populated)
    const expected = text(region(all, 'summary'))

    const attention = render({ ...populated, filter: 'attention' })
    expect(text(region(attention, 'teams'))).toContain('研发团队')
    expect(region(attention, 'teams')).not.toContain('team-blocked')
    expect(text(region(attention, 'assistants'))).toContain('待输入助手')
    expect(region(attention, 'assistants')).not.toContain('assistant-run')
    expect(text(region(attention, 'summary'))).toBe(expected)

    const running = render({ ...populated, filter: 'running' })
    expect(region(running, 'teams')).toContain('team-run')
    expect(region(running, 'teams')).not.toContain('team-idle')
    expect(region(running, 'assistants')).toContain('assistant-run')
    expect(text(region(running, 'summary'))).toBe(expected)

    const idle = render({ ...populated, filter: 'idle' })
    expect(region(idle, 'teams')).toContain('team-idle')
    expect(region(idle, 'teams')).not.toContain('team-blocked')
    expect(region(idle, 'assistants')).toContain('assistant-idle')
    expect(text(region(idle, 'summary'))).toBe(expected)

    for (const html of [attention, running, idle]) {
      expect(text(html)).toContain('3 个团队 · 3 个助手')
    }
  })

  it('shows an explicit empty filter state instead of fake rows or counts', () => {
    const html = render({
      teams: [idleTeam],
      instances: [idleAssistant],
      filter: 'attention',
      onFilterChange: () => undefined,
    })

    expect(text(html)).toContain('当前筛选下没有团队或助手')
    expect(region(html, 'filter-empty')).toContain('查看全部')
    expect(html).not.toContain('data-overview-region="teams"')
    expect(text(region(html, 'summary'))).toContain('0 有活动')
    expect(text(region(html, 'summary'))).toContain('2 空闲')
  })

  it('renders explicit empty, loading and error states', () => {
    const empty = text(render())
    expect(empty).toContain('0 个团队 · 0 个助手')
    expect(empty).toContain('还没有团队或助手，先创建成员模板或团队。')

    const loading = text(render({ loading: true }))
    expect(loading).toContain('正在加载助手和任务…')
    expect(loading).not.toContain('个团队')

    const failed = render({ error: '网络错误' })
    expect(failed).toContain('role="alert"')
    expect(text(failed)).toContain('网络错误')
    expect(text(failed)).not.toContain('个团队')

    const stale = render({ ...populated, error: '刷新失败' })
    expect(stale).toContain('role="alert"')
    expect(text(stale)).toContain('刷新失败')
    expect(text(stale)).toContain('3 个团队 · 3 个助手')
  })

  it('never shows zero team counts while the team list is loading or failed', () => {
    const loading = render({ teamsLoading: true, instances: [idleAssistant] })
    expect(text(loading)).toContain('正在加载团队和助手…')
    expect(text(loading)).not.toContain('个团队')
    expect(text(loading)).not.toContain('0 有活动')

    const stale = render({ ...populated, teamsLoading: true })
    expect(text(stale)).not.toContain('3 个团队')
    expect(text(stale)).not.toContain('2 有活动')

    const failed = render({ teamsError: 'team.list 超时' })
    expect(failed).toContain('role="alert"')
    expect(text(failed)).toContain('团队数据加载失败：team.list 超时')
    expect(text(failed)).not.toContain('个团队')
    expect(text(failed)).not.toContain('0 有活动')
  })
})

describe('GlobalOverview attention center', () => {
  const blockedApprovalTeam = team({
    id: 'team-approve',
    name: '审批团队',
    members: [member('leader', { role: 'leader', lastRuntimeState: 'waiting_approval' })],
    tasks: [task('dep', 'running'), task('held', 'pending', { dependencyIds: ['dep'] })],
  })
  const errorTeam = team({ id: 'team-error', name: '异常团队', state: 'error' })
  const failedAssistant = instance({ id: 'assistant-failed', name: '异常助手', status: 'error' })
  const unreadAssistant = instance({
    id: 'assistant-unread',
    name: '未读助手',
    preview: { role: 'assistant', text: '结果已生成', time: Date.parse(ISO) },
  })

  it('renders one row per entity and lists the state categories it holds as words', () => {
    const html = render({
      teams: [blockedApprovalTeam],
      instances: [],
      tasks: [],
    })
    const attention = region(html, 'attention')

    expect(attention).toContain('data-attention-team-id="team-approve"')
    expect(attention.match(/data-attention-team-id=/g)?.length).toBe(1)
    expect(html).toContain('data-attention-categories="approval,blocked"')
    expect(text(attention)).toContain('1 个待审批')
    expect(text(attention)).toContain('等待前置')
    expect(text(attention)).not.toContain('个等待前置')
  })

  it('keeps states out of the decision list and counts them as entities', () => {
    const html = render({
      teams: [blockedTeam, errorTeam],
      instances: [failedAssistant, unreadAssistant],
      tasks: [],
      readState: { 'assistant-unread': 0 },
    })
    const attention = text(region(html, 'attention'))
    const summary = text(region(html, 'summary'))

    expect(attention).toContain('当前没有需要你处理的事项')
    expect(attention).not.toContain('异常团队')
    expect(attention).not.toContain('异常助手')
    expect(attention).not.toContain('未读助手')
    expect(summary).toContain('1 等待前置')
    expect(summary).toContain('2 异常')
    expect(summary).toContain('1 未读')
    expect(summary).toContain('0 需要你')
  })

  it('renders a failed assistant as 异常 instead of 空闲', () => {
    const html = render({ teams: [], instances: [failedAssistant], tasks: [] })
    const assistants = text(region(html, 'assistants'))

    expect(assistants).toContain('异常助手')
    expect(assistants).toContain('异常')
    expect(assistants).not.toContain('空闲')
    expect(text(region(html, 'summary'))).not.toContain('1 空闲')
  })

  it('narrows rows with the state filters and marks the active one', () => {
    const html = render({
      teams: [blockedTeam, errorTeam],
      instances: [failedAssistant, unreadAssistant],
      tasks: [],
      filter: 'error',
      readState: { 'assistant-unread': 0 },
      onFilterChange: () => undefined,
    })

    for (const label of ['全部', '需要你', '有活动', '等待前置', '异常', '未读', '空闲']) {
      expect(html).toContain(`>${label}</button>`)
    }
    expect(html).toMatch(/aria-pressed="true"[^>]*>异常<\/button>/)
    expect(text(region(html, 'teams'))).toContain('异常团队')
    expect(text(region(html, 'teams'))).not.toContain('阻塞团队')
    expect(text(region(html, 'assistants'))).toContain('异常助手')
    expect(text(region(html, 'assistants'))).not.toContain('未读助手')
  })

  it('never hides a pending approval behind a state filter', () => {
    for (const filter of ['blocked', 'error', 'unread', 'running', 'idle', 'attention', 'all'] as const) {
      const html = render({ ...populated, filter })
      const attention = text(region(html, 'attention'))
      expect(attention).toContain('研发团队')
      expect(attention).toContain('待输入助手')
      expect(attention).toContain('1 个待审批')
      expect(attention).toContain('1 个待输入')
    }
  })

  it('explains the activity count so it cannot be read as the member count', () => {
    const html = render(populated)
    expect(html).toMatch(/data-count="running"[^>]*title="有活动[^"]*审批[^"]*"/)
    expect(html).toMatch(/data-count="attention"[^>]*title="需要你[^"]*"/)
  })
})

describe('GlobalOverview startup', () => {
  const startingTeam = team({ id: 'team-starting', name: '启动团队', state: 'starting' })
  const wakingMemberTeam = team({
    id: 'team-waking',
    name: '唤醒团队',
    members: [member('waker', { lastRuntimeState: 'starting' })],
  })

  it('shows 启动中 and never 空闲 for a starting team or a waking member', () => {
    for (const fixture of [startingTeam, wakingMemberTeam]) {
      const html = render({ teams: [fixture], instances: [], tasks: [] })
      expect(text(region(html, 'teams'))).toContain('启动中')
      expect(text(region(html, 'teams'))).not.toContain('空闲')
    }
    expect(text(region(render({ teams: [startingTeam], instances: [], tasks: [] }), 'summary')))
      .toContain('0 空闲')
  })

  it('drops a starting team from the idle filter instead of listing it there', () => {
    const html = render({ teams: [startingTeam], instances: [], tasks: [], filter: 'idle' })

    expect(region(html, 'filter-empty')).toContain('当前筛选下没有团队或助手')
    expect(html).not.toContain('data-team-id="team-starting"')
  })
})

describe('GlobalOverview layout contract', () => {
  it('keeps counts and rows readable at 320px without clipping', () => {
    const moduleCss = source('AgentTeam.module.css')
    const root = cssRule(moduleCss, 'globalOverview')
    const stats = cssRule(moduleCss, 'globalOverviewStats')
    const stat = cssRule(moduleCss, 'globalOverviewStat')
    const count = cssRule(moduleCss, 'globalOverviewCount')
    const filters = cssRule(moduleCss, 'globalOverviewFilters')
    const row = cssRule(moduleCss, 'globalOverviewRow')
    const globalCss = moduleCss.slice(
      moduleCss.indexOf('Read-only global overview'),
      moduleCss.indexOf('/* Team mark:'),
    )
    const narrow = globalCss.slice(globalCss.indexOf('@media (max-width: 420px)'))

    expect(root).toContain('min-width: 0')
    expect(stats).toContain('flex-wrap: wrap')
    expect(stat).toContain('white-space: nowrap')
    expect(count).toContain('white-space: nowrap')
    expect(filters).toContain('flex-wrap: wrap')
    expect(row).toContain('flex-wrap: wrap')
    expect(row).toContain('min-width: 0')
    expect(globalCss).not.toContain('overflow: hidden')
    expect(narrow).toContain('.globalOverviewCount {')
    expect(narrow).toContain('white-space: normal')
    expect(narrow).toContain('flex: 0 1 auto')
    expect(narrow).toContain('min-width: 0')
    expect(count).toContain('font-variant-numeric: tabular-nums')
  })
})
