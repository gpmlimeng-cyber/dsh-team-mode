import { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import {
  GROUP_SHARE_KIND,
  GROUP_SHARE_MAX_DOCUMENT_BYTES,
  portableDocumentBytes,
  uniqueName,
  type GroupExportDocument,
  type PortableAssistantProfile,
} from '../src/domain/group-share.js'
import { AgentTeamError } from '../src/domain/errors.js'
import { assistantInstanceSchema, teamAggregateSchema } from '../src/domain/schemas.js'
import type { AssistantInstance } from '../src/domain/types.js'
import { registerAssistantMemoryTools, registerAssistantTaskTools } from '../src/runtime/assistant-tools.js'
import { TEAM_TOOL_NAMES } from '../src/runtime/team-tools.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import { dshTeamModeDomainSpec } from '../src/storage/domain.js'
import { DomainAgentTeamStore } from '../src/storage/store.js'

const NOW = '2026-10-26T00:00:00.000Z'
const WORKSPACE_ID = 'workspace-1'
const WORKSPACE_PATH = '/tmp/dsh-group-share-workspace'

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

const workspace = {
  id: WORKSPACE_ID,
  path: WORKSPACE_PATH,
  title: 'Workspace',
  status: async () => 'ok' as const,
}

class FakeTable {
  readonly values = new Map<string, unknown>()

  get(key: string): unknown {
    return this.values.get(key)
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.values.entries()
  }

  keys(): IterableIterator<string> {
    return this.values.keys()
  }

  get size(): number {
    return this.values.size
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
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

/**
 * One service over the real domain store plus the Host seams an import touches:
 * workspace registry, model catalog, presets, skills and MCP tools.
 */
function createHarness(): { service: AgentTeamService; store: DomainAgentTeamStore } {
  const ctx = new Context()
  ctx.provide('workspaceRegistry', {
    get: (id: string) => id === WORKSPACE_ID ? workspace : undefined,
    list: () => [workspace],
  } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
    listModels: async () => [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 mini' },
    ],
    resolveModelInfo: async (provider: string, model: string) => {
      const efforts = provider === 'openai' && model === 'gpt-5'
        ? ['low', 'medium', 'high']
        : provider === 'openai' && model === 'gpt-5-mini'
          ? ['low', 'high']
          : undefined
      if (efforts === undefined) throw new Error(`Unknown model '${provider}/${model}'`)
      return {
        provider,
        model,
        reasoning: { efforts: efforts.map(id => ({ id, name: id })), defaultEffort: efforts[0] },
      }
    },
  } as never)
  ctx.provide('permissionPresets', {
    names: ['standard', 'workspace-write', 'read-only'],
    optionOf: (name: string) => ({ value: name, name }),
  } as never)
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'default', name: 'Default' }],
    resolve: async (id: string) => {
      if (id !== 'default') throw new Error(`Unknown agent preset '${id}'`)
      return { id, name: 'Default' }
    },
    acquireScope: async () => ({
      key: { kind: 'preset-scope' },
      [Symbol.asyncDispose]: async () => {},
    }),
  } as never)
  ctx.provide('tools', {
    get: () => ({}),
    schemas: () => [{ name: 'mcp__github__list_issues', description: 'List issues.' }],
  } as never)
  ctx.provide('skills', {
    list: async () => [{
      name: 'review',
      description: 'Review a diff',
      source: 'user',
      invocation: { modelInvocable: true, userInvocable: true },
    }],
  } as never)
  const store = new DomainAgentTeamStore(fakeDomain())
  return { service: new AgentTeamService(ctx, config, store), store }
}

/** A valid portable profile: everything an import has to carry. */
function profile(overrides: Partial<PortableAssistantProfile> = {}): PortableAssistantProfile {
  return {
    name: 'Reviewer',
    instructions: 'Review every diff before it lands.',
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'high',
    agentPresetId: 'default',
    permissionPresetId: 'read-only',
    skillAllowlist: ['review'],
    mcpServers: ['github'],
    ...overrides,
  }
}

