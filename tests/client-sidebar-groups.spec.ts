import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SIDEBAR_GROUP_BRIEF_MAX_CHARS as HOST_BRIEF_MAX_CHARS } from '../src/domain/schemas.js'
import {
  GROUP_SHARE_KIND,
  GROUP_SHARE_MAX_DOCUMENT_BYTES as HOST_GROUP_SHARE_MAX_DOCUMENT_BYTES,
  type GroupImportPreview,
  type PortableAssistantProfile,
} from '../src/domain/group-share.js'
import {
  GROUP_SHARE_MAX_DOCUMENT_BYTES,
  SIDEBAR_GROUP_BRIEF_MAX_CHARS,
  SIDEBAR_GROUP_MAX_CHARS,
  UNGROUPED_PARTITION_ID,
  applyGroupBatch,
  groupBatchLevelNeedsDefault,
  groupBatchLevels,
  groupBatchMembers,
  groupBatchModelKey,
  groupBatchModelRefs,
  groupBatchPatch,
  groupBatchPendingMembers,
  groupBatchRoundResults,
  groupExportFileName,
  groupImportPlanLines,
  groupMembershipCandidates,
  groupMembershipChanges,
  insertGroupOrder,
  movedGroupOrder,
  parseGroupExportText,
  revokeDownloadUrlLater,
  resolveDropTarget,
  sidebarGroupBriefError,
  sidebarGroupBriefUsage,
  sidebarGroupNameError,
  sidebarPartitions,
  type GroupBatchMember,
  type GroupBatchResult,
  type SidebarGroupCandidate,
} from '../src/client/sidebar-groups.js'

// The picker imports the whole primitive set; this node test only needs the
// native Menu's shape (anchor always rendered, content only while open) and a
// Modal that renders its frame, so a group dialog can be read as text.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: h } = await import('react')
  const api: Record<string, unknown> = {
    Menu: (props: { anchor?: unknown; open?: boolean; children?: unknown }) =>
      h('div', { role: 'menu' }, props.anchor as never, props.open === true ? props.children as never : null),
    Modal: (props: {
      title?: unknown
      description?: unknown
      children?: unknown
      footer?: unknown
    }) => h(
      'div',
      { role: 'dialog' },
      h('div', null, props.title as never),
      h('div', null, props.description as never),
      props.children as never,
      h('div', null, props.footer as never),
    ),
  }
  // Icons are irrelevant here; unknown names resolve to a null component. The
  // module must never look thenable, or `await import()` never settles.
  return new Proxy(api, {
    get: (target, key) => {
      if (typeof key !== 'string' || key === 'then' || key === '__esModule') return undefined
      if (!(key in target)) target[key] = () => null
      return target[key]
    },
  })
})

import { NewChatPanel } from '../src/client/new-chat-panel.js'
import {
  SidebarGroupDialogs,
  sidebarGroupActionItems,
  sidebarGroupMenuItems,
} from '../src/client/sidebar-group-ui.js'

interface Row {
  id: string
  name: string
  group?: string
}

const row = (id: string, group?: string): Row => ({ id, name: id, ...(group === undefined ? {} : { group }) })
const project = (value: Row): SidebarGroupCandidate => ({
  id: value.id,
  name: value.name,
  ...(value.group === undefined ? {} : { group: value.group }),
})
const labels = <T>(partitions: ReturnType<typeof sidebarPartitions<T>>): Array<string | undefined> =>
  partitions.map(partition => partition.group)
const ids = <T>(partitions: ReturnType<typeof sidebarPartitions<T>>): string[][] =>
  partitions.map(partition => partition.items.map(item => (item as unknown as Row).id))

describe('sidebarPartitions', () => {
  it('keeps one unlabelled partition when no group exists, so the list is untouched', () => {
    const partitions = sidebarPartitions([], [row('a'), row('b')], value => value.group)

    expect(partitions).toHaveLength(1)
    expect(partitions[0]?.group).toBeUndefined()
    expect(partitions[0]?.id).toBe(UNGROUPED_PARTITION_ID)
    expect(ids(partitions)).toEqual([['a', 'b']])
  })

  it('follows the Host order and puts the ungrouped rows last', () => {
    const items = [row('loose'), row('b1', 'b'), row('a1', 'a')]
    const partitions = sidebarPartitions(['a', 'b'], items, value => value.group)

    expect(labels(partitions)).toEqual(['a', 'b', undefined])
    expect(ids(partitions)).toEqual([['a1'], ['b1'], ['loose']])
    expect(partitions[0]?.id).toBe('group:a')
  })

  it('renders an empty group as its own section', () => {
    const partitions = sidebarPartitions(['a', 'empty'], [row('a1', 'a')], value => value.group)

    expect(labels(partitions)).toEqual(['a', 'empty'])
    expect(ids(partitions)).toEqual([['a1'], []])
  })

  it('drops an empty ungrouped section instead of leaving a bare header', () => {
    const partitions = sidebarPartitions(['a'], [row('a1', 'a')], value => value.group)

    expect(labels(partitions)).toEqual(['a'])
  })

  it('falls back to ungrouped when a row names a group the list lost', () => {
    const partitions = sidebarPartitions(['a'], [row('ghost', 'gone'), row('a1', 'a')], value => value.group)

    expect(ids(partitions)).toEqual([['a1'], ['ghost']])
  })

  it('keeps row order inside a partition', () => {
    const partitions = sidebarPartitions(['a'], [row('a1', 'a'), row('a2', 'a')], value => value.group)

    expect(ids(partitions)).toEqual([['a1', 'a2']])
  })
})

describe('groupMembershipCandidates', () => {
  it('offers the group members first, then every ungrouped row, and no other group', () => {
    const items = [
      row('member', 'work'),
      row('loose'),
      row('elsewhere', 'play'),
      row('member2', 'work'),
    ]

    expect(groupMembershipCandidates('work', items, project).map(candidate => candidate.id))
      .toEqual(['member', 'member2', 'loose'])
  })
})

describe('groupMembershipChanges', () => {
  const candidates = groupMembershipCandidates(
    'work',
    [row('member', 'work'), row('loose'), row('newcomer')],
    project,
  )

  it('submits nothing when the checklist is untouched', () => {
    expect(groupMembershipChanges('work', candidates, new Set(['member']))).toEqual({ add: [], remove: [] })
  })

  it('adds a newly ticked ungrouped row and removes an unticked member', () => {
    const changes = groupMembershipChanges('work', candidates, new Set(['newcomer']))

    expect(changes.add.map(candidate => candidate.id)).toEqual(['newcomer'])
    expect(changes.remove.map(candidate => candidate.id)).toEqual(['member'])
  })

  it('treats every unticked row as a removal from the group', () => {
    const changes = groupMembershipChanges('work', candidates, new Set())

    expect(changes.add).toEqual([])
    expect(changes.remove.map(candidate => candidate.id)).toEqual(['member'])
  })
})

