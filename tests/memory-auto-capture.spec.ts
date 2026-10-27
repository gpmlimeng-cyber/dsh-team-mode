import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import type {
  AssistantInstance,
  AssistantMemory,
  MemoryEntry,
  WriteAssistantMemoryEntryInput,
} from '../src/domain/types.js'
import { AssistantRuntime } from '../src/runtime/assistant-runtime.js'
import type { AgentTeamService } from '../src/service/dsh-team-mode-service.js'

const NOW = '2026-10-27T00:00:00.000Z'
const MAIN_SESSION = 'session-main'

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
    workspacePath: '/tmp/dsh-memory-auto-capture',
    mainSessionId: MAIN_SESSION,
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

function memory(entries: MemoryEntry[], revision = entries.length + 1): AssistantMemory {
  return {
    schemaVersion: 1,
    assistantId: 'instance-1',
    content: '',
    entries,
    revision,
    updatedAt: NOW,
  }
}

function captureReply(
  entries: Array<{ title: string, body: string, key?: string, visibility?: string }>,
): string {
  return JSON.stringify({ entries })
}

function userEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: {
      id: `user-${seq}`,
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  } as unknown as SessionEvent
}

function assistantEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `assistant-${seq}`,
        content: [{ type: 'text', text }],
      },
      stream: [],
    },
  } as unknown as SessionEvent
}

function turnEndEvent(
  seq: number,
  turn: number,
  kind: 'completed' | 'aborted' | 'error' = 'completed',
): SessionEvent {
  return {
    type: 'turn/end',
    seq,
    time: seq,
    data: {
      turn,
      reason: kind === 'error'
        ? { kind, error: { message: 'provider failed', code: 'RATE_LIMIT' } }
        : kind === 'aborted'
          ? { kind, reason: { kind: 'user' } }
          : { kind },
    },
  } as unknown as SessionEvent
}

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

