/**
 * First-response benchmark for team mode — measurement only, no product code.
 *
 * Run: `npx vitest run --config scripts/vitest.measure.config.ts`
 *
 * The benchmark answers one question the plan's P0 asks: for a prompt the user
 * types into an **already-built** team, how many mandatory round-trips sit
 * between the send and the first user-visible output, and where does the time
 * go. It has four parts:
 *
 *   1 SEAMS    pinned source facts the numbers depend on (fails loudly if moved),
 *              plus the strings the P1 fast path removed (they must stay gone)
 *   2 PROMPTS  the fixed 12-prompt benchmark definition (4/4/4)
 *   3 ANALYZER one leader turn log -> timestamps + round-trip counts, with a
 *              synthetic fixture that proves the extraction before real data
 *   4 SAMPLES  the same analyzer over this machine's recorded runs (read-only)
 *
 * Part 4 needs real recorded runs to say anything. When there are none it says
 * so instead of printing a number that came from a different machine.
 *
 * Repinned 2026-10-28 after the P1 fast path (`src/runtime/team-prompts.ts`,
 * commit 7aee654): the forced first-turn roster call and approval are gone, so
 * the seam ledger now pins the fast-path rules and asserts the old gate strings
 * are absent everywhere they used to live.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { projectConversation } from '../src/runtime/conversation-projector.js'
import { TeamTurnCoordinator } from '../src/runtime/team-turn-coordinator.js'
import { memberPrompt, rosterPrompt } from '../src/runtime/team-prompts.js'
import type { TeamAggregate, TeamMemberSlot, TeamMessage } from '../src/domain/types.js'

const repoRoot = join(import.meta.dirname, '..')
const SRC = (path: string): string => readFileSync(join(repoRoot, path), 'utf8')

/** The client's change coalescing window (`src/client/components.tsx`). */
const CLIENT_RELOAD_DEBOUNCE_MS = 120
/** The server's per-session conversation publish coalescing (`team-runtime.ts`). */
const CONVERSATION_PUBLISH_MS = 48

/** Where the plugin and the harness keep their durable state. */
const TEAM_STORE = process.env.DSH_TEAM_STORE ?? join(homedir(), '.dsh', 'storages', 'dsh_team_mode.json')
const SESSIONS_ROOT = process.env.DSH_SESSIONS_DIR ?? join(homedir(), '.dsh', 'sessions')

// ── 1. Seams ────────────────────────────────────────────────────────────────
/**
 * Every number in the baseline is derived through one of these seams. Pinning
 * them keeps the benchmark reproducible: when a constant or the forcing rule
 * moves, the run fails here instead of reporting a stale comparison.
 */
