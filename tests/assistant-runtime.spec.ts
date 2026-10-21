import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import type {
  AssistantInstance,
  AssistantSession,
  CreateAssistantSessionInput,
  UpdateAssistantSessionInput,
} from '../src/domain/types.js'
import { AssistantRuntime } from '../src/runtime/assistant-runtime.js'
import type { AgentTeamService } from '../src/service/dsh-team-mode-service.js'

vi.mock('@deepseek-ai/dsh-agent', () => ({
  installModelSelection: vi.fn(),
}))

const NOW = '2026-10-21T00:00:00.000Z'
const WORKSPACE_ID = 'workspace-1'
const WORKSPACE_PATH = '/tmp/dsh-assistant-runtime-workspace'

const TASK_TOOL_NAMES = [
  'assistant_task_create',
  'assistant_task_send',
  'assistant_task_list',
  'assistant_task_wait',
  'assistant_task_summary',
  'assistant_task_cancel',
]

const config: Config = {
  maxRequestBytes: 128 * 1024,
  sseHeartbeatMs: 20_000,
  runtimeConcurrency: 4,
  directMemberChatDefault: true,
  assistantBuilderProvider: '',
  assistantBuilderModel: '',
  assistantBuilderAgentPresetId: '',
  assistantBuilderPermissionPresetId: '',
}

interface AgentRecord {
  handle: AgentHandle
  agent: Agent
  agentCtx: Context
  section: ReturnType<typeof vi.fn>
  toolsRegister: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  whenIdle: ReturnType<typeof vi.fn>
  events: SessionEvent[]
}

