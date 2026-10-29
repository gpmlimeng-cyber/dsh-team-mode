import { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import type { TeamAggregate } from '../src/domain/types.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import { dshTeamModeDomainSpec } from '../src/storage/domain.js'
import { DomainAgentTeamStore } from '../src/storage/store.js'

/**
 * B4 exit, one scenario end to end: create a team and a thread → the thread
 * reads as the Leader's → reassign it to a member → stop → resume → archive →
 * restore, with the revision and the Session id asserted at every step.
 *
 * Everything under test is production code: the real `AgentTeamService` over the
 * real `DomainAgentTeamStore`. Only the Host seams a node process cannot own are
 * stubbed (workspace registry, model/preset catalogs and the Domain persistence
 * backend), exactly like `assistant-lifecycle-e2e.spec.ts`.
 *
 * The second test pins the read-only side: a record written before ownership
 * existed must read as the Leader's **without** a backfill write.
 */

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

const BASE_WORKSPACE_ID = 'workspace-base'

class FakeTable {
  readonly values = new Map<string, unknown>()
  /** Every put/update, so a test can prove a read path never wrote. */
  writes = 0

  get(key: string): unknown {
    return this.values.get(key)
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.values.entries()
  }

  async put(key: string, value: unknown): Promise<void> {
    this.writes += 1
    this.values.set(key, value)
  }

  async update(key: string, update: (value: unknown) => unknown): Promise<unknown> {
    this.writes += 1
    const next = update(this.values.get(key))
    this.values.set(key, next)
    return next
  }
}

interface World {
  service: AgentTeamService
  store: DomainAgentTeamStore
  root: string
  /** Total puts/updates across every table. */
  writes: () => number
  /** The persisted team record, exactly as the store holds it. */
  rawTeam: (id: string) => TeamAggregate | undefined
}

function createWorld(): World {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b4-thread-owner-'))
  const basePath = join(root, 'base')
  mkdirSync(basePath, { recursive: true })

  const tables = new Map<string, FakeTable>()
  const domain = {
    name: 'dsh_team_mode',
    table(name: string) {
      let table = tables.get(name)
      if (table === undefined) {
        table = new FakeTable()
        tables.set(name, table)
      }
      return table
    },
  } as unknown as Domain<typeof dshTeamModeDomainSpec>

  const workspace = {
    id: BASE_WORKSPACE_ID,
    path: basePath,
    title: 'Base',
    status: async () => 'ok' as const,
  }
  const ctx = new Context()
  ctx.provide('workspaceRegistry', {
    get: (id: string) => (id === BASE_WORKSPACE_ID ? workspace : undefined),
    list: () => [workspace],
    create: async () => workspace,
  } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
    listModels: async () => [{ id: 'gpt-5', name: 'GPT-5' }],
    resolveModelInfo: async (provider: string, model: string) => {
      if (provider !== 'openai' || model !== 'gpt-5') throw new Error(`Unknown model '${provider}/${model}'`)
      return { provider, model, reasoning: { efforts: [], defaultEffort: 'high' } }
    },
  } as never)
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'default', name: 'Default' }],
    resolve: async (id: string) => ({ id, name: id }),
    acquireScope: async () => ({ key: { kind: 'preset-scope' }, [Symbol.asyncDispose]: async () => {} }),
  } as never)
  ctx.provide('permissionPresets', {
    names: ['standard'],
    optionOf: (name: string) => ({ value: name, name }),
  } as never)
  ctx.provide('tools', { get: () => ({}), schemas: () => [] } as never)
  ctx.provide('skills', { list: async () => [] } as never)

  const store = new DomainAgentTeamStore(domain)
  return {
    service: new AgentTeamService(ctx, config, store),
    store,
    root,
    writes: () => [...tables.values()].reduce((total, table) => total + table.writes, 0),
    rawTeam: (id: string) => tables.get('teams')?.get(id) as TeamAggregate | undefined,
  }
}

const worlds: World[] = []

afterAll(() => {
  for (const world of worlds) rmSync(world.root, { recursive: true, force: true })
})

function world(): World {
  const created = createWorld()
  worlds.push(created)
  return created
}

async function assistant(service: AgentTeamService, name: string): Promise<string> {
  const created = await service.createAssistant({
    name,
    instructions: `${name} works on the team's threads.`,
    provider: 'openai',
    model: 'gpt-5',
    agentPresetId: 'default',
    permissionPresetId: 'standard',
    skillAllowlist: [],
    mcpServers: [],
  })
  return created.id
}

async function teamWithTwoMembers(service: AgentTeamService): Promise<TeamAggregate> {
  const leader = await assistant(service, 'Thread Lead')
  const member = await assistant(service, 'Thread Engineer')
  return service.createTeamDraft({
    name: 'Thread owner team',
    workspaceId: BASE_WORKSPACE_ID,
    members: [
      { assistantId: leader, role: 'leader' },
      { assistantId: member, role: 'member' },
    ],
  })
}

