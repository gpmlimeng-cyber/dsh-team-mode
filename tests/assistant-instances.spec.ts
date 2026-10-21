import { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import { assistantInstanceSchema, assistantSessionSchema } from '../src/domain/schemas.js'
import type {
  AssistantInstance,
  AssistantSession,
  AssistantTemplate,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
} from '../src/domain/types.js'
import type { AssistantRuntime } from '../src/runtime/assistant-runtime.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
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
    } as unknown as AssistantRuntime
    service.attachAssistantRuntime(runtime)

    const ensured = await service.ensureAssistantInstance(created.id)
    expect(runtime.ensureInstance).toHaveBeenCalledWith(created.id)
    expect(ensured).toEqual({ instance: created, sessionId: 'session-main' })

    expect(() => service.attachAssistantRuntime(runtime))
      .toThrow('Assistant runtime is already attached')

    await service.archiveAssistantInstance(created.id)
    await expect(service.ensureAssistantInstance(created.id)).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
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

  it('adds assistant_instances to the v1 domain spec without a data migration', () => {
    // The domain format version stays 1: a single-layout unit stores table
    // documents by name, so an existing unit opens with an empty new table.
    expect(dshTeamModeDomainSpec.version).toBe(1)
    expect(Object.keys(dshTeamModeDomainSpec.tables)).toContain('assistant_instances')
    expect(dshTeamModeDomainSpec.tables.assistant_instances).toBeDefined()
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
  const store = new MemoryStore()
  return { service: new AgentTeamService(ctx, config, store), store }
}

class MemoryStore implements AgentTeamStore {
  private assistants = new Map<string, AssistantTemplate>()
  private assistantInstances = new Map<string, AssistantInstance>()
  private assistantSessions = new Map<string, AssistantSession>()
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
