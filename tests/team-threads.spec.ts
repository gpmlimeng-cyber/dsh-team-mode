import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import { teamAggregateSchema } from '../src/domain/schemas.js'
import type { TeamActivity, TeamAggregate, TeamMemberSlot } from '../src/domain/types.js'
import type { TeamView } from '../src/transport/contracts.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'

const NOW = '2026-10-27T00:00:00.000Z'

const config: Config = {
  maxRequestBytes: 128 * 1024,
  sseHeartbeatMs: 20_000,
  runtimeConcurrency: 4,
  directMemberChatDefault: true,
  assistantBuilderProvider: '',
  assistantBuilderModel: '',
  assistantBuilderAgentPresetId: '',
  assistantBuilderPermissionPresetId: '',
}

function member(id: string, sessionId: string): TeamMemberSlot {
  return {
    id,
    assistantId: `assistant-${id}`,
    displayName: id,
    role: id === 'leader' ? 'leader' : 'member',
    assistantSnapshot: {
      assistantId: `assistant-${id}`,
      revision: 1,
      name: id,
      instructions: '',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    permissionPresetId: 'read-only',
    sessionId,
    desiredState: 'online',
    lastRuntimeState: 'idle',
    joinedAt: NOW,
  }
}

/** A stored team exactly as an older record looks: no `threads` field at all. */
function teamRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'team-1',
    name: 'Threads team',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/dsh-team-threads-workspace',
    leaderSlotId: 'leader',
    state: 'active',
    directMemberChat: true,
    members: {
      leader: member('leader', 'session-leader'),
      engineer: member('engineer', 'session-engineer'),
    },
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** The real service over the one store slice these methods touch. */
function createHarness(seed: Record<string, unknown> = teamRecord()): {
  service: AgentTeamService
  team: () => TeamAggregate
  activities: TeamActivity[]
} {
  const ctx = new Context()
  const teams = new Map<string, TeamAggregate>([[String(seed.id), teamAggregateSchema.parse(seed)]])
  const activities: TeamActivity[] = []
  const store = {
    getTeam: (id: string) => teams.get(id),
    listTeams: () => [...teams.values()],
    updateTeam: async (id: string, update: (current: TeamAggregate) => TeamAggregate) => {
      const current = teams.get(id)
      if (current === undefined) throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${id}'`)
      const next = update(current)
      teams.set(id, next)
      return next
    },
    putActivity: async (activity: TeamActivity) => { activities.push(activity) },
  } as unknown as AgentTeamStore
  const service = new AgentTeamService(ctx, config, store)
  return {
    service,
    team: () => teamAggregateSchema.parse(teams.get('team-1')),
    activities,
  }
}

describe('teamAggregateSchema threads', () => {
  it('loads a record written before threads existed and keeps the same schema version', () => {
    const legacy = teamAggregateSchema.parse(teamRecord())
    expect(legacy.threads).toBeUndefined()
    expect(legacy.retiredThreads).toBeUndefined()
    expect(legacy.schemaVersion).toBe(2)
    expect(teamAggregateSchema.parse(teamRecord({ schemaVersion: 1 })).threads).toBeUndefined()
  })

  it('accepts a thread record with the documented fields only', () => {
    const parsed = teamAggregateSchema.parse(teamRecord({
      threads: {
        'thread-1': {
          id: 'thread-1',
          title: '新对话 1',
          sessionId: 'session-thread-1',
          createdAt: 1,
          updatedAt: 2,
        },
      },
    }))
    expect(parsed.threads?.['thread-1']?.speakerSlotId).toBeUndefined()
    expect(parsed.threads?.['thread-1']?.ownerSlotId).toBeUndefined()
    expect(parsed.threads?.['thread-1']?.pausedAt).toBeUndefined()
    expect(() => teamAggregateSchema.parse(teamRecord({
      threads: { 'thread-1': { id: 'thread-1', title: 't', sessionId: 's', createdAt: 1, updatedAt: 2, extra: 1 } },
    }))).toThrow()
  })

  it('accepts an owner and a pause marker without a schema-version bump', () => {
    const parsed = teamAggregateSchema.parse(teamRecord({
      threads: {
        'thread-1': {
          id: 'thread-1',
          title: '设计讨论',
          sessionId: 'session-thread-1',
          ownerSlotId: 'engineer',
          pausedAt: 1_700_000_000_000,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    }))
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.threads?.['thread-1']?.ownerSlotId).toBe('engineer')
    expect(parsed.threads?.['thread-1']?.pausedAt).toBe(1_700_000_000_000)
  })
})

describe('team threads', () => {
  it('creates a thread with a real Session id and leaves every member Session alone', async () => {
    const { service, team, activities } = createHarness()
    const before = team()

    const view: TeamView = await service.createThread('team-1')

    expect(view.revision).toBe(before.revision + 1)
    const threads = Object.values(view.threads ?? {})
    expect(threads).toHaveLength(1)
    const [thread] = threads
    expect(thread?.title).toBe('新对话 1')
    expect(thread?.sessionId).toMatch(/^session-[0-9a-f-]{36}$/)
    expect(thread?.speakerSlotId).toBeUndefined()
    expect(thread?.createdAt).toBe(thread?.updatedAt)
    // Member Sessions are a different layer: byte-identical after the thread write.
    expect(view.members).toEqual(before.members)
    expect(view.members.leader?.sessionId).toBe('session-leader')
    expect(view.members.engineer?.sessionId).toBe('session-engineer')
    expect(activities.at(-1)?.kind).toBe('team.thread_created')
  })

  it('numbers default titles and keeps minted Session ids unique', async () => {
    const { service } = createHarness()
    await service.createThread('team-1')
    const view = await service.createThread('team-1')
    const threads = Object.values(view.threads ?? {})
    expect(threads.map(thread => thread.title)).toEqual(['新对话 1', '新对话 2'])
    expect(new Set(threads.map(thread => thread.sessionId)).size).toBe(2)
  })

  it('refuses a Session id that already belongs to the team', async () => {
    const { service } = createHarness()
    await expect(service.createThread('team-1', { sessionId: 'session-engineer' }))
      .rejects.toThrow(/already belongs to this team/)
  })

  it('renames only the title and the thread updatedAt', async () => {
    const { service, team } = createHarness()
    const created = await service.createThread('team-1')
    const threadId = Object.keys(created.threads ?? {})[0] as string
    const createdThread = created.threads?.[threadId]
    const before = team()

    const view = await service.renameThread('team-1', threadId, '  设计讨论  ')
    const renamed = view.threads?.[threadId]

    expect(renamed?.title).toBe('设计讨论')
    expect(renamed?.sessionId).toBe(createdThread?.sessionId)
    expect(renamed?.createdAt).toBe(createdThread?.createdAt)
    // Millisecond clock: a rename right after creation may land in the same tick.
    expect(renamed?.updatedAt).toBeGreaterThanOrEqual(createdThread?.updatedAt ?? 0)
    expect(view.revision).toBe(before.revision + 1)
    expect(view.members).toEqual(before.members)
    expect(view.retiredSessions).toEqual(before.retiredSessions)
    expect(view.outbox).toEqual(before.outbox)
  })

  it('refuses a blank title and an unknown thread', async () => {
    const { service } = createHarness()
    const created = await service.createThread('team-1')
    const threadId = Object.keys(created.threads ?? {})[0] as string

    await expect(service.renameThread('team-1', threadId, '   ')).rejects.toThrow(/cannot be empty/)
    await expect(service.renameThread('team-1', 'thread-missing', 'x'))
      .rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' })
    await expect(service.archiveThread('team-1', 'thread-missing'))
      .rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' })
  })

  it('archives a thread into the retired list instead of deleting it', async () => {
    const { service, team } = createHarness()
    const created = await service.createThread('team-1')
    const threadId = Object.keys(created.threads ?? {})[0] as string
    const createdThread = created.threads?.[threadId]

    const view = await service.archiveThread('team-1', threadId)

    expect(view.threads?.[threadId]).toBeUndefined()
    expect(view.retiredThreads?.[threadId]).toEqual(createdThread)
    expect(view.revision).toBe(created.revision + 1)
    expect(view.members).toEqual(team().members)
    // The archived Session stays inside the team's reclaim scope.
    expect(service.listTeamSessionIds('team-1')).toContain(createdThread?.sessionId)
  })

  it('sweeps both layers when the team goes away, and threads never leak into members', async () => {
    const { service, team } = createHarness()
    const created = await service.createThread('team-1')
    const active = Object.keys(created.threads ?? {})[0] as string
    const archived = (await service.createThread('team-1', { title: '第二条' })).threads
    const archivedId = Object.keys(archived ?? {}).find(id => id !== active) as string
    await service.archiveThread('team-1', archivedId)

    const current = team()
    const threadSessions = [
      current.threads?.[active]?.sessionId,
      current.retiredThreads?.[archivedId]?.sessionId,
    ]
    expect(service.listTeamSessionIds('team-1')).toEqual(expect.arrayContaining([
      'session-leader',
      'session-engineer',
      ...threadSessions,
    ]))
    expect(service.listTeamSessionIds('team-1')).toHaveLength(4)
  })

  it('keeps thread Sessions out of the member layer in both directions', async () => {
    const { service, team } = createHarness()
    const created = await service.createThread('team-1')
    const threadId = Object.keys(created.threads ?? {})[0] as string
    const threadSessionId = created.threads?.[threadId]?.sessionId

    // A member Session replacement (what a context reset does) must not touch threads.
    const reset = await service.updateRuntimeTeam(
      'team-1',
      current => {
        const engineer = current.members.engineer
        if (engineer === undefined) throw new Error('fixture lost its engineer member')
        return {
          ...current,
          members: {
            ...current.members,
            engineer: { ...engineer, sessionId: 'session-engineer-2' },
          },
        }
      },
      'team.context_reset',
      'member session rotated',
    )
    expect(reset.threads?.[threadId]?.sessionId).toBe(threadSessionId)
    expect(reset.threads?.[threadId]?.title).toBe(created.threads?.[threadId]?.title)
    expect(team().members.engineer?.sessionId).toBe('session-engineer-2')

    // And a second thread never adopts the rotated member Session.
    const withSecond = await service.createThread('team-1')
    const secondThread = Object.values(withSecond.threads ?? {}).find(thread => thread.id !== threadId)
    expect(secondThread?.sessionId).not.toBe('session-engineer-2')
    expect(withSecond.members.engineer?.sessionId).toBe('session-engineer-2')
  })

  it('assigns one owner from the team members and bumps the revision', async () => {
    const { service } = createHarness()
    const created = await service.createThread('team-1')
    const threadId = Object.keys(created.threads ?? {})[0] as string
    const thread = created.threads?.[threadId]

    const view = await service.assignThread('team-1', threadId, ' engineer ')

    expect(view.threads?.[threadId]?.ownerSlotId).toBe('engineer')
    expect(view.threads?.[threadId]?.sessionId).toBe(thread?.sessionId)
    expect(view.revision).toBe(created.revision + 1)
    expect(view.members).toEqual(created.members)
    expect(service.threadOwnerSlotId('team-1', threadId)).toBe('engineer')
  })

  it('refuses an owner who is not a team member', async () => {
    const { service, team } = createHarness()
    const created = await service.createThread('team-1')
    const threadId = Object.keys(created.threads ?? {})[0] as string

    await expect(service.assignThread('team-1', threadId, 'ghost'))
      .rejects.toMatchObject({ code: 'THREAD_OWNER_UNKNOWN' })
    // Refused means refused: no owner was stored and the revision did not move.
    expect(team().threads?.[threadId]?.ownerSlotId).toBeUndefined()
    expect(team().revision).toBe(created.revision)
  })

  it('reads a pre-ownership thread as the Leader without backfilling the store', async () => {
    const legacyThread = { id: 'thread-old', title: '旧对话', sessionId: 'session-old', createdAt: 1, updatedAt: 2 }
    const { service, team } = createHarness(teamRecord({ threads: { 'thread-old': legacyThread } }))
    const before = team()

    expect(service.threadOwnerSlotId('team-1', 'thread-old')).toBe('leader')

    // A load is not a write: the stored thread keeps its shape and its revision.
    const after = team()
    expect(after.revision).toBe(before.revision)
    expect(after.threads?.['thread-old']).toEqual(legacyThread)
  })

  it('pauses a thread by writing pausedAt only', async () => {
    const { service } = createHarness()
    const created = await service.createThread('team-1')
    const threadId = Object.keys(created.threads ?? {})[0] as string
    const thread = created.threads?.[threadId]

    const stopped = await service.stopThread('team-1', threadId)

    expect(stopped.threads?.[threadId]?.pausedAt).toEqual(expect.any(Number))
    expect(stopped.threads?.[threadId]?.sessionId).toBe(thread?.sessionId)
    expect(stopped.threads?.[threadId]?.title).toBe(thread?.title)
    expect(stopped.revision).toBe(created.revision + 1)
    expect(stopped.members).toEqual(created.members)
  })

  it('resumes a stopped thread by clearing pausedAt', async () => {
    const { service } = createHarness()
    const created = await service.createThread('team-1')
    const threadId = Object.keys(created.threads ?? {})[0] as string
    const stopped = await service.stopThread('team-1', threadId)

    const resumed = await service.resumeThread('team-1', threadId)

    expect(resumed.threads?.[threadId]?.pausedAt).toBeUndefined()
    expect(resumed.threads?.[threadId]?.sessionId).toBe(created.threads?.[threadId]?.sessionId)
    expect(resumed.revision).toBe(stopped.revision + 1)
  })

  it('restores an archived thread onto the active list with its createdAt intact', async () => {
    const { service } = createHarness()
    const created = await service.createThread('team-1')
    const threadId = Object.keys(created.threads ?? {})[0] as string
    const archived = await service.archiveThread('team-1', threadId)
    const retired = archived.retiredThreads?.[threadId]

    const restored = await service.restoreThread('team-1', threadId)

    expect(restored.threads?.[threadId]).toEqual(retired)
    expect(restored.threads?.[threadId]?.createdAt).toBe(retired?.createdAt)
    expect(restored.threads?.[threadId]?.sessionId).toBe(created.threads?.[threadId]?.sessionId)
    expect(restored.retiredThreads?.[threadId]).toBeUndefined()
    expect(restored.revision).toBe(archived.revision + 1)
    await expect(service.restoreThread('team-1', 'thread-missing'))
      .rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' })
  })
})
