import { describe, expect, it } from 'vitest'
import {
  assistantMemoryView,
  MEMORY_HISTORY_LIMIT,
  memorySourceLabel,
  memoryStatusLabel,
  memoryVisibilityLabel,
  sortMemoryEntries,
  teamMemoryView,
} from '../src/client/labels.js'
import type { AssistantMemory, MemoryEntry, TeamMemory } from '../src/domain/types.js'

const NOW = '2026-01-01T00:00:00.000Z'

function entry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, 'id'>): MemoryEntry {
  return {
    scope: 'team',
    visibility: 'team-safe',
    status: 'active',
    source: 'user',
    title: `Title ${overrides.id}`,
    body: `Body ${overrides.id}`,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('client memory view helpers', () => {
  it('keeps legacy assistant content visible without inventing entries', () => {
    const memory: AssistantMemory = {
      schemaVersion: 1,
      assistantId: 'assistant-1',
      content: 'Legacy note.',
      revision: 3,
      updatedAt: NOW,
    }
    const view = assistantMemoryView(memory)
    expect(view).toMatchObject({
      content: 'Legacy note.',
      revision: 3,
      empty: false,
    })
    expect(view.active).toEqual([])
    expect(view.history).toEqual([])
  })

  it('treats a missing assistant and team memory as an empty panel', () => {
    expect(assistantMemoryView(undefined)).toMatchObject({ revision: 0, content: '', empty: true })
    expect(assistantMemoryView(null)).toMatchObject({ revision: 0, empty: true })
    expect(teamMemoryView(undefined)).toMatchObject({ revision: 0, content: '', empty: true })
  })

  it('splits assistant entries into active, proposed and capped history', () => {
    const entries = [
      entry({ id: 'active', scope: 'assistant', visibility: 'private', status: 'active', updatedAt: '2026-01-03T00:00:00.000Z' }),
      entry({ id: 'proposed', scope: 'assistant', status: 'proposed', updatedAt: '2026-01-02T00:00:00.000Z' }),
      ...Array.from({ length: 25 }, (_, index) =>
        entry({
          id: `history-${index}`,
          scope: 'assistant',
          status: 'archived',
          updatedAt: `2025-12-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        })),
    ]
    const memory: AssistantMemory = {
      schemaVersion: 1,
      assistantId: 'assistant-1',
      content: '',
      entries,
      revision: 7,
      updatedAt: NOW,
    }
    const view = assistantMemoryView(memory)
    expect(view.active.map(item => item.id)).toEqual(['active'])
    expect(view.proposed.map(item => item.id)).toEqual(['proposed'])
    expect(view.history).toHaveLength(MEMORY_HISTORY_LIMIT)
    expect(view.historyTotal).toBe(25)
    expect(view.empty).toBe(false)
  })

  it('never exposes private or assistant-scoped entries in the team view', () => {
    const memory: TeamMemory = {
      revision: 4,
      updatedAt: NOW,
      entries: [
        entry({ id: 'visible', key: 'fact' }),
        entry({ id: 'private', visibility: 'private' }),
        entry({ id: 'assistant-scope', scope: 'assistant', visibility: 'team-safe' }),
        entry({ id: 'proposal', status: 'proposed' }),
        entry({ id: 'history', status: 'archived' }),
      ],
    }
    const view = teamMemoryView(memory)
    const ids = [...view.active, ...view.proposed, ...view.history].map(item => item.id)
    expect(ids).toEqual(['visible', 'proposal', 'history'])
    expect(ids).not.toContain('private')
    expect(ids).not.toContain('assistant-scope')
    expect(view.revision).toBe(4)
  })

  it('sorts newest first with a stable id tie-break', () => {
    const sorted = sortMemoryEntries([
      entry({ id: 'b', updatedAt: NOW }),
      entry({ id: 'a', updatedAt: NOW }),
      entry({ id: 'newer', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ])
    expect(sorted.map(item => item.id)).toEqual(['newer', 'a', 'b'])
  })

  it('labels unknown memory values without throwing', () => {
    expect(memoryVisibilityLabel('private')).toBe('私有')
    expect(memoryVisibilityLabel('team-safe')).toBe('团队可见')
    expect(memoryStatusLabel('proposed')).toBe('待确认')
    expect(memoryStatusLabel('future-status')).toBe('future-status')
    expect(memorySourceLabel('user')).toBe('用户')
    expect(memorySourceLabel('future-source')).toBe('future-source')
  })
})
