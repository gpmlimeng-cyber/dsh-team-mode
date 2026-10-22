import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assistantReadState,
  isAssistantUnread,
  markAssistantRead,
  markAssistantUnread,
} from '../src/client/assistant-read-state.js'
import type { AssistantInstanceView } from '../src/transport/contracts.js'

function view(previewAt: number): AssistantInstanceView {
  return {
    id: 'assistant-a',
    preview: { role: 'assistant', text: 'latest', time: previewAt },
  } as AssistantInstanceView
}

function installStorage(): { clear: () => void } {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    clear: () => { data.clear() },
  }
  vi.stubGlobal('window', { localStorage: storage })
  return storage
}

describe('assistant read state', () => {
  let storage: { clear: () => void }

  beforeEach(() => {
    storage = installStorage()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('treats a missing record as already read at the preview timestamp', () => {
    expect(isAssistantUnread(view(2_000), assistantReadState())).toBe(false)
  })

  it('marks a newer preview unread and clears it when read', () => {
    const unread = markAssistantUnread('assistant-a')
    expect(isAssistantUnread(view(2_000), unread)).toBe(true)
    const read = markAssistantRead('assistant-a', 3_000)
    expect(isAssistantUnread(view(2_000), read)).toBe(false)
  })

  it('persists across reads and ignores malformed storage', () => {
    markAssistantRead('assistant-a', 5_000)
    expect(assistantReadState()['assistant-a']).toBe(5_000)
    window.localStorage.setItem('dsh-team-mode:assistant-read-at', '{not json')
    expect(assistantReadState()).toEqual({})
    storage.clear()
  })
})
