import { useSyncExternalStore } from 'react'

/**
 * Sidebar presentation for the “单聊” section. `simple` keeps the DS Bot-style
 * one-row-per-assistant list; `advanced` additionally renders each assistant's
 * task threads inline. The mode is a client-only preference: it changes no
 * request, record, or runtime behavior.
 */
export type AssistantDisplayMode = 'simple' | 'advanced'

export const ASSISTANT_DISPLAY_MODE_KEY = 'dsh-team-mode:assistant-display-mode'
export const ASSISTANT_DISPLAY_MODE_EVENT = 'dsh-team-mode:assistant-display-mode-change'

const DEFAULT_MODE: AssistantDisplayMode = 'simple'

/** Only the literal `advanced` opts in; missing or invalid values are simple. */
export function parseAssistantDisplayMode(value: string | null | undefined): AssistantDisplayMode {
  return value === 'advanced' ? 'advanced' : 'simple'
}

/** Read the persisted mode; restricted storage falls back to `simple`. */
export function readAssistantDisplayMode(): AssistantDisplayMode {
  try {
    return parseAssistantDisplayMode(window.localStorage.getItem(ASSISTANT_DISPLAY_MODE_KEY))
  } catch {
    return DEFAULT_MODE
  }
}

let current: AssistantDisplayMode | undefined
const listeners = new Set<() => void>()

function getSnapshot(): AssistantDisplayMode {
  if (current === undefined) current = readAssistantDisplayMode()
  return current
}

function sync(next: AssistantDisplayMode): void {
  if (current === next) return
  current = next
  for (const listener of listeners) listener()
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== ASSISTANT_DISPLAY_MODE_KEY) return
  sync(readAssistantDisplayMode())
}

function onModeChange(event: Event): void {
  const detail = typeof CustomEvent !== 'undefined' && event instanceof CustomEvent
    ? event.detail
    : undefined
  sync(typeof detail === 'string' ? parseAssistantDisplayMode(detail) : readAssistantDisplayMode())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (typeof window === 'undefined') return () => { listeners.delete(listener) }
  window.addEventListener('storage', onStorage)
  window.addEventListener(ASSISTANT_DISPLAY_MODE_EVENT, onModeChange)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(ASSISTANT_DISPLAY_MODE_EVENT, onModeChange)
  }
}

/**
 * Persist and publish the new mode. The in-memory value changes even when
 * storage is restricted, so the current view still switches immediately; the
 * preference simply cannot survive a reload in that environment.
 */
export function setAssistantDisplayMode(next: AssistantDisplayMode): void {
  const value = parseAssistantDisplayMode(next)
  current = value
  try {
    window.localStorage.setItem(ASSISTANT_DISPLAY_MODE_KEY, value)
  } catch {
    // Restricted WebViews may reject storage; the current session still works.
  }
  for (const listener of listeners) listener()
  // Storage events do not fire in the window that wrote the value, and a
  // second bundle instance would otherwise miss the update, so notify it too.
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(ASSISTANT_DISPLAY_MODE_EVENT, { detail: value }))
    }
  } catch {
    // A missing CustomEvent or a blocked event dispatch never blocks the mode.
  }
}

/** Subscribe to the client-only display mode; storage failures mean `simple`. */
export function useAssistantDisplayMode(): AssistantDisplayMode {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_MODE)
}