describe('movedGroupOrder', () => {
  it('swaps one group with its neighbour', () => {
    expect(movedGroupOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(movedGroupOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
  })

  it('returns the same order at either end or for an unknown group', () => {
    expect(movedGroupOrder(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
    expect(movedGroupOrder(['a', 'b'], 'b', 1)).toEqual(['a', 'b'])
    expect(movedGroupOrder(['a', 'b'], 'gone', 1)).toEqual(['a', 'b'])
  })
})

describe('resolveDropTarget', () => {
  it('assigns a row dropped on the ungrouped header', () => {
    expect(resolveDropTarget('row', 'ungrouped', 'after')).toEqual({ kind: 'assign', ungrouped: true })
  })

  it('assigns a row dropped on a named group header, on either half', () => {
    expect(resolveDropTarget('row', 'group', 'before')).toEqual({ kind: 'assign', ungrouped: false })
    expect(resolveDropTarget('row', 'group', 'after')).toEqual({ kind: 'assign', ungrouped: false })
  })

  it('inserts a dragged group on the hovered half of another header', () => {
    expect(resolveDropTarget('group', 'group', 'before')).toEqual({ kind: 'insert', half: 'before' })
    expect(resolveDropTarget('group', 'group', 'after')).toEqual({ kind: 'insert', half: 'after' })
  })

  it('reports none for every invalid combination', () => {
    // Rows carry no order field, so a row never reorders anything.
    expect(resolveDropTarget('row', 'row', 'before')).toEqual({ kind: 'none' })
    // The ungrouped header is not a group in the list: it cannot be reordered onto.
    expect(resolveDropTarget('group', 'ungrouped', 'after')).toEqual({ kind: 'none' })
    expect(resolveDropTarget('group', 'row', 'before')).toEqual({ kind: 'none' })
    expect(resolveDropTarget(undefined, 'group', 'after')).toEqual({ kind: 'none' })
    expect(resolveDropTarget('row', 'none', 'after')).toEqual({ kind: 'none' })
  })
})

describe('insertGroupOrder', () => {
  it('inserts before or after the target after leaving the old slot', () => {
    expect(insertGroupOrder(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(insertGroupOrder(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c'])
    // Moving down past a neighbour lands in the same place as moving it up.
    expect(insertGroupOrder(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
  })

  it('returns the same order for a no-op or an unknown label', () => {
    expect(insertGroupOrder(['a', 'b'], 'a', 'a', 'before')).toEqual(['a', 'b'])
    expect(insertGroupOrder(['a', 'b'], 'a', 'b', 'before')).toEqual(['a', 'b'])
    expect(insertGroupOrder(['a', 'b'], 'gone', 'a', 'after')).toEqual(['a', 'b'])
    expect(insertGroupOrder(['a', 'b'], 'a', 'gone', 'after')).toEqual(['a', 'b'])
  })
})

describe('sidebarGroupNameError', () => {
  it('refuses empty, over-long and duplicate labels', () => {
    expect(sidebarGroupNameError('   ', [])).toBe('分组名不能为空')
    expect(sidebarGroupNameError('x'.repeat(SIDEBAR_GROUP_MAX_CHARS + 1), [])).not.toBeUndefined()
    expect(sidebarGroupNameError('工作', ['工作'])).toBe('已存在同名分组')
    expect(sidebarGroupNameError('工作', ['别的'])).toBeUndefined()
    // The bound itself is allowed.
    expect(sidebarGroupNameError('x'.repeat(SIDEBAR_GROUP_MAX_CHARS), [])).toBeUndefined()
  })
})

describe('sidebarGroupBriefUsage', () => {
  it('counts characters against the Host cap', () => {
    expect(sidebarGroupBriefUsage('')).toBe(`0 / ${SIDEBAR_GROUP_BRIEF_MAX_CHARS}`)
    expect(sidebarGroupBriefUsage('分组')).toBe(`2 / ${SIDEBAR_GROUP_BRIEF_MAX_CHARS}`)
  })

  it('mirrors the Host constant instead of drifting from it', () => {
    expect(SIDEBAR_GROUP_BRIEF_MAX_CHARS).toBe(HOST_BRIEF_MAX_CHARS)
    expect(SIDEBAR_GROUP_BRIEF_MAX_CHARS).toBe(24_576)
  })
})

describe('sidebarGroupBriefError', () => {
  it('allows an empty brief and text exactly at the cap', () => {
    expect(sidebarGroupBriefError('')).toBeUndefined()
    expect(sidebarGroupBriefError('x'.repeat(SIDEBAR_GROUP_BRIEF_MAX_CHARS))).toBeUndefined()
  })

  it('refuses one character over the cap and names how much to remove', () => {
    const error = sidebarGroupBriefError('x'.repeat(SIDEBAR_GROUP_BRIEF_MAX_CHARS + 3))

    expect(error).toContain(String(SIDEBAR_GROUP_BRIEF_MAX_CHARS))
    expect(error).toContain('3')
  })
})

describe('group brief editor source contract', () => {
  const ui = readFileSync(new URL('../src/client/sidebar-group-ui.tsx', import.meta.url), 'utf8')
  const dialog = ui.slice(
    ui.indexOf('function GroupBriefDialog'),
    ui.indexOf('function GroupNameDialog'),
  )
  const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
  const briefCss = css.slice(
    css.indexOf('.sidebarGroupBriefForm'),
    css.indexOf('/* ── Sidebar drag & drop'),
  )

  it('opens from the existing group ⋯ menu as one more Menu row', () => {
    expect(ui).toContain("{ id: 'brief', label: '编辑分组简报'")
  })

  it('loads one brief on open and writes only through the user-only transport', () => {
    expect(dialog).toContain("callAgentTeam('sidebar.groups.briefs')")
    expect(dialog).toContain("callAgentTeam('sidebar.groups.brief.set', { name, brief: value })")
    // The sidebar keeps reading names only; this dialog never reads that list.
    expect(dialog).not.toContain("'sidebar.groups.list'")
  })

  it('shows the textarea, the counter, the 24 KB limit and the three states', () => {
    expect(dialog).toContain('<textarea')
    expect(dialog).toContain('sidebarGroupBriefUsage(value)')
    expect(dialog).toContain('SIDEBAR_GROUP_BRIEF_MAX_CHARS')
    expect(dialog).toContain('还没有简报')
    expect(dialog).toContain('已保存')
    expect(dialog).toContain('role="alert"')
    expect(dialog).toContain('role="status"')
    expect(dialog).toContain('overLimit')
  })

  it('stays on the native modal and text control, with no body host', () => {
    expect(dialog).toContain('<AnimatedModal')
    expect(ui).not.toContain('document.body')
    expect(ui).not.toContain('createPortal')
    expect(briefCss.length).toBeGreaterThan(0)
    expect(briefCss).not.toContain('position: fixed')
    expect(briefCss).not.toContain('z-index')
    // Theme tokens only; no colour system of its own.
    expect(briefCss).toContain('var(--dsw-')
    expect(briefCss).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('is wired into both sidebars through the existing dialog host', () => {
    const team = readFileSync(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')
    const assistant = readFileSync(
      new URL('../src/client/assistant-sidebar.tsx', import.meta.url),
      'utf8',
    )

    expect(team).toContain("{ kind: 'brief', name: group }")
    expect(assistant).toContain("{ kind: 'brief', name: group }")
    expect(team).toContain('<SidebarGroupDialogs')
    expect(assistant).toContain('<SidebarGroupDialogs')
  })
})

describe('native menu unification for the floating pickers', () => {
  const panel = readFileSync(new URL('../src/client/new-chat-panel.tsx', import.meta.url), 'utf8')
  const parallel = readFileSync(new URL('../src/client/team-parallel.tsx', import.meta.url), 'utf8')
  const mention = parallel.slice(
    parallel.indexOf('export function TeamMentionAction'),
    parallel.indexOf('function initial('),
  )
  const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
  const pickerCss = css.slice(css.indexOf('.newChatPicker {'), css.indexOf('.newChatSearch {'))
  const mentionCss = css.slice(css.indexOf('.teamMentionMenu {'), css.indexOf('.teamMentionTitle {'))

  it('opens the new-chat picker as a portalled host Menu anchored to the ＋ button', () => {
    expect(panel).toContain('<Menu')
    expect(panel).toContain('portal')
    expect(panel).toContain('getAnchorRect')
    expect(panel).toContain('listClassName={css.newChatPicker}')
    // The picker no longer builds its own body host or coordinates; only the
    // host Menu's getAnchorRect hook reads the trigger rect.
    expect(panel).not.toContain('createPortal')
    expect(panel).not.toContain('document.body')
    expect(panel).not.toContain('window.innerWidth')
    expect(panel).not.toContain('document.addEventListener')
  })

  it('keeps the picker content and actions inside the native surface', () => {
    const anchor = {
      isConnected: true,
      focus: () => undefined,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
    } as unknown as HTMLElement
    const markup = renderToStaticMarkup(createElement(NewChatPanel, {
      anchor,
      entries: [{ id: 'chief', name: 'Chief', portrait: 'C', hint: '总协调' }],
      onClose: () => undefined,
      onNewAssistant: () => undefined,
      onNewTeam: () => undefined,
      onPick: () => undefined,
    }))
    expect(markup).toContain('role="menu"')
    expect(markup).toContain('aria-label="新对话：选择助手"')
    expect(markup).toContain('placeholder="跟谁聊？搜索助手"')
    expect(markup).toContain('新建助手')
    expect(markup).toContain('新建团队')
    expect(markup).toContain('创建分组')
    expect(markup).toContain('Chief')
    expect(markup).toContain('总协调')
    // One surface, not a second bespoke dialog layer.
    expect(markup).not.toContain('role="dialog"')
    expect(panel).toContain('onPick(id)')
    expect(panel).toContain('onNewAssistant()')
  })

  it('opens the @ picker as a portalled host Menu anchored to the @ button', () => {
    expect(mention).toContain('<Menu')
    expect(mention).toContain('portal')
    expect(mention).toContain('autoFocus')
    expect(mention).toContain('side="top"')
    expect(mention).toContain('listClassName={css.teamMentionMenu}')
    expect(mention).toContain('role="menuitem"')
    // Host Menu owns placement, dismissal and the keyboard walk now.
    expect(mention).not.toContain('createPortal')
    expect(mention).not.toContain('document.body')
    expect(mention).not.toContain('getBoundingClientRect')
    expect(mention).not.toContain("addEventListener('scroll'")
    expect(mention).not.toContain('document.addEventListener')
  })

  it('leaves no fixed or globally layered picker styles behind', () => {
    expect(pickerCss.length).toBeGreaterThan(0)
    expect(mentionCss.length).toBeGreaterThan(0)
    for (const block of [pickerCss, mentionCss]) {
      expect(block).not.toContain('position: fixed')
      expect(block).not.toContain('z-index')
      expect(block).not.toContain('background:')
      expect(block).not.toContain('box-shadow:')
    }
    // The bespoke card classes are gone; the host Menu paints the surface.
    expect(css).not.toContain('.newChatPanel {')
    expect(css).not.toContain('.teamMentionPopover {')
  })
})

describe('native overlays for the session header and the enlarged conversation', () => {
  const chrome = readFileSync(new URL('../src/client/team-member-chrome.tsx', import.meta.url), 'utf8')
  const teamPanel = readFileSync(new URL('../src/client/teams/TeamPanel.tsx', import.meta.url), 'utf8')
  const columnCss = readFileSync(
    new URL('../src/client/workbench/ConversationColumn.module.css', import.meta.url),
    'utf8',
  )
  const components = readFileSync(new URL('../src/client/components.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
  const expandedColumnCss = columnCss.slice(
    columnCss.indexOf('.conversationColumnExpanded {'),
    columnCss.indexOf('.conversationColumnExpanded .columnHeader {'),
  )

  it('moved member add out of the Session header', () => {
    // The header owns one control now: the Session switcher. Adding a member
    // had a second entry all along (team page → 添加助手), so the ＋ and its
    // search panel left with the old member selector.
    expect(chrome).not.toContain('添加成员')
    expect(chrome).not.toContain('team.addMember')
    expect(chrome).not.toContain('memberAdd')
    expect(css).not.toContain('.memberAddWrap')
    expect(css).not.toContain('.memberAddScrim')
    expect(css).not.toContain('.memberAddPanel')
  })

  it('keeps adding members reachable from the team page dialog', () => {
    expect(teamPanel).toContain('添加助手')
    expect(teamPanel).toContain("callAgentTeam('team.addMember'")
    expect(teamPanel).toContain('同一个助手可以多次加入')
  })

  it('enlarges a conversation in a headless host Modal instead of a fixed layer', () => {
    expect(teamPanel).toContain('headless')
    expect(teamPanel).toContain('css.conversationExpandedModal')
    expect(teamPanel).toContain('conversationCss.conversationColumnExpanded')
    // The column is no longer enlarged in place, and no bespoke backdrop or
    // page Escape listener is left.
    expect(teamPanel).not.toContain('conversationFocusBackdrop')
    expect(teamPanel).not.toContain("window.addEventListener('keydown'")
    expect(teamPanel).not.toContain('expanded={expandedSlotId === member.id}')
    expect(css).not.toContain('.conversationFocusBackdrop')
    // The one remaining expanded instance keeps the same wiring.
    expect(teamPanel).toContain('onSent={load}')
    expect(teamPanel).toContain('onTeamChanged={onChanged}')
    expect(teamPanel).toContain('onExpandedChange={next => { if (!next) setExpandedSlotId(undefined) }}')
    // The modal frame owns the size; the column styles stay presentation-only.
    expect(css).toContain('.conversationExpandedModal')
    expect(expandedColumnCss.length).toBeGreaterThan(0)
    expect(expandedColumnCss).not.toContain('position: fixed')
    expect(expandedColumnCss).not.toContain('z-index')
    expect(expandedColumnCss).not.toContain('animation:')
  })

  it('removes the dead floating launcher and its CSS', () => {
    expect(components).not.toContain('FloatingTeamLauncher')
    expect(components).not.toContain('AgentTeamOverlay')
    expect(components).not.toContain('floatingLauncher')
    expect(css).not.toContain('floatingTeamLauncher')
  })
})

describe('initial focus in the unified pickers', () => {
  const panel = readFileSync(new URL('../src/client/new-chat-panel.tsx', import.meta.url), 'utf8')
  const chrome = readFileSync(new URL('../src/client/team-member-chrome.tsx', import.meta.url), 'utf8')

  it('focuses the new-chat search on the Menu placement frame, not on mount', () => {
    // The host Menu renders its list visibility:hidden for one measuring pass,
    // so a mount-time focus() silently fails. The focus must wait a frame.
    expect(panel).toContain(
      'const frame = requestAnimationFrame(() => { inputRef.current?.focus() })',
    )
    expect(panel).toContain('cancelAnimationFrame(frame)')
    expect(panel).toContain('ref={inputRef}')
    // No competing immediate focus and no bespoke listener to emulate it.
    expect(panel).not.toContain('inputRef.current?.focus()\n  }, [])')
    expect(panel).not.toContain('autoFocus')
  })

  it('focuses the session-switcher search on the Menu placement frame, not via autoFocus', () => {
    expect(chrome).toContain('const searchRef = useRef<HTMLInputElement>(null)')
    expect(chrome).toContain(
      'const frame = requestAnimationFrame(() => { searchRef.current?.focus() })',
    )
    expect(chrome).toContain('cancelAnimationFrame(frame)')
    expect(chrome).toContain('}, [open])')
    expect(chrome).toContain('ref={searchRef}')
    // The search waits for the frame; only an inline rename field may autofocus.
    const searchInput = chrome.slice(
      chrome.lastIndexOf('<input', chrome.indexOf('aria-label="搜索成员或会话"')),
      chrome.indexOf('aria-label="搜索成员或会话"'),
    )
    expect(searchInput).not.toContain('autoFocus')
  })

  it('leaves arrows, Tab and Escape to the native menu surface', () => {
    for (const source of [panel, chrome]) {
      // The host Menu owns dismissal/focus return; no page-level key or
      // pointer listeners may be reintroduced to fake it.
      expect(source).not.toContain('document.addEventListener')
      expect(source).not.toContain("addEventListener('keydown'")
      expect(source).not.toContain("addEventListener('pointerdown'")
    }
    // New chat: arrows keep focus in the search while moving its own cursor;
    // Escape closes via the Menu and unmount returns focus to the shipped ＋.
    expect(panel).toContain("event.key === 'ArrowDown'")
    expect(panel).toContain("event.key === 'ArrowUp'")
    expect(panel).not.toContain("event.key === 'Escape'")
    expect(panel).not.toContain("event.key === 'Tab'")
    expect(panel).toContain('trigger?.focus()')
    // Session switcher: native menu rows, so the Menu walks them and Tab settles them.
    expect(chrome).toContain('role="menuitem"')
    expect(chrome).not.toContain("event.key === 'Tab'")
    // The one local Escape cancels the inline rename; it is not menu dismissal.
    expect(chrome).toMatch(/onKeyDown=\{event => \{[\s\S]{0,400}event\.key === 'Escape'[\s\S]{0,200}setRenaming\(undefined\)/)
  })
})

interface BatchRow {
  id: string
  name: string
  group?: string
  status: string
  provider: string
  model: string
}

const batchRow = (
  id: string,
  status: string,
  group?: string,
  provider = 'deepseek',
  model = 'deepseek-chat',
): BatchRow => ({
  id,
  name: `name-${id}`,
  ...(group === undefined ? {} : { group }),
  status,
  provider,
  model,
})
const batchProject = (value: BatchRow): {
  id: string
  name: string
  group?: string
  status: string
  provider: string
  model: string
} => ({
  id: value.id,
  name: value.name,
  ...(value.group === undefined ? {} : { group: value.group }),
  status: value.status,
  provider: value.provider,
  model: value.model,
})

describe('groupBatchMembers', () => {
  const items = [
    batchRow('a1', 'idle', 'work'),
    batchRow('elsewhere', 'idle', 'play'),
    batchRow('loose', 'idle'),
    batchRow('a2', 'active', 'work', 'other', 'other-large'),
    batchRow('gone', 'archived', 'work'),
  ]

  it('lists only that group, and never an archived row', () => {
    expect(groupBatchMembers('work', items, batchProject)).toEqual([
      { id: 'a1', name: 'name-a1', model: { provider: 'deepseek', model: 'deepseek-chat' } },
      { id: 'a2', name: 'name-a2', model: { provider: 'other', model: 'other-large' } },
    ])
  })

  it('carries each row\'s own model, so a mixed-model group is visible', () => {
    // The thinking list is a union over these references; dropping them would
    // force the dialog back to one model's levels.
    expect(groupBatchMembers('work', items, batchProject).map(member => member.model))
      .toEqual([
        { provider: 'deepseek', model: 'deepseek-chat' },
        { provider: 'other', model: 'other-large' },
      ])
  })

  it('takes no search query, so a typed filter cannot shrink the batch', () => {
    // Three inputs: the group, the rows, the projection. A query parameter would
    // be the way the sidebar's search could hide rows from the batch.
    expect(groupBatchMembers).toHaveLength(3)
    expect(groupBatchMembers('work', items, batchProject)).toHaveLength(2)
  })

  it('answers an empty list for a group without members', () => {
    expect(groupBatchMembers('empty', items, batchProject)).toEqual([])
  })
})

describe('groupBatchModelRefs', () => {
  const member = (id: string, provider: string, model: string): GroupBatchMember => ({
    id,
    name: id,
    model: { provider, model },
  })

  it('lists each model once, in member order', () => {
    const members = [
      member('a', 'deepseek', 'deepseek-chat'),
      member('b', 'other', 'other-large'),
      member('c', 'deepseek', 'deepseek-chat'),
    ]

    expect(groupBatchModelRefs(members)).toEqual([
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'other', model: 'other-large' },
    ])
  })

  it('appends a model picked in the dialog, without duplicating one already used', () => {
    const members = [member('a', 'deepseek', 'deepseek-chat')]

    expect(groupBatchModelRefs(members, { provider: 'third', model: 'third-mini' }))
      .toEqual([
        { provider: 'deepseek', model: 'deepseek-chat' },
        { provider: 'third', model: 'third-mini' },
      ])
    expect(groupBatchModelRefs(members, { provider: 'deepseek', model: 'deepseek-chat' }))
      .toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }])
  })

  it('answers no references for an empty group', () => {
    expect(groupBatchModelRefs([])).toEqual([])
  })
})

describe('groupBatchLevels', () => {
  it('unions the levels of every model in the group, first seen wins', () => {
    expect(groupBatchLevels([
      [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      [{ id: 'high', name: 'High（另一个模型）' }, { id: 'max', name: 'Max' }],
    ])).toEqual([
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Max' },
    ])
  })

  it('offers one level for a mixed-model group where only one model serves it', () => {
    // m1 serves 'high', m2 serves only 'low'. The union is still offered and the
    // Host refuses m2's row on its own, which is the designed per-row rejection.
    const levels = groupBatchLevels([
      [{ id: 'high', name: 'High' }],
      [{ id: 'low', name: 'Low' }],
    ])

    expect(levels.map(level => level.id)).toEqual(['high', 'low'])
  })

  it('answers no levels when no model serves any (or a read failed)', () => {
    expect(groupBatchLevels([])).toEqual([])
    expect(groupBatchLevels([[], []])).toEqual([])
  })
})

describe('groupBatchLevelNeedsDefault', () => {
  const served = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]

  it('keeps a level the newly picked model serves', () => {
    expect(groupBatchLevelNeedsDefault('high', served)).toBe(false)
  })

  it('narrows a level the newly picked model cannot serve', () => {
    // Every row gets the same model+level pair, so this would be refused
    // uniformly instead of per row.
    expect(groupBatchLevelNeedsDefault('max', served)).toBe(true)
    expect(groupBatchLevelNeedsDefault('high', [])).toBe(true)
  })

  it('never narrows 模型默认, an untouched pick, or a failed capability read', () => {
    expect(groupBatchLevelNeedsDefault('', served)).toBe(false)
    expect(groupBatchLevelNeedsDefault(undefined, served)).toBe(false)
    // Unknown is not "no levels": a read error must not drop a valid pick.
    expect(groupBatchLevelNeedsDefault('max', undefined)).toBe(false)
  })
})

describe('groupBatchPatch', () => {
  it('sends nothing when no picker was touched', () => {
    expect(groupBatchPatch({})).toBeUndefined()
  })

  it('writes the provider with the model, never one half alone', () => {
    expect(groupBatchPatch({ model: { provider: 'deepseek', model: 'deepseek-chat' } }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('carries one explicit level, the clearing value included', () => {
    expect(groupBatchPatch({ reasoningEffort: 'high' })).toEqual({ reasoningEffort: 'high' })
    expect(groupBatchPatch({ reasoningEffort: '' })).toEqual({ reasoningEffort: '' })
  })

  it('writes a permission preset on its own', () => {
    expect(groupBatchPatch({ permissionPresetId: 'workspace-write' }))
      .toEqual({ permissionPresetId: 'workspace-write' })
  })

  it('keeps all three axes in one patch, and never a group label', () => {
    const patch = groupBatchPatch({
      model: { provider: 'p', model: 'm' },
      reasoningEffort: 'high',
      permissionPresetId: 'read-only',
    })

    expect(patch).toEqual({
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
      permissionPresetId: 'read-only',
    })
    // Batch membership is the filter, not a write: a group label here would
    // move rows the user never asked to move.
    expect(Object.keys(patch ?? {})).not.toContain('group')
  })
})

describe('applyGroupBatch', () => {
  const members = [
    { id: 'a1', name: '助手一' },
    { id: 'a2', name: '助手二' },
    { id: 'a3', name: '助手三' },
  ]

  it('reports one outcome per member, in list order, and keeps going after a refusal', async () => {
    const written: string[] = []
    const results = await applyGroupBatch(
      members,
      { permissionPresetId: 'read-only' },
      async id => {
        written.push(id)
        if (id === 'a2') throw new Error('Unknown permission preset')
        return undefined
      },
    )

    // No rollback: the refusal does not undo a1, and it does not stop a3.
    expect(written).toEqual(['a1', 'a2', 'a3'])
    expect(results).toEqual([
      { id: 'a1', name: '助手一' },
      { id: 'a2', name: '助手二', error: 'Unknown permission preset' },
      { id: 'a3', name: '助手三' },
    ])
  })

  it('applies a thinking-only level to a mixed-model group, refusing only the rows that cannot serve it', async () => {
    // Two models: one serves 'high', the other does not. The batch sends the
    // level alone — no provider/model — and the Host's refusal lands on that
    // row while its neighbours still apply.
    const patch = groupBatchPatch({ reasoningEffort: 'high' })
    expect(patch).toEqual({ reasoningEffort: 'high' })
    expect(Object.keys(patch ?? {})).not.toContain('provider')
    expect(Object.keys(patch ?? {})).not.toContain('model')

    const written: string[] = []
    const results = await applyGroupBatch(
      [
        { id: 'small-model', name: '小模型助手' },
        { id: 'big-model', name: '大模型助手' },
      ],
      patch as { reasoningEffort: string },
      async id => {
        written.push(id)
        if (id === 'small-model') {
          throw new Error("MODEL_REFERENCE_INVALID: model 'deepseek-chat' does not support effort 'high'")
        }
        return undefined
      },
    )

    expect(written).toEqual(['small-model', 'big-model'])
    expect(results.find(result => result.id === 'small-model')?.error)
      .toContain('does not support effort')
    expect(results.find(result => result.id === 'big-model')?.error).toBeUndefined()
  })

  it('names a non-Error refusal instead of dropping it', async () => {
    const results = await applyGroupBatch(members.slice(0, 1), { reasoningEffort: 'high' }, async () => {
      throw 'MODEL_REFERENCE_INVALID'
    })

    expect(results).toEqual([{ id: 'a1', name: '助手一', error: 'MODEL_REFERENCE_INVALID' }])
  })

  it('writes nothing for an empty group', async () => {
    const write = vi.fn()
    expect(await applyGroupBatch([], { reasoningEffort: 'high' }, write)).toEqual([])
    expect(write).not.toHaveBeenCalled()
  })
})

describe('groupBatchPendingMembers', () => {
  const members = [
    { id: 'a1', name: '助手一' },
    { id: 'a2', name: '助手二' },
    { id: 'a3', name: '助手三' },
  ]

  it('writes every member on the first apply', () => {
    expect(groupBatchPendingMembers(members, undefined)).toEqual(members)
  })

  it('retries only the refused rows, never one that already landed', () => {
    const results: GroupBatchResult[] = [
      { id: 'a1', name: '助手一' },
      { id: 'a2', name: '助手二', error: 'MODEL_REFERENCE_INVALID' },
      { id: 'a3', name: '助手三' },
    ]

    // a1/a3 already landed; rewriting them would count them again.
    expect(groupBatchPendingMembers(members, results))
      .toEqual([{ id: 'a2', name: '助手二' }])
  })

  it('keeps a row a retry skipped as 未变化 out of the next retry', () => {
    const results: GroupBatchResult[] = [
      { id: 'a1', name: '助手一', unchanged: true },
      { id: 'a2', name: '助手二', error: 'refused again' },
    ]

    expect(groupBatchPendingMembers(members.slice(0, 2), results))
      .toEqual([{ id: 'a2', name: '助手二' }])
  })
})

describe('groupBatchRoundResults', () => {
  const members = [
    { id: 'a1', name: '助手一' },
    { id: 'a2', name: '助手二' },
  ]

  it('keeps the first round\'s outcomes as written', () => {
    expect(groupBatchRoundResults(members, [
      { id: 'a1', name: '助手一' },
      { id: 'a2', name: '助手二', error: 'MODEL_REFERENCE_INVALID' },
    ])).toEqual([
      { id: 'a1', name: '助手一' },
      { id: 'a2', name: '助手二', error: 'MODEL_REFERENCE_INVALID' },
    ])
  })

  it('reads a row a retry skipped as 未变化, not as another 已更新', () => {
    // The retry wrote only a2; a1 was already landed and must not be counted.
    expect(groupBatchRoundResults(members, [
      { id: 'a2', name: '助手二', error: 'still refused' },
    ])).toEqual([
      { id: 'a1', name: '助手一', unchanged: true },
      { id: 'a2', name: '助手二', error: 'still refused' },
    ])
  })
})

describe('group batch settings source contract', () => {
  const source = readFileSync(new URL('../src/client/sidebar-group-ui.tsx', import.meta.url), 'utf8')
  const moduleCss = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
  const dialog = source.slice(
    source.indexOf('function GroupBatchDialog'),
    source.indexOf('/** Renaming keeps the one-field dialog'),
  )
  const batchRules = [...moduleCss.matchAll(/\.groupBatch[\w]*(?::hover)?\s*\{[^}]*\}/g)]
    .map(match => match[0])

  it('offers 批量设置… in the group header menu', () => {
    expect(sidebarGroupMenuItems(['甲组', '乙组'], '甲组').map(entry => entry.id)).toContain('batch')
    expect(source).toContain("label: '批量设置…'")
  })

  it('opens one native modal titled after the group', () => {
    const markup = renderToStaticMarkup(createElement(SidebarGroupDialogs, {
      dialog: { kind: 'batch', group: '甲组' },
      groups: ['甲组'],
      onClose: () => {},
      onListChanged: () => {},
      onChanged: () => {},
    }))

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('批量设置「甲组」')
    // The one thing the dialog promises before any write.
    expect(markup).toContain('不会回滚')
  })

  it('reads membership from a fresh list instead of the rendered section', () => {
    expect(dialog).toContain("callAgentTeam('assistant.instance.list'")
    expect(dialog).toContain('groupBatchMembers(')
    // A search-filtered partition would silently shrink the batch.
    expect(dialog).not.toContain('partition.')
  })

  it('offers the three pickers through the shared select, and writes one by one', () => {
    expect(dialog).toContain('ariaLabel="模型"')
    expect(dialog).toContain('ariaLabel="思考模式"')
    expect(dialog).toContain('ariaLabel="权限"')
    expect(dialog.match(/<SelectControl/g) ?? []).toHaveLength(3)
    // A retry writes the pending rows only.
    expect(dialog).toContain('applyGroupBatch(pending, patch')
    expect(dialog).toContain("callAgentTeam('assistant.instance.update', { id, value })")
    // The batch is a settings write only; a group label would move the rows.
    expect(dialog).not.toContain('value: { group')
  })

  it('shows one row per assistant with its own outcome, and a clear empty state', () => {
    expect(dialog).toContain('data-dsh-group-batch-row={member.id}')
    expect(dialog).toContain('data-dsh-group-batch-failed')
    expect(dialog).toContain('已更新')
    // A row a retry left alone says 未变化 instead of counting as changed again.
    expect(dialog).toContain('未变化')
    expect(dialog).toContain('个被拒绝')
    expect(dialog).toContain('还没有助手')
    expect(dialog).toContain('data-dsh-group-batch-empty')
  })

  it('lets the user retry from the same dialog without rewriting landed rows', () => {
    expect(dialog).toContain('groupBatchPendingMembers(members, results)')
    expect(dialog).toContain('groupBatchRoundResults(members, written)')
    expect(dialog).toContain('重试 ${pending.length} 个被拒绝的助手')
    expect(dialog).toContain('未变化 ${unchanged} 个')
    // The pickers stay usable after an apply: the user may narrow a rejected
    // level first, then retry the refused rows only.
    expect(dialog).not.toContain('disabled={locked')
    expect(dialog).not.toContain('const locked =')
  })

  it('treats thinking as its own axis over the group\'s models', () => {
    // The union, read from every model the group uses — not from whichever model
    // the model picker happens to hold.
    expect(dialog).toContain('groupBatchModelRefs(')
    expect(dialog).toContain('groupBatchLevels(')
    expect(dialog).toContain("callAgentTeam('catalog.model.get'")
    // The old rule: thinking disabled until a model was picked, levels from that
    // one model. Both are gone.
    expect(dialog).not.toContain('disabled={locked || pickedModel')
    expect(dialog).not.toContain('useModelCapabilities')
    expect(dialog).not.toContain('modelControlReasoning')
    // A thinking pick is its own row value; the model picker stays untouched.
    expect(dialog).toContain("options={thinkingOptions}")
    expect(dialog).toContain("label: '模型默认'")
    expect(dialog).toContain('档位来自组内各模型的并集')
    // Per-row rejection stays the Host's call.
    expect(dialog).toContain('不支持所选档位的助手会被单独拒绝')
  })

  it('offers a thinking-only patch without pairing it with a model', () => {
    // groupBatchPatch already proves the patch shape; this pins that the dialog
    // does not synthesise a model reference when only the level is picked.
    expect(dialog).toContain('...(pickedProvider === \'\' || pickedModel === \'\'')
    expect(dialog).toContain('reasoningEffort: thinkingEffort')
  })

  it('narrows a level the newly picked model cannot serve to 模型默认', () => {
    // The picked model's own levels are kept per reference, so the narrowing
    // reads that model instead of the union.
    expect(dialog).toContain('groupBatchModelKey(')
    expect(dialog).toContain('effortsByModel.get(')
    expect(dialog).toContain('groupBatchLevelNeedsDefault(')
    expect(dialog).toContain("setThinkingRow(modelControlEffortRow(''))")
    // The narrowing cannot wait for the read if apply fires first.
    expect(dialog).toContain('levelsPending')
  })

  it('never turns a failed catalog onto the empty state', () => {
    // Three reads settle separately, so one failure cannot fake an empty group.
    expect(dialog).toContain('Promise.allSettled')
    expect(dialog).toContain('data-dsh-group-batch-failed-load')
    expect(dialog).toContain('读取助手列表失败')
    expect(dialog).toContain('重试')
    expect(dialog).toContain('data-dsh-group-batch-catalog-error')
    // The empty state is only reachable from a successful roster read.
    const emptyAt = dialog.indexOf('data-dsh-group-batch-empty')
    const failedAt = dialog.indexOf('data-dsh-group-batch-failed-load')
    expect(failedAt).toBeGreaterThan(-1)
    expect(emptyAt).toBeGreaterThan(failedAt)
    expect(dialog).toContain('membersError !== undefined')
  })

  it('says teams are untouched when the group holds teams but no assistants', () => {
    expect(dialog).toContain("callAgentTeam('team.list'")
    expect(dialog).toContain('个团队，没有助手')
    expect(dialog.match(/团队不受影响/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('uses the native modal/button and no page-level layer', () => {
    expect(dialog).toContain('<AnimatedModal')
    expect(dialog).toContain('<Button')
    expect(dialog).not.toContain('createPortal')
    expect(dialog).not.toContain('position: fixed')
    expect(dialog).not.toContain('zIndex')
    expect(source).not.toContain('createPortal')
  })

  it('styles the dialog with semantic tokens and no positioning of its own', () => {
    expect(batchRules.length).toBeGreaterThan(6)
    for (const rule of batchRules) {
      expect(rule).not.toContain('position:')
      expect(rule).not.toContain('z-index')
      expect(rule).not.toContain('!important')
    }
    const joined = batchRules.join('\n')
    expect(joined).not.toMatch(/#[0-9a-f]{3,8}/i)
    expect(joined).not.toMatch(/\brgb\(/)
    expect(joined).toContain('var(--dsw-alias-label-primary)')
    expect(joined).toContain('var(--dsw-alias-state-success-primary)')
    expect(joined).toContain('var(--dsw-alias-state-error-primary)')
  })
})

describe('parseGroupExportText', () => {
  it('asks for a document when the editor is blank', () => {
    expect(parseGroupExportText('  \n\t ')).toEqual({
      ok: false,
      error: '请粘贴分组导出的 JSON，或选择一个文件',
    })
  })

  it('names malformed JSON instead of clearing the editor', () => {
    const outcome = parseGroupExportText('{"kind": ')

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('JSON')
  })

  it('refuses anything that is not one JSON object', () => {
    for (const text of ['[]', 'null', '42', '"text"', 'true']) {
      const outcome = parseGroupExportText(text)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain('JSON 对象')
    }
  })

  it('keeps the document exactly as parsed, including keys it does not know', () => {
    // The Host owns the schema and the plan hash. Re-serialising here would
    // change what the apply sends and could earn a stale-preview refusal.
    const outcome = parseGroupExportText(JSON.stringify({
      kind: GROUP_SHARE_KIND,
      schemaVersion: 1,
      future: { keep: [1, 2, 3] },
    }))

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.document).toEqual({
        kind: GROUP_SHARE_KIND,
        schemaVersion: 1,
        future: { keep: [1, 2, 3] },
      })
      expect(Object.keys(outcome.document)).toEqual(['kind', 'schemaVersion', 'future'])
    }
  })

  it('pins the client file-size guard to the Host cap', () => {
    expect(GROUP_SHARE_MAX_DOCUMENT_BYTES).toBe(HOST_GROUP_SHARE_MAX_DOCUMENT_BYTES)
  })
})

describe('groupExportFileName', () => {
  it('keeps a readable group name and adds the portable suffix', () => {
    expect(groupExportFileName('工作')).toBe('工作.group.json')
    expect(groupExportFileName(' 工作 ')).toBe('工作.group.json')
  })

  it('turns characters a filesystem would refuse into dashes', () => {
    expect(groupExportFileName('a/b:c*d?"e<f>g|h')).toBe('a-b-c-d--e-f-g-h.group.json')
    expect(groupExportFileName('a\u0000b\u001fc')).toBe('a-b-c.group.json')
  })

  it('falls back to a name and stays under the cap for odd input', () => {
    expect(groupExportFileName('   ')).toBe('group.group.json')
    expect(groupExportFileName('.').endsWith('.group.json')).toBe(true)

    const long = groupExportFileName('长'.repeat(120))
    expect(long.endsWith('.group.json')).toBe(true)
    expect(long.length).toBe(60 + '.group.json'.length)
  })
})

const portableProfile = (name: string): PortableAssistantProfile => ({
  name,
  instructions: '你是研究员。',
  provider: 'deepseek',
  model: 'deepseek-chat',
  agentPresetId: 'default',
  permissionPresetId: 'workspace-write',
  skillAllowlist: [],
  mcpServers: [],
})

const importPreview = (overrides: Partial<GroupImportPreview> = {}): GroupImportPreview => ({
  schemaVersion: 1,
  group: { requested: '工作', plannedName: '工作 (2)', renamed: true, briefChars: 12 },
  assistants: [
    { name: '研究员', plannedName: '研究员', action: 'create', profile: portableProfile('研究员') },
    {
      name: '旧模型助手',
      plannedName: '旧模型助手',
      action: 'skip',
      reason: "unknown model 'gone/model'",
    },
  ],
  templates: [{ name: '研究员', plannedName: '研究员', action: 'create', profile: portableProfile('研究员') }],
  teams: [{
    name: '小队',
    plannedName: '小队',
    action: 'create',
    members: [{
      displayName: '组长',
      role: 'leader',
      templateName: '研究员',
      permissionPresetId: 'workspace-write',
    }],
  }],
  skills: [{ name: 'mine', available: false }],
  mcpServers: [],
  warnings: ['Portable documents carry mascot identities, not avatar photos.'],
  counts: { assistants: 1, templates: 1, teams: 1, members: 1, skipped: 1 },
  planHash: 'a'.repeat(64),
  ...overrides,
})

describe('groupImportPlanLines', () => {
  it('lists the group first, with its collision suffix and brief size', () => {
    const [first] = groupImportPlanLines(importPreview())

    expect(first).toEqual({
      key: '0:group',
      kind: 'group',
      name: '工作',
      plannedName: '工作 (2)',
      action: 'create',
      note: '同名分组已存在，导入为「工作 (2)」',
      detail: '简报 12 字',
    })
  })

  it('leaves the suffix note off when the planned name is unchanged', () => {
    const preview = importPreview({
      group: { requested: '工作', plannedName: '工作', renamed: false, briefChars: 0 },
    })

    expect(groupImportPlanLines(preview)[0]).toEqual({
      key: '0:group',
      kind: 'group',
      name: '工作',
      plannedName: '工作',
      action: 'create',
    })
  })

  it('keeps every skipped row and its reason', () => {
    const skipped = groupImportPlanLines(importPreview())
      .find(line => line.kind === 'assistant' && line.action === 'skip')

    expect(skipped).toEqual({
      key: '2:assistant',
      kind: 'assistant',
      name: '旧模型助手',
      plannedName: '旧模型助手',
      action: 'skip',
      note: "unknown model 'gone/model'",
    })
  })

  it('says a template is reused and how many members a team carries', () => {
    const lines = groupImportPlanLines(importPreview({
      templates: [{
        name: '研究员',
        plannedName: '研究员',
        action: 'reuse',
        profile: portableProfile('研究员'),
      }],
    }))

    expect(lines.find(line => line.kind === 'template')).toMatchObject({
      action: 'reuse',
      note: '复用本地相同的助手模板',
    })
    expect(lines.find(line => line.kind === 'team')).toMatchObject({
      action: 'create',
      detail: '1 名成员',
    })
  })

  it('flattens in review order: group, assistants, templates, teams', () => {
    expect(groupImportPlanLines(importPreview()).map(line => line.kind))
      .toEqual(['group', 'assistant', 'assistant', 'template', 'team'])
  })
})

describe('group export/import dialog source contract', () => {
  const ui = readFileSync(new URL('../src/client/sidebar-group-ui.tsx', import.meta.url), 'utf8')
  const exportDialog = ui.slice(
    ui.indexOf('function GroupExportDialog'),
    ui.indexOf('function GroupImportDialog'),
  )
  const importDialog = ui.slice(ui.indexOf('function GroupImportDialog'))
  const moduleCss = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
  const shareCss = moduleCss.slice(
    moduleCss.indexOf('.groupShareForm {'),
    moduleCss.indexOf('/* ── Sidebar drag & drop'),
  )

  it('offers 导出分组 / 导入分组 in the shared group ⋯ menu', () => {
    const entries = sidebarGroupMenuItems(['甲组', '乙组'], '甲组')
    // MenuEntry is a union with separators, which carry no label.
    const labelOf = (id: string): unknown => {
      const entry = entries.find(candidate => candidate.id === id)
      return entry !== undefined && 'label' in entry ? entry.label : undefined
    }

    expect(labelOf('export')).toBe('导出分组')
    expect(labelOf('import')).toBe('导入分组')
    expect(ui).toContain("label: '导出分组'")
    expect(ui).toContain("label: '导入分组'")
  })

  it('opens the export as one native modal showing the portable JSON', () => {
    const markup = renderToStaticMarkup(createElement(SidebarGroupDialogs, {
      dialog: { kind: 'export', name: '甲组' },
      groups: ['甲组'],
      onClose: () => {},
      onListChanged: () => {},
      onChanged: () => {},
    }))

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('导出分组「甲组」')
    expect(markup).toContain('data-dsh-group-export-omitted')
    // The two static omissions the user must know before sharing the file.
    expect(markup).toContain('头像照片不会导出')
    expect(markup).toContain('助手提示词（prompts）是本机记录')
    // The footer buttons come from the shared primitive (null in this mock), so
    // their copy is pinned on the source instead of the rendered text.
    expect(exportDialog).toContain('复制 JSON')
    expect(exportDialog).toContain('下载文件')
    expect(exportDialog).toContain("callAgentTeam('sidebar.groups.export', { name })")
    expect(exportDialog).toContain('readOnly')
    expect(exportDialog).toContain('writeClipboard(text)')
    expect(exportDialog).toContain('URL.createObjectURL')
    expect(exportDialog).toContain('anchor.download = groupExportFileName(name)')
  })

  it('opens the import as one native modal with paste, file and workspace pickers', () => {
    const markup = renderToStaticMarkup(createElement(SidebarGroupDialogs, {
      dialog: { kind: 'import' },
      groups: ['甲组'],
      onClose: () => {},
      onListChanged: () => {},
      onChanged: () => {},
    }))

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('导入分组')
    expect(markup).toContain('data-dsh-group-import-source')
    expect(markup).toContain('type="file"')
    expect(markup).toContain('accept=".json,application/json"')
    expect(importDialog).toContain('预览导入')
    expect(importDialog).toContain('取消')
    // Prompts are not carried and the dialog says so up front.
    expect(markup).toContain('提示词（prompts）、会话、记忆和头像照片都不在导入范围内')
    expect(importDialog).toContain('await file.text()')
    expect(importDialog).toContain('GROUP_SHARE_MAX_DOCUMENT_BYTES')
    // Cancel is the native close, and an edit never writes.
    expect(importDialog).toContain('disabled={busy} onClick={onClose}>取消</Button>')
    const editBody = importDialog.slice(
      importDialog.indexOf('const edit ='),
      importDialog.indexOf('const readFile ='),
    )
    expect(editBody).not.toContain('callAgentTeam')
  })

  it('previews with one held document and applies the previewed plan hash', () => {
    expect(importDialog).toContain("callAgentTeam('sidebar.groups.import.preview'")
    expect(importDialog).toContain('document: parsed.document')
    expect(importDialog).toContain("callAgentTeam('sidebar.groups.import',")
    // The exact object and workspace the user reviewed, never a re-parse.
    expect(importDialog).toContain('document: preview.document')
    expect(importDialog).toContain('workspaceId: preview.workspaceId')
    expect(importDialog).toContain('expectedPlanHash: preview.value.planHash')
    // An edit or a target change drops the reviewed plan.
    expect(importDialog.match(/setPreview\(undefined\)/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(3)
  })

  it('previews created/skipped rows, the collision suffix and per-item outcomes', () => {
    expect(importDialog).toContain('groupImportPlanLines(planned)')
    expect(importDialog).toContain('data-dsh-group-import-preview')
    expect(importDialog).toContain('data-dsh-group-import-renamed')
    expect(importDialog).toContain('data-dsh-group-import-counts')
    expect(importDialog).toContain('GROUP_SHARE_STATUS_LABELS[row.status]')
    expect(importDialog).toContain('data-dsh-group-import-result-row')
    expect(importDialog).toContain('data-dsh-group-import-outcome')
    expect(importDialog).toContain('已创建')
    expect(importDialog).toContain('已拒绝')
    // The applied import re-reads the sections and adopts the Host's group list.
    expect(importDialog).toContain('onChanged()')
    expect(importDialog).toContain("callAgentTeam('sidebar.groups.list')")
    expect(importDialog).toContain('onListChanged(')
  })

  it('never renders a secret, a session or an assistant template', () => {
    for (const source of [exportDialog, importDialog]) {
      expect(source).not.toContain('assistantSnapshot')
      expect(source).not.toContain('.instructions')
      expect(source).not.toContain('memoryKey')
      expect(source).not.toContain('sessionId')
      expect(source).not.toContain('apiKey')
    }
  })

  it('stays on native surfaces with no page-level layer', () => {
    for (const source of [exportDialog, importDialog]) {
      expect(source).toContain('<AnimatedModal')
      expect(source).toContain('<Button')
      expect(source).not.toContain('createPortal')
      expect(source).not.toContain('document.body')
      expect(source).not.toContain('position: fixed')
      expect(source).not.toContain('zIndex')
    }
  })

  it('styles the share dialogs with semantic tokens and no positioning of its own', () => {
    expect(shareCss.length).toBeGreaterThan(800)
    expect(shareCss).not.toContain('position:')
    expect(shareCss).not.toContain('z-index')
    expect(shareCss).not.toContain('!important')
    expect(shareCss).not.toMatch(/#[0-9a-f]{3,8}/i)
    expect(shareCss).not.toMatch(/\brgb\(/)
    expect(shareCss).toContain('var(--dsw-alias-label-primary)')
    expect(shareCss).toContain('var(--dsw-alias-state-success-primary)')
    expect(shareCss).toContain('var(--dsw-alias-state-error-primary)')
    expect(shareCss).toContain('var(--dsw-alias-state-business-primary)')
  })
})

describe('group actions live in every section header menu', () => {
  const ui = readFileSync(new URL('../src/client/sidebar-group-ui.tsx', import.meta.url), 'utf8')
  const assistantSidebar = readFileSync(
    new URL('../src/client/assistant-sidebar.tsx', import.meta.url),
    'utf8',
  )
  const teamSidebar = readFileSync(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')

  it('gives the ungrouped header create + import, its only two operations', () => {
    const ids = sidebarGroupActionItems(['甲组'], undefined).map(entry => entry.id)

    expect(ids).toEqual(['create', 'import'])
  })

  it('gives a named header create + members before the shared group items', () => {
    const ids = sidebarGroupActionItems(['甲组', '乙组'], '甲组').map(entry => entry.id)

    expect(ids.slice(0, 2)).toEqual(['create', 'members'])
    // The shared list still owns import/rename/delete, unchanged.
    expect(ids).toContain('import')
    expect(ids).toContain('rename')
    expect(ids).toContain('delete')
    expect(sidebarGroupMenuItems(['甲组', '乙组'], '甲组').map(entry => entry.id))
      .toEqual(expect.arrayContaining(['import', 'rename', 'delete']))
  })

  it('routes both sidebars through the shared menu composer', () => {
    expect(assistantSidebar).toContain('sidebarGroupActionItems(groups, group)')
    expect(teamSidebar).toContain('sidebarGroupActionItems(groups, group)')
    // Dispatchers handle the two new ids plus the shared ones.
    expect(assistantSidebar).toContain("if (id === 'create')")
    expect(assistantSidebar).toContain("if (id === 'members')")
    expect(teamSidebar).toContain("if (id === 'create')")
    expect(teamSidebar).toContain("if (id === 'members')")
  })

  it('renders no list-level create/import row anywhere', () => {
    expect(ui).not.toContain('export function SidebarGroupImportRow')
    expect(ui).not.toContain('export function SidebarGroupCreateRow')
    expect(assistantSidebar).not.toContain('<SidebarGroupImportRow')
    expect(assistantSidebar).not.toContain('<SidebarGroupCreateRow')
    expect(teamSidebar).not.toContain('<SidebarGroupImportRow')
    expect(teamSidebar).not.toContain('<SidebarGroupCreateRow')
    // The dialogs they used to open are still reachable from the menu dispatch.
    expect(assistantSidebar).toContain("setGroupDialog({ kind: 'import' })")
    expect(teamSidebar).toContain("openGroupDialog({ kind: 'import' })")
  })

  it('keeps the header menu trigger visible while its menu is open', () => {
    // The anchor carries aria-expanded; the CSS pins the actions visible on it.
    expect(ui).toContain('aria-expanded={menuOpen}')
    expect(ui).toContain('data-dsh-sidebar-group-menu')
  })
})

describe('plan row keys for repeated document names', () => {
  it('gives every row a distinct key even when the document repeats a name', () => {
    const repeated = '同名'
    const member = {
      displayName: '组长',
      role: 'leader' as const,
      templateName: repeated,
      permissionPresetId: 'workspace-write',
    }
    const lines = groupImportPlanLines(importPreview({
      assistants: [
        { name: repeated, plannedName: repeated, action: 'create', profile: portableProfile(repeated) },
        { name: repeated, plannedName: `${repeated} (2)`, action: 'create', profile: portableProfile(repeated) },
        { name: repeated, plannedName: `${repeated} (3)`, action: 'skip', reason: 'unknown model' },
      ],
      templates: [
        { name: repeated, plannedName: repeated, action: 'create', profile: portableProfile(repeated) },
        { name: repeated, plannedName: `${repeated} (2)`, action: 'reuse', profile: portableProfile(repeated) },
      ],
      teams: [
        { name: repeated, plannedName: repeated, action: 'create', members: [member] },
        { name: repeated, plannedName: `${repeated} (2)`, action: 'skip', reason: 'no leader', members: [] },
      ],
    }))
    const keys = lines.map(line => line.key)

    expect(lines).toHaveLength(8)
    expect(new Set(keys).size).toBe(lines.length)
    // The old key (kind plus name) collided on exactly these rows.
    expect(keys.filter(key => key.includes('assistant'))).toHaveLength(3)
    expect(keys.filter(key => key.includes('team'))).toHaveLength(2)
  })

  it('uses the row key in the dialog instead of a name-derived key', () => {
    const source = readFileSync(new URL('../src/client/sidebar-group-ui.tsx', import.meta.url), 'utf8')
    const dialog = source.slice(source.indexOf('function GroupImportDialog'))

    expect(dialog).toContain('key={line.key}')
    expect(dialog).not.toContain('key={`${line.kind}:${line.name}`}')
    expect(dialog).toContain('data-dsh-group-import-row={line.key}')
  })
})

describe('revokeDownloadUrlLater', () => {
  it('revokes the download URL after the click, never in the same task', () => {
    vi.useFakeTimers()
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    try {
      revokeDownloadUrlLater('blob:group-export')

      // Synchronous revoke can cancel the download before the browser reads it.
      expect(revoke).not.toHaveBeenCalled()
      vi.advanceTimersByTime(999)
      expect(revoke).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(revoke).toHaveBeenCalledTimes(1)
      expect(revoke).toHaveBeenCalledWith('blob:group-export')
    } finally {
      revoke.mockRestore()
      vi.useRealTimers()
    }
  })

  it('keeps the export dialog off the synchronous revoke', () => {
    const source = readFileSync(new URL('../src/client/sidebar-group-ui.tsx', import.meta.url), 'utf8')
    const exportDialog = source.slice(
      source.indexOf('function GroupExportDialog'),
      source.indexOf('function GroupImportDialog'),
    )

    expect(exportDialog).toContain('revokeDownloadUrlLater(url)')
    expect(exportDialog).not.toContain('URL.revokeObjectURL')
    expect(exportDialog).toContain('URL.createObjectURL')
  })
})
