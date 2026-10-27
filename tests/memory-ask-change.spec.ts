import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import {
  AssistantMemorySection,
  MemoryAskOutcome,
  memoryAskFailure,
} from '../src/client/assistant-memory-panel.js'
import { AgentTeamError } from '../src/domain/errors.js'
import type {
  AssistantInstance,
  AssistantMemory,
  AssistantSession,
  AssistantTemplate,
  MemoryEntry,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
  WriteAssistantMemoryEntryInput,
} from '../src/domain/types.js'
import { AssistantRuntime, memoryPrompt } from '../src/runtime/assistant-runtime.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'

// The shipped primitives package expects browser peers this node test does not
// install; the rendered copy and structure are what the assertions below pin.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  const Icon = (): ReactElement => react.createElement('span')
  const Pass = (props: { children?: ReactNode }): ReactElement =>
    react.createElement('span', null, props.children)
  return {
    Button: (props: {
      children?: ReactNode
      type?: 'button' | 'submit'
      disabled?: boolean
    }): ReactElement => react.createElement(
      'button',
      { type: props.type ?? 'button', disabled: props.disabled },
      props.children,
    ),
    Menu: Pass,
    Modal: Pass,
    IconChevronDownOutlineRegular: Icon,
  }
})

function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
}

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

function instance(overrides: Partial<AssistantInstance> = {}): AssistantInstance {
  return {
    schemaVersion: 1,
    id: 'instance-1',
    templateId: 'template-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: 'Researcher',
      instructions: 'Cite sources.',
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'high',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/dsh-memory-ask',
    status: 'active',
    pinned: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function entry(
  id: string,
  status: MemoryEntry['status'],
  title: string,
  body: string,
): MemoryEntry {
  return {
    id,
    scope: 'assistant',
    visibility: 'private',
    status,
    source: 'assistant',
    title,
    body,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function memory(entries: MemoryEntry[], revision = 1): AssistantMemory {
  return {
    schemaVersion: 1,
    assistantId: 'instance-1',
    content: '',
    entries,
    revision,
    updatedAt: NOW,
  }
}

type ReplyChunk = StreamChunk

function harness(options: {
  reply?: string
  failure?: string
  stored?: AssistantMemory
  archived?: boolean
  rejectWrite?: AgentTeamError
  /** 1-based index of a write that is rejected after the earlier ones landed. */
  failWriteNumber?: number
} = {}) {
  const requests: GenerateOptions[] = []
  const llm = {
    stream: (request: GenerateOptions): AsyncIterable<StreamChunk> => {
      requests.push(request)
      return (async function* (): AsyncGenerator<ReplyChunk, void, void> {
        if (options.failure !== undefined) {
          yield { type: 'text-delta', index: 0, text: 'partial' }
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: options.failure, code: 'RATE_LIMIT' },
            },
          }
          return
        }
        yield { type: 'text-delta', index: 0, text: options.reply ?? '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }

  const ctx = {
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    on: vi.fn(() => () => {}),
    llm,
  } as unknown as Context

  let stored = options.stored
  const getAssistantInstance = vi.fn(() => instance(
    options.archived === true ? { status: 'archived' } : {},
  ))
  const getAssistantMemory = vi.fn(() => stored)
  const writeAssistantMemoryEntry = vi.fn(async (
    assistantId: string,
    input: WriteAssistantMemoryEntryInput,
    writeOptions: { expectedRevision?: number } = {},
  ) => {
    if (options.rejectWrite !== undefined) throw options.rejectWrite
    const attempt = writeAssistantMemoryEntry.mock.calls.length
    if (options.failWriteNumber !== undefined && attempt === options.failWriteNumber) {
      throw new AgentTeamError(
        'MEMORY_REVISION_CONFLICT',
        `Assistant memory revision conflict on write ${attempt}`,
      )
    }
    const currentRevision = stored?.revision ?? 0
    if (writeOptions.expectedRevision !== undefined
      && writeOptions.expectedRevision !== currentRevision) {
      throw new AgentTeamError(
        'MEMORY_REVISION_CONFLICT',
        `Assistant memory revision conflict: expected ${writeOptions.expectedRevision}, current ${currentRevision}`,
      )
    }
    const written = {
      ...entry(
        input.id ?? `mem-${(stored?.entries?.length ?? 0) + 1}`,
        input.status ?? 'active',
        input.title,
        input.body,
      ),
      visibility: input.visibility ?? 'private',
      ...(input.key === undefined ? {} : { key: input.key }),
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      revision: input.id === undefined ? 1 : 2,
    }
    const nextEntries = input.id === undefined
      ? [...(stored?.entries ?? []), written]
      : (stored?.entries ?? []).map(value => value.id === written.id ? written : value)
    stored = memory(nextEntries, currentRevision + 1)
    return { memory: stored, entry: written }
  })

  const service = {
    getAssistantInstance,
    getAssistantMemory,
    writeAssistantMemoryEntry,
  } as unknown as AgentTeamService

  return {
    runtime: new AssistantRuntime(ctx, config, service),
    requests,
    getAssistantInstance,
    getAssistantMemory,
    writeAssistantMemoryEntry,
    stored: () => stored,
  }
}

describe('askAssistantMemory', () => {
  it('answers from the stored entries with exactly one model call and no write', async () => {
    const h = harness({
      stored: memory([entry('m1', 'active', 'Tables', 'Render data as tables.')]),
      reply: '{"kind":"answer","answer":"You prefer tables."}',
    })

    const result = await h.runtime.askAssistantMemory('instance-1', 'How should data look?')

    expect(result).toEqual({ kind: 'answer', answer: 'You prefer tables.' })
    expect(h.writeAssistantMemoryEntry).not.toHaveBeenCalled()
    expect(h.stored()?.revision).toBe(1)
    expect(h.requests).toHaveLength(1)
    const request = h.requests[0]!
    expect(request).toMatchObject({ provider: 'openai', model: 'gpt-5' })
    expect(String(request.reasoningEffort)).toBe('high')
    expect(request.messages).toHaveLength(1)
    expect(JSON.stringify(request.messages)).toContain('Render data as tables.')
    expect(request.system).toContain('"kind":"change"')
  })

  it('writes a change only as proposed, fenced by the memory revision', async () => {
    const h = harness({
      stored: memory([entry('m1', 'active', 'Tables', 'Render data as tables.')], 4),
      reply: JSON.stringify({
        kind: 'change',
        entries: [
          { title: 'Tone', body: 'Keep answers short.' },
          {
            entryId: 'm1',
            key: 'tables',
            visibility: 'team-safe',
            title: 'Tables',
            body: 'Render every dataset as a table.',
          },
        ],
      }),
    })

    const result = await h.runtime.askAssistantMemory('instance-1', 'Remember to be terse.')

    expect(h.requests).toHaveLength(1)
    expect(h.writeAssistantMemoryEntry).toHaveBeenCalledTimes(2)
    expect(h.writeAssistantMemoryEntry.mock.calls[0]?.slice(1)).toEqual([
      { status: 'proposed', title: 'Tone', body: 'Keep answers short.' },
      { expectedRevision: 4 },
    ])
    expect(h.writeAssistantMemoryEntry.mock.calls[1]?.slice(1)).toEqual([
      {
        supersedes: 'm1',
        key: 'tables',
        visibility: 'team-safe',
        status: 'proposed',
        title: 'Tables',
        body: 'Render every dataset as a table.',
      },
      { expectedRevision: 5 },
    ])
    expect(result.kind).toBe('change')
    if (result.kind !== 'change') throw new Error('expected a change')
    expect(result.entries.map(value => value.status)).toEqual(['proposed', 'proposed'])
    // The revised target was never rewritten: it keeps its accepted body and
    // stays active (the only status the prompt injects), and the proposal names
    // it until the user accepts.
    expect(h.stored()?.entries?.[0]).toMatchObject({
      id: 'm1',
      status: 'active',
      body: 'Render data as tables.',
    })
    expect(h.stored()?.entries?.[2]).toMatchObject({ status: 'proposed', supersedes: 'm1' })
  })

  it('keeps a revised target active and prompt-injected while the proposal is pending', async () => {
    const h = harness({
      stored: memory([entry('m1', 'active', 'Tables', 'Render data as tables.')]),
      reply: JSON.stringify({
        kind: 'change',
        entries: [{ entryId: 'm1', title: 'Tables', body: 'Render every dataset as a table.' }],
      }),
    })

    const result = await h.runtime.askAssistantMemory('instance-1', 'Use tables for datasets.')

    expect(result.kind).toBe('change')
    const stored = h.stored()!
    const target = stored.entries?.find(value => value.id === 'm1')
    expect(target).toMatchObject({ status: 'active', body: 'Render data as tables.' })
    const proposal = stored.entries?.find(value => value.id !== 'm1')
    expect(proposal).toMatchObject({
      status: 'proposed',
      supersedes: 'm1',
      body: 'Render every dataset as a table.',
    })
    // Injection is status-based: the accepted body is still what the assistant
    // reads, and the pending proposal stays out until 采纳 applies it.
    const injected = memoryPrompt(stored, 'main')
    expect(injected).toContain('Render data as tables.')
    expect(injected).not.toContain('Render every dataset as a table.')
  })

  it('keeps the proposals that landed when a later write of the same call fails', async () => {
    const h = harness({
      stored: memory([entry('m1', 'active', 'Tables', 'Render data as tables.')]),
      failWriteNumber: 2,
      reply: JSON.stringify({
        kind: 'change',
        entries: [
          { title: 'Tone', body: 'Keep answers short.' },
          { title: 'Tests', body: 'Run the focused test first.' },
        ],
      }),
    })

    await expect(h.runtime.askAssistantMemory('instance-1', 'Remember these.'))
      .rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' })

    // The first proposal was written before the second was rejected, so it is
    // stored and must be visible through a re-read rather than silently lost.
    expect(h.stored()?.entries?.map(value => value.title))
      .toEqual(['Tables', 'Tone'])
    expect(h.stored()?.entries?.[1]).toMatchObject({ status: 'proposed' })
  })

  it('surfaces a revision conflict instead of overwriting a concurrent write', async () => {
    const h = harness({
      reply: '{"kind":"change","entries":[{"title":"Tone","body":"Short."}]}',
      rejectWrite: new AgentTeamError(
        'MEMORY_REVISION_CONFLICT',
        'Assistant memory revision conflict: expected 0, current 2',
      ),
    })

    await expect(h.runtime.askAssistantMemory('instance-1', 'Remember this.'))
      .rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' })
    expect(h.requests).toHaveLength(1)
  })

  it('reports an unusable reply with its reason and writes nothing', async () => {
    const h = harness({ reply: 'Sure, noted!' })

    await expect(h.runtime.askAssistantMemory('instance-1', 'Remember this.'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(h.writeAssistantMemoryEntry).not.toHaveBeenCalled()
  })

  it('reports a model failure with the provider reason', async () => {
    const h = harness({ failure: 'provider overloaded' })

    await expect(h.runtime.askAssistantMemory('instance-1', 'Anything?'))
      .rejects.toThrow(/provider overloaded/)
    expect(h.writeAssistantMemoryEntry).not.toHaveBeenCalled()
  })

  it('refuses an archived instance before spending a model call', async () => {
    const h = harness({ archived: true, reply: '{"kind":"answer","answer":"x"}' })

    await expect(h.runtime.askAssistantMemory('instance-1', 'Anything?'))
      .rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(h.requests).toHaveLength(0)
  })

  it('refuses an over-long request before spending a model call', async () => {
    const h = harness({ reply: '{"kind":"answer","answer":"x"}' })

    await expect(h.runtime.askAssistantMemory('instance-1', 'x'.repeat(2_001)))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(h.requests).toHaveLength(0)
  })
})

describe('service ask-or-change passthrough', () => {
  it('delegates to the attached Assistant runtime', async () => {
    const result = { kind: 'answer', answer: 'Delegated.' } as const
    const ask = vi.fn(async () => result)
    // The method only touches the attached runtime; exercising it on a bare
    // prototype instance proves the service adds no second call path.
    const service = Object.create(AgentTeamService.prototype) as AgentTeamService
    ;(service as unknown as { assistantRuntime: unknown }).assistantRuntime = {
      askAssistantMemory: ask,
    }

    await expect(service.askAssistantMemory('instance-1', 'How do we format tables?'))
      .resolves.toBe(result)
    expect(ask).toHaveBeenCalledWith('instance-1', 'How do we format tables?')
  })

  it('refuses when no Assistant runtime is attached', async () => {
    const service = Object.create(AgentTeamService.prototype) as AgentTeamService

    await expect(service.askAssistantMemory('instance-1', 'Anything?'))
      .rejects.toThrow(/Assistant runtime is not attached/)
  })
})

describe('client ask-or-change surface', () => {
  it('keeps the typed draft and always re-reads after a failure', () => {
    const conflict = Object.assign(new Error('conflict'), { code: 'MEMORY_REVISION_CONFLICT' })
    expect(memoryAskFailure(conflict)).toEqual({
      message: '记忆已被其他操作更新，已重新加载最新版本，请重试。',
      reload: true,
    })

    // A change-path failure is not necessarily a conflict: earlier proposals of
    // the same call may already be stored, so the panel must re-read to show
    // exactly what landed instead of hiding it.
    const unusable = Object.assign(new Error('Memory ask reply was not usable: no JSON object'), {
      code: 'INVALID_REQUEST',
    })
    expect(memoryAskFailure(unusable)).toEqual({
      message: 'Memory ask reply was not usable: no JSON object',
      reload: true,
    })
  })

  it('renders an answer as text and says the memory was not touched', () => {
    const html = text(renderToStaticMarkup(createElement(MemoryAskOutcome, {
      result: { kind: 'answer', answer: 'Render data sets as tables.' },
    })))

    expect(html).toContain('回答')
    expect(html).toContain('Render data sets as tables.')
    expect(html).toContain('未改动记忆')
    expect(html).not.toContain('待确认')
  })

  it('renders the proposed entries a change wrote', () => {
    const html = text(renderToStaticMarkup(createElement(MemoryAskOutcome, {
      result: {
        kind: 'change',
        entries: [
          entry('m1', 'proposed', 'Tables', 'Render data sets as tables.'),
          entry('m2', 'proposed', 'Tone', 'Keep answers short.'),
        ],
      },
    })))

    expect(html).toContain('已提出 2 条待确认条目')
    expect(html).toContain('采纳后生效')
    expect(html).toContain('Tables')
    expect(html).toContain('Keep answers short.')
  })

  it('offers one explicit ask-or-change trigger in the memory panel', () => {
    const markup = renderToStaticMarkup(createElement(AssistantMemorySection, {
      assistantId: 'instance-1',
    }))
    const html = text(markup)

    expect(html).toContain('问 / 改')
    expect(markup).toContain('aria-label="问 / 改记忆"')
    expect(markup).toContain('placeholder="例如：我们一般怎么组织表格？"')
    expect(html).toContain('修改只写成「待确认」条目')
  })
})

// ---------------------------------------------------------------------------
// Service-level proposal semantics. The runtime tests above prove which writes
// the ask path issues; these prove what the one revision-fenced entry write
// does with `supersedes`, which is the half that applies or discards them.
// ---------------------------------------------------------------------------

class ProposalMemoryStore implements AgentTeamStore {
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
    return updateProposalMap(this.assistants, id, update)
  }
  async deleteAssistant(id: string) { return this.assistants.delete(id) }

  getAssistantInstance(id: string) { return this.assistantInstances.get(id) }
  listAssistantInstances() { return [...this.assistantInstances.values()] }
  async putAssistantInstance(value: AssistantInstance) { this.assistantInstances.set(value.id, value) }
  updateAssistantInstance(id: string, update: (current: AssistantInstance) => AssistantInstance) {
    return updateProposalMap(this.assistantInstances, id, update)
  }
  async deleteAssistantInstance(id: string) { return this.assistantInstances.delete(id) }

  getAssistantMemory(assistantId: string) { return this.assistantMemory.get(assistantId) }
  async putAssistantMemory(value: AssistantMemory) { this.assistantMemory.set(value.assistantId, value) }
  updateAssistantMemory(
    assistantId: string,
    update: (current: AssistantMemory) => AssistantMemory,
  ) {
    return updateProposalMap(this.assistantMemory, assistantId, update)
  }

  getAssistantSession(id: string) { return this.assistantSessions.get(id) }
  listAssistantSessions() { return [...this.assistantSessions.values()] }
  async putAssistantSession(value: AssistantSession) { this.assistantSessions.set(value.id, value) }
  updateAssistantSession(id: string, update: (current: AssistantSession) => AssistantSession) {
    return updateProposalMap(this.assistantSessions, id, update)
  }

  getTeam(id: string) { return this.teams.get(id) }
  listTeams() { return [...this.teams.values()] }
  async putTeam(value: TeamAggregate) { this.teams.set(value.id, value) }
  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate) {
    return updateProposalMap(this.teams, id, update)
  }
  async deleteTeam(id: string) { return this.teams.delete(id) }

  listMessages(teamId: string) {
    return [...this.messages.values()].filter(value => value.teamId === teamId)
  }
  async putMessage(value: TeamMessage) { this.messages.set(value.id, value) }
  async deleteMessage(id: string) { return this.messages.delete(id) }

  listActivities(teamId: string) {
    return [...this.activities.values()].filter(value => value.teamId === teamId)
  }
  async putActivity(value: TeamActivity) { this.activities.set(value.id, value) }
  async deleteActivity(id: string) { return this.activities.delete(id) }

  getOperation(id: string) { return this.operations.get(id) }
  listOperations() { return [...this.operations.values()] }
  async putOperation(value: Operation) { this.operations.set(value.id, value) }
  updateOperation(id: string, update: (current: Operation) => Operation) {
    return updateProposalMap(this.operations, id, update)
  }
  async deleteOperation(id: string) { return this.operations.delete(id) }
}

async function updateProposalMap<T>(
  map: Map<string, T>,
  id: string,
  update: (current: T) => T,
): Promise<T> {
  const current = map.get(id)
  if (current === undefined) throw new Error(`Unknown record '${id}'`)
  const next = update(current)
  map.set(id, next)
  return next
}

const ASSISTANT = 'instance-1'
const PROPOSAL_CONFIG: Config = {
  maxRequestBytes: 128 * 1024,
  sseHeartbeatMs: 20_000,
  runtimeConcurrency: 4,
  directMemberChatDefault: true,
  assistantBuilderProvider: '',
  assistantBuilderModel: '',
  assistantBuilderAgentPresetId: '',
  assistantBuilderPermissionPresetId: '',
}

function createProposalService(): AgentTeamService {
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
    listModels: async () => [{ id: 'codex', name: 'Codex' }],
    resolveModelInfo: async (provider: string, model: string) => ({ provider, model }),
  } as never)
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'default', name: 'Default' }],
    resolve: async (id: string) => ({ id, name: id }),
    acquireScope: async () => ({ key: { kind: 'preset-scope' }, [Symbol.asyncDispose]: async () => {} }),
  } as never)
  ctx.provide('tools', { get: () => undefined, schemas: () => [] } as never)
  ctx.provide('skills', { list: async () => [] } as never)
  ctx.provide('permissionPresets', {
    names: ['standard'],
    optionOf: (name: string) => ({ value: name, name }),
    set: () => {},
  } as never)
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('sessions', { flush: async () => {} } as never)
  ctx.provide('sessionPersistence', { list: async () => [] } as never)
  const workspace = {
    id: 'workspace-1',
    path: '/tmp/dsh-memory-ask-proposals',
    title: 'Workspace',
    status: async () => 'ok' as const,
  }
  ctx.provide('workspaceRegistry', {
    get: (id: string) => id === workspace.id ? workspace : undefined,
    list: () => [workspace],
  } as never)
  return new AgentTeamService(ctx as never, PROPOSAL_CONFIG, new ProposalMemoryStore())
}

