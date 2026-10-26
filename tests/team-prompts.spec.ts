import { describe, expect, it } from 'vitest'
import { coordinatorPrompt, memberPrompt } from '../src/runtime/team-prompts.js'
import type { TeamAggregate, TeamMemberSlot, TeamTask } from '../src/domain/types.js'

const joinedAt = '2026-01-01T00:00:00.000Z'

function leader(role: 'leader' | 'member' = 'leader'): TeamMemberSlot {
  return {
    id: role,
    assistantId: 'assistant-main',
    displayName: role === 'leader' ? '小码' : '小测',
    role,
    assistantSnapshot: {
      assistantId: 'assistant-main',
      revision: 1,
      name: role === 'leader' ? '小码' : '小测',
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
    sessionId: `session-${role}`,
    desiredState: 'online',
    lastRuntimeState: 'idle',
    joinedAt,
  }
}

function team(member: TeamMemberSlot): TeamAggregate {
  return {
    schemaVersion: 2,
    id: 'team-main-agent',
    name: '主 Agent 测试团队',
    workspaceId: 'workspace-main',
    workspacePath: '/tmp/team-main-agent',
    leaderSlotId: member.role === 'leader' ? member.id : 'leader',
    state: 'active',
    directMemberChat: false,
    members: { [member.id]: member },
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: joinedAt,
    updatedAt: joinedAt,
  }
}

const prompt = memberPrompt(team(leader()), leader())

describe('Leader main Agent direct answers', () => {
  it('answers ordinary questions without creating a Goal or a Task', () => {
    expect(prompt).toContain('Ordinary chat must never create a Goal or a task')
    expect(prompt).toContain('answer it and stop')
    expect(prompt).toContain('Do not call team_mode_goal_create or team_mode_task_create for direct mode.')
  })

  it('classifies requests into exactly three modes', () => {
    expect(prompt).toContain('对话/direct')
    expect(prompt).toContain('单任务/single')
    expect(prompt).toContain('编排/orchestrated')
  })
})

describe('Leader thresholds', () => {
  it('creates exactly one Task for a single deliverable', () => {
    expect(prompt).toContain('one owner and one verifiable deliverable')
    expect(prompt).toContain('create exactly one Task')
  })

  it('orchestrates only for real multi-stream work', () => {
    expect(prompt).toContain('2+ parallel workstreams')
    expect(prompt).toContain('2+ members')
    expect(prompt).toContain('cross-task dependency')
    expect(prompt).toContain('independent review')
    expect(prompt).toContain('long-running')
    expect(prompt).toContain('prefer single')
  })
})

describe('Leader aggregation', () => {
  it('speaks to the user as the single voice and synthesizes member results', () => {
    expect(prompt).toContain('only voice to the user')
    expect(prompt).toContain('Aggregate member results into one synthesized answer')
  })

  it('never dumps member transcripts or raw Session output', () => {
    expect(prompt).toContain('Never paste member transcripts')
    expect(prompt).toContain('raw Session output')
    expect(prompt).toContain('message dumps')
  })

  it('brings only human decisions to the user', () => {
    expect(prompt).toContain('Ask the user only for decisions you cannot make')
  })
})

describe('Leader approvals', () => {
  it('never approves or verifies its own work', () => {
    expect(prompt).toContain('Never approve or verify your own deliverable')
    expect(prompt).toContain('assign it to another member')
  })

  it('leaves approvals on the native DSH interaction', () => {
    expect(prompt).toContain('DSH native')
    expect(prompt).toContain('Never approve your own approval request')
  })
})

describe('Teammate prompt', () => {
  it('does not carry the Leader aggregation directive', () => {
    const teammate = leader('member')
    const teammatePrompt = memberPrompt(team(teammate), teammate)
    expect(teammatePrompt).not.toContain('only voice to the user')
    expect(teammatePrompt).not.toContain('Never approve or verify your own deliverable')
  })
})

function slot(id: string, role: 'leader' | 'member'): TeamMemberSlot {
  const base = leader(role)
  return { ...base, id, displayName: id, sessionId: `session-${id}` }
}

function task(id: string, title: string, status: TeamTask['status'] = 'pending'): TeamTask {
  return {
    id,
    title,
    description: '',
    status,
    dependencyIds: [],
    fileScopes: [],
    revision: 1,
    createdAt: joinedAt,
    updatedAt: joinedAt,
  }
}

interface TeamOptions {
  id?: string
  name?: string
  workspaceId?: string
  leader?: string
  members?: string[]
  tasks?: TeamTask[]
  archivedAt?: string
  updatedAt?: string
}

function coordinatorTeam(options: TeamOptions = {}): TeamAggregate {
  const leaderName = options.leader ?? 'Alice'
  const members: Record<string, TeamMemberSlot> = {
    [leaderName]: slot(leaderName, 'leader'),
  }
  for (const name of options.members ?? ['Bob']) members[name] = slot(name, 'member')
  return {
    schemaVersion: 2,
    id: options.id ?? 'team-alpha',
    name: options.name ?? 'Alpha',
    workspaceId: options.workspaceId ?? 'workspace-main',
    workspacePath: '/tmp/coordinator-team',
    leaderSlotId: leaderName,
    state: 'active',
    directMemberChat: false,
    members,
    retiredSessions: {},
    tasks: Object.fromEntries((options.tasks ?? []).map(value => [value.id, value])),
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: joinedAt,
    updatedAt: options.updatedAt ?? joinedAt,
    ...(options.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
  }
}

describe('Coordinator prompt', () => {
  it('lists every live team with its Leader, members, and open-task digest', () => {
    const prompt = coordinatorPrompt([
      coordinatorTeam({
        name: 'Alpha',
        leader: 'Alice',
        members: ['Bob', 'Carol'],
        tasks: [
          task('t1', 'Ship parser', 'running'),
          task('t2', 'Review parser', 'pending'),
          task('t3', 'Already done', 'completed'),
        ],
      }),
      coordinatorTeam({ id: 'team-beta', name: 'Beta', leader: 'Dave', members: [], tasks: [] }),
    ])

    expect(prompt).toContain('this workspace’s 2 teams')
    expect(prompt).toContain('Alpha [active]: Leader Alice; members: Bob, Carol')
    expect(prompt).toContain('open tasks: 2 — [running] Ship parser · [pending] Review parser')
    expect(prompt).not.toContain('Already done')
    expect(prompt).toContain('Beta [active]: Leader Dave; members: none')
    expect(prompt).toContain('open tasks: 0')
  })

  it('carries the coordinator duties, including delegation and honest reporting', () => {
    const prompt = coordinatorPrompt([coordinatorTeam()])

    expect(prompt).toContain('single contact person')
    expect(prompt).toContain('team_send_message')
    expect(prompt).toContain('team_mode_task_create')
    expect(prompt).toContain('team_mode_inbox')
    expect(prompt).toContain('After you delegate, end your turn')
    expect(prompt).toContain('summarize them for the user')
    expect(prompt).toContain('Report failures and blockers honestly')
    expect(prompt).toContain('Never invent progress')
    expect(prompt).toContain('Never paste member transcripts')
  })

  it('hides archived teams and counts only the live ones', () => {
    const prompt = coordinatorPrompt([
      coordinatorTeam({ name: 'Alpha' }),
      coordinatorTeam({ id: 'team-old', name: 'Retired team', archivedAt: joinedAt }),
    ])

    expect(prompt).not.toContain('Retired team')
    expect(prompt).toContain('this workspace’s 1 team.')
  })

  it('says so when the workspace has no teams', () => {
    const prompt = coordinatorPrompt([])

    expect(prompt).toContain('This workspace has no teams yet.')
    expect(prompt).toContain('Coordinator duties:')
  })

  it('caps the named teams and reports how many are not shown', () => {
    const teams = Array.from({ length: 12 }, (_, index) => coordinatorTeam({
      id: `team-${index}`,
      name: `Team ${index}`,
      leader: `Leader${index}`,
      members: [],
    }))

    const prompt = coordinatorPrompt(teams)

    expect(prompt.match(/^- Team /gm)).toHaveLength(8)
    expect(prompt).toContain('4 more teams not shown')
  })

  it('caps members and open-task titles per team', () => {
    const prompt = coordinatorPrompt([coordinatorTeam({
      members: Array.from({ length: 10 }, (_, index) => `Member${index}`),
      tasks: [
        task('t1', 'First task'),
        task('t2', 'Second task'),
        task('t3', 'Third task'),
        task('t4', 'Fourth task'),
        task('t5', 'Fifth task'),
      ],
    })])

    expect(prompt).toContain('+2 more')
    expect(prompt).toContain('(+2 more)')
    expect(prompt).not.toContain('Fourth task')
  })

  it('truncates long names and titles', () => {
    const prompt = coordinatorPrompt([coordinatorTeam({
      name: 'T'.repeat(200),
      members: ['M'.repeat(200)],
      tasks: [task('t1', 'X'.repeat(200))],
    })])

    expect(prompt).not.toContain('T'.repeat(61))
    expect(prompt).not.toContain('X'.repeat(61))
    expect(prompt).toContain('…')
  })

  it('keeps the whole block within its limit however many teams exist', () => {
    const teams = Array.from({ length: 80 }, (_, index) => coordinatorTeam({
      id: `team-${index}`,
      name: `Team ${index} ${'N'.repeat(120)}`,
      leader: `Leader${index}${'L'.repeat(60)}`,
      members: Array.from({ length: 20 }, (_, member) => `M${index}-${member}-${'X'.repeat(60)}`),
      tasks: Array.from({ length: 20 }, (_, taskIndex) =>
        task(`t${index}-${taskIndex}`, `Task ${taskIndex} ${'Y'.repeat(120)}`, 'running')),
    }))

    const prompt = coordinatorPrompt(teams)

    expect(prompt.length).toBeLessThanOrEqual(4_000)
    expect(prompt).toContain('more teams not shown')
    expect(prompt).toContain('Coordinator duties:')
  })
})
