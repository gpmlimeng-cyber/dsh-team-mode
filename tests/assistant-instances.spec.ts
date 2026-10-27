import { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import { assistantInstanceSchema, assistantMemorySchema, assistantSessionSchema } from '../src/domain/schemas.js'
import type {
  AssistantInstance,
  AssistantMemory,
  AssistantSession,
  AssistantTemplate,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
} from '../src/domain/types.js'
import { isCoordinatorInstance } from '../src/domain/types.js'
import type { AssistantRuntime } from '../src/runtime/assistant-runtime.js'
import { AgentTeamService, ASSISTANT_MEMORY_MAX_CHARS } from '../src/service/dsh-team-mode-service.js'
import { dshTeamModeDomainSpec } from '../src/storage/domain.js'
import { DomainAgentTeamStore, type AgentTeamStore } from '../src/storage/store.js'

const NOW = '2026-10-21T00:00:00.000Z'
const WORKSPACE_PATH = '/tmp/dsh-assistant-instance-workspace'

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

function template(overrides: Partial<AssistantTemplate> = {}): AssistantTemplate {
  return {
    schemaVersion: 1,
    id: 'template-1',
    name: 'Research assistant',
    instructions: 'Research carefully and cite sources.',
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'high',
    agentPresetId: 'default',
    permissionPresetId: 'workspace-write',
    skillAllowlist: ['code-review'],
    mcpServers: [],
    prompts: ['Plan the work'],
    enabled: true,
    teamSelectable: true,
    sortOrder: 0,
    source: 'user',
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

const avatar = (value: string): string => `data:image/png;base64,${value}`

describe('Assistant instances', () => {
  it('creates an idle instance from a template snapshot and workspace', async () => {
    const { service, store } = createHarness()
    const assistant = template({ avatar: avatar('AAAA') })
    await store.putAssistant(assistant)

    const instance = await service.createAssistantInstance({
      templateId: assistant.id,
      name: '  My Researcher  ',
      workspaceId: 'workspace-1',
    })

    expect(instance).toMatchObject({
      schemaVersion: 1,
      templateId: 'template-1',
      workspaceId: 'workspace-1',
      workspacePath: WORKSPACE_PATH,
      status: 'idle',
      pinned: false,
      revision: 1,
    })
    expect(instance.id).not.toBe('')
    expect(instance.mainSessionId).toBeUndefined()
    expect(instance.archivedAt).toBeUndefined()
    expect(instance.assistantSnapshot).toEqual({
      assistantId: 'template-1',
      revision: 3,
      name: 'My Researcher',
      avatar: avatar('AAAA'),
      instructions: 'Research carefully and cite sources.',
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'high',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: ['code-review'],
      mcpServers: [],
      prompts: ['Plan the work'],
    })
    expect(assistantInstanceSchema.parse(instance)).toEqual(instance)
    expect(store.getAssistantInstance(instance.id)).toEqual(instance)
    // Persistence is a store read, so a fresh service instance sees the record.
    expect(new AgentTeamService(new Context(), config, store).getAssistantInstance(instance.id))
      .toEqual(instance)
    // Creation stores a snapshot and never touches the template or creates a Session.
    expect(store.getAssistant(assistant.id)).toEqual(assistant)
  })

  it('creates a template-less instance directly without a template row', async () => {
    const { service, store } = createHarness()

    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: '  Direct Researcher  ',
      instructions: 'Answer directly.',
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      pinned: true,
    })

    expect(instance).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      workspacePath: WORKSPACE_PATH,
      status: 'idle',
      pinned: true,
      revision: 1,
    })
    expect(instance.templateId).toBeUndefined()
    expect(instance.mainSessionId).toBeUndefined()
    expect(instance.assistantSnapshot).toEqual({
      assistantId: instance.id,
      revision: 1,
      name: 'Direct Researcher',
      instructions: 'Answer directly.',
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    })
    expect(assistantInstanceSchema.parse(instance)).toEqual(instance)
    const persisted = store.getAssistantInstance(instance.id)
    expect(persisted).toEqual(instance)
    expect(persisted?.templateId).toBeUndefined()
    expect(Object.hasOwn(persisted as object, 'templateId')).toBe(false)
    // Direct creation needs no template row and creates no Session.
    expect(store.listAssistants()).toEqual([])
    expect(store.listAssistantSessions()).toEqual([])

    const minimal = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Minimal',
      provider: 'openai',
      model: 'no-reasoning',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
    })
    expect(minimal.templateId).toBeUndefined()
    expect(minimal.assistantSnapshot.instructions).toBe('')
    expect(minimal.assistantSnapshot.reasoningEffort).toBeUndefined()
  })

  it('stores the mascot picked at creation, like instructions', async () => {
    const { service, store } = createHarness()

    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Picked',
      instructions: '',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      mascot: { seed: 'seed-7', shape: 'pill', eyes: 'big', color: '#4E6EF2', fill: 'radial' },
    })

    expect(instance.mascot).toEqual({
      seed: 'seed-7',
      shape: 'pill',
      eyes: 'big',
      color: '#4E6EF2',
      fill: 'radial',
    })
    expect(assistantInstanceSchema.parse(instance).mascot).toEqual(instance.mascot)
    expect(store.getAssistantInstance(instance.id)?.mascot).toEqual(instance.mascot)

    // Absent mascot stays absent: the avatar-less row falls back to initials.
    const plain = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Plain',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
    })
    expect(Object.hasOwn(plain as object, 'mascot')).toBe(false)
  })

  it('applies explicit fields on top of a template snapshot', async () => {
    const { service, store } = createHarness()
    const source = template({ avatar: avatar('AAAA') })
    await store.putAssistant(source)

    const instance = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
      name: 'Override Researcher',
      avatar: avatar('BBBB'),
      instructions: 'Use the override brief.',
      provider: 'anthropic',
      model: 'claude-sonnet',
      reasoningEffort: 'low',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      pinned: true,
      skillAllowlist: ['research'],
    })

    expect(instance.templateId).toBe('template-1')
    expect(instance.pinned).toBe(true)
    expect(instance.assistantSnapshot).toEqual({
      assistantId: 'template-1',
      revision: 3,
      name: 'Override Researcher',
      avatar: avatar('BBBB'),
      instructions: 'Use the override brief.',
      provider: 'anthropic',
      model: 'claude-sonnet',
      reasoningEffort: 'low',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      skillAllowlist: ['research'],
      mcpServers: [],
      prompts: ['Plan the work'],
    })
    expect(assistantInstanceSchema.parse(instance)).toEqual(instance)
    expect(store.getAssistant(source.id)).toEqual(source)

    // Fields the payload omits keep the template snapshot values.
    const partial = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
      permissionPresetId: 'read-only',
    })
    expect(partial.assistantSnapshot).toMatchObject({
      assistantId: 'template-1',
      revision: 3,
      name: 'Research assistant',
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'high',
      permissionPresetId: 'read-only',
      skillAllowlist: ['code-review'],
    })
  })

  it('rejects direct creation when a required field is missing or the payload is not strict', async () => {
    const { service, store } = createHarness()
    const base = {
      workspaceId: 'workspace-1',
      name: 'Direct',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
    }

    for (const field of ['name', 'provider', 'model', 'agentPresetId', 'permissionPresetId'] as const) {
      const { [field]: _omitted, ...payload } = base
      await expect(service.createAssistantInstance(payload as never)).rejects.toBeInstanceOf(Error)
    }
    const { workspaceId: _workspaceId, ...withoutWorkspace } = base
    await expect(service.createAssistantInstance(withoutWorkspace as never)).rejects.toBeInstanceOf(Error)
    await expect(service.createAssistantInstance({ ...base, templateId: '' } as never))
      .rejects.toBeInstanceOf(Error)
    await expect(service.createAssistantInstance({ ...base, unknownField: true } as never))
      .rejects.toBeInstanceOf(Error)
    expect(store.listAssistantInstances()).toEqual([])
  })

  it('rejects invalid direct and override references without persisting', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const base = {
      workspaceId: 'workspace-1',
      name: 'Direct',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
    }

    await expect(service.createAssistantInstance({ ...base, model: 'missing-model' }))
      .rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
    await expect(service.createAssistantInstance({ ...base, reasoningEffort: 'ultra' }))
      .rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
    await expect(service.createAssistantInstance({ ...base, permissionPresetId: 'root-access' }))
      .rejects.toMatchObject({ code: 'PERMISSION_PRESET_INVALID' })
    await expect(service.createAssistantInstance({ ...base, agentPresetId: 'missing-preset' }))
      .rejects.toMatchObject({ code: 'PRESET_REFERENCE_INVALID' })
    await expect(service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
      provider: 'anthropic',
      model: 'missing-model',
    })).rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
    await expect(service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
      reasoningEffort: 'ultra',
    })).rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
    await expect(service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
      permissionPresetId: 'root-access',
    })).rejects.toMatchObject({ code: 'PERMISSION_PRESET_INVALID' })
    await expect(service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
      agentPresetId: 'missing-preset',
    })).rejects.toMatchObject({ code: 'PRESET_REFERENCE_INVALID' })

    expect(store.listAssistantInstances()).toEqual([])
  })

  it('creates a direct instance carrying the Skills and MCP Servers it was given', async () => {
    const { service, store } = createHarness()

    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Equipped',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      skillAllowlist: ['code-review', ' code-review ', 'research'],
      mcpServers: ['github'],
    })

    expect(instance.assistantSnapshot.skillAllowlist).toEqual(['code-review', 'research'])
    expect(instance.assistantSnapshot.mcpServers).toEqual(['github'])
    expect(store.getAssistantInstance(instance.id)?.assistantSnapshot).toEqual(instance.assistantSnapshot)

    // Without the fields the snapshot keeps the empty lists older rows carry.
    const legacy = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Legacy',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
    })
    expect(legacy.assistantSnapshot.skillAllowlist).toEqual([])
    expect(legacy.assistantSnapshot.mcpServers).toEqual([])
    expect((await service.updateAssistantInstance(legacy.id, { pinned: true }))
      .assistantSnapshot).toMatchObject({ skillAllowlist: [], mcpServers: [] })
  })

  it('rejects an unusable Skill or a missing MCP Server with its name', async () => {
    const { service, store } = createHarness()
    const base = {
      workspaceId: 'workspace-1',
      name: 'Equipped',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
    }

    await expect(service.createAssistantInstance({ ...base, skillAllowlist: ['Not A Skill'] }))
      .rejects.toMatchObject({
        code: 'SKILL_REFERENCE_INVALID',
        message: expect.stringContaining('Not A Skill'),
      })
    await expect(service.createAssistantInstance({ ...base, mcpServers: ['gitlab'] }))
      .rejects.toMatchObject({
        code: 'MCP_REFERENCE_INVALID',
        message: expect.stringContaining('gitlab'),
      })
    expect(store.listAssistantInstances()).toEqual([])
  })

  it('adds and clears Skills and MCP Servers on update', async () => {
    const { service, store } = createHarness()
    const created = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Equipped',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      skillAllowlist: ['code-review'],
    })

    const added = await service.updateAssistantInstance(created.id, {
      skillAllowlist: ['code-review', 'research'],
      mcpServers: ['github'],
    })
    expect(added.revision).toBe(created.revision + 1)
    expect(added.assistantSnapshot.skillAllowlist).toEqual(['code-review', 'research'])
    expect(added.assistantSnapshot.mcpServers).toEqual(['github'])
    expect(store.getAssistantInstance(created.id)).toEqual(added)

    await expect(service.updateAssistantInstance(created.id, { skillAllowlist: ['Not A Skill'] }))
      .rejects.toMatchObject({
        code: 'SKILL_REFERENCE_INVALID',
        message: expect.stringContaining('Not A Skill'),
      })

    // Clearing is a real change, not a no-op.
    const cleared = await service.updateAssistantInstance(created.id, {
      skillAllowlist: [],
      mcpServers: [],
    })
    expect(cleared.revision).toBe(added.revision + 1)
    expect(cleared.assistantSnapshot.skillAllowlist).toEqual([])
    expect(cleared.assistantSnapshot.mcpServers).toEqual([])
  })

  it('allows duplicate display names', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())

    const first = await service.createAssistantInstance({
      templateId: 'template-1',
      name: 'Researcher',
      workspaceId: 'workspace-1',
    })
    const second = await service.createAssistantInstance({
      templateId: 'template-1',
      name: 'Researcher',
      workspaceId: 'workspace-1',
    })

    expect(second.id).not.toBe(first.id)
    expect(second.assistantSnapshot.name).toBe('Researcher')
    expect(service.listAssistantInstances()).toMatchObject({ total: 2 })
  })

  it('overrides name/avatar and pin state without touching the template', async () => {
    const { service, store } = createHarness()
    const assistant = template({ avatar: avatar('AAAA') })
    await store.putAssistant(assistant)
    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })

    const updated = await service.updateAssistantInstance(created.id, {
      name: 'Renamed Researcher',
      avatar: avatar('BBBB'),
      pinned: true,
    })

    expect(updated.revision).toBe(2)
    expect(updated.pinned).toBe(true)
    expect(updated.assistantSnapshot).toMatchObject({
      assistantId: 'template-1',
      revision: 3,
      name: 'Renamed Researcher',
      avatar: avatar('BBBB'),
      instructions: 'Research carefully and cite sources.',
    })
    expect(store.getAssistant(assistant.id)).toEqual(assistant)

    const cleared = await service.updateAssistantInstance(created.id, { avatar: '' })
    expect(cleared.revision).toBe(3)
    expect(cleared.assistantSnapshot.avatar).toBeUndefined()
    expect(cleared.assistantSnapshot.name).toBe('Renamed Researcher')

    const noop = await service.updateAssistantInstance(created.id, {})
    expect(noop.revision).toBe(3)
    expect(noop).toEqual(cleared)
  })

  it('replaces the persona text without touching the rest of the snapshot', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      name: 'Researcher',
      workspaceId: 'workspace-1',
    })
    expect(created.assistantSnapshot.instructions).toBe('Research carefully and cite sources.')

    const updated = await service.updateAssistantInstance(created.id, {
      instructions: 'Cite every claim.',
    })
    expect(updated.revision).toBe(created.revision + 1)
    expect(updated.assistantSnapshot.instructions).toBe('Cite every claim.')
    expect(updated.assistantSnapshot.name).toBe('Researcher')
    expect(updated.assistantSnapshot.model).toBe(created.assistantSnapshot.model)

    // An absent field keeps the stored persona; an empty string clears it.
    const kept = await service.updateAssistantInstance(created.id, { pinned: true })
    expect(kept.assistantSnapshot.instructions).toBe('Cite every claim.')
    const cleared = await service.updateAssistantInstance(created.id, { instructions: '' })
    expect(cleared.assistantSnapshot.instructions).toBe('')
  })

  it('updates model, reasoning, and permission on the stored snapshot', async () => {
    const { service, store } = createHarness()
    const assistant = template()
    await store.putAssistant(assistant)
    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      name: 'Researcher',
      workspaceId: 'workspace-1',
    })

    const updated = await service.updateAssistantInstance(created.id, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      reasoningEffort: 'medium',
      permissionPresetId: 'read-only',
    })

    expect(updated.revision).toBe(2)
    expect(updated.assistantSnapshot).toMatchObject({
      assistantId: 'template-1',
      revision: 3,
      name: 'Researcher',
      instructions: 'Research carefully and cite sources.',
      provider: 'anthropic',
      model: 'claude-sonnet',
      reasoningEffort: 'medium',
      permissionPresetId: 'read-only',
      skillAllowlist: ['code-review'],
      prompts: ['Plan the work'],
    })
    expect(assistantInstanceSchema.parse(updated)).toEqual(updated)
    expect(store.getAssistantInstance(created.id)).toEqual(updated)
    // The instance snapshot is persisted; the template is untouched.
    expect(new AgentTeamService(new Context(), config, store).getAssistantInstance(created.id))
      .toEqual(updated)
    expect(store.getAssistant(assistant.id)).toEqual(assistant)
  })

  it('clears reasoning when the new model does not support it or the patch clears it', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })

    const noReasoning = await service.updateAssistantInstance(created.id, {
      provider: 'openai',
      model: 'no-reasoning',
    })
    expect(noReasoning.revision).toBe(2)
    expect(noReasoning.assistantSnapshot.model).toBe('no-reasoning')
    expect(noReasoning.assistantSnapshot.reasoningEffort).toBeUndefined()

    const explicit = await service.updateAssistantInstance(created.id, {
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'low',
    })
    expect(explicit.revision).toBe(3)
    expect(explicit.assistantSnapshot.reasoningEffort).toBe('low')

    const cleared = await service.updateAssistantInstance(created.id, { reasoningEffort: '' })
    expect(cleared.revision).toBe(4)
    expect(cleared.assistantSnapshot.reasoningEffort).toBeUndefined()
    expect(cleared.assistantSnapshot.model).toBe('gpt-5')
  })

  it('does not bump the revision when engine fields match the snapshot', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })

    const unchanged = await service.updateAssistantInstance(created.id, {
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'high',
      permissionPresetId: 'workspace-write',
    })

    expect(unchanged.revision).toBe(created.revision)
    expect(unchanged.updatedAt).toBe(created.updatedAt)
    expect(service.getAssistantInstance(created.id)).toEqual(created)
  })

  it('rejects invalid engine references without changing the instance', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })

    await expect(service.updateAssistantInstance(created.id, { provider: 'anthropic' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(service.updateAssistantInstance(created.id, { model: 'gpt-5-mini' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(service.updateAssistantInstance(created.id, {
      provider: 'openai',
      model: 'missing-model',
    })).rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
    await expect(service.updateAssistantInstance(created.id, { reasoningEffort: 'ultra' }))
      .rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
    await expect(service.updateAssistantInstance(created.id, {
      permissionPresetId: 'root-access',
    })).rejects.toMatchObject({ code: 'PERMISSION_PRESET_INVALID' })
    // An explicit unsupported effort is rejected even when the model changes.
    await expect(service.updateAssistantInstance(created.id, {
      provider: 'openai',
      model: 'gpt-5-mini',
      reasoningEffort: 'medium',
    })).rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })

    expect(service.getAssistantInstance(created.id)).toEqual(created)
  })

  it('sorts pinned instances first for listing', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const older = await service.createAssistantInstance({
      templateId: 'template-1',
      name: 'Older',
      workspaceId: 'workspace-1',
    })
    const newer = await service.createAssistantInstance({
      templateId: 'template-1',
      name: 'Newer',
      workspaceId: 'workspace-1',
    })
    await service.updateAssistantInstance(older.id, { pinned: true })

    expect(service.listAssistantInstances().items.map(instance => instance.id)).toEqual([
      older.id,
      newer.id,
    ])
  })

  it('archives idempotently and keeps the bound main Session', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })
    const bound = await service.bindAssistantMainSession(created.id, 'session-main')

    const archived = await service.archiveAssistantInstance(created.id)
    expect(archived.status).toBe('archived')
    expect(archived.archivedAt).toBeDefined()
    expect(archived.mainSessionId).toBe('session-main')
    expect(archived.revision).toBe(bound.revision + 1)
    expect(store.getAssistantInstance(created.id)?.status).toBe('archived')

    const again = await service.archiveAssistantInstance(created.id)
    expect(again.revision).toBe(archived.revision)
    expect(again.archivedAt).toBe(archived.archivedAt)
    expect(store.getAssistantInstance(created.id)).toEqual(archived)
    // Archived rows stay in the unfiltered page so the client can filter them.
    expect(service.listAssistantInstances().items.map(instance => instance.id)).toContain(created.id)
  })

  it('binds the main Session idempotently and reactivates an idle instance', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })

    const bound = await service.bindAssistantMainSession(created.id, 'session-main')
    expect(bound).toMatchObject({
      mainSessionId: 'session-main',
      status: 'active',
      revision: 2,
    })

    const same = await service.bindAssistantMainSession(created.id, 'session-main')
    expect(same).toBe(bound)
    expect(store.getAssistantInstance(created.id)?.revision).toBe(2)

    const replaced = await service.bindAssistantMainSession(created.id, 'session-main-2')
    expect(replaced.mainSessionId).toBe('session-main-2')
    expect(replaced.revision).toBe(3)
  })

  it('delegates ensure to the attached assistant runtime and propagates archived', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })
    const runtime = {
      ensureInstance: vi.fn(async (id: string) => {
        const instance = service.getAssistantInstance(id)
        if (instance.status === 'archived') {
          throw new AgentTeamError(
            'ASSISTANT_INSTANCE_ARCHIVED',
            `Assistant instance '${id}' is archived`,
          )
        }
        return { instance, sessionId: 'session-main' }
      }),
      stopForArchive: vi.fn(async () => {}),
    } as unknown as AssistantRuntime
    service.attachAssistantRuntime(runtime)

    const ensured = await service.ensureAssistantInstance(created.id)
    expect(runtime.ensureInstance).toHaveBeenCalledWith(created.id)
    expect(ensured).toEqual({ instance: created, sessionId: 'session-main' })

    expect(() => service.attachAssistantRuntime(runtime))
      .toThrow('Assistant runtime is already attached')

    await service.archiveAssistantInstance(created.id)
    expect(runtime.stopForArchive).toHaveBeenCalledWith(created.id)
    await expect(service.ensureAssistantInstance(created.id)).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
  })

  it('opens a task through the attached assistant runtime', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })
    const task = await service.createAssistantSession({
      assistantId: created.id,
      sessionId: 'session-worker',
      title: 'Task',
      brief: 'Brief',
      parentSessionId: 'session-main',
    })

    await expect(service.openAssistantTask(task.id))
      .rejects.toThrow('Assistant runtime is not attached')

    const openTask = vi.fn(async (taskId: string) => ({
      task: service.getAssistantSession(taskId),
      sessionId: 'session-worker',
    }))
    const runtime = { openTask } as unknown as AssistantRuntime
    service.attachAssistantRuntime(runtime)

    const opened = await service.openAssistantTask(task.id)
    expect(openTask).toHaveBeenCalledWith(task.id)
    expect(opened).toEqual({ task, sessionId: 'session-worker' })
  })

  it('rejects ensure before an assistant runtime is attached', async () => {
    const { service } = createHarness()
    await expect(service.ensureAssistantInstance('instance-1')).rejects
      .toThrow('Assistant runtime is not attached')
  })

  it('rejects invalid template, workspace, instance, and payload references', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())

    await expect(service.createAssistantInstance({
      templateId: 'missing-template',
      workspaceId: 'workspace-1',
    })).rejects.toMatchObject({ code: 'ASSISTANT_NOT_FOUND' })

    await expect(service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'missing-workspace',
    })).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })

    await expect(service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-broken',
    })).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })

    await expect(service.createAssistantInstance({
      templateId: 'template-1',
      name: '   ',
      workspaceId: 'workspace-1',
    })).rejects.toBeInstanceOf(Error)

    await expect(service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
      unexpected: true,
    } as never)).rejects.toBeInstanceOf(Error)

    try {
      service.getAssistantInstance('missing-instance')
      expect.unreachable('getAssistantInstance should reject an unknown instance')
    } catch (error) {
      expect(error).toMatchObject({ code: 'ASSISTANT_INSTANCE_NOT_FOUND' })
    }
    await expect(service.updateAssistantInstance('missing-instance', { pinned: true })).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_NOT_FOUND' })
    await expect(service.archiveAssistantInstance('missing-instance')).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_NOT_FOUND' })
    await expect(service.bindAssistantMainSession('missing-instance', 'session-main')).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_NOT_FOUND' })

    const created = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })
    await expect(service.updateAssistantInstance(created.id, { pinned: 'yes' } as never))
      .rejects.toBeInstanceOf(Error)
    await expect(service.bindAssistantMainSession(created.id, '   ')).rejects
      .toMatchObject({ code: 'INVALID_REQUEST' })

    const archived = await service.archiveAssistantInstance(created.id)
    expect(archived.status).toBe('archived')
    await expect(service.bindAssistantMainSession(created.id, 'session-main')).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    await expect(service.bindAssistantMainSession(created.id, 'session-main')).rejects
      .toBeInstanceOf(AgentTeamError)
  })

  it('round-trips a template-less instance through the domain store', async () => {
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
    const store = new DomainAgentTeamStore(domain)
    const instance: AssistantInstance = {
      schemaVersion: 1,
      id: 'instance-direct',
      assistantSnapshot: {
        assistantId: 'instance-direct',
        revision: 1,
        name: 'Direct',
        instructions: '',
        provider: 'openai',
        model: 'gpt-5',
        agentPresetId: 'default',
        permissionPresetId: 'read-only',
        skillAllowlist: [],
        mcpServers: [],
        prompts: [],
      },
      workspaceId: 'workspace-1',
      workspacePath: WORKSPACE_PATH,
      status: 'idle',
      pinned: false,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }

    await store.putAssistantInstance(instance)
    expect(store.getAssistantInstance(instance.id)).toEqual(instance)
    expect(store.getAssistantInstance(instance.id)?.templateId).toBeUndefined()
  })

  it('adds assistant_instances to the v1 domain spec without a data migration', () => {
    // The domain format version stays 1: a single-layout unit stores table
    // documents by name, so an existing unit opens with an empty new table.
    expect(dshTeamModeDomainSpec.version).toBe(1)
    expect(Object.keys(dshTeamModeDomainSpec.tables)).toContain('assistant_instances')
    expect(dshTeamModeDomainSpec.tables.assistant_instances).toBeDefined()
  })
})

