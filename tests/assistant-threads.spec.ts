import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import { assistantInstanceSchema } from '../src/domain/schemas.js'
import type { AssistantInstance } from '../src/domain/types.js'
import {
  AgentTeamService,
  ASSISTANT_THREAD_SESSION_LIMIT,
  type AgentTeamChange,
} from '../src/service/dsh-team-mode-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'

const NOW = '2026-10-21T00:00:00.000Z'

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

function instance(overrides: Partial<AssistantInstance> = {}): AssistantInstance {
  return {
    schemaVersion: 1,
    id: 'instance-1',
    assistantSnapshot: {
      assistantId: 'assistant-1',
      revision: 1,
      name: 'Researcher',
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
    workspacePath: '/tmp/dsh-assistant-thread-workspace',
    mainSessionId: 'session-main',
    status: 'active',
    pinned: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** The real service over the one store slice these methods touch. */
function createHarness(seed: AssistantInstance = instance()): {
  service: AgentTeamService
  instance: () => AssistantInstance
  changes: AgentTeamChange[]
} {
  const ctx = new Context()
  const instances = new Map([[seed.id, seed]])
  const store = {
    getAssistantInstance: (id: string) => instances.get(id),
    listAssistantInstances: () => [...instances.values()],
    updateAssistantInstance: async (
      id: string,
      update: (current: AssistantInstance) => AssistantInstance,
    ) => {
      const current = instances.get(id)
      if (current === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown record '${id}'`)
      const next = update(current)
      instances.set(id, next)
      return next
    },
  } as unknown as AgentTeamStore
  const service = new AgentTeamService(ctx, config, store)
  const changes: AgentTeamChange[] = []
  service.subscribe(change => { changes.push(change) })
  return { service, instance: () => instances.get(seed.id) as AssistantInstance, changes }
}

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  const error = await work.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(AgentTeamError)
  return (error as AgentTeamError).code
}

describe('Assistant threads', () => {
  it('attaches an extra Session and bumps the revision', async () => {
    const h = createHarness()

    const next = await h.service.attachAssistantThread('instance-1', '  session-a  ')

    expect(next.threadSessionIds).toEqual(['session-a'])
    expect(next.revision).toBe(2)
    expect(next.updatedAt).not.toBe(NOW)
    expect(h.instance().threadSessionIds).toEqual(['session-a'])
    expect(h.changes.at(-1)).toMatchObject({
      entityType: 'assistant-instance',
      entityId: 'instance-1',
      revision: 2,
      kind: 'assistant.instance.thread_attached',
    })
  })

  it('refuses the same Session twice', async () => {
    const h = createHarness(instance({ threadSessionIds: ['session-a'] }))

    expect(await codeOf(h.service.attachAssistantThread('instance-1', 'session-a')))
      .toBe('INVALID_REQUEST')
    expect(h.instance().threadSessionIds).toEqual(['session-a'])
    expect(h.instance().revision).toBe(1)
  })

  it('refuses the main Session as a thread', async () => {
    const h = createHarness()

    expect(await codeOf(h.service.attachAssistantThread('instance-1', 'session-main')))
      .toBe('INVALID_REQUEST')
    expect(h.instance().threadSessionIds).toBeUndefined()
  })

  it('refuses more threads than the limit', async () => {
    const full = Array.from({ length: ASSISTANT_THREAD_SESSION_LIMIT }, (_, index) => `session-${index}`)
    const h = createHarness(instance({ threadSessionIds: full }))

    expect(await codeOf(h.service.attachAssistantThread('instance-1', 'session-extra')))
      .toBe('INVALID_REQUEST')
    expect(h.instance().threadSessionIds).toEqual(full)
  })

  it('archives a thread into the retired list', async () => {
    const h = createHarness(instance({ threadSessionIds: ['session-a', 'session-b'] }))

    const next = await h.service.archiveAssistantThread('instance-1', 'session-a')

    expect(next.threadSessionIds).toEqual(['session-b'])
    expect(next.retiredThreadSessionIds).toEqual(['session-a'])
    expect(next.revision).toBe(2)
    expect(h.changes.at(-1)).toMatchObject({
      entityType: 'assistant-instance',
      entityId: 'instance-1',
      revision: 2,
      kind: 'assistant.instance.thread_archived',
    })
  })

  it('refuses to archive the main Session', async () => {
    const h = createHarness(instance({ threadSessionIds: ['session-a'] }))

    expect(await codeOf(h.service.archiveAssistantThread('instance-1', 'session-main')))
      .toBe('INVALID_REQUEST')
    expect(h.instance().threadSessionIds).toEqual(['session-a'])
    expect(h.instance().retiredThreadSessionIds).toBeUndefined()
  })

  it('refuses a Session that is not a thread', async () => {
    const h = createHarness(instance({ threadSessionIds: ['session-a'] }))

    expect(await codeOf(h.service.archiveAssistantThread('instance-1', 'session-unknown')))
      .toBe('INVALID_REQUEST')
    expect(await codeOf(h.service.archiveAssistantThread('instance-missing', 'session-a')))
      .toBe('ASSISTANT_INSTANCE_NOT_FOUND')
  })

  it('refuses both writes on an archived instance', async () => {
    const h = createHarness(instance({
      status: 'archived',
      threadSessionIds: ['session-a'],
      archivedAt: NOW,
    }))

    expect(await codeOf(h.service.attachAssistantThread('instance-1', 'session-b')))
      .toBe('ASSISTANT_INSTANCE_ARCHIVED')
    expect(await codeOf(h.service.archiveAssistantThread('instance-1', 'session-a')))
      .toBe('ASSISTANT_INSTANCE_ARCHIVED')
    expect(h.instance().threadSessionIds).toEqual(['session-a'])
    expect(h.changes).toEqual([])
  })

  it('reads a record stored before threads existed as no threads', async () => {
    const { threadSessionIds: _threads, retiredThreadSessionIds: _retired, ...legacyFields } = instance()
    const legacy = assistantInstanceSchema.parse(legacyFields)

    expect(legacy.threadSessionIds).toBeUndefined()
    expect(legacy.retiredThreadSessionIds).toBeUndefined()
    expect((legacy.threadSessionIds ?? [])).toEqual([])

    const h = createHarness(legacy)
    expect(await codeOf(h.service.archiveAssistantThread('instance-1', 'session-a')))
      .toBe('INVALID_REQUEST')
    const next = await h.service.attachAssistantThread('instance-1', 'session-a')
    expect(next.threadSessionIds).toEqual(['session-a'])
  })
})
