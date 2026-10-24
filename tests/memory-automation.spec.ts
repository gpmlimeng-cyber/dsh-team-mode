import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Config as configSchema, type Config } from '../src/config.js'
import {
  memoryDedupeKey,
  memoryRecallFilterOf,
  recallMemoryEntries,
  redactMemoryText,
} from '../src/domain/memory.js'
import {
  assistantMemorySchema,
  teamMemorySchema,
} from '../src/domain/schemas.js'
import type {
  AssistantInstance,
  AssistantMemory,
  AssistantSession,
  MemoryEntry,
  TeamActivity,
  TeamAggregate,
  TeamGoal,
  TeamMemberSlot,
  TeamTask,
} from '../src/domain/types.js'
import { TeamCommandHandler } from '../src/runtime/team-command-handler.js'
import {
  AgentTeamService,
  appendMemoryJournal,
  MEMORY_CAPTURE_MAX_BODY_CHARS,
  MEMORY_CAPTURE_MAX_TITLE_CHARS,
} from '../src/service/dsh-team-mode-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'

const stamp = '2026-10-23T00:00:00.000Z'

function entry(
  id: string,
  status: MemoryEntry['status'],
  title: string,
  body: string,
  createdAt = stamp,
  key?: string,
): MemoryEntry {
  return {
    id,
    scope: 'assistant',
    visibility: 'private',
    status,
    source: 'assistant',
    ...(key === undefined ? {} : { key }),
    title,
    body,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  }
}

describe('memory recall', () => {
  const entries = [
    entry('mem-1', 'active', 'Tone', 'Be terse.', '2026-10-20T00:00:00.000Z', 'tone'),
    entry('mem-2', 'archived', 'Retired', 'Old tab rule.', '2026-10-21T00:00:00.000Z'),
    entry('mem-3', 'active', 'Style', 'Use tabs in code.', '2026-10-22T00:00:00.000Z'),
  ]

  it('filters by status and case-insensitive query without mutating input', () => {
    const snapshot = JSON.stringify(entries)
    expect(recallMemoryEntries(entries, { query: 'TABS' }).entries.map(value => value.id))
      .toEqual(['mem-3'])
    expect(recallMemoryEntries(entries, { query: 'tab' }).entries.map(value => value.id))
      .toEqual(['mem-2', 'mem-3'])
    expect(recallMemoryEntries(entries, { status: 'active' }).entries.map(value => value.id))
      .toEqual(['mem-1', 'mem-3'])
    // The key is part of the query surface.
    expect(recallMemoryEntries(entries, { query: 'tone' }).entries.map(value => value.id))
      .toEqual(['mem-1'])
    expect(recallMemoryEntries(entries, { status: 'active', query: 'tabs' }).total).toBe(1)
    expect(JSON.stringify(entries)).toBe(snapshot)
  })

  it('bounds by limit and by the shared character budget', () => {
    const limited = recallMemoryEntries(entries, { limit: 1 })
    expect(limited.entries.map(value => value.id)).toEqual(['mem-1'])
    expect(limited).toMatchObject({ total: 3, truncated: true })

    const large = [
      entry('big-1', 'active', 'One', 'x'.repeat(3_000), '2026-10-20T00:00:00.000Z'),
      entry('big-2', 'active', 'Two', 'y'.repeat(3_000), '2026-10-21T00:00:00.000Z'),
      entry('big-3', 'active', 'Three', 'z'.repeat(3_000), '2026-10-22T00:00:00.000Z'),
    ]
    const budgeted = recallMemoryEntries(large)
    expect(budgeted.entries.map(value => value.id)).toEqual(['big-1', 'big-2'])
    expect(budgeted).toMatchObject({ total: 3, truncated: true })
  })

  it('omits an oversized first entry instead of exceeding the budget', () => {
    const result = recallMemoryEntries([
      entry('huge', 'active', 'Huge', 'x'.repeat(9_000), '2026-10-20T00:00:00.000Z'),
    ])
    expect(result.entries).toEqual([])
    expect(result).toMatchObject({ total: 1, truncated: true })
  })

  it('normalizes tool arguments and clamps the limit', () => {
    expect(memoryRecallFilterOf({ query: '  tabs ', status: 'archived', limit: 999 }))
      .toEqual({ query: 'tabs', status: 'archived', limit: 50 })
    expect(memoryRecallFilterOf({ query: '', status: 'bogus', limit: 'many' })).toEqual({})
    expect(memoryRecallFilterOf({ limit: 0 })).toEqual({ limit: 1 })
  })
})

