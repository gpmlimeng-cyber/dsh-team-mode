import type { Context } from '@deepseek-ai/cordis'
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
  MemoryEntry,
  WriteAssistantMemoryEntryInput,
} from '../src/domain/types.js'
import { AssistantRuntime } from '../src/runtime/assistant-runtime.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'

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
        id: 'm1',
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
    expect(h.stored()?.entries?.every(value => value.status === 'proposed')).toBe(true)
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
  it('keeps the typed draft and reloads only on a revision conflict', () => {
    const conflict = Object.assign(new Error('conflict'), { code: 'MEMORY_REVISION_CONFLICT' })
    expect(memoryAskFailure(conflict)).toEqual({
      message: '记忆已被其他操作更新，已重新加载最新版本，请重试。',
      reload: true,
    })

    const unusable = Object.assign(new Error('Memory ask reply was not usable: no JSON object'), {
      code: 'INVALID_REQUEST',
    })
    expect(memoryAskFailure(unusable)).toEqual({
      message: 'Memory ask reply was not usable: no JSON object',
      reload: false,
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
