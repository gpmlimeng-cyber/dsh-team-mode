import { describe, expect, it } from 'vitest'
import { memberPrompt } from '../src/runtime/team-prompts.js'
import type { TeamAggregate, TeamMemberSlot } from '../src/domain/types.js'

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
