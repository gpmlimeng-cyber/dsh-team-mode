import { describe, expect, it } from 'vitest'
import {
  greetingLine,
  todayGreeting,
  todayModel,
  todayRunning,
  todayUpcoming,
  todayWaiting,
} from '../src/client/today-model.js'
import type { Escalation, TeamMemberSlot, TeamTask } from '../src/domain/types.js'
import type { TeamView } from '../src/transport/contracts.js'

const ISO = '2026-01-01T00:00:00.000Z'
const NOW = Date.parse('2026-01-01T01:00:00.000Z')
const HOUR = 3_600_000

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
    leaderSlotId: 'leader',
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

function escalation(overrides: {
  id: string
  teamId?: string
  teamName?: string
  kind?: Escalation['kind']
  summary?: string
  status?: Escalation['status']
  createdAt?: string
}): Escalation {
  return {
    schemaVersion: 1,
    id: overrides.id,
    teamId: overrides.teamId ?? 'team-1',
    teamName: overrides.teamName ?? '团队 team-1',
    memberSlotId: 'member-1',
    sessionId: 'session-member-1',
    kind: overrides.kind ?? 'approval',
    gateId: `gate-${overrides.id}`,
    summary: overrides.summary ?? overrides.id,
    status: overrides.status ?? 'open',
    createdAt: overrides.createdAt ?? ISO,
  }
}

describe('todayGreeting', () => {
  it('states the waiting count when something waits', () => {
    expect(todayGreeting(2, 3)).toBe('2 件事等你，其余在按计划跑')
  })

  it('says everything runs on schedule when nothing waits but work is running', () => {
    expect(todayGreeting(0, 2)).toBe('都在按计划跑')
  })

  it('says nothing is waiting when both are empty', () => {
    expect(todayGreeting(0, 0)).toBe('今天没有等你的事')
  })

  it('never prints a zero count', () => {
    expect(greetingLine(0, 0)).not.toContain('0')
    expect(greetingLine(0, 4)).not.toContain('0')
    expect(todayModel({ teams: [team()], now: NOW }).greeting).not.toContain('0')
  })

  it('exposes greetingLine as the same function', () => {
    expect(greetingLine).toBe(todayGreeting)
  })
})

describe('todayModel', () => {
  it('returns empty arrays for the blocks that must not render', () => {
    const model = todayModel({ teams: [], now: NOW })
    expect(model.waiting).toEqual([])
    expect(model.upcoming).toEqual([])
    expect(model.running).toEqual([])
    expect(model.runningEmpty).toBe(true)
    expect(model.greeting).toBe('今天没有等你的事')
  })

  it('derives all three blocks from the projections it is given', () => {
    const model = todayModel({
      teams: [
        team({
          id: 'team-a',
          name: '甲队',
          members: [member('leader'), member('worker', { lastRuntimeState: 'running' })],
          tasks: [task('build', 'running')],
        }),
      ],
      escalations: [escalation({ id: 'e1', teamId: 'team-a', teamName: '甲队' })],
      automations: [{ id: 'job-1', title: '晨报', status: 'active', scheduledAt: '2026-01-02T01:00:00.000Z' }],
      now: NOW,
    })
    expect(model.greeting).toBe('1 件事等你，其余在按计划跑')
    expect(model.waiting.map(row => row.kind)).toEqual(['approval'])
    expect(model.running.map(row => row.subject)).toEqual(['build'])
    expect(model.upcoming).toEqual([
      { id: 'job-1', name: '晨报', nextAt: Date.parse('2026-01-02T01:00:00.000Z') },
    ])
    expect(model.runningEmpty).toBe(false)
  })
})