describe('memory redaction and dedupe', () => {
  it('redacts common credential shapes and reports the change', () => {
    const secret = redactMemoryText(
      'key sk-abcdefghijklmnopqrstuvwx and token=supersecretvalue123\nAuthorization: Bearer abcdefghijklmnopqrstuvwx',
    )
    expect(secret.redacted).toBe(true)
    expect(secret.text).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(secret.text).not.toContain('supersecretvalue123')
    expect(secret.text).not.toContain('abcdefghijklmnopqrstuvwx')
    expect(secret.text).toContain('[REDACTED]')

    const key = redactMemoryText(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
    )
    expect(key.redacted).toBe(true)
    expect(key.text).toBe('[REDACTED PRIVATE KEY]')

    const plain = redactMemoryText('Use tabs and keep the parser small.')
    expect(plain).toEqual({ text: 'Use tabs and keep the parser small.', redacted: false })
  })

  it('dedupes by explicit key, otherwise by normalized text', () => {
    expect(memoryDedupeKey({ key: ' style ', title: 'A', body: 'B' })).toBe('key:style')
    expect(memoryDedupeKey({ title: '  Use   Tabs ', body: 'Agreed\n In review.' }))
      .toBe('text:use tabs|agreed in review.')
    expect(memoryDedupeKey({ title: 'Use tabs', body: 'Agreed in review.' }))
      .toBe(memoryDedupeKey({ title: ' use TABS ', body: 'AGREED   in review. ' }))
  })
})

describe('memory journal storage', () => {
  it('keeps legacy containers without a journal unchanged', () => {
    const legacy = assistantMemorySchema.parse({
      schemaVersion: 1,
      assistantId: 'instance-1',
      content: 'Legacy note.',
      revision: 2,
      updatedAt: stamp,
    })
    expect(legacy.journal).toBeUndefined()
    expect(legacy.entries).toBeUndefined()

    const team = teamMemorySchema.parse({
      revision: 1,
      entries: [],
      updatedAt: stamp,
    })
    expect(team.journal).toBeUndefined()
  })

  it('bounds records by count and characters and marks truncated snapshots', () => {
    const change = (index: number) => ({
      scope: 'assistant' as const,
      actor: 'assistant' as const,
      action: 'create' as const,
      entryId: `mem-${index}`,
      reason: `create ${index}`,
      before: null,
      after: { title: `Entry ${index}`, body: 'x'.repeat(20), visibility: 'private' as const, status: 'active' as const },
    })
    let journal = appendMemoryJournal(undefined, change(0), 1, 16_000)
    for (let index = 1; index < 12; index += 1) {
      journal = appendMemoryJournal(journal, change(index), index + 1, 16_000)
    }
    expect(journal).toHaveLength(10)
    expect(journal.at(-1)?.entryId).toBe('mem-11')

    // A record that cannot fit even alone is kept but marked not undoable.
    const oversized = appendMemoryJournal(undefined, {
      ...change(0),
      after: {
        title: 'Huge',
        body: 'x'.repeat(2_000),
        visibility: 'private',
        status: 'active',
      },
    }, 1, 1_000)
    expect(oversized).toHaveLength(1)
    expect(oversized[0]).toMatchObject({ trimmed: true })
  })
})