function documentWith(overrides: Partial<GroupExportDocument> = {}): GroupExportDocument {
  return {
    kind: GROUP_SHARE_KIND,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    group: { name: '工作', brief: 'Cite every source.' },
    assistants: [{ profile: profile() }],
    teams: [],
    ...overrides,
  }
}

/** A hand-written team document: one leader, one member, two local templates. */
function teamDocument(): GroupExportDocument {
  return documentWith({
    assistants: [],
    teams: [{
      name: '研究组',
      directMemberChat: false,
      members: [
        {
          displayName: '组长',
          role: 'leader',
          profile: profile({ name: 'Writer', model: 'gpt-5', reasoningEffort: 'high' }),
          permissionPresetId: 'workspace-write',
        },
        {
          displayName: '研究员',
          role: 'member',
          profile: profile({ name: 'Builder', model: 'gpt-5-mini', reasoningEffort: 'low' }),
        },
      ],
    }],
  })
}

async function createInstance(service: AgentTeamService): Promise<AssistantInstance> {
  const instance = await service.createAssistantInstance({
    workspaceId: WORKSPACE_ID,
    name: 'Researcher',
    instructions: 'You research.',
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'high',
    agentPresetId: 'default',
    permissionPresetId: 'read-only',
    skillAllowlist: ['review'],
    mcpServers: ['github'],
    mascot: { seed: 'abc' },
  })
  return service.updateAssistantInstance(instance.id, { group: '工作', memoryAutoCapture: true })
}

/** Bytes of every store table, for "nothing was written" assertions. */
function storeSnapshot(store: DomainAgentTeamStore): string {
  return JSON.stringify({
    groups: store.getSidebarGroups(),
    assistants: store.listAssistants(),
    instances: store.listAssistantInstances(),
    teams: store.listTeams(),
  })
}

function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, found)
    return found
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key)
      keysDeep(child, found)
    }
  }
  return found
}

