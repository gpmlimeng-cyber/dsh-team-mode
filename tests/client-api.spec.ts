import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_TEAM_FILE_NAME_HEADER,
  AGENT_TEAM_REQUEST_ID_HEADER,
} from '../src/transport/contracts.js'

class FakeEventSource {
  static readonly OPEN = 1
  static instances: FakeEventSource[] = []

  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  readyState = 0
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener as (event: unknown) => void)
    this.listeners.set(type, listeners)
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) })
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }

  close(): void {
    this.closed = true
  }
}

describe('Agent Team client event hub', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  it('shares one EventSource across list and conversation subscribers', async () => {
    const {
      subscribeAgentTeam,
      subscribeAgentTeamConversation,
      subscribeAgentTeamWorkspace,
      subscribeAssistantBuilderConversation,
    } = await import('../src/client/api.js')
    const listChange = vi.fn()
    const conversationChange = vi.fn()
    const builderChange = vi.fn()
    const workspaceChange = vi.fn()
    const opened = vi.fn()

    const unsubscribeList = subscribeAgentTeam(listChange, vi.fn())
    const unsubscribeConversation = subscribeAgentTeamConversation(
      'team-1',
      conversationChange,
      vi.fn(),
      opened,
    )
    const unsubscribeBuilder = subscribeAssistantBuilderConversation(builderChange, vi.fn())
    const unsubscribeWorkspace = subscribeAgentTeamWorkspace('team-1', workspaceChange, vi.fn())

    expect(FakeEventSource.instances).toHaveLength(1)
    const source = FakeEventSource.instances[0]!
    source.open()
    source.emit('change', { entityId: 'team-1' })
    source.emit('conversation', {
      entityId: 'team-1',
      conversation: { slotId: 'slot-1', throughSeq: 3 },
    })
    source.emit('assistant-builder-conversation', {
      assistantBuilderConversation: {
        schemaVersion: 1,
        sessionId: 'dsh-team-mode:assistant-builder',
        status: 'running',
        throughSeq: 4,
        nodes: [],
      },
    })
    source.emit('workspace', { entityId: 'team-1', kind: 'workspace.changed' })

    expect(opened).toHaveBeenCalledOnce()
    expect(listChange).toHaveBeenCalledOnce()
    expect(conversationChange).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'slot-1' }))
    expect(builderChange).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'dsh-team-mode:assistant-builder',
    }))
    expect(workspaceChange).toHaveBeenCalledOnce()

    unsubscribeList()
    expect(source.closed).toBe(false)
    unsubscribeConversation()
    expect(source.closed).toBe(false)
    unsubscribeBuilder()
    expect(source.closed).toBe(false)
    unsubscribeWorkspace()
    expect(source.closed).toBe(true)
  })
})

describe('Agent Team client requests', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('requests the Skill catalog for one Agent Preset', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { skills: [] } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('skill.catalog', { agentPresetId: 'standard' })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'skill.catalog',
      payload: { agentPresetId: 'standard' },
    })
  })

  it('submits a structured team interaction response', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { accepted: true } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('team.interaction.respond', {
      teamId: 'team-1',
      slotId: 'slot-1',
      interactionId: 'question:rpc-1',
      response: {
        kind: 'question',
        answers: [{ id: 'name', selected: [], custom: 'Reviewer' }],
      },
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'team.interaction.respond',
      payload: {
        teamId: 'team-1',
        slotId: 'slot-1',
        interactionId: 'question:rpc-1',
        response: {
          kind: 'question',
          answers: [{ id: 'name', selected: [], custom: 'Reviewer' }],
        },
      },
    })
  })

  it('uploads a system-selected file to the team Workspace upload route', async () => {
    const fetch = vi.fn(async () => ({
      json: async () => ({
        requestId: 'request-1',
        ok: true,
        value: { name: 'notes.txt', path: '.dsh-team-mode/uploads/notes.txt', bytes: 5 },
      }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { uploadAgentTeamFile } = await import('../src/client/api.js')
    const file = { name: '会议 notes.txt' } as File

    await expect(uploadAgentTeamFile('team-1', file)).resolves.toMatchObject({
      path: '.dsh-team-mode/uploads/notes.txt',
    })

    expect(fetch).toHaveBeenCalledWith('/dsh-team-mode/upload?teamId=team-1', expect.objectContaining({
      method: 'POST',
      body: file,
      headers: expect.objectContaining({
        'Content-Type': 'application/octet-stream',
        [AGENT_TEAM_FILE_NAME_HEADER]: encodeURIComponent(file.name),
        [AGENT_TEAM_REQUEST_ID_HEADER]: 'request-1',
      }),
    }))
  })

  it('requests the MCP catalog for one Agent Preset', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { servers: [] } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('mcp.catalog', { agentPresetId: 'standard' })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'mcp.catalog',
      payload: { agentPresetId: 'standard' },
    })
  })

  it('addresses Assistant Builder requests to one conversation Session', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { messageId: 'message-1' } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('assistant.builder.send', {
      sessionId: 'dsh-team-mode:assistant-builder:conversation-1',
      content: 'Create a reviewer',
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'assistant.builder.send',
      payload: {
        sessionId: 'dsh-team-mode:assistant-builder:conversation-1',
        content: 'Create a reviewer',
      },
    })
  })

  it('submits an Assistant Builder structured interaction response', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { accepted: true } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('assistant.builder.interaction.respond', {
      sessionId: 'dsh-team-mode:assistant-builder:conversation-1',
      interactionId: 'question:question-rpc-1',
      response: {
        kind: 'question',
        answers: [{ id: 'name', selected: ['代码审查助手'] }],
      },
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'assistant.builder.interaction.respond',
      payload: {
        sessionId: 'dsh-team-mode:assistant-builder:conversation-1',
        interactionId: 'question:question-rpc-1',
      },
    })
  })

  it('starts an Assistant Builder Session only with the first draft message', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { sessionId: 'conversation-1' } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('assistant.builder.start', {
      provider: 'deepseek',
      model: 'reasoner',
      content: 'Create a reviewer',
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'assistant.builder.start',
      payload: {
        provider: 'deepseek',
        model: 'reasoner',
        content: 'Create a reviewer',
      },
    })
  })

  it('requests archival of one Assistant Builder conversation', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { archived: true } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('assistant.builder.archive', {
      sessionId: 'dsh-team-mode:assistant-builder:conversation-1',
    })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'assistant.builder.archive',
      payload: { sessionId: 'dsh-team-mode:assistant-builder:conversation-1' },
    })
  })

  it('sends the current revision when updating an assistant', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { id: 'assistant-1' } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('assistant.update', {
      id: 'assistant-1',
      value: { name: 'Updated Assistant' },
    }, 3)

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'assistant.update',
      expectedRevision: 3,
      payload: {
        id: 'assistant-1',
        value: { name: 'Updated Assistant' },
      },
    })
  })
})

