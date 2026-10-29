import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamView } from '../src/transport/contracts.js'

const ISO = '2026-01-01T00:00:00.000Z'

const state = vi.hoisted(() => ({
  data: {
    teams: [] as TeamView[],
    teamsLoading: false,
    teamsError: undefined as string | undefined,
  },
}))

vi.mock('../src/client/components.js', () => ({
  useAgentTeamData: () => ({
    catalog: undefined,
    assistants: [],
    teams: state.data.teams,
    loading: false,
    error: undefined,
    teamsLoading: state.data.teamsLoading,
    teamsError: state.data.teamsError,
    load: async () => undefined,
  }),
}))

vi.mock('../src/client/teams/TeamPanel.js', () => ({
  TeamCard: () => createElement('div', { 'data-team-card': 'stub' }),
}))

// The 今天 entry point is the real one user-side; this node test only needs the
// wiring, not the primitives it renders with.
vi.mock('../src/client/today-surface.js', () => ({ requestToday: () => undefined }))

const { TEAM_MANAGE_VIEW_ID, TeamManageView } = await import('../src/client/team-manage.js')
const { GlobalOverviewPanel } = await import('../src/client/global-overview.js')

function team(id: string, sessionId: string): TeamView {
  return {
    schemaVersion: 2,
    id,
    name: `团队 ${id}`,
    workspaceId: `workspace-${id}`,
    workspacePath: `/tmp/${id}`,
    leaderSlotId: 'leader',
    state: 'active',
    directMemberChat: false,
    members: {
      leader: {
        id: 'leader',
        assistantId: 'assistant-leader',
        displayName: '小码',
        role: 'leader',
        assistantSnapshot: {
          assistantId: 'assistant-leader',
          revision: 1,
          name: '小码',
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
        sessionId,
        desiredState: 'online',
        lastRuntimeState: 'idle',
        joinedAt: ISO,
      },
    },
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
  }
}

function render(sessionId = 'session-leader'): string {
  return renderToStaticMarkup(createElement(TeamManageView, { sessionId }))
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
}

describe('TeamManageView overview states', () => {
  beforeEach(() => {
    state.data = { teams: [team('team-1', 'session-leader')], teamsLoading: false, teamsError: undefined }
  })

  it('passes the cached team list loading state into the overview', () => {
    state.data.teamsLoading = true
    const html = render()

    expect(text(html)).toContain('全局总览')
    expect(text(html)).toContain('正在加载团队和助手…')
    expect(html).toContain('role="status"')
    // Unknown is not zero: no fabricated counts while the refresh is unanswered.
    expect(text(html)).not.toContain('个团队')
    expect(text(html)).not.toContain('0 空闲')
  })

  it('replaces only the overview on a team list failure, never the team page', () => {
    // Documented behavior: a team-list failure is an unknown team count, so the
    // overview is replaced by the error card; the team card below still renders.
    state.data.teamsError = 'team.list 超时'
    const html = render()

    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('团队数据加载失败：team.list 超时')
    expect(text(html)).not.toContain('0 空闲')
    expect(text(html)).not.toContain('个团队')
    expect(html).not.toContain('data-overview-region="summary"')
    expect(html).toContain('data-team-card="stub"')
  })

  it('keeps the last known facts when only the assistant list fails', () => {
    // The other half of the documented difference: Assistant rows survive a
    // failed refresh and the message is shown inline above them.
    const staleTask = {
      schemaVersion: 1 as const,
      id: 'task-stale',
      assistantId: 'assistant-stale',
      sessionId: 'session-task-stale',
      role: 'task' as const,
      title: '旧任务',
      brief: '',
      parentSessionId: 'parent-stale',
      status: 'running' as const,
      createdAt: ISO,
      updatedAt: ISO,
    }
    const html = renderToStaticMarkup(createElement(GlobalOverviewPanel, {
      teams: state.data.teams,
      instances: [],
      tasks: [staleTask],
      error: '助手数据连接已断开，正在重连',
      onOpenToday: () => undefined,
    }))

    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('助手数据连接已断开，正在重连')
    expect(text(html)).toContain('1 个团队')
    expect(html).toContain('data-overview-region="summary"')
  })

  it('states that difference in the operator documentation', () => {
    const docs = readFileSync(new URL('../docs/team-management.md', import.meta.url), 'utf8')

    expect(docs).toContain('团队列表失败会整块替换总览')
    expect(docs).toContain('助手列表失败则保留上一次成功加载的数字')
  })

  it('renders nothing when the Session does not belong to a team', () => {
    expect(render('session-unknown')).toBe('')
  })

  it('wires the overview to the data hook without a second list call', () => {
    const source = readFileSync(new URL('../src/client/team-manage.tsx', import.meta.url), 'utf8')

    expect(source).toContain('teamsLoading={teamsLoading}')
    expect(source).toContain('{...(teamsError === undefined ? {} : { teamsError })}')
    expect(source).toContain('onOpenToday={requestToday}')
    expect(source).not.toContain('callAgentTeam')
    expect(TEAM_MANAGE_VIEW_ID).toBe('team-manage')
  })
})