function instance(overrides: Partial<AssistantInstance> = {}): AssistantInstance {
  return {
    schemaVersion: 1,
    id: 'instance-1',
    templateId: 'template-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: 'Researcher',
      instructions: 'Cite sources.',
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'high',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: WORKSPACE_ID,
    workspacePath: WORKSPACE_PATH,
    status: 'idle',
    pinned: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function createHarness(overrides: Partial<AssistantInstance> = {}) {
  const handles: AgentRecord[] = []
  const live = new Map<string, Agent>()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  const on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    const set = listeners.get(event) ?? new Set()
    set.add(listener)
    listeners.set(event, set)
    return () => { set.delete(listener) }
  })
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }

  const createHandle = async (sessionId: string, setup?: AgentSetup): Promise<AgentRecord> => {
    const events: SessionEvent[] = []
    const session = {
      id: SessionId(sessionId),
      snapshotEvents: vi.fn(() => events),
    }
    const followup = vi.fn()
    const cancel = vi.fn()
    const whenIdle = vi.fn(async () => {})
    const agent = {
      id: SessionId(sessionId),
      session,
      cancel,
      followup,
      whenIdle,
      status: 'idle',
    } as unknown as Agent
    const section = vi.fn()
    const toolsRegister = vi.fn()
    const agentCtx = {
      systemPrompt: { section },
      tools: { register: toolsRegister },
    } as unknown as Context
    if (setup !== undefined) await setup(agentCtx, agent)
    const dispose = vi.fn(async () => {})
    const record: AgentRecord = {
      handle: { agent, dispose },
      agent,
      agentCtx,
      section,
      toolsRegister,
      dispose,
      followup,
      cancel,
      whenIdle,
      events,
    }
    handles.push(record)
    return record
  }

  const createMock = vi.fn(async (options: CreateAgentOptions) => (
    await createHandle(String(options.sessionId), options.setup)
  ).handle)
  const resumeMock = vi.fn(async (options: ResumeAgentOptions) => (
    await createHandle(String(options.resumeSessionId), options.setup)
  ).handle)
  const getMock = vi.fn((id: SessionId) => live.get(String(id)))

  const mounted = vi.fn(async () => {})
  const permissionSet = vi.fn()
  const flush = vi.fn(async () => {})
  const attachSession = vi.fn(async () => {})
  const workspaceStatus = vi.fn(async () => 'ok' as const)
  const workspace = { attachSession, status: workspaceStatus }
  const workspaceGet = vi.fn((id: WorkspaceId) => (String(id) === WORKSPACE_ID ? workspace : undefined))

  const ctx = {
    logger: { warn: vi.fn() },
    on,
    agents: { get: getMock, create: createMock, resume: resumeMock },
    agentPresets: { mount: mounted },
    permissionPresets: { set: permissionSet },
    sessions: { flush },
    workspaceRegistry: { get: workspaceGet },
  } as unknown as Context

  let current = instance(overrides)
  const getAssistantInstance = vi.fn((id: string) => {
    if (id !== current.id) {
      throw new AgentTeamError('ASSISTANT_INSTANCE_NOT_FOUND', `Unknown assistant instance '${id}'`)
    }
    return current
  })
  const bindAssistantMainSession = vi.fn(async (id: string, sessionId: string) => {
    if (id !== current.id) {
      throw new AgentTeamError('ASSISTANT_INSTANCE_NOT_FOUND', `Unknown assistant instance '${id}'`)
    }
    current = {
      ...current,
      mainSessionId: sessionId,
      status: 'active',
      revision: current.revision + 1,
      updatedAt: NOW,
    }
    return current
  })

  const tasks = new Map<string, AssistantSession>()
  let nextTaskNumber = 1
  const createAssistantSession = vi.fn(async (input: CreateAssistantSessionInput) => {
    const task: AssistantSession = {
      schemaVersion: 1,
      id: `task-${nextTaskNumber}`,
      assistantId: input.assistantId,
      sessionId: input.sessionId,
      role: 'task',
      title: input.title,
      brief: input.brief,
      parentSessionId: input.parentSessionId,
      status: 'queued',
      createdAt: NOW,
      updatedAt: NOW,
    }
    nextTaskNumber += 1
    tasks.set(task.id, task)
    return task
  })
  const getAssistantSession = vi.fn((id: string) => {
    const task = tasks.get(id)
    if (task === undefined) {
      throw new AgentTeamError('ASSISTANT_TASK_NOT_FOUND', `Unknown assistant task '${id}'`)
    }
    return task
  })
  const listAssistantSessions = vi.fn((assistantId?: string) => {
    const items = [...tasks.values()]
      .filter(task => assistantId === undefined || task.assistantId === assistantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    return { items, total: items.length }
  })
  const updateAssistantSession = vi.fn(async (
    id: string,
    patch: UpdateAssistantSessionInput,
  ) => {
    const task = getAssistantSession(id)
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    )
    const next: AssistantSession = {
      ...task,
      ...defined,
      updatedAt: NOW,
    }
    tasks.set(id, next)
    return next
  })

  const service = {
    getAssistantInstance,
    bindAssistantMainSession,
    createAssistantSession,
    getAssistantSession,
    listAssistantSessions,
    updateAssistantSession,
  } as unknown as AgentTeamService

  return {
    runtime: new AssistantRuntime(ctx, config, service),
    ctx,
    service,
    getAssistantInstance,
    bindAssistantMainSession,
    createAssistantSession,
    getAssistantSession,
    listAssistantSessions,
    updateAssistantSession,
    createMock,
    resumeMock,
    getMock,
    mounted,
    permissionSet,
    flush,
    workspace,
    attachSession,
    workspaceStatus,
    workspaceGet,
    handles,
    createHandle,
    emit,
    tasks,
    current: () => current,
    setLive(sessionId: string) {
      live.set(sessionId, { id: SessionId(sessionId) } as unknown as Agent)
    },
  }
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return content.flatMap(block => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n')
}

