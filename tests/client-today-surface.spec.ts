import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TodayModel, TodayWaiting } from '../src/client/today-model.js'

// The page and the sidebar import the whole primitive set (dialogs, menus,
// markdown) and expect browser peers this node test does not install, so every
// export is one stub: the assertions below are about this plugin's own markup
// and source.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (props: { children?: unknown }): unknown => createElement('span', null, props?.children as never)
  const names = [
    'Button', 'Checkbox', 'Input', 'MarkdownText', 'Menu', 'Modal', 'Tag', 'Tooltip', 'UserTextRun',
    'IconAgentPresetOutlineRegular', 'IconArchiveOutlineMedium', 'IconArchiveOutlineRegular',
    'IconBranchOutlineRegular', 'IconChecklistOutlineRegular', 'IconCheckOutlineRegular',
    'IconChevronDownOutlineRegular', 'IconChevronLeftOutlineRegular', 'IconChevronRightOutlineRegular',
    'IconChevronUpOutlineRegular', 'IconChevronsUpDownOutlineRegular', 'IconClockOutlineRegular',
    'IconCloseFillRegular', 'IconCloseOutlineRegular', 'IconEditOutlineRegular',
    'IconEllipsisOutlineRegular', 'IconFolderCloseRegular', 'IconFolderOpenOutlineRegular',
    'IconFolderOpenRegular', 'IconFlatListOutlineRegular', 'IconLoadingOutlineRegular', 'IconNewChatOutlineRegular',
    'IconPaperclipOutlineRegular', 'IconPinFillRegular', 'IconPinOutlineRegular',
    'IconPlusOutlineRegular', 'IconProjectAddOutlineRegular', 'IconRefreshOutlineRegular',
    'IconRightUpOutlineRegular', 'IconSearchOutlineRegular', 'IconSendOutlineRegular',
    'IconSettingsOutlineRegular', 'IconSlidersTwoOutlineRegular', 'IconSparkleRegular', 'IconUserOutlineRegular', 'IconUsersOutlineRegular',
    'IconStopFillRegular', 'IconThinkOutlineRegular', 'IconTrashOutlineRegular',
    'IconWarningOutlineRegular', 'IconWarningTriangleOutlineRegular',
    'IconInfoOutlineRegular', 'IconPersonalizationOutlineRegular', 'IconShieldOutlineRegular',
    'IconDatabaseOutlineRegular', 'Switch',
  ]
  /**
   * The host's documented buckets, restated: the page only owns the wording, so
   * the test's job is that wording, not the thresholds.
   */
  const relativeTime = (at: number, now: number): { unit: string; n: number } => {
    const diff = Math.max(0, now - at)
    const MIN = 60_000
    const HOUR = 3_600_000
    const DAY = 86_400_000
    if (diff < MIN) return { unit: 'now', n: 0 }
    if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
    if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
    if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
    if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
    return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
  }
  return { ...Object.fromEntries(names.map(name => [name, Stub])), relativeTime }
})

const {
  ARCHIVED_TEAM_MODE_NOTICE,
  OPEN_TODAY_EVENT,
  TODAY_TAB_ID,
  TODAY_TAB_KIND,
  TODAY_TAB_TITLE,
  TodaySurfacePanel,
  applyTodayTab,
  openArchivedTeam,
  openRunningRow,
  openUnreadAssistantRow,
  openWaitingRow,
  requestToday,
  todayRowKey,
} = await import('../src/client/today-surface.js')
const { todayWaitingGroups } = await import('../src/client/today-model.js')
const { brandCreateItems } = await import('../src/client/sidebar.js')

const source = readFileSync(new URL('../src/client/today-surface.tsx', import.meta.url), 'utf8')
const plugin = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/client/Today.module.css', import.meta.url), 'utf8')

/** Markup without tags, for "does this sentence appear" assertions. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

/** Local wall-clock times keep 今天/明天 assertions timezone-independent. */
const NOW = new Date(2026, 0, 1, 12, 0, 0).getTime()
const TOMORROW_9 = new Date(2026, 0, 2, 9, 0, 0).getTime()

