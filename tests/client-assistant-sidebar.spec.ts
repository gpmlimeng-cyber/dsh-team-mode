import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assistantInstanceLabel,
  assistantInstanceTitle,
  assistantNameForSession,
  assistantNow,
  assistantPendingDecisions,
  assistantSidebarSummary,
  visibleAssistantInstances,
} from '../src/client/assistant-instances.js'
import type { AssistantInstance, AssistantSession } from '../src/domain/types.js'
import type { AssistantInstanceView } from '../src/transport/contracts.js'
import {
  USAGE_MISSING,
  assistantUsageScope,
  formatUsageContext,
  formatUsagePercent,
  formatUsageTokens,
  installUsageSessions,
  requestMissingProjections,
  usageReport,
  usageRowFacts,
  usageRowTitle,
  type UsageListSnapshot,
} from '../src/client/usage.js'

const ISO = '2026-01-01T00:00:00Z'

function instance(
  id: string,
  name: string,
  overrides: Partial<AssistantInstance> = {},
): AssistantInstanceView {
  return {
    schemaVersion: 1,
    id,
    templateId: `template-${id}`,
    assistantSnapshot: {
      assistantId: `template-${id}`,
      revision: 1,
      name,
      instructions: '',
      provider: 'deepseek',
      model: 'deepseek-chat',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/workspace-1',
    status: 'idle',
    pinned: false,
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

/** The same instance with an optional 职能 line, as the snapshot stores it. */
function titled(
  id: string,
  name: string,
  title?: string,
  overrides: Partial<AssistantInstanceView> = {},
): AssistantInstanceView {
  const base = instance(id, name)
  return {
    ...base,
    ...overrides,
    assistantSnapshot: { ...base.assistantSnapshot, ...(title === undefined ? {} : { title }) },
  }
}

function task(
  assistantId: string,
  status: AssistantSession['status'],
  id = `${assistantId}-${status}`,
  overrides: Partial<AssistantSession> = {},
): AssistantSession {  return {
    schemaVersion: 1,
    id,
    assistantId,
    sessionId: `session-${id}`,
    role: 'task',
    title: `task ${id}`,
    brief: '',
    parentSessionId: `parent-${assistantId}`,
    status,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

const paper = instance('paper', 'Paper Bot')
const data = instance('data', 'Data Bot', { status: 'active' })
const broken = instance('broken', 'Broken Bot', { status: 'error', archivedAt: undefined })
const instances: AssistantInstanceView[] = [paper, data, broken]

const tasks: AssistantSession[] = [
  task('paper', 'needs_input', 'paper-pending'),
  task('data', 'needs_input', 'data-pending'),
  task('data', 'running', 'data-running'),
  task('broken', 'needs_input', 'broken-pending'),
]

describe('assistant sidebar search only narrows the ordinary list', () => {
  it('keeps every pending decision when the query matches no assistant', () => {
    // The query is a view over the rows; the decision block is workspace-wide.
    expect(visibleAssistantInstances(instances, '不存在的名字')).toEqual([])
    expect(assistantPendingDecisions(instances, tasks).map(entry => entry.task.id))
      .toEqual(['paper-pending', 'data-pending', 'broken-pending'])
  })

  it('keeps the decision block identical for a matching and a non-matching query', () => {
    const matching = visibleAssistantInstances(instances, 'paper')
    const missing = visibleAssistantInstances(instances, 'nothing here')

    expect(matching.map(item => item.id)).toEqual(['paper'])
    expect(missing).toEqual([])
    expect(assistantPendingDecisions(instances, tasks))
      .toEqual(assistantPendingDecisions(instances, tasks))
    expect(assistantPendingDecisions(instances, tasks)).toHaveLength(3)
  })

  it('counts the summary over every listed assistant, with no query input', () => {
    const summary = assistantSidebarSummary(instances, tasks, {})

    expect(summary).toEqual({ waiting: 3, working: 0, queued: 0, unread: 0 })
    // Same inputs, same numbers: there is no query parameter to narrow them.
    expect(assistantSidebarSummary(instances, tasks, {})).toEqual(summary)
    expect(assistantSidebarSummary(instances, tasks, {}).waiting)
      .toBe(assistantPendingDecisions(instances, tasks).length)

    const busy = instance('busy', 'Busy Bot', { status: 'active' })
    expect(assistantSidebarSummary([busy], [task('busy', 'running')], {}))
      .toEqual({ waiting: 0, working: 1, queued: 0, unread: 0 })
    expect(assistantSidebarSummary([busy], [task('busy', 'queued')], {}))
      .toEqual({ waiting: 0, working: 0, queued: 1, unread: 0 })
  })

  it('never offers an archived instance as a decision or a row', () => {
    const archived = instance('gone', 'Gone Bot', { status: 'archived' })
    const archivedTask = task('paper', 'needs_input', 'paper-archived', {
      archivedAt: '2026-01-02T00:00:00Z',
    })

    expect(visibleAssistantInstances([...instances, archived], '').map(item => item.id))
      .toEqual(['broken', 'data', 'paper'])
    expect(assistantPendingDecisions([...instances, archived], [...tasks, archivedTask])
      .map(entry => entry.task.id)).toEqual(['paper-pending', 'data-pending', 'broken-pending'])
    expect(assistantSidebarSummary([...instances, archived], [...tasks, archivedTask], {}).waiting).toBe(3)
  })
})

describe('assistant sidebar source contract', () => {
  const source = readFileSync(new URL('../src/client/assistant-sidebar.tsx', import.meta.url), 'utf8')
  const moduleCss = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')

  it('builds 待你处理 from the workspace instead of the filtered rows', () => {
    expect(source).toContain('assistantPendingDecisions(instances, tasks)')
    expect(source).not.toContain('visible.some(instance => instance.id === item.instance.id)')
    expect(source).toContain('{attentionItems.length > 0 && (')
    expect(source).toContain('{attentionItems.length}')
  })

  it('has no section header left to carry counts', () => {
    // The header row is gone: no title, no summary line, no section-level fold.
    expect(source).not.toContain('data-dsh-assistant-title')
    expect(source).not.toContain('sidebarAssistantSummary')
    expect(source).toContain('aria-label="单聊"')
    expect(source).not.toContain('for (const instance of visible)')
  })

  it('renders an explicit loading and failure state instead of an empty section', () => {
    expect(source).toContain('正在加载助手…')
    expect(source).toContain('data-dsh-assistant-loading')
    expect(source).toContain('助手数据加载失败：')
    expect(source).toContain('setLoaded(true)')
    expect(source).toContain('className={css.sidebarTeamRetry}')
  })

  it('takes every status word from the shared source', () => {
    expect(source).not.toContain("'空闲'")
    expect(source).not.toContain("'异常'")
    expect(source).not.toContain("'唤醒中'")
    expect(source).toContain('assistantRowState(activity)')
    expect(source).toContain('assistantRowStatusText(activity)')
    expect(source).toContain('assistantRowStatusTitle(activity)')
  })

  it('tones a failed or waking row with the error and business tokens', () => {
    expect(source).toContain('css.sidebarAssistantDotError')
    expect(source).toContain('css.sidebarAssistantDotStarting')
    expect(source).toContain('css.sidebarAssistantStatusError')
    expect(source).toContain('css.sidebarAssistantStatusStarting')
    expect(moduleCss).toMatch(/\.sidebarAssistantDotError\s*\{[^}]*--dsw-alias-state-error-primary/)
    expect(moduleCss).toMatch(/\.sidebarAssistantDotStarting\s*\{[^}]*--dsw-alias-state-business-primary/)
    expect(moduleCss).toMatch(/\.sidebarAssistantStatusError\s*\{[^}]*--dsw-alias-state-error-primary/)
    expect(moduleCss).toMatch(/\.sidebarAssistantStatusStarting\s*\{[^}]*--dsw-alias-state-business-primary/)
  })

  it('follows the effective row state for the dot and the second line', () => {
    expect(source).toContain("const state = assistantRowState(activity)")
    expect(source).toContain("const activeStatus = state !== 'none'")
    expect(source).toContain("{state !== 'none' && (")
    expect(source).toContain('data-dsh-assistant-status={state}')
  })

  it('draws a mascot and an uploaded picture at one 36px row size', () => {
    // DeepSeek-Bot's sidebar Bot is 36px; one constant keeps the row from
    // jumping when a helper swaps a picture for its mascot (was 32 vs 34).
    expect(source).toContain('export const SIDEBAR_ASSISTANT_AVATAR_SIZE = 36')
    expect(source.match(/size=\{SIDEBAR_ASSISTANT_AVATAR_SIZE\}/g) ?? []).toHaveLength(2)
    expect(source).not.toContain('size={32}')
    expect(source).not.toContain('size={34}')
    expect(moduleCss).toMatch(/\.sidebarAssistantAvatar\s*\{[^}]*width: 36px;[^}]*height: 36px;/)
  })

  it('keeps the coordinator in the team column instead of a body host', () => {
    // The pinned 总协调 row leads the lists as one more row: it scrolls with
    // them, needs no host polling, and owns no fixed position or z-index.
    expect(source).toContain('data-dsh-assistant-coordinator-row')
    expect(source).toContain('css.sidebarCoordinatorRow')
    expect(source).not.toContain('createPortal')
    expect(source).not.toContain('useStewardHost')
    expect(source).not.toContain('STEWARD_HOST_ID')
    expect(source).not.toContain('requestAnimationFrame')
    expect(moduleCss).not.toMatch(/\.sidebarCoordinatorRow\s*\{[^}]*order:/)
    // Coordinator row, then the 群聊 child, then 单聊: the DOM order is the
    // visual order instead of a CSS `order` override.
    expect(source).toContain('children?: ReactNode')
    const coordinatorAt = source.indexOf('data-dsh-assistant-coordinator-row')
    const childrenAt = source.indexOf('{children}')
    const sectionAt = source.indexOf('aria-label="单聊"')
    expect(coordinatorAt).toBeGreaterThan(-1)
    expect(childrenAt).toBeGreaterThan(coordinatorAt)
    expect(sectionAt).toBeGreaterThan(childrenAt)
    // The coordinator is still not repeated in the list.
    expect(source).toMatch(/filter\(instance => instance\.id !== coordinatorId\)/)
  })

  it('opens the native group batch dialog from both group ⋯ menus', () => {
    // The menu row is defined once in the shared dialog module; each sidebar
    // only has to dispatch it, and both do.
    expect(source).toContain("setGroupDialog({ kind: 'batch', group })")
    const teamSidebar = readFileSync(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')
    expect(teamSidebar).toContain("openGroupDialog({ kind: 'batch', group })")
    // Both sections reach the dialog through the one shared component.
    expect(source).toContain('<SidebarGroupDialogs')
    expect(teamSidebar).toContain('<SidebarGroupDialogs')
  })

  it('dispatches 导出分组 / 导入分组 from both group ⋯ menus', () => {
    const teamSidebar = readFileSync(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')

    expect(source).toContain("setGroupDialog({ kind: 'export', name: group })")
    expect(source).toContain("setGroupDialog({ kind: 'import' })")
    expect(teamSidebar).toContain("openGroupDialog({ kind: 'export', name: group })")
    expect(teamSidebar).toContain("openGroupDialog({ kind: 'import' })")
  })
})

const usageSnapshot = (
  values: Record<string, unknown>,
  extra: Partial<UsageListSnapshot> = {},
): UsageListSnapshot => ({
  phase: 'ready',
  byId: Object.fromEntries(Object.entries(values).map(([id, projectionValues]) => [
    id,
    { projectionValues: projectionValues as never },
  ])),
  ...extra,
})

const fullUsage = (overrides: Record<string, number> = {}): Record<string, unknown> => ({
  tokenUsage: {
    uncachedInputTokens: 1000,
    cacheReadTokens: 3000,
    cacheWriteTokens: 0,
    outputTokens: 500,
    ...overrides,
  },
  sessionStats: { turns: 4 },
  contextPressure: { projectedTokens: 64_000, contextWindow: 128_000 },
})

describe('assistant usage scope', () => {
  it('covers the main Session, added threads and both retired lists', () => {
    const scope = assistantUsageScope({
      mainSessionId: 'main',
      threadSessionIds: ['thread-1', 'thread-2'],
      retiredMainSessionIds: ['old-main'],
      retiredThreadSessionIds: ['old-thread'],
    })

    expect(scope.map(entry => entry.sessionId)).toEqual([
      'main', 'thread-1', 'thread-2', 'old-main', 'old-thread',
    ])
    // Retired Sessions are counted (their tokens were really spent) and marked.
    expect(scope.filter(entry => entry.retired === true).map(entry => entry.sessionId))
      .toEqual(['old-main', 'old-thread'])
    expect(assistantUsageScope({})).toEqual([])
  })

  it('counts one Session once, preferring the live row over a retired one', () => {
    const scope = assistantUsageScope({
      mainSessionId: 'shared',
      threadSessionIds: ['shared'],
      retiredMainSessionIds: ['shared'],
    })

    expect(scope).toHaveLength(1)
    expect(scope[0]?.retired).toBeUndefined()
    expect(scope[0]?.label).toBe('主会话')
  })
})

describe('usage rollup from host projections', () => {
  it('sums the four buckets, cache hit, turns and the most occupied context', () => {
    const snapshot = usageSnapshot({
      main: fullUsage(),
      thread: {
        tokenUsage: {
          uncachedInputTokens: 1000,
          cacheReadTokens: 1000,
          cacheWriteTokens: 0,
          outputTokens: 100,
        },
        sessionStats: { turns: 0 },
        contextPressure: { pressureTokens: 100_000, contextWindow: 200_000 },
        modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-chat' } },
      },
    })
    const report = usageReport(assistantUsageScope({
      mainSessionId: 'main',
      threadSessionIds: ['thread'],
    }), snapshot)

    expect(report.rollup.reporting).toBe(2)
    expect(report.rollup.tokens).toEqual({
      uncachedInput: 2000,
      cacheRead: 4000,
      cacheWrite: 0,
      output: 600,
      total: 6600,
    })
    // cacheRead / (uncached + cacheRead + cacheWrite) over the whole scope.
    expect(report.rollup.cacheHitPercent).toBe(67)
    // A real zero turn count is a fact, not a missing value.
    expect(report.rollup.turns).toBe(4)
    // Context windows never add up: the highest occupancy wins.
    expect(report.rollup.context?.sessionId).toBe('thread')
    expect(report.rollup.context?.percent).toBe(50)
    expect(report.rollup.partial).toBe(false)
    expect(report.rows[1]?.model).toBe('deepseek-chat')
  })

  it('renders “—” for a Session without projections and keeps it out of the sums', () => {
    const snapshot = usageSnapshot({ main: fullUsage() })
    const report = usageReport(assistantUsageScope({
      mainSessionId: 'main',
      threadSessionIds: ['cold'],
    }), snapshot)

    expect(report.rollup.tokens.total).toBe(4500)
    expect(report.rollup.reporting).toBe(1)
    expect(report.rollup.missing).toBe(1)
    expect(report.rollup.partial).toBe(true)
    const cold = report.rows[1]
    expect(cold?.missing).toBe(true)
    expect(cold?.tokens.total).toBeNull()
    expect(cold?.turns).toBeNull()
    expect(cold?.context).toBeNull()
    expect(usageRowFacts(cold!)).toBe('— tok · 轮数 — · 缓存 — · 上下文 —')
    // The missing row never becomes a zero-token contributor: the sum is the
    // one Session that answered, and the row count says two.
    expect(report.rollup.sessions).toBe(2)
    expect(report.rollup.tokens.total).toBe(4500)
  })

  it('keeps migration-deferred cached values and says the total is partial', () => {
    const snapshot = usageSnapshot({ main: fullUsage()}, {
      projectionsBySession: {
        main: { values: {}, state: 'migration-required' },
        cold: { values: {}, state: 'migration-required' },
      },
    })
    const report = usageReport(assistantUsageScope({
      mainSessionId: 'main',
      threadSessionIds: ['cold'],
    }), snapshot)

    expect(report.rollup.migrating).toBe(2)
    expect(report.rollup.partial).toBe(true)
    expect(report.rows.every(row => row.migrating)).toBe(true)
    // Cached values still sum: migration only limits what is readable.
    expect(report.rollup.tokens.total).toBe(4500)
  })

  it('shows nothing read yet as “—”, never as zero', () => {
    const report = usageReport(assistantUsageScope({ mainSessionId: 'main' }), undefined)

    expect(report.rollup.tokens).toEqual({
      uncachedInput: null,
      cacheRead: null,
      cacheWrite: null,
      output: null,
      total: null,
    })
    expect(report.rollup.cacheHitPercent).toBeNull()
    expect(report.rollup.turns).toBeNull()
    expect(report.rollup.context).toBeNull()
    expect(formatUsageTokens(report.rollup.tokens.total)).toBe(USAGE_MISSING)
    expect(formatUsagePercent(report.rollup.cacheHitPercent)).toBe(USAGE_MISSING)
    expect(formatUsageContext(report.rollup.context)).toBe(USAGE_MISSING)
    expect(report.rows[0]?.missing).toBe(true)
    expect(report.rollup.loading).toBe(false)
  })

  it('prefers the list row projection and falls back to the store map', () => {
    const rowValues = fullUsage()
    const storeValues = { sessionStats: { turns: 9 } }
    const snapshot: UsageListSnapshot = {
      phase: 'ready',
      byId: {
        row: { projectionValues: rowValues as never },
        store: {},
      },
      projectionsBySession: {
        row: { values: {} },
        store: { values: storeValues, state: 'idle' },
      },
    }

    const report = usageReport([
      { sessionId: 'row' },
      { sessionId: 'store' },
    ], snapshot)
    expect(report.rows[0]?.turns).toBe(4)
    expect(report.rows[0]?.missing).toBe(false)
    expect(report.rows[1]?.turns).toBe(9)
    expect(report.rows[1]?.tokens.total).toBeNull()
  })

  it('keeps a 0% cache hit and a 0-turn Session as real zeroes', () => {
    const snapshot = usageSnapshot({
      main: {
        tokenUsage: {
          uncachedInputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 50,
        },
        sessionStats: { turns: 0 },
      },
    })
    const report = usageReport(assistantUsageScope({ mainSessionId: 'main' }), snapshot)

    expect(report.rollup.cacheHitPercent).toBe(0)
    expect(report.rollup.turns).toBe(0)
    expect(usageRowFacts(report.rows[0]!)).toBe('550 tok · 0 轮 · 缓存 0% · 上下文 —')
  })
})

/** Flush the promise chain a projection read builds (call, settle, cleanup). */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

function fakeSessions(): { refresh: string[]; sessions: Parameters<typeof installUsageSessions>[0] } {
  const refresh: string[] = []
  return {
    refresh,
    sessions: {
      list: { getSnapshot: () => ({}), subscribe: () => () => {} },
      refreshProjections: async (sessionId: string) => { refresh.push(sessionId) },
    },
  }
}

describe('usage projection reads', () => {
  it('asks once per unknown Session and never for one that already answered', async () => {
    const fake = fakeSessions()
    installUsageSessions(fake.sessions)
    const snapshot = usageSnapshot({ known: fullUsage() }, {
      projectionsBySession: { migrating: { values: {}, state: 'migration-required' } },
    })
    const scope = [
      { sessionId: 'known' },
      { sessionId: 'migrating' },
      { sessionId: 'cold' },
    ]

    requestMissingProjections(scope, snapshot)
    requestMissingProjections(scope, snapshot)
    await settle()
    expect(fake.refresh).toEqual(['cold'])

    // After the one request settles, a later mount may retry the same id.
    requestMissingProjections(scope, snapshot)
    await settle()
    expect(fake.refresh).toEqual(['cold', 'cold'])
    installUsageSessions(undefined)
  })
})

describe('usage repair-round edges', () => {
  it('includes hidden task-worker Sessions by task title and marks them', () => {
    const scope = assistantUsageScope({ id: 'a1', mainSessionId: 'main' }, [
      { assistantId: 'a1', sessionId: 'worker', title: '修复登录' },
      { assistantId: 'a1', sessionId: 'old-worker', title: '旧任务', archivedAt: '2026-01-02T00:00:00Z' },
      { assistantId: 'a1', sessionId: 'untitled', title: '   ' },
      // Another assistant's worker never joins this rollup.
      { assistantId: 'a2', sessionId: 'other', title: '别人的任务' },
    ])

    expect(scope.map(entry => entry.sessionId)).toEqual([
      'main', 'worker', 'old-worker', 'untitled',
    ])
    const worker = scope.find(entry => entry.sessionId === 'worker')
    expect(worker?.label).toBe('修复登录')
    expect(worker?.hidden).toBe(true)
    expect(worker?.retired).toBeUndefined()
    // An archived task is history: counted, marked retired as well as hidden.
    const retired = scope.find(entry => entry.sessionId === 'old-worker')
    expect(retired?.hidden).toBe(true)
    expect(retired?.retired).toBe(true)
    // A blank task title is not a Session id.
    expect(scope.find(entry => entry.sessionId === 'untitled')?.label).toBe('任务会话')
  })

  it('falls back to 会话 instead of the raw Session id', () => {
    const [row] = usageReport([{ sessionId: 'raw-session-id' }], undefined).rows
    expect(row?.label).toBeUndefined()
    expect(usageRowTitle(row!)).toMatch(/^会话 · /)
    expect(usageRowTitle(row!)).not.toContain('raw-session-id')
  })

  it('calls the total partial whenever any scope Session reported no tokenUsage', () => {
    const report = usageReport([{ sessionId: 'used' }, { sessionId: 'stats-only' }], {
      phase: 'ready',
      byId: {
        used: { projectionValues: fullUsage() as never },
        // Values exist, but there is no tokenUsage to sum.
        'stats-only': { projectionValues: { sessionStats: { turns: 0 } } as never },
      },
    })

    expect(report.rollup.sessions).toBe(2)
    expect(report.rollup.reporting).toBe(1)
    expect(report.rollup.missing).toBe(0)
    expect(report.rollup.partial).toBe(true)
  })

  it('treats empty values and a failed read as unread and retries the failure', async () => {
    const fake = fakeSessions()
    installUsageSessions(fake.sessions)
    const snapshot: UsageListSnapshot = {
      phase: 'ready',
      byId: {},
      projectionsBySession: {
        failed: { values: {}, state: 'error' },
        empty: { values: {} },
        ready: { values: fullUsage() as never, state: 'ready' },
      },
    }
    const scope = [
      { sessionId: 'failed' },
      { sessionId: 'empty' },
      { sessionId: 'ready' },
      { sessionId: 'missing' },
    ]

    requestMissingProjections(scope, snapshot)
    await settle()
    // A failed or empty read is retried; a loaded Session is not.
    expect(fake.refresh).toEqual(['failed', 'empty', 'missing'])
    expect(usageReport(scope, snapshot).rows[1]?.missing).toBe(true)
    expect(usageReport(scope, snapshot).rows[2]?.missing).toBe(false)
    installUsageSessions(undefined)
  })

  it('returns no cache-hit share when nothing was billed', () => {
    const report = usageReport([{ sessionId: 'main' }], usageSnapshot({
      main: {
        tokenUsage: {
          uncachedInputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
        },
      },
    }))

    expect(report.rollup.reporting).toBe(1)
    expect(report.rollup.cacheHitPercent).toBeNull()
    expect(report.rows[0]?.cacheHitPercent).toBeNull()
    expect(formatUsagePercent(report.rollup.cacheHitPercent)).toBe(USAGE_MISSING)
  })

  it('never rounds a partial cache hit up to 100%', () => {
    const report = usageReport([{ sessionId: 'main' }], usageSnapshot({
      main: {
        tokenUsage: {
          uncachedInputTokens: 1,
          cacheReadTokens: 999,
          cacheWriteTokens: 0,
          outputTokens: 5,
        },
      },
    }))

    expect(report.rollup.cacheHitPercent).toBe(99)
    expect(report.rows[0]?.cacheHitPercent).toBe(99)
  })

  it('keeps a full cache hit at exactly 100%', () => {
    const report = usageReport([{ sessionId: 'main' }], usageSnapshot({
      main: {
        tokenUsage: {
          uncachedInputTokens: 0,
          cacheReadTokens: 1000,
          cacheWriteTokens: 0,
          outputTokens: 5,
        },
      },
    }))

    expect(report.rollup.cacheHitPercent).toBe(100)
    expect(formatUsagePercent(report.rollup.cacheHitPercent)).toBe('100%')
  })

  it('carries a rounded 1000k over to the M branch', () => {
    expect(formatUsageTokens(999_949)).toBe('999.9k')
    expect(formatUsageTokens(999_950)).toBe('1M')
    expect(formatUsageTokens(999_999)).toBe('1M')
    expect(formatUsageTokens(1_000_000)).toBe('1M')
    expect(formatUsageTokens(1_234_567)).toBe('1.23M')
  })
})

describe('assistant identity label in rows, pickers and breadcrumb', () => {
  it('reads name · title only when a 职能 line exists', () => {
    expect(assistantInstanceLabel(titled('back', '小码', '后端工程师'))).toBe('小码 · 后端工程师')
    expect(assistantInstanceLabel(titled('plain', '小码'))).toBe('小码')
    // Whitespace is "not set", never a dangling separator.
    expect(assistantInstanceTitle(titled('blank', '小码', '   '))).toBeUndefined()
    expect(assistantInstanceLabel(titled('blank', '小码', '   '))).toBe('小码')
  })

  it('keeps two same-named assistants tellable apart in the row list', () => {
    const rows = visibleAssistantInstances([
      titled('back', '小码', '后端工程师'),
      titled('data', '小码', '数据工程师'),
    ], '')
    expect(rows.map(entry => assistantInstanceLabel(entry))).toEqual([
      '小码 · 后端工程师',
      '小码 · 数据工程师',
    ])
  })

  it('finds an assistant by its 职能 line', () => {
    const rows = visibleAssistantInstances([
      titled('back', '小码', '后端工程师'),
      titled('data', '小码', '数据工程师'),
    ], '数据')
    expect(rows.map(entry => entry.id)).toEqual(['data'])
  })

  it('labels the session breadcrumb with the title', () => {
    const back = titled('back', '小码', '后端工程师', { mainSessionId: 'session-back' })
    const plain = instance('plain', '小码', { mainSessionId: 'session-plain' })
    expect(assistantNameForSession([back, plain], 'session-back')).toBe('小码 · 后端工程师')
    // An untitled assistant still reads as its bare name.
    expect(assistantNameForSession([back, plain], 'session-plain')).toBe('小码')
    expect(assistantNameForSession([back, plain], 'session-other')).toBeUndefined()
  })

  it('names the ＋ picker and the sidebar row with that same label', () => {
    const sidebar = readFileSync(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')
    const row = readFileSync(new URL('../src/client/assistant-sidebar.tsx', import.meta.url), 'utf8')
    expect(sidebar).toContain('name: assistantInstanceLabel(item)')
    expect(row).toContain('const label = assistantInstanceLabel(instance)')
    expect(row).toContain('>{label}</span>')
    expect(row).toContain('${label} · ${secondLine}')
  })

  it('leaves team member surfaces name-only', () => {
    // A member row reads the name the Host sends; the instance 职能 line is an
    // Assistant-side field and never leaks into a team slot.
    for (const path of ['team-sidebar-data.ts', 'team-member-chrome.tsx']) {
      const source = readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
      expect(source).not.toContain('assistantInstanceLabel')
      expect(source).not.toContain('assistantSnapshot.title')
      expect(source).not.toContain('assistantSnapshot.blurb')
    }
  })
})

describe('assistantNow — the detail pane first answer', () => {
  it('puts needs_input before running and queued, so 处理 names the blocking task', () => {
    const now = assistantNow(instance('paper', 'Paper Bot'), [
      task('paper', 'queued', 'task-queue'),
      task('paper', 'running', 'task-run'),
      task('paper', 'needs_input', 'task-pending', { title: '确认发布范围' }),
    ])
    expect(now.current).toMatchObject({
      taskId: 'task-pending',
      title: '确认发布范围',
      statusLabel: '待你处理',
    })
    expect(now.statusText).toBe('待你处理')
    expect(now.counts).toEqual({ needs_input: 1, running: 1, queued: 1 })
  })

  it('ignores archived tasks and the main Session when naming current work', () => {
    const now = assistantNow(instance('paper', 'Paper Bot', { mainSessionId: 'session-main' }), [
      task('paper', 'needs_input', 'task-retired', { archivedAt: ISO }),
      task('paper', 'running', 'task-main', { sessionId: 'session-main' }),
    ])
    expect(now.current).toBeUndefined()
    expect(now.counts).toEqual({ needs_input: 0, running: 0, queued: 0 })
  })

  it('never keeps the stale 活跃 word: archived reads 已归档', () => {
    expect(assistantNow(instance('paper', 'Paper Bot'), []).statusText).toBe('空闲')
    const archived = assistantNow(instance('old', '旧助手', { status: 'archived' }), [])
    expect(archived.statusText).toBe('已归档')
    expect(archived.statusText).not.toBe('活跃')
  })

  it('carries the recent preview and whether a canonical chat exists', () => {
    const withChat: AssistantInstanceView = {
      ...instance('paper', 'Paper Bot', { mainSessionId: 'session-main' }),
      preview: { role: 'user', text: '先做一版', time: Date.parse(ISO) },
    }
    const now = assistantNow(withChat, [])
    expect(now.hasSession).toBe(true)
    expect(now.recent).toEqual({ role: 'user', text: '先做一版', time: Date.parse(ISO) })

    const noChat = assistantNow(instance('new', '新助手'), [])
    expect(noChat.hasSession).toBe(false)
    expect(noChat.recent).toBeUndefined()
  })
})
