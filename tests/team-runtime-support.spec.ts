import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import { Config as ConfigSchema } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  MemoryEntry,
  TeamAggregate,
  TeamCheckpoint,
  TeamGoal,
  TeamMemberSlot,
  TeamMessage,
  TeamTask,
} from '../src/domain/types.js'
import { epochOf } from '../src/domain/types.js'
import { teamAggregateSchema } from '../src/domain/schemas.js'
import {
  buildTeamCheckpointFacts,
  teamCheckpointHandoffMessage,
  TeamRuntime,
} from '../src/runtime/team-runtime.js'
import { TeamTurnCoordinator } from '../src/runtime/team-turn-coordinator.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import {
  assignmentContent,
  requireMessageContent,
  taskMessageType,
  teamMessageHeader,
} from '../src/runtime/team-messages.js'
import {
  linkedAssistantMemoryPrompt,
  memberPrompt,
  rosterPrompt,
  teamMemoryPrompt,
} from '../src/runtime/team-prompts.js'
import {
  applyToolSurfaceToPrompt,
  TEAM_TOOL_NAMES,
  teamToolListLine,
} from '../src/runtime/team-tools.js'

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

  it('advertises the registered tool surface and keeps the default list frozen', () => {
    const leader = member('leader-slot', 'Code Leader', 'leader')
    const coder = member('coder-slot', 'Coder', 'member')
    const team = {
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: leader.id,
      members: { [leader.id]: leader, [coder.id]: coder },
    } as unknown as TeamAggregate

    // The pre-policy prompt line must not change for the default surface.
    expect(teamToolListLine(TEAM_TOOL_NAMES)).toBe(
      'Available team tools: team_members, team_read_messages, team_send_message, '
        + 'team_interrupt_agent, team_mode_goal_create, team_mode_goal_list, team_mode_goal_update, '
        + 'team_mode_task_create, team_mode_task_update, team_mode_task_claim, team_mode_task_list, '
        + 'team_mode_inbox, team_escalations, team_memory_propose, team_memory_list, team_memory_accept, '
        + 'team_list_assistants, team_describe_assistant, team_spawn_agent, team_rename_agent, '
        + 'team_clear_agent_context, team_shutdown_agent.',
    )
    expect(memberPrompt(team, coder)).toContain(teamToolListLine(TEAM_TOOL_NAMES))
    expect(memberPrompt(team, coder)).not.toContain('team_create_task')

    // A narrowed member surface is what the prompt advertises.
    const narrowed = ['team_members', 'team_mode_task_list']
    const filtered = applyToolSurfaceToPrompt(memberPrompt(team, coder), narrowed)
    const filteredLine = filtered.split('\n').find(line => line.startsWith('Available team tools:'))
    expect(filteredLine).toBe('Available team tools: team_members, team_mode_task_list.')

    // A closed surface says so instead of printing an empty list.
    expect(applyToolSurfaceToPrompt(memberPrompt(team, coder), []))
      .toContain('No team tools are enabled for this member.')
    // Regenerating from the full baseline keeps the byte-identical default line.
    expect(teamToolListLine(TEAM_TOOL_NAMES)).toBe(
      memberPrompt(team, coder).split('\n').find(line => line.startsWith('Available team tools:')),
    )
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
    expect(leaderPrompt).toContain('team_mode_goal_update')
    expect(leaderPrompt).toContain('new team epoch')
    expect(leaderPrompt).toContain('goal_id')
    expect(leaderPrompt).toContain('follow an explicit user override')

    // Teammates get the tool list but not the Leader-only steward rules.
    const coderPrompt = memberPrompt(team, coder)
    expect(coderPrompt).toContain('team_mode_goal_list')
    expect(coderPrompt).toContain('team_mode_goal_update')
    expect(coderPrompt).not.toContain('Ordinary chat must never create a Goal')

    expect(rosterPrompt(team)).toContain('Current goal count: 0')
    expect(rosterPrompt(team)).toContain('team_mode_goal_list')
  })

  it('keeps legacy teams on epoch 1 and parses the optional epoch field', () => {
    const base = {
      schemaVersion: 1 as const,
      id: 'team-schema',
      name: 'Schema Team',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/schema-team',
      leaderSlotId: 'leader-slot',
      state: 'active' as const,
      directMemberChat: true,
      members: {},
      retiredSessions: {},
      tasks: {},
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    // Legacy record: no field, no schema bump, and the reader defaults to 1.
    const legacy = teamAggregateSchema.parse(base)
    expect(legacy.epoch).toBeUndefined()
    expect(epochOf(legacy)).toBe(1)

    const nextEpoch = teamAggregateSchema.parse({ ...base, epoch: 2 })
    expect(nextEpoch.schemaVersion).toBe(1)
    expect(epochOf(nextEpoch)).toBe(2)

    expect(teamAggregateSchema.safeParse({ ...base, epoch: 0 }).success).toBe(false)
    expect(teamAggregateSchema.safeParse({ ...base, epoch: 1.5 }).success).toBe(false)
  })

  it('rejects a team tool call whose Session belongs to an old epoch', () => {
    const now = '2026-01-01T00:00:00.000Z'
    const leader = member('leader-slot', 'Lead', 'leader')
    let team = {
      schemaVersion: 2,
      id: 'team-epoch',
      name: 'Epoch Team',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/epoch-team',
      leaderSlotId: leader.id,
      state: 'active',
      directMemberChat: true,
      epoch: 2,
      members: { [leader.id]: { ...leader, sessionId: 'session-current' } },
      retiredSessions: {},
      tasks: {},
      leases: {},
      outbox: {},
      revision: 3,
      createdAt: now,
      updatedAt: now,
    } as TeamAggregate
    const ctx = new Context()
    const service = {
      getTeam: (id: string) => {
        if (id !== team.id) throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${id}'`)
        return team
      },
    } as unknown as AgentTeamService
    const runtime = new TeamRuntime(ctx, {} as Config, service)
    const internals = runtime as unknown as {
      owned: Map<string, unknown>
      assertToolIdentity: (
        agent: { id: string } | undefined,
        teamId: string,
        slotId: string,
        sessionId: string,
      ) => void
    }
    const stale = {
      teamId: team.id,
      slotId: leader.id,
      sessionId: 'session-retired',
      epoch: 1,
    }
    internals.owned.set('session-retired', stale)

    expect(() => internals.assertToolIdentity({ id: 'session-retired' }, team.id, leader.id, 'session-retired'))
      .toThrowError(expect.objectContaining({ code: 'EPOCH_STALE' }))

    // Same Session under the current epoch is still authorized.
    internals.owned.set('session-retired', { ...stale, epoch: 2 })
    expect(() => internals.assertToolIdentity({ id: 'session-retired' }, team.id, leader.id, 'session-retired'))
      .not.toThrow()

    // A tool closure registered for another Session of the same slot is not it.
    expect(() => internals.assertToolIdentity({ id: 'session-retired' }, team.id, leader.id, 'session-other'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))

    // The epoch is read live from the aggregate, so a later bump fences too.
    team = { ...team, epoch: 3 }
    expect(() => internals.assertToolIdentity({ id: 'session-retired' }, team.id, leader.id, 'session-retired'))
      .toThrowError(expect.objectContaining({ code: 'EPOCH_STALE' }))
  })

  it('loads teams with and without optional memory without a schema bump', () => {
    const base = {
      schemaVersion: 1 as const,
      id: 'team-schema',
      name: 'Schema Team',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/schema-team',
      leaderSlotId: 'leader-slot',
      state: 'active' as const,
      directMemberChat: true,
      members: {},
      retiredSessions: {},
      tasks: {},
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    const legacy = teamAggregateSchema.parse(base)
    expect(legacy.schemaVersion).toBe(1)
    expect(legacy.memory).toBeUndefined()

    const withMemory = teamAggregateSchema.parse({
      ...base,
      memory: {
        revision: 2,
        entries: [memoryEntry('mem-1', 'active', 'Commit style', 'Conventional commits.')],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    expect(withMemory.schemaVersion).toBe(1)
    expect(withMemory.memory?.entries).toHaveLength(1)
    expect(withMemory.memory?.entries[0]).toMatchObject({ scope: 'team', visibility: 'team-safe' })
  })

  it('injects only active team memory into member prompts', () => {
    const active = memoryEntry('mem-active', 'active', 'Lint', 'Use eslint.')
    const proposed = memoryEntry('mem-proposed', 'proposed', 'Secrets', 'PROPOSED-BODY')
    const superseded = memoryEntry('mem-superseded', 'superseded', 'Old lint', 'SUPERSEDED-BODY')
    const archived = memoryEntry('mem-archived', 'archived', 'Dropped', 'ARCHIVED-BODY')
    // Hand-written shapes the API would not produce: a private team entry and
    // an assistant-scoped entry stored in the team container must not load.
    const privateEntry = memoryEntry('mem-private', 'active', 'Private note', 'PRIVATE-BODY', {
      visibility: 'private',
    })
    const wrongScope = memoryEntry('mem-wrong-scope', 'active', 'Assistant note', 'ASSISTANT-SCOPE-BODY', {
      scope: 'assistant',
    })
    const team = {
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: 'leader-slot',
      members: {},
      memory: {
        revision: 4,
        entries: [active, proposed, superseded, archived, privateEntry, wrongScope],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    } as unknown as TeamAggregate

    const prompt = teamMemoryPrompt(team)
    expect(prompt).toContain('Team memory')
    expect(prompt).toContain('Lint: Use eslint.')
    expect(prompt).not.toContain('PROPOSED-BODY')
    expect(prompt).not.toContain('SUPERSEDED-BODY')
    expect(prompt).not.toContain('ARCHIVED-BODY')
    expect(prompt).not.toContain('PRIVATE-BODY')
    expect(prompt).not.toContain('ASSISTANT-SCOPE-BODY')

    // The member prompt section is roster + team memory, same as runtime.
    const composed = [rosterPrompt(team), teamMemoryPrompt(team)]
      .filter(line => line !== '')
      .join('\n\n')
    expect(composed).toContain('Team roster')
    expect(composed).toContain('Use eslint.')
    expect(composed).not.toContain('PROPOSED-BODY')

    // A team without memory injects no memory block at all.
    expect(teamMemoryPrompt({ ...team, memory: undefined } as TeamAggregate)).toBe('')
    expect(teamMemoryPrompt({
      ...team,
      memory: { revision: 1, entries: [proposed], updatedAt: '2026-01-01T00:00:00.000Z' },
    } as TeamAggregate)).toBe('')
  })

  it('injects only active team-safe memory from an explicitly linked assistant instance', () => {
    const active = memoryEntry('mem-active', 'active', 'Style', 'SHARED-BODY', { scope: 'assistant' })
    const privateEntry = memoryEntry('mem-private', 'active', 'Private', 'PRIVATE-BODY', {
      scope: 'assistant',
      visibility: 'private',
    })
    const proposed = memoryEntry('mem-proposed', 'proposed', 'Proposal', 'PROPOSED-BODY', {
      scope: 'assistant',
    })
    const archived = memoryEntry('mem-archived', 'archived', 'Old', 'ARCHIVED-BODY', {
      scope: 'assistant',
    })
    const wrongScope = memoryEntry('mem-team', 'active', 'Team row', 'TEAM-SCOPE-BODY')
    const prompt = linkedAssistantMemoryPrompt({
      state: 'linked',
      entries: [active, privateEntry, proposed, archived, wrongScope],
    })

    expect(prompt).toContain('Assistant memory')
    expect(prompt).toContain('Style: SHARED-BODY')
    expect(prompt).not.toContain('PRIVATE-BODY')
    expect(prompt).not.toContain('PROPOSED-BODY')
    expect(prompt).not.toContain('ARCHIVED-BODY')
    expect(prompt).not.toContain('TEAM-SCOPE-BODY')

    // Unlinked members and stale links inject nothing at all.
    expect(linkedAssistantMemoryPrompt({ state: 'unlinked', entries: [active] })).toBe('')
    expect(linkedAssistantMemoryPrompt({ state: 'archived', entries: [active] })).toBe('')
    expect(linkedAssistantMemoryPrompt({ state: 'unavailable', entries: [active] })).toBe('')
    expect(linkedAssistantMemoryPrompt({ state: 'linked', entries: [privateEntry] })).toBe('')
  })

  it('bounds the injected linked assistant memory block', () => {
    const entries = Array.from({ length: 40 }, (_, index) => memoryEntry(
      `assistant-mem-${index}`,
      'active',
      `Entry ${index}`,
      'x'.repeat(500),
      { scope: 'assistant' },
    ))
    const prompt = linkedAssistantMemoryPrompt({ state: 'linked', entries })
    expect(prompt.length).toBeLessThan(2_400)
    expect(prompt.endsWith('…')).toBe(true)
  })

  it('loads legacy members without an assistant instance link', () => {
    const legacyMember = {
      id: 'legacy-slot',
      assistantId: 'assistant-1',
      displayName: 'Legacy',
      role: 'member' as const,
      assistantSnapshot: {
        assistantId: 'assistant-1',
        revision: 1,
        name: 'Legacy',
        instructions: '',
        provider: 'test',
        model: 'test-model',
        agentPresetId: 'standard',
        permissionPresetId: 'read-only',
        skillAllowlist: [],
        mcpServers: [],
        prompts: [],
      },
      permissionPresetId: 'read-only',
      sessionId: 'session-legacy',
      desiredState: 'offline' as const,
      lastRuntimeState: 'offline' as const,
      joinedAt: '2026-01-01T00:00:00.000Z',
    }
    const base = {
      schemaVersion: 1 as const,
      id: 'team-legacy',
      name: 'Legacy Team',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/legacy-team',
      leaderSlotId: 'leader-slot',
      state: 'draft' as const,
      directMemberChat: true,
      members: { 'legacy-slot': legacyMember },
      retiredSessions: {},
      tasks: {},
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    const legacy = teamAggregateSchema.parse(base)
    expect(legacy.schemaVersion).toBe(1)
    expect(legacy.members['legacy-slot']?.assistantInstanceId).toBeUndefined()

    const linked = teamAggregateSchema.parse({
      ...base,
      members: { 'legacy-slot': { ...legacyMember, assistantInstanceId: 'instance-1' } },
    })
    expect(linked.schemaVersion).toBe(1)
    expect(linked.members['legacy-slot']?.assistantInstanceId).toBe('instance-1')
  })

  it('bounds the injected team memory block', () => {
    const entries = Array.from({ length: 40 }, (_, index) => memoryEntry(
      `mem-${index}`,
      'active',
      `Entry ${index}`,
      'x'.repeat(500),
    ))
    const prompt = teamMemoryPrompt({
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: 'leader-slot',
      members: {},
      memory: { revision: 1, entries, updatedAt: '2026-01-01T00:00:00.000Z' },
    } as unknown as TeamAggregate)
    expect(prompt.length).toBeLessThan(2_400)
    expect(prompt.endsWith('…')).toBe(true)
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
      memory: {
        revision: 2,
        entries: [
          memoryEntry('mem-active', 'active', 'Commit style', 'Conventional commits.'),
          memoryEntry('mem-proposed', 'proposed', 'Pending idea', 'Awaiting Leader.'),
        ],
        updatedAt: now,
      },
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
      listTeamSessionIds: () => [] as string[],
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
    // Team memory is durable knowledge, not board state: reset preserves it
    // verbatim (same team, same entries, same revisions and visibility).
    expect(reset.memory).toEqual(team.memory)
    expect(reset.memory?.entries.map(entry => entry.status)).toEqual(['active', 'proposed'])
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

  it('reuses one 30s tick for reminders and the routine, serializes sweeps, and clears it on dispose', async () => {
    vi.useFakeTimers()
    try {
      const teams = [
        { id: 'team-a', state: 'active' },
        { id: 'team-b', state: 'active' },
        { id: 'team-c', state: 'deleting' },
      ] as unknown as TeamAggregate[]
      const service = {
        listTeams: () => ({ items: teams, total: teams.length }),
      } as unknown as AgentTeamService
      const runtime = new TeamRuntime(
        new Context(),
        { teamRoutineIdleMs: 60_000 } as Config,
        service,
      )
      const internals = runtime as unknown as {
        armReminderTick: () => void
        reminderTimer?: unknown
        commands: {
          remindDueTasks: (teamId: string, now: string) => Promise<{
            teamId: string
            remindedTaskIds: string[]
          }>
          runDueRoutine: (teamId: string, now: string) => Promise<{
            teamId: string
            nudged: boolean
          }>
        }
      }
      let release!: () => void
      const blocked = new Promise<{ teamId: string; remindedTaskIds: string[] }>(resolve => {
        release = () => resolve({ teamId: 'team-a', remindedTaskIds: [] })
      })
      const remindDueTasks = vi.fn()
        .mockImplementationOnce(() => blocked)
        .mockResolvedValue({ teamId: 'team-b', remindedTaskIds: [] })
      const runDueRoutine = vi.fn(async (teamId: string) => ({ teamId, nudged: false }))
      internals.commands = { remindDueTasks, runDueRoutine } as never

      internals.armReminderTick()
      const armed = internals.reminderTimer
      internals.armReminderTick()
      expect(internals.reminderTimer).toBe(armed)

      // The first tick blocks on team-a's reminder, so a second tick must not
      // overlap it — neither the reminders nor the routine run twice.
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(remindDueTasks).toHaveBeenCalledTimes(1)
      expect(remindDueTasks).toHaveBeenCalledWith('team-a', expect.any(String))
      expect(runDueRoutine).not.toHaveBeenCalled()

      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(remindDueTasks.mock.calls.map(call => call[0])).toEqual(['team-a', 'team-b'])
      expect(remindDueTasks.mock.calls.some(call => call[0] === 'team-c')).toBe(false)
      expect(runDueRoutine.mock.calls.map(call => call[0])).toEqual(['team-a', 'team-b'])
      expect(runDueRoutine.mock.calls.some(call => call[0] === 'team-c')).toBe(false)

      await runtime.dispose()
      expect(internals.reminderTimer).toBeUndefined()
      remindDueTasks.mockClear()
      runDueRoutine.mockClear()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(remindDueTasks).not.toHaveBeenCalled()
      expect(runDueRoutine).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the routine off when teamRoutineIdleMs is absent or zero', async () => {
    // The deployment default is off without adding a required config field.
    const defaults = (ConfigSchema as unknown as (value: Record<string, never>) => Config)({})
    expect(defaults.teamRoutineIdleMs).toBe(0)
    vi.useFakeTimers()
    try {
      const teams = [{ id: 'team-a', state: 'active' }] as unknown as TeamAggregate[]
      const service = {
        listTeams: () => ({ items: teams, total: teams.length }),
      } as unknown as AgentTeamService
      const runtime = new TeamRuntime(new Context(), {} as Config, service)
      const internals = runtime as unknown as {
        armReminderTick: () => void
        commands: {
          remindDueTasks: (teamId: string, now: string) => Promise<{ teamId: string; remindedTaskIds: string[] }>
          runDueRoutine: (teamId: string, now: string) => Promise<{ teamId: string; nudged: boolean }>
        }
      }
      const remindDueTasks = vi.fn(async (teamId: string) => ({ teamId, remindedTaskIds: [] }))
      const runDueRoutine = vi.fn(async (teamId: string) => ({ teamId, nudged: false }))
      internals.commands = { remindDueTasks, runDueRoutine } as never

      internals.armReminderTick()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(remindDueTasks).toHaveBeenCalledTimes(1)
      expect(runDueRoutine).not.toHaveBeenCalled()
      await runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('team checkpoint facts', () => {
  it('bounds the transcript tail, keeps relayed mail separate, and drops tool noise', () => {
    const team = checkpointTeam()
    const mail = memberMail({
      id: 'mail-1',
      content: `Report ${'very long status '.repeat(40)}`,
    })
    const events: SessionEvent[] = []
    let seq = 0
    for (let index = 0; index < 14; index += 1) {
      events.push(userEvent(seq++, `user-${index}`, `  question   ${index}  `))
      events.push(assistantEvent(seq++, `assistant-${index}`, `answer ${index}`))
    }
    events.push(userEvent(seq++, mail.id, mail.content, { kind: 'team-message', plugin: 'dsh-team-mode' }))
    // Reasoning and tool arguments are never copied into facts.
    events.push({
      seq: seq++,
      time: 1_700_000_000_000 + seq,
      type: 'tool/call',
      data: { callId: 'call-1', name: 'bash', arguments: 'SECRET-TOOL-ARGS' },
    } as unknown as SessionEvent)
    events.push({
      seq: seq++,
      time: 1_700_000_000_000 + seq,
      type: 'assistant/attempt',
      data: { turn: 99, step: 1, stream: [{ type: 'reasoning', text: 'SECRET-REASONING' }] },
    } as unknown as SessionEvent)

    const built = buildTeamCheckpointFacts({
      events,
      team,
      messages: [mail],
      tasks: [],
      goals: [],
      workspacePath: team.workspacePath,
      note: '  continue  ',
    })

    expect(built.facts.recentMessages).toHaveLength(12)
    expect(built.facts.recentMessages[0]).toEqual({ role: 'user', text: 'question 8' })
    for (const message of built.facts.recentMessages) {
      expect(message.text.length).toBeLessThanOrEqual(500)
      expect(message.text).not.toContain('Report')
      expect(message.text).not.toContain('SECRET')
    }
    // Member mail is a separate bounded field, never a user message.
    expect(built.facts.recentTeamMail).toEqual([{
      fromName: 'Coder',
      type: 'progress',
      text: expect.any(String),
    }])
    expect(built.facts.recentTeamMail[0]!.text.length).toBeLessThanOrEqual(300)
    expect(built.facts.recentTeamMail[0]!.text.startsWith('Report')).toBe(true)
    expect(built.capturedThroughSeq).toBe(seq - 1)
    expect(built.facts.workspacePath).toBe(team.workspacePath)
  })

  it('lists pending-inclusive open tasks and active Goals newest first', () => {
    const team = checkpointTeam()
    const tasks = [
      checkpointTask({ id: 'done', status: 'completed', updatedAt: '2026-10-01T00:00:00.000Z' }),
      checkpointTask({ id: 'pending', status: 'pending', updatedAt: '2026-10-02T00:00:00.000Z' }),
      checkpointTask({ id: 'running', status: 'running', updatedAt: '2026-10-04T00:00:00.000Z' }),
      checkpointTask({ id: 'blocked', status: 'blocked', updatedAt: '2026-10-03T00:00:00.000Z' }),
      checkpointTask({ id: 'failed', status: 'failed', updatedAt: '2026-10-05T00:00:00.000Z' }),
    ]
    const goals = [
      checkpointGoal({ id: 'goal-active', status: 'active', updatedAt: '2026-10-02T00:00:00.000Z' }),
      checkpointGoal({ id: 'goal-paused', status: 'paused', updatedAt: '2026-10-03T00:00:00.000Z' }),
    ]

    const built = buildTeamCheckpointFacts({
      events: [],
      team,
      messages: [],
      tasks,
      goals,
      workspacePath: team.workspacePath,
      note: '',
    })

    expect(built.facts.recentMessages).toEqual([])
    expect(built.capturedThroughSeq).toBe(-1)
    expect(built.facts.activeTasks.map(task => task.id)).toEqual(['running', 'blocked', 'pending'])
    expect(built.facts.activeTasks[0]).toEqual({ id: 'running', title: 'Task running', status: 'running' })
    expect(built.facts.activeGoals).toEqual([{ id: 'goal-active', title: 'Goal goal-active', status: 'active' }])
    expect(built.facts.recentTeamMail).toEqual([])
  })

  it('states the handoff source and bounds the injected text', () => {
    const checkpoint = checkpointRecord({ note: 'pick up the parser work' })
    const message = teamCheckpointHandoffMessage(checkpoint)

    expect(message.source).toEqual({ kind: 'runtime-context', form: 'instructions' })
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('上下文交接')
    expect(text).toContain('不是模型总结')
    expect(text).toContain('pick up the parser work')
    expect(text).toContain('进行中的 Goal')
    expect(text).toContain('最近团队邮件')
    expect(text).not.toContain('session-')
  })
})

describe('Leader Team Session handoff', () => {
  it('creates a fresh Leader Session and preserves every other durable field', async () => {
    const h = handoffHarness()
    const before = h.team()
    const leader = before.members[before.leaderSlotId]!
    const oldSessionId = leader.sessionId

    const result = await h.runtime.handoffLeader(before.id, h.checkpoint.id, {
      expectedRevision: before.revision,
    })

    // The old handle is cancelled, drained, flushed and disposed exactly once.
    expect(h.agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(h.agent.whenIdle).toHaveBeenCalledOnce()
    expect(h.flush).toHaveBeenCalledOnce()
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.detachSession).toHaveBeenCalledWith(oldSessionId)

    const after = h.team()
    expect(after.members[leader.id]!.sessionId).not.toBe(oldSessionId)
    expect(result.sessionId).toBe(after.members[leader.id]!.sessionId)
    expect(h.ensureMemberOnline).toHaveBeenCalledOnce()
    const seedCall = h.ensureMemberOnline.mock.calls[0]!
    expect(seedCall[0]).toBe(after)
    expect(seedCall[1]).toMatchObject({ id: leader.id })
    expect(seedCall[2]).toBe(false)
    expect(seedCall[3]?.seed?.source).toEqual({ kind: 'runtime-context', form: 'instructions' })

    // The write is one aggregate update carrying the revision and Session fences.
    expect(h.service.updateRuntimeTeam).toHaveBeenCalledOnce()
    const options = h.service.updateRuntimeTeam.mock.calls[0]![4] as {
      expectedRevision?: number
      expectedMemberSession?: { slotId: string; sessionId: string }
    }
    expect(options).toEqual({
      expectedRevision: before.revision,
      expectedMemberSession: { slotId: leader.id, sessionId: oldSessionId },
    })

    // Nothing durable moved: same team, epoch, Leader, roster, board and history.
    expect(after.id).toBe(before.id)
    expect(after.name).toBe(before.name)
    expect(after.workspaceId).toBe(before.workspaceId)
    expect(after.leaderSlotId).toBe(before.leaderSlotId)
    expect(epochOf(after)).toBe(epochOf(before))
    expect(after.tasks).toEqual(before.tasks)
    expect(after.tasks.assigned?.attemptId).toBe('attempt-1')
    expect(after.goals).toEqual(before.goals)
    expect(after.memory).toEqual(before.memory)
    expect(after.leases).toEqual(before.leases)
    expect(after.outbox).toEqual(before.outbox)
    expect(after.memberOrder).toEqual(before.memberOrder)
    for (const member of Object.values(before.members)) {
      if (member.id === leader.id) continue
      expect(after.members[member.id]).toEqual(member)
    }

    // The retired Session is a tombstone, never deleted or reparented.
    expect(after.retiredSessions[oldSessionId]).toMatchObject({
      formerSlotId: leader.id,
      sessionId: oldSessionId,
      displayName: leader.displayName,
    })
    expect(after.retiredLeaderSessionIds).toEqual([oldSessionId])
    expect(h.service.consumeTeamCheckpoint).toHaveBeenCalledWith(
      before.id,
      h.checkpoint.id,
      result.sessionId,
    )
    expect(result.checkpoint).toMatchObject({ status: 'consumed', targetSessionId: result.sessionId })
  })

  it('rejects a stale checkpoint and a running Leader before touching anything', async () => {
    const stale = handoffHarness({ checkpoint: { epoch: 1 } })
    await expect(stale.runtime.handoffLeader(stale.team().id, stale.checkpoint.id))
      .rejects.toMatchObject({ code: 'CHECKPOINT_STALE' })
    expect(stale.ensureMemberOnline).not.toHaveBeenCalled()

    const moved = handoffHarness({ checkpoint: { sourceSessionId: 'session-other' } })
    await expect(moved.runtime.handoffLeader(moved.team().id, moved.checkpoint.id))
      .rejects.toMatchObject({ code: 'CHECKPOINT_STALE' })

    const busy = handoffHarness({ leaderStatus: 'running' })
    await expect(busy.runtime.handoffLeader(busy.team().id, busy.checkpoint.id))
      .rejects.toMatchObject({ code: 'MEMBER_BUSY' })
    expect(busy.ensureMemberOnline).not.toHaveBeenCalled()
    expect(busy.agent.cancel).not.toHaveBeenCalled()
    expect(busy.team().members[busy.team().leaderSlotId]!.sessionId).toBe('session-leader')

    const consumed = handoffHarness({ checkpoint: { status: 'consumed' } })
    await expect(consumed.runtime.handoffLeader(consumed.team().id, consumed.checkpoint.id))
      .rejects.toMatchObject({ code: 'CHECKPOINT_NOT_READY' })

    const draft = handoffHarness({ state: 'draft' })
    await expect(draft.runtime.handoffLeader(draft.team().id, draft.checkpoint.id))
      .rejects.toMatchObject({ code: 'TEAM_NOT_ACTIVE' })
  })

  it('routes queued mail to the fresh Leader Session, never the retired one', async () => {
    const followup = vi.fn()
    const queued = memberMail({ id: 'queued-1', deliveryState: 'queued' })
    let leaderSessionId = 'session-old'
    const base = checkpointTeam()
    const coordinator = new TeamTurnCoordinator({
      getTeam: () => ({
        ...base,
        members: {
          ...base.members,
          leader: { ...base.members.leader!, sessionId: leaderSessionId },
        },
      }),
      listMessages: () => [queued],
      putMessage: async () => {},
      followup,
      sessionState: () => 'online',
      hasMessage: () => false,
      warn: () => {},
    })

    await coordinator.drain(base.id)
    expect(followup).toHaveBeenLastCalledWith('session-old', queued)

    // A handoff rotates `members[leader].sessionId`; recipients are resolved by
    // slot at delivery time, so the queued turn reaches the fresh Session.
    leaderSessionId = 'session-new'
    await coordinator.drain(base.id)
    expect(followup).toHaveBeenLastCalledWith('session-new', queued)
    expect(followup.mock.calls.filter(([sessionId]) => sessionId === 'session-old')).toHaveLength(1)
  })

  it('keeps the checkpoint ready and marks the member when the new Session fails to start', async () => {
    const h = handoffHarness({ activationError: new Error('activation failed') })

    await expect(h.runtime.handoffLeader(h.team().id, h.checkpoint.id))
      .rejects.toThrow('activation failed')

    const after = h.team()
    const leader = after.members[after.leaderSlotId]!
    expect(leader.lastRuntimeState).toBe('error')
    expect(leader.sessionId).not.toBe('session-leader')
    expect(after.retiredSessions['session-leader']).toBeDefined()
    // Retry surface: the fresh Session is durable and the checkpoint can be reused.
    expect(h.service.consumeTeamCheckpoint).not.toHaveBeenCalled()
  })
})

const CHECKPOINT_NOW = '2026-10-24T00:00:00.000Z'

function checkpointTeam(): TeamAggregate {
  const leader = checkpointMember('leader', 'Lead', 'leader', 'session-leader')
  const coder = checkpointMember('coder-slot', 'Coder', 'member', 'session-coder')
  return {
    schemaVersion: 2,
    id: 'team-1',
    name: 'Test Team',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/test-team',
    leaderSlotId: leader.id,
    state: 'active',
    directMemberChat: true,
    members: { [leader.id]: leader, [coder.id]: coder },
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    memberOrder: [leader.id, coder.id],
    epoch: 2,
    revision: 7,
    createdAt: CHECKPOINT_NOW,
    updatedAt: CHECKPOINT_NOW,
  }
}

function checkpointMember(
  id: string,
  displayName: string,
  role: 'leader' | 'member',
  sessionId: string,
): TeamMemberSlot {
  return {
    id,
    assistantId: `assistant-${id}`,
    displayName,
    role,
    assistantSnapshot: {
      assistantId: `assistant-${id}`,
      revision: 1,
      name: displayName,
      instructions: '',
      provider: 'test',
      model: 'test-model',
      agentPresetId: 'standard',
      permissionPresetId: 'read-only',
      skillAllowlist: [],
      mcpServers: [],
    },
    permissionPresetId: 'read-only',
    sessionId,
    desiredState: 'online',
    lastRuntimeState: 'idle',
    joinedAt: CHECKPOINT_NOW,
  } as unknown as TeamMemberSlot
}

function checkpointTask(overrides: Partial<TeamTask> & { id: string }): TeamTask {
  return {
    title: `Task ${overrides.id}`,
    description: '',
    dependencyIds: [],
    fileScopes: [],
    revision: 1,
    createdAt: CHECKPOINT_NOW,
    updatedAt: CHECKPOINT_NOW,
    ...overrides,
    status: overrides.status ?? 'pending',
  } as unknown as TeamTask
}

function checkpointGoal(overrides: Partial<TeamGoal> & { id: string }): TeamGoal {
  return {
    teamId: 'team-1',
    title: `Goal ${overrides.id}`,
    objective: 'Objective',
    acceptance: '',
    mode: 'single',
    createdAt: CHECKPOINT_NOW,
    updatedAt: CHECKPOINT_NOW,
    ...overrides,
    status: overrides.status ?? 'active',
  } as unknown as TeamGoal
}

function memberMail(overrides: Partial<TeamMessage> & { id: string }): TeamMessage {
  return {
    schemaVersion: 1,
    teamId: 'team-1',
    sender: { kind: 'member', id: 'coder-slot' },
    recipient: { kind: 'leader', slotId: 'leader' },
    type: 'progress',
    content: 'status',
    attachments: [],
    readBy: [],
    deliveryState: 'delivered',
    idempotencyKey: overrides.id,
    createdAt: CHECKPOINT_NOW,
    ...overrides,
  } as unknown as TeamMessage
}

function checkpointRecord(overrides: Partial<TeamCheckpoint> = {}): TeamCheckpoint {
  const built = buildTeamCheckpointFacts({
    events: [userEvent(0, 'user-1', 'Plan the handoff')],
    team: checkpointTeam(),
    messages: [memberMail({ id: 'mail-1', content: 'Halfway there' })],
    tasks: [checkpointTask({ id: 'task-1', status: 'assigned' })],
    goals: [checkpointGoal({ id: 'goal-1' })],
    workspacePath: '/tmp/test-team',
    note: 'note',
  })
  return {
    schemaVersion: 1,
    id: 'checkpoint-1',
    teamId: 'team-1',
    leaderSlotId: 'leader',
    epoch: 2,
    sourceSessionId: 'session-leader',
    title: '检查点',
    note: 'note',
    capturedThroughSeq: built.capturedThroughSeq,
    facts: { ...built.facts, note: overrides.note ?? built.facts.note },
    status: 'ready',
    createdAt: CHECKPOINT_NOW,
    ...overrides,
  } as TeamCheckpoint
}

function userEvent(
  seq: number,
  id: string,
  text: string,
  source: Record<string, unknown> = { kind: 'user' },
): SessionEvent {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'user/message',
    data: {
      id,
      role: 'user',
      source,
      content: [{ type: 'text', text }],
    },
  } as unknown as SessionEvent
}

function assistantEvent(seq: number, id: string, text: string): SessionEvent {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'assistant/message',
    data: {
      turn: seq + 1,
      step: 1,
      message: {
        id,
        role: 'assistant',
        source: { kind: 'model', provider: 'test', model: 'test-model' },
        content: [{ type: 'text', text }],
      },
      stream: [],
    },
  } as unknown as SessionEvent
}

function handoffHarness(options: {
  state?: TeamAggregate['state']
  leaderStatus?: 'idle' | 'running'
  activationError?: Error
  checkpoint?: Partial<TeamCheckpoint>
} = {}) {
  let team: TeamAggregate = { ...checkpointTeam(), state: options.state ?? 'active' }
  team.tasks = {
    assigned: {
      ...checkpointTask({ id: 'assigned', status: 'assigned' }),
      ownerSlotId: 'coder-slot',
      attemptId: 'attempt-1',
    },
  }
  team.goals = { 'goal-1': checkpointGoal({ id: 'goal-1' }) }
  team.memory = {
    revision: 2,
    entries: [{
      id: 'entry-1',
      scope: 'team',
      visibility: 'team-safe',
      status: 'active',
      source: 'member',
      title: 'Style',
      body: 'Conventional commits.',
      revision: 1,
      createdAt: CHECKPOINT_NOW,
      updatedAt: CHECKPOINT_NOW,
    }],
    updatedAt: CHECKPOINT_NOW,
  } as unknown as TeamAggregate['memory']
  team.leases = {
    'lease-1': {
      id: 'lease-1',
      slotId: 'coder-slot',
      taskId: 'assigned',
      path: 'src/parser.ts',
      acquiredAt: CHECKPOINT_NOW,
    },
  }
  team.outbox = { 'msg-1': memberMail({ id: 'msg-1' }) }
  const checkpoint = checkpointRecord({ ...(options.checkpoint ?? {}) })
  const agent = {
    id: 'session-leader',
    status: options.leaderStatus ?? 'idle',
    session: {
      id: 'session-leader',
      snapshotEvents: () => [] as SessionEvent[],
    },
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
  const dispose = vi.fn(async () => {})
  const flush = vi.fn(async () => {})
  const detachSession = vi.fn(async () => {})
  const workspace = {
    id: 'workspace-1',
    path: team.workspacePath,
    status: async () => 'ok' as const,
    attachSession: async () => {},
    detachSession,
  }
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('sessions', { flush } as never)
  ctx.provide('workspaceRegistry', {
    get: (id: string) => id === workspace.id ? workspace : undefined,
    list: () => [workspace],
  } as never)
  const lastOptions: { value?: unknown } = {}
  const service = {
    getTeam: () => team,
    listMessages: () => ({ items: [memberMail({ id: 'mail-1' })], total: 1 }),
    getTeamCheckpoint: (_teamId: string, checkpointId: string) => {
      if (checkpointId !== checkpoint.id) {
        throw new AgentTeamError('CHECKPOINT_NOT_FOUND', `Unknown checkpoint '${checkpointId}'`)
      }
      return checkpoint
    },
    updateRuntimeTeam: vi.fn(async (
      _teamId: string,
      update: (current: TeamAggregate) => TeamAggregate,
      _kind?: string,
      _summary?: string,
      writeOptions?: unknown,
    ) => {
      lastOptions.value = writeOptions
      team = { ...update(team), revision: team.revision + 1, updatedAt: CHECKPOINT_NOW }
      return team
    }),
    consumeTeamCheckpoint: vi.fn(async (
      _teamId: string,
      _checkpointId: string,
      targetSessionId: string,
    ) => ({ ...checkpoint, status: 'consumed', targetSessionId })),
    createTeamCheckpoint: vi.fn(),
  } as unknown as AgentTeamService
  const runtime = new TeamRuntime(ctx, {} as Config, service)
  const internals = runtime as unknown as {
    owned: Map<string, unknown>
    ensureMemberOnline: ReturnType<typeof vi.fn>
  }
  internals.owned.set(team.members[team.leaderSlotId]!.sessionId, {
    teamId: team.id,
    slotId: team.leaderSlotId,
    sessionId: team.members[team.leaderSlotId]!.sessionId,
    epoch: epochOf(team),
    handle: { agent, dispose },
    modelSelection: { current: undefined, assembled: undefined },
  })
  const ensureMemberOnline = vi.fn(async (
    _team: TeamAggregate,
    _member: TeamMemberSlot,
    _persisted: boolean,
    _seedOptions?: { seed?: { source: unknown } },
  ) => {
    if (options.activationError !== undefined) throw options.activationError
  })
  internals.ensureMemberOnline = ensureMemberOnline
  return {
    runtime,
    service: service as unknown as {
      updateRuntimeTeam: ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } }
      consumeTeamCheckpoint: ReturnType<typeof vi.fn>
    },
    checkpoint,
    team: () => team,
    agent,
    dispose,
    flush,
    detachSession,
    ensureMemberOnline,
    lastOptions,
  }
}

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

function memoryEntry(
  id: string,
  status: MemoryEntry['status'],
  title: string,
  body: string,
  overrides: Partial<MemoryEntry> = {},
): MemoryEntry {
  return {
    ...overrides,
    id,
    scope: overrides.scope ?? 'team',
    visibility: overrides.visibility ?? 'team-safe',
    status,
    source: 'member',
    authorSlotId: 'coder-slot',
    title,
    body,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('opt-in threshold checkpoint', () => {
  it('defaults to off with a 30 minute spacing', () => {
    const defaults = (ConfigSchema as unknown as (value: Record<string, never>) => Config)({})
    expect(defaults.teamCheckpointThresholdRatio).toBe(0)
    expect(defaults.teamCheckpointMinIntervalMs).toBe(30 * 60 * 1000)
  })

  it('writes one threshold checkpoint on the tick and replaces it in place', async () => {
    const h = thresholdHarness({ ratio: 0.8, usedTokens: 850 })
    const before = JSON.parse(JSON.stringify(h.team()))

    await h.sweep()
    expect(h.remindDueTasks).toHaveBeenCalledOnce()
    expect(h.runDueRoutine).not.toHaveBeenCalled()
    expect(h.createThreshold).toHaveBeenCalledOnce()
    const created = h.createThreshold.mock.calls[0]![0] as {
      teamId: string
      leaderSlotId: string
      epoch: number
      sourceSessionId: string
      facts: { recentMessages: unknown[]; recentTeamMail: unknown[] }
    }
    expect(created).toMatchObject({
      teamId: h.team().id,
      leaderSlotId: h.team().leaderSlotId,
      epoch: epochOf(h.team()),
      sourceSessionId: h.team().members[h.team().leaderSlotId]!.sessionId,
    })
    expect(created.facts.recentMessages).toEqual([
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'Plan the threshold' },
    ])
    expect(created.facts.recentTeamMail).toEqual([])

    // Inside the minimum interval the same Session is not captured again.
    await h.sweep()
    expect(h.createThreshold).toHaveBeenCalledOnce()

    // Nothing about the team moved: no aggregate write, no handoff, no new Agent.
    expect(h.service.updateRuntimeTeam).not.toHaveBeenCalled()
    expect(h.service.consumeTeamCheckpoint).not.toHaveBeenCalled()
    expect(h.service.handoffTeamLeader).not.toHaveBeenCalled()
    expect(h.service.createTeamLeaderCheckpoint).not.toHaveBeenCalled()
    expect(h.ensureMemberOnline).not.toHaveBeenCalled()
    expect(h.agentsCreate).not.toHaveBeenCalled()
    expect(JSON.parse(JSON.stringify(h.team()))).toEqual(before)
  })

  it('stays silent when the ratio is off, the Agent is running, or the team is archived', async () => {
    const off = thresholdHarness({ ratio: 0, usedTokens: 1_000 })
    await off.sweep()
    expect(off.createThreshold).not.toHaveBeenCalled()
    expect(off.remindDueTasks).toHaveBeenCalledOnce()

    const busy = thresholdHarness({ ratio: 0.8, usedTokens: 1_000, agentStatus: 'running' })
    await busy.sweep()
    expect(busy.createThreshold).not.toHaveBeenCalled()

    const archived = thresholdHarness({
      ratio: 0.8,
      usedTokens: 1_000,
      archivedAt: '2026-10-01T00:00:00.000Z',
    })
    await archived.sweep()
    expect(archived.createThreshold).not.toHaveBeenCalled()

    const draft = thresholdHarness({ ratio: 0.8, usedTokens: 1_000, state: 'draft' })
    await draft.sweep()
    expect(draft.createThreshold).not.toHaveBeenCalled()
  })

  it('waits for usage to reach the ratio and for a known context window', async () => {
    const below = thresholdHarness({ ratio: 0.8, usedTokens: 700 })
    await below.sweep()
    expect(below.createThreshold).not.toHaveBeenCalled()

    const noWindow = thresholdHarness({ ratio: 0.8, usedTokens: 1_000, contextWindow: undefined })
    await noWindow.sweep()
    expect(noWindow.createThreshold).not.toHaveBeenCalled()
  })

  it('writes only bounded facts and keeps member mail out of the transcript', async () => {
    const events: SessionEvent[] = [...thresholdEvents(850, 1_000)]
    let seq = 100
    for (let index = 0; index < 20; index += 1) {
      events.push(userEvent(seq++, `long-${index}`, `line ${index} `.repeat(120)))
    }
    const messages = Array.from({ length: 10 }, (_, index) => memberMail({
      id: `mail-${index}`,
      content: `report ${index} `.repeat(80),
      createdAt: `2026-10-24T00:0${index}:00.000Z`,
    }))
    const h = thresholdHarness({ ratio: 0.8, usedTokens: 850, events, messages })

    await h.sweep()

    const record = h.checkpoints[0]!
    expect(record.origin).toBe('threshold')
    expect(record.note).toBe('')
    expect(record.facts.recentMessages).toHaveLength(12)
    expect(record.facts.recentMessages.every(message => message.text.length <= 500)).toBe(true)
    expect(record.facts.recentMessages.some(message => message.text.includes('report'))).toBe(false)
    expect(record.facts.recentTeamMail).toHaveLength(8)
    expect(record.facts.recentTeamMail.every(mail => mail.text.length <= 300)).toBe(true)
  })

  it('replaces the previous threshold record of the same Session instead of appending', async () => {
    const h = thresholdServiceHarness()
    const base = {
      teamId: h.team.id,
      leaderSlotId: h.team.leaderSlotId,
      epoch: epochOf(h.team),
      sourceSessionId: h.team.members[h.team.leaderSlotId]!.sessionId,
      capturedThroughSeq: 1,
      facts: emptyTeamFacts(),
    }

    const first = await h.service.createThresholdTeamCheckpoint({ ...base, at: '2026-10-24T12:00:00.000Z' })
    expect(first).toMatchObject({ origin: 'threshold', note: '', status: 'ready' })
    const second = await h.service.createThresholdTeamCheckpoint({
      ...base,
      capturedThroughSeq: 9,
      at: '2026-10-24T12:30:00.000Z',
    })
    expect(second.id).toBe(first.id)
    expect(second.capturedThroughSeq).toBe(9)
    expect(second.createdAt).toBe('2026-10-24T12:30:00.000Z')
    expect(h.records()).toHaveLength(1)

    // A different Session gets its own record, and a manual checkpoint is never
    // replaced by a threshold capture.
    const other = await h.service.createThresholdTeamCheckpoint({
      ...base,
      sourceSessionId: 'session-next',
      at: '2026-10-24T13:00:00.000Z',
    })
    expect(other.id).not.toBe(first.id)
    const manual = await h.service.createTeamCheckpoint({ ...base, note: 'keep me' })
    expect(manual.origin).toBe('manual')
    await h.service.createThresholdTeamCheckpoint({ ...base, at: '2026-10-24T13:30:00.000Z' })
    expect(h.records()).toHaveLength(3)
    expect(h.service.getTeamCheckpoint(h.team.id, manual.id)).toMatchObject({
      origin: 'manual',
      note: 'keep me',
    })
  })
})

function emptyTeamFacts() {
  return buildTeamCheckpointFacts({
    events: [],
    team: checkpointTeam(),
    messages: [],
    tasks: [],
    goals: [],
    workspacePath: '/tmp/test-team',
    note: '',
  }).facts
}

function thresholdEvents(usedTokens: number, contextWindow: number | undefined): SessionEvent[] {
  return [
    {
      seq: 0,
      time: 1_700_000_000_000,
      type: 'request/context',
      data: contextWindow === undefined ? {} : { contextWindow },
    } as unknown as SessionEvent,
    {
      seq: 1,
      time: 1_700_000_000_001,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          source: { kind: 'model', provider: 'test', model: 'test-model' },
          content: [{ type: 'text', text: 'ok' }],
        },
        usage: { inputTokens: usedTokens, outputTokens: 0 },
        stream: [],
      },
    } as unknown as SessionEvent,
    userEvent(2, 'user-1', 'Plan the threshold'),
  ]
}

function thresholdHarness(options: {
  ratio: number
  usedTokens: number
  contextWindow?: number | undefined
  agentStatus?: 'idle' | 'running'
  state?: TeamAggregate['state']
  archivedAt?: string
  events?: SessionEvent[]
  messages?: TeamMessage[]
}) {
  const base = checkpointTeam()
  const team: TeamAggregate = {
    ...base,
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
  }
  const leader = team.members[team.leaderSlotId]!
  const checkpoints: TeamCheckpoint[] = []
  const contextWindow = 'contextWindow' in options
    ? options.contextWindow
    : 1_000
  const events = options.events ?? thresholdEvents(options.usedTokens, contextWindow)
  const messages = options.messages ?? []
  const createThreshold = vi.fn(async (input: {
    teamId: string
    leaderSlotId: string
    epoch: number
    sourceSessionId: string
    capturedThroughSeq: number
    facts: unknown
    at: string
  }) => {
    const record = {
      schemaVersion: 1,
      id: `checkpoint-${checkpoints.length + 1}`,
      teamId: input.teamId,
      leaderSlotId: input.leaderSlotId,
      epoch: input.epoch,
      sourceSessionId: input.sourceSessionId,
      title: `检查点 ${input.at}`,
      note: '',
      capturedThroughSeq: input.capturedThroughSeq,
      facts: input.facts,
      origin: 'threshold',
      status: 'ready',
      createdAt: input.at,
    } as unknown as TeamCheckpoint
    checkpoints.push(record)
    return record
  })
  const agentsCreate = vi.fn()
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, create: agentsCreate } as never)
  const service = {
    listTeams: () => ({ items: [team], total: 1 }),
    getTeam: () => team,
    listMessages: () => ({ items: messages, total: messages.length }),
    listTeamCheckpoints: () => [...checkpoints],
    createThresholdTeamCheckpoint: createThreshold,
    updateRuntimeTeam: vi.fn(),
    consumeTeamCheckpoint: vi.fn(),
    handoffTeamLeader: vi.fn(),
    createTeamLeaderCheckpoint: vi.fn(),
  } as unknown as AgentTeamService
  const runtime = new TeamRuntime(ctx, {
    teamCheckpointThresholdRatio: options.ratio,
    teamCheckpointMinIntervalMs: 30 * 60 * 1000,
  } as Config, service)
  const internals = runtime as unknown as {
    owned: Map<string, unknown>
    commands: unknown
    ensureMemberOnline: ReturnType<typeof vi.fn>
    sweepTaskReminders: () => Promise<void>
  }
  const agent = {
    id: leader.sessionId,
    status: options.agentStatus ?? 'idle',
    session: { id: leader.sessionId, snapshotEvents: () => events },
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
  internals.owned.set(leader.sessionId, {
    teamId: team.id,
    slotId: leader.id,
    sessionId: leader.sessionId,
    epoch: epochOf(team),
    handle: { agent, dispose: vi.fn(async () => {}) },
    modelSelection: { current: undefined, assembled: undefined },
  })
  const remindDueTasks = vi.fn(async (teamId: string) => ({ teamId, remindedTaskIds: [] }))
  const runDueRoutine = vi.fn(async (teamId: string) => ({ teamId, nudged: false }))
  internals.commands = { remindDueTasks, runDueRoutine }
  const ensureMemberOnline = vi.fn()
  internals.ensureMemberOnline = ensureMemberOnline
  return {
    runtime,
    service,
    team: () => team,
    checkpoints,
    createThreshold,
    agentsCreate,
    remindDueTasks,
    runDueRoutine,
    ensureMemberOnline,
    sweep: () => internals.sweepTaskReminders(),
  }
}

function thresholdServiceHarness() {
  const team = checkpointTeam()
  const records = new Map<string, TeamCheckpoint>()
  const store = {
    getTeam: (id: string) => id === team.id ? team : undefined,
    getTeamCheckpoint: (id: string) => records.get(id),
    listTeamCheckpoints: (teamId: string) => [...records.values()]
      .filter(checkpoint => checkpoint.teamId === teamId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
        || left.id.localeCompare(right.id)),
    putTeamCheckpoint: async (value: TeamCheckpoint) => { records.set(value.id, value) },
    updateTeamCheckpoint: async (
      id: string,
      update: (current: TeamCheckpoint) => TeamCheckpoint,
    ) => {
      const next = update(records.get(id)!)
      records.set(id, next)
      return next
    },
    deleteTeamCheckpoint: async (id: string) => records.delete(id),
  } as unknown as AgentTeamStore
  const service = new AgentTeamService(new Context(), {} as Config, store)
  return { service, team, records: () => [...records.values()] }
}

describe('team thread Sessions', () => {
  function threadTeam() {
    const now = '2026-01-01T00:00:00.000Z'
    const leader = {
      id: 'leader-slot',
      assistantId: 'assistant-1',
      displayName: 'Leader Alice',
      role: 'leader' as const,
      assistantSnapshot: {
        assistantId: 'assistant-1',
        revision: 1,
        name: 'Leader Alice',
        instructions: 'Lead the team.',
        provider: 'openai',
        model: 'gpt-5',
        agentPresetId: 'default',
        permissionPresetId: 'workspace-write',
        skillAllowlist: [],
        mcpServers: [],
        prompts: [],
      },
      permissionPresetId: 'workspace-write',
      sessionId: 'session-old-leader',
      desiredState: 'offline' as const,
      lastRuntimeState: 'offline' as const,
      joinedAt: now,
    }
    let team = {
      schemaVersion: 2,
      id: 'team-threads',
      name: 'Thread Team',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/team-threads',
      leaderSlotId: leader.id,
      state: 'draft',
      epoch: 1,
      directMemberChat: true,
      members: { [leader.id]: leader },
      retiredSessions: {
        'session-older': {
          formerSlotId: 'old-slot',
          sessionId: 'session-older',
          displayName: 'Old Member',
          removedAt: now,
        },
      },
      threads: {
        'thread-active': {
          id: 'thread-active',
          title: 'Shipped design',
          sessionId: 'session-thread',
          speakerSlotId: leader.id,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      retiredThreads: {
        'thread-old': {
          id: 'thread-old',
          title: 'Old conversation',
          sessionId: 'session-retired-thread',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      tasks: {},
      goals: {},
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    } as TeamAggregate
    return {
      team: () => team,
      setTeam: (next: TeamAggregate) => { team = next },
      leader,
    }
  }

  function threadCtx() {
    const workspace = {
      id: 'workspace-1',
      path: '/tmp/team-threads',
      status: async () => 'ok' as const,
      attachSession: vi.fn(async () => {}),
      detachSession: vi.fn(async () => {}),
    }
    const ctx = new Context()
    ctx.provide('agents', {
      get: () => undefined,
      create: vi.fn(),
    } as never)
    ctx.provide('sessions', { flush: vi.fn(async () => {}) } as never)
    ctx.provide('workspaceRegistry', {
      get: (id: string) => id === workspace.id ? workspace : undefined,
      list: () => [workspace],
    } as never)
    const mount = vi.fn(async () => {})
    ctx.provide('agentPresets', { mount } as never)
    const permissionSet = vi.fn()
    ctx.provide('permissionPresets', { set: permissionSet } as never)
    return { ctx, workspace, mount, permissionSet }
  }

  it('creates a real Session in the team Workspace and records the Leader as speaker', async () => {
    const h = threadTeam()
    const fx = threadCtx()
    const dispose = vi.fn(async () => {})
    let created: { sessionId: string; handle: unknown } | undefined
    const create = vi.fn(async (options: {
      sessionId: unknown
      meta: unknown
      agentOptions: unknown
      setup?: (ctx: Context, agent: { session: unknown }) => Promise<void> | void
    }) => {
      const sessionId = String(options.sessionId)
      const agent = { id: sessionId, status: 'idle', session: { id: sessionId } }
      await options.setup?.(new Context(), agent as never)
      created = { sessionId, handle: { agent, dispose } }
      return created.handle
    })
    ;(fx.ctx as unknown as { agents: { create: unknown; get: () => undefined } }).agents
      .create = create
    const createThread = vi.fn(async (
      teamId: string,
      input: { sessionId: string; speakerSlotId?: string },
    ) => {
      const next = {
        ...h.team(),
        revision: h.team().revision + 1,
        threads: {
          ...(h.team().threads ?? {}),
          'thread-new': {
            id: 'thread-new',
            title: '新对话 2',
            sessionId: input.sessionId,
            ...(input.speakerSlotId === undefined ? {} : { speakerSlotId: input.speakerSlotId }),
            createdAt: 2,
            updatedAt: 2,
          },
        },
      } as TeamAggregate
      h.setTeam(next)
      return next
    })
    const service = {
      getTeam: (id: string) => {
        if (id !== h.team().id) throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${id}'`)
        return h.team()
      },
      createThread,
      listTeamSessionIds: () => ['session-old-leader', 'session-thread'],
      retireQueuedMessages: async () => {},
      updateRuntimeTeam: async (
        _teamId: string,
        update: (current: TeamAggregate) => TeamAggregate,
      ) => {
        h.setTeam(update(h.team()))
        return h.team()
      },
    } as unknown as AgentTeamService
    const runtime = new TeamRuntime(fx.ctx, {} as Config, service)

    const next = await runtime.createThread(h.team().id)

    expect(create).toHaveBeenCalledOnce()
    const options = create.mock.calls[0]![0]
    expect(options.meta).toEqual({
      cwd: h.team().workspacePath,
      agentPreset: h.leader.assistantSnapshot.agentPresetId,
    })
    expect(options.agentOptions).toEqual({ provider: 'openai', model: 'gpt-5' })
    // The Session is attached to the team Workspace and flushed before the
    // record exists, so the row names a Host-owned Session.
    expect(fx.workspace.attachSession).toHaveBeenCalledWith(created?.sessionId)
    expect(fx.ctx.sessions.flush).toHaveBeenCalled()
    // It runs as the Leader: same preset, model selection, and permission preset.
    expect(fx.mount).toHaveBeenCalledWith(expect.anything(), 'default')
    expect(fx.permissionSet).toHaveBeenCalledWith(expect.objectContaining({ id: created?.sessionId }), 'workspace-write')
    // Default speaker is the Leader; the Session id is the real one.
    expect(createThread).toHaveBeenCalledWith(h.team().id, {
      sessionId: created?.sessionId,
      speakerSlotId: h.leader.id,
    }, {})
    expect(next.threads?.['thread-new']).toMatchObject({
      sessionId: created?.sessionId,
      speakerSlotId: h.leader.id,
    })
    // No idle Agent is kept resident for a thread nobody opened.
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('detaches the unused Session when the service refuses the thread record', async () => {
    const h = threadTeam()
    const fx = threadCtx()
    const dispose = vi.fn(async () => {})
    let sessionId = ''
    ;(fx.ctx as unknown as { agents: { create: unknown } }).agents.create = vi.fn(async (options: {
      sessionId: unknown
      setup?: (ctx: Context, agent: { session: unknown }) => Promise<void> | void
    }) => {
      sessionId = String(options.sessionId)
      const agent = { id: sessionId, session: { id: sessionId } }
      await options.setup?.(new Context(), agent as never)
      return { agent, dispose }
    })
    const service = {
      getTeam: () => h.team(),
      createThread: vi.fn(async () => {
        throw new AgentTeamError('TEAM_REVISION_CONFLICT', 'stale')
      }),
      listTeamSessionIds: () => [],
    } as unknown as AgentTeamService
    const runtime = new TeamRuntime(fx.ctx, {} as Config, service)

    await expect(runtime.createThread(h.team().id)).rejects.toMatchObject({
      code: 'TEAM_REVISION_CONFLICT',
    })

    expect(dispose).toHaveBeenCalledOnce()
    expect(fx.workspace.detachSession).toHaveBeenCalledWith(sessionId)
  })

  it('keeps active thread Sessions attached on reset and detaches the rest of the scope', async () => {
    const h = threadTeam()
    const fx = threadCtx()
    const service = {
      getTeam: () => h.team(),
      listTeamSessionIds: () => {
        const team = h.team()
        return [
          ...Object.values(team.members).map(member => member.sessionId),
          ...Object.keys(team.retiredSessions),
          ...Object.values(team.threads ?? {}).map(thread => thread.sessionId),
          ...Object.values(team.retiredThreads ?? {}).map(thread => thread.sessionId),
        ]
      },
      retireQueuedMessages: async () => {},
      updateRuntimeTeam: async (
        _teamId: string,
        update: (current: TeamAggregate) => TeamAggregate,
      ) => {
        h.setTeam(update(h.team()))
        return h.team()
      },
    } as unknown as AgentTeamService
    const runtime = new TeamRuntime(fx.ctx, {} as Config, service)

    const reset = await runtime.resetTeam(h.team().id)

    // The active thread keeps its record and its Workspace account.
    expect(reset.threads?.['thread-active']?.sessionId).toBe('session-thread')
    expect(fx.workspace.detachSession).not.toHaveBeenCalledWith('session-thread')
    // Replaced member Sessions, retired Sessions, and retired thread Sessions
    // are all swept via listTeamSessionIds.
    expect(fx.workspace.detachSession).toHaveBeenCalledWith('session-old-leader')
    expect(fx.workspace.detachSession).toHaveBeenCalledWith('session-older')
    expect(fx.workspace.detachSession).toHaveBeenCalledWith('session-retired-thread')
  })

  it('detaches every thread Session when the team dissolves', async () => {
    const h = threadTeam()
    h.setTeam({ ...h.team(), state: 'active' })
    const fx = threadCtx()
    const deleteTeamRecords = vi.fn(async () => {})
    const service = {
      getTeam: () => h.team(),
      listTeamSessionIds: () => {
        const team = h.team()
        return [
          ...Object.values(team.members).map(member => member.sessionId),
          ...Object.values(team.threads ?? {}).map(thread => thread.sessionId),
        ]
      },
      updateRuntimeTeam: async (
        _teamId: string,
        update: (current: TeamAggregate) => TeamAggregate,
      ) => {
        h.setTeam(update(h.team()))
        return h.team()
      },
      deleteTeamRecords,
    } as unknown as AgentTeamService
    const runtime = new TeamRuntime(fx.ctx, {} as Config, service)

    await runtime.dissolveTeam(h.team().id)

    expect(fx.workspace.detachSession).toHaveBeenCalledWith('session-old-leader')
    expect(fx.workspace.detachSession).toHaveBeenCalledWith('session-thread')
    expect(deleteTeamRecords).toHaveBeenCalledWith(h.team().id)
  })
})
