import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
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
    'IconFolderOpenRegular', 'IconLoadingOutlineRegular', 'IconNewChatOutlineRegular',
    'IconPaperclipOutlineRegular', 'IconPinFillRegular', 'IconPinOutlineRegular',
    'IconPlusOutlineRegular', 'IconProjectAddOutlineRegular', 'IconRefreshOutlineRegular',
    'IconRightUpOutlineRegular', 'IconSearchOutlineRegular', 'IconSendOutlineRegular',
    'IconSettingsOutlineRegular', 'IconSlidersTwoOutlineRegular', 'IconSparkleRegular',
    'IconStopFillRegular', 'IconThinkOutlineRegular', 'IconTrashOutlineRegular',
    'IconUsersOutlineRegular', 'IconWarningOutlineRegular', 'IconWarningTriangleOutlineRegular',
  ]
  return Object.fromEntries(names.map(name => [name, Stub]))
})

const { SidebarTeamSection } = await import('../src/client/sidebar.js')
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

  it('keeps one 新建分组 entry, at the bottom of the sidebar list', () => {
    expect(assistant).toContain('<SidebarGroupCreateRow')
    expect(sidebar).not.toContain('<SidebarGroupCreateRow')
  })
})
