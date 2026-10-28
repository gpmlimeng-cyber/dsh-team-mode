import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TodayModel } from '../src/client/today-model.js'

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
  return Object.fromEntries(names.map(name => [name, Stub]))
})

const {
  OPEN_TODAY_EVENT,
  TODAY_TAB_ID,
  TODAY_TAB_KIND,
  TODAY_TAB_TITLE,
  TodaySurfacePanel,
  applyTodayTab,
  requestToday,
} = await import('../src/client/today-surface.js')
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
  return {
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
    runningEmpty: false,
    ...overrides,
  }
}

function render(overrides: Parameters<typeof TodaySurfacePanel>[0] = {
  onRefresh: () => {},
  onOpenTeam: () => {},
  onOpenAutomation: () => {},
}): string {
  return renderToStaticMarkup(createElement(TodaySurfacePanel, overrides))
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
    expect(text(render({ loading: true, onRefresh: () => {}, onOpenTeam: () => {}, onOpenAutomation: () => {} })))
      .toContain('正在读取今天…')
  })

  it('shows a failed read instead of a stale page', () => {
    const html = render({
      error: '今天数据加载失败：team.list 超时',
      onRefresh: () => {},
      onOpenTeam: () => {},
      onOpenAutomation: () => {},
    })
    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('今天数据加载失败：team.list 超时')
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
    expect(reads.sort()).toEqual(['escalation.list', 'team.list'])
    expect(source).toContain('readAssistantAutomations')
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
