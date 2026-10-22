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
  AssistantMemory,
  AssistantSession,
  CreateAssistantSessionInput,
  MemoryEntry,
  UpdateAssistantSessionInput,
  WriteAssistantMemoryEntryInput,
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

const MEMORY_TOOL_NAMES = [
  'assistant_memory_read',
  'assistant_memory_write',
  'assistant_memory_entry_write',
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

function createHarness(
  overrides: Partial<AssistantInstance> = {},
  configOverrides: Partial<Config> = {},
) {
  const handles: AgentRecord[] = []
  const live = new Map<string, Agent>()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const persistedEvents = new Map<string, SessionEvent[]>()

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
    persistedEvents.set(sessionId, events)
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
  const sessionPersistence = {
    open: vi.fn(async (id: SessionId) => ({
      read: async () => ({ events: [...(persistedEvents.get(String(id)) ?? [])] }),
      close: async () => {},
    })),
  }

  const ctx = {
    logger: { warn: vi.fn() },
    on,
    agents: { get: getMock, create: createMock, resume: resumeMock },
    agentPresets: { mount: mounted },
    permissionPresets: { set: permissionSet },
    sessions: { flush },
    sessionPersistence,
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

  const memories = new Map<string, AssistantMemory>()
  const getAssistantMemory = vi.fn((assistantId: string) => memories.get(assistantId))
  const writeAssistantMemory = vi.fn(async (
    assistantId: string,
    content: string,
    mode: 'replace' | 'append',
  ) => {
    const current = memories.get(assistantId)
    const next: AssistantMemory = {
      schemaVersion: 1,
      assistantId,
      content: mode === 'append' && current !== undefined && current.content !== ''
        ? `${current.content}\n${content}`
        : content,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: NOW,
    }
    memories.set(assistantId, next)
    return next
  })

  const writeAssistantMemoryEntry = vi.fn(async (
    assistantId: string,
    input: WriteAssistantMemoryEntryInput,
    options: { expectedRevision?: number } = {},
  ) => {
    const current = memories.get(assistantId)
    const currentRevision = current?.revision ?? 0
    if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
      throw new AgentTeamError(
        'MEMORY_REVISION_CONFLICT',
        `Memory revision conflict: expected ${options.expectedRevision}, current ${currentRevision}`,
      )
    }
    const entries = [...(current?.entries ?? [])]
    const existing = input.id === undefined
      ? undefined
      : entries.find(entry => entry.id === input.id)
    const entry: MemoryEntry = existing === undefined
      ? {
        id: input.id ?? `mem-${entries.length + 1}`,
        scope: 'assistant',
        visibility: input.visibility ?? 'private',
        status: input.status ?? 'active',
        source: 'assistant',
        ...(input.key === undefined ? {} : { key: input.key }),
        title: input.title,
        body: input.body,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }
      : {
        ...existing,
        title: input.title,
        body: input.body,
        visibility: input.visibility ?? existing.visibility,
        status: input.status ?? existing.status,
        ...(input.key === undefined ? {} : { key: input.key }),
        revision: existing.revision + 1,
        updatedAt: NOW,
      }
    const nextEntries = existing === undefined
      ? [...entries, entry]
      : entries.map(value => value.id === entry.id ? entry : value)
    const memory: AssistantMemory = {
      schemaVersion: 1,
      assistantId,
      content: current?.content ?? '',
      entries: nextEntries,
      revision: currentRevision + 1,
      updatedAt: NOW,
    }
    memories.set(assistantId, memory)
    return { memory, entry }
  })

  const service = {
    getAssistantInstance,
    bindAssistantMainSession,
    createAssistantSession,
    getAssistantSession,
    listAssistantSessions,
    updateAssistantSession,
    getAssistantMemory,
    writeAssistantMemory,
    writeAssistantMemoryEntry,
  } as unknown as AgentTeamService

  return {
    runtime: new AssistantRuntime(ctx, { ...config, ...configOverrides }, service),
    createRuntime(runtimeConfig: Partial<Config> = {}) {
      return new AssistantRuntime(ctx, { ...config, ...configOverrides, ...runtimeConfig }, service)
    },
    ctx,
    service,
    getAssistantInstance,
    bindAssistantMainSession,
    createAssistantSession,
    getAssistantSession,
    listAssistantSessions,
    updateAssistantSession,
    getAssistantMemory,
    writeAssistantMemory,
    writeAssistantMemoryEntry,
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
    memories,
    current: () => current,
    setLive(sessionId: string, agent?: Agent) {
      live.set(sessionId, agent ?? { id: SessionId(sessionId) } as unknown as Agent)
    },
    clearLive(sessionId: string) {
      live.delete(sessionId)
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
    const sections = record?.section.mock.calls.map(
      call => call[0] as { name: string; order: number; text: () => string },
    ) ?? []
    const memory = sections.find(section => section.name.includes('assistant-memory'))
    expect(memory?.order).toBe(9)
    expect(memory?.text()).toContain('Durable assistant memory')
    expect(memory?.text()).toContain('No memory has been saved yet.')

    const prompt = sections.find(section => section.name.includes('assistant-identity'))
    expect(prompt?.order).toBe(10)
    expect(prompt?.text()).toBe(
      'You are Researcher, a persistent assistant for one workspace.\n\nCite sources.',
    )

    const second = await h.runtime.ensureInstance('instance-1')
    expect(second).toEqual(first)
    expect(h.createMock).toHaveBeenCalledTimes(1)
    expect(h.attachSession).toHaveBeenCalledTimes(1)
    expect(h.bindAssistantMainSession).toHaveBeenCalledTimes(1)
  })

  it('registers exactly the task and memory tools on the main Session', async () => {
    const h = createHarness()

    await h.runtime.ensureInstance('instance-1')

    expect(toolsRegistered(h.handles[0]).sort())
      .toEqual([...TASK_TOOL_NAMES, ...MEMORY_TOOL_NAMES].sort())
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
    const sections = worker?.section.mock.calls.map(
      call => call[0] as { name: string; order: number; text: () => string },
    ) ?? []
    const workerMemory = sections.find(section => section.name.includes('assistant-worker-memory'))
    expect(workerMemory?.order).toBe(9)
    expect(workerMemory?.text()).toContain('Durable assistant memory')
    expect(workerMemory?.text()).toContain('this worker cannot change it')

    const prompt = sections.find(section => section.name.includes('assistant-worker:'))
    expect(prompt?.name).toContain('assistant-worker')
    expect(prompt?.text()).toContain('hidden background worker')
    expect(prompt?.text()).toContain('Cite sources.')
    expect(toolsRegistered(worker)).toEqual([])
  })

  it('injects bounded durable memory before identity and into workers', async () => {
    const h = createHarness()
    h.memories.set('instance-1', {
      schemaVersion: 1,
      assistantId: 'instance-1',
      content: `${'A'.repeat(5_000)}TAIL-MARKER`,
      revision: 4,
      updatedAt: NOW,
    })

    await h.runtime.createTask('instance-1', { title: 'Use memory', brief: 'Start.' })

    const mainSections = h.handles[0]?.section.mock.calls.map(
      call => call[0] as { name: string; order: number; text: () => string },
    ) ?? []
    const mainMemory = mainSections.find(section => section.name.includes('assistant-memory'))
    expect(mainMemory?.order).toBe(9)
    expect(mainMemory?.text()).toContain('Durable assistant memory')
    expect(mainMemory?.text()).toContain('assistant_memory_read')
    expect(mainMemory?.text()).not.toContain('TAIL-MARKER')
    expect(mainMemory!.text().length).toBeLessThan(4_400)

    const workerSections = h.handles[1]?.section.mock.calls.map(
      call => call[0] as { name: string; order: number; text: () => string },
    ) ?? []
    const workerMemory = workerSections.find(
      section => section.name.includes('assistant-worker-memory'),
    )
    expect(workerMemory?.order).toBe(9)
    expect(workerMemory?.text()).toContain('Durable assistant memory')
    expect(workerMemory?.text()).toContain('this worker cannot change it')
    expect(workerMemory?.text()).not.toContain('TAIL-MARKER')
  })

  it('registers memory tools on the main Session and rejects other Sessions', async () => {
    const h = createHarness()
    await h.runtime.ensureInstance('instance-1')
    const main = h.handles[0]
    const mainSessionId = h.current().mainSessionId
    expect(mainSessionId).toBeDefined()
    const mainAgent = { id: SessionId(mainSessionId!) } as unknown as Agent
    const otherAgent = { id: SessionId('session-other') } as unknown as Agent
    const findTool = (name: string) => main?.toolsRegister.mock.calls.find(
      call => (call[0] as { name: string }).name === name,
    )?.[0] as unknown as {
      execute: (args: Record<string, unknown>, exec: { agent: Agent }) => Promise<Record<string, unknown>>
    }

    const read = findTool('assistant_memory_read')
    const write = findTool('assistant_memory_write')
    expect(read).toBeDefined()
    expect(write).toBeDefined()

    await expect(read.execute({}, { agent: otherAgent }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(write.execute({ content: 'x', mode: 'replace' }, { agent: otherAgent }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const written = await write.execute(
      { content: 'Prefers tables.', mode: 'append' },
      { agent: mainAgent },
    )
    expect(h.writeAssistantMemory).toHaveBeenCalledWith(
      'instance-1',
      'Prefers tables.',
      'append',
    )
    expect(written).toMatchObject({
      assistant_id: 'instance-1',
      mode: 'append',
      revision: 1,
      content_length: 15,
    })

    const readResult = await read.execute({}, { agent: mainAgent })
    expect(readResult).toMatchObject({
      memory: {
        assistant_id: 'instance-1',
        content: 'Prefers tables.',
        revision: 1,
      },
    })
  })

  it('injects active structured entries into the main prompt only', async () => {
    const h = createHarness()
    h.memories.set('instance-1', {
      schemaVersion: 1,
      assistantId: 'instance-1',
      content: 'Prefers tables.',
      entries: [
        {
          id: 'mem-1',
          scope: 'assistant',
          visibility: 'private',
          status: 'active',
          source: 'assistant',
          title: 'Tone',
          body: 'Be terse.',
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: 'mem-2',
          scope: 'assistant',
          visibility: 'team-safe',
          status: 'archived',
          source: 'assistant',
          title: 'Retired fact',
          body: 'SHOULD-NOT-APPEAR',
          revision: 2,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      revision: 3,
      updatedAt: NOW,
    })

    await h.runtime.createTask('instance-1', { title: 'Use entries', brief: 'Start.' })

    const sections = h.handles[0]?.section.mock.calls.map(
      call => call[0] as { name: string; text: () => string },
    ) ?? []
    const mainMemory = sections.find(section => section.name.includes('assistant-memory'))
    expect(mainMemory?.text()).toContain('Prefers tables.')
    expect(mainMemory?.text()).toContain('[private] Tone: Be terse.')
    expect(mainMemory?.text()).toContain('assistant_memory_entry_write')
    expect(mainMemory?.text()).not.toContain('SHOULD-NOT-APPEAR')

    const workerSections = h.handles[1]?.section.mock.calls.map(
      call => call[0] as { name: string; text: () => string },
    ) ?? []
    const workerMemory = workerSections.find(
      section => section.name.includes('assistant-worker-memory'),
    )
    expect(workerMemory?.text()).toContain('this worker cannot change it')
    expect(workerMemory?.text()).not.toContain('Tone: Be terse.')
    expect(workerMemory?.text()).not.toContain('SHOULD-NOT-APPEAR')
  })

  it('writes structured entries with a document revision fence', async () => {
    const h = createHarness()
    await h.runtime.ensureInstance('instance-1')
    const main = h.handles[0]
    const mainAgent = { id: SessionId(h.current().mainSessionId!) } as unknown as Agent
    const findTool = (name: string) => main?.toolsRegister.mock.calls.find(
      call => (call[0] as { name: string }).name === name,
    )?.[0] as unknown as {
      execute: (args: Record<string, unknown>, exec: { agent: Agent }) => Promise<Record<string, unknown>>
    }

    const write = findTool('assistant_memory_entry_write')
    const read = findTool('assistant_memory_read')
    expect(write).toBeDefined()

    const created = await write.execute(
      { expected_revision: 0, title: 'Tone', body: 'Be terse.' },
      { agent: mainAgent },
    )
    expect(h.writeAssistantMemoryEntry).toHaveBeenCalledWith(
      'instance-1',
      { title: 'Tone', body: 'Be terse.' },
      { expectedRevision: 0 },
    )
    expect(created).toMatchObject({
      assistant_id: 'instance-1',
      memory_revision: 1,
      entry: {
        visibility: 'private',
        status: 'active',
        source: 'assistant',
        revision: 1,
        title: 'Tone',
        body: 'Be terse.',
      },
    })

    const readResult = await read.execute({}, { agent: mainAgent })
    expect(readResult).toMatchObject({
      memory: {
        revision: 1,
        entries: [{ entry_id: 'mem-1', title: 'Tone' }],
      },
    })

    await expect(write.execute(
      { expected_revision: 0, title: 'Stale', body: 'Should not land.' },
      { agent: mainAgent },
    )).rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' })
    expect(h.getAssistantMemory('instance-1')?.entries).toHaveLength(1)
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
    expect(worker?.dispose).toHaveBeenCalledTimes(1)

    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('failed')
  })

  it('maps waiting_approval to needs_input, resumes on running, and never auto-completes it', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Approval task', brief: 'Start.' })
    const worker = h.handles[1]
    expect(worker).toBeDefined()

    h.emit('agent/status', { agent: worker?.agent, status: 'waiting_approval' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('needs_input')

    h.emit('agent/status', { agent: worker?.agent, status: 'running' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('running')

    h.emit('agent/status', { agent: worker?.agent, status: 'waiting_approval' })
    await settle()
    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('needs_input')
  })

  it('keeps needs_input visible in task lists and the prompt digest', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Blocked task', brief: 'Start.' })
    const worker = h.handles[1]
    h.emit('agent/status', { agent: worker?.agent, status: 'waiting_approval' })
    await settle()

    expect(h.runtime.listTasks('instance-1').map(item => item.status)).toEqual(['needs_input'])

    const sections = h.handles[0]?.section.mock.calls.map(
      call => call[0] as { name: string; text: () => string },
    ) ?? []
    const digest = sections.find(section => section.name.includes('assistant-tasks'))
    expect(digest?.text()).toContain('[needs_input]')
    expect(digest?.text()).toContain(task.id)
  })

  it('does not overwrite terminal tasks on waiting_approval or idle', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Done task', brief: 'Start.' })
    const worker = h.handles[1]
    await h.updateAssistantSession(task.id, { status: 'completed' })

    h.emit('agent/status', { agent: worker?.agent, status: 'waiting_approval' })
    h.emit('agent/status', { agent: worker?.agent, status: 'running' })
    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('completed')

    await h.updateAssistantSession(task.id, { status: 'cancelled' })
    h.emit('agent/status', { agent: worker?.agent, status: 'waiting_approval' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('cancelled')
  })

  it('disposes a completed worker and summarizes from its stored Session log', async () => {
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
            content: [{ type: 'text', text: 'Stored completion.' }],
          },
          stream: [],
        },
      } as unknown as SessionEvent,
    )

    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()

    expect(h.getAssistantSession(task.id).status).toBe('completed')
    expect(worker?.dispose).toHaveBeenCalledTimes(1)
    expect(h.flush).toHaveBeenCalledWith(worker?.agent.session)

    const summary = await h.runtime.summaryTask('instance-1', task.id)
    expect(summary.summary).toBe('Stored completion.')
    expect(summary.messages.map(message => message.kind)).toEqual(['user', 'assistant'])
  })

  it('re-resumes a released completed worker from sendTask', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Task', brief: 'Start.' })
    const worker = h.handles[1]
    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    expect(worker?.dispose).toHaveBeenCalledTimes(1)

    const sent = await h.runtime.sendTask('instance-1', task.id, 'Continue.')

    expect(sent.status).toBe('running')
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    const resumed = h.handles[2]
    expect(resumed).toBeDefined()
    expect(resumed?.followup).toHaveBeenCalledTimes(1)
    expect(textOf(resumed?.followup.mock.calls[0]?.[0])).toBe('Continue.')
  })

  it('opens a released task by resuming its worker without changing status', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Task', brief: 'Start.' })
    const worker = h.handles[1]
    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    expect(worker?.dispose).toHaveBeenCalledTimes(1)

    const opened = await h.runtime.openTask(task.id)

    expect(opened.task).toMatchObject({ id: task.id, status: 'completed' })
    expect(opened.sessionId).toBe(task.sessionId)
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    expect(h.getAssistantSession(task.id).status).toBe('completed')
  })

  it('opens a live task without resuming or changing its status', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Task', brief: 'Start.' })

    const opened = await h.runtime.openTask(task.id)

    expect(opened.task.status).toBe('running')
    expect(opened.sessionId).toBe(task.sessionId)
    expect(h.resumeMock).not.toHaveBeenCalled()
  })

  it('cancels active tasks and disposes their workers before archive', async () => {
    const h = createHarness()
    const active = await h.runtime.createTask('instance-1', { title: 'Active', brief: 'Start.' })
    const done = await h.runtime.createTask('instance-1', { title: 'Done', brief: 'Start.' })
    const main = h.handles[0]
    const activeWorker = h.handles[1]
    const doneWorker = h.handles[2]
    h.emit('agent/status', { agent: doneWorker?.agent, status: 'idle' })
    await settle()
    expect(h.getAssistantSession(done.id).status).toBe('completed')

    await h.runtime.stopForArchive('instance-1')

    expect(h.getAssistantSession(active.id).status).toBe('cancelled')
    expect(h.getAssistantSession(done.id).status).toBe('completed')
    expect(activeWorker?.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(activeWorker?.dispose).toHaveBeenCalledTimes(1)
    expect(doneWorker?.dispose).toHaveBeenCalledTimes(1)
    expect(main?.dispose).not.toHaveBeenCalled()
  })

  it('cancels a running worker on archive even when it had no live handle', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Task', brief: 'Start.' })
    const recovered = h.createRuntime()

    await recovered.stopForArchive('instance-1')

    expect(h.getAssistantSession(task.id).status).toBe('cancelled')
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
    expect(worker?.dispose).toHaveBeenCalledTimes(1)

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

  it('refuses a live main Session owned by another lifecycle', async () => {
    const h = createHarness({ mainSessionId: 'session-bound', status: 'active' })
    const cancel = vi.fn()
    const dispose = vi.fn(async () => {})
    const foreign = {
      id: SessionId('session-bound'),
      cancel,
      dispose,
    } as unknown as Agent
    h.setLive('session-bound', foreign)

    const error = await h.runtime.ensureInstance('instance-1').catch(value => value)

    expect(error).toBeInstanceOf(AgentTeamError)
    expect(error).toMatchObject({
      code: 'AGENT_HANDLE_OWNERSHIP_CONFLICT',
      details: { instanceId: 'instance-1', sessionId: 'session-bound' },
    })
    expect(h.resumeMock).not.toHaveBeenCalled()
    expect(h.createMock).not.toHaveBeenCalled()
    expect(h.bindAssistantMainSession).not.toHaveBeenCalled()
    expect(h.attachSession).not.toHaveBeenCalled()
    expect(h.flush).not.toHaveBeenCalled()

    await h.runtime.dispose()

    // The foreign Agent is never cancelled or disposed by this runtime.
    expect(cancel).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('reattaches the assistant surface after the conflicting owner releases the Session', async () => {
    const h = createHarness({ mainSessionId: 'session-bound', status: 'active' })
    h.setLive('session-bound')

    await expect(h.runtime.ensureInstance('instance-1'))
      .rejects.toMatchObject({ code: 'AGENT_HANDLE_OWNERSHIP_CONFLICT' })

    h.clearLive('session-bound')
    const recovered = await h.runtime.ensureInstance('instance-1')

    expect(recovered.sessionId).toBe('session-bound')
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    expect(String((h.resumeMock.mock.calls[0]?.[0] as ResumeAgentOptions).resumeSessionId))
      .toBe('session-bound')
    expect(h.bindAssistantMainSession).toHaveBeenCalledWith('instance-1', 'session-bound')
    expect(toolsRegistered(h.handles[0]).sort())
      .toEqual([...TASK_TOOL_NAMES, ...MEMORY_TOOL_NAMES].sort())

    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    expect(task.parentSessionId).toBe('session-bound')
    expect(h.createMock).toHaveBeenCalledTimes(1)
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

  it('recovers a dropped worker by resuming its Session on send', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    const recovered = h.createRuntime()

    const sent = await recovered.sendTask('instance-1', task.id, 'Continue with renewals.')

    expect(sent.status).toBe('running')
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    const resumeOptions = h.resumeMock.mock.calls[0]?.[0] as ResumeAgentOptions
    expect(String(resumeOptions.resumeSessionId)).toBe(task.sessionId)
    expect(resumeOptions.agentOptions).toMatchObject({ provider: 'openai', model: 'gpt-5' })
    const resumed = h.handles[2]
    expect(resumed).toBeDefined()
    expect(h.attachSession).toHaveBeenCalledWith(task.sessionId)
    expect(h.flush).toHaveBeenCalledWith(resumed?.agent.session)
    expect(resumed?.followup).toHaveBeenCalledTimes(1)
    expect(textOf(resumed?.followup.mock.calls[0]?.[0])).toBe('Continue with renewals.')
    expect(h.mounted).toHaveBeenCalledWith(resumed?.agentCtx, 'default')
    expect(h.permissionSet).toHaveBeenCalledWith(resumed?.agent.session, 'workspace-write')
    const sections = resumed?.section.mock.calls.map(
      call => call[0] as { name: string; text: () => string },
    ) ?? []
    const prompt = sections.find(section => section.name.includes('assistant-worker:'))
    expect(prompt?.name).toContain('assistant-worker')
    expect(prompt?.text()).toContain('Research pricing')
  })

  it('uses a live unowned worker without resuming or disposing it', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    const worker = h.handles[1]
    expect(worker).toBeDefined()
    h.setLive(task.sessionId, worker!.agent)
    const recovered = h.createRuntime()

    await recovered.sendTask('instance-1', task.id, 'Keep going.')

    expect(h.resumeMock).not.toHaveBeenCalled()
    expect(worker?.followup).toHaveBeenCalledTimes(2)
    expect(textOf(worker?.followup.mock.calls[1]?.[0])).toBe('Keep going.')
    expect(vi.mocked(h.ctx.logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('already live'),
    )

    await recovered.dispose()

    expect(worker?.dispose).not.toHaveBeenCalled()
    expect(worker?.cancel).not.toHaveBeenCalled()
  })

  it('reports ASSISTANT_TASK_NOT_ACTIVE when worker recovery fails', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    h.resumeMock.mockRejectedValueOnce(new Error('Session is not persisted'))
    const recovered = h.createRuntime()

    const error = await recovered.sendTask('instance-1', task.id, 'Continue.').catch(value => value)

    expect(error).toBeInstanceOf(AgentTeamError)
    expect(error).toMatchObject({
      code: 'ASSISTANT_TASK_NOT_ACTIVE',
      details: { taskId: task.id, cause: 'Session is not persisted' },
    })
    expect((error as Error).cause).toBeInstanceOf(Error)
  })

  it('enforces the per-assistant worker limit and frees capacity after terminal', async () => {
    const h = createHarness({}, { assistantWorkerConcurrency: 1 })
    const first = await h.runtime.createTask('instance-1', { title: 'First', brief: 'Start.' })

    await expect(h.runtime.createTask('instance-1', { title: 'Second', brief: 'Start.' }))
      .rejects.toMatchObject({ code: 'ASSISTANT_WORKER_LIMIT' })
    expect(h.createMock).toHaveBeenCalledTimes(2)

    await h.updateAssistantSession(first.id, { status: 'completed' })
    const second = await h.runtime.createTask('instance-1', { title: 'Third', brief: 'Start.' })

    expect(second.status).toBe('running')
    expect(h.createMock).toHaveBeenCalledTimes(3)
  })

  it('puts bounded recent tasks and routing instructions into the main prompt', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'SECRET WORKER TRANSCRIPT',
    })

    const sections = h.handles[0]?.section.mock.calls.map(
      call => call[0] as { name: string; order: number; text: () => string },
    ) ?? []
    const digest = sections.find(section => section.order === 11)

    expect(digest).toBeDefined()
    const text = digest!.text()
    expect(text).toContain('Research pricing')
    expect(text).toContain(task.id)
    expect(text).toContain('[running]')
    expect(text).toContain('assistant_task_create')
    expect(text).toContain('assistant_task_send')
    expect(text).toContain('assistant_task_wait')
    expect(text).toContain('assistant_task_summary')
    expect(text).toContain('continue')
    expect(text).toContain('answer simple one-step requests directly')
    expect(text).toContain('ambiguous')
    expect(text).toContain('ask the user')
    expect(text).not.toContain('SECRET WORKER TRANSCRIPT')
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
