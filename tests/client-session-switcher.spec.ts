import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TeamView } from '../src/transport/contracts.js'

// The switcher imports the whole primitive set; this node test only checks the
// plugin's own grouping/navigation and the source wiring, so every primitive is
// a stub (the Menu renders its anchor and, while open, its content).
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (props: { children?: unknown }): unknown => createElement('span', null, props?.children as never)
  const api: Record<string, unknown> = {
    Menu: (props: { anchor?: unknown; open?: boolean; children?: unknown }) => createElement(
      'div',
      { role: 'menu' },
      props.anchor as never,
      props.open === true ? props.children as never : null,
    ),
  }
  for (const name of [
    'IconArchiveOutlineRegular', 'IconCheckOutlineRegular', 'IconChevronDownOutlineRegular',
    'IconEditOutlineRegular', 'IconEllipsisOutlineRegular', 'IconPauseOutlineRegular',
    'IconPlayOutlineRegular', 'IconPlusOutlineRegular', 'IconSearchOutlineRegular',
    'IconUnarchiveOutlineRegular', 'IconUsersOutlineRegular',
  ]) api[name] = Stub
  return api
})

const {
  TeamSessionSwitcher,
  sessionSwitcherModel,
  teamOwningSession,
  threadMenuModel,
} = await import('../src/client/team-member-chrome.js')
import type { SwitcherThreadRow, ThreadControlId } from '../src/client/team-member-chrome.js'

const ISO = '2026-01-01T00:00:00.000Z'

function member(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    assistantId: `assistant-${id}`,
    displayName: id,
    role: 'member',
    assistantSnapshot: { name: id, prompts: [] },
    permissionPresetId: 'default',
    sessionId: `session-${id}`,
    desiredState: 'online',
    lastRuntimeState: 'idle',
    joinedAt: ISO,
    ...overrides,
  }
}

function thread(id: string, title: string, updatedAt: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title, sessionId: `session-${id}`, createdAt: updatedAt, updatedAt, ...overrides }
}

function team(overrides: Record<string, unknown> = {}): TeamView {
  return {
    id: 'team-1',
    name: '测试团队',
    leaderSlotId: 'leader',
    state: 'active',
    members: {
      leader: member('leader', { displayName: '领队', role: 'leader', sessionId: 'session-leader' }),
      helper: member('helper', { displayName: '小助手', joinedAt: '2026-01-02T00:00:00.000Z' }),
    },
    tasks: {},
    ...overrides,
  } as unknown as TeamView
}

describe('the switcher model: two groups, current first', () => {
  it('puts members before threads and pins the current member to the top', () => {
    const model = sessionSwitcherModel(team({
      threads: {
        plan: thread('plan', '排期讨论', 100),
        ship: thread('ship', '发布复盘', 300),
      },
    }), 'session-helper')
    // Members are a separate group; the current one leads it.
    expect(model.members.map(row => row.name)).toEqual(['小助手', '领队'])
    expect(model.members[0]?.current).toBe(true)
    expect(model.members[1]?.leader).toBe(true)
    // Threads are newest first and carry their timestamp for the row.
    expect(model.threads.map(row => row.title)).toEqual(['发布复盘', '排期讨论'])
    expect(model.threads.map(row => row.updatedAt)).toEqual([300, 100])
    expect(model.currentName).toBe('小助手')
    expect(model.switchable).toBe(true)
  })

  it('lists the current thread first and marks it, keeping the rest newest-first', () => {
    const model = sessionSwitcherModel(team({
      threads: {
        older: thread('older', '旧线程', 100),
        current: thread('current', '当前线程', 50),
      },
    }), 'session-current')
    expect(model.threads.map(row => row.id)).toEqual(['current', 'older'])
    expect(model.threads[0]?.current).toBe(true)
    expect(model.currentName).toBe('当前线程')
  })

  it('hides the control when the Session is the only conversation a team has', () => {
    const solo = team({
      members: { leader: member('leader', { displayName: '领队', role: 'leader', sessionId: 'session-leader' }) },
    })
    expect(sessionSwitcherModel(solo, 'session-leader').switchable).toBe(false)
    expect(sessionSwitcherModel(solo, 'session-leader').threads).toEqual([])
    // A second member is enough of a destination.
    expect(sessionSwitcherModel(team(), 'session-leader').switchable).toBe(true)
  })

  it('filters members and threads with one query', () => {
    const model = sessionSwitcherModel(team({
      threads: {
        plan: thread('plan', '排期讨论', 100),
        ship: thread('ship', '发布复盘', 300),
      },
    }), 'session-helper', '小助')
    expect(model.members.map(row => row.name)).toEqual(['小助手'])
    expect(model.threads).toEqual([])

    const byThread = sessionSwitcherModel(team({
      threads: {
        plan: thread('plan', '排期讨论', 100),
        ship: thread('ship', '发布复盘', 300),
      },
    }), 'session-helper', '复盘')
    expect(byThread.members).toEqual([])
    expect(byThread.threads.map(row => row.title)).toEqual(['发布复盘'])
  })

  it('ignores Session-less members and never invents a fallback thread row', () => {
    const model = sessionSwitcherModel(team({
      members: {
        leader: member('leader', { displayName: '领队', role: 'leader', sessionId: 'session-leader' }),
        helper: member('helper', { sessionId: '' }),
      },
    }), 'session-leader')
    expect(model.members.map(row => row.sessionId)).toEqual(['session-leader', ''])
    expect(model.threads).toEqual([])
    expect(model.currentName).toBe('领队')
  })
})