function model(overrides: Partial<TodayModel> = {}): TodayModel {
  const base: TodayModel = {
    greeting: '2 件事等你，其余在按计划跑',
    waiting: [
      {
        teamId: 'team-a',
        teamName: '甲队',
        kind: 'approval',
        subject: '合并 PR',
        since: NOW - 2 * 3_600_000,
        waitMs: 2 * 3_600_000,
      },
      {
        teamId: 'team-b',
        teamName: '乙队',
        kind: 'stuck_member',
        subject: 'worker',
        since: NOW - 90_000,
        waitMs: 90_000,
      },
    ],
    waitingGroups: [],
    running: [
      {
        teamId: 'team-c',
        teamName: '丙队',
        subject: '跑测试',
        since: NOW - 25 * 60_000,
        runMs: 25 * 60_000,
      },
    ],
    upcoming: [{ id: 'job-1', name: '每日汇报', nextAt: TOMORROW_9 }],
    archived: { teams: [], assistants: [], threads: [], total: 0 },
    attentionCount: 2,
    runningEmpty: false,
  }
  const merged: TodayModel = { ...base, ...overrides }
  merged.waitingGroups = overrides.waitingGroups ?? todayWaitingGroups(merged.waiting)
  return merged
}

function render(overrides: Partial<Parameters<typeof TodaySurfacePanel>[0]> = {}): string {
  return renderToStaticMarkup(createElement(TodaySurfacePanel, {
    now: NOW,
    onRefresh: () => {},
    onOpenTeam: () => {},
    onOpenWaiting: () => {},
    onOpenAutomation: () => {},
    onOpenArchivedTeam: () => {},
    onOpenArchivedAssistant: () => {},
    onOpenThread: () => {},
    ...overrides,
  }))
}

describe('today tab registration', () => {
  it('owns one page type on the right Sidebar', () => {
    expect(TODAY_TAB_ID).toBe('dsh-team-mode-today')
    expect(TODAY_TAB_KIND).toBe('dsh-team-mode-today')
    expect(TODAY_TAB_TITLE).toBe('今天')
  })

  it('registers the type, its body key, and the guide entry on the host', () => {
    expect(plugin).toContain('sidebarRightTabs.register')
    expect(plugin).toContain('id: TODAY_TAB_ID')
    expect(plugin).toContain('kind: TODAY_TAB_KIND')
    expect(plugin).toContain('title: () => TODAY_TAB_TITLE')
    expect(plugin).toContain("'sidebar.right.pane.tab'")
    expect(plugin).toContain('key: TODAY_TAB_ID')
    expect(plugin).toContain('TodaySurfaceBody')
    expect(plugin).toContain('guide:')
    expect(plugin).toContain('icon: IconSparkleRegular')
  })

  it('opens from the brand ＋ menu through the host listener', () => {
    const items = brandCreateItems(false)
    expect(items).toContainEqual(expect.objectContaining({ id: 'today', label: '今天' }))
    // 今天 leads the menu: it is where the day starts, not a create action.
    expect(items[0]).toMatchObject({ id: 'today' })
    expect(sidebar).toContain("if (id === 'today') requestToday()")
    expect(plugin).toContain('window.addEventListener(OPEN_TODAY_EVENT, open)')
    expect(plugin).toContain('applyTodayTab(native.sidebarRight)')
  })

  it('refuses to open without a mounted Session and honours the host writer', () => {
    const calls: string[] = []
    expect(applyTodayTab(undefined)).toBe(false)
    expect(applyTodayTab({ mounted: { getSnapshot: () => undefined }, openTab: () => {} })).toBe(false)
    expect(applyTodayTab({
      mounted: { getSnapshot: () => 'session-1' },
      openTab: kind => { calls.push(kind) },
    })).toBe(true)
    expect(calls).toEqual([TODAY_TAB_KIND])
    expect(applyTodayTab({
      mounted: { getSnapshot: () => 'session-1' },
      openTab: () => { throw new Error('no pane') },
    })).toBe(false)
  })

  it('publishes the open request instead of touching the layout', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    requestToday()
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({}))
    expect((dispatchEvent.mock.calls[0]?.[0] as Event).type).toBe(OPEN_TODAY_EVENT)
    vi.unstubAllGlobals()
  })
})

