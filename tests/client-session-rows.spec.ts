import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isUnknownSessionError,
  isUnknownTeamError,
  navigationErrorMessage,
  openSessionInCatalog,
  teamLeaderSessionId,
} from '../src/client/api.js'
import { hiddenSessionIds } from '../src/client/session-rows.js'
import { teamRosterRows } from '../src/client/team-sidebar-data.js'
import type { TeamView } from '../src/transport/contracts.js'

describe('hiddenSessionIds', () => {
  it('unions team member, assistant main, and assistant task Sessions', () => {
    const ids = hiddenSessionIds(
      [{
        members: {
          leader: { sessionId: 'team-leader' },
          member: { sessionId: 'team-member' },
        },
      }],
      [{ mainSessionId: 'assistant-main' }],
      [{ sessionId: 'assistant-task' }],
    )
    expect([...ids].sort()).toEqual([
      'assistant-main',
      'assistant-task',
      'team-leader',
      'team-member',
    ])
  })

  it('hides every retired main Session alongside the current one', () => {
    const ids = hiddenSessionIds(
      [],
      [{ mainSessionId: 'main', retiredMainSessionIds: ['old-1', 'old-2'] }],
      [],
    )
    expect([...ids].sort()).toEqual(['main', 'old-1', 'old-2'])
  })

  it('skips blank retired main Session ids', () => {
    const ids = hiddenSessionIds([], [{ retiredMainSessionIds: ['', 'old-1'] }], [])
    expect([...ids]).toEqual(['old-1'])
  })

  it('hides Leader Sessions retired by an explicit handoff', () => {
    const ids = hiddenSessionIds(
      [
        {
          members: { leader: { sessionId: 'team-leader' } },
          retiredLeaderSessionIds: ['old-leader', ''],
        },
        { members: { leader: { sessionId: 'other-leader' } }, retiredLeaderSessionIds: ['old-leader'] },
      ],
      [],
      [],
    )
    // Blank entries are skipped and cross-team duplicates collapse to one row.
    expect([...ids].sort()).toEqual(['old-leader', 'other-leader', 'team-leader'])
  })

  it('deduplicates a Session referenced by every source', () => {
    const ids = hiddenSessionIds(
      [{ members: { leader: { sessionId: 'shared' }, member: { sessionId: 'team-only' } } }],
      [{ mainSessionId: 'shared' }],
      [{ sessionId: 'shared' }],
    )
    expect([...ids].sort()).toEqual(['shared', 'team-only'])
  })

  it('deduplicates Sessions across multiple teams and tasks', () => {
    const ids = hiddenSessionIds(
      [
        { members: { a: { sessionId: 'same' } } },
        { members: { b: { sessionId: 'same' }, c: { sessionId: 'other' } } },
      ],
      [{ mainSessionId: 'same' }, { mainSessionId: 'same' }],
      [{ sessionId: 'task' }, { sessionId: 'task' }],
    )
    expect([...ids].sort()).toEqual(['other', 'same', 'task'])
  })

  it('skips missing and blank Session ids', () => {
    const ids = hiddenSessionIds(
      [{ members: { member: { sessionId: '' } } }],
      [{}, { mainSessionId: '' }],
      [{ sessionId: '' }],
    )
    expect(ids.size).toBe(0)
  })

  it('returns an empty set when no source has Sessions', () => {
    expect(hiddenSessionIds([], [], []).size).toBe(0)
  })
})

describe('sidebar roster stays outside the native Session list', () => {
  const ISO = '2026-01-01T00:00:00.000Z'

  function member(id: string): Record<string, unknown> {
    return {
      id,
      assistantId: `assistant-${id}`,
      displayName: id,
      role: 'member',
      assistantSnapshot: {
        assistantId: `assistant-${id}`,
        revision: 1,
        name: id,
        instructions: '',
        provider: 'deepseek',
        model: 'deepseek-chat',
        agentPresetId: 'default',
        permissionPresetId: 'default',
        skillAllowlist: [],
        mcpServers: [],
        prompts: [],
      },
      permissionPresetId: 'default',
      sessionId: `session-${id}`,
      desiredState: 'online',
      lastRuntimeState: 'running',
      joinedAt: ISO,
    }
  }

  it('renders every roster Session that the hider already removed from native rows', () => {
    // The roster is the only sidebar entry to a member Session: adding rows must
    // not resurrect a native duplicate (SessionRowHider unchanged).
    const team = {
      id: 'team-1',
      name: '测试团队',
      members: Object.fromEntries(['leader', 'a'].map(id => [id, member(id)])),
      tasks: {},
    } as unknown as TeamView
    const roster = teamRosterRows(team)
    const hidden = hiddenSessionIds([team], [], [])
    expect(roster.map(row => row.sessionId)).toEqual(['session-leader', 'session-a'])
    expect(roster.filter(row => !hidden.has(row.sessionId))).toEqual([])
  })
})

