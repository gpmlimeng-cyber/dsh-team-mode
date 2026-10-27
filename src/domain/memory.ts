import { z } from 'zod'
import { AgentTeamError } from './errors.js'
import type { MemoryEntry, MemoryEntryStatus, MemoryVisibility } from './types.js'

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

/** One ask-or-change request is bounded so a single call cannot flood a prompt. */
export const MEMORY_ASK_MAX_TEXT_CHARS = 2_000
/** At most this many entries may be proposed by one ask-or-change call. */
export const MEMORY_ASK_MAX_ENTRIES = 5
export const MEMORY_ASK_MAX_TITLE_CHARS = 160
export const MEMORY_ASK_MAX_BODY_CHARS = 2_000
export const MEMORY_ASK_MAX_ANSWER_CHARS = 4_000
/** Character budget the stored entries may occupy in the single prompt. */
export const MEMORY_ASK_PROMPT_CHARS = 8_000
/** Output budget for the one model call. */
export const MEMORY_ASK_MAX_TOKENS = 1_024

const MEMORY_ASK_ENTRY_BODY_CHARS = 400

/**
 * The fixed instruction for the single ask-or-change model call. The reply is a
 * machine contract, not prose: one JSON object decides between answering and
 * proposing a change, and a change may only name fields the existing entry
 * write path accepts.
 */
export const MEMORY_ASK_SYSTEM_PROMPT = [
  'You answer one question about an assistant’s durable memory, or propose one memory change.',
  'Reply with exactly one JSON object and no other text.',
  'Answer: {"kind":"answer","answer":"<text>"}',
  'Change: {"kind":"change","entries":[{"entryId":"<existing id>","key":"<key>","visibility":"private","title":"<short heading>","body":"<stored text>"}]}',
  'In a change, "entryId", "key", and "visibility" are optional; "title" and "body" are required.',
  'Use "answer" for every question, including ones that read from the entries.',
  'Use "change" only when the request asks to remember, correct, or replace something.',
  'Each proposed entry is stored as status "proposed" and takes effect only after the user accepts it, so never claim a write already happened.',
  `Propose at most ${MEMORY_ASK_MAX_ENTRIES} entries, each title at most ${MEMORY_ASK_MAX_TITLE_CHARS} characters and each body at most ${MEMORY_ASK_MAX_BODY_CHARS} characters.`,
  'Include "entryId" only to propose a revision of an entry listed in the prompt.',
  'Never propose deletions: the memory state machine has no delete.',
].join('\n')

/** One entry the model wants written; it never carries a status. */
export interface MemoryChangeProposal {
  /** Existing entry id to revise; absent means a new entry. */
  entryId?: string
  key?: string
  visibility?: MemoryVisibility
  title: string
  body: string
}

/** What the single model call decided. */
export type MemoryAskReply =
  | { kind: 'answer'; answer: string }
  | { kind: 'change'; proposals: MemoryChangeProposal[] }

/**
 * The fixed result of one explicit ask-or-change operation. An answer wrote
 * nothing; a change holds the entries it wrote, all of them `proposed`.
 */
export type MemoryAskResult =
  | { kind: 'answer'; answer: string }
  | { kind: 'change'; entries: MemoryEntry[] }

const memoryAskProposalSchema = z.object({
  entryId: z.string().max(200).optional(),
  key: z.string().max(200).optional(),
  visibility: z.enum(['private', 'team-safe']).optional(),
  title: z.string().max(MEMORY_ASK_MAX_TITLE_CHARS),
  body: z.string().max(MEMORY_ASK_MAX_BODY_CHARS),
}).strict()

const memoryAskReplySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('answer'),
    answer: z.string().max(MEMORY_ASK_MAX_ANSWER_CHARS),
  }).strict(),
  z.object({
    kind: z.literal('change'),
    entries: z.array(memoryAskProposalSchema).min(1).max(MEMORY_ASK_MAX_ENTRIES),
  }).strict(),
])

/**
 * Build the single prompt of one ask-or-change call: the stored entries the
 * call may answer from or revise, then the user's request. Archived and
 * superseded entries are history and stay out; the character budget bounds the
 * whole entry block so one huge entry cannot flood the call.
 */
export function memoryAskPrompt(entries: readonly MemoryEntry[], text: string): string {
  const live = entries
    .filter(entry => entry.status === 'active' || entry.status === 'proposed')
    .slice()
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  const lines = [
    'Stored memory entries:',
  ]
  if (live.length === 0) lines.push('(none)')
  let chars = 0
  let shown = 0
  for (const entry of live) {
    const line = [
      `- id: ${entry.id}`,
      `visibility: ${entry.visibility}`,
      `status: ${entry.status}`,
      `title: ${clipText(entry.title, MEMORY_ASK_MAX_TITLE_CHARS)}`,
      `body: ${clipText(entry.body, MEMORY_ASK_ENTRY_BODY_CHARS)}`,
    ].join(' | ')
    if (chars + line.length > MEMORY_ASK_PROMPT_CHARS) break
    lines.push(line)
    chars += line.length
    shown += 1
  }
  if (shown < live.length) {
    lines.push(`(${live.length - shown} more entries are stored but omitted; do not propose revisions of them.)`)
  }
  lines.push('', 'Request:', text)
  return lines.join('\n')
}

/**
 * Parse the single reply into the fixed ask-or-change contract. Anything the
 * contract cannot represent is rejected with its reason instead of being
 * dropped: a proposal the user never sees is worse than a visible failure.
 */
export function parseMemoryAskReply(reply: string): MemoryAskReply {
  const parsed = memoryAskReplySchema.safeParse(replyJson(reply))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw memoryAskError(issue === undefined
      ? 'the reply does not match the ask-or-change contract'
      : `${issue.path.join('.') || 'reply'}: ${issue.message}`)
  }
  if (parsed.data.kind === 'answer') {
    const answer = parsed.data.answer.trim()
    if (answer === '') throw memoryAskError('the answer is empty')
    return { kind: 'answer', answer }
  }
  return {
    kind: 'change',
    proposals: parsed.data.entries.map(proposal => {
      const title = proposal.title.trim()
      if (title === '') throw memoryAskError('a proposed entry has an empty title')
      return {
        ...(proposal.entryId === undefined || proposal.entryId.trim() === ''
          ? {}
          : { entryId: proposal.entryId.trim() }),
        ...(proposal.key === undefined || proposal.key.trim() === ''
          ? {}
          : { key: proposal.key.trim() }),
        ...(proposal.visibility === undefined ? {} : { visibility: proposal.visibility }),
        title,
        body: proposal.body,
      }
    }),
  }
}

function memoryAskError(reason: string): AgentTeamError {
  return new AgentTeamError(
    'INVALID_REQUEST',
    `Memory ask reply was not usable: ${reason}`,
    { reason },
  )
}

/** Accept a bare JSON object, a fenced block, or prose around one JSON object. */
function replyJson(reply: string): unknown {
  const text = reply.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw memoryAskError('the reply contains no JSON object')
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    throw memoryAskError('the reply is not valid JSON')
  }
}

/** Truncate on a code-point boundary so a surrogate pair is never split. */
function clipText(value: string, limit: number): string {
  const characters = [...value]
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join('')}…`
}
