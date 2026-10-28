import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { TeamAggregate } from '../domain/types.js'
import { openAssistantSession } from './store.js'
import css from './AgentTeam.module.css'

/**
 * Read-only token usage, aggregated in the client from the Host's own Session
 * projections. There is no usage ledger here: `tokenUsage` / `sessionStats` /
 * `contextPressure` are whole-Session totals the Host already persists, and
 * `modelSelection` only names the route last used. Nothing is written, no time
 * series exists, and no cost is ever shown — DSH has no price field.
 *
 * The Host's client Session list is the only read channel. A long-lived
 * assistant/team has Sessions the open conversation does not load, so the
 * values are read from the list snapshot when it has them and refreshed once
 * per Session through the same service the native UI uses.
 */

/** The four exclusive buckets of one Session's `tokenUsage` projection. */
export interface UsageTokenBucket {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** The slices of the Host's wire projections this panel reads. */
export interface UsageProjectionValues {
  tokenUsage?: Partial<UsageTokenBucket>
  sessionStats?: { turns?: number; steps?: number }
  contextPressure?: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number }
  modelSelection?: {
    lastUsed?: { provider?: string; model?: string } | null
  }
}

/** One Session's projection store, as the list snapshot exposes it. */
export interface UsageProjectionEntry {
  values?: Partial<UsageProjectionValues>
  /** `migration-required` means only cached values are readable for now. */
  state?: string
}

/** The structural slice of `sessions.list.getSnapshot()` this module reads. */
export interface UsageListSnapshot {
  phase?: string
  byId?: Record<string, { displayTitle?: string; projectionValues?: Partial<UsageProjectionValues> }>
  projectionsBySession?: Record<string, UsageProjectionEntry>
}

/** The structural slice of the injected `sessions` service this module reads. */
export interface UsageSessionsService {
  list?: {
    getSnapshot?: () => UsageListSnapshot
    subscribe?: (listener: () => void) => () => void
  }
  refreshProjections?: (sessionId: string) => Promise<void>
}

/** One Session in an assistant/team scope, before any projection is read. */
export interface UsageScopeSession {
  sessionId: string
  /** Assistant/team-owned name; absent means the Host's own Session title. */
  label?: string
  /** Retired Sessions are counted (the tokens were really spent) and marked. */
  retired?: boolean
  /** Rows the native Session list hides (an assistant's task workers). */
  hidden?: boolean
}

/**
 * The slice of one `assistant.task.list` row this panel reads. A task worker
 * Session is a hidden Session owned by the assistant, so its tokens belong to
 * the assistant total even though the native sidebar never lists it.
 */
export interface UsageTaskSession {
  assistantId: string
  sessionId: string
  title: string
  archivedAt?: string | undefined
}

/** One Session's usage, or explicit absences — never a made-up zero. */
export interface UsageSessionRow {
  sessionId: string
  label?: string
  retired: boolean
  tokens: UsageTokens
  cacheHitPercent: number | null
  turns: number | null
  context: UsageContext | null
  /** Last route used by this Session; informational, never a token split. */
  model?: string
  /** The native list hides this Session (an assistant task worker). */
  hidden: boolean
  /** The list snapshot carries no projection values for this Session yet. */
  missing: boolean
  /** Only cached projections exist; the Host deferred this Session's migration. */
  migrating: boolean
}

/** The four totals plus their sum; `null` means “nobody reported this”. */
export interface UsageTokens {
  uncachedInput: number | null
  cacheRead: number | null
  cacheWrite: number | null
  output: number | null
  total: number | null
}

/** One Session's current context occupancy. */
export interface UsageContext {
  pressureTokens: number
  contextWindow: number | null
  percent: number | null
}

/** The assistant/team totals the panel prints above the Session rows. */
export interface UsageRollup {
  sessions: number
  /** Sessions with a complete `tokenUsage` (the only ones summed). */
  reporting: number
  tokens: UsageTokens
  cacheHitPercent: number | null
  turns: number | null
  /** The most occupied Session: context windows never add up across Sessions. */
  context: (UsageContext & { sessionId: string; label?: string }) | null
  /**
   * The total is incomplete: fewer Sessions reported `tokenUsage` than the
   * scope holds. Covers unread, empty, errored and migration-deferred rows.
   */
  partial: boolean
  migrating: number
  /** Sessions whose projection read failed. */
  errored: number
  missing: number
  /** The list has not answered yet and no values exist to show. */
  loading: boolean
}