describe('Assistant memory', () => {
  async function instanceFor(service: AgentTeamService, store: MemoryStore): Promise<AssistantInstance> {
    await store.putAssistant(template())
    return service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })
  }

  it('returns undefined before the first write and bumps revisions on replace and append', async () => {
    const { service, store } = createHarness()
    const instance = await instanceFor(service, store)

    expect(service.getAssistantMemory(instance.id)).toBeUndefined()

    const first = await service.writeAssistantMemory(instance.id, 'Prefers tables.', 'replace')
    expect(first).toMatchObject({
      schemaVersion: 1,
      assistantId: instance.id,
      content: 'Prefers tables.',
      revision: 1,
    })
    expect(assistantMemorySchema.parse(first)).toEqual(first)
    expect(() => assistantMemorySchema.parse({ ...first, extra: true })).toThrow()

    const appended = await service.writeAssistantMemory(instance.id, 'Cite sources.', 'append')
    expect(appended.content).toBe('Prefers tables.\nCite sources.')
    expect(appended.revision).toBe(2)

    const replaced = await service.writeAssistantMemory(instance.id, 'Only this.', 'replace')
    expect(replaced.content).toBe('Only this.')
    expect(replaced.revision).toBe(3)

    // Persistence is a store read, so a fresh service instance sees the record.
    expect(new AgentTeamService(new Context(), config, store).getAssistantMemory(instance.id))
      .toEqual(replaced)
  })

  it('rejects content over the 16000 character budget without changing the record', async () => {
    const { service, store } = createHarness()
    const instance = await instanceFor(service, store)

    const exact = await service.writeAssistantMemory(
      instance.id,
      'a'.repeat(ASSISTANT_MEMORY_MAX_CHARS),
      'replace',
    )
    expect(exact.content).toHaveLength(ASSISTANT_MEMORY_MAX_CHARS)

    await expect(service.writeAssistantMemory(instance.id, 'b', 'append')).rejects
      .toMatchObject({
        code: 'INVALID_REQUEST',
        details: {
          length: ASSISTANT_MEMORY_MAX_CHARS + 2,
          limit: ASSISTANT_MEMORY_MAX_CHARS,
        },
      })
    expect(service.getAssistantMemory(instance.id)).toEqual(exact)
  })

  it('rejects archived and unknown instances', async () => {
    const { service, store } = createHarness()
    const instance = await instanceFor(service, store)
    await service.archiveAssistantInstance(instance.id)

    await expect(service.writeAssistantMemory(instance.id, 'Note.', 'replace')).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(service.getAssistantMemory(instance.id)).toBeUndefined()

    await expect(service.writeAssistantMemory('missing-instance', 'Note.', 'replace')).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_NOT_FOUND' })
    expect(service.getAssistantMemory('missing-instance')).toBeUndefined()
  })

  it('honors an expected memory revision', async () => {
    const { service, store } = createHarness()
    const instance = await instanceFor(service, store)

    await expect(service.writeAssistantMemory(instance.id, 'First.', 'replace', {
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'ASSISTANT_REVISION_CONFLICT' })

    const first = await service.writeAssistantMemory(instance.id, 'First.', 'replace', {
      expectedRevision: 0,
    })
    expect(first.revision).toBe(1)

    const second = await service.writeAssistantMemory(instance.id, 'Second.', 'append', {
      expectedRevision: 1,
    })
    expect(second.revision).toBe(2)
    expect(second.content).toBe('First.\nSecond.')
  })

  it('exposes assistant_memory in the v1 domain spec and round-trips it through the store', async () => {
    expect(dshTeamModeDomainSpec.version).toBe(1)
    expect(Object.keys(dshTeamModeDomainSpec.tables)).toContain('assistant_memory')

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
    const store = new DomainAgentTeamStore(domain)
    const memory: AssistantMemory = {
      schemaVersion: 1,
      assistantId: 'instance-1',
      content: 'Remember this.',
      revision: 1,
      updatedAt: NOW,
    }

    await store.putAssistantMemory(memory)
    expect(store.getAssistantMemory('instance-1')).toEqual(memory)

    const updated = await store.updateAssistantMemory('instance-1', current => ({
      ...current,
      content: 'Remember this better.',
      revision: 2,
      updatedAt: NOW,
    }))
    expect(updated).toMatchObject({ content: 'Remember this better.', revision: 2 })
    expect(store.getAssistantMemory('instance-1')).toEqual(updated)
  })
})

