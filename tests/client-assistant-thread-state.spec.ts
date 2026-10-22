import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_THREADS_KEY_PREFIX,
  assistantThreadsStorageKey,
  parseAssistantThreadExpanded,
  readAssistantThreadExpanded,
  writeAssistantThreadExpanded,
} from '../src/client/assistant-thread-state.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('assistantThreadsStorageKey', () => {
  it('scopes the persisted state by assistant id', () => {
    expect(ASSISTANT_THREADS_KEY_PREFIX).toBe('dsh-team-mode:assistant-threads:')
    expect(assistantThreadsStorageKey('assistant-1'))
      .toBe('dsh-team-mode:assistant-threads:assistant-1')
  })
})

describe('parseAssistantThreadExpanded', () => {
  it('treats only the exact true value as expanded', () => {
    expect(parseAssistantThreadExpanded('true')).toBe(true)
    expect(parseAssistantThreadExpanded('false')).toBe(false)
    expect(parseAssistantThreadExpanded('TRUE')).toBe(false)
    expect(parseAssistantThreadExpanded('1')).toBe(false)
    expect(parseAssistantThreadExpanded(null)).toBe(false)
    expect(parseAssistantThreadExpanded(undefined)).toBe(false)
  })
})

describe('assistant thread storage', () => {
  it('reads the persisted value for one assistant', () => {
    const getItem = vi.fn(() => 'true')
    vi.stubGlobal('window', { localStorage: { getItem } })
    expect(readAssistantThreadExpanded('assistant-1')).toBe(true)
    expect(getItem).toHaveBeenCalledWith('dsh-team-mode:assistant-threads:assistant-1')
  })

  it('defaults to collapsed when storage is missing or restricted', () => {
    expect(readAssistantThreadExpanded('assistant-1')).toBe(false)
    vi.stubGlobal('window', {
      localStorage: { getItem: () => { throw new Error('storage denied') } },
    })
    expect(readAssistantThreadExpanded('assistant-1')).toBe(false)
  })

  it('writes the state without throwing when storage rejects it', () => {
    const setItem = vi.fn()
    vi.stubGlobal('window', { localStorage: { setItem } })
    writeAssistantThreadExpanded('assistant-1', true)
    expect(setItem).toHaveBeenCalledWith('dsh-team-mode:assistant-threads:assistant-1', 'true')

    vi.stubGlobal('window', {
      localStorage: { setItem: () => { throw new Error('storage denied') } },
    })
    expect(() => { writeAssistantThreadExpanded('assistant-1', false) }).not.toThrow()
  })
})