/**
 * F4: a fresh page mounts independent readers that start ~450 ms apart
 * (`TeamTriggerEnhancer.loadColors`, then the Session row hider / sidebar
 * `load`), so the in-flight sharing above cannot merge them. One settled
 * `team.list` snapshot covers that stagger and nothing more.
 */
describe('Agent Team mount snapshot (one team.list per fresh mount)', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const stubFetch = (): string[] => {
    const calls: string[] = []
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string }
      calls.push(request.method)
      return { json: async () => ({ requestId: 'request-1', ok: true, value: { items: [], total: 0 } }) }
    }))
    return calls
  }

  it('lets the mount\'s second reader join the settled answer', async () => {
    const calls = stubFetch()
    const { callAgentTeam } = await import('../src/client/api.js')
    await callAgentTeam('team.list')
    await callAgentTeam('team.list')
    expect(calls).toEqual(['team.list'])
  })

  it('stops reusing it after the settle window', async () => {
    const calls = stubFetch()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const { callAgentTeam } = await import('../src/client/api.js')
    await callAgentTeam('team.list')
    await callAgentTeam('team.list')
    expect(calls).toEqual(['team.list'])
    now.mockReturnValue(1_000_000 + 1_501)
    await callAgentTeam('team.list')
    expect(calls).toEqual(['team.list', 'team.list'])
  })

  it('drops the snapshot on any mutation, so a later read is fresh', async () => {
    const calls = stubFetch()
    const { callAgentTeam } = await import('../src/client/api.js')
    await callAgentTeam('team.list')
    await callAgentTeam('team.pin', { teamId: 'team-1', pinned: true }, 1)
    await callAgentTeam('team.list')
    expect(calls).toEqual(['team.list', 'team.pin', 'team.list'])
  })

  it('drops the snapshot when a team change event arrives', async () => {
    const calls = stubFetch()
    const { callAgentTeam, subscribeAgentTeam } = await import('../src/client/api.js')
    const unsubscribe = subscribeAgentTeam(vi.fn(), vi.fn())
    await callAgentTeam('team.list')
    await callAgentTeam('team.list')
    expect(calls).toEqual(['team.list'])
    FakeEventSource.instances[0]!.open()
    FakeEventSource.instances[0]!.emit('change', { entityId: 'team-1' })
    await callAgentTeam('team.list')
    expect(calls).toEqual(['team.list', 'team.list'])
    unsubscribe()
  })

  it('never reuses other reads', async () => {
    const calls = stubFetch()
    const { callAgentTeam } = await import('../src/client/api.js')
    await callAgentTeam('team.get', { id: 'team-a' })
    await callAgentTeam('team.get', { id: 'team-a' })
    expect(calls).toEqual(['team.get', 'team.get'])
  })
})

describe('Agent Team sidebar group sharing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const stubFetch = (value: unknown): string[] => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      calls.push((JSON.parse(init.body) as { method: string }).method)
      return { json: async () => ({ requestId: 'request-1', ok: true, value }) }
    }))
    return calls
  }

  it('shares one in-flight sidebar.groups.list between concurrent readers', async () => {
    const calls = stubFetch(['工作', '生活'])
    const { callAgentTeam } = await import('../src/client/api.js')
    const [first, second] = await Promise.all([
      callAgentTeam('sidebar.groups.list'),
      callAgentTeam('sidebar.groups.list'),
    ])
    expect(calls).toEqual(['sidebar.groups.list'])
    expect(first).toEqual(['工作', '生活'])
    expect(second).toEqual(first)
  })

  it('never shares a sidebar group write', async () => {
    const calls = stubFetch(['工作'])
    const { callAgentTeam } = await import('../src/client/api.js')
    await Promise.all([
      callAgentTeam('sidebar.groups.rename', { from: '工作', to: '办公' }),
      callAgentTeam('sidebar.groups.rename', { from: '工作', to: '办公' }),
    ])
    expect(calls).toEqual(['sidebar.groups.rename', 'sidebar.groups.rename'])
  })
})