describe('Assistant sessions', () => {
  it('persists a queued task whose parent is the main Session', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const instance = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })
    await service.bindAssistantMainSession(instance.id, 'session-main')

    const task = await service.createAssistantSession({
      assistantId: instance.id,
      sessionId: 'session-worker',
      title: 'Compare vendors',
      brief: 'Return a comparison table.',
      parentSessionId: 'session-main',
    })

    expect(task).toMatchObject({
      schemaVersion: 1,
      assistantId: instance.id,
      sessionId: 'session-worker',
      role: 'task',
      title: 'Compare vendors',
      brief: 'Return a comparison table.',
      parentSessionId: 'session-main',
      status: 'queued',
    })
    expect(task.id).not.toBe('')
    expect(task.archivedAt).toBeUndefined()
    expect(assistantSessionSchema.parse(task)).toEqual(task)
    expect(service.getAssistantSession(task.id)).toEqual(task)
    // Persistence is a store read, so a fresh service instance sees the record.
    expect(new AgentTeamService(new Context(), config, store).getAssistantSession(task.id))
      .toEqual(task)
  })

  it('lists all tasks or filters by assistant instance', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const first = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })
    const second = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })
    const a = await service.createAssistantSession({
      assistantId: first.id,
      sessionId: 'session-a',
      title: 'A',
      brief: 'A brief',
      parentSessionId: 'session-main-a',
    })
    const b = await service.createAssistantSession({
      assistantId: second.id,
      sessionId: 'session-b',
      title: 'B',
      brief: 'B brief',
      parentSessionId: 'session-main-b',
    })

    expect(service.listAssistantSessions()).toMatchObject({ total: 2 })
    expect(service.listAssistantSessions(first.id).items.map(task => task.id)).toEqual([a.id])
    expect(service.listAssistantSessions(second.id).items.map(task => task.id)).toEqual([b.id])
  })

  it('updates status and result summary without dropping other fields', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const instance = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })
    const task = await service.createAssistantSession({
      assistantId: instance.id,
      sessionId: 'session-worker',
      title: 'Task',
      brief: 'Brief',
      parentSessionId: 'session-main',
    })

    const running = await service.updateAssistantSession(task.id, { status: 'running' })
    expect(running).toMatchObject({ status: 'running', brief: 'Brief', sessionId: 'session-worker' })

    const completed = await service.updateAssistantSession(task.id, {
      status: 'completed',
      resultSummary: 'Done and verified.',
    })
    expect(completed).toMatchObject({
      status: 'completed',
      resultSummary: 'Done and verified.',
      title: 'Task',
    })

    const noop = await service.updateAssistantSession(task.id, {})
    expect(noop).toEqual(completed)
  })

  it('rejects unknown and archived assistant instances', async () => {
    const { service, store } = createHarness()
    await store.putAssistant(template())
    const instance = await service.createAssistantInstance({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })
    await service.archiveAssistantInstance(instance.id)

    await expect(service.createAssistantSession({
      assistantId: instance.id,
      sessionId: 'session-worker',
      title: 'Task',
      brief: 'Brief',
      parentSessionId: 'session-main',
    })).rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })

    await expect(service.createAssistantSession({
      assistantId: 'missing',
      sessionId: 'session-worker',
      title: 'Task',
      brief: 'Brief',
      parentSessionId: 'session-main',
    })).rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_NOT_FOUND' })

    await expect(service.updateAssistantSession('missing', { status: 'completed' }))
      .rejects.toMatchObject({ code: 'ASSISTANT_TASK_NOT_FOUND' })
  })

  it('exposes the assistant_sessions table and round-trips it through the domain store', async () => {
    expect(dshTeamModeDomainSpec.version).toBe(1)
    expect(Object.keys(dshTeamModeDomainSpec.tables)).toContain('assistant_sessions')

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
    const store = new DomainAgentTeamStore(domain)
    const task: AssistantSession = {
      schemaVersion: 1,
      id: 'task-1',
      assistantId: 'instance-1',
      sessionId: 'session-worker',
      role: 'task',
      title: 'Task',
      brief: 'Brief',
      parentSessionId: 'session-main',
      status: 'queued',
      createdAt: NOW,
      updatedAt: NOW,
    }

    await store.putAssistantSession(task)
    expect(store.getAssistantSession(task.id)).toEqual(task)
    expect(store.listAssistantSessions()).toEqual([task])

    const updated = await store.updateAssistantSession(task.id, current => ({
      ...current,
      status: 'completed',
      resultSummary: 'Done.',
    }))
    expect(updated).toMatchObject({ status: 'completed', resultSummary: 'Done.' })
    expect(store.getAssistantSession(task.id)).toEqual(updated)
  })
})