describe('today surface rendering', () => {
  it('leads with the greeting line and then the three blocks in priority order', () => {
    const html = render({
      model: model(),
      hello: '下午好',
      now: NOW,
      onRefresh: () => {},
      onOpenTeam: () => {},
      onOpenAutomation: () => {},
    })
    expect(text(html)).toContain('下午好')
    expect(text(html)).toContain('2 件事等你，其余在按计划跑')
    const order = ['等你确认', '在进行', '接下来'].map(title => text(html).indexOf(title))
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(text(html)).toContain('甲队')
    expect(text(html)).toContain('合并 PR')
    expect(text(html)).toContain('已等 2 小时')
    expect(text(html)).toContain('已跑 25 分钟')
    expect(text(html)).toContain('明天 09:00')
  })

  it('draws no block for empty 等你确认 and 接下来, and one grey line for empty 在进行', () => {
    const html = render({
      model: model({ greeting: '今天没有等你的事', waiting: [], running: [], upcoming: [], runningEmpty: true }),
      now: NOW,
      onRefresh: () => {},
      onOpenTeam: () => {},
      onOpenAutomation: () => {},
    })
    expect(text(html)).not.toContain('等你确认')
    expect(text(html)).not.toContain('接下来')
    expect(text(html)).toContain('在进行')
    expect(text(html)).toContain('现在没有在跑的任务')
    expect(text(html)).not.toContain('0 件事等你')
  })

  it('renders every row as a button, so a row is never a dead line of text', () => {
    const html = render({
      model: model(),
      now: NOW,
      onRefresh: () => {},
      onOpenTeam: () => {},
      onOpenAutomation: () => {},
    })
    expect(html).toContain('data-dsh-today-row="waiting"')
    expect(html).toContain('data-dsh-today-row="running"')
    expect(html).toContain('data-dsh-today-row="upcoming"')
    // Two waiting rows, one running row, one upcoming row, plus the refresh button.
    expect(html.match(/<button/g)?.length).toBe(5)
  })

  it('offers a manual refresh and says what it is doing before data lands', () => {
    expect(render()).toContain('aria-label="刷新"')
    expect(text(render({
      loading: true,
      now: NOW,
      onRefresh: () => {},
      onOpenTeam: () => {},
      onOpenAutomation: () => {},
    })))
      .toContain('正在读取今天…')
  })

  it('shows a failed read instead of a stale page, and drops the headline', () => {
    const html = render({
      error: '今天数据加载失败：team.list 超时',
      now: NOW,
      onRefresh: () => {},
      onOpenTeam: () => {},
      onOpenAutomation: () => {},
    })
    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('今天数据加载失败：team.list 超时')
    // The most important line must not claim the day is quiet while the alert
    // above it says the read failed.
    expect(text(html)).not.toContain('今天没有等你的事')
    expect(html).not.toContain('role="status"')
  })

  it('draws assistant decisions and passive unread rows in the same 等你确认 block', () => {
    const html = render({
      model: model({
        waiting: [
          {
            teamName: 'Paper Bot',
            kind: 'assistant_decision',
            subject: '整理本周资料',
            since: NOW - 60_000,
            waitMs: 60_000,
            assistant: {
              assistantId: 'paper',
              name: 'Paper Bot',
              sessionId: 'session-paper',
              taskId: 'task-paper',
            },
          },
          {
            teamName: 'Data Bot',
            kind: 'assistant_unread',
            subject: '报表已经生成',
            since: NOW - 120_000,
            waitMs: 120_000,
            assistant: { assistantId: 'data', name: 'Data Bot', sessionId: 'session-data' },
          },
        ],
      }),
      now: NOW,
    })
    expect(text(html)).toContain('助手待你处理')
    expect(text(html)).toContain('未读 · 2 分钟前')
    expect(html.match(/data-dsh-today-row="waiting"/g)?.length).toBe(2)
  })

  it('folds 已归档 by default, lists all three kinds view-only, and offers no restore', () => {
    const html = render({
      model: model({
        archived: {
          teams: [{ id: 'team-old', name: '旧团队' }],
          assistants: [{ id: 'assistant-old', name: '旧助手', sessionId: 'session-old' }],
          threads: [{ sessionId: 'session-thread', title: '旧线程', source: '甲队' }],
          total: 3,
        },
      }),
      now: NOW,
    })
    expect(html).toContain('<details')
    expect(html).not.toContain('<details open')
    expect(text(html)).toContain('已归档')
    expect(text(html)).toContain('助手可在「单聊 → 已归档」恢复；团队暂不支持恢复。')
    expect(html).toContain('data-dsh-today-row="archived-team"')
    expect(html).toContain('data-dsh-today-row="archived-assistant"')
    expect(html).toContain('data-dsh-today-row="archived-thread"')
    // Archived team rows open the manage dialog, never a dead draft Session.
    expect(text(html)).toContain('草稿团队 · 打开管理')
    // v1 is view-only: the note says so and no row offers a restore action.
    expect(html).not.toMatch(/<button[^>]*>[^<]*恢复/)
  })

  it('draws no 已归档 block when nothing is archived', () => {
    expect(text(render({ model: model(), now: NOW }))).not.toContain('已归档')
  })
})

