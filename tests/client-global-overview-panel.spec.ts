import { existsSync, readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GlobalOverviewPanel } from '../src/client/global-overview.js'
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
} = {}): TeamView {
  const id = overrides.id ?? 'team-1'
  return {
    schemaVersion: 2,
    id,
    name: overrides.name ?? `团队 ${id}`,
    workspaceId: `workspace-${id}`,
    workspacePath: `/tmp/${id}`,
    leaderSlotId: overrides.leaderSlotId ?? 'leader',
    state: 'active',
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
  tasks: [task('t1', 'blocked')],
})
const blockedTeam = team({ id: 'team-blocked', name: '阻塞团队', tasks: [task('b1', 'blocked')] })
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
    expect(summary).toContain('2 运行中')
    expect(summary).toContain('2 需要你')
    expect(summary).toContain('2 阻塞')
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
    expect(teams).toContain('运行中 · 1 个待审批 · 1 个阻塞')
    expect(teams).toContain('阻塞团队')
    expect(teams).toContain('1 个阻塞')
    expect(assistants).toContain('论文助手')
    expect(assistants).toContain('deepseek-reasoner · 1 个任务')
    expect(assistants).toContain('待输入助手')
    expect(assistants).toContain('1 个待输入')
  })
})

describe('GlobalOverview navigation', () => {
  it('opens teams and only enables assistants that already have a main session', () => {
    const html = render({ ...populated, onOpenAssistant: () => undefined })

    expect(text(region(html, 'teams'))).toContain('研发团队')
    expect(text(region(html, 'assistants'))).toContain('未创建主会话')

    const withMain = buttonTag(html, 'data-assistant-id', 'assistant-run')
    const withoutMain = buttonTag(html, 'data-assistant-id', 'assistant-needs')
    expect(withMain).not.toContain('disabled')
    expect(withoutMain).toContain('disabled')
    expect(withoutMain).toContain('未创建主会话')
    expect(buttonTag(html, 'data-team-id', 'team-run')).not.toContain('disabled')

    // Presence of a main session alone decides the disabled state; a host
    // without a navigation callback still renders the row enabled.
    const noHandler = render(populated)
    expect(buttonTag(noHandler, 'data-assistant-id', 'assistant-run')).not.toContain('disabled')
    expect(buttonTag(noHandler, 'data-assistant-id', 'assistant-needs')).toContain('disabled')
  })

  it('uses only the existing list calls and never ensures a session or offers bulk actions', () => {
    const overview = source('global-overview.tsx')
    const methods = [...overview.matchAll(/callAgentTeam\('([^']+)'/g)].map(match => match[1]).sort()

    expect(methods).toEqual(['assistant.instance.list', 'assistant.task.list'])
    expect(overview).not.toContain('assistant.instance.ensure')
    expect(overview).not.toContain('team.interaction.respond')
    expect(overview).not.toContain('批量')
    expect(overview).toContain('onClick={() => { onOpenTeam(item.id) }}')
    expect(overview).toContain('onOpenAssistant(sessionId)')
  })

  it('mounts the workbench overlay in the shipped client entry and forwards its opener', () => {
    const entry = source('index.tsx')
    const components = source('components.tsx')
    const panel = source('teams/TeamPanel.tsx')

    expect(entry).toContain("id: 'dsh-team-mode-workbench'")
    expect(entry).toContain('order: 15')
    expect(entry).toContain('<AgentTeamOverlay pickWorkspace={pickWorkspace} openSession={openSession} />')
    expect(components).toContain('export function AgentTeamOverlay({')
    expect(components).toContain('<TeamPanel')
    expect(components).toContain('openSession={openSession}')
    expect(components).toContain('teamsLoading={teamsLoading}')
    expect(panel).toContain('onOpenAssistant: openSession')
    expect(panel).toContain('{...(teamsLoading === undefined ? {} : { teamsLoading })')
    expect(panel).toContain('{...(teamsError === undefined ? {} : { teamsError })')
  })

  it('keeps the overview text in the built client bundle so it cannot become dead code', () => {
    const bundleUrl = new URL('../lib/client.js', import.meta.url)
    expect(existsSync(bundleUrl), 'lib/client.js is missing: run npm run build first').toBe(true)
    const bundle = readFileSync(bundleUrl, 'utf8')

    expect(bundle).toContain('全局总览')
    expect(bundle).toContain('dsh-team-mode-workbench')
  })

  it('mounts only on the default workbench page and forwards the session opener', () => {
    const panel = source('teams/TeamPanel.tsx')

    expect(panel).toContain("import { GlobalOverview } from '../global-overview.js'")
    expect(panel).toContain('openSession?: (sessionId: string) => void')
    expect(panel).toContain('{selectedTeam === undefined && (')
    expect(panel).toContain('<GlobalOverview')
    expect(panel).toContain('onOpenTeam={teamId => { openTeam(teamId) }}')
    expect(panel).toContain('onOpenAssistant: openSession')
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
    expect(text(region(html, 'summary'))).toContain('0 运行中')
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
    expect(text(loading)).not.toContain('0 运行中')

    const stale = render({ ...populated, teamsLoading: true })
    expect(text(stale)).not.toContain('3 个团队')
    expect(text(stale)).not.toContain('2 运行中')

    const failed = render({ teamsError: 'team.list 超时' })
    expect(failed).toContain('role="alert"')
    expect(text(failed)).toContain('团队数据加载失败：team.list 超时')
    expect(text(failed)).not.toContain('个团队')
    expect(text(failed)).not.toContain('0 运行中')
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
    const globalCss = moduleCss.slice(moduleCss.indexOf('Read-only global overview'))

    expect(root).toContain('min-width: 0')
    expect(stats).toContain('flex-wrap: wrap')
    expect(stat).toContain('white-space: nowrap')
    expect(count).toContain('white-space: nowrap')
    expect(filters).toContain('flex-wrap: wrap')
    expect(row).toContain('flex-wrap: wrap')
    expect(row).toContain('min-width: 0')
    expect(globalCss).not.toContain('overflow: hidden')
    expect(globalCss).toContain('@media (max-width: 420px)')
  })
})
