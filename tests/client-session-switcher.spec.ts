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
    'IconCheckOutlineRegular', 'IconChevronDownOutlineRegular', 'IconPlusOutlineRegular', 'IconSearchOutlineRegular',
  ]) api[name] = Stub
  return api
})

const {
  TeamSessionSwitcher,
  sessionSwitcherModel,
  teamOwningSession,
} = await import('../src/client/team-member-chrome.js')

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
    // The trigger is the name plus a caret, not a framed pill next to a ＋.
    expect(chrome).toContain('<span className={css.teamSessionTriggerName}>{model.currentName}</span>')
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
    const create = chrome.indexOf('void createThread(team)')
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
