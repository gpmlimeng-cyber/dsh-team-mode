import { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memberAssistantArchivedNote } from '../src/client/labels.js'
import type { Config } from '../src/config.js'
import { AgentTeamService, assistantWorkspacePath } from '../src/service/dsh-team-mode-service.js'
import { dshTeamModeDomainSpec } from '../src/storage/domain.js'
import { DomainAgentTeamStore } from '../src/storage/store.js'

/**
 * M1 exit, one scenario end to end: create an Assistant → join a team →
 * archive (refused by the team link) → forced archive → the team side shows it
 * archived → restore → open a new Session.
 *
 * Everything under test is production code: the real `AgentTeamService` over the
 * real `DomainAgentTeamStore`, with Assistant workspaces materialised on a real
 * temporary directory. Only the Host seams a node process cannot own are stubbed
 * (workspace registry, model/preset catalogs and the Domain persistence backend),
 * the same way every other service spec does it.
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

  get(key: string): unknown {
    return this.values.get(key)
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.values.entries()
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }

  async update(key: string, update: (value: unknown) => unknown): Promise<unknown> {
    const next = update(this.values.get(key))
    this.values.set(key, next)
    return next
  }
}

function fakeDomain(): Domain<typeof dshTeamModeDomainSpec> {
  const tables = new Map<string, FakeTable>()
  return {
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
}

interface World {
  service: AgentTeamService
  store: DomainAgentTeamStore
  root: string
  basePath: string
  /** Every Directory the test created, so `afterAll` can remove exactly those. */
  roots: string[]
}