describe('which Sessions get the control', () => {
  it('resolves member, thread and main Sessions to their team', () => {
    const value = team({ threads: { plan: thread('plan', '排期讨论', 100) } })
    expect(teamOwningSession([value], 'session-helper')?.id).toBe('team-1')
    expect(teamOwningSession([value], 'session-plan')?.id).toBe('team-1')
    expect(teamOwningSession([value], 'session-leader')?.id).toBe('team-1')
  })

  it('renders nothing outside a team conversation', () => {
    const value = team()
    expect(teamOwningSession([value], 'session-elsewhere')).toBeUndefined()
    expect(teamOwningSession([value], undefined)).toBeUndefined()
    // The component itself bails out on a plain Session (no team resolved).
    expect(renderToStaticMarkup(createElement(TeamSessionSwitcher, {
      sessionId: 'session-elsewhere',
      openSession: () => {},
    }))).toBe('')
  })
})

describe('the header trigger and panel', () => {
  const chrome = readFileSync(new URL('../src/client/team-member-chrome.tsx', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')

  function block(selector: string): string {
    const start = css.indexOf(`${selector} {`)
    expect(start).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start) + 1)
  }

  it('registers one control in the public header-actions slot', () => {
    expect(index).toContain("slotApi.inject('conversation.session.header.actions'")
    expect(index).toContain("id: 'dsh-team-mode-session-switcher'")
    expect(index).toContain('openSession: (sessionId: string)')
  })

  it('names the trigger after the current object and exposes its state', () => {
    expect(chrome).toContain('aria-label={`切换团队会话：${model.currentName}`}')
    expect(chrome).toContain('aria-expanded={open}')
    expect(chrome).toContain('aria-haspopup="menu"')
    expect(chrome).toContain('data-dsh-team-session-switcher')
    // The current topic is a chip; the trigger is only the caret that opens the
    // full list, so the name never appears twice in the header.
    expect(chrome).toContain('data-dsh-team-session-tabs')
    expect(chrome).toContain('data-dsh-team-session-tab={tab.sessionId}')
    expect(chrome).toContain('<IconChevronDownOutlineRegular size={12}')
    expect(block('.teamSessionTrigger')).toContain('border: none')
    expect(block('.teamSessionTrigger')).toContain('background: transparent')
    expect(chrome).not.toContain('teamSwitcherAdd')
  })

  it('opens on hover, on keyboard focus, and on Enter/click; closes on Esc, outside and navigation', () => {
    expect(chrome).toContain('onMouseEnter={() => { cancelHoverClose(); setOpen(true) }}')
    expect(chrome).toContain('onFocus={() => {')
    expect(chrome).toContain('onClick={() => { pointerFocus.current = false; toggle() }}')
    // A pointer press focuses the trigger; the click, not that focus, opens it.
    expect(chrome).toContain('onPointerDown={() => { pointerFocus.current = true }}')
    expect(chrome).toContain('onClose={close}')
    expect(chrome).toContain('useEffect(() => {\n    setOpen(false)\n    setQuery(\'\')\n  }, [sessionId])')
  })

  it('puts a search box above the two groups and the create row at the bottom', () => {
    expect(chrome).toContain('aria-label="搜索成员或会话"')
    const search = chrome.indexOf('className={css.teamSessionSearch}')
    const members = chrome.indexOf('aria-label="成员"')
    const threads = chrome.indexOf('aria-label="团队会话"')
    const create = chrome.indexOf('void createThread(team)', chrome.indexOf('aria-label="团队会话"'))
    expect(search).toBeGreaterThan(-1)
    expect(members).toBeGreaterThan(search)
    expect(threads).toBeGreaterThan(members)
    expect(create).toBeGreaterThan(threads)
    // Empty groups disappear instead of drawing an empty heading.
    expect(chrome).toContain('{model.members.length > 0 && (')
    expect(chrome).toContain('{model.threads.length > 0 && (')
    expect(chrome).toContain('没有匹配的成员或会话')
  })

  it('switches on the row itself: member Session, thread Session, or a new thread', () => {
    expect(chrome).toContain('onClick={() => { goTo(member.sessionId) }}')
    expect(chrome).toContain('onClick={() => { goTo(thread.sessionId) }}')
    expect(chrome).toContain('keepChatView(target)')
    expect(chrome).toContain('openSession(target)')
    expect(chrome).toContain("callAgentTeam('team.thread.create', { id: teamView.id })")
    expect(chrome).toContain('.find(thread => !known.has(thread.id))')
    expect(chrome).toContain('goTo(created.sessionId)')
  })

  it('caps the panel at 280px and scrolls the list inside it', () => {
    expect(block('.teamSessionMenu')).toContain('width: min(280px, calc(100vw - 24px))')
    expect(block('.teamSessionMenu')).toContain('max-width: 280px')
    expect(block('.teamSessionBody')).toContain('max-height: min(320px, 50vh)')
    expect(block('.teamSessionList')).toContain('overflow-y: auto')
    // The trigger stays inside the header bar.
    expect(block('.teamSessionTrigger')).toContain('max-width: 240px')
  })

  it('replaces the old member selector behind a stable data hook and keeps adding reachable', () => {
    // The old selector was this plugin's own header control; it is gone rather
    // than hidden with a guessed host class.
    expect(index).not.toContain('dsh-team-mode-member-switcher')
    expect(chrome).not.toContain('TeamMemberSwitcher')
    // The one header hook this contract can name without guessing a host class.
    expect(chrome).toContain('data-dsh-team-session-switcher')
    expect(chrome).not.toContain("aria-label=\"添加成员\"")
    expect(chrome).not.toContain('memberAdd')
    expect(css).not.toContain('.memberAddWrap')
    // 添加成员 still has its team-page entry: TeamPanel's 添加助手 dialog.
    const panel = readFileSync(new URL('../src/client/teams/TeamPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('添加助手')
    expect(panel).toContain("callAgentTeam('team.addMember'")
  })
})

describe('session row actions', () => {
  const chromeSource = readFileSync(new URL('../src/client/team-member-chrome.tsx', import.meta.url), 'utf8')
  const cssSource = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')

  it('offers rename and archive on each thread row', () => {
    expect(chromeSource).toContain("team.thread.rename")
    expect(chromeSource).toContain("team.thread.archive")
    expect(chromeSource).toContain("label: '重命名'")
    expect(chromeSource).toContain("label: '归档'")
  })

  it('keeps the row a single line and reveals actions only on hover', () => {
    expect(cssSource).toContain('.teamSessionRowWrap:hover .teamSessionRowActions')
    expect(cssSource).toContain(".teamSessionRowWrap:has([aria-expanded='true']) .teamSessionRowActions")
    expect(cssSource).toContain('.teamSessionRename')
  })
})

describe('the thread row shows its owner and its pause marker', () => {
  it('resolves the explicit owner and falls back to the Leader, never blank', () => {
    const model = sessionSwitcherModel(team({
      threads: {
        owned: thread('owned', '负责线程', 200, { ownerSlotId: 'helper' }),
        legacy: thread('legacy', '旧线程', 100),
      },
    }), 'session-helper')

    const owned = model.threads.find(row => row.id === 'owned')
    const legacy = model.threads.find(row => row.id === 'legacy')
    expect(owned?.ownerSlotId).toBe('helper')
    expect(owned?.ownerName).toBe('小助手')
    expect(owned?.ownerLeader).toBe(false)
    // A thread stored before ownership existed reads as the Leader's, not blank.
    expect(legacy?.ownerSlotId).toBe('leader')
    expect(legacy?.ownerName).toBe('领队')
    expect(legacy?.ownerLeader).toBe(true)
    expect(model.threads.every(row => row.ownerName.trim() !== '')).toBe(true)
  })

  it('falls back to the Leader when the stored owner is no longer a member', () => {
    const model = sessionSwitcherModel(team({
      threads: { ghost: thread('ghost', '失效负责人', 100, { ownerSlotId: 'gone' }) },
    }), 'session-leader')
    expect(model.threads[0]?.ownerSlotId).toBe('leader')
    expect(model.threads[0]?.ownerName).toBe('领队')
  })

  it('carries pausedAt onto the row and leaves the Session id alone', () => {
    const model = sessionSwitcherModel(team({
      threads: { paused: thread('paused', '暂停线程', 100, { pausedAt: 1_700_000_000_000 }) },
    }), 'session-helper')
    expect(model.threads[0]?.pausedAt).toBe(1_700_000_000_000)
    expect(model.threads[0]?.sessionId).toBe('session-paused')
  })
})

describe('the thread ⋯ menu', () => {
  const row = (overrides: Partial<SwitcherThreadRow> = {}): SwitcherThreadRow => ({
    id: 'thread-1',
    sessionId: 'session-thread-1',
    title: '讨论',
    updatedAt: 100,
    current: false,
    ownerSlotId: 'leader',
    ownerName: '领队',
    ownerLeader: true,
    ...overrides,
  })
  const disabledIds = (model: ReturnType<typeof threadMenuModel>): ThreadControlId[] =>
    model.items.filter(item => item.disabled).map(item => item.id)

  it('always lists the six controls in order and disables the inapplicable ones', () => {
    const running = threadMenuModel(team(), row())
    expect(running.items.map(item => item.id))
      .toEqual(['rename', 'assign', 'stop', 'resume', 'archive', 'restore'])
    expect(running.items.map(item => item.label))
      .toEqual(['重命名', '设置负责人', '暂停', '恢复', '归档', '恢复归档'])
    // Running: only resume and restore cannot act; nothing is hidden.
    expect(disabledIds(running)).toEqual(['resume', 'restore'])
    // Paused flips stop/resume and changes nothing else.
    expect(disabledIds(threadMenuModel(team(), row({ pausedAt: 9 })))).toEqual(['stop', 'restore'])
    // A retired row is the only state restore can act on.
    expect(disabledIds(threadMenuModel(team(), row({ archived: true }))))
      .toEqual(['stop', 'resume', 'archive'])
  })

  it('lists every member as a possible owner, Leader first, checking the resolved one', () => {
    const model = threadMenuModel(team(), row({ ownerSlotId: 'helper', ownerName: '小助手' }))
    const assign = model.items.find(item => item.id === 'assign')
    expect(assign?.disabled).toBe(false)
    expect(assign?.submenu?.map(owner => owner.name)).toEqual(['领队', '小助手'])
    expect(assign?.submenu?.map(owner => owner.leader)).toEqual([true, false])
    expect(assign?.submenu?.filter(owner => owner.current).map(owner => owner.slotId)).toEqual(['helper'])
    expect(model.currentOwnerSlotId).toBe('helper')
    // A legacy row checks the Leader: the submenu always has exactly one check.
    const legacy = threadMenuModel(team(), row())
    const legacyOwners = legacy.items.find(item => item.id === 'assign')?.submenu ?? []
    expect(legacyOwners.filter(owner => owner.current).map(owner => owner.slotId)).toEqual(['leader'])
  })

  it('draws the owner marker right of the title and a pause marker inside the row', () => {
    const chromeSource = readFileSync(new URL('../src/client/team-member-chrome.tsx', import.meta.url), 'utf8')
    const cssSource = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
    // Owner name sits before the relative time (the row's right side).
    const owner = chromeSource.indexOf('css.teamSessionOwner}')
    const time = chromeSource.indexOf('css.teamSessionTime}')
    expect(owner).toBeGreaterThan(-1)
    expect(time).toBeGreaterThan(owner)
    expect(chromeSource).toContain('aria-label={`负责人：${thread.ownerName}`}')
    // Paused is a marker, not a gate: the same row still navigates to history.
    expect(chromeSource).toContain('{thread.pausedAt !== undefined && (')
    expect(chromeSource).toContain('onClick={() => { goTo(thread.sessionId) }}')
    expect(chromeSource).toContain('css.teamSessionPausedDot')
    expect(chromeSource).toContain('已暂停')
    expect(cssSource).toContain('.teamSessionOwner')
    expect(cssSource).toContain('.teamSessionPausedDot')
    // The second-level owner list is the member list: avatar + name, Leader
    // crowned, the current owner checked.
    expect(chromeSource).toContain('submenu: item.submenu.map(owner => (')
    expect(chromeSource).toContain('<MemberAvatar name={owner.name}')
    expect(chromeSource).toContain("aria-label=\"当前负责人\"")
    expect(chromeSource).toContain("aria-label=\"队长\"")
  })

  it('calls the four thread-control transports and refreshes via subscribe', () => {
    const chromeSource = readFileSync(new URL('../src/client/team-member-chrome.tsx', import.meta.url), 'utf8')
    for (const method of ['team.thread.assign', 'team.thread.stop', 'team.thread.resume', 'team.thread.restore']) {
      expect(chromeSource).toContain(`callAgentTeam('${method}'`)
    }
    expect(chromeSource).toContain("id.startsWith('owner:')")
    expect(chromeSource).toContain('threadMenuEntries(thread)')
    // No local thread array is patched: every write reloads the team view.
    expect(chromeSource).toContain('subscribeAgentTeam')
    expect(chromeSource).not.toContain('setThreads')
    expect(chromeSource).not.toContain('setMembers')
  })
})

describe('topic tabs in the header', () => {
  const chromeSource = readFileSync(new URL('../src/client/team-member-chrome.tsx', import.meta.url), 'utf8')
  const cssSource = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')

  it('caps the strip at three topics with the current one first', async () => {
    const { sessionTabRows } = await import('../src/client/team-member-chrome.js')
    const team = {
      id: 't',
      name: 'T',
      leaderSlotId: 'm1',
      members: {},
      threads: {
        a: { id: 'a', title: 'A', sessionId: 's-a', updatedAt: 1 },
        b: { id: 'b', title: 'B', sessionId: 's-b', updatedAt: 9 },
        c: { id: 'c', title: 'C', sessionId: 's-c', updatedAt: 5 },
        d: { id: 'd', title: 'D', sessionId: 's-d', updatedAt: 3 },
      },
    } as never
    const rows = sessionTabRows(team, 's-c')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ sessionId: 's-c', current: true })
    // Newest of the rest comes next, and the current topic never repeats.
    expect(rows.slice(1).map(row => row.sessionId)).toEqual(['s-b', 's-d'])
  })

  it('keeps the add button and the panel caret beside the strip', () => {
    expect(chromeSource).toContain('data-dsh-team-session-add')
    expect(chromeSource).toContain('aria-label="新建话题"')
    expect(cssSource).toContain('.teamSessionTabAdd')
    expect(cssSource).toContain('.teamSessionTabCurrent')
  })
})

describe('lineage title names the team', () => {
  const chromeSource = readFileSync(new URL('../src/client/team-member-chrome.tsx', import.meta.url), 'utf8')
  const cssSource = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')

  it('names the team for every Session of that team', () => {
    // Which thread or member is open never changes the title: the header answers
    // "which team am I in".
    expect(chromeSource).toContain('data-dsh-team-session-title')
    expect(chromeSource).toContain('{team.name}')
    expect(chromeSource).not.toContain('export function teamSessionOwner')
    expect(chromeSource).not.toContain('export function isTeamLevelSession')
  })

  it('stacks up to three faces before the name, and hides the shipped crumb', () => {
    expect(chromeSource).toContain('sortedMembers(team).slice(0, 3)')
    expect(cssSource).toContain('.teamSessionTitleFaces > * + *')
    expect(cssSource).toContain("crumbSeg")
  })
})
