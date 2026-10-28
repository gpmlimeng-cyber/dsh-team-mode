import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import { sidebarPartitionLabel } from '../src/client/sidebar-group-ui.js'

// The sections import the whole primitive set through their child modules and
// expect browser peers this node test does not install, so every export is one
// stub: the assertions below are about this plugin's own markup and source.
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
    'IconUsersOutlineRegular', 'IconWarningOutlineRegular', 'IconWarningTriangleOutlineRegular',
    'IconInfoOutlineRegular', 'IconPersonalizationOutlineRegular', 'IconShieldOutlineRegular',
    'IconArchiveOutlineRegular', 'IconClockOutlineRegular', 'IconDatabaseOutlineRegular',
    'IconFlatListOutlineRegular', 'Switch',
  ]
  return Object.fromEntries(names.map(name => [name, Stub]))
})

const { SidebarTeamSection, brandCreateItems, teamLastSessionId, teamThreadRows } = await import('../src/client/sidebar.js')
const { AssistantSidebarSection } = await import('../src/client/assistant-sidebar.js')

const sidebar = readFileSync(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')
const assistant = readFileSync(new URL('../src/client/assistant-sidebar.tsx', import.meta.url), 'utf8')

describe('the two sections start with a group header, not a title row', () => {
  it('renders each section with its accessible name and no 群聊/单聊 heading', () => {
    const team = renderToStaticMarkup(createElement(SidebarTeamSection, {
      openSession: () => {},
      openTeamPage: () => {},
    }))
    // The aria-label survives; the visible header row does not.
    expect(team).toContain('aria-label="群聊"')
    expect(team).not.toContain('>群聊<')
    expect(team).not.toContain('data-dsh-team-mode-title')
    // Deleting the header must not delete the empty state.
    expect(team).toContain('正在加载团队…')

    const stewards = renderToStaticMarkup(createElement(AssistantSidebarSection, {
      openSession: () => {},
      pickWorkspace: async () => null,
    }))
    expect(stewards).toContain('aria-label="单聊"')
    expect(stewards).not.toContain('>单聊<')
    expect(stewards).not.toContain('data-dsh-assistant-title')
    expect(stewards).toContain('正在加载助手…')
  })

  it('names the only partition after the list it holds', () => {
    expect(sidebarPartitionLabel(undefined, false, '团队群聊')).toBe('团队群聊')
    expect(sidebarPartitionLabel(undefined, false, '默认分组')).toBe('默认分组')
  })

  it('keeps real group names and calls the leftovers 未分组', () => {
    expect(sidebarPartitionLabel('设计组', true, '团队群聊')).toBe('设计组')
    expect(sidebarPartitionLabel(undefined, true, '团队群聊')).toBe('未分组')
  })

  it('renders every list through the collapsible partition header', () => {
    expect(sidebar).toContain("sidebarPartitionLabel(group, partitioned, '团队群聊')")
    expect(assistant).toContain("sidebarPartitionLabel(group, partitioned, '默认分组')")
    // No section-level fold and no header row is left behind.
    expect(sidebar).not.toContain('css.sidebarTeamHeader')
    expect(assistant).not.toContain('css.sidebarTeamHeader')
  })
})

describe('the brand row carries the three actions', () => {
  it('filters both lists from the one search field', () => {
    expect(sidebar).toContain('SIDEBAR_SEARCH_EVENT')
    expect(assistant).toContain('window.addEventListener(SIDEBAR_SEARCH_EVENT, onSearch)')
  })

  it('offers 新建团队 and 新建助手 instead of guessing one', () => {
    expect(sidebar).toContain("label: '新建团队'")
    expect(sidebar).toContain("label: '新建助手'")
    expect(sidebar).toContain('openCreateTeamDialog()')
    expect(sidebar).toContain('SIDEBAR_ASSISTANT_CREATE_EVENT')
    // The assistant section opens its existing dialog; no second create path.
    expect(assistant).toContain('window.addEventListener(SIDEBAR_ASSISTANT_CREATE_EVENT, onCreate)')
    expect(assistant).toContain('setCreateOpen(true)')
  })

  it('scopes every 筛选 row to the list it changes', () => {
    expect(sidebar).toContain("label: '团队 · 只看待确认'")
    expect(sidebar).toContain("label: '团队 · 按名称排序'")
    expect(sidebar).toContain("label: '助手 · 简洁：每个助手一行'")
    expect(sidebar).toContain("label: '助手 · 进阶：显示任务线程'")
    // The list with focus comes first; 群聊 is the fallback.
    expect(sidebar).toContain('selectedTeamId === undefined && selectedAssistantId !== undefined')
    expect(sidebar).toContain("setAssistantDisplayMode('advanced')")
  })

  it('leads with 新对话 and keeps 打开管家会话 as the last row', () => {
    const items = brandCreateItems(true, [
      { id: 'chief', name: 'Chief', portrait: null },
      { id: 'other', name: 'Other', portrait: null },
    ])
    expect(items.map(item => ('id' in item ? item.id : ''))).toEqual([
      'new-chat',
      'new-chat-separator',
      'new-assistant',
      'new-team',
      'create-group',
      'library',
      'steward-separator',
      'open-steward',
    ])
    // MausBot's shape: one row opens the picker; every row carries an icon.
    const newChat = items[0] as MenuItem
    expect(newChat.label).toBe('新对话')
    expect(newChat.icon).toBeDefined()
    for (const item of items) {
      if ('type' in item) continue
      expect((item as MenuItem).icon).toBeDefined()
    }
    // 新对话 opens the floating panel, so the picker lives outside the menu.
    expect(sidebar).toContain('NewChatPanel')
    expect(sidebar).toContain('new-chat-panel')
    expect(sidebar).toContain('setNewChatOpen(true)')
    expect((items.at(-1) as MenuItem).label).toBe('打开管家会话')
    expect((items.at(-1) as MenuItem).disabled).toBeUndefined()
  })

  it('disables the steward row without a coordinator and says why', () => {
    const steward = brandCreateItems(false).at(-1) as MenuItem
    expect(steward.icon).toBeDefined()
    expect(steward.disabled).toBe(true)
    expect((steward.label as unknown as { props: { title?: string } }).props.title)
      .toBe('还没有总协调助手')
  })

  it('opens the coordinator session through the pre-existing action', () => {
    expect(sidebar).toContain('void startStewardSession(openSession)')
    expect(sidebar).toContain('const stewardAvailable = useStewardAvailable()')
    expect(sidebar).toContain('items={brandCreateItems(stewardAvailable, chats)}')
  })

  it('routes 新建分组 through the header ⋯ menu, with no bottom rows', () => {
    // The list-level create/import rows are gone; every section header owns
    // one ⋯ menu instead (sidebarGroupActionItems in both sidebars).
    expect(assistant).not.toContain('<SidebarGroupCreateRow')
    expect(assistant).not.toContain('<SidebarGroupImportRow')
    expect(sidebar).not.toContain('<SidebarGroupCreateRow')
    expect(sidebar).not.toContain('<SidebarGroupImportRow')
    expect(assistant).toContain('sidebarGroupActionItems(groups, group)')
    expect(sidebar).toContain('sidebarGroupActionItems(groups, group)')
  })
})

/** Just enough of a TeamView for the sidebar row projection. */
function teamThreadFixture(overrides: Record<string, unknown> = {}): Parameters<typeof teamThreadRows>[0] {
  return {
    id: 'team-1',
    name: '测试团队',
    leaderSlotId: 'leader',
    members: { leader: { sessionId: 'session-main' } },
    ...overrides,
  } as unknown as Parameters<typeof teamThreadRows>[0]
}

describe('a team row resolves its last used conversation', () => {
  it('takes every row title and Session from the thread, newest first', () => {
    const rows = teamThreadRows(teamThreadFixture({
      threads: {
        older: { id: 'older', title: '上周的排期', sessionId: 'session-older', createdAt: 1_000, updatedAt: 1_000 },
        newer: { id: 'newer', title: '今天的发布', sessionId: 'session-newer', createdAt: 2_000, updatedAt: 2_000 },
      },
    }))
    // The row title is thread.title; member display names never become rows.
    expect(rows.map(row => row.title)).toEqual(['今天的发布', '上周的排期'])
    expect(rows.map(row => row.sessionId)).toEqual(['session-newer', 'session-older'])
    expect(rows.every(row => row.main === false)).toBe(true)
    expect(rows[0]?.updatedAt).toBe('1970-01-01T00:00:02.000Z')
  })

  it('falls back to one row for the team main Session when no thread exists', () => {
    const rows = teamThreadRows(teamThreadFixture())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: 'session-main', title: '主会话', main: true })
    // The fallback row is the main Session, so it has no thread to rename.
    expect(rows[0]?.id).toBeUndefined()
  })

  it('keeps the Leader Session even when the team also has threads', () => {
    const rows = teamThreadRows(teamThreadFixture({
      threads: { only: { id: 'only', title: '线程', sessionId: 'session-thread', createdAt: 5, updatedAt: 5 } },
    }))
    expect(rows.map(row => row.sessionId)).toEqual(['session-thread'])
  })

  it('has no row when a team has neither threads nor a resolvable Leader Session', () => {
    expect(teamThreadRows(teamThreadFixture({ members: {} }))).toEqual([])
    expect(teamThreadRows(teamThreadFixture({ members: { leader: { sessionId: '' } } }))).toEqual([])
  })

  it('opens the newest thread, or the main Session when there is none', () => {
    const withThreads = teamThreadFixture({
      threads: {
        older: { id: 'older', title: '上周的排期', sessionId: 'session-older', createdAt: 1_000, updatedAt: 1_000 },
        newer: { id: 'newer', title: '今天的发布', sessionId: 'session-newer', createdAt: 2_000, updatedAt: 2_000 },
      },
    })
    expect(teamLastSessionId(withThreads)).toBe('session-newer')
    expect(teamLastSessionId(teamThreadFixture())).toBe('session-main')
    expect(teamLastSessionId(teamThreadFixture({ members: {} }))).toBeUndefined()
  })
})