describe('today waiting groups and coworker running rows', () => {
  it('draws one group per coworker, longest wait first, with an actionable count', () => {
    const waiting: TodayWaiting[] = [
      {
        teamName: 'Paper Bot',
        kind: 'assistant_decision',
        subject: '整理本周资料',
        since: NOW - 3 * 3_600_000,
        waitMs: 3 * 3_600_000,
        assistant: { assistantId: 'paper', name: 'Paper Bot', sessionId: 'session-paper', taskId: 'task-paper' },
      },
      {
        teamName: 'Data Bot',
        kind: 'assistant_decision',
        subject: '报表已经生成',
        since: NOW - 60_000,
        waitMs: 60_000,
        assistant: { assistantId: 'data', name: 'Data Bot', sessionId: 'session-data', taskId: 'task-data' },
      },
    ]
    const html = render({ model: model({ waiting }), now: NOW })
    const groupTitles = html.match(/data-dsh-today-group="[^"]+"/g) ?? []
    expect(groupTitles).toHaveLength(2)
    // The longest-waiting coworker is drawn first.
    expect(html.indexOf('Paper Bot')).toBeLessThan(html.indexOf('Data Bot'))
    expect(html).toContain('data-dsh-today-row="waiting"')
    // Every count on the block is actionable: two decisions, no passive rows.
    expect(text(html)).toContain('等你确认2')
  })

  it('never counts a passive unread row as actionable and says so beside the group', () => {
    const waiting: TodayWaiting[] = [
      {
        teamName: 'Paper Bot',
        kind: 'assistant_unread',
        subject: '简报写好了',
        since: NOW - 120_000,
        waitMs: 120_000,
        assistant: { assistantId: 'paper', name: 'Paper Bot', sessionId: 'session-paper' },
      },
    ]
    const html = render({ model: model({ waiting, attentionCount: 0 }), now: NOW })
    const plain = text(html)
    expect(plain).toContain('Paper Bot')
    expect(plain).toContain('未读 1')
    // Passive rows never put a number beside 等你确认.
    expect(plain).not.toContain('等你确认0')
    expect(plain).not.toContain('等你确认1')
    expect(plain).not.toContain('助手待你处理')
  })

  it('draws a coworker running row and routes it to the task Session, not a team page', () => {
    const running = [{
      teamName: 'Paper Bot',
      subject: '整理本周资料',
      since: NOW - 10 * 60_000,
      runMs: 10 * 60_000,
      assistant: {
        assistantId: 'paper',
        name: 'Paper Bot',
        sessionId: 'session-paper',
        taskId: 'task-paper',
      },
    }]
    const html = render({ model: model({ running }), now: NOW })
    expect(html).toContain('data-dsh-today-running="assistant"')
    expect(text(html)).toContain('Paper Bot')
    expect(text(html)).toContain('整理本周资料')
  })
})

