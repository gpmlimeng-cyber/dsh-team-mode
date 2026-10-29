import { existsSync, readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GlobalOverviewPanel } from '../src/client/global-overview.js'
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
    leaderSlotId: 'leader',
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
  status?: AssistantInstanceView['status']
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
      model: 'deepseek-chat',
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
  loading?: boolean
  error?: string
  teamsLoading?: boolean
  teamsError?: string
  readState?: Readonly<Record<string, number>>
  onOpenToday?: () => void
} = {}): string {
  return renderToStaticMarkup(createElement(GlobalOverviewPanel, {
    teams: options.teams ?? [],
    instances: options.instances ?? [],
    tasks: options.tasks ?? [],
    loading: options.loading ?? false,
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.teamsLoading === undefined ? {} : { teamsLoading: options.teamsLoading }),
    ...(options.teamsError === undefined ? {} : { teamsError: options.teamsError }),
    ...(options.readState === undefined ? {} : { readState: options.readState }),
    onOpenToday: options.onOpenToday ?? (() => undefined),
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

const runningTeam = team({
  id: 'team-run',
  name: '研发团队',
  members: [
    member('leader', { role: 'leader', lastRuntimeState: 'running' }),
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
const activeAssistant = instance({ id: 'assistant-run', status: 'active' })
const needsAssistant = instance({ id: 'assistant-needs' })
const idleAssistant = instance({ id: 'assistant-idle' })
const activeTask = assistantTask('x1', 'running', { assistantId: 'assistant-run' })
const needsTask = assistantTask('y1', 'needs_input', { assistantId: 'assistant-needs' })

const populated = {
  teams: [runningTeam, blockedTeam, idleTeam],
  instances: [activeAssistant, needsAssistant, idleAssistant],
  tasks: [activeTask, needsTask],
}

describe('GlobalOverview facts', () => {
  it('renders header counts, six summary numbers and one 今天 entry', () => {
    const html = render(populated)
    const summary = text(region(html, 'summary'))
    const needs = text(region(html, 'needs-you'))

    expect(text(html)).toContain('3 个团队 · 3 个助手')
    expect(summary).toContain('2 有活动')
    expect(summary).toContain('2 需要你')
    expect(summary).toContain('2 等待前置')
    expect(summary).toContain('0 异常')
    expect(summary).toContain('0 未读')
    expect(summary).toContain('2 空闲')
    expect(needs).toContain('2 项需要你')
    expect(needs).toContain('打开今天')
    expect(html).not.toContain('undefined')
  })

  it('does not repeat the sidebar or 今天 lists, and has no filters', () => {
    const html = render(populated)

    expect(html).not.toContain('data-team-id=')
    expect(html).not.toContain('data-assistant-id=')
    expect(html).not.toContain('data-attention-')
    for (const gone of ['teams', 'assistants', 'attention', 'filters', 'filter-empty']) {
      expect(html).not.toContain(`data-overview-region="${gone}"`)
    }
    // Entity names belong to the surfaces that own the rows.
    expect(text(html)).not.toContain('研发团队')
    expect(text(html)).not.toContain('阻塞团队')
    expect(text(html)).not.toContain('论文助手')
    // No filter chips and no second call to action.
    for (const label of ['全部', '需要你</button>', '有活动</button>', '空闲</button>']) {
      expect(html).not.toContain(label)
    }
    expect(html.match(/打开今天/g) ?? []).toHaveLength(1)
  })

  it('wires 打开今天 through onOpenToday into the 今天 page', () => {
    const overview = source('global-overview.tsx')
    const manage = source('team-manage.tsx')
    const today = source('today-surface.tsx')

    expect(overview).toContain('onClick={onOpenToday}')
    expect(manage).toContain('onOpenToday={requestToday}')
    expect(today).toContain("window.dispatchEvent(new CustomEvent(OPEN_TODAY_EVENT))")
    expect(manage).not.toContain('onOpenTeam=')
    expect(manage).not.toContain('onOpenAssistant=')
  })

  it('uses only the existing list calls here and has no filter projection', () => {
    const overview = source('global-overview.tsx')
    const methods = [...overview.matchAll(/callAgentTeam\('([^']+)'/g)].map(match => match[1]).sort()

    expect(methods).toEqual(['assistant.instance.list', 'assistant.task.list'])
    expect(overview).not.toContain('filterGlobalOverview')
    expect(overview).not.toContain('openAssistantSession')
    expect(overview).not.toContain('team.interaction.respond')
    expect(overview).not.toContain('批量')
  })
})

describe('GlobalOverview states', () => {
  it('renders explicit empty, loading and error states', () => {
    const empty = text(render())
    expect(empty).toContain('0 个团队 · 0 个助手')
    expect(empty).toContain('0 需要你')
    expect(empty).toContain('0 项需要你')

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

  it('keeps an explicit inline error while the last known numbers stay', () => {
    const html = render({ ...populated, error: '助手数据连接已断开，正在重连' })

    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('助手数据连接已断开，正在重连')
    expect(text(html)).toContain('3 个团队 · 3 个助手')
    expect(html).toContain('data-overview-region="summary"')
  })
})

describe('GlobalOverview layout contract', () => {
  it('keeps the facts readable at 320px without list or filter CSS', () => {
    const moduleCss = source('AgentTeam.module.css')
    const root = cssRule(moduleCss, 'globalOverview')
    const stats = cssRule(moduleCss, 'globalOverviewStats')
    const stat = cssRule(moduleCss, 'globalOverviewStat')
    const count = cssRule(moduleCss, 'globalOverviewCount')
    const needs = cssRule(moduleCss, 'globalOverviewNeeds')
    const action = cssRule(moduleCss, 'globalOverviewNeedsAction')
    const globalCss = moduleCss.slice(
      moduleCss.indexOf('Read-only global overview'),
      moduleCss.indexOf('/* Team mark:'),
    )
    const narrow = globalCss.slice(globalCss.indexOf('@media (max-width: 420px)'))

    expect(root).toContain('min-width: 0')
    expect(stats).toContain('flex-wrap: wrap')
    expect(stat).toContain('white-space: nowrap')
    expect(count).toContain('white-space: nowrap')
    expect(needs).toContain('flex-wrap: wrap')
    expect(action).toContain('cursor: pointer')
    expect(globalCss).not.toContain('overflow: hidden')
    expect(narrow).toContain('.globalOverviewCount {')
    expect(narrow).toContain('white-space: normal')
    expect(count).toContain('font-variant-numeric: tabular-nums')
    // The removed lists and filters left no CSS behind.
    for (const gone of [
      'globalOverviewRow ',
      'globalOverviewRows',
      'globalOverviewColumns',
      'globalOverviewAttention',
      'globalOverviewFilters',
      'globalOverviewFilter ',
      'globalOverviewFilterEmpty',
      'globalOverviewClearButton',
    ]) {
      expect(moduleCss).not.toContain(`.${gone}`)
    }
  })
})

describe('removed workbench surfaces', () => {
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
    expect(bundle).not.toContain('globalOverviewAttention')
  })

  it('deletes the dead workbench page and keeps GlobalOverview on the live team manage view', () => {
    const panel = source('teams/TeamPanel.tsx')

    expect(panel).not.toContain('export function TeamPanel(')
    expect(panel).not.toContain('function TeamWorkbench(')
    expect(panel).not.toContain('GlobalOverview')
    expect(panel).not.toContain('openAssistantSession')

    const manage = source('team-manage.tsx')
    expect(manage).toContain('<GlobalOverview')
    expect(manage).toContain('onOpenToday={requestToday}')
    expect(source('index.tsx')).toContain('<TeamMainAgentPanel')
  })
})