export interface UsageReport {
  rollup: UsageRollup
  rows: UsageSessionRow[]
}

export const USAGE_MISSING = '—'

let installed: UsageSessionsService | undefined

/**
 * Point the read-only panel at the injected `sessions` service. Called once by
 * the client entry; passing `undefined` detaches it (and is what tests use).
 */
export function installUsageSessions(sessions: UsageSessionsService | undefined): void {
  installed = sessions
  requests.clear()
}

const EMPTY_SNAPSHOT: UsageListSnapshot = {}

function readSnapshot(): UsageListSnapshot {
  return installed?.list?.getSnapshot?.() ?? EMPTY_SNAPSHOT
}

function subscribeSnapshot(listener: () => void): () => void {
  const subscribe = installed?.list?.subscribe
  return subscribe === undefined ? () => {} : subscribe(listener)
}

/**
 * The Host's Session list snapshot, or a stable empty one when no Host UI is
 * mounted (server render / tests). `getServerSnapshot` is the live value so an
 * SSR render observes the same store the browser will.
 */
export function useUsageList(): UsageListSnapshot {
  return useSyncExternalStore(subscribeSnapshot, readSnapshot, readSnapshot)
}

/** Single-flight projection reads: one request per Session, however many callers. */
const requests = new Map<string, Promise<void>>()

function requestProjections(sessionId: string): void {
  const service = installed
  if (service?.refreshProjections === undefined) return
  if (requests.has(sessionId)) return
  const refresh = service.refreshProjections
  const pending = Promise.resolve()
    .then(() => refresh.call(service, sessionId))
    .catch(() => undefined)
    .then(() => {
      // Leaving the entry behind would block a later cold mount; the list store
      // itself decides whether a second read can add anything.
      if (requests.get(sessionId) === pending) requests.delete(sessionId)
    })
  requests.set(sessionId, pending)
}

/** True only for a projection store that actually carries values. */
function hasProjectionValues(values: Partial<UsageProjectionValues> | undefined): boolean {
  return values !== undefined && Object.keys(values).length > 0
}

/**
 * Ask the Host for the projections of every scope Session the list has not
 * answered for. One request per Session in flight. A failed read is retried
 * (that is what makes an error row recover instead of staying “—” forever);
 * a `migration-required` answer is not, because it is the Host's final word for
 * now. Exported so the read path is testable without a browser.
 */
export function requestMissingProjections(
  scope: readonly UsageScopeSession[],
  snapshot: UsageListSnapshot | undefined,
): void {
  for (const entry of scope) {
    const unread = !hasProjectionValues(usageSessionValues(snapshot, entry.sessionId))
    if (!unread) continue
    const state = projectionState(snapshot, entry.sessionId)
    if (state === undefined || state === 'error') requestProjections(entry.sessionId)
  }
}

/** Projection values for one Session: the list row first, then the store map. */
export function usageSessionValues(
  snapshot: UsageListSnapshot | undefined,
  sessionId: string,
): Partial<UsageProjectionValues> | undefined {
  const row = snapshot?.byId?.[sessionId]?.projectionValues
  if (row !== undefined) return row
  return snapshot?.projectionsBySession?.[sessionId]?.values
}

function projectionState(snapshot: UsageListSnapshot | undefined, sessionId: string): string | undefined {
  return snapshot?.projectionsBySession?.[sessionId]?.state
}

