import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import type { TeamAggregate, TeamMemberSlot } from '../src/domain/types.js'
import { TeamRuntime } from '../src/runtime/team-runtime.js'
import type { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import {
  assignmentContent,
  requireMessageContent,
  taskMessageType,
  teamMessageHeader,
} from '../src/runtime/team-messages.js'
import { memberPrompt, rosterPrompt } from '../src/runtime/team-prompts.js'

describe('team runtime support', () => {
  it('builds identity and roster prompts with stable member ids', () => {
    const leader = member('leader-slot', 'Code Leader', 'leader')
    const coder = member('coder-slot', 'Coder', 'member')
    const team = {
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: leader.id,
      members: { [leader.id]: leader, [coder.id]: coder },
    } as unknown as TeamAggregate

    expect(memberPrompt(team, coder)).toContain('You are Coder')
    expect(memberPrompt(team, coder)).toContain('Implement assigned code.')
    expect(memberPrompt(team, coder)).toContain('Standing by')
    expect(memberPrompt(team, coder)).toContain('shutdown_approved')
    expect(memberPrompt(team, leader)).toContain('team_members')
    expect(memberPrompt(team, leader)).toContain('Wait for the user')
    expect(rosterPrompt(team)).toContain('Code Leader (leader), slotId=leader-slot')
    expect(rosterPrompt(team)).toContain('Coder (member), slotId=coder-slot')
    expect(rosterPrompt(team)).toContain('team_read_messages')
  })

  it('documents the steward modes and Goal rules in the Leader prompt', () => {
    const leader = member('leader-slot', 'Code Leader', 'leader')
    const coder = member('coder-slot', 'Coder', 'member')
    const team = {
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: leader.id,
      members: { [leader.id]: leader, [coder.id]: coder },
      tasks: {},
      goals: {},
    } as unknown as TeamAggregate

    const leaderPrompt = memberPrompt(team, leader)
    expect(leaderPrompt).toContain('对话/direct')
    expect(leaderPrompt).toContain('单任务/single')
    expect(leaderPrompt).toContain('编排/orchestrated')
    expect(leaderPrompt).toContain('Ordinary chat must never create a Goal')
    expect(leaderPrompt).toContain('team_mode_goal_create')
    expect(leaderPrompt).toContain('team_mode_goal_list')
    expect(leaderPrompt).toContain('goal_id')
    expect(leaderPrompt).toContain('follow an explicit user override')

    // Teammates get the tool list but not the Leader-only steward rules.
    const coderPrompt = memberPrompt(team, coder)
    expect(coderPrompt).toContain('team_mode_goal_list')
    expect(coderPrompt).not.toContain('Ordinary chat must never create a Goal')

    expect(rosterPrompt(team)).toContain('Current goal count: 0')
    expect(rosterPrompt(team)).toContain('team_mode_goal_list')
  })

  it('clears Goals together with tasks when a draft team is reset', async () => {
    const now = '2026-01-01T00:00:00.000Z'
    let team = {
      schemaVersion: 2,
      id: 'team-reset',
      name: 'Reset Team',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/reset-team',
      leaderSlotId: 'leader-slot',
      state: 'draft',
      directMemberChat: true,
      members: {},
      retiredSessions: {},
      tasks: {
        'task-1': {
          id: 'task-1',
          title: 'Old work',
          description: '',
          status: 'running',
          goalId: 'goal-1',
          dependencyIds: [],
          fileScopes: [],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      },
      goals: {
        'goal-1': {
          id: 'goal-1',
          teamId: 'team-reset',
          title: 'Old goal',
          objective: 'Must not outlive its task board',
          acceptance: '',
          mode: 'single',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      },
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    } as TeamAggregate
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      get: (id: string) => id === 'workspace-1'
        ? { id, path: '/tmp/reset-team', status: async () => 'ok' as const }
        : undefined,
    } as never)
    const service = {
      getTeam: (id: string) => {
        if (id !== team.id) throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${id}'`)
        return team
      },
      retireQueuedMessages: async () => {},
      updateRuntimeTeam: async (
        _teamId: string,
        update: (current: TeamAggregate) => TeamAggregate,
      ) => {
        team = update(team)
        return team
      },
    } as unknown as AgentTeamService
    const runtime = new TeamRuntime(ctx, {} as Config, service)

    const reset = await runtime.resetTeam(team.id)

    expect(reset.tasks).toEqual({})
    expect(reset.goals).toEqual({})
  })

  it('normalizes messages and maps task states to message types', () => {
    expect(requireMessageContent('  ready  ')).toBe('ready')
    expect(() => requireMessageContent('   ')).toThrow(AgentTeamError)
    expect(teamMessageHeader('Coder', 'coder-slot')).toBe(
      '[Team message from Coder; slotId=coder-slot]',
    )
    expect(assignmentContent('Parser', 'Implement it.', ['src/parser.ts'])).toContain(
      'File scopes: src/parser.ts',
    )
    expect(taskMessageType('completed')).toBe('result')
    expect(taskMessageType('blocked')).toBe('question')
    expect(taskMessageType('failed')).toBe('warning')
    expect(taskMessageType('running')).toBe('progress')
  })
})

function member(id: string, displayName: string, role: 'leader' | 'member'): TeamMemberSlot {
  return {
    id,
    displayName,
    role,
    assistantSnapshot: {
      instructions: 'Implement assigned code.',
    },
  } as unknown as TeamMemberSlot
}