const baseConfig: Config = {
  maxRequestBytes: 128 * 1024,
  sseHeartbeatMs: 20_000,
  runtimeConcurrency: 4,
  directMemberChatDefault: true,
  assistantBuilderProvider: '',
  assistantBuilderModel: '',
  assistantBuilderAgentPresetId: '',
  assistantBuilderPermissionPresetId: '',
}

interface CaptureHarness {
  service: AgentTeamService
  teams: Map<string, TeamAggregate>
  instances: Map<string, AssistantInstance>
  sessions: Map<string, AssistantSession>
  memories: Map<string, AssistantMemory>
  activities: TeamActivity[]
}

/** Real service over the small slice of AgentTeamStore capture touches. */
function createCaptureHarness(overrides: Partial<Config> = {}): CaptureHarness {
  const ctx = new Context()
  const teams = new Map<string, TeamAggregate>()
  const instances = new Map<string, AssistantInstance>()
  const sessions = new Map<string, AssistantSession>()
  const memories = new Map<string, AssistantMemory>()
  const activities: TeamActivity[] = []
  const update = <T>(map: Map<string, T>, id: string, change: (current: T) => T): T => {
    const current = map.get(id)
    if (current === undefined) throw new Error(`Unknown record '${id}'`)
    const next = change(current)
    map.set(id, next)
    return next
  }
  const store = {
    getTeam: (id: string) => teams.get(id),
    putTeam: async (value: TeamAggregate) => { teams.set(value.id, value) },
    updateTeam: async (id: string, change: (current: TeamAggregate) => TeamAggregate) =>
      update(teams, id, change),
    putActivity: async (value: TeamActivity) => { activities.push(value) },
    getAssistantInstance: (id: string) => instances.get(id),
    getAssistantSession: (id: string) => sessions.get(id),
    getAssistantMemory: (id: string) => memories.get(id),
    putAssistantMemory: async (value: AssistantMemory) => { memories.set(value.assistantId, value) },
    updateAssistantMemory: async (
      id: string,
      change: (current: AssistantMemory) => AssistantMemory,
    ) => update(memories, id, change),
  } as unknown as AgentTeamStore
  return {
    service: new AgentTeamService(ctx, { ...baseConfig, ...overrides }, store),
    teams,
    instances,
    sessions,
    memories,
    activities,
  }
}

function captureGoal(teamId: string): TeamGoal {
  return {
    id: 'goal-1',
    teamId,
    title: 'Ship parser',
    objective: 'Ship the parser',
    acceptance: 'Tests pass',
    mode: 'single',
    status: 'active',
    createdAt: stamp,
    updatedAt: stamp,
  }
}

function captureTask(
  teamId: string,
  index: number,
  overrides: Partial<TeamTask> = {},
): TeamTask {
  return {
    id: `task-${index}`,
    title: `Task ${index}`,
    description: '',
    status: 'completed',
    goalId: 'goal-1',
    dependencyIds: [],
    fileScopes: [],
    result: `Result ${index}`,
    revision: 1,
    createdAt: stamp,
    updatedAt: `2026-10-23T00:00:0${index}.000Z`,
    ...overrides,
  } as TeamTask
}

function seedCaptureTeam(teams: Map<string, TeamAggregate>, options: {
  goal?: Partial<TeamGoal>
  tasks?: TeamTask[]
  memory?: TeamAggregate['memory']
} = {}): TeamAggregate {
  const teamId = 'team-1'
  const tasks = Object.fromEntries((options.tasks ?? [
    captureTask(teamId, 1),
    captureTask(teamId, 2),
    captureTask(teamId, 3),
    captureTask(teamId, 4),
  ]).map(task => [task.id, task]))
  const team: TeamAggregate = {
    schemaVersion: 2,
    id: teamId,
    name: 'Capture team',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/dsh-team-mode-capture',
    leaderSlotId: 'leader',
    state: 'active',
    directMemberChat: true,
    members: {},
    retiredSessions: {},
    tasks,
    goals: { 'goal-1': { ...captureGoal(teamId), ...options.goal } },
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  }
  teams.set(team.id, team)
  return team
}

