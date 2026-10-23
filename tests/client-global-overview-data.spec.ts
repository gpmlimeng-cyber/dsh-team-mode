import { describe, expect, it } from 'vitest'
import { globalOverviewModel, filterGlobalOverview } from '../src/client/global-overview-data.js'
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
  updatedAt?: string
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
    members: Object.fromEntries((overrides.members ?? []).map(entry => [entry.id, entry])),
    retiredSessions: {},
    tasks: Object.fromEntries((overrides.tasks ?? []).map(entry => [entry.id, entry])),
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: ISO,
    updatedAt: overrides.updatedAt ?? ISO,
    ...(overrides.archivedAt === undefined ? {} : { archivedAt: overrides.archivedAt }),
  }
}

function instance(overrides: {
  id?: string
  name?: string
  model?: string
  status?: AssistantInstanceView['status']
  mainSessionId?: string
  updatedAt?: string
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
    updatedAt: overrides.updatedAt ?? ISO,
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

function ids(entries: ReadonlyArray<{ id: string }>): string[] {
  return entries.map(entry => entry.id)
}

function tag(item: { kind: 'team' | 'assistant'; id: string }): string {
  return `${item.kind}:${item.id}`
}

describe('globalOverviewModel', () => {
  it('returns zero counts and empty lists for empty input, with no undefined', () => {
    const model = globalOverviewModel({ teams: [], instances: [], tasks: [] })

    expect(model.teams).toEqual([])
    expect(model.assistants).toEqual([])
    expect(model.attention).toEqual([])
    expect(model.counts).toEqual({
      teams: 0,
      assistants: 0,
      running: 0,
      attention: 0,
      blocked: 0,
      idle: 0,
    })
    for (const value of Object.values(model.counts)) {
      expect(value).toBeTypeOf('number')
      expect(value).toBe(0)
    }
  })

  it('projects team runtime, approvals, blocked tasks, and assistant status', () => {
    const model = globalOverviewModel({
      teams: [
        team({
          id: 'team-a',
          name: '研发团队',
          members: [
            member('leader', { role: 'leader', displayName: '阿Leader', lastRuntimeState: 'running' }),
            member('worker', { lastRuntimeState: 'waiting_approval' }),
          ],
          tasks: [
            task('t0', 'pending'),
            task('t1', 'assigned', { dependencyIds: ['t0'] }),
            task('t2', 'running'),
          ],
        }),
        team({ id: 'team-b', name: '安静团队' }),
      ],
      instances: [
        instance({ id: 'assistant-x', name: '论文助手', model: 'deepseek-reasoner', status: 'active' }),
        instance({ id: 'assistant-y', name: '待输入助手', status: 'idle' }),
      ],
      tasks: [
        assistantTask('x1', 'running', { assistantId: 'assistant-x' }),
        assistantTask('y1', 'needs_input', { assistantId: 'assistant-y' }),
      ],
    })

    expect(model.teams[0]).toMatchObject({
      kind: 'team',
      id: 'team-a',
      name: '研发团队',
      leaderName: '阿Leader',
      members: 2,
      running: true,
      approval: 1,
      blocked: 1,
    })
    expect(model.teams[1]).toMatchObject({ id: 'team-b', running: false, approval: 0, blocked: 0 })

    expect(model.assistants[0]).toMatchObject({
      kind: 'assistant',
      id: 'assistant-x',
      name: '论文助手',
      model: 'deepseek-reasoner',
      status: 'active',
      tasks: 1,
      running: true,
      needsInput: 0,
    })
    expect(model.assistants[1]).toMatchObject({
      id: 'assistant-y',
      status: 'idle',
      tasks: 1,
      running: false,
      needsInput: 1,
    })

    expect(model.counts).toEqual({
      teams: 2,
      assistants: 2,
      running: 2,
      attention: 2,
      blocked: 1,
      idle: 1,
    })
  })

  it('counts blocked by unfinished dependencies instead of the task status', () => {
    const model = globalOverviewModel({
      teams: [
        team({
          id: 'epoch-retired',
          tasks: [
            task('done', 'completed'),
            // Leader-epoch retire sets every open task to blocked without adding dependencies.
            task('retired', 'blocked'),
          ],
        }),
        team({
          id: 'waiting-on-dep',
          tasks: [
            task('dep', 'running'),
            task('queued', 'assigned', { dependencyIds: ['dep'] }),
          ],
        }),
        team({
          id: 'dep-completed',
          tasks: [
            task('finished', 'completed'),
            task('ready', 'pending', { dependencyIds: ['finished'] }),
          ],
        }),
      ],
      instances: [],
      tasks: [],
    })

    expect(model.teams[0]).toMatchObject({ blocked: 0, running: false })
    expect(model.teams[1]).toMatchObject({ blocked: 1, running: true })
    expect(model.teams[2]).toMatchObject({ blocked: 0, running: false })
    expect(model.counts.blocked).toBe(1)
    expect(model.counts.idle).toBe(2)
  })

  it('puts only waiting approvals and needs-input tasks in attention', () => {
    const blocked = team({
      id: 'blocked-team',
      tasks: [
        task('b0', 'assigned'),
        task('b1', 'pending', { dependencyIds: ['b0'] }),
      ],
    })
    const waiting = team({
      id: 'waiting-team',
      members: [member('leader', { role: 'leader', lastRuntimeState: 'waiting_approval' })],
    })
    const running = team({
      id: 'running-team',
      members: [member('leader', { role: 'leader', lastRuntimeState: 'running' })],
    })

    const model = globalOverviewModel({
      teams: [blocked, waiting, running],
      instances: [
        instance({ id: 'needs' }),
        instance({ id: 'busy', status: 'active' }),
        instance({ id: 'queued' }),
        instance({ id: 'failed', status: 'error' }),
      ],
      tasks: [
        assistantTask('n1', 'needs_input', { assistantId: 'needs' }),
        assistantTask('b1', 'running', { assistantId: 'busy' }),
        assistantTask('q1', 'queued', { assistantId: 'queued' }),
        assistantTask('f1', 'failed', { assistantId: 'failed' }),
      ],
    })

    expect(model.attention.map(tag)).toEqual(['team:waiting-team', 'assistant:needs'])
    expect(model.counts.attention).toBe(2)
    expect(model.counts.blocked).toBe(1)
    // A team waiting for approval still counts as executing on the board.
    expect(model.counts.running).toBe(3)
  })

  it('sorts attention by pending work, then by most recent update', () => {
    const model = globalOverviewModel({
      teams: [
        team({
          id: 'team-low',
          updatedAt: '2026-01-01T02:00:00.000Z',
          members: [member('leader', { role: 'leader', lastRuntimeState: 'waiting_approval' })],
        }),
        team({
          id: 'team-high',
          updatedAt: '2026-01-01T01:00:00.000Z',
          members: [
            member('leader', { role: 'leader', lastRuntimeState: 'waiting_approval' }),
            member('worker', { lastRuntimeState: 'waiting_approval' }),
          ],
        }),
      ],
      instances: [
        instance({ id: 'assistant-new', updatedAt: '2026-01-01T03:00:00.000Z' }),
        instance({ id: 'assistant-old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      ],
      tasks: [
        assistantTask('new', 'needs_input', { assistantId: 'assistant-new' }),
        assistantTask('old', 'needs_input', { assistantId: 'assistant-old' }),
      ],
    })

    expect(model.attention.map(tag)).toEqual([
      'team:team-high',
      'assistant:assistant-new',
      'team:team-low',
      'assistant:assistant-old',
    ])
  })

  it('filters rows without touching the global counts or attention list', () => {
    const model = globalOverviewModel({
      teams: [
        team({
          id: 'team-run',
          members: [
            member('leader', { role: 'leader', lastRuntimeState: 'running' }),
            member('approver', { lastRuntimeState: 'waiting_approval' }),
          ],
          tasks: [
            task('t0', 'pending'),
            task('t1', 'assigned', { dependencyIds: ['t0'] }),
          ],
        }),
        team({
          id: 'team-blocked',
          tasks: [
            task('b0', 'assigned'),
            task('b1', 'pending', { dependencyIds: ['b0'] }),
          ],
        }),
        team({ id: 'team-idle' }),
      ],
      instances: [
        instance({ id: 'assistant-run', status: 'active' }),
        instance({ id: 'assistant-needs' }),
        instance({ id: 'assistant-idle' }),
      ],
      tasks: [assistantTask('n1', 'needs_input', { assistantId: 'assistant-needs' })],
    })

    expect(model.counts).toEqual({
      teams: 3,
      assistants: 3,
      running: 2,
      attention: 2,
      blocked: 2,
      idle: 2,
    })

    const all = filterGlobalOverview(model, 'all')
    expect(ids(all.teams)).toEqual(['team-run', 'team-blocked', 'team-idle'])
    expect(ids(all.assistants)).toEqual(['assistant-run', 'assistant-needs', 'assistant-idle'])

    const attention = filterGlobalOverview(model, 'attention')
    expect(ids(attention.teams)).toEqual(['team-run'])
    expect(ids(attention.assistants)).toEqual(['assistant-needs'])
    expect(attention.teams.length + attention.assistants.length).toBe(model.counts.attention)

    const running = filterGlobalOverview(model, 'running')
    expect(ids(running.teams)).toEqual(['team-run'])
    expect(ids(running.assistants)).toEqual(['assistant-run'])
    expect(running.teams.length + running.assistants.length).toBe(model.counts.running)

    const idle = filterGlobalOverview(model, 'idle')
    expect(ids(idle.teams)).toEqual(['team-idle'])
    expect(ids(idle.assistants)).toEqual(['assistant-idle'])
    expect(idle.teams.length + idle.assistants.length).toBe(model.counts.idle)

    for (const filtered of [all, attention, running, idle]) {
      expect(filtered.counts).toEqual(model.counts)
      expect(filtered.attention).toEqual(model.attention)
    }
  })

  it('excludes archived teams, instances, and tasks', () => {
    const model = globalOverviewModel({
      teams: [
        team({ id: 'team-live' }),
        team({ id: 'team-archived', archivedAt: '2026-01-02T00:00:00.000Z' }),
      ],
      instances: [
        instance({ id: 'assistant-live' }),
        instance({ id: 'assistant-archived-status', status: 'archived' }),
        instance({ id: 'assistant-archived-at', archivedAt: '2026-01-02T00:00:00.000Z' }),
      ],
      tasks: [
        assistantTask('live', 'needs_input', { assistantId: 'assistant-live' }),
        assistantTask('old', 'needs_input', {
          assistantId: 'assistant-live',
          archivedAt: '2026-01-02T00:00:00.000Z',
        }),
      ],
    })

    expect(ids(model.teams)).toEqual(['team-live'])
    expect(ids(model.assistants)).toEqual(['assistant-live'])
    expect(model.assistants[0]).toMatchObject({ tasks: 1, needsInput: 1 })
    expect(model.counts.teams).toBe(1)
    expect(model.counts.assistants).toBe(1)
    expect(model.attention.map(tag)).toEqual(['assistant:assistant-live'])
  })

  it('never throws for an assistant without a main session', () => {
    expect(() => globalOverviewModel({
      teams: [],
      instances: [instance({ id: 'no-main' }), instance({ id: 'with-main', mainSessionId: 'session-main' })],
      tasks: [],
    })).not.toThrow()

    const model = globalOverviewModel({
      teams: [],
      instances: [instance({ id: 'no-main' }), instance({ id: 'with-main', mainSessionId: 'session-main' })],
      tasks: [],
    })

    expect(model.assistants[0]).not.toHaveProperty('mainSessionId')
    expect(model.assistants[0]?.mainSessionId).toBeUndefined()
    expect(model.assistants[1]?.mainSessionId).toBe('session-main')
  })
})