function createWorld(): World {
  const root = mkdtempSync(join(tmpdir(), 'dsh-m1-e2e-'))
  const basePath = join(root, 'base')
  mkdirSync(basePath, { recursive: true })

  const workspaces = new Map<string, {
    id: string
    path: string
    title: string
    status: () => Promise<'ok'>
  }>([[
    BASE_WORKSPACE_ID,
    { id: BASE_WORKSPACE_ID, path: basePath, title: 'Base', status: async () => 'ok' as const },
  ]])
  // The registry reuses a registration for an already-registered canonical path,
  // exactly like the host: allocating an isolated workspace twice cannot fork it.
  const byPath = new Map([...workspaces.values()].map(workspace => [workspace.path, workspace]))
  let isolatedSequence = 0

  const ctx = new Context()
  ctx.provide('workspaceRegistry', {
    get: (id: string) => workspaces.get(id),
    list: () => [...workspaces.values()],
    create: async (path: string, title?: string) => {
      const existing = byPath.get(path)
      if (existing !== undefined) return existing
      isolatedSequence += 1
      const workspace = {
        id: `workspace-isolated-${isolatedSequence}`,
        path,
        title: title ?? 'Isolated workspace',
        status: async () => 'ok' as const,
      }
      workspaces.set(workspace.id, workspace)
      byPath.set(path, workspace)
      return workspace
    },
  } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
    listModels: async () => [{ id: 'gpt-5', name: 'GPT-5' }],
    resolveModelInfo: async (provider: string, model: string) => {
      if (provider !== 'openai' || model !== 'gpt-5') throw new Error(`Unknown model '${provider}/${model}'`)
      return {
        provider,
        model,
        reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
      }
    },
  } as never)
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'default', name: 'Default' }],
    resolve: async (id: string) => ({ id, name: id }),
    acquireScope: async () => ({
      key: { kind: 'preset-scope' },
      [Symbol.asyncDispose]: async () => {},
    }),
  } as never)
  ctx.provide('permissionPresets', {
    names: ['standard'],
    optionOf: (name: string) => ({ value: name, name }),
  } as never)
  ctx.provide('tools', { get: () => ({}), schemas: () => [] } as never)
  ctx.provide('skills', { list: async () => [] } as never)

  const store = new DomainAgentTeamStore(fakeDomain())
  return {
    service: new AgentTeamService(ctx, config, store),
    store,
    root,
    basePath,
    roots: [root],
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

describe('M1 assistant lifecycle end to end', () => {
  it('runs create → team → refused archive → forced archive → team badge → restore → new Session', async () => {
    const { service, store, basePath } = world()
    const trace: string[] = []
    const step = (line: string): void => { trace.push(line) }

    // 1. Two 同事, both isolated: their workspaces must be different directories
    //    under the base checkout, each materialised for real.
    const first = await service.createAssistantInstance({
      workspaceId: BASE_WORKSPACE_ID,
      name: 'Researcher',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
      workspaceIsolated: true,
    })
    const second = await service.createAssistantInstance({
      workspaceId: BASE_WORKSPACE_ID,
      name: 'Reviewer',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
      workspaceIsolated: true,
    })
    const inTeam = await service.createAssistantInstance({
      workspaceId: BASE_WORKSPACE_ID,
      name: 'Teammate',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    step(`create: ${first.assistantSnapshot.name} → ${first.workspacePath}`)
    step(`create: ${second.assistantSnapshot.name} → ${second.workspacePath}`)
    step(`create: ${inTeam.assistantSnapshot.name} → ${inTeam.workspacePath} (shared)`)

    expect(first.workspaceIsolated).toBe(true)
    expect(first.workspacePath).toBe(assistantWorkspacePath(basePath, 'Researcher', first.id))
    expect(first.workspacePath).not.toBe(second.workspacePath)
    expect(existsSync(first.workspacePath)).toBe(true)
    expect(existsSync(second.workspacePath)).toBe(true)
    // The private roots never pollute the base checkout's git status.
    expect(readFileSync(join(basePath, '.dsh-team-mode', '.gitignore'), 'utf8')).toBe('*\n')

    // 2. Joining a team: an isolated Assistant is refused with a reason that names
    //    the structural rule (turn the switch off when creating), not a generic
    //    workspace mismatch. The teammate Assistant shares the base workspace and
    //    links successfully through the API-only entry.
    const assistant = await service.createAssistant({
      name: 'Codex Lead',
      instructions: 'Coordinate the team.',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
      skillAllowlist: [],
      mcpServers: [],
    })
    const team = await service.createTeamDraft({
      name: 'Lifecycle team',
      workspaceId: BASE_WORKSPACE_ID,
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const slotId = team.leaderSlotId
    await expect(service.setMemberAssistantInstance(team.id, slotId, first.id)).rejects.toMatchObject({
      code: 'ASSISTANT_INSTANCE_WORKSPACE_MISMATCH',
      message: expect.stringContaining('独立工作区'),
    })
    const linked = await service.setMemberAssistantInstance(team.id, slotId, inTeam.id)
    step(`join team: ${linked.name} ← ${inTeam.assistantSnapshot.name} (slot ${slotId}, revision ${linked.revision})`)
    expect(linked.members[slotId]?.assistantInstanceId).toBe(inTeam.id)

    // 3. Archive is refused while a live team links it: the reason names the team
    //    and no team-side marker is written yet.
    await expect(service.archiveAssistantInstance(inTeam.id)).rejects.toMatchObject({
      code: 'ASSISTANT_INSTANCE_TEAM_LINKED',
      message: expect.stringContaining('Lifecycle team'),
    })
    expect(store.getAssistantInstance(inTeam.id)?.status).not.toBe('archived')
    expect(service.getTeam(team.id).members[slotId]?.assistantInstanceArchivedAt).toBeUndefined()
    step('archive refused: ASSISTANT_INSTANCE_TEAM_LINKED (names the team)')

    // 4. Forced archive: the Assistant is archived and the team-side link is kept
    //    but marked invalidated, so the team UI can show 已归档 (same helper the
    //    member rows render) instead of silently reading an empty memory.
    const archived = await service.archiveAssistantInstance(inTeam.id, { force: true })
    expect(archived.status).toBe('archived')
    const archivedMember = service.getTeam(team.id).members[slotId]
    expect(archivedMember?.assistantInstanceId).toBe(inTeam.id)
    expect(archivedMember?.assistantInstanceArchivedAt).toEqual(expect.any(String))
    expect(memberAssistantArchivedNote(archivedMember!)).toBe('已归档')
    expect(service.readMemberAssistantMemory(team.id, slotId)).toEqual({ state: 'archived', entries: [] })
    step(`force archive: status=${archived.status}, team badge="${memberAssistantArchivedNote(archivedMember!)}", memory=archived`)

    // 5. An archived Assistant cannot be opened: both the main-Session bind and a
    //    new visible thread are refused, so reopening cannot revive it.
    await expect(service.bindAssistantMainSession(inTeam.id, 'session-main-after-archive'))
      .rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    await expect(service.attachAssistantThread(inTeam.id, 'session-thread-after-archive'))
      .rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(store.getAssistantInstance(inTeam.id)?.mainSessionId).toBeUndefined()
    step('open while archived: refused (main bind + thread create)')

    // 6. Restore: availability comes back, the team-side badge goes away and the
    //    link is live again.
    const restored = await service.restoreAssistantInstance(inTeam.id)
    expect(restored.status).not.toBe('archived')
    const revivedMember = service.getTeam(team.id).members[slotId]
    expect(revivedMember?.assistantInstanceId).toBe(inTeam.id)
    expect(revivedMember?.assistantInstanceArchivedAt).toBeUndefined()
    expect(memberAssistantArchivedNote(revivedMember!)).toBeUndefined()
    expect(service.readMemberAssistantMemory(team.id, slotId).state).toBe('linked')
    step(`restore: status=${restored.status}, team badge cleared, memory linked`)

    // 7. A new Session opens: this is exactly the bind the runtime performs when
    //    the user opens the Assistant, plus one visible thread.
    const reopened = await service.bindAssistantMainSession(inTeam.id, 'session-main-after-restore')
    expect(reopened.status).toBe('active')
    expect(reopened.mainSessionId).toBe('session-main-after-restore')
    const threaded = await service.attachAssistantThread(inTeam.id, 'session-thread-after-restore')
    expect(threaded.threadSessionIds).toContain('session-thread-after-restore')
    step(`reopen: main=${reopened.mainSessionId}, thread=${threaded.threadSessionIds?.join(',')}`)

    // 8. Workspace boundary: archiving an Assistant never deletes its directory,
    //    and an unlinked isolated Assistant archives without a forced flag.
    const marker = join(first.workspacePath, 'notes.md')
    writeFileSync(marker, 'keep me\n')
    const archivedFirst = await service.archiveAssistantInstance(first.id)
    expect(archivedFirst.status).toBe('archived')
    expect(existsSync(first.workspacePath)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('keep me\n')
    expect(existsSync(second.workspacePath)).toBe(true)
    step(`archive isolated: directory kept (${first.workspacePath}, notes.md intact)`)

    // The whole scenario above is the trace a person can read; asserting it is
    // complete keeps a future edit from silently skipping a stage.
    expect(trace).toHaveLength(10)
    for (const line of trace) console.info(`[m1-e2e] ${line}`)
  })
})