function sessionTitle(snapshot: UsageListSnapshot | undefined, sessionId: string): string | undefined {
  const title = snapshot?.byId?.[sessionId]?.displayTitle
  return title === undefined || title.trim() === '' ? undefined : title
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function percentOf(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null
  return Math.round((part / whole) * 100)
}

/**
 * Cache hit share over billed input. Nothing billed is “unknown”, not 0%;
 * a full cache hit is exactly 100%, and every partial hit stays below it so
 * rounding can never claim a hit that did not happen.
 */
function cacheHitPercentOf(cacheRead: number | null, billed: number | null): number | null {
  if (cacheRead === null || billed === null || billed <= 0) return null
  if (cacheRead === billed) return 100
  return Math.min(99, Math.round((cacheRead / billed) * 100))
}

function tokensOf(token: Partial<UsageTokenBucket> | undefined): UsageTokens {
  const uncachedInput = count(token?.uncachedInputTokens)
  const cacheRead = count(token?.cacheReadTokens)
  const cacheWrite = count(token?.cacheWriteTokens)
  const output = count(token?.outputTokens)
  const total = uncachedInput === null || cacheRead === null || cacheWrite === null || output === null
    ? null
    : uncachedInput + cacheRead + cacheWrite + output
  return { uncachedInput, cacheRead, cacheWrite, output, total }
}

function contextOf(
  pressure: UsageProjectionValues['contextPressure'],
): UsageContext | null {
  // `projectedTokens` includes surface growth after the last provider report,
  // so it is the more current occupancy; the reported size is the fallback.
  const pressureTokens = count(pressure?.projectedTokens) ?? count(pressure?.pressureTokens)
  if (pressureTokens === null) return null
  const contextWindow = count(pressure?.contextWindow)
  return { pressureTokens, contextWindow, percent: percentOf(pressureTokens, contextWindow) }
}

function modelOf(values: UsageProjectionValues | undefined): string | undefined {
  const model = values?.modelSelection?.lastUsed?.model
  return typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined
}

function sessionRow(
  entry: UsageScopeSession,
  snapshot: UsageListSnapshot | undefined,
): UsageSessionRow {
  const values = usageSessionValues(snapshot, entry.sessionId)
  const tokens = tokensOf(values?.tokenUsage)
  const billed = tokens.uncachedInput === null || tokens.cacheRead === null || tokens.cacheWrite === null
    ? null
    : tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite
  const turns = count(values?.sessionStats?.turns)
  const state = projectionState(snapshot, entry.sessionId)
  const label = entry.label ?? sessionTitle(snapshot, entry.sessionId)
  const model = modelOf(values)
  return {
    sessionId: entry.sessionId,
    ...(label === undefined ? {} : { label }),
    retired: entry.retired === true,
    tokens,
    cacheHitPercent: cacheHitPercentOf(tokens.cacheRead, billed),
    turns,
    context: contextOf(values?.contextPressure),
    ...(model === undefined ? {} : { model }),
    hidden: entry.hidden === true,
    missing: !hasProjectionValues(values),
    migrating: state === 'migration-required',
  }
}

/**
 * Aggregate one assistant/team scope from the Host's Session projections.
 * Pure: `usage.ts` owns the reading, the caller owns which Sessions belong to
 * the scope. Sessions without a `tokenUsage` stay in the row list with “—”
 * and never enter a sum.
 */
export function usageReport(
  scope: readonly UsageScopeSession[],
  snapshot: UsageListSnapshot | undefined,
): UsageReport {
  const rows = scope.map(entry => sessionRow(entry, snapshot))
  let reporting = 0
  let migrating = 0
  let errored = 0
  let missing = 0
  let uncachedInput = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  let turns: number | null = null
  let context: UsageRollup['context'] = null
  for (const row of rows) {
    if (row.missing) missing += 1
    if (row.migrating) migrating += 1
    if (projectionState(snapshot, row.sessionId) === 'error') errored += 1
    if (row.turns !== null) turns = (turns ?? 0) + row.turns
    const bucket = row.tokens
    if (bucket.total !== null) {
      reporting += 1
      uncachedInput += bucket.uncachedInput ?? 0
      cacheRead += bucket.cacheRead ?? 0
      cacheWrite += bucket.cacheWrite ?? 0
      output += bucket.output ?? 0
    }
    const occupancy = row.context
    if (occupancy !== null) {
      const better = context === null
        || (occupancy.percent ?? -1) > (context.percent ?? -1)
        || ((occupancy.percent ?? -1) === (context.percent ?? -1)
          && occupancy.pressureTokens > context.pressureTokens)
      if (better) {
        context = {
          ...occupancy,
          sessionId: row.sessionId,
          ...(row.label === undefined ? {} : { label: row.label }),
        }
      }
    }
  }
  const complete = reporting > 0
  const billed = uncachedInput + cacheRead + cacheWrite
  return {
    rows,
    rollup: {
      sessions: rows.length,
      reporting,
      tokens: complete
        ? {
            uncachedInput,
            cacheRead,
            cacheWrite,
            output,
            total: uncachedInput + cacheRead + cacheWrite + output,
          }
        : { uncachedInput: null, cacheRead: null, cacheWrite: null, output: null, total: null },
      cacheHitPercent: complete ? cacheHitPercentOf(cacheRead, billed) : null,
      turns,
      context,
      // “Complete” means every Session in scope reported; a Session with no
      // tokenUsage (unread, failed or migration-deferred) leaves the total short.
      partial: reporting < rows.length,
      migrating,
      errored,
      missing,
      loading: rows.length > 0 && snapshot?.phase === 'pending' && !complete && missing === rows.length,
    },
  }
}

/**
 * Read one scope and keep it current: subscribes to the Host's Session list and
 * asks for the projections of Sessions it has not loaded yet (single-flight).
 * The effect is keyed by the id list, so a renamed assistant does not re-ask
 * and a newly bound Session does.
 */
export function useUsageReport(scope: readonly UsageScopeSession[]): UsageReport {
  const snapshot = useUsageList()
  const key = scope
    .map(entry => `${entry.sessionId}\u0001${entry.label ?? ''}\u0001${entry.retired === true ? '1' : '0'}\u0001${entry.hidden === true ? '1' : '0'}`)
    .join('\u0000')
  useEffect(() => {
    // The scope is keyed by its ids: an async list answer must not re-issue the
    // same read on every store notification.
    requestMissingProjections(scope, readSnapshot())
  }, [key])
  return useMemo(() => usageReport(scope, snapshot), [key, snapshot])
}

/** Deduplicate one scope by Session id, preferring a live row over a retired one. */
function uniqueScope(entries: readonly UsageScopeSession[]): UsageScopeSession[] {
  const byId = new Map<string, UsageScopeSession>()
  for (const entry of entries) {
    const sessionId = entry.sessionId.trim()
    if (sessionId === '') continue
    const existing = byId.get(sessionId)
    if (existing === undefined || (existing.retired === true && entry.retired !== true)) {
      byId.set(sessionId, { ...entry, sessionId })
    }
  }
  return [...byId.values()]
}

/** The assistant fields the scope reads; `id` scopes task rows to one owner. */
export interface AssistantUsageSource {
  id?: string | undefined
  mainSessionId?: string | undefined
  retiredMainSessionIds?: readonly string[] | undefined
  threadSessionIds?: readonly string[] | undefined
  retiredThreadSessionIds?: readonly string[] | undefined
}

/**
 * Every Session an assistant owns: main, added threads, both retired lists, and
 * the hidden task-worker Sessions its background tasks ran on. Retired Sessions
 * are counted (the tokens were spent) and marked; worker rows carry their task
 * title and the hidden mark. The sidebar's hiding rules are untouched.
 */
export function assistantUsageScope(
  instance: AssistantUsageSource,
  tasks: readonly UsageTaskSession[] = [],
): UsageScopeSession[] {
  return uniqueScope([
    ...(instance.mainSessionId === undefined
      ? []
      : [{ sessionId: instance.mainSessionId, label: '主会话' }]),
    ...(instance.threadSessionIds ?? []).map(sessionId => ({ sessionId, label: '附加会话' })),
    ...(instance.retiredMainSessionIds ?? []).map(sessionId => ({ sessionId, label: '退役主会话', retired: true })),
    ...(instance.retiredThreadSessionIds ?? []).map(sessionId => ({ sessionId, label: '退役附加会话', retired: true })),
    ...tasks
      .filter(task => instance.id === undefined || task.assistantId === instance.id)
      .map(task => ({
        sessionId: task.sessionId,
        label: task.title.trim() === '' ? '任务会话' : task.title,
        hidden: true,
        ...(task.archivedAt === undefined ? {} : { retired: true }),
      })),
  ])
}

type TeamUsageSource = Pick<
  TeamAggregate,
  'members' | 'retiredSessions' | 'threads' | 'retiredThreads' | 'retiredLeaderSessionIds'
>

/**
 * Every Session a team owns: member Sessions, its threads (archived included),
 * the Sessions of removed members, and Leader Sessions retired by handoff.
 */
export function teamUsageScope(team: TeamUsageSource): UsageScopeSession[] {
  return uniqueScope([
    ...Object.values(team.members).map(member => ({
      sessionId: member.sessionId,
      label: member.displayName,
    })),
    ...Object.values(team.threads ?? {}).map(thread => ({
      sessionId: thread.sessionId,
      label: thread.title,
    })),
    ...Object.values(team.retiredThreads ?? {}).map(thread => ({
      sessionId: thread.sessionId,
      label: thread.title,
      retired: true,
    })),
    ...Object.values(team.retiredSessions).map(session => ({
      sessionId: session.sessionId,
      label: session.displayName,
      retired: true,
    })),
    ...(team.retiredLeaderSessionIds ?? []).map(sessionId => ({
      sessionId,
      label: '退役 Leader 会话',
      retired: true,
    })),
  ])
}

/** Compact token count: `985`, `12.3k`, `1.25M`; “—” when nothing was read. */
export function formatUsageTokens(value: number | null): string {
  if (value === null) return USAGE_MISSING
  if (value < 1000) return String(value)
  if (value < 1_000_000) {
    const kilo = Number((value / 1000).toFixed(1))
    // 999,950+ rounds to 1000.0k; promote instead of printing “1000k”.
    return kilo < 1000 ? `${trim(kilo, 1)}k` : `${trim(value / 1_000_000, 2)}M`
  }
  return `${trim(value / 1_000_000, 2)}M`
}

function trim(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString()
}

/** `62%`; “—” when the Host reported no denominator. A real 0 stays `0%`. */
export function formatUsagePercent(value: number | null): string {
  return value === null ? USAGE_MISSING : `${value}%`
}

/** Context occupancy text: percentage when a window is known, else the tokens. */
export function formatUsageContext(context: UsageContext | null): string {
  if (context === null) return USAGE_MISSING
  return context.percent === null
    ? formatUsageTokens(context.pressureTokens)
    : `${context.percent}%`
}

/** One Session row's facts, in the panel's fixed order. */
export function usageRowFacts(row: UsageSessionRow): string {
  return [
    `${formatUsageTokens(row.tokens.total)} tok`,
    row.turns === null ? '轮数 —' : `${row.turns} 轮`,
    `缓存 ${formatUsagePercent(row.cacheHitPercent)}`,
    `上下文 ${formatUsageContext(row.context)}`,
  ].join(' · ')
}

/** Title text for a row: the full numbers behind the compact line. */
export function usageRowTitle(row: UsageSessionRow): string {
  const parts = [
    row.label ?? '会话',
    `输入 ${formatUsageTokens(row.tokens.uncachedInput)}`,
    `缓存读 ${formatUsageTokens(row.tokens.cacheRead)}`,
    `缓存写 ${formatUsageTokens(row.tokens.cacheWrite)}`,
    `输出 ${formatUsageTokens(row.tokens.output)}`,
  ]
  if (row.context !== null) {
    parts.push(`上下文 ${formatUsageTokens(row.context.pressureTokens)}${row.context.contextWindow === null
      ? ''
      : ` / ${formatUsageTokens(row.context.contextWindow)}`}`)
  }
  if (row.model !== undefined) parts.push(row.model)
  return parts.join(' · ')
}

export interface UsageSectionProps {
  scope: readonly UsageScopeSession[]
  /** What an assistant/team with no Session at all reads. */
  emptyHint?: string | undefined
  /**
   * The surface's own navigation. The team card must close its management modal
   * before opening a Session, so it passes its `onOpenSession`; the settings
   * pane omits it and falls back to the plugin-wide opener bridge.
   */
  onOpenSession?: ((sessionId: string) => void) | undefined
  /**
   * Shown when part of the scope could not be read at all (the assistant's task
   * list failed), so the total is explicitly labelled as excluding it.
   */
  excludeNote?: string | undefined
}

/**
 * The read-only usage body, shared by 助手设置's 用量 group and the team card.
 * Every number comes from the Host's own Session projections; a Session whose
 * projections cannot be read prints “—” and never enters a total. Rows open the
 * native conversation, so this panel keeps no history, no ledger and no route
 * of its own. Written with `createElement` because the two host surfaces import
 * this one module and must not drag a whole UI chunk (or its icon mocks) along.
 */
export function UsageSection({
  scope,
  emptyHint = '还没有会话用量',
  onOpenSession,
  excludeNote,
}: UsageSectionProps): JSX.Element {
  const { rollup, rows } = useUsageReport(scope)
  const [error, setError] = useState<string>()
  const open = (sessionId: string): void => {
    setError(undefined)
    if (onOpenSession !== undefined) {
      onOpenSession(sessionId)
      return
    }
    if (!openAssistantSession(sessionId)) {
      setError('无法打开该会话：宿主还没有可用的会话视图')
    }
  }
  const contextTitle = rollup.context === null
    ? undefined
    : [
        rollup.context.label ?? '会话',
        rollup.context.contextWindow === null
          ? formatUsageTokens(rollup.context.pressureTokens)
          : `${formatUsageTokens(rollup.context.pressureTokens)} / ${formatUsageTokens(rollup.context.contextWindow)}`,
      ].join(' · ')
  const buckets = [
    `输入 ${formatUsageTokens(rollup.tokens.uncachedInput)}`,
    `缓存读 ${formatUsageTokens(rollup.tokens.cacheRead)}`,
    `缓存写 ${formatUsageTokens(rollup.tokens.cacheWrite)}`,
    `输出 ${formatUsageTokens(rollup.tokens.output)}`,
  ].join(' · ')
  return h(
    'div',
    {
      className: css.usageSection,
      'data-dsh-usage-section': '',
      'data-dsh-usage-sessions': rollup.sessions,
    },
    h(
      'div',
      { className: css.usageTotals },
      h(
        'span',
        { className: css.usageTotal, 'data-dsh-usage-total': rollup.tokens.total ?? '' },
        formatUsageTokens(rollup.tokens.total),
        h('span', { className: css.usageTotalUnit }, 'tokens'),
      ),
      h('span', { className: css.usageBuckets, 'data-dsh-usage-buckets': '' }, buckets),
    ),
    h(
      'div',
      { className: css.usageMetrics },
      h('span', { 'data-dsh-usage-cache-hit': '' }, `缓存命中 ${formatUsagePercent(rollup.cacheHitPercent)}`),
      h('span', { 'data-dsh-usage-turns': '' }, rollup.turns === null ? '轮数 —' : `${rollup.turns} 轮`),
      h(
        'span',
        {
          'data-dsh-usage-context': '',
          ...(contextTitle === undefined ? {} : { title: contextTitle }),
        },
        `上下文 ${formatUsageContext(rollup.context)}`,
      ),
    ),
    error !== undefined && h('p', { className: css.usageNote, role: 'alert' }, error),
    rollup.loading
      ? h('p', { className: css.usageNote, role: 'status' }, '正在读取用量…')
      : rollup.partial && h(
          'p',
          { className: css.usageNote, role: 'status' },
          `${rollup.migrating > 0 && rollup.errored === 0
            ? '部分会话仍在迁移'
            : '部分会话暂无法读取'}，合计只含已读取的 ${rollup.reporting} 个会话`,
        ),
    excludeNote !== undefined && h(
      'p',
      { className: css.usageNote, 'data-dsh-usage-exclude-note': '' },
      excludeNote,
    ),
    rows.length === 0
      ? h('p', { className: css.usageEmpty }, emptyHint)
      : h(
          'ul',
          { className: css.usageRows, 'aria-label': '各会话用量' },
          rows.map((row, index) => h(
            'li',
            { key: row.sessionId },
            h(
              'button',
              {
                // The Session id stays in the click closure: the team card must
                // not print it (the epoch is the only id-like fact it shows).
                type: 'button',
                className: css.usageRow,
                'data-dsh-usage-row': index,
                // Compact mark for the tests and for any future styling hook.
                ...(row.hidden ? { 'data-dsh-usage-hidden': '' } : {}),
                title: usageRowTitle(row),
                onClick: () => { open(row.sessionId) },
              },
              h(
                'span',
                { className: css.usageRowName },
                // Never the raw Session id: the Host title is a label, and a
                // Session without one is just “会话”.
                h('span', { className: css.usageRowNameText }, row.label ?? '会话'),
                row.hidden && h('span', { className: css.usageRowTag }, '后台任务'),
                row.retired && h('span', { className: css.usageRowTag }, '已退役'),
                row.migrating && h('span', { className: css.usageRowTag }, '迁移中'),
              ),
              h('span', { className: css.usageRowFacts }, usageRowFacts(row)),
            ),
          )),
        ),
  )
}
