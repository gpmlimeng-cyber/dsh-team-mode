import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_ASK_MAX_ENTRIES,
  memoryAskPrompt,
  parseMemoryAskReply,
} from '../src/domain/memory.js'
import {
  assistantMemorySchema,
  writeAssistantMemoryEntryInputSchema,
} from '../src/domain/schemas.js'
import type {
  AssistantMemory,
  MemoryEntry,
  WriteAssistantMemoryEntryInput,
} from '../src/domain/types.js'
import { registerAssistantMemoryTools } from '../src/runtime/assistant-tools.js'

const NOW = '2026-10-27T00:00:00.000Z'

function entry(
  id: string,
  status: MemoryEntry['status'],
  title = `Title ${id}`,
  body = `Body ${id}`,
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

interface RecordedTool {
  name: string
  execute: (
    args: Record<string, unknown>,
    exec: { agent: unknown },
  ) => Promise<Record<string, unknown>>
}

function toolContext(): { ctx: Context, tools: Map<string, RecordedTool> } {
  const tools = new Map<string, RecordedTool>()
  const ctx = {
    tools: {
      register: (tool: RecordedTool) => { tools.set(tool.name, tool) },
    },
  } as unknown as Context
  return { ctx, tools }
}

function memoryWith(entries: MemoryEntry[]): AssistantMemory {
  return {
    schemaVersion: 1,
    assistantId: 'instance-1',
    content: '',
    entries,
    revision: 3,
    updatedAt: NOW,
  }
}

describe('assistant memory write status', () => {
  it('accepts proposed, active, and archived writes', () => {
    for (const status of ['active', 'proposed', 'archived'] as const) {
      expect(writeAssistantMemoryEntryInputSchema.parse({
        title: 'Prefers tables',
        body: 'Always render tabular data as tables.',
        status,
      })).toMatchObject({ status })
    }
  })

  it('still refuses a status only the state machine may derive', () => {
    expect(() => writeAssistantMemoryEntryInputSchema.parse({
      title: 'Prefers tables',
      body: 'Always render tabular data as tables.',
      status: 'superseded',
    })).toThrow()
  })

  it('keeps legacy rows and every stored status parseable', () => {
    // A row written before structured memory existed carries neither field.
    expect(assistantMemorySchema.parse({
      schemaVersion: 1,
      assistantId: 'instance-1',
      content: 'Legacy note',
      revision: 1,
      updatedAt: NOW,
    })).toMatchObject({ content: 'Legacy note', revision: 1 })

    const parsed = assistantMemorySchema.parse(memoryWith([
      entry('m1', 'active'),
      entry('m2', 'proposed'),
      entry('m3', 'superseded'),
      entry('m4', 'archived'),
    ]))
    expect(parsed.entries?.map(value => value.status))
      .toEqual(['active', 'proposed', 'superseded', 'archived'])
  })
})

describe('memory ask prompt', () => {
  it('offers live entries with their status and the request last', () => {
    const prompt = memoryAskPrompt([
      entry('m1', 'active', 'Tables', 'Render data as tables.'),
      entry('m2', 'proposed', 'Tone', 'Keep answers short.'),
      entry('m3', 'archived', 'Old', 'Gone from the prompt.'),
      entry('m4', 'superseded', 'Older', 'Replaced already.'),
    ], 'Which tone do you prefer?')

    expect(prompt).toContain('id: m1')
    expect(prompt).toContain('status: active')
    expect(prompt).toContain('id: m2')
    expect(prompt).toContain('status: proposed')
    expect(prompt).toContain('Tables')
    expect(prompt).not.toContain('id: m3')
    expect(prompt).not.toContain('id: m4')
    expect(prompt.endsWith('Which tone do you prefer?')).toBe(true)
  })

  it('says so when nothing is stored yet', () => {
    expect(memoryAskPrompt([], 'What do you remember?')).toContain('(none)')
  })

  it('bounds the entry block instead of flooding the one call', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      entry(`m${index}`, 'active', 'A'.repeat(120), 'B'.repeat(300)))
    const prompt = memoryAskPrompt(many, 'Summarize everything.')

    expect(prompt.length).toBeLessThan(10_000)
    expect(prompt).toContain('more entries are stored but omitted')
  })
})

