/**
 * Per-assistant inline-thread disclosure state. This is view state only: it
 * never changes which tasks exist or how they run, and it is scoped by the
 * assistant id so expanding one row does not expand the others.
 */
export const ASSISTANT_THREADS_KEY_PREFIX = 'dsh-team-mode:assistant-threads:'

/** Storage key for one assistant's thread disclosure state. */
export function assistantThreadsStorageKey(assistantId: string): string {
  return `${ASSISTANT_THREADS_KEY_PREFIX}${assistantId}`
}

/** Missing or invalid values default to collapsed. */
export function parseAssistantThreadExpanded(value: string | null | undefined): boolean {
  return value === 'true'
}

/** Read one assistant's disclosure state; restricted storage means collapsed. */
export function readAssistantThreadExpanded(assistantId: string): boolean {
  try {
    return parseAssistantThreadExpanded(
      window.localStorage.getItem(assistantThreadsStorageKey(assistantId)),
    )
  } catch {
    return false
  }
}

/** Persist one assistant's disclosure state; failure keeps the current view. */
export function writeAssistantThreadExpanded(assistantId: string, expanded: boolean): void {
  try {
    window.localStorage.setItem(assistantThreadsStorageKey(assistantId), String(expanded))
  } catch {
    // Restricted WebViews may reject storage; the current session still works.
  }
}