const SEAMS: ReadonlyArray<{ id: string; file: string; pattern: RegExp; what: string }> = [
  {
    id: 'fast-path-at-once',
    file: 'src/runtime/team-prompts.ts',
    pattern: /A team that already has members starts the requested work at once: state the mode in one line, then act\./,
    what: 'LEADER_RULES starts the work at once on a built team (P1 fast path)',
  },
  {
    id: 'approval-only-user-decisions',
    file: 'src/runtime/team-prompts.ts',
    pattern: /Ask for approval only for decisions the user owns: creating a new team, adding members, or accepting a scope\/risk trade-off\./,
    what: 'approval is scoped to decisions the user owns, not to every first turn',
  },
  {
    id: 'roster-ask-only-on-request',
    file: 'src/runtime/team-prompts.ts',
    pattern: /If the user asks for a roster\/plan, the Leader proposes it\. Adding members needs the user.s approval; assigning work to the existing roster does not\./,
    what: 'rosterPrompt offers a plan only when asked; assigning to the existing roster needs no approval',
  },
  {
    id: 'members-tool-not-forced',
    file: 'src/runtime/team-tools.ts',
    pattern: /The roster is already in the Leader prompt every turn, so call this only when it may be stale\./,
    what: 'team_members no longer asks to be called before planning or delegating',
  },
  {
    id: 'roster-already-in-prompt',
    file: 'src/runtime/team-runtime.ts',
    pattern: /name: rosterSection,[\s\S]{0,240}?order: 11,[\s\S]{0,240}?text: \(\) => rosterPrompt\(/,
    what: 'the roster is a live system-prompt section on every turn, so team_members re-fetches it',
  },
  {
    id: 'conversation-publish-window',
    file: 'src/runtime/team-runtime.ts',
    pattern: /const timer = setTimeout\(\(\) => \{[\s\S]{0,400}?\}, 48\)/,
    what: 'server-side conversation publish coalescing (applied in front of every visible output)',
  },
  {
    id: 'client-reload-window',
    file: 'src/client/components.tsx',
    pattern: /TEAM_RELOAD_DEBOUNCE_MS = 120/,
    what: 'client-side change coalescing before the reload that paints the new node',
  },
]

/**
 * The other half of the ledger: the strings the P1 fast path deleted. Pinning
 * their absence means a regression that puts the forced roster approval back
 * fails this run instead of quietly changing what the benchmark measures.
 */
const REMOVED: ReadonlyArray<{ id: string; file: string; text: string; what: string }> = [
  {
    id: 'gate-first-turn-members',
    file: 'src/runtime/team-prompts.ts',
    text: 'First turn: call team_members to inspect the current roster',
    what: 'forced team_members call before any work',
  },
  {
    id: 'gate-roster-approval',
    file: 'src/runtime/team-prompts.ts',
    text: 'Wait for the user to approve before spawning or assigning work',
    what: 'forced human approval before any work',
  },
  {
    id: 'gate-next-turn-approval',
    file: 'src/runtime/team-prompts.ts',
    text: 'Next turn, after the user approves',
    what: 'the second-turn half of the same gate',
  },
  {
    id: 'gate-roster-tail',
    file: 'src/runtime/team-prompts.ts',
    text: 'If the user asks for a roster/plan, the Leader proposes it first; only spawn or assign after approval.',
    what: 'the rosterPrompt copy of the same gate',
  },
  {
    id: 'gate-tool-description',
    file: 'src/runtime/team-tools.ts',
    text: 'Call this before planning or delegating.',
    what: 'the team_members description copy of the same gate',
  },
]

/** The floor a zero-latency model would still pay before the first node paints. */
const VISIBLE_FLOOR_MS = CONVERSATION_PUBLISH_MS + CLIENT_RELOAD_DEBOUNCE_MS

// ── 2. The 12-prompt benchmark ──────────────────────────────────────────────
/**
 * Fixed prompts against a **pre-built** team (1 leader + 2 members already
 * built, no spawn needed). `expect` is what a responsive team should produce
 * under the *current* prompt, so a run can be scored automatically:
 * `goals`/`tasks` are board artifacts, `rosterApprovals` is the roster-approval
 * round-trip P1 removed (0 everywhere now), `firstTurnToolCalls` is the leader's
 * tool round-trips before the user sees anything.
 */
interface BenchmarkPrompt {
  id: string
  kind: 'direct' | 'single' | 'multi'
  lang: 'zh' | 'en'
  prompt: string
  expect: {
    goals: number
    tasks: number
    /** Human approvals the *target* design needs; 0 once P1 lands. */
    rosterApprovals: 0 | 1
    /** Leader tool calls the target design needs before the first visible output. */
    firstTurnToolCalls: number
  }
}

const PROMPTS: readonly BenchmarkPrompt[] = [
  // ── direct: one question, no deliverable ────────────────────────────────
  {
    id: 'D1',
    kind: 'direct',
    lang: 'zh',
    prompt: '这个团队现在有几个人？一句话回答。',
    expect: { goals: 0, tasks: 0, rosterApprovals: 0, firstTurnToolCalls: 0 },
  },
  {
    id: 'D2',
    kind: 'direct',
    lang: 'zh',
    prompt: '这个仓库跑测试用哪个命令？只要一行。',
    expect: { goals: 0, tasks: 0, rosterApprovals: 0, firstTurnToolCalls: 0 },
  },
  {
    id: 'D3',
    kind: 'direct',
    lang: 'zh',
    prompt: '我们上次为什么决定不做并行分派？一句话。',
    expect: { goals: 0, tasks: 0, rosterApprovals: 0, firstTurnToolCalls: 0 },
  },
  {
    id: 'D4',
    kind: 'direct',
    lang: 'en',
    prompt: 'Translate to English, one line: 先测量，再优化。',
    expect: { goals: 0, tasks: 0, rosterApprovals: 0, firstTurnToolCalls: 0 },
  },
  // ── single: one owner, one verifiable deliverable ───────────────────────
  {
    id: 'S1',
    kind: 'single',
    lang: 'zh',
    prompt: '在 README 的“Build, Test, and Development Commands”里补一行 npm run guard:architecture 的说明。',
    expect: { goals: 1, tasks: 1, rosterApprovals: 0, firstTurnToolCalls: 1 },
  },
  {
    id: 'S2',
    kind: 'single',
    lang: 'zh',
    prompt: '给 tests/team-prompts.spec.ts 加一个断言：leader 的 prompt 里包含 roster。',
    expect: { goals: 1, tasks: 1, rosterApprovals: 0, firstTurnToolCalls: 1 },
  },
  {
    id: 'S3',
    kind: 'single',
    lang: 'zh',
    prompt: '把 docs/troubleshooting.md 里那条过期命令改掉，只改那一处。',
    expect: { goals: 1, tasks: 1, rosterApprovals: 0, firstTurnToolCalls: 1 },
  },
  {
    id: 'S4',
    kind: 'single',
    lang: 'en',
    prompt: 'Run npm run typecheck once and tell me the result. No code changes.',
    expect: { goals: 1, tasks: 1, rosterApprovals: 0, firstTurnToolCalls: 1 },
  },
  // ── multi: 2+ parallel workstreams or a required independent review ─────
  {
    id: 'M1',
    kind: 'multi',
    lang: 'zh',
    prompt: '两个成员并行：一个改 leader 首轮规则，一个补对应测试，然后互相复核。',
    expect: { goals: 1, tasks: 2, rosterApprovals: 0, firstTurnToolCalls: 3 },
  },
  {
    id: 'M2',
    kind: 'multi',
    lang: 'zh',
    prompt: '一个成员审计 src/runtime 各提示词段的体积占比并出报告，另一个成员独立复核这份报告。',
    expect: { goals: 1, tasks: 2, rosterApprovals: 0, firstTurnToolCalls: 3 },
  },
  {
    id: 'M3',
    kind: 'multi',
    lang: 'zh',
    prompt: '一个成员实现真实状态行，一个成员写回归测试，第三个成员做独立验收。',
    expect: { goals: 1, tasks: 3, rosterApprovals: 0, firstTurnToolCalls: 4 },
  },
  {
    id: 'M4',
    kind: 'multi',
    lang: 'en',
    prompt: 'In parallel: one member investigates the 70s silence after dispatch, one audits the client coalescing window, then summarize both.',
    expect: { goals: 1, tasks: 2, rosterApprovals: 0, firstTurnToolCalls: 3 },
  },
]

// ── 3. Analyzer ─────────────────────────────────────────────────────────────
/**
 * One leader turn, measured from the log the harness itself writes. Every time
 * is unix epoch ms, so a sample is comparable across machines.
 *
 * `steps` is the model-request count: a turn that calls a tool and continues
 * costs one extra step per tool round-trip, so `toolRoundTrips = steps - 1`
 * when the turn ends on an answer.
 */
interface TurnSample {
  messageId: string
  mode: 'direct' | 'single' | 'multi' | 'unknown'
  sentAt: number
  /** First stream chunk of the turn (TTFT), relative to `sentAt`. */
  ttftMs?: number
  /** First projected node after the user message (what the user actually sees). */
  firstVisibleMs?: number
  firstToolCallMs?: number
  toolCalls: string[]
  toolRoundTrips: number
  steps: number
  approvals: number
  turnEndMs?: number
  /** Next user message minus this turn's end: the human approval round-trip. */
  humanGapMs?: number
  goals: number
  tasks: number
  /** Why the sample is unusable, when it is. */
  skipped?: string
}

function indexBySeq(events: readonly SessionEvent[]): readonly SessionEvent[] {
  return [...events].sort((left, right) => left.seq - right.seq)
}

/** All events of the turn that contains `messageId`, plus the user event. */
function turnOfMessage(
  events: readonly SessionEvent[],
  messageId: string,
): { userEvent: SessionEvent; turn: number; events: SessionEvent[] } | undefined {
  const userEvent = events.find(event =>
    event.type === 'user/message'
    && String((event.data as { id?: unknown }).id) === messageId)
  if (userEvent === undefined) return undefined
  let turn: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.seq > userEvent.seq) continue
    if (event.type === 'turn/start') {
      turn = (event.data as { turn: number }).turn
      break
    }
  }
  if (turn === undefined) return undefined
  const scoped = events.filter((event) => {
    const data = event.data as { turn?: number }
    return data.turn === turn && event.seq >= userEvent.seq
  })
  return { userEvent, turn, events: scoped }
}