describe('memory ask reply', () => {
  it('parses an answer', () => {
    expect(parseMemoryAskReply('{"kind":"answer","answer":"Tables."}'))
      .toEqual({ kind: 'answer', answer: 'Tables.' })
  })

  it('parses a fenced change with every optional field', () => {
    const reply = [
      '```json',
      JSON.stringify({
        kind: 'change',
        entries: [
          { title: 'New fact', body: 'Remember this.' },
          {
            entryId: 'm1',
            key: 'tone',
            visibility: 'team-safe',
            title: 'Tone',
            body: 'Keep answers short.',
          },
        ],
      }),
      '```',
    ].join('\n')

    expect(parseMemoryAskReply(reply)).toEqual({
      kind: 'change',
      proposals: [
        { title: 'New fact', body: 'Remember this.' },
        {
          entryId: 'm1',
          key: 'tone',
          visibility: 'team-safe',
          title: 'Tone',
          body: 'Keep answers short.',
        },
      ],
    })
  })

  it('rejects a reply the fixed contract cannot carry', () => {
    const cases = [
      'I think it is fine.',
      '{"kind":"write","entries":[]}',
      '{"kind":"change","entries":[]}',
      '{"kind":"change"}',
      `{"kind":"change","entries":${JSON.stringify(
        Array.from({ length: MEMORY_ASK_MAX_ENTRIES + 1 }, () => ({ title: 't', body: 'b' })),
      )}}`,
      '{"kind":"change","entries":[{"title":"t","body":"b","delete":true}]}',
      '{"kind":"change","entries":[{"title":"t"}]}',
      '{"kind":"answer","answer":"   "}',
    ]
    for (const reply of cases) {
      expect(() => parseMemoryAskReply(reply)).toThrowError(/not usable/)
    }
  })

  it('reports a malformed reply as a typed rejection', () => {
    expect(() => parseMemoryAskReply('{oops}')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }) as Error,
    )
  })
})

describe('assistant memory entry write tool', () => {
  function registered() {
    const { ctx, tools } = toolContext()
    const writeEntry = vi.fn(async (
      input: WriteAssistantMemoryEntryInput,
      expectedRevision: number,
    ) => {
      const memory = memoryWith([entry('m1', 'proposed')])
      return { memory, entry: entry('m1', input.status ?? 'active', input.title, input.body) }
    })
    registerAssistantMemoryTools(ctx, {
      assertIdentity: () => {},
      readMemory: () => undefined,
      writeMemory: async () => memoryWith([]),
      writeEntry,
    })
    return { tools, writeEntry }
  }

  it('forwards a proposed write through the existing entry write path', async () => {
    const { tools, writeEntry } = registered()
    const tool = tools.get('assistant_memory_entry_write')
    expect(tool).toBeDefined()

    await tool!.execute({
      expected_revision: 2,
      title: 'Tone',
      body: 'Keep answers short.',
      status: 'proposed',
    }, { agent: undefined })

    expect(writeEntry).toHaveBeenCalledWith(
      { title: 'Tone', body: 'Keep answers short.', status: 'proposed' },
      2,
    )
  })

  it('keeps the active default and still forwards archived', async () => {
    const { tools, writeEntry } = registered()
    const tool = tools.get('assistant_memory_entry_write')!

    await tool.execute({ expected_revision: 0, title: 'A', body: 'B' }, { agent: undefined })
    await tool.execute(
      { expected_revision: 1, entry_id: 'm1', title: 'A', body: 'B', status: 'archived' },
      { agent: undefined },
    )

    expect(writeEntry.mock.calls[0]?.[0]).toEqual({ title: 'A', body: 'B' })
    expect(writeEntry.mock.calls[1]?.[0]).toEqual({
      id: 'm1',
      title: 'A',
      body: 'B',
      status: 'archived',
    })
  })
})
