import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'
import { assistantInstanceSchema, contextCheckpointSchema } from '../src/domain/schemas.js'
import type { ContextCheckpoint } from '../src/domain/types.js'
import { dshTeamModeDomainSpec } from '../src/storage/domain.js'
import { DomainAgentTeamStore } from '../src/storage/store.js'

const NOW = '2026-01-01T00:00:00.000Z'

function checkpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'cp-1',
    assistantId: 'a-1',
    sourceSessionId: 's-1',
    title: 'Handoff',
    note: '',
    capturedThroughSeq: 12,
    facts: {
      recentMessages: [],
      activeTasks: [],
      workspacePath: '/tmp/w',
      note: '',
    },
    createdAt: NOW,
    ...overrides,
  }
}

const messages = (count: number) => Array.from({ length: count }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  text: `message ${index}`,
}))

const tasks = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `task-${index}`,
  title: `Task ${index}`,
  status: 'running',
}))

function legacyInstance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'instance-1',
    assistantSnapshot: {
      assistantId: 'template-1',
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
    workspacePath: '/tmp/w',
    mainSessionId: 'session-main',
    status: 'idle',
    pinned: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
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

describe('Context checkpoint model', () => {
  it('parses a bounded checkpoint and defaults status to ready', () => {
    const parsed = contextCheckpointSchema.parse(checkpoint())

    expect(parsed.status).toBe('ready')
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      id: 'cp-1',
      assistantId: 'a-1',
      sourceSessionId: 's-1',
      title: 'Handoff',
      capturedThroughSeq: 12,
    })
    expect(parsed.targetSessionId).toBeUndefined()
    expect(parsed.consumedAt).toBeUndefined()
  })

  it('keeps an explicit status and the optional target session', () => {
    const parsed = contextCheckpointSchema.parse(
      checkpoint({ status: 'consumed', targetSessionId: 's-2', consumedAt: NOW }),
    )

    expect(parsed.status).toBe('consumed')
    expect(parsed.targetSessionId).toBe('s-2')
    expect(parsed.consumedAt).toBe(NOW)
  })

  it('rejects an unknown status', () => {
    expect(() => contextCheckpointSchema.parse(checkpoint({ status: 'done' }))).toThrow()
  })

  it('caps recent messages at 12 and each text at 500 chars', () => {
    expect(contextCheckpointSchema.parse(checkpoint({
      facts: {
        recentMessages: messages(12),
        activeTasks: [],
        workspacePath: '/tmp/w',
        note: '',
      },
    })).facts.recentMessages).toHaveLength(12)

    expect(() => contextCheckpointSchema.parse(checkpoint({
      facts: {
        recentMessages: messages(13),
        activeTasks: [],
        workspacePath: '/tmp/w',
        note: '',
      },
    }))).toThrow()

    const bounded = {
      recentMessages: [{ role: 'user', text: 'x'.repeat(500) }],
      activeTasks: [],
      workspacePath: '/tmp/w',
      note: '',
    }
    expect(contextCheckpointSchema.parse(checkpoint({ facts: bounded })).facts.recentMessages[0]?.text)
      .toHaveLength(500)

    expect(() => contextCheckpointSchema.parse(checkpoint({
      facts: {
        ...bounded,
        recentMessages: [{ role: 'user', text: 'x'.repeat(501) }],
      },
    }))).toThrow()
  })

  it('caps active tasks at 20', () => {
    const facts = (count: number) => ({
      recentMessages: [],
      activeTasks: tasks(count),
      workspacePath: '/tmp/w',
      note: '',
    })

    expect(contextCheckpointSchema.parse(checkpoint({ facts: facts(20) })).facts.activeTasks)
      .toHaveLength(20)
    expect(() => contextCheckpointSchema.parse(checkpoint({ facts: facts(21) }))).toThrow()
  })

  it('caps the user note at 4000 chars', () => {
    expect(contextCheckpointSchema.parse(checkpoint({ note: 'x'.repeat(4000) })).note)
      .toHaveLength(4000)
    expect(() => contextCheckpointSchema.parse(checkpoint({ note: 'x'.repeat(4001) }))).toThrow()
  })

  it('accepts a legacy instance without retired ids and keeps a provided list', () => {
    const legacy = assistantInstanceSchema.parse(legacyInstance())
    expect(legacy.retiredMainSessionIds).toBeUndefined()

    const withRetired = assistantInstanceSchema.parse(
      legacyInstance({ retiredMainSessionIds: ['session-old-1', 'session-old-2'] }),
    )
    expect(withRetired.retiredMainSessionIds).toEqual(['session-old-1', 'session-old-2'])
  })

  it('exposes context_checkpoints and round-trips checkpoints through the store', async () => {
    expect(Object.keys(dshTeamModeDomainSpec.tables)).toContain('context_checkpoints')
    const store = new DomainAgentTeamStore(fakeDomain())
    const older = contextCheckpointSchema.parse(checkpoint({
      id: 'cp-older',
      createdAt: '2026-01-01T00:00:00.000Z',
    }))
    const newer = contextCheckpointSchema.parse(checkpoint({
      id: 'cp-newer',
      createdAt: '2026-01-02T00:00:00.000Z',
    }))

    await store.putContextCheckpoint(older)
    await store.putContextCheckpoint(newer)

    expect(store.getContextCheckpoint('cp-newer')).toEqual(newer)
    expect(store.listContextCheckpoints().map(value => value.id)).toEqual(['cp-newer', 'cp-older'])

    const updated = await store.updateContextCheckpoint('cp-newer', current => ({
      ...current,
      status: 'consumed' as const,
    }))
    expect(updated.status).toBe('consumed')
    expect(store.getContextCheckpoint('cp-newer')?.status).toBe('consumed')
  })

  it('round-trips a legacy instance record without a retired list', async () => {
    const store = new DomainAgentTeamStore(fakeDomain())
    const legacy = assistantInstanceSchema.parse(legacyInstance())

    await store.putAssistantInstance(legacy)

    expect(store.getAssistantInstance('instance-1')).toEqual(legacy)
  })

  it('stores the checkpoint value bounded by the schema', () => {
    // Guards the store value type: parsed records are the persisted shape.
    const value: ContextCheckpoint = contextCheckpointSchema.parse(checkpoint())
    expect(value.facts.recentMessages).toEqual([])
  })
})