describe('today row navigation', () => {
  it('answers an archived-team click in native mode with a visible notice, not a dead manage call', () => {
    const openManageTeam = vi.fn()
    const notice = vi.fn()

    expect(openArchivedTeam('team-old', { mode: 'native', openManageTeam, notice })).toBe(false)
    expect(openManageTeam).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith(ARCHIVED_TEAM_MODE_NOTICE)

    expect(openArchivedTeam('team-old', { mode: 'team', openManageTeam, notice })).toBe(true)
    expect(openManageTeam).toHaveBeenCalledWith('team-old')
  })

  it('surfaces that notice as a visible status line on the page', () => {
    const html = render({ notice: ARCHIVED_TEAM_MODE_NOTICE, now: NOW })
    expect(html).toContain('role="status"')
    expect(text(html)).toContain(ARCHIVED_TEAM_MODE_NOTICE)
  })

  it('marks an unread assistant read before opening it from 今天', () => {
    const navigation = { markRead: vi.fn(), openAssistant: vi.fn(), openTeam: vi.fn() }
    const row: TodayWaiting = {
      teamName: 'Data Bot',
      kind: 'assistant_unread',
      subject: '报表已经生成',
      since: NOW - 120_000,
      waitMs: 120_000,
      assistant: { assistantId: 'data', name: 'Data Bot', sessionId: 'session-data' },
    }
    openWaitingRow(row, navigation)
    expect(navigation.markRead).toHaveBeenCalledWith('data')
    expect(navigation.openAssistant).toHaveBeenCalledWith('session-data', 'data')
    expect(navigation.openTeam).not.toHaveBeenCalled()
  })

  it('does not mark an actionable decision read, and routes a team row to the team opener', () => {
    const navigation = { markRead: vi.fn(), openAssistant: vi.fn(), openTeam: vi.fn() }
    openWaitingRow({
      teamName: 'Paper Bot',
      kind: 'assistant_decision',
      subject: '整理资料',
      since: NOW - 60_000,
      waitMs: 60_000,
      assistant: {
        assistantId: 'paper',
        name: 'Paper Bot',
        sessionId: 'session-paper',
        taskId: 'task-paper',
      },
    }, navigation)
    expect(navigation.markRead).not.toHaveBeenCalled()
    expect(navigation.openAssistant).toHaveBeenCalledWith('session-paper', 'paper')

    openWaitingRow({
      teamId: 'team-a',
      teamName: '甲队',
      kind: 'approval',
      subject: '合并 PR',
      since: NOW - 60_000,
      waitMs: 60_000,
    }, navigation)
    expect(navigation.openTeam).toHaveBeenCalledWith('team-a')
  })

  it('routes a coworker running row to its task Session, never to a team page', () => {
    const navigation = { openAssistant: vi.fn(), openTeam: vi.fn() }
    openRunningRow({
      teamName: 'Paper Bot',
      subject: '整理资料',
      since: NOW - 60_000,
      runMs: 60_000,
      assistant: {
        assistantId: 'paper',
        name: 'Paper Bot',
        sessionId: 'session-paper',
        taskId: 'task-paper',
      },
    }, navigation)
    expect(navigation.openAssistant).toHaveBeenCalledWith('session-paper', 'paper')
    expect(navigation.openTeam).not.toHaveBeenCalled()

    openRunningRow({
      teamId: 'team-a',
      teamName: '甲队',
      subject: '合并 PR',
      since: NOW - 60_000,
      runMs: 60_000,
    }, navigation)
    expect(navigation.openTeam).toHaveBeenCalledWith('team-a')
  })

  it('keys same-titled assistant tasks by taskId so pending rows cannot collide', () => {    const row = (taskId: string): TodayWaiting => ({
      teamName: 'Paper Bot',
      kind: 'assistant_decision',
      subject: '同名任务',
      since: NOW,
      waitMs: 0,
      assistant: {
        assistantId: 'paper',
        name: 'Paper Bot',
        sessionId: `session-${taskId}`,
        taskId,
      },
    })
    expect(todayRowKey(row('task-a'))).not.toBe(todayRowKey(row('task-b')))
    expect(todayRowKey(row('task-a'))).toContain('task-a')
    // The list itself must render through that key, not an inline subject key.
    expect(source).toContain('key={todayRowKey(row)}')
  })
})

