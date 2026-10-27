import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SIDEBAR_GROUP_BRIEF_MAX_CHARS as HOST_BRIEF_MAX_CHARS } from '../src/domain/schemas.js'
import {
  SIDEBAR_GROUP_BRIEF_MAX_CHARS,
  SIDEBAR_GROUP_MAX_CHARS,
  UNGROUPED_PARTITION_ID,
  groupMembershipCandidates,
  groupMembershipChanges,
  insertGroupOrder,
  movedGroupOrder,
  resolveDropTarget,
  sidebarGroupBriefError,
  sidebarGroupBriefUsage,
  sidebarGroupNameError,
  sidebarPartitions,
  type SidebarGroupCandidate,
} from '../src/client/sidebar-groups.js'

// The picker imports the whole primitive set; this node test only needs the
// native Menu's shape (anchor always rendered, content only while open).
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: h } = await import('react')
  const api: Record<string, unknown> = {
    Menu: (props: { anchor?: unknown; open?: boolean; children?: unknown }) =>
      h('div', { role: 'menu' }, props.anchor as never, props.open === true ? props.children as never : null),
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

describe('native overlays for member add and the enlarged conversation', () => {
  const chrome = readFileSync(new URL('../src/client/team-member-chrome.tsx', import.meta.url), 'utf8')
  const teamPanel = readFileSync(new URL('../src/client/teams/TeamPanel.tsx', import.meta.url), 'utf8')
  const columnCss = readFileSync(
    new URL('../src/client/workbench/ConversationColumn.module.css', import.meta.url),
    'utf8',
  )
  const components = readFileSync(new URL('../src/client/components.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
  const memberAddCss = css.slice(css.indexOf('.memberAddWrap {'), css.indexOf('.memberAddHeader {'))
  const expandedColumnCss = columnCss.slice(
    columnCss.indexOf('.conversationColumnExpanded {'),
    columnCss.indexOf('.conversationColumnExpanded .columnHeader {'),
  )

  it('adds a member from a portalled host Menu anchored to the ＋ button', () => {
    expect(chrome).toContain('<Menu')
    expect(chrome).toContain('portal')
    expect(chrome).toContain('listClassName={css.memberAddMenu}')
    expect(chrome).toContain('aria-haspopup="menu"')
    expect(chrome).toContain('role="menuitem"')
    // The bespoke scrim, dialog semantics and page Escape listener are gone.
    expect(chrome).not.toContain('memberAddScrim')
    expect(chrome).not.toContain('memberAddPanel')
    expect(chrome).not.toContain('aria-haspopup="dialog"')
    expect(chrome).not.toContain("document.addEventListener('keydown'")
    expect(chrome).not.toContain('autoFocus')
  })

  it('keeps the member-add content and every action', () => {
    for (const copy of [
      '添加成员',
      '同一助手可被反复添加',
      '搜索助手',
      '没有可加入团队的助手',
      '没有匹配的助手',
      '没有合适的？让 Leader 帮你安排。',
      '告诉 Leader →',
    ]) {
      expect(chrome).toContain(copy)
    }
    expect(chrome).toContain("callAgentTeam('team.addMember'")
    expect(chrome).toContain('keepChatView(leader.sessionId)')
    expect(memberAddCss.length).toBeGreaterThan(0)
    expect(memberAddCss).not.toContain('position: fixed')
    expect(memberAddCss).not.toContain('position: absolute')
    expect(memberAddCss).not.toContain('z-index')
    // The scrim class is gone entirely.
    expect(css).not.toContain('.memberAddScrim')
    expect(css).not.toContain('.memberAddPanel')
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

  it('focuses the member-add search on the Menu placement frame, not via autoFocus', () => {
    expect(chrome).toContain('const addSearchRef = useRef<HTMLInputElement>(null)')
    expect(chrome).toContain(
      'const frame = requestAnimationFrame(() => { addSearchRef.current?.focus() })',
    )
    expect(chrome).toContain('cancelAnimationFrame(frame)')
    expect(chrome).toContain('}, [addPanelOpen])')
    expect(chrome).toContain('ref={addSearchRef}')
    expect(chrome).not.toContain('autoFocus')
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
    // Member add: native menu rows, so the Menu walks them and Tab settles them.
    expect(chrome).toContain('role="menuitem"')
    expect(chrome).not.toContain("event.key === 'Escape'")
    expect(chrome).not.toContain("event.key === 'Tab'")
  })
})