describe('Group export', () => {
  it('suffixes a colliding name deterministically and keeps truncating under the cap', () => {
    expect(uniqueName('工作', [])).toBe('工作')
    expect(uniqueName(' 工作 ', ['工作'])).toBe('工作 (2)')
    expect(uniqueName('工作', ['工作', '工作 (2)'])).toBe('工作 (3)')
    const long = 'g'.repeat(80)
    const suffixed = uniqueName(long, [long])
    expect(suffixed).toHaveLength(80)
    expect(suffixed.endsWith(' (2)')).toBe(true)
  })

  it('exports the group, its Assistant instances and its teams without any binding data', async () => {
    const { service } = await createHarness()
    await service.createGroup('工作')
    await service.setGroupBrief('工作', 'Cite every source.')
    const instance = await createInstance(service)
    const template = await service.createAssistant({
      name: 'Writer',
      instructions: 'You write.',
      provider: 'openai',
      model: 'gpt-5-mini',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: [],
      mcpServers: [],
    })
    const team = await service.createTeamDraft({
      name: '研究组',
      workspaceId: WORKSPACE_ID,
      directMemberChat: false,
      members: [{ assistantId: template.id, role: 'leader' }],
    })
    const leader = Object.values(team.members)[0]
    await service.renameMember(team.id, leader?.id ?? '', '组长')
    await service.setTeamGroup(team.id, '工作')

    // An archived instance and an archived team stay out of the export.
    const archived = await service.createAssistantInstance({
      workspaceId: WORKSPACE_ID,
      name: 'Retired',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      skillAllowlist: [],
      mcpServers: [],
    })
    await service.archiveAssistantInstance(archived.id)

    const document = service.exportGroup('工作')
    expect(document).toMatchObject({
      kind: GROUP_SHARE_KIND,
      schemaVersion: 1,
      group: { name: '工作', brief: 'Cite every source.' },
      assistants: [{
        profile: {
          name: 'Researcher',
          instructions: 'You research.',
          provider: 'openai',
          model: 'gpt-5',
          reasoningEffort: 'high',
          agentPresetId: 'default',
          permissionPresetId: 'read-only',
          skillAllowlist: ['review'],
          mcpServers: ['github'],
        },
        mascot: { seed: 'abc' },
        memoryAutoCapture: true,
      }],
    })
    expect(document.teams).toHaveLength(1)
    expect(document.teams[0]?.members).toMatchObject([
      {
        displayName: '组长',
        role: 'leader',
        permissionPresetId: 'workspace-write',
        profile: { name: 'Writer', model: 'gpt-5-mini' },
      },
    ])
    expect(document.teams[0]?.directMemberChat).toBe(false)

    // Nothing that binds the document to this machine or this Account travels.
    const keys = keysDeep(document)
    for (const forbidden of [
      'memoryKey',
      'avatar',
      'assistantId',
      'assistantInstanceId',
      'revision',
      'sessionId',
      'mainSessionId',
      'threadSessionIds',
      'retiredMainSessionIds',
      'workspaceId',
      'workspacePath',
      'coordinator',
      'toolPolicy',
      'joinedAt',
      'desiredState',
      'lastRuntimeState',
      'prompts',
      'outbox',
      'tasks',
      'memory',
      'journal',
      'pinned',
      'id',
    ]) {
      expect(keys.has(forbidden), `exported key '${forbidden}'`).toBe(false)
    }
    const json = JSON.stringify(document)
    expect(json).not.toContain(WORKSPACE_PATH)
    expect(json).not.toContain(instance.mainSessionId ?? 'session-never-minted')
    expect(json).not.toContain('data:image')
    expect(json).not.toContain('memoryKey')
  })

  it('refuses an unknown group and an over-long persona with a concrete reason', async () => {
    const { service } = await createHarness()
    // Export is synchronous: the group lookup fails before any document exists.
    expect(() => service.exportGroup('无此分组')).toThrow(/Unknown group/)

    await service.createGroup('工作')
    const instance = await service.createAssistantInstance({
      workspaceId: WORKSPACE_ID,
      name: 'Long',
      instructions: 'x'.repeat(64 * 1024 + 1),
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      skillAllowlist: [],
      mcpServers: [],
    })
    await service.updateAssistantInstance(instance.id, { group: '工作' })

    let error: unknown
    try {
      service.exportGroup('工作')
    } catch (value) {
      error = value
    }
    expect(error).toBeInstanceOf(AgentTeamError)
    expect((error as AgentTeamError).message).toContain('assistants.0.profile.instructions')
    expect((error as AgentTeamError).code).toBe('INVALID_REQUEST')
  })
})