describe('team and member row navigation', () => {
  // The shell refuses an id its client Session catalog has not pulled yet; a
  // Host-created team Session hits this on a page that was already open.
  const unknownSession = (): Error => new Error('sessions.retain: unknown session session-leader')

  it('opens a Session the client already knows without pulling the catalog', async () => {
    const open = vi.fn()
    const refresh = vi.fn(async () => undefined)
    await openSessionInCatalog('session-leader', { open, refresh })
    expect(open.mock.calls).toEqual([['session-leader']])
    expect(refresh).not.toHaveBeenCalled()
  })

  it('pulls the catalog once and retries when the client does not know the Session', async () => {
    const calls: string[] = []
    const open = vi.fn(() => {
      calls.push('open')
      if (calls.length === 1) throw unknownSession()
    })
    const refresh = vi.fn(async () => { calls.push('refresh') })
    await openSessionInCatalog('session-leader', { open, refresh })
    // open → refused → catalog pull → open again, in that order.
    expect(calls).toEqual(['open', 'refresh', 'open'])
  })

  it('reports the refusal instead of a silent no-op when the retry still fails', async () => {
    const open = vi.fn(() => { throw unknownSession() })
    const refresh = vi.fn(async () => undefined)
    await expect(openSessionInCatalog('session-leader', { open, refresh })).rejects.toThrow('unknown session')
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('does not pull the catalog for an unrelated failure', async () => {
    const open = vi.fn(() => { throw new Error('Session Controller is disposed') })
    const refresh = vi.fn(async () => undefined)
    await expect(openSessionInCatalog('session-leader', { open, refresh })).rejects.toThrow('disposed')
    expect(refresh).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('reports the refusal when the shell exposes no catalog refresh', async () => {
    const open = vi.fn(() => { throw unknownSession() })
    await expect(openSessionInCatalog('session-leader', { open })).rejects.toThrow('unknown session')
  })

  it('turns a refusal into a message the sidebar can show', () => {
    expect(isUnknownSessionError(unknownSession())).toBe(true)
    expect(navigationErrorMessage(unknownSession())).toContain('无法打开该会话')
    expect(navigationErrorMessage(new Error('boom'))).toBe('无法打开该会话：boom')
  })

  it('resolves the Leader Slot Session and never returns a blank id', () => {
    expect(teamLeaderSessionId({
      members: { leader: { sessionId: 'session-leader' }, member: { sessionId: 'session-member' } },
      leaderSlotId: 'leader',
    })).toBe('session-leader')
    expect(teamLeaderSessionId({ members: {}, leaderSlotId: 'leader' })).toBeUndefined()
    expect(teamLeaderSessionId({
      members: { leader: { sessionId: '' } },
      leaderSlotId: 'leader',
    })).toBeUndefined()
  })

  it('keeps the sidebar click path free of a swallowed navigation failure', () => {
    // F2: `openTeamPage` used `team.list` plus `.catch(() => undefined)`, so a
    // refused Session left the main pane unchanged with no message.
    const source = readFileSync('src/client/index.tsx', 'utf8')
    expect(source).not.toContain('.catch(() => undefined)')
    expect(source).toContain("callAgentTeam('team.get'")
    expect(source).toContain('openSessionInCatalog')
    expect(source).toContain('reportNavigationError')
  })
})

describe('F8: a missing team is reported without its internal id', () => {
  // The Host raises TEAM_NOT_FOUND with `Unknown team '<uuid>'`; the id is an
  // implementation detail a person must never read.
  const unknownTeamByCode = (): Error => Object.assign(
    new Error("Unknown team 'a5d3f549-ad2c-40c5-a1fe-12c1c35d569b'"),
    { code: 'TEAM_NOT_FOUND' },
  )

  it('maps TEAM_NOT_FOUND to exactly one sentence', () => {
    const message = navigationErrorMessage(unknownTeamByCode())
    expect(message).toBe('该团队已不存在。')
    expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/)
    expect(message).not.toContain('TEAM_NOT_FOUND')
    expect(message).not.toContain('Unknown team')
  })

  it('recognises the bare wording when no code survived the boundary', () => {
    expect(isUnknownTeamError(new Error("Unknown team 'id-1'"))).toBe(true)
    expect(navigationErrorMessage(new Error("Unknown team 'id-1'"))).toBe('该团队已不存在。')
    expect(isUnknownTeamError(unknownTeamByCode())).toBe(true)
  })

  it('leaves every other failure, including the session refusal, untouched', () => {
    expect(isUnknownTeamError(new Error('boom'))).toBe(false)
    expect(isUnknownTeamError('Unknown team')).toBe(false)
    expect(isUnknownTeamError(undefined)).toBe(false)
    expect(navigationErrorMessage(new Error('boom'))).toBe('无法打开该会话：boom')
    expect(navigationErrorMessage(new Error('sessions.retain: unknown session x')))
      .toBe('无法打开该会话：会话尚未同步到本地，请重新加载页面后再试')
  })
})

class FakeEventSource {
  static readonly OPEN = 1
  static instances: FakeEventSource[] = []

  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  readyState = 0
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener as (event: unknown) => void)
    this.listeners.set(type, listeners)
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: '{}' })
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }

  close(): void {
    this.readyState = 2
  }
}

