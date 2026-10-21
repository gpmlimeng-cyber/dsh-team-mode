import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_DISPLAY_MODE_KEY,
  parseAssistantDisplayMode,
  readAssistantDisplayMode,
} from '../src/client/assistant-display-mode.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseAssistantDisplayMode', () => {
  it('defaults missing and basic values to simple', () => {
    expect(parseAssistantDisplayMode(undefined)).toBe('simple')
    expect(parseAssistantDisplayMode(null)).toBe('simple')
    expect(parseAssistantDisplayMode('')).toBe('simple')
    expect(parseAssistantDisplayMode('simple')).toBe('simple')
  })

  it('accepts only the exact advanced literal', () => {
    expect(parseAssistantDisplayMode('advanced')).toBe('advanced')
    expect(parseAssistantDisplayMode('ADVANCED')).toBe('simple')
    expect(parseAssistantDisplayMode(' advanced ')).toBe('simple')
    expect(parseAssistantDisplayMode('true')).toBe('simple')
  })
})

describe('assistant display mode storage', () => {
  it('uses the documented storage key', () => {
    expect(ASSISTANT_DISPLAY_MODE_KEY).toBe('dsh-team-mode:assistant-display-mode')
  })

  it('reads the persisted advanced mode', () => {
    const getItem = vi.fn(() => 'advanced')
    vi.stubGlobal('window', { localStorage: { getItem } })
    expect(readAssistantDisplayMode()).toBe('advanced')
    expect(getItem).toHaveBeenCalledWith(ASSISTANT_DISPLAY_MODE_KEY)
  })

  it('falls back to simple when storage is missing, invalid, or restricted', () => {
    expect(readAssistantDisplayMode()).toBe('simple')
    vi.stubGlobal('window', { localStorage: { getItem: () => 'unexpected' } })
    expect(readAssistantDisplayMode()).toBe('simple')
    vi.stubGlobal('window', {
      localStorage: { getItem: () => { throw new Error('storage denied') } },
    })
    expect(readAssistantDisplayMode()).toBe('simple')
  })
})