/** First assistant text/reasoning chunk time of a step's attempt record. */
function firstChunkTime(event: SessionEvent): number | undefined {
  const stream = (event.data as { stream?: ReadonlyArray<Record<string, unknown>> }).stream ?? []
  let earliest: number | undefined
  for (const record of stream) {
    const time = typeof record.time0 === 'number'
      ? record.time0
      : typeof record.time === 'number'
        ? record.time
        : undefined
    if (time === undefined) continue
    earliest = earliest === undefined ? time : Math.min(earliest, time)
  }
  return earliest
}

function analyzeMessage(
  events: readonly SessionEvent[],
  messageId: string,
): TurnSample | undefined {
  const scoped = turnOfMessage(events, messageId)
  if (scoped === undefined) return undefined
  const sentAt = scoped.userEvent.time
  const sample: TurnSample = {
    messageId,
    mode: 'unknown',
    sentAt,
    toolCalls: [],
    toolRoundTrips: 0,
    steps: 0,
    approvals: 0,
    goals: 0,
    tasks: 0,
  }

  for (const event of scoped.events) {
    if (event.type === 'step/start') sample.steps += 1
    if (event.type === 'tool/call') {
      const name = (event.data as { name: string }).name
      sample.toolCalls.push(name)
      sample.firstToolCallMs ??= event.time - sentAt
    }
    if (event.type === 'approval/asked') sample.approvals += 1
    if (event.type === 'assistant/attempt') {
      const time = firstChunkTime(event)
      if (time !== undefined) sample.ttftMs ??= time - sentAt
    }
    if (event.type === 'turn/end') sample.turnEndMs = event.time - sentAt
  }

  // The projected conversation is the same function the UI renders, so its
  // first non-user node is exactly the first thing the user can see.
  const projection = projectConversation(scoped.events, 240)
  const userNode = projection.nodes.find(node => node.id === messageId)
  const firstVisible = projection.nodes
    .filter(node => node.id !== messageId && (userNode === undefined || node.seq > userNode.seq))
    .sort((left, right) => left.seq - right.seq)[0]
  if (firstVisible !== undefined) sample.firstVisibleMs = firstVisible.time - sentAt

  sample.toolRoundTrips = Math.max(0, sample.steps - 1)
  sample.mode = sample.tasks === 0
    ? 'direct'
    : sample.tasks === 1
      ? 'single'
      : 'multi'
  return sample
}