function harness(options: {
  reply?: string
  failure?: string
  stored?: AssistantMemory
  gate?: Promise<void>
  instances?: AssistantInstance[]
} = {}) {
  const requests: GenerateOptions[] = []
  const llm = {
    stream: (request: GenerateOptions): AsyncIterable<StreamChunk> => {
      requests.push(request)
      return (async function* (): AsyncGenerator<StreamChunk, void, void> {
        if (options.gate !== undefined) await options.gate
        if (options.failure !== undefined) {
          yield { type: 'text-delta', index: 0, text: 'partial' }
          yield {
            type: 'finish',
            reason: { kind: 'error', failure: { message: options.failure, code: 'RATE_LIMIT' } },
          }
          return
        }
        yield { type: 'text-delta', index: 0, text: options.reply ?? '{"entries":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const ctx = {
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => { set.delete(listener) }
    },
    llm,
  } as unknown as Context

  let stored = options.stored
  let current = options.instances?.[0] ?? instance()
  let listed = options.instances ?? [current]
  const getAssistantInstance = vi.fn(() => current)
  const listAssistantInstances = vi.fn(() => ({
    items: listed,
    total: listed.length,
  }))
  const getAssistantMemory = vi.fn(() => stored)
  const writeAssistantMemoryEntry = vi.fn(async (
    assistantId: string,
    input: WriteAssistantMemoryEntryInput,
    writeOptions: { expectedRevision?: number } = {},
  ) => {
    const currentRevision = stored?.revision ?? 0
    if (writeOptions.expectedRevision !== undefined
      && writeOptions.expectedRevision !== currentRevision) {
      throw new Error(`revision conflict: expected ${writeOptions.expectedRevision}`)
    }
    const existing = input.id === undefined
      ? undefined
      : (stored?.entries ?? []).find(value => value.id === input.id)
    const written: MemoryEntry = {
      ...entry(
        input.id ?? `mem-${(stored?.entries?.length ?? 0) + 1}`,
        input.status ?? 'active',
        input.title,
        input.body,
      ),
      visibility: input.visibility ?? 'private',
      ...(input.key === undefined ? {} : { key: input.key }),
      revision: existing === undefined ? 1 : existing.revision + 1,
    }
    const nextEntries = existing === undefined
      ? [...(stored?.entries ?? []), written]
      : (stored?.entries ?? []).map(value => value.id === written.id ? written : value)
    stored = memory(nextEntries, currentRevision + 1)
    return { memory: stored, entry: written }
  })

  const service = {
    getAssistantInstance,
    listAssistantInstances,
    getAssistantMemory,
    writeAssistantMemoryEntry,
  } as unknown as AgentTeamService

  const events = [userEvent(1, 'Please remember my tone.'), assistantEvent(2, 'Noted.')]
  const runtime = new AssistantRuntime(ctx, config, service)

  return {
    runtime,
    ctx,
    events,
    requests,
    getAssistantInstance,
    listAssistantInstances,
    getAssistantMemory,
    writeAssistantMemoryEntry,
    stored: () => stored,
    setInstances(instances: AssistantInstance[]): void {
      current = instances[0] ?? current
      listed = instances
    },
    /** Emit one turn end exactly as the Session service would. */
    endTurn(input: {
      sessionId?: string
      turn?: number
      kind?: 'completed' | 'aborted' | 'error'
      seq?: number
    } = {}): void {
      const sessionId = input.sessionId ?? MAIN_SESSION
      const seq = input.seq ?? 3
      const event = turnEndEvent(seq, input.turn ?? 1, input.kind ?? 'completed')
      this.events.push(event)
      const session = {
        id: sessionId,
        snapshotEvents: () => this.events,
      }
      for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    },
  }
}

describe('memory auto-capture', () => {
  it('is off by default and writes nothing', async () => {
    const h = harness({ reply: captureReply([{ title: 'Tone', body: 'Keep answers short.' }]) })

    expect(h.runtime.getMemoryAutoCapture('instance-1')).toBe(false)
    h.endTurn()
    await settle()

    expect(h.requests).toHaveLength(0)
    expect(h.writeAssistantMemoryEntry).not.toHaveBeenCalled()
  })

  it('captures one completed turn as proposed entries through the M3 write path', async () => {
    const h = harness({
      reply: captureReply([
        { title: 'Tone', body: 'Keep answers short.' },
        { title: 'Tables', body: 'Render data as tables.', visibility: 'team-safe' },
      ]),
    })

    expect(h.runtime.setMemoryAutoCapture('instance-1', true)).toBe(true)
    expect(h.runtime.getMemoryAutoCapture('instance-1')).toBe(true)
    h.endTurn()
    await settle()

    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({ provider: 'openai', model: 'gpt-5' })
    expect(JSON.stringify(h.requests[0]?.messages)).toContain('Please remember my tone.')
    expect(h.writeAssistantMemoryEntry).toHaveBeenCalledTimes(2)
    for (const call of h.writeAssistantMemoryEntry.mock.calls) {
      expect(call[1]).toMatchObject({ status: 'proposed' })
    }
    expect(h.stored()?.entries?.map(value => value.status)).toEqual(['proposed', 'proposed'])
    expect(h.stored()?.entries?.[1]?.visibility).toBe('team-safe')
  })

  it('runs at most once per completed turn and again for the next turn', async () => {
    const h = harness({ reply: captureReply([{ title: 'Tone', body: 'Keep answers short.' }]) })
    h.runtime.setMemoryAutoCapture('instance-1', true)

    h.endTurn({ turn: 1 })
    await settle()
    h.endTurn({ turn: 1, seq: 4 })
    await settle()
    expect(h.requests).toHaveLength(1)
    expect(h.writeAssistantMemoryEntry).toHaveBeenCalledTimes(1)

    h.endTurn({ turn: 2, seq: 5 })
    await settle()
    expect(h.requests).toHaveLength(2)
  })

  it('ignores aborted and failed turns', async () => {
    const h = harness({ reply: captureReply([{ title: 'Tone', body: 'Keep answers short.' }]) })
    h.runtime.setMemoryAutoCapture('instance-1', true)

    h.endTurn({ turn: 1, kind: 'aborted' })
    h.endTurn({ turn: 2, kind: 'error' })
    await settle()

    expect(h.requests).toHaveLength(0)
    expect(h.writeAssistantMemoryEntry).not.toHaveBeenCalled()
  })

  it('never captures a Session that is not an Assistant conversation', async () => {
    const h = harness({ reply: captureReply([{ title: 'Tone', body: 'Keep answers short.' }]) })
    h.runtime.setMemoryAutoCapture('instance-1', true)

    h.endTurn({ sessionId: 'session-team-member' })
    await settle()

    expect(h.requests).toHaveLength(0)
  })

  it('caps one run at three entries and drops prefix/containment duplicates', async () => {
    const h = harness({
      stored: memory([entry('m1', 'active', 'Prefers tables', 'Render data as tables')]),
      reply: captureReply([
        // Same text as the stored entry.
        { title: 'Prefers tables', body: 'Render data as tables' },
        // The stored text is a prefix of this one.
        { title: 'Prefers tables', body: 'Render data as tables always' },
        { title: 'Tone', body: 'Keep answers short.' },
        { title: 'Tests', body: 'Run the focused test first.' },
        { title: 'Paths', body: 'Use POSIX paths in reports.' },
        { title: 'Late', body: 'This fourth new entry is over the cap.' },
      ]),
    })
    h.runtime.setMemoryAutoCapture('instance-1', true)

    h.endTurn()
    await settle()

    expect(h.requests).toHaveLength(1)
    expect(h.writeAssistantMemoryEntry).toHaveBeenCalledTimes(3)
    expect(h.writeAssistantMemoryEntry.mock.calls.map(call => call[1].title))
      .toEqual(['Tone', 'Tests', 'Paths'])
    expect(h.writeAssistantMemoryEntry.mock.calls.every(call => call[1].status === 'proposed'))
      .toBe(true)
  })

  it('dedupes proposals against each other inside one reply', async () => {
    const h = harness({
      reply: captureReply([
        { title: 'Tone', body: 'Keep answers short.' },
        { title: 'Tone', body: 'Keep answers short.' },
      ]),
    })
    h.runtime.setMemoryAutoCapture('instance-1', true)

    h.endTurn()
    await settle()

    expect(h.writeAssistantMemoryEntry).toHaveBeenCalledTimes(1)
  })

  it('ignoring proposals archives them so they are never proposed again', async () => {
    const h = harness({
      stored: memory([entry('m1', 'active', 'Tables', 'Render data as tables.')]),
      reply: captureReply([{ title: 'Tone', body: 'Keep answers short.' }]),
    })
    h.runtime.setMemoryAutoCapture('instance-1', true)

    h.endTurn({ turn: 1 })
    await settle()
    expect(h.stored()?.entries?.map(value => value.status)).toEqual(['active', 'proposed'])

    const ignored = await h.runtime.ignoreMemoryProposals('instance-1')
    expect(ignored.map(value => value.status)).toEqual(['archived'])
    expect(h.stored()?.entries?.map(value => value.status)).toEqual(['active', 'archived'])

    h.endTurn({ turn: 2, seq: 5 })
    await settle()

    // A second model call happened, but the proposal is gone: archived entries
    // count as already handled.
    expect(h.requests).toHaveLength(2)
    expect(h.writeAssistantMemoryEntry).toHaveBeenCalledTimes(2)
  })

  it('ignores only the named proposals', async () => {
    const h = harness({
      stored: memory([
        entry('m1', 'proposed', 'Tone', 'Keep answers short.'),
        entry('m2', 'proposed', 'Tables', 'Render data as tables.'),
        entry('m3', 'active', 'Tests', 'Run the focused test first.'),
      ]),
    })

    const ignored = await h.runtime.ignoreMemoryProposals('instance-1', ['m2'])

    expect(ignored.map(value => value.id)).toEqual(['m2'])
    expect(h.stored()?.entries?.find(value => value.id === 'm2')?.status).toBe('archived')
    expect(h.stored()?.entries?.find(value => value.id === 'm1')?.status).toBe('proposed')
  })

  it('stops the next turn immediately after being disabled', async () => {
    const h = harness({ reply: captureReply([{ title: 'Tone', body: 'Keep answers short.' }]) })
    h.runtime.setMemoryAutoCapture('instance-1', true)
    h.endTurn({ turn: 1 })
    await settle()
    expect(h.requests).toHaveLength(1)

    expect(h.runtime.setMemoryAutoCapture('instance-1', false)).toBe(false)
    h.endTurn({ turn: 2, seq: 5 })
    await settle()

    expect(h.requests).toHaveLength(1)
  })

  it('drops an in-flight run when the switch is turned off before its write', async () => {
    const gate = deferred()
    const h = harness({
      reply: captureReply([{ title: 'Tone', body: 'Keep answers short.' }]),
      gate: gate.promise,
    })
    h.runtime.setMemoryAutoCapture('instance-1', true)

    h.endTurn()
    await settle()
    expect(h.requests).toHaveLength(1)

    h.runtime.setMemoryAutoCapture('instance-1', false)
    gate.resolve()
    await settle()

    expect(h.writeAssistantMemoryEntry).not.toHaveBeenCalled()
  })

  it('leaves memory untouched and logs when the reply is unusable', async () => {
    const h = harness({ reply: 'Sure, I noted that.' })
    h.runtime.setMemoryAutoCapture('instance-1', true)

    h.endTurn()
    await settle()

    expect(h.writeAssistantMemoryEntry).not.toHaveBeenCalled()
    expect(h.ctx.logger.warn).toHaveBeenCalled()
  })

  it('leaves memory untouched and logs when the model call fails', async () => {
    const h = harness({ failure: 'provider overloaded' })
    h.runtime.setMemoryAutoCapture('instance-1', true)

    h.endTurn()
    await settle()

    expect(h.writeAssistantMemoryEntry).not.toHaveBeenCalled()
    expect(h.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory auto-capture failed'),
      expect.objectContaining({ message: expect.stringContaining('provider overloaded') }),
    )
  })

  it('skips capture for an archived assistant', async () => {
    const h = harness({
      reply: captureReply([{ title: 'Tone', body: 'Keep answers short.' }]),
      instances: [instance({ status: 'archived' })],
    })
    h.runtime.setMemoryAutoCapture('instance-1', true)

    h.endTurn()
    await settle()

    expect(h.requests).toHaveLength(0)
  })
})