describe('todayWaiting', () => {
  it('keeps only open escalations, with wait time in milliseconds', () => {
    const rows = todayWaiting(
      [],
      [
        escalation({ id: 'open', createdAt: '2026-01-01T00:00:00.000Z' }),
        escalation({ id: 'lifted', status: 'lifted' }),
      ],
      NOW,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ subject: 'open', since: NOW - HOUR, waitMs: HOUR })
  })

  it('surfaces a stuck member from its error state, not from a new request', () => {
    const rows = todayWaiting(
      [team({ id: 'team-a', name: '甲队', members: [member('worker', { lastRuntimeState: 'error' })] })],
      [],
      NOW,
    )
    expect(rows).toEqual([
      { teamId: 'team-a', teamName: '甲队', kind: 'stuck_member', subject: 'worker', since: NOW - HOUR, waitMs: HOUR },
    ])
  })

  it('skips archived teams', () => {
    const rows = todayWaiting(
      [team({ archivedAt: '2026-01-01T00:30:00.000Z', members: [member('worker', { lastRuntimeState: 'error' })] })],
      [],
      NOW,
    )
    expect(rows).toEqual([])
  })

  it('sorts by wait time descending', () => {
    const rows = todayWaiting(
      [],
      [
        escalation({ id: 'short', createdAt: '2026-01-01T00:50:00.000Z' }),
        escalation({ id: 'long', createdAt: '2026-01-01T00:10:00.000Z' }),
        escalation({ id: 'middle', createdAt: '2026-01-01T00:30:00.000Z' }),
      ],
      NOW,
    )
    expect(rows.map(row => row.subject)).toEqual(['long', 'middle', 'short'])
  })

  it('never reports a negative wait for a clock that runs backwards', () => {
    const rows = todayWaiting([], [escalation({ id: 'future', createdAt: '2026-01-01T02:00:00.000Z' })], NOW)
    expect(rows[0]?.waitMs).toBe(0)
  })

  it('keeps one row per team matter even when the same id is read twice', () => {
    const row = escalation({ id: 'e1' })
    expect(todayWaiting([], [row, row], NOW)).toHaveLength(1)
    expect(todayWaiting(
      [],
      [
        escalation({ id: 'e1', summary: '同一件事' }),
        escalation({ id: 'e2', summary: '同一件事' }),
      ],
      NOW,
    )).toHaveLength(1)
    // A different kind on the same team is a different matter.
    expect(todayWaiting(
      [],
      [
        escalation({ id: 'e1', summary: '同一件事', kind: 'approval' }),
        escalation({ id: 'e2', summary: '同一件事', kind: 'question' }),
      ],
      NOW,
    )).toHaveLength(2)
  })
})

describe('todayRunning', () => {
  it('counts a running task or a running member, but not a parked approval', () => {
    const rows = todayRunning(
      [
        team({ id: 'task-team', tasks: [task('build', 'running')] }),
        team({ id: 'member-team', members: [member('worker', { lastRuntimeState: 'running' })] }),
        team({ id: 'approval-team', members: [member('parked', { lastRuntimeState: 'waiting_approval' })] }),
        team({ id: 'idle-team' }),
      ],
      NOW,
    )
    expect(rows.map(row => row.teamId).sort()).toEqual(['member-team', 'task-team'])
    expect(rows.map(row => row.subject).sort()).toEqual(['build', 'worker 正在执行'])
  })

  it('sorts by run time descending', () => {
    const rows = todayRunning(
      [
        team({ id: 'fresh', tasks: [task('fresh', 'running', { createdAt: '2026-01-01T00:50:00.000Z' })] }),
        team({ id: 'old', tasks: [task('old', 'running', { createdAt: '2026-01-01T00:05:00.000Z' })] }),
      ],
      NOW,
    )
    expect(rows.map(row => row.teamId)).toEqual(['old', 'fresh'])
    expect(rows[0]?.runMs).toBe(55 * 60_000)
  })

  it('shows one row per team, on the task that has been running longest', () => {
    const rows = todayRunning(
      [team({ tasks: [
        task('later', 'running', { createdAt: '2026-01-01T00:40:00.000Z' }),
        task('earlier', 'running', { createdAt: '2026-01-01T00:20:00.000Z' }),
      ] })],
      NOW,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.subject).toBe('earlier')
  })
})

describe('todayUpcoming', () => {
  it('keeps running automations only, soonest first', () => {
    const rows = todayUpcoming([
      { id: 'c', title: '三', status: 'active', scheduledAt: '2026-01-03T01:00:00.000Z' },
      { id: 'a', title: '一', status: 'active', scheduledAt: '2026-01-01T01:00:00.000Z' },
      { id: 'b', title: '二', status: 'active', scheduledAt: '2026-01-02T01:00:00.000Z' },
      { id: 'off', title: '停', status: 'inactive', scheduledAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(rows.map(row => row.id)).toEqual(['a', 'b', 'c'])
    expect(rows[0]?.nextAt).toBe(Date.parse('2026-01-01T01:00:00.000Z'))
  })

  it('keeps one row per automation id, at its earliest occurrence', () => {
    const rows = todayUpcoming([
      { id: 'dup', title: '重复', status: 'active', scheduledAt: '2026-01-02T01:00:00.000Z' },
      { id: 'dup', title: '重复', status: 'active', scheduledAt: '2026-01-01T01:00:00.000Z' },
    ])
    expect(rows).toEqual([{ id: 'dup', name: '重复', nextAt: Date.parse('2026-01-01T01:00:00.000Z') }])
  })

  it('drops rows the clock cannot read', () => {
    expect(todayUpcoming([
      { id: 'broken', title: '坏', status: 'active', scheduledAt: 'not-a-date' },
    ])).toEqual([])
  })
})
