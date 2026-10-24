import type { MemoryEntry, MemoryEntryStatus } from './types.js'

/** Recall returns at most this many entries; 20 is the tool default. */
export const MEMORY_RECALL_MAX_LIMIT = 50
export const MEMORY_RECALL_DEFAULT_LIMIT = 20
/**
 * Returned entries share one character budget so a recall can never flood a
 * prompt with the whole archive.
 */
export const MEMORY_RECALL_MAX_CHARS = 8_000

export interface MemoryRecallFilter {
  /** Case-insensitive substring matched against key, title, and body. */
  query?: string
  /** One entry status; absent means every status. */
  status?: MemoryEntryStatus
  /** Maximum entries returned, clamped to 1-50; default 20. */
  limit?: number
}

export interface MemoryRecallResult {
  entries: MemoryEntry[]
  /** Matching entries before the limit and character budget. */
  total: number
  /** True when the limit or the character budget dropped matching entries. */
  truncated: boolean
}

const MEMORY_ENTRY_STATUSES: readonly MemoryEntryStatus[] = [
  'active',
  'proposed',
  'superseded',
  'archived',
]

/**
 * Normalize raw tool arguments into a recall filter. Unknown statuses and
 * non-numeric limits are ignored instead of rejecting the read: recall must
 * stay a pure, non-failing lookup.
 */
export function memoryRecallFilterOf(args: {
  query?: unknown
  status?: unknown
  limit?: unknown
}): MemoryRecallFilter {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  const status = typeof args.status === 'string'
    && (MEMORY_ENTRY_STATUSES as readonly string[]).includes(args.status)
    ? args.status as MemoryEntryStatus
    : undefined
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.min(Math.max(Math.floor(args.limit), 1), MEMORY_RECALL_MAX_LIMIT)
    : undefined
  return {
    ...(query === '' ? {} : { query }),
    ...(status === undefined ? {} : { status }),
    ...(limit === undefined ? {} : { limit }),
  }
}

/**
 * Filter entries by status and a case-insensitive query, oldest first, then
 * bound the result by the requested limit and the shared character budget.
 * Pure: the caller always reads its own scope's entry array.
 */
export function recallMemoryEntries(
  entries: readonly MemoryEntry[],
  filter: MemoryRecallFilter = {},
): MemoryRecallResult {
  const query = filter.query?.trim().toLowerCase()
  const matches = entries
    .filter(entry => filter.status === undefined || entry.status === filter.status)
    .filter(entry => query === undefined || [entry.key, entry.title, entry.body]
      .some(value => value?.toLowerCase().includes(query)))
    .slice()
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  const limit = Math.min(
    Math.max(Math.floor(filter.limit ?? MEMORY_RECALL_DEFAULT_LIMIT), 1),
    MEMORY_RECALL_MAX_LIMIT,
  )
  const selected: MemoryEntry[] = []
  let chars = 0
  for (const entry of matches) {
    if (selected.length >= limit) break
    const size = entry.title.length + entry.body.length
    // The budget is a hard result bound: an oversized first entry is omitted
    // (total still reports it and truncated stays true) rather than flooding
    // the caller with the whole body.
    if (chars + size > MEMORY_RECALL_MAX_CHARS) break
    selected.push(entry)
    chars += size
  }
  return {
    entries: selected,
    total: matches.length,
    truncated: selected.length < matches.length,
  }
}

export interface MemoryTextRedaction {
  text: string
  /** True when a rule changed the text, so the stored copy is not exact. */
  redacted: boolean
}

const REDACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private keys are the longest match and must run before generic tokens.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [REDACTED]'],
  [/\b(password|passwd|secret|token|api[_-]?key)\b(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]'],
]

/**
 * Remove likely credentials from text copied into a journal snapshot. The
 * redactor is conservative and never logs what it matched; callers mark the
 * record `redacted` so undo refuses an inexact copy.
 */
export function redactMemoryText(text: string): MemoryTextRedaction {
  let next = text
  for (const [pattern, replacement] of REDACTION_RULES) {
    next = next.replace(pattern, replacement)
  }
  return { text: next, redacted: next !== text }
}

/**
 * Stable identity of one piece of memory for dedupe: an explicit key wins,
 * otherwise normalized title+body text. Capture uses this to skip entries it
 * has already proposed; nothing here decides acceptance.
 */
export function memoryDedupeKey(input: {
  key?: string | undefined
  title: string
  body: string
}): string {
  const key = input.key?.trim()
  if (key !== undefined && key !== '') return `key:${key}`
  return `text:${normalizeDedupeText(input.title)}|${normalizeDedupeText(input.body)}`
}

function normalizeDedupeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}