function toolsRegistered(record: AgentRecord | undefined): string[] {
  return (record?.toolsRegister.mock.calls ?? []).map(call => (call[0] as { name: string }).name)
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AssistantRuntime', () => {
  it('creates, configures, binds, and reuses one main Session', async () => {
    const h = createHarness()

    const first = await h.runtime.ensureInstance('instance-1')

    expect(first.sessionId).toMatch(/^session-/)
    expect(first.instance).toMatchObject({
      id: 'instance-1',
      mainSessionId: first.sessionId,
      status: 'active',
      revision: 2,
    })
    expect(h.createMock).toHaveBeenCalledTimes(1)
    expect(h.resumeMock).not.toHaveBeenCalled()

    const createOptions = h.createMock.mock.calls[0]?.[0] as CreateAgentOptions
    expect(String(createOptions.sessionId)).toBe(first.sessionId)
    expect(createOptions.meta).toEqual({ cwd: WORKSPACE_PATH, agentPreset: 'default' })
    expect(createOptions.agentOptions).toMatchObject({ provider: 'openai', model: 'gpt-5' })
    expect(String(createOptions.agentOptions?.reasoningEffort)).toBe('high')

    expect(h.workspaceGet).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(h.workspaceStatus).toHaveBeenCalledTimes(1)
    expect(h.attachSession).toHaveBeenCalledWith(first.sessionId)
    expect(h.flush).toHaveBeenCalledWith(h.handles[0]?.agent.session)
    expect(h.bindAssistantMainSession).toHaveBeenCalledWith('instance-1', first.sessionId)

    const record = h.handles[0]
    expect(record).toBeDefined()
    expect(h.mounted).toHaveBeenCalledWith(record?.agentCtx, 'default')
    expect(installModelSelection).toHaveBeenCalledTimes(1)
    const selection = vi.mocked(installModelSelection).mock.calls[0]?.[1]
    expect(selection?.current ?? {}).toMatchObject({ provider: 'openai', model: 'gpt-5' })
    expect(String(selection?.current?.reasoningEffort)).toBe('high')
    expect(h.permissionSet).toHaveBeenCalledWith(record?.agent.session, 'workspace-write')
    const prompt = record?.section.mock.calls[0]?.[0] as {
      name: string
      order: number
      text: () => string
    }
    expect(prompt.name).toContain('assistant-identity')
    expect(prompt.order).toBe(10)
    expect(prompt.text()).toBe(
      'You are Researcher, a persistent assistant for one workspace.\n\nCite sources.',
    )

    const second = await h.runtime.ensureInstance('instance-1')
    expect(second).toEqual(first)
    expect(h.createMock).toHaveBeenCalledTimes(1)
    expect(h.attachSession).toHaveBeenCalledTimes(1)
    expect(h.bindAssistantMainSession).toHaveBeenCalledTimes(1)
  })

  it('registers exactly the task tools on the main Session', async () => {
    const h = createHarness()

    await h.runtime.ensureInstance('instance-1')

    expect(toolsRegistered(h.handles[0]).sort()).toEqual([...TASK_TOOL_NAMES].sort())
  })

  it('creates a hidden worker, persists the task, and delivers the brief', async () => {
    const h = createHarness()

    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Compare the three vendors and return a table.',
    })

    expect(h.createMock).toHaveBeenCalledTimes(2)
    expect(task).toMatchObject({
      assistantId: 'instance-1',
      title: 'Research pricing',
      brief: 'Compare the three vendors and return a table.',
      role: 'task',
      status: 'running',
    })
    expect(task.parentSessionId).toBe(h.current().mainSessionId)
    expect(h.createAssistantSession).toHaveBeenCalledWith({
      assistantId: 'instance-1',
      sessionId: task.sessionId,
      title: 'Research pricing',
      brief: 'Compare the three vendors and return a table.',
      parentSessionId: h.current().mainSessionId,
    })

    const workerOptions = h.createMock.mock.calls[1]?.[0] as CreateAgentOptions
    expect(String(workerOptions.sessionId)).toBe(task.sessionId)
    expect(workerOptions.sessionId).not.toBe(h.current().mainSessionId)
    expect(workerOptions.meta).toEqual({ cwd: WORKSPACE_PATH, agentPreset: 'default' })
    expect(workerOptions.agentOptions).toMatchObject({ provider: 'openai', model: 'gpt-5' })
    expect(String(workerOptions.agentOptions?.reasoningEffort)).toBe('high')

    const worker = h.handles[1]
    expect(worker).toBeDefined()
    expect(h.attachSession).toHaveBeenCalledWith(task.sessionId)
    expect(h.flush).toHaveBeenCalledWith(worker?.agent.session)
    expect(h.permissionSet).toHaveBeenCalledWith(worker?.agent.session, 'workspace-write')
    expect(worker?.followup).toHaveBeenCalledTimes(1)
    expect(textOf(worker?.followup.mock.calls[0]?.[0])).toBe(
      'Compare the three vendors and return a table.',
    )
    const prompt = worker?.section.mock.calls[0]?.[0] as { name: string; text: () => string }
    expect(prompt.name).toContain('assistant-worker')
    expect(prompt.text()).toContain('hidden background worker')
    expect(prompt.text()).toContain('Cite sources.')
    expect(toolsRegistered(worker)).toEqual([])
  })

  it('sends follow-ups, tracks running/idle, and completes the task', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Task', brief: 'Start.' })
    const worker = h.handles[1]
    expect(worker).toBeDefined()

    const sent = await h.runtime.sendTask('instance-1', task.id, 'Also cover renewals.')
    expect(sent.status).toBe('running')
    expect(worker?.followup).toHaveBeenCalledTimes(2)
    expect(textOf(worker?.followup.mock.calls[1]?.[0])).toBe('Also cover renewals.')

    h.emit('agent/status', { agent: worker?.agent, status: 'running' })
    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()

    expect(h.getAssistantSession(task.id).status).toBe('completed')

    const waited = await h.runtime.waitTask('instance-1', task.id, 1_000)
    expect(waited).toMatchObject({ timedOut: false })
    expect(waited.task.status).toBe('completed')
  })

  it('marks a worker failed on a turn error and does not overwrite it on idle', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Task', brief: 'Start.' })
    const worker = h.handles[1]

    h.emit('session/event', {
      id: worker?.agent.session.id,
    }, {
      type: 'turn/end',
      seq: 2,
      time: 2,
      data: { reason: { kind: 'error', error: { message: 'provider exploded' } } },
    })
    await settle()
    expect(h.getAssistantSession(task.id)).toMatchObject({
      status: 'failed',
      error: 'provider exploded',
    })

    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('failed')
  })

  it('times out a wait instead of blocking forever', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Task', brief: 'Start.' })

    const waited = await h.runtime.waitTask('instance-1', task.id, 5)

    expect(waited.timedOut).toBe(true)
    expect(waited.task.status).toBe('running')
  })

  it('summarizes recent worker messages and persists the result summary', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Task', brief: 'Start.' })
    const worker = h.handles[1]
    expect(worker).toBeDefined()
    worker!.events.push(
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          id: 'message-1',
          content: [{ type: 'text', text: 'Start.' }],
          source: { kind: 'user' },
        },
      } as unknown as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'message-2',
            content: [{ type: 'text', text: 'Vendors compared: A, B, C.' }],
          },
          stream: [],
        },
      } as unknown as SessionEvent,
    )

    const summary = await h.runtime.summaryTask('instance-1', task.id)

    expect(summary.summary).toBe('Vendors compared: A, B, C.')
    expect(summary.messages.map(message => message.kind)).toEqual(['user', 'assistant'])
    expect(h.getAssistantSession(task.id).resultSummary).toBe('Vendors compared: A, B, C.')
  })

  it('cancels the live worker turn and marks the task cancelled', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Task', brief: 'Start.' })
    const worker = h.handles[1]

    const cancelled = await h.runtime.cancelTask('instance-1', task.id)

    expect(cancelled.status).toBe('cancelled')
    expect(worker?.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(worker?.whenIdle).toHaveBeenCalledTimes(1)

    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('cancelled')
  })

  it('rejects task tools for a Session that is not the assistant main Session', async () => {
    const h = createHarness()
    await h.runtime.ensureInstance('instance-1')
    const main = h.handles[0]
    const registered = main?.toolsRegister.mock.calls.find(
      call => (call[0] as { name: string }).name === 'assistant_task_list',
    )?.[0] as { execute: (args: unknown, exec: { agent: Agent }) => Promise<unknown> }

    await expect(registered.execute({}, {
      agent: { id: SessionId('session-other') } as unknown as Agent,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('resumes a bound Session instead of creating a replacement', async () => {
    const h = createHarness({ mainSessionId: 'session-bound', status: 'active' })

    const first = await h.runtime.ensureInstance('instance-1')

    expect(first.sessionId).toBe('session-bound')
    expect(h.createMock).not.toHaveBeenCalled()
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    const resumeOptions = h.resumeMock.mock.calls[0]?.[0] as ResumeAgentOptions
    expect(String(resumeOptions.resumeSessionId)).toBe('session-bound')
    expect(resumeOptions.agentOptions).toMatchObject({ provider: 'openai', model: 'gpt-5' })
    expect(h.attachSession).toHaveBeenCalledWith('session-bound')
    expect(h.bindAssistantMainSession).toHaveBeenCalledWith('instance-1', 'session-bound')

    const second = await h.runtime.ensureInstance('instance-1')
    expect(second).toEqual(first)
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an archived instance before touching Agent state', async () => {
    const h = createHarness({ status: 'archived' })

    await expect(h.runtime.ensureInstance('instance-1')).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(h.createMock).not.toHaveBeenCalled()
    expect(h.resumeMock).not.toHaveBeenCalled()
    expect(h.attachSession).not.toHaveBeenCalled()
  })

  it('passively opens a live but unowned main Session', async () => {
    const h = createHarness({ mainSessionId: 'session-bound', status: 'active' })
    h.setLive('session-bound')

    await expect(h.runtime.ensureInstance('instance-1')).resolves.toMatchObject({
      sessionId: 'session-bound',
    })
    expect(h.resumeMock).not.toHaveBeenCalled()
    expect(h.createMock).not.toHaveBeenCalled()
    expect(h.bindAssistantMainSession).not.toHaveBeenCalled()
  })

  it('fails a missing bound Session without creating a replacement', async () => {
    const h = createHarness({ mainSessionId: 'session-gone', status: 'active' })
    h.resumeMock.mockRejectedValueOnce(new Error('Session is not persisted'))

    const error = await h.runtime.ensureInstance('instance-1').catch(value => value)
    expect(error).toBeInstanceOf(AgentTeamError)
    expect(error).toMatchObject({ code: 'SESSION_CREATE_FAILED' })
    expect(h.createMock).not.toHaveBeenCalled()
    expect(h.attachSession).not.toHaveBeenCalled()
    expect(h.bindAssistantMainSession).not.toHaveBeenCalled()
  })

  it('fails fast when the workspace is unavailable', async () => {
    const h = createHarness({ workspaceId: 'missing-workspace' })

    await expect(h.runtime.ensureInstance('instance-1')).rejects
      .toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
    expect(h.createMock).not.toHaveBeenCalled()
    expect(h.resumeMock).not.toHaveBeenCalled()
  })

  it('disposes the fresh handle when workspace attachment fails', async () => {
    const h = createHarness()
    h.attachSession.mockRejectedValueOnce(new Error('attach failed'))

    await expect(h.runtime.ensureInstance('instance-1')).rejects
      .toMatchObject({ code: 'SESSION_CREATE_FAILED' })
    expect(h.handles[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(h.bindAssistantMainSession).not.toHaveBeenCalled()
    expect(h.flush).not.toHaveBeenCalled()
  })

  it('serializes concurrent ensure calls per instance', async () => {
    const h = createHarness()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = h.createMock.getMockImplementation()
    expect(original).toBeDefined()
    h.createMock.mockImplementationOnce(async (options: CreateAgentOptions) => {
      await gate
      return original!(options)
    })

    const first = h.runtime.ensureInstance('instance-1')
    const second = h.runtime.ensureInstance('instance-1')
    release()
    const [left, right] = await Promise.all([first, second])

    expect(h.createMock).toHaveBeenCalledTimes(1)
    expect(left).toEqual(right)
    expect(h.bindAssistantMainSession).toHaveBeenCalledTimes(1)
  })

  it('cancels and disposes owned handles and refuses later ensures', async () => {
    const h = createHarness()
    await h.runtime.ensureInstance('instance-1')
    const record = h.handles[0]
    expect(record).toBeDefined()

    await h.runtime.dispose()

    expect(record?.agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(record?.dispose).toHaveBeenCalledTimes(1)
    await expect(h.runtime.ensureInstance('instance-1')).rejects
      .toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
