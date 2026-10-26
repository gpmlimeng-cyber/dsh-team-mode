import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AssistantMemory, MemoryEntry } from '../src/domain/types.js'

// The primitives package needs browser peers this node test does not install.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (): unknown => createElement('div')
  return { Button: Stub, Modal: Stub }
})

const { memoryAfterUndo } = await import('../src/client/assistant-settings-dialog.js')

const NOW = '2026-10-23T00:00:00.000Z'

function entry(): MemoryEntry {
  return {
    id: 'mem-1',
    scope: 'assistant',
    visibility: 'private',
    status: 'active',
    source: 'assistant',
    title: 'Tone',
    body: 'Be terse.',
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

describe('assistant settings memory panel', () => {
  it('stores the undo envelope’s memory document instead of the envelope', () => {
    const memory: AssistantMemory = {
      schemaVersion: 1,
      assistantId: 'instance-1',
      content: 'Restored note.',
      entries: [entry()],
      revision: 4,
      updatedAt: NOW,
    }

    // The panel's undo path uses this helper; the wire value is the same
    // `{ memory, entry }` shape as assistant.memory.entry.write.
    const next = memoryAfterUndo({ memory, entry: entry() })
    expect(next).toBe(memory)
    expect(next.content).toBe('Restored note.')
    expect(next.revision).toBe(4)
    expect(next.entries?.[0]?.body).toBe('Be terse.')
  })
})

describe('assistant settings coordinator marker', () => {
  const source = readFileSync(
    new URL('../src/client/assistant-settings-dialog.tsx', import.meta.url),
    'utf8',
  )

  it('shows 总协调 for every assistant, so 否 does not read as "unsupported"', () => {
    expect(source).toContain('>总协调<')
    expect(source).toContain("isCoordinatorInstance(assistant) ? '是' : '否'")
    expect(source).toContain('data-dsh-assistant-settings-coordinator')
  })
})
