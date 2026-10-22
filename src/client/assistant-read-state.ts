import type { AssistantInstanceView } from '../transport/contracts.js'

const READ_STATE_KEY = 'dsh-team-mode:assistant-read-at'

type ReadState = Record<string, number>

function readState(): ReadState {
  try {
    const raw = window.localStorage.getItem(READ_STATE_KEY)
    if (raw === null) return {}
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const next: ReadState = {}
    for (const [id, at] of Object.entries(value)) {
      if (typeof at === 'number' && Number.isFinite(at)) next[id] = at
    }
    return next
  } catch {
    return {}
  }
}

/** Read timestamps are presentation state; a restricted WebView just reads empty. */
export function assistantReadState(): ReadState {
  return readState()
}

export function markAssistantRead(id: string, at = Date.now()): ReadState {
  const next = { ...readState(), [id]: at }
  write(next)
  return next
}

export function markAssistantUnread(id: string): ReadState {
  const next = { ...readState(), [id]: 0 }
  write(next)
  return next
}

function write(value: ReadState): void {
  try { window.localStorage.setItem(READ_STATE_KEY, JSON.stringify(value)) } catch { /* storage may be unavailable */ }
}

/** A missing record is read-at-preview: existing rows never start as unread. */
export function isAssistantUnread(instance: AssistantInstanceView, state: ReadState): boolean {
  const preview = instance.preview
  if (preview === undefined || preview.text.trim() === '') return false
  return preview.time > (state[instance.id] ?? preview.time)
}