/** Every user prompt in one session log, oldest first. */
function sessionSamples(events: readonly SessionEvent[]): TurnSample[] {
  const userMessages = events.filter(event =>
    event.type === 'user/message'
    && ((event.data as { source?: { kind?: string } }).source?.kind) === 'user')
  const samples: TurnSample[] = []
  for (const [index, event] of userMessages.entries()) {
    const messageId = String((event.data as { id?: unknown }).id)
    const sample = analyzeMessage(events, messageId)
    if (sample === undefined) continue
    const next = userMessages[index + 1]
    if (next !== undefined && sample.turnEndMs !== undefined) {
      sample.humanGapMs = next.time - (sample.sentAt + sample.turnEndMs)
    }
    samples.push(sample)
  }
  return samples
}

// ── 4. Recorded samples ─────────────────────────────────────────────────────
function readSessionLog(sessionId: string): readonly SessionEvent[] | undefined {
  if (!existsSync(SESSIONS_ROOT)) return undefined
  for (const workspace of readdirSync(SESSIONS_ROOT)) {
    const dir = join(SESSIONS_ROOT, workspace, sessionId)
    if (!existsSync(dir)) continue
    const file = readdirSync(dir).find(name => name.startsWith('session.v'))
    if (file === undefined) continue
    const raw = readFileSync(join(dir, file))
    const text = file.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as SessionEvent)
  }
  return undefined
}