describe('B4 team thread owner end to end', () => {
  it('runs create → default owner → reassign → stop → resume → archive → restore', async () => {
    const { service } = world()
    const trace: string[] = []
    const step = (line: string): void => { trace.push(line) }

    // 1. One team, one Leader, one member. The thread owner must always be one
    //    of these member slots — never a Session id, never an Assistant id.
    const team = await teamWithTwoMembers(service)
    const memberSlotId = Object.values(team.members).find(slot => slot.role === 'member')?.id
    expect(memberSlotId).toBeDefined()
    step(`team: ${team.id} revision=${team.revision} leader=${team.leaderSlotId} member=${memberSlotId}`)

    // 2. A fresh thread carries no explicit owner, and reads as the Leader's:
    //    the default is resolved on read so creating a thread stays one write.
    const created = await service.createThread(team.id)
    const threadId = Object.keys(created.threads ?? {})[0] as string
    const thread = created.threads?.[threadId]
    expect(thread).toBeDefined()
    expect(thread?.ownerSlotId).toBeUndefined()
    expect(service.threadOwnerSlotId(team.id, threadId)).toBe(team.leaderSlotId)
    step(`thread: ${threadId} session=${thread?.sessionId} owner=Leader(${team.leaderSlotId}) revision=${created.revision}`)

    // 3. Reassign: the owner becomes the member, the revision moves, and the
    //    Session is untouched — ownership is a member slot, not a conversation.
    const assigned = await service.assignThread(team.id, threadId, memberSlotId as string)
    expect(assigned.threads?.[threadId]?.ownerSlotId).toBe(memberSlotId)
    expect(assigned.threads?.[threadId]?.sessionId).toBe(thread?.sessionId)
    expect(assigned.revision).toBe(created.revision + 1)
    expect(service.threadOwnerSlotId(team.id, threadId)).toBe(memberSlotId)
    step(`assign: owner=${memberSlotId} revision=${assigned.revision} session unchanged`)

    // 4. Stop writes only `pausedAt`: the Session id survives, every member
    //    Session survives, and the thread stays in the reclaim scope.
    const stopped = await service.stopThread(team.id, threadId)
    expect(stopped.threads?.[threadId]?.pausedAt).toEqual(expect.any(Number))
    expect(stopped.threads?.[threadId]?.sessionId).toBe(thread?.sessionId)
    expect(stopped.members).toEqual(assigned.members)
    expect(service.listTeamSessionIds(team.id)).toContain(thread?.sessionId)
    expect(stopped.revision).toBe(assigned.revision + 1)
    step(`stop: pausedAt=${stopped.threads?.[threadId]?.pausedAt} revision=${stopped.revision} session kept`)

    // 5. Resume clears the marker; same Session, one more revision.
    const resumed = await service.resumeThread(team.id, threadId)
    expect(resumed.threads?.[threadId]?.pausedAt).toBeUndefined()
    expect(resumed.threads?.[threadId]?.sessionId).toBe(thread?.sessionId)
    expect(resumed.revision).toBe(stopped.revision + 1)
    step(`resume: pausedAt cleared revision=${resumed.revision} session kept`)

    // 6. Archive moves the record to `retiredThreads`; it is never deleted, so
    //    the Session stays known for the team's reclaim sweep.
    const archived = await service.archiveThread(team.id, threadId)
    expect(archived.threads?.[threadId]).toBeUndefined()
    expect(archived.retiredThreads?.[threadId]?.sessionId).toBe(thread?.sessionId)
    expect(archived.retiredThreads?.[threadId]?.ownerSlotId).toBe(memberSlotId)
    expect(archived.revision).toBe(resumed.revision + 1)
    step(`archive: retired revision=${archived.revision} session kept`)

    // 7. Restore is the exact inverse: same record, same Session, same
    //    `createdAt`, owner intact; the revision only moves on the team.
    const restored = await service.restoreThread(team.id, threadId)
    expect(restored.threads?.[threadId]).toEqual(archived.retiredThreads?.[threadId])
    expect(restored.threads?.[threadId]?.createdAt).toBe(thread?.createdAt)
    expect(restored.threads?.[threadId]?.ownerSlotId).toBe(memberSlotId)
    expect(restored.retiredThreads?.[threadId]).toBeUndefined()
    expect(restored.revision).toBe(archived.revision + 1)
    step(`restore: active revision=${restored.revision} createdAt=${restored.threads?.[threadId]?.createdAt} kept`)

    // The persisted team is the source of truth the UI reloads after the event.
    const persisted = service.getTeam(team.id)
    expect(persisted.threads?.[threadId]?.ownerSlotId).toBe(memberSlotId)
    expect(persisted.threads?.[threadId]?.pausedAt).toBeUndefined()

    expect(trace).toHaveLength(7)
    for (const line of trace) console.info(`[b4-e2e] ${line}`)
  })

  it('reads a pre-ownership thread as the Leader without backfilling the store', async () => {
    const { service, rawTeam, writes } = world()

    const team = await teamWithTwoMembers(service)
    const memberSlotId = Object.values(team.members).find(slot => slot.role === 'member')?.id as string
    const created = await service.createThread(team.id)
    const threadId = Object.keys(created.threads ?? {})[0] as string
    await service.assignThread(team.id, threadId, memberSlotId)

    // Backdate the persisted record to what an older build wrote: ownership
    // simply does not exist on the thread. This is a fixture edit, not a call.
    const raw = rawTeam(team.id)
    const stored = raw?.threads?.[threadId]
    expect(stored).toBeDefined()
    delete stored?.ownerSlotId
    const revision = raw?.revision
    const writesBefore = writes()

    // Reading resolves the missing owner to the Leader...
    expect(service.threadOwnerSlotId(team.id, threadId)).toBe(team.leaderSlotId)
    expect(service.threadOwnerSlotId(team.id, threadId)).toBe(team.leaderSlotId)

    // ...and a load is not a write: no store call, no revision bump, no field
    // backfilled onto the stored thread.
    expect(writes()).toBe(writesBefore)
    const after = rawTeam(team.id)
    expect(after?.revision).toBe(revision)
    expect(Object.hasOwn(after?.threads?.[threadId] ?? {}, 'ownerSlotId')).toBe(false)
    expect(after?.threads?.[threadId]?.sessionId).toBe(created.threads?.[threadId]?.sessionId)
    console.info(
      `[b4-e2e] legacy owner fallback: Leader(${team.leaderSlotId}) revision=${after?.revision} `
      + `writes=${writes() - writesBefore}`,
    )
  })
})