/** A directly configured instance: no template row, so the test owns every field. */
function createInstance(service: AgentTeamService, name: string): Promise<AssistantInstance> {
  return service.createAssistantInstance({
    workspaceId: 'workspace-1',
    name,
    provider: 'openai',
    model: 'gpt-5',
    agentPresetId: 'default',
    permissionPresetId: 'read-only',
  })
}

describe('Assistant coordinator', () => {
  it('leaves the flag absent on an instance that was never made coordinator', async () => {
    const { service } = createHarness()
    const instance = await createInstance(service, 'Plain')

    // Missing-field compatibility: a row stored before the flag existed carries
    // no key at all, still parses, and reads as "not the coordinator".
    expect('coordinator' in instance).toBe(false)
    expect(assistantInstanceSchema.parse(instance)).toEqual(instance)
    expect(isCoordinatorInstance(instance)).toBe(false)
    expect(service.getCoordinatorInstance()).toBeUndefined()
  })

  it('switches the single coordinator: setting a new one clears the old', async () => {
    const { service, store } = createHarness()
    const first = await createInstance(service, 'First')
    const second = await createInstance(service, 'Second')

    const set = await service.setCoordinatorInstance(first.id)
    expect(set?.id).toBe(first.id)
    expect(isCoordinatorInstance(store.getAssistantInstance(first.id)!)).toBe(true)

    const switched = await service.setCoordinatorInstance(second.id)
    expect(switched?.id).toBe(second.id)
    expect(isCoordinatorInstance(store.getAssistantInstance(second.id)!)).toBe(true)
    // Cleared by removing the field, so a former coordinator reads exactly like
    // a pre-coordinator row.
    expect('coordinator' in store.getAssistantInstance(first.id)!).toBe(false)
    expect(store.listAssistantInstances().filter(isCoordinatorInstance).map(item => item.id))
      .toEqual([second.id])
    // Persisted, not held in memory: a fresh service sees the same coordinator.
    expect(new AgentTeamService(new Context(), config, store).getCoordinatorInstance()?.id)
      .toBe(second.id)

    // Setting the current coordinator again is a no-op, not a revision bump.
    const stable = await service.setCoordinatorInstance(second.id)
    expect(stable).toEqual(switched)
    expect(store.getAssistantInstance(second.id)?.revision).toBe(switched?.revision)
  })

  it('clears the coordinator with null and refuses unknown or archived targets', async () => {
    const { service, store } = createHarness()
    const instance = await createInstance(service, 'Coordinator')
    await service.setCoordinatorInstance(instance.id)

    expect(await service.setCoordinatorInstance(null)).toBeUndefined()
    expect(service.getCoordinatorInstance()).toBeUndefined()
    expect(store.listAssistantInstances().some(isCoordinatorInstance)).toBe(false)

    await expect(service.setCoordinatorInstance('missing'))
      .rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_NOT_FOUND' })
    await expect(service.setCoordinatorInstance('   '))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const archived = await createInstance(service, 'Archived')
    await service.archiveAssistantInstance(archived.id)
    await expect(service.setCoordinatorInstance(archived.id))
      .rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
  })

  it('refuses to archive the coordinator and names the way out', async () => {
    const { service, store } = createHarness()
    const instance = await createInstance(service, 'Coordinator')
    await service.setCoordinatorInstance(instance.id)

    await expect(service.archiveAssistantInstance(instance.id)).rejects.toMatchObject({
      code: 'ASSISTANT_INSTANCE_COORDINATOR',
      message: expect.stringContaining('assistant.coordinator.set'),
    })
    expect(store.getAssistantInstance(instance.id)?.status).not.toBe('archived')

    // The hint is executable: clearing the coordinator unblocks the archive.
    await service.setCoordinatorInstance(null)
    const archived = await service.archiveAssistantInstance(instance.id)
    expect(archived.status).toBe('archived')
    expect(isCoordinatorInstance(archived)).toBe(false)
  })

  it('never reports a coordinator as archived on load or list', async () => {
    // A state the archive entry point cannot produce (older build, direct edit):
    // read it back visible instead of silently dropping the pinned row.
    const { service, store } = createHarness()
    const instance = await createInstance(service, 'Legacy coordinator')
    await store.putAssistantInstance({
      ...instance,
      coordinator: true,
      status: 'archived',
      archivedAt: NOW,
    })

    const loaded = service.getAssistantInstance(instance.id)
    expect(loaded).toMatchObject({ status: 'idle', coordinator: true })
    expect(loaded.archivedAt).toBeUndefined()
    expect(service.listAssistantInstances().items.find(item => item.id === instance.id))
      .toMatchObject({ status: 'idle' })
    expect(service.getCoordinatorInstance()?.status).toBe('idle')
  })

  it('serializes concurrent switches so exactly one coordinator remains', async () => {
    const { service, store } = createHarness()
    const first = await createInstance(service, 'First')
    const second = await createInstance(service, 'Second')

    await Promise.all([
      service.setCoordinatorInstance(first.id),
      service.setCoordinatorInstance(second.id),
    ])

    expect(store.listAssistantInstances().filter(isCoordinatorInstance).map(item => item.id))
      .toEqual([second.id])
    expect(service.getCoordinatorInstance()?.id).toBe(second.id)
  })
})

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