describe('today surface cost and style rules', () => {
  it('reads once on open and refreshes only on demand', () => {
    expect(source).not.toContain('setInterval')
    expect(source).not.toContain('setTimeout')
    expect(source.match(/useEffect\(/g)?.length).toBe(1)
    expect(source).toContain('}, [nonce])')
    expect(source).toContain('aria-label="刷新"')
  })

  it('reuses existing reads and adds no transport method', () => {
    const reads = [...source.matchAll(/callAgentTeam\('([^']+)'/g)].map(match => match[1] ?? '')
    expect(reads.sort()).toEqual([
      'assistant.instance.list',
      'assistant.task.list',
      'escalation.list',
      'team.list',
    ])
    expect(source).toContain('readAssistantAutomations')
    // The 4th read is a payloadless read; it must not grow a new endpoint.
    expect(source).toContain("callAgentTeam('assistant.task.list', undefined)")
  })

  it('builds the one footer entry on truthful waiting data, not on waiting_approval members', () => {
    expect(plugin).toContain("'sidebar.footer.action'")
    expect(plugin).toContain('SidebarTodayAction')
    expect(plugin).toContain("id: 'dsh-team-mode-today-entry'")
    expect(sidebar).toContain('export function SidebarTodayAction')
    expect(sidebar).toContain('readTodayAttentionCount')
    expect(sidebar).toContain('requestToday')
    expect(sidebar).toContain('footerActionCount')
    // The count must not be built from the dead member status (S6).
    expect(sidebar).not.toContain('waiting_approval')
    expect(source).not.toContain('waiting_approval')
  })

  it('dates rows with the host relative-time buckets, not its own thresholds', () => {
    expect(source).not.toMatch(/const (MINUTE|HOUR|DAY)\b/)
    expect(source).not.toContain('function duration')
    expect(source).toContain('relativeTime(at, now)')
    expect(source).toContain('const ELAPSED_WORDS')
    for (const unit of ['now', 'minutes', 'hours', 'days', 'months', 'years']) {
      expect(source).toContain(`${unit}:`)
    }
    // 等待 row (action + passive unread) and 进行 row share one formatter.
    expect(source.match(/elapsedLabel\(row\.since, now\)/g)?.length).toBe(3)
    // The pane-wide `expanded` flag had no consumer; the tab width is the host's.
    expect(source).not.toContain('data-expanded')
  })

  it('keeps the new surfaces on native controls and tokens', () => {
    expect(source).toContain('<details')
    expect(source).toContain('<summary')
    expect(styles).not.toContain('position: fixed')
    expect(styles).not.toMatch(/\bz-index\b/)
    expect(styles).not.toMatch(/(^|[^\w-])body\b/)
    expect(styles).toContain('var(--dsw-radius-sm)')
  })

  it('styles only through --dsw-* tokens and wraps instead of overflowing', () => {
    const variables = [...styles.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1] ?? '')
    expect(variables.length).toBeGreaterThan(10)
    expect(variables.every(name => name.startsWith('--dsw-'))).toBe(true)
    expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(styles).not.toMatch(/\brgba?\(/)
    expect(styles).toContain('min-width: 0')
    expect(styles).toContain('text-overflow: ellipsis')
    expect(styles).toContain('overflow-x: hidden')
  })
})

describe('today unread row opens the canonical chat, not a stored id', () => {
  const source = readFileSync(new URL('../src/client/today-surface.tsx', import.meta.url), 'utf8')

  const unread = (sessionId: string): TodayWaiting => ({
    teamName: 'Data Bot',
    kind: 'assistant_unread',
    subject: '报表已经生成',
    since: NOW - 120_000,
    waitMs: 120_000,
    assistant: { assistantId: 'data', name: 'Data Bot', sessionId },
  })

  it('marks read and hands the assistant id to the ensure door, never the stored session id', () => {
    const navigation = { markRead: vi.fn(), openCanonical: vi.fn() }
    expect(openUnreadAssistantRow(unread('session-data'), navigation)).toBe(true)
    expect(navigation.markRead).toHaveBeenCalledWith('data')
    expect(navigation.openCanonical).toHaveBeenCalledWith('data', true)
    expect(JSON.stringify(navigation.openCanonical.mock.calls)).not.toContain('session-data')
  })

  it('passes the pre-ensure bound fact, so a first bind can still be marked', () => {
    const navigation = { markRead: vi.fn(), openCanonical: vi.fn() }
    openUnreadAssistantRow(unread(''), navigation)
    expect(navigation.openCanonical).toHaveBeenCalledWith('data', false)
  })

  it('leaves decision rows on their task Session instead of the canonical door', () => {
    const navigation = { markRead: vi.fn(), openCanonical: vi.fn() }
    const decision: TodayWaiting = {
      teamName: 'Paper Bot',
      kind: 'assistant_decision',
      subject: '整理资料',
      since: NOW - 60_000,
      waitMs: 60_000,
      assistant: {
        assistantId: 'paper',
        name: 'Paper Bot',
        sessionId: 'session-task',
        taskId: 'task-paper',
      },
    }
    expect(openUnreadAssistantRow(decision, navigation)).toBe(false)
    expect(navigation.markRead).not.toHaveBeenCalled()
    expect(navigation.openCanonical).not.toHaveBeenCalled()
  })

  it('wires the page action through openAssistantMainSession before navigation', () => {
    expect(source).toContain('openAssistantMainSession(assistantId, sessionId => {')
    expect(source).toContain('openUnreadAssistantRow(row, {')
  })
})