interface RecordedRun {
  team: string
  sample: TurnSample
}

function recordedRuns(): { runs: RecordedRun[]; reason?: string } {
  if (!existsSync(TEAM_STORE)) return { runs: [], reason: `no team store at ${TEAM_STORE}` }
  const tables = (JSON.parse(readFileSync(TEAM_STORE, 'utf8')) as {
    tables: {
      teams?: Record<string, TeamAggregate>
      messages?: Record<string, { id: string; teamId: string; sender: { kind: string }; createdAt: string; recipient: { slotId?: string } }>
    }
  }).tables
  const teams = tables.teams ?? {}
  const messages = Object.values(tables.messages ?? {})
    .filter(message => message.sender.kind === 'user')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const runs: RecordedRun[] = []
  const skipped: string[] = []
  for (const message of messages) {
    const team = teams[message.teamId]
    const slotId = message.recipient.slotId
    if (team === undefined || slotId === undefined) continue
    const sessionId = team.members[slotId]?.sessionId
    if (sessionId === undefined) continue
    const events = readSessionLog(sessionId)
    if (events === undefined) {
      skipped.push(`${message.id}: no session log`)
      continue
    }
    // A session that never ran keeps only its header: nothing was measured.
    if (events.filter(event => event.type !== 'session').length === 0) {
      skipped.push(`${message.id}: session log holds a header only (turn never persisted)`)
      continue
    }
    const sample = analyzeMessage(events, message.id)
    if (sample === undefined) {
      skipped.push(`${message.id}: no matching turn in the leader log`)
      continue
    }
    // Board artifacts the leader created inside its own turn decide the mode.
    const window = sample.turnEndMs === undefined ? undefined : [sample.sentAt, sample.sentAt + sample.turnEndMs + 1_000]
    const inWindow = (iso: string | undefined): boolean => {
      if (iso === undefined || window === undefined) return false
      const time = Date.parse(iso)
      return time >= window[0]! && time <= window[1]!
    }
    sample.tasks = Object.values(team.tasks ?? {}).filter(task => inWindow(task.createdAt)).length
    sample.goals = Object.values(team.goals ?? {}).filter(goal => inWindow(goal.createdAt)).length
    sample.mode = sample.tasks === 0 ? 'direct' : sample.tasks === 1 ? 'single' : 'multi'
    runs.push({ team: team.name, sample })
  }
  return {
    runs,
    ...(skipped.length === 0
      ? {}
      : { reason: `${skipped.length} recorded user prompt(s) unusable → ${skipped.join('; ')}` }),
  }
}