describe('Group import', () => {
  it('previews created, skipped and suffixed rows without writing anything', async () => {
    const { service, store } = await createHarness()
    await service.createGroup('工作')
    const before = storeSnapshot(store)

    const preview = await service.previewGroupImport(documentWith(), WORKSPACE_ID)
    expect(preview.group).toMatchObject({ requested: '工作', plannedName: '工作 (2)', renamed: true })
    expect(preview.assistants).toMatchObject([
      { name: 'Reviewer', plannedName: 'Reviewer', action: 'create' },
    ])
    expect(preview.counts).toMatchObject({ assistants: 1, teams: 0, skipped: 0 })
    expect(preview.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(storeSnapshot(store)).toBe(before)
  })

  it('applies one item at a time, reports each row and never touches existing data', async () => {
    const { service, store } = await createHarness()
    await service.createGroup('工作')
    await service.setGroupBrief('工作', 'Existing brief.')
    const existing = await createInstance(service)
    const before = storeSnapshot(store)

    const document = teamDocument()
    const preview = await service.previewGroupImport(document, WORKSPACE_ID)
    const result = await service.importGroup(document, WORKSPACE_ID, preview.planHash)

    expect(result.groupName).toBe('工作 (2)')
    expect(result.rows).toMatchObject([
      { kind: 'group', name: '工作', plannedName: '工作 (2)', status: 'created' },
      { kind: 'template', name: 'Writer', plannedName: 'Writer', status: 'created' },
      { kind: 'template', name: 'Builder', plannedName: 'Builder', status: 'created' },
      { kind: 'team', name: '研究组', plannedName: '研究组', status: 'created' },
    ])
    expect(result.counts).toMatchObject({ created: 4, skipped: 0, rejected: 0 })

    // The group carries the brief; the teams are drafts in the new group.
    expect(service.listGroupBriefs()).toContainEqual(expect.objectContaining({
      name: '工作 (2)',
      brief: 'Cite every source.',
    }))
    const created = store.listTeams().find(team => team.name === '研究组')
    expect(created).toBeDefined()
    expect(teamAggregateSchema.parse(created)).toMatchObject({
      state: 'draft',
      group: '工作 (2)',
      directMemberChat: false,
    })
    const members = Object.values(created?.members ?? {})
    const leader = members.find(member => member.role === 'leader')
    expect(leader).toMatchObject({
      displayName: '组长',
      permissionPresetId: 'workspace-write',
      reasoningEffort: 'high',
      assistantSnapshot: { name: 'Writer', model: 'gpt-5' },
    })
    expect(members.find(member => member.role === 'member')).toMatchObject({
      displayName: '研究员',
      permissionPresetId: 'read-only',
      reasoningEffort: 'low',
    })
    // Slots get a fresh session id; no exported id can come back.
    expect(leader?.sessionId).toMatch(/^session-/)
    expect(leader?.sessionId).not.toBe('')

    // The pre-existing group, instance and brief are byte-identical.
    const after = storeSnapshot(store)
    const existingBefore = JSON.parse(before) as {
      groups: { groups: Array<{ name: string, brief: string, memoryKey: string }> }
      instances: AssistantInstance[]
    }
    const existingAfter = JSON.parse(after) as typeof existingBefore
    expect(existingAfter.instances.find(item => item.id === existing.id))
      .toEqual(existingBefore.instances.find(item => item.id === existing.id))
    expect(existingAfter.groups.groups.find(group => group.name === '工作'))
      .toEqual(existingBefore.groups.groups.find(group => group.name === '工作'))
    expect(service.listGroups()).toEqual(['工作', '工作 (2)'])
  })

  it('imports Assistant instances with their model, effort, permissions, skills and MCP', async () => {
    const { service, store } = await createHarness()
    const document = documentWith()
    const preview = await service.previewGroupImport(document, WORKSPACE_ID)
    const result = await service.importGroup(document, WORKSPACE_ID, preview.planHash)

    expect(result.rows).toMatchObject([
      { kind: 'group', status: 'created' },
      { kind: 'assistant', name: 'Reviewer', status: 'created' },
    ])
    const imported = store.listAssistantInstances().find(
      item => item.assistantSnapshot.name === 'Reviewer',
    )
    expect(assistantInstanceSchema.parse(imported)).toMatchObject({
      group: '工作',
      assistantSnapshot: {
        name: 'Reviewer',
        instructions: 'Review every diff before it lands.',
        provider: 'openai',
        model: 'gpt-5',
        reasoningEffort: 'high',
        agentPresetId: 'default',
        permissionPresetId: 'read-only',
        skillAllowlist: ['review'],
        mcpServers: ['github'],
      },
    })
    // No ids, sessions or avatar bytes are invented by an import.
    expect(imported?.mainSessionId).toBeUndefined()
    expect(imported?.assistantSnapshot.avatar).toBeUndefined()
    expect(imported?.workspacePath).toBe(WORKSPACE_PATH)
  })

  it('reuses an exact local Assistant template instead of doubling the library', async () => {
    const { service, store } = await createHarness()
    const document = documentWith()
    const first = await service.previewGroupImport(document, WORKSPACE_ID)
    expect(first.templates).toHaveLength(0)
    await service.importGroup(document, WORKSPACE_ID, first.planHash)
    const instancesAfterFirst = store.listAssistantInstances().length

    const second = await service.previewGroupImport(document, WORKSPACE_ID)
    expect(second.group.plannedName).toBe('工作 (2)')
    // The first import already owns the name, so the second one is suffixed.
    expect(second.assistants[0]?.plannedName).toBe('Reviewer (2)')
    await service.importGroup(document, WORKSPACE_ID, second.planHash)

    // Both imports created an instance; the second one owns «工作 (2)», and the
    // first group is untouched.
    expect(store.listAssistantInstances()).toHaveLength(instancesAfterFirst + 1)
    expect(service.listGroups()).toEqual(['工作', '工作 (2)'])
    expect(service.listGroupBriefs()).toContainEqual(expect.objectContaining({
      name: '工作 (2)',
      brief: 'Cite every source.',
    }))
  })

  it('refuses a stale preview and a malformed or oversized document without writing', async () => {
    const { service, store } = await createHarness()
    const document = documentWith()
    const before = storeSnapshot(store)

    await expect(service.importGroup(document, WORKSPACE_ID, 'not-the-plan'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(service.previewGroupImport({ kind: 'other' }, WORKSPACE_ID))
      .rejects.toThrow(/kind/)
    await expect(service.previewGroupImport(
      { ...document, group: { name: '工作', brief: 'x'.repeat(24_577) } },
      WORKSPACE_ID,
    )).rejects.toThrow(/brief/)
    const oversized = 'x'.repeat(GROUP_SHARE_MAX_DOCUMENT_BYTES + 1)
    await expect(service.previewGroupImport(oversized, WORKSPACE_ID))
      .rejects.toThrow(/portable limit/)
    await expect(service.previewGroupImport(document, 'workspace-missing'))
      .rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
    expect(storeSnapshot(store)).toBe(before)
    expect(service.listGroups()).toEqual([])
  })

  it('skips a row this machine cannot resolve and still lands the later rows', async () => {
    const { service, store } = await createHarness()
    const document = documentWith({
      assistants: [
        { profile: profile({ name: 'Ghost', model: 'not-a-model' }) },
        { profile: profile({ name: 'Reviewer' }) },
      ],
    })

    const preview = await service.previewGroupImport(document, WORKSPACE_ID)
    expect(preview.assistants).toMatchObject([
      { name: 'Ghost', action: 'skip', reason: "unknown model 'openai/not-a-model'" },
      { name: 'Reviewer', action: 'create' },
    ])
    expect(preview.counts.skipped).toBe(1)
    expect(preview.warnings.join('\n')).toContain("Assistant 'Ghost' skipped")

    const result = await service.importGroup(document, WORKSPACE_ID, preview.planHash)
    expect(result.rows).toMatchObject([
      { kind: 'group', status: 'created' },
      { kind: 'assistant', name: 'Ghost', status: 'skipped' },
      { kind: 'assistant', name: 'Reviewer', status: 'created' },
    ])
    expect(store.listAssistantInstances().map(item => item.assistantSnapshot.name))
      .toEqual(['Reviewer'])
  })

  it('drops references this machine cannot resolve and reports them in the preview', async () => {
    const { service, store } = await createHarness()
    const document = documentWith({
      assistants: [{
        profile: profile({
          skillAllowlist: ['review', 'ghost-skill'],
          mcpServers: ['github', 'ghost-mcp'],
        }),
      }],
    })

    const preview = await service.previewGroupImport(document, WORKSPACE_ID)
    expect(preview.skills).toEqual([
      { name: 'ghost-skill', available: false },
      { name: 'review', available: true },
    ])
    expect(preview.mcpServers).toEqual([
      { name: 'ghost-mcp', available: false },
      { name: 'github', available: true },
    ])
    expect(preview.assistants[0]?.dropped).toEqual({
      skills: ['ghost-skill'],
      mcpServers: ['ghost-mcp'],
    })
    expect(preview.warnings.join('\n')).toContain('dropped unavailable')

    await service.importGroup(document, WORKSPACE_ID, preview.planHash)
    expect(store.listAssistantInstances()[0]?.assistantSnapshot).toMatchObject({
      skillAllowlist: ['review'],
      mcpServers: ['github'],
    })
  })

  it('reports a team member\'s unavailable skill, MCP and effort instead of discarding them', async () => {
    const { service, store } = await createHarness()
    const document = teamDocument()
    const team = document.teams[0]!
    const [leader, member] = team.members
    // Team-only document: no `assistants` rows to carry the availability map.
    const withGhosts: GroupExportDocument = {
      ...document,
      assistants: [],
      teams: [{
        ...team,
        members: [
          {
            ...leader!,
            profile: profile({
              name: 'Writer',
              model: 'gpt-5-mini',
              reasoningEffort: 'medium',
              skillAllowlist: ['review', 'ghost-skill'],
              mcpServers: ['github', 'ghost-mcp'],
            }),
          },
          member!,
        ],
      }],
    }

    const preview = await service.previewGroupImport(withGhosts, WORKSPACE_ID)
    expect(preview.skills).toEqual([
      { name: 'ghost-skill', available: false },
      { name: 'review', available: true },
    ])
    expect(preview.mcpServers).toEqual([
      { name: 'ghost-mcp', available: false },
      { name: 'github', available: true },
    ])
    expect(preview.teams[0]?.members[0]).toMatchObject({
      displayName: '组长',
      permissionPresetId: 'workspace-write',
      dropped: {
        skills: ['ghost-skill'],
        mcpServers: ['ghost-mcp'],
        reasoningEffort: 'medium',
      },
    })
    // The member that asked for nothing unavailable reports nothing.
    expect(preview.teams[0]?.members[1]?.dropped).toBeUndefined()
    const warnings = preview.warnings.join('\n')
    expect(warnings).toContain(
      "Team '研究组' member '组长': dropped unavailable skill(s) ghost-skill; "
      + "MCP server(s) ghost-mcp; reasoning effort 'medium'",
    )

    // Apply reports the same drops and lands only what this machine resolves.
    const result = await service.importGroup(withGhosts, WORKSPACE_ID, preview.planHash)
    expect(result.warnings).toEqual(preview.warnings)
    const template = store.listAssistants().find(assistant => assistant.name === 'Writer')
    expect(template).toMatchObject({ skillAllowlist: ['review'], mcpServers: ['github'] })
    expect(template?.reasoningEffort).toBeUndefined()
    const created = store.listTeams()[0]
    const createdLeader = Object.values(created?.members ?? {}).find(slot => slot.role === 'leader')
    expect(createdLeader?.reasoningEffort).toBeUndefined()
    expect(createdLeader?.assistantSnapshot).toMatchObject({
      skillAllowlist: ['review'],
      mcpServers: ['github'],
    })
  })

  it('skips a team with two leaders instead of materializing half a roster', async () => {
    const { service, store } = await createHarness()
    const document = teamDocument()
    const members = document.teams[0]?.members ?? []
    const broken: GroupExportDocument = {
      ...document,
      teams: [{ ...document.teams[0]!, members: members.map(member => ({ ...member, role: 'leader' as const })) }],
    }

    const preview = await service.previewGroupImport(broken, WORKSPACE_ID)
    expect(preview.teams).toMatchObject([{
      name: '研究组',
      action: 'skip',
      reason: 'it declares 2 leaders; exactly one is required',
    }])
    const result = await service.importGroup(broken, WORKSPACE_ID, preview.planHash)
    expect(result.rows.map(row => row.status)).toEqual(['created', 'skipped'])
    // The group is still created (the export said so), but no team is.
    expect(store.listTeams()).toEqual([])
    expect(service.listGroups()).toEqual(['工作'])
  })

  it('turns a repeated import into a fresh suffixed group, never an overwrite', async () => {
    const { service, store } = await createHarness()
    const document = teamDocument()

    const first = await service.previewGroupImport(document, WORKSPACE_ID)
    const firstResult = await service.importGroup(document, WORKSPACE_ID, first.planHash)
    expect(firstResult.rows.find(row => row.kind === 'template'))
      .toMatchObject({ name: 'Writer', status: 'created' })

    const second = await service.previewGroupImport(document, WORKSPACE_ID)
    expect(second.group.plannedName).toBe('工作 (2)')
    expect(second.teams[0]?.plannedName).toBe('研究组 (2)')
    // The two templates the first import created are reused, not duplicated.
    expect(second.templates).toMatchObject([
      { name: 'Writer', action: 'reuse' },
      { name: 'Builder', action: 'reuse' },
    ])
    const secondResult = await service.importGroup(document, WORKSPACE_ID, second.planHash)
    expect(secondResult.rows.filter(row => row.kind === 'template').map(row => row.status))
      .toEqual(['reused', 'reused'])
    expect(secondResult.rows.find(row => row.kind === 'team'))
      .toMatchObject({ plannedName: '研究组 (2)', status: 'created' })
    expect(store.listTeams().map(team => team.name).sort()).toEqual(['研究组', '研究组 (2)'])
    expect(store.listAssistants().map(assistant => assistant.name).sort())
      .toEqual(['Builder', 'Writer'])
  })

  it('reports a failed write as rejected and keeps the remaining items going', async () => {
    const { service } = await createHarness()
    const document = teamDocument()
    const preview = await service.previewGroupImport(document, WORKSPACE_ID)
    vi.spyOn(service, 'createTeamDraft').mockRejectedValueOnce(
      new AgentTeamError('WORKSPACE_UNAVAILABLE', 'Workspace vanished'),
    )

    const result = await service.importGroup(document, WORKSPACE_ID, preview.planHash)
    expect(result.rows).toMatchObject([
      { kind: 'group', plannedName: '工作', status: 'created' },
      { kind: 'template', name: 'Writer', status: 'created' },
      { kind: 'template', name: 'Builder', status: 'created' },
      { kind: 'team', name: '研究组', status: 'rejected', reason: 'Workspace vanished' },
    ])
    expect(result.counts).toMatchObject({ created: 3, rejected: 1 })

    // A template that never landed cascades into a skipped team, not a crash.
    const fresh = createHarness()
    const second = await fresh.service.previewGroupImport(document, WORKSPACE_ID)
    vi.spyOn(fresh.service, 'createAssistant').mockRejectedValue(
      new AgentTeamError('PRESET_REFERENCE_INVALID', 'Preset gone'),
    )
    const cascade = await fresh.service.importGroup(document, WORKSPACE_ID, second.planHash)
    expect(cascade.rows.filter(row => row.kind === 'template').map(row => row.status))
      .toEqual(['rejected', 'rejected'])
    expect(cascade.rows.find(row => row.kind === 'team')).toMatchObject({
      status: 'skipped',
      reason: "its Assistant template 'Writer' was not created",
    })
  })

  it('exposes no agent tool that can export or import a group', () => {
    const registered: string[] = []
    const ctx = {
      tools: {
        register: (tool: { name: string }) => { registered.push(tool.name) },
      },
    } as unknown as Context
    registerAssistantTaskTools(ctx, {} as never)
    registerAssistantMemoryTools(ctx, {} as never)

    expect(registered.length).toBeGreaterThan(0)
    expect([...TEAM_TOOL_NAMES, ...registered].filter(name => /export|import|portable/i.test(name)))
      .toEqual([])
  })

  it('bounds the portable document well under the transport ceiling', () => {
    const bytes = portableDocumentBytes(documentWith({ group: { name: '工作', brief: 'x'.repeat(24_576) } }))
    expect(bytes).toBeLessThan(GROUP_SHARE_MAX_DOCUMENT_BYTES)
  })
})