function seedLeader(team: TeamAggregate): TeamMemberSlot {
  const leader: TeamMemberSlot = {
    id: 'leader',
    assistantId: 'assistant-leader',
    displayName: 'Lead',
    role: 'leader',
    assistantSnapshot: {
      assistantId: 'assistant-leader',
      revision: 1,
      name: 'Lead',
      instructions: '',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    permissionPresetId: 'standard',
    sessionId: 'session-leader',
    desiredState: 'online',
    lastRuntimeState: 'idle',
    joinedAt: stamp,
  }
  team.members = { [leader.id]: leader }
  team.leaderSlotId = leader.id
  return leader
}

function seedCaptureInstance(instances: Map<string, AssistantInstance>): AssistantInstance {
  const instance: AssistantInstance = {
    schemaVersion: 1,
    id: 'instance-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: 'Capture assistant',
      instructions: '',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/dsh-team-mode-capture',
    status: 'active',
    pinned: false,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  }
  instances.set(instance.id, instance)
  return instance
}

function seedCaptureSession(
  sessions: Map<string, AssistantSession>,
  overrides: Partial<AssistantSession> = {},
): AssistantSession {
  const session: AssistantSession = {
    schemaVersion: 1,
    id: 'task-1',
    assistantId: 'instance-1',
    sessionId: 'session-worker',
    role: 'task',
    title: 'Research parser',
    brief: 'Start.',
    parentSessionId: 'session-main',
    status: 'completed',
    resultSummary: 'Parser ships with tests.',
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  }
  sessions.set(session.id, session)
  return session
}

describe('opt-in memory capture', () => {
  it('is off by default at the config and service layers', async () => {
    expect((configSchema({} as never) as Config).memoryAutoCapture).toBe(false)
    const h = createCaptureHarness()
    seedCaptureTeam(h.teams)
    await h.service.updateGoal('team-1', 'goal-1', { status: 'completed' })
    expect(h.teams.get('team-1')!.memory).toBeUndefined()
    expect(await h.service.captureTeamGoalMemory('team-1', 'goal-1')).toBe(false)

    seedCaptureInstance(h.instances)
    seedCaptureSession(h.sessions)
    expect(await h.service.captureAssistantTaskMemory('instance-1', 'task-1')).toBe(false)
    expect(h.memories.size).toBe(0)
  })

  it('captures at most two proposed team entries on explicit goal completion', async () => {
    const h = createCaptureHarness({ memoryAutoCapture: true })
    seedCaptureTeam(h.teams)

    await h.service.updateGoal('team-1', 'goal-1', { status: 'completed' })

    const memory = h.teams.get('team-1')!.memory!
    expect(memory.entries).toHaveLength(2)
    const byKey = Object.fromEntries(memory.entries.map(value => [value.key, value]))
    expect(byKey['goal:goal-1']).toMatchObject({
      scope: 'team',
      visibility: 'team-safe',
      status: 'proposed',
      source: 'auto',
      title: 'Ship parser',
    })
    expect(byKey['goal:goal-1']!.body).toContain('Objective: Ship the parser')
    expect(byKey['goal:goal-1']!.body).toContain('Acceptance: Tests pass')
    expect(byKey['goal-results:goal-1']).toMatchObject({
      status: 'proposed',
      source: 'auto',
      title: 'Results: Ship parser',
    })
    // Only three completed task results enter the bounded body.
    expect(byKey['goal-results:goal-1']!.body).toContain('Result 1')
    expect(byKey['goal-results:goal-1']!.body).toContain('Result 3')
    expect(byKey['goal-results:goal-1']!.body).not.toContain('Result 4')
    expect(memory.entries.every(value => value.status === 'proposed')).toBe(true)
    expect(memory.journal).toHaveLength(2)
    expect(memory.journal!.every(record => record.actor === 'auto' && record.action === 'create'))
      .toBe(true)

    // A second capture run is a no-op: keys are already present.
    expect(await h.service.captureTeamGoalMemory('team-1', 'goal-1')).toBe(false)
    expect(h.teams.get('team-1')!.memory!.entries).toHaveLength(2)
  })

  it('redacts and bounds captured goal content and skips an existing key', async () => {
    const h = createCaptureHarness({ memoryAutoCapture: true })
    seedCaptureTeam(h.teams, {
      goal: {
        title: 'T'.repeat(500),
        objective: 'O'.repeat(5_000),
        acceptance: 'token=supersecretvalue123',
        status: 'active',
      },
      tasks: [
        captureTask('team-1', 1, { result: 'password=hunter2 but shipped' }),
      ],
    })
    h.teams.get('team-1')!.memory = {
      revision: 1,
      entries: [{
        id: 'existing-goal',
        scope: 'team',
        visibility: 'team-safe',
        status: 'archived',
        source: 'leader',
        key: 'goal:goal-1',
        title: 'Ship parser',
        body: 'Existing.',
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
      }],
      updatedAt: stamp,
    }
    await h.service.updateGoal('team-1', 'goal-1', { status: 'completed' })
    const memory = h.teams.get('team-1')!.memory!
    // The pre-existing goal key was deduped; only the results entry is new.
    expect(memory.entries).toHaveLength(2)
    const captured = memory.entries.find(value => value.key === 'goal-results:goal-1')!
    expect(captured.title.length).toBeLessThanOrEqual(MEMORY_CAPTURE_MAX_TITLE_CHARS)
    expect(captured.body.length).toBeLessThanOrEqual(MEMORY_CAPTURE_MAX_BODY_CHARS)
    expect(captured.body).not.toContain('hunter2')
    expect(captured.body).toContain('[REDACTED]')
  })

  it('swallows a stale-epoch capture without writing memory', async () => {
    const h = createCaptureHarness({ memoryAutoCapture: true })
    seedCaptureTeam(h.teams, { goal: { status: 'completed' } })
    expect(await h.service.captureTeamGoalMemory('team-1', 'goal-1', 2)).toBe(false)
    expect(h.teams.get('team-1')!.memory).toBeUndefined()
  })

  it('captures one private proposed assistant entry from a completed worker task', async () => {
    const h = createCaptureHarness({ memoryAutoCapture: true })
    seedCaptureInstance(h.instances)
    seedCaptureSession(h.sessions)

    expect(await h.service.captureAssistantTaskMemory('instance-1', 'task-1')).toBe(true)
    const memory = h.memories.get('instance-1')!
    expect(memory.content).toBe('')
    expect(memory.entries).toHaveLength(1)
    expect(memory.entries![0]).toMatchObject({
      scope: 'assistant',
      visibility: 'private',
      status: 'proposed',
      source: 'auto',
      key: 'task:task-1',
      title: 'Research parser',
    })
    expect(memory.entries![0]!.body).toContain('Parser ships with tests.')
    expect(memory.journal).toHaveLength(1)
    expect(memory.journal![0]).toMatchObject({ actor: 'auto', action: 'create', before: null })

    // Deduped per task; only a completed task is captured; never active.
    expect(await h.service.captureAssistantTaskMemory('instance-1', 'task-1')).toBe(false)
    expect(h.memories.get('instance-1')!.entries).toHaveLength(1)
    seedCaptureSession(h.sessions, { id: 'task-2', status: 'running' })
    expect(await h.service.captureAssistantTaskMemory('instance-1', 'task-2')).toBe(false)
    expect(h.memories.get('instance-1')!.entries!.every(value => value.status === 'proposed'))
      .toBe(true)
  })

  it('redacts and bounds the assistant task capture', async () => {
    const h = createCaptureHarness({ memoryAutoCapture: true })
    seedCaptureInstance(h.instances)
    seedCaptureSession(h.sessions, {
      title: 'Q'.repeat(500),
      resultSummary: `api_key=supersecretvalue123 ${'z'.repeat(5_000)}`,
    })
    expect(await h.service.captureAssistantTaskMemory('instance-1', 'task-1')).toBe(true)
    const entry = h.memories.get('instance-1')!.entries![0]!
    expect(entry.title.length).toBeLessThanOrEqual(MEMORY_CAPTURE_MAX_TITLE_CHARS)
    expect(entry.body.length).toBeLessThanOrEqual(MEMORY_CAPTURE_MAX_BODY_CHARS)
    expect(entry.body).not.toContain('supersecretvalue123')
    expect(entry.body).toContain('[REDACTED]')
    expect(entry.status).toBe('proposed')
  })

  it('undoes both entries captured for one goal revision', async () => {
    const h = createCaptureHarness({ memoryAutoCapture: true })
    seedCaptureTeam(h.teams)
    await h.service.updateGoal('team-1', 'goal-1', { status: 'completed' })

    let memory = h.teams.get('team-1')!.memory!
    const byKey = Object.fromEntries(memory.entries.map(value => [value.key, value]))
    const goalEntryId = byKey['goal:goal-1']!.id
    const resultsEntryId = byKey['goal-results:goal-1']!.id
    const goalJournal = memory.journal!.find(record =>
      record.entryId === goalEntryId && record.action === 'create')!
    const resultsJournal = memory.journal!.find(record =>
      record.entryId === resultsEntryId && record.action === 'create')!
    expect(goalJournal.revision).toBe(resultsJournal.revision)

    const first = await h.service.undoUserTeamMemory('team-1', goalJournal.id, {
      expectedMemoryRevision: 1,
    })
    expect(first.entry).toMatchObject({ id: goalEntryId, status: 'archived' })
    memory = h.teams.get('team-1')!.memory!
    // The sibling delta of the same revision is re-stamped so it stays undoable.
    expect(memory.journal!.find(record =>
      record.entryId === resultsEntryId && record.action === 'create')?.revision).toBe(2)

    const second = await h.service.undoUserTeamMemory('team-1', resultsJournal.id, {
      expectedMemoryRevision: 2,
    })
    expect(second.entry).toMatchObject({ id: resultsEntryId, status: 'archived' })
    expect(h.teams.get('team-1')!.memory!.entries.every(value => value.status === 'archived'))
      .toBe(true)
  })

  it('undoes a keyed Leader write end-to-end through the command handler', async () => {
    const h = createCaptureHarness()
    const team = seedCaptureTeam(h.teams)
    seedLeader(team)
    const commands = new TeamCommandHandler(h.service, {} as never)

    const proposed = await commands.proposeMemory('team-1', 'leader', {
      title: 'Use tabs',
      body: 'Agreed in review.',
      key: 'style',
      expected_revision: 0,
    })
    const journal = h.teams.get('team-1')!.memory!.journal!
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({
      actor: 'leader',
      action: 'create',
      entryId: proposed.entry.entry_id,
      revision: 1,
    })

    const undone = await h.service.undoUserTeamMemory('team-1', journal[0]!.id, {
      expectedMemoryRevision: proposed.revision,
    })
    expect(undone.entry).toMatchObject({
      id: proposed.entry.entry_id,
      status: 'archived',
      key: 'style',
    })
  })

  it('leaves team revision and activity untouched when capture is fully deduped', async () => {
    const h = createCaptureHarness({ memoryAutoCapture: true })
    seedCaptureTeam(h.teams)
    await h.service.updateGoal('team-1', 'goal-1', { status: 'completed' })

    const revision = h.teams.get('team-1')!.revision
    const activityCount = h.activities.length
    const entries = h.teams.get('team-1')!.memory!.entries.length
    expect(entries).toBe(2)

    expect(await h.service.captureTeamGoalMemory('team-1', 'goal-1')).toBe(false)
    expect(h.teams.get('team-1')!.revision).toBe(revision)
    expect(h.activities).toHaveLength(activityCount)
    expect(h.teams.get('team-1')!.memory!.entries).toHaveLength(entries)
  })
})