/** Seed one assistant instance through the service, then a target + proposal. */
async function seedProposal(service: AgentTeamService): Promise<{
  target: MemoryEntry
  proposal: MemoryEntry
  proposalRevision: number
}> {
  const row = instance({ id: ASSISTANT })
  const store = (service as unknown as { store: ProposalMemoryStore }).store
  await store.putAssistantInstance(row)
  const created = await service.writeAssistantMemoryEntry(ASSISTANT, {
    title: 'Tables',
    body: 'Render data as tables.',
  }, { expectedRevision: 0 })
  const proposal = await service.writeAssistantMemoryEntry(ASSISTANT, {
    title: 'Tables',
    body: 'Render every dataset as a table.',
    status: 'proposed',
    supersedes: created.entry.id,
  }, { expectedRevision: created.memory.revision })
  return {
    target: created.entry,
    proposal: proposal.entry,
    proposalRevision: proposal.memory.revision,
  }
}

describe('assistant memory revision proposals (service)', () => {
  it('applies a proposal and supersedes its target in one fenced write', async () => {
    const service = createProposalService()
    const seeded = await seedProposal(service)

    const accepted = await service.writeAssistantMemoryEntry(ASSISTANT, {
      id: seeded.proposal.id,
      title: seeded.proposal.title,
      body: seeded.proposal.body,
      status: 'active',
    }, { expectedRevision: seeded.proposalRevision })

    expect(accepted.memory.revision).toBe(seeded.proposalRevision + 1)
    const entries = accepted.memory.entries ?? []
    expect(entries.find(value => value.id === seeded.target.id)).toMatchObject({
      status: 'superseded',
      body: 'Render data as tables.',
    })
    expect(entries.find(value => value.id === seeded.proposal.id)).toMatchObject({
      status: 'active',
      body: 'Render every dataset as a table.',
      supersedes: seeded.target.id,
    })
    // Only the accepted body is injected now.
    expect(memoryPrompt(accepted.memory, 'main')).toContain('Render every dataset as a table.')
    expect(memoryPrompt(accepted.memory, 'main')).not.toContain('Render data as tables.\n')

    const journal = accepted.memory.journal ?? []
    const last = journal.at(-1)
    const previous = journal.at(-2)
    expect(last).toMatchObject({ action: 'supersede', entryId: seeded.target.id, revision: accepted.memory.revision })
    expect(previous).toMatchObject({ action: 'accept', entryId: seeded.proposal.id, revision: accepted.memory.revision })
  })

  it('leaves the target active when the proposal is ignored', async () => {
    const service = createProposalService()
    const seeded = await seedProposal(service)

    await service.writeAssistantMemoryEntry(ASSISTANT, {
      id: seeded.proposal.id,
      title: seeded.proposal.title,
      body: seeded.proposal.body,
      status: 'archived',
    }, { expectedRevision: seeded.proposalRevision })

    const entries = service.getAssistantMemory(ASSISTANT)?.entries ?? []
    // Ignoring is a decision about the proposal only: the accepted entry keeps
    // its body and stays injected.
    expect(entries.find(value => value.id === seeded.target.id)).toMatchObject({
      status: 'active',
      body: 'Render data as tables.',
    })
    expect(entries.find(value => value.id === seeded.proposal.id)).toMatchObject({
      status: 'archived',
    })
  })

  it('refuses to demote an active entry back to proposed', async () => {
    const service = createProposalService()
    const seeded = await seedProposal(service)
    const current = service.getAssistantMemory(ASSISTANT)!

    await expect(service.writeAssistantMemoryEntry(ASSISTANT, {
      id: seeded.target.id,
      title: seeded.target.title,
      body: 'Rewritten in place.',
      status: 'proposed',
    }, { expectedRevision: current.revision })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    expect(service.getAssistantMemory(ASSISTANT)?.entries?.find(
      value => value.id === seeded.target.id,
    )).toMatchObject({ status: 'active', body: 'Render data as tables.' })
  })

  it('refuses a proposal that names an unknown target', async () => {
    const service = createProposalService()
    const seeded = await seedProposal(service)

    await expect(service.writeAssistantMemoryEntry(ASSISTANT, {
      title: 'Bogus',
      body: 'Names a missing entry.',
      status: 'proposed',
      supersedes: 'missing-entry',
    }, { expectedRevision: seeded.proposalRevision })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(service.getAssistantMemory(ASSISTANT)?.entries).toHaveLength(2)
  })

  it('rejects a stale acceptance instead of applying half of it', async () => {
    const service = createProposalService()
    const seeded = await seedProposal(service)

    await expect(service.writeAssistantMemoryEntry(ASSISTANT, {
      id: seeded.proposal.id,
      title: seeded.proposal.title,
      body: seeded.proposal.body,
      status: 'active',
    }, { expectedRevision: seeded.proposalRevision - 1 })).rejects.toMatchObject({
      code: 'MEMORY_REVISION_CONFLICT',
    })

    const entries = service.getAssistantMemory(ASSISTANT)?.entries ?? []
    expect(entries.find(value => value.id === seeded.target.id)?.status).toBe('active')
    expect(entries.find(value => value.id === seeded.proposal.id)?.status).toBe('proposed')
  })
})