describe('F4: the event hub does not double the mount read', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function subscribeAll(): Promise<{
    listResync: ReturnType<typeof vi.fn>
    conversationOpen: ReturnType<typeof vi.fn>
    workspaceOpen: ReturnType<typeof vi.fn>
    builderOpen: ReturnType<typeof vi.fn>
    dispose: () => void
  }> {
    const {
      subscribeAgentTeam,
      subscribeAgentTeamConversation,
      subscribeAgentTeamWorkspace,
      subscribeAssistantBuilderConversation,
    } = await import('../src/client/api.js')
    const listResync = vi.fn()
    const conversationOpen = vi.fn()
    const workspaceOpen = vi.fn()
    const builderOpen = vi.fn()
    const disposers = [
      subscribeAgentTeam(vi.fn(), vi.fn(), listResync),
      subscribeAgentTeamConversation('team-1', vi.fn(), vi.fn(), conversationOpen),
      subscribeAgentTeamWorkspace('team-1', vi.fn(), vi.fn(), workspaceOpen),
      subscribeAssistantBuilderConversation(vi.fn(), vi.fn(), builderOpen),
    ]
    return {
      listResync,
      conversationOpen,
      workspaceOpen,
      builderOpen,
      dispose: () => { for (const dispose of disposers) dispose() },
    }
  }

  it('skips the change resync on the first open, which the mount read covers', async () => {
    const hub = await subscribeAll()
    FakeEventSource.instances[0]!.open()
    // One page mount already read; a first open must not add a second team.list.
    expect(hub.listResync).not.toHaveBeenCalled()
    // The other subscription kinds keep their first-open behaviour.
    expect(hub.conversationOpen).toHaveBeenCalledOnce()
    expect(hub.workspaceOpen).toHaveBeenCalledOnce()
    expect(hub.builderOpen).toHaveBeenCalledOnce()
    hub.dispose()
  })

  it('resyncs change subscribers when the stream re-opens after a drop', async () => {
    const hub = await subscribeAll()
    const source = FakeEventSource.instances[0]!
    source.open()
    expect(hub.listResync).not.toHaveBeenCalled()
    // EventSource re-opens after its own reconnect: events may be missing now.
    source.open()
    expect(hub.listResync).toHaveBeenCalledOnce()
    source.open()
    expect(hub.listResync).toHaveBeenCalledTimes(2)
    hub.dispose()
  })

  it('always honours the explicit server resync frame', async () => {
    const hub = await subscribeAll()
    const source = FakeEventSource.instances[0]!
    source.open()
    source.emit('resync')
    expect(hub.listResync).toHaveBeenCalledOnce()
    hub.dispose()
  })

  it('shares one EventSource for every subscriber of the mount', async () => {
    const hub = await subscribeAll()
    expect(FakeEventSource.instances).toHaveLength(1)
    hub.dispose()
  })
})