// ── reporting ───────────────────────────────────────────────────────────────
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const ms = (value: number | undefined): string =>
  value === undefined ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`

function table(rows: readonly string[][], header: readonly string[]): string {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map(row => (row[index] ?? '').length)))
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join(' │ ')
  return [line(header), widths.map(width => '─'.repeat(width)).join('─┼─'), ...rows.map(line)].join('\n')
}

/** A leader prompt already carries the roster: the forced team_members call re-fetches it. */
function fixtureTeam(): TeamAggregate {
  const slot = (id: string, name: string, role: 'leader' | 'member'): TeamMemberSlot => ({
    id,
    displayName: name,
    role,
    assistantId: 'assistant-demo',
    assistantSnapshot: { name: 'Demo', provider: 'p', model: 'm', instructions: '' },
    sessionId: `session-${id}`,
    joinedAt: '2026-10-28T00:00:00.000Z',
    lastRuntimeState: 'idle',
    desiredState: 'online',
    permissionPresetId: 'default',
  } as unknown as TeamMemberSlot)
  return {
    name: 'Benchmark',
    leaderSlotId: 'leader-slot',
    members: {
      'leader-slot': slot('leader-slot', 'Bench Leader', 'leader'),
      'member-a': slot('member-a', 'Member A', 'member'),
      'member-b': slot('member-b', 'Member B', 'member'),
    },
    tasks: {},
    goals: {},
    threads: {},
    retiredSessions: {},
    messages: {},
  } as unknown as TeamAggregate
}

/**
 * The one plugin segment the user pays on every send: the queued record is
 * handed to the leader Agent (`followup`), which is where the model turn
 * starts. Everything before it is a durable write; everything after it is the
 * model. Measured on the real `TeamTurnCoordinator`, not a copy of it.
 */
async function handoffSamples(iterations: number): Promise<number[]> {
  const team = { state: 'active', members: { 'leader-slot': { sessionId: 'session-leader', desiredState: 'online' } } }
  const messages = new Map<string, TeamMessage>()
  const sessionsWithMessage = new Set<string>()
  const timings: number[] = []
  const coordinator = new TeamTurnCoordinator({
    getTeam: () => team as never,
    listMessages: () => [...messages.values()],
    putMessage: async (message) => { messages.set(message.id, message) },
    followup: (sessionId, message) => {
      if (sessionsWithMessage.has(message.id)) return
      sessionsWithMessage.add(message.id)
      timings.push(performance.now() - startedAt)
    },
    sessionState: () => 'online',
    hasMessage: () => false,
    warn: (text) => { throw new Error(text) },
  })
  let startedAt = 0
  for (let index = 0; index < iterations; index += 1) {
    const id = `bench-${index}`
    messages.set(id, {
      id,
      teamId: 'team-bench',
      sender: { kind: 'user', id: 'local-user' },
      recipient: { kind: 'leader', slotId: 'leader-slot' },
      type: 'instruction',
      content: 'ping',
      deliveryState: 'queued',
      createdAt: new Date().toISOString(),
    } as unknown as TeamMessage)
    startedAt = performance.now()
    await coordinator.submit('team-bench', id)
  }
  return timings
}

describe('team first-response benchmark', () => {
  it('pins the seams every baseline number depends on', () => {
    for (const seam of SEAMS) {
      expect(SRC(seam.file), `${seam.id}: ${seam.what} (${seam.file})`).toMatch(seam.pattern)
    }
    for (const gone of REMOVED) {
      expect(SRC(gone.file), `${gone.id}: ${gone.what} came back (${gone.file})`).not.toContain(gone.text)
    }
    expect(VISIBLE_FLOOR_MS).toBe(168)

    const team = fixtureTeam()
    const leader = team.members[team.leaderSlotId]!
    const prompt = memberPrompt(team, leader)
    const roster = rosterPrompt(team)
    // The roster the first turn is told to fetch is already built every turn.
    expect(roster).toContain('Member A (member), slotId=member-a, status=idle')
    expect(roster).toContain('Bench Leader (leader), slotId=leader-slot, status=idle')
    // The assembled leader prompt carries the fast path and no longer asks to
    // wait for a roster approval.
    expect(prompt).toContain('starts the requested work at once')
    expect(prompt).not.toContain('Wait for the user to approve before spawning or assigning work')
    console.log([
      '',
      'Seams pinned:',
      ...SEAMS.map(seam => `  ${seam.id.padEnd(28)} ${seam.what}`),
      '',
      'Removed by the P1 fast path (must stay gone):',
      ...REMOVED.map(gone => `  ${gone.id.padEnd(28)} ${gone.what}`),
      `  ${'visible-output floor'.padEnd(28)} ${CONVERSATION_PUBLISH_MS}ms publish + ${CLIENT_RELOAD_DEBOUNCE_MS}ms client = ${VISIBLE_FLOOR_MS}ms`,
      '',
      `Leader prompt (identity section) ${prompt.length} chars; roster section ${roster.length} chars already appended every turn.`,
    ].join('\n'))
  })

  it('recovers a synthetic turn exactly (analyzer self-check)', () => {
    const t0 = 1_700_000_000_000
    const events = [
      { seq: 1, time: t0, type: 'turn/start', data: { turn: 1 } },
      {
        seq: 2,
        time: t0 + 40,
        type: 'user/message',
        data: {
          id: 'msg-1',
          role: 'user',
          content: [{ type: 'text', text: '这个团队现在有几个人？' }],
          source: { kind: 'user' },
        },
      },
      { seq: 3, time: t0 + 60, type: 'step/start', data: { turn: 1, step: 1 } },
      {
        seq: 4,
        time: t0 + 900,
        type: 'assistant/attempt',
        data: {
          turn: 1,
          step: 1,
          stream: [{ type: 'text-chunks', time0: t0 + 800, index: 0, dt: [0, 100], texts: ['团队', '有'] }],
        },
      },
      { seq: 5, time: t0 + 1000, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'team_members', arguments: '{}' } },
      {
        seq: 6,
        time: t0 + 1010,
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          callId: 'c1',
          message: { toolCallId: 'c1', role: 'tool', content: [{ type: 'text', text: 'ok' }] },
        },
      },
      { seq: 7, time: t0 + 1020, type: 'step/end', data: { turn: 1, step: 1 } },
      { seq: 8, time: t0 + 1040, type: 'step/start', data: { turn: 1, step: 2 } },
      {
        seq: 9,
        time: t0 + 2400,
        type: 'assistant/attempt',
        data: { turn: 1, step: 2, stream: [{ type: 'text-chunks', time0: t0 + 2300, index: 0, dt: [], texts: ['两个'] }] },
      },
      { seq: 10, time: t0 + 2500, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 11, time: t0 + 12_000, type: 'user/message', data: { id: 'msg-2', role: 'user', content: [{ type: 'text', text: '好' }], source: { kind: 'user' } } },
    ] as unknown as readonly SessionEvent[]

    const sample = analyzeMessage(events, 'msg-1')!
    // sentAt is the user event (t0+40), so every delta is relative to it.
    expect(sample.ttftMs).toBe(760)
    expect(sample.firstVisibleMs).toBe(760)
    expect(sample.firstToolCallMs).toBe(960)
    expect(sample.steps).toBe(2)
    expect(sample.toolRoundTrips).toBe(1)
    expect(sample.toolCalls).toEqual(['team_members'])
    expect(sample.approvals).toBe(0)
    expect(sample.turnEndMs).toBe(2460)

    const [first] = sessionSamples(events)
    expect(first?.humanGapMs).toBe(12_000 - 40 - 2460)
  })

  it('prints the 12-prompt definition', () => {
    const rows = PROMPTS.map((prompt) => [
      prompt.id,
      prompt.kind,
      `${prompt.expect.goals}g/${prompt.expect.tasks}t`,
      String(prompt.expect.rosterApprovals),
      String(prompt.expect.firstTurnToolCalls),
      prompt.prompt,
    ])
    console.log([
      '',
      'Benchmark definition (pre-built team: leader + 2 members, no spawn):',
      table(rows, ['id', 'kind', 'board', 'human-approvals', 'leader-tools', 'prompt']),
      '',
      'P1 fast path has landed (7aee654): every row now expects rosterApprovals=0 and no',
      'forced team_members call — an extra tool call or an approval round-trip is a regression.',
      '`expect.firstTurnToolCalls` is the current target per mode.',
    ].join('\n'))
    expect(PROMPTS).toHaveLength(12)
    expect(PROMPTS.filter(prompt => prompt.kind === 'direct')).toHaveLength(4)
    expect(PROMPTS.filter(prompt => prompt.kind === 'single')).toHaveLength(4)
    expect(PROMPTS.filter(prompt => prompt.kind === 'multi')).toHaveLength(4)
  })

  it('reports recorded samples, or says why there are none', () => {
    const { runs, reason } = recordedRuns()
    if (runs.length === 0) {
      console.log([
        '',
        'Recorded samples: none usable on this machine.',
        reason === undefined ? '' : `  ${reason}`,
        '  → run the 12 prompts above against a real team, then rerun this file;',
        '    or point DSH_TEAM_STORE / DSH_SESSIONS_DIR at a profile that has runs.',
      ].join('\n'))
      expect(runs).toHaveLength(0)
      return
    }
    const rows = runs.map(({ team, sample }) => [
      sample.messageId.slice(0, 12),
      team.slice(0, 12),
      sample.mode,
      ms(sample.ttftMs),
      ms(sample.firstVisibleMs),
      ms(sample.firstToolCallMs),
      sample.toolCalls.join(',') === '' ? '—' : sample.toolCalls.join(','),
      String(sample.toolRoundTrips),
      String(sample.approvals),
      ms(sample.turnEndMs),
      ms(sample.humanGapMs),
    ])
    console.log([
      '',
      'Recorded runs (real model, real disk):',
      table(rows, ['message', 'team', 'mode', 'TTFT', 'first-visible', 'first-tool', 'tools', 'tool-RT', 'approvals', 'turn', 'human-gap']),
      '',
      `medians: TTFT ${ms(median(runs.map(run => run.sample.ttftMs).filter((v): v is number => v !== undefined)))}, ` +
        `first-visible ${ms(median(runs.map(run => run.sample.firstVisibleMs).filter((v): v is number => v !== undefined)))}, ` +
        `tool round-trips ${median(runs.map(run => run.sample.toolRoundTrips)) ?? '—'}`,
    ].join('\n'))
    expect(runs.length).toBeGreaterThan(0)
  })

  it('measures the plugin handoff on the real turn coordinator', async () => {
    const timings = await handoffSamples(20)
    const sorted = [...timings].sort((left, right) => left - right)
    console.log([
      '',
      'Plugin floor for one send (real TeamTurnCoordinator, no model, n=20):',
      table([
        ['queued record -> leader followup()', ms(median(timings)), ms(sorted[sorted.length - 1]), ms(sorted[0])],
        ['+ server conversation publish window', `${CONVERSATION_PUBLISH_MS}ms`, '—', '—'],
        ['+ client reload window', `${CLIENT_RELOAD_DEBOUNCE_MS}ms`, '—', '—'],
        ['= floor before ANY model token', ms((median(timings) ?? 0) + VISIBLE_FLOOR_MS), '—', '—'],
      ], ['segment', 'median', 'slowest', 'fastest']),
    ].join('\n'))
    expect(sorted[0]).toBeGreaterThanOrEqual(0)
    expect(median(timings)).toBeLessThan(50)
  })
})