function createHarness(): { service: AgentTeamService; store: MemoryStore } {
  const ctx = new Context()
  const workspaces = new Map([
    ['workspace-1', {
      id: 'workspace-1',
      path: WORKSPACE_PATH,
      title: 'Workspace',
      status: async () => 'ok' as const,
    }],
    ['workspace-broken', {
      id: 'workspace-broken',
      path: '/tmp/dsh-assistant-instance-missing',
      title: 'Missing workspace',
      status: async () => 'missing-dir' as const,
    }],
  ])
  ctx.provide('workspaceRegistry', {
    get: (id: string) => workspaces.get(id),
    list: () => [...workspaces.values()],
  } as never)
  ctx.provide('llm', {
    listProviders: () => [
      { id: 'openai', name: 'OpenAI' },
      { id: 'anthropic', name: 'Anthropic' },
    ],
    listModels: async (provider: string) => (provider === 'anthropic'
      ? [{ id: 'claude-sonnet', name: 'Claude Sonnet' }]
      : [
        { id: 'gpt-5', name: 'GPT-5' },
        { id: 'gpt-5-mini', name: 'GPT-5 mini' },
        { id: 'no-reasoning', name: 'No reasoning' },
      ]),
    resolveModelInfo: async (provider: string, model: string) => {
      const efforts = provider === 'openai' && model === 'gpt-5'
        ? ['low', 'medium', 'high']
        : provider === 'openai' && model === 'gpt-5-mini'
          ? ['low', 'high']
          : provider === 'anthropic' && model === 'claude-sonnet'
            ? ['low', 'medium', 'high']
            : provider === 'openai' && model === 'no-reasoning'
              ? []
              : undefined
      if (efforts === undefined) throw new Error(`Unknown model '${provider}/${model}'`)
      return {
        provider,
        model,
        ...(efforts.length === 0
          ? {}
          : {
              reasoning: {
                efforts: efforts.map(id => ({ id, name: id })),
                defaultEffort: efforts[0],
              },
            }),
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
    // Catalog reads lease the preset revision's scope and release it through
    // Symbol.asyncDispose.
    acquireScope: async () => ({
      key: { kind: 'preset-scope' },
      [Symbol.asyncDispose]: async () => {},
    }),
  } as never)
  // The only MCP Server the `default` preset can reach in catalog reads.
  ctx.provide('tools', {
    schemas: () => [{ name: 'mcp__github__list_issues', description: 'List issues.' }],
  } as never)
  const store = new MemoryStore()
  return { service: new AgentTeamService(ctx, config, store), store }
}

class MemoryStore implements AgentTeamStore {
  private assistants = new Map<string, AssistantTemplate>()
  private assistantInstances = new Map<string, AssistantInstance>()
  private assistantSessions = new Map<string, AssistantSession>()
  private assistantMemory = new Map<string, AssistantMemory>()
  private teams = new Map<string, TeamAggregate>()
  private messages = new Map<string, TeamMessage>()
  private activities = new Map<string, TeamActivity>()
  private operations = new Map<string, Operation>()

  getAssistant(id: string) { return this.assistants.get(id) }
  listAssistants() { return [...this.assistants.values()] }
  async putAssistant(value: AssistantTemplate) { this.assistants.set(value.id, value) }
  updateAssistant(id: string, update: (current: AssistantTemplate) => AssistantTemplate) {
    return updateMap(this.assistants, id, update)
  }
  async deleteAssistant(id: string) { return this.assistants.delete(id) }

  getAssistantInstance(id: string) { return this.assistantInstances.get(id) }
  listAssistantInstances() { return [...this.assistantInstances.values()] }
  async putAssistantInstance(value: AssistantInstance) { this.assistantInstances.set(value.id, value) }
  updateAssistantInstance(id: string, update: (current: AssistantInstance) => AssistantInstance) {
    return updateMap(this.assistantInstances, id, update)
  }
  async deleteAssistantInstance(id: string) { return this.assistantInstances.delete(id) }

  getAssistantMemory(assistantId: string) { return this.assistantMemory.get(assistantId) }
  async putAssistantMemory(value: AssistantMemory) { this.assistantMemory.set(value.assistantId, value) }
  updateAssistantMemory(
    assistantId: string,
    update: (current: AssistantMemory) => AssistantMemory,
  ) {
    return updateMap(this.assistantMemory, assistantId, update)
  }

  getAssistantSession(id: string) { return this.assistantSessions.get(id) }
  listAssistantSessions() { return [...this.assistantSessions.values()] }
  async putAssistantSession(value: AssistantSession) { this.assistantSessions.set(value.id, value) }
  updateAssistantSession(id: string, update: (current: AssistantSession) => AssistantSession) {
    return updateMap(this.assistantSessions, id, update)
  }

  getTeam(id: string) { return this.teams.get(id) }
  listTeams() { return [...this.teams.values()] }
  async putTeam(value: TeamAggregate) { this.teams.set(value.id, value) }
  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate) {
    return updateMap(this.teams, id, update)
  }
  async deleteTeam(id: string) { return this.teams.delete(id) }

  listMessages(teamId: string) { return [...this.messages.values()].filter(value => value.teamId === teamId) }
  async putMessage(value: TeamMessage) { this.messages.set(value.id, value) }
  async deleteMessage(id: string) { return this.messages.delete(id) }

  listActivities(teamId: string) { return [...this.activities.values()].filter(value => value.teamId === teamId) }
  async putActivity(value: TeamActivity) { this.activities.set(value.id, value) }
  async deleteActivity(id: string) { return this.activities.delete(id) }

  getOperation(id: string) { return this.operations.get(id) }
  listOperations() { return [...this.operations.values()] }
  async putOperation(value: Operation) { this.operations.set(value.id, value) }
  updateOperation(id: string, update: (current: Operation) => Operation) {
    return updateMap(this.operations, id, update)
  }
  async deleteOperation(id: string) { return this.operations.delete(id) }
}

async function updateMap<T>(map: Map<string, T>, id: string, update: (current: T) => T): Promise<T> {
  const current = map.get(id)
  if (current === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown record '${id}'`)
  const next = update(current)
  map.set(id, next)
  return next
}
