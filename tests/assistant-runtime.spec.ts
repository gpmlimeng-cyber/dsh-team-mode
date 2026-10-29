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
  CheckpointFacts,
  ContextCheckpoint,
  CreateAssistantSessionInput,
  MemoryEntry,
  TeamAggregate,
  TeamMemberSlot,
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

function coordinatorTeam(overrides: Partial<TeamAggregate> = {}): TeamAggregate {
  const leaderSlot: TeamMemberSlot = {
    id: 'leader-1',
    assistantId: 'template-1',
    displayName: 'Alice',
    role: 'leader',
    assistantSnapshot: instance().assistantSnapshot,
    permissionPresetId: 'workspace-write',
    sessionId: 'session-leader',
    desiredState: 'online',
    lastRuntimeState: 'idle',
    joinedAt: NOW,
  }
  return {
    schemaVersion: 2,
    id: 'team-1',
    name: 'Alpha',
    workspaceId: WORKSPACE_ID,
    workspacePath: WORKSPACE_PATH,
    leaderSlotId: leaderSlot.id,
    state: 'active',
    directMemberChat: false,
    members: { [leaderSlot.id]: leaderSlot },
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
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
  // Worker-scoped handlers (the interaction bridge's two waterfalls) live on
  // each Agent context, separate from the runtime listeners above.
  const agentListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const agentOn = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    const set = agentListeners.get(event) ?? new Set()
    set.add(listener)
    agentListeners.set(event, set)
    return () => { set.delete(listener) }
  })
  const fireAgent = (event: string, ...args: unknown[]): void => {
    for (const listener of agentListeners.get(event) ?? []) listener(...args)
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
      on: agentOn,
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
    stat: vi.fn(async (id: SessionId) => (
      persistedEvents.has(String(id))
        ? { header: { id }, revision: 0 }
        : undefined
    )),
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
  const teamRows: TeamAggregate[] = []
  const listTeams = vi.fn(() => ({ items: [...teamRows], total: teamRows.length }))
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
  const persistAssistantArchived = vi.fn(async (id: string) => {
    if (id !== current.id) {
      throw new AgentTeamError('ASSISTANT_INSTANCE_NOT_FOUND', `Unknown assistant instance '${id}'`)
    }
    if (current.status !== 'archived') {
      current = {
        ...current,
        status: 'archived',
        archivedAt: NOW,
        revision: current.revision + 1,
        updatedAt: NOW,
      }
    }
    return current
  })
  const attachAssistantThread = vi.fn(async (id: string, sessionId: string) => {
    if (id !== current.id) {
      throw new AgentTeamError('ASSISTANT_INSTANCE_NOT_FOUND', `Unknown assistant instance '${id}'`)
    }
    if (current.status === 'archived') {
      throw new AgentTeamError('ASSISTANT_INSTANCE_ARCHIVED', `Assistant instance '${id}' is archived`)
    }
    current = {
      ...current,
      threadSessionIds: [...(current.threadSessionIds ?? []), sessionId],
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
  const markAssistantTaskStarted = vi.fn(async (id: string) => {
    const task = getAssistantSession(id)
    // Conditional like the service: only a queued row may become running.
    if (task.status !== 'queued') return task
    const next: AssistantSession = {
      ...task,
      status: 'running',
      ...(task.startedAt === undefined ? { startedAt: NOW } : {}),
      updatedAt: NOW,
    }
    tasks.set(id, next)
    return next
  })
  const setAssistantTaskPaused = vi.fn(async (
    id: string,
    pausedBy: NonNullable<AssistantSession['pausedBy']>,
  ) => {
    const task = getAssistantSession(id)
    const next: AssistantSession = { ...task, status: 'paused', pausedBy, updatedAt: NOW }
    tasks.set(id, next)
    return next
  })
  const drainAssistantQueue = vi.fn(async (_assistantId: string) => {})

  const captureAssistantTaskMemory = vi.fn(async (_assistantId: string, _taskId: string) => true)

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

  const checkpoints = new Map<string, ContextCheckpoint>()
  const getContextCheckpoint = vi.fn((id: string) => {
    const checkpoint = checkpoints.get(id)
    if (checkpoint === undefined) {
      throw new AgentTeamError('CHECKPOINT_NOT_FOUND', `Unknown checkpoint '${id}'`)
    }
    return checkpoint
  })
  const advanceAssistantMainSession = vi.fn(async (
    id: string,
    mainSessionId: string,
    retiredSessionId: string,
  ) => {
    if (id !== current.id) {
      throw new AgentTeamError('ASSISTANT_INSTANCE_NOT_FOUND', `Unknown assistant instance '${id}'`)
    }
    const retiredIds = [...(current.retiredMainSessionIds ?? [])]
    if (retiredSessionId !== '' && !retiredIds.includes(retiredSessionId)) retiredIds.push(retiredSessionId)
    current = {
      ...current,
      mainSessionId,
      retiredMainSessionIds: retiredIds,
      status: 'active',
      revision: current.revision + 1,
      updatedAt: NOW,
    }
    return current
  })
  const consumeContextCheckpoint = vi.fn(async (id: string, targetSessionId: string) => {
    const checkpoint = getContextCheckpoint(id)
    if (checkpoint.status !== 'ready') {
      throw new AgentTeamError('CHECKPOINT_NOT_READY', `Checkpoint '${id}' is ${checkpoint.status}`)
    }
    const next: ContextCheckpoint = {
      ...checkpoint,
      status: 'consumed',
      targetSessionId,
      consumedAt: NOW,
    }
    checkpoints.set(id, next)
    return next
  })
  const createContextCheckpoint = vi.fn(async (input: {
    assistantId: string
    sourceSessionId: string
    capturedThroughSeq: number
    facts: CheckpointFacts
    note: string
  }) => {
    const checkpoint: ContextCheckpoint = {
      schemaVersion: 1,
      id: `checkpoint-${checkpoints.size + 1}`,
      assistantId: input.assistantId,
      sourceSessionId: input.sourceSessionId,
      title: '检查点',
      note: input.note,
      capturedThroughSeq: input.capturedThroughSeq,
      facts: input.facts,
      status: 'ready',
      createdAt: NOW,
    }
    checkpoints.set(checkpoint.id, checkpoint)
    return checkpoint
  })
  const seedCheckpoint = (overrides: Partial<ContextCheckpoint> = {}): ContextCheckpoint => {
    const checkpoint: ContextCheckpoint = {
      schemaVersion: 1,
      id: 'checkpoint-1',
      assistantId: 'instance-1',
      sourceSessionId: 'session-main',
      title: 'Handoff at noon',
      note: 'continue the work',
      capturedThroughSeq: 3,
      facts: {
        recentMessages: [{ role: 'user', text: 'Build the handoff' }],
        activeTasks: [],
        workspacePath: WORKSPACE_PATH,
        note: 'continue the work',
      },
      status: 'ready',
      createdAt: NOW,
      ...overrides,
    }
    checkpoints.set(checkpoint.id, checkpoint)
    return checkpoint
  }

  const service = {
    getAssistantInstance,
    listTeams,
    bindAssistantMainSession,
    persistAssistantArchived,
    attachAssistantThread,
    getContextCheckpoint,
    advanceAssistantMainSession,
    consumeContextCheckpoint,
    createContextCheckpoint,
    createAssistantSession,
    getAssistantSession,
    listAssistantSessions,
    updateAssistantSession,
    markAssistantTaskStarted,
    setAssistantTaskPaused,
    drainAssistantQueue,
    notifyAssistantTaskChanged: vi.fn(),
    captureAssistantTaskMemory,
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
    persistAssistantArchived,
    attachAssistantThread,
    getContextCheckpoint,
    advanceAssistantMainSession,
    consumeContextCheckpoint,
    createContextCheckpoint,
    seedCheckpoint,
    checkpoints,
    createAssistantSession,
    getAssistantSession,
    listAssistantSessions,
    updateAssistantSession,
    markAssistantTaskStarted,
    setAssistantTaskPaused,
    drainAssistantQueue,
    captureAssistantTaskMemory,
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
    agentOn,
    fireAgent,
    tasks,
    memories,
    current: () => current,
    teamRows,
    listTeams,
    setCoordinator(value: boolean) {
      current = { ...current, coordinator: value }
    },
    setInstanceStatus(status: AssistantInstance['status']) {
      current = { ...current, status }
    },
    setInstancePaused(pausedAt: string | undefined) {
      const { pausedAt: _pausedAt, ...rest } = current
      current = pausedAt === undefined ? rest : { ...rest, pausedAt }
    },
    setLive(sessionId: string, agent?: Agent) {
      live.set(sessionId, agent ?? { id: SessionId(sessionId) } as unknown as Agent)
    },
    clearLive(sessionId: string) {
      live.delete(sessionId)
    },
    /** Record a durable Session log so queue recovery resumes instead of creating. */
    seedPersistedSession(sessionId: string) {
      persistedEvents.set(sessionId, [])
    },
  }
}

function sessionEvent(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
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

  it('creates a real Session in the workspace and attaches it as a thread', async () => {
    const h = createHarness()
    const main = await h.runtime.ensureInstance('instance-1')

    const thread = await h.runtime.createAssistantThread('instance-1')

    expect(thread.sessionId).toMatch(/^session-/)
    expect(thread.sessionId).not.toBe(main.sessionId)
    // The main Session keeps its id; the new Session only joins the thread list.
    expect(h.current().mainSessionId).toBe(main.sessionId)
    expect(h.current().threadSessionIds).toEqual([thread.sessionId])
    expect(h.bindAssistantMainSession).toHaveBeenCalledTimes(1)
    expect(h.attachAssistantThread).toHaveBeenCalledWith('instance-1', thread.sessionId)

    expect(h.createMock).toHaveBeenCalledTimes(2)
    const options = h.createMock.mock.calls[1]?.[0] as CreateAgentOptions
    expect(String(options.sessionId)).toBe(thread.sessionId)
    expect(options.meta).toEqual({ cwd: WORKSPACE_PATH, agentPreset: 'default' })
    expect(h.attachSession).toHaveBeenCalledWith(thread.sessionId)
    expect(h.flush).toHaveBeenCalledWith(h.handles[1]?.agent.session)
    // Same assistant, same identity prompt as the main Session.
    const sections = h.handles[1]?.section.mock.calls.map(
      call => call[0] as { name: string; text: () => string },
    ) ?? []
    expect(sections.find(section => section.name.includes('assistant-identity'))?.text())
      .toContain('You are Researcher')
  })

  it('registers no task or memory tools on a thread Session', async () => {
    const h = createHarness()
    await h.runtime.ensureInstance('instance-1')

    await h.runtime.createAssistantThread('instance-1')

    // A thread keeps the assistant's prompts and permission, but the team task
    // and memory tools act as the main Session, so it offers neither.
    expect(toolsRegistered(h.handles[1])).toEqual([])
    expect(toolsRegistered(h.handles[0]).sort())
      .toEqual([...TASK_TOOL_NAMES, ...MEMORY_TOOL_NAMES].sort())
    expect(h.permissionSet).toHaveBeenCalledWith(h.handles[1]?.agent.session, 'workspace-write')
  })

  it('keeps task and memory tool names out of the thread prompt only', async () => {
    const h = createHarness()
    await h.createAssistantSession({
      assistantId: 'instance-1',
      sessionId: 'session-worker',
      title: 'Compare vendors',
      brief: 'Compare the three vendors.',
      parentSessionId: 'session-main',
    })
    await h.runtime.ensureInstance('instance-1')
    await h.runtime.createAssistantThread('instance-1')

    const sectionsOf = (record: AgentRecord | undefined): Map<string, string> => new Map(
      (record?.section.mock.calls ?? []).map(call => {
        const section = call[0] as { name: string; text: () => string }
        return [section.name.replace(/:[^:]+$/, ''), section.text()]
      }),
    )
    const promptOf = (record: AgentRecord | undefined): string =>
      [...sectionsOf(record).values()].join('\n')

    const threadPrompt = promptOf(h.handles[1])
    expect(threadPrompt).not.toContain('assistant_task_')
    expect(threadPrompt).not.toContain('assistant_memory_')
    // The thread still sees the same board and knows where it belongs.
    expect(threadPrompt).toContain('Compare vendors')
    expect(threadPrompt).toContain('You are Researcher')
    expect(threadPrompt).toContain('additional conversation of the assistant')

    const mainPrompt = promptOf(h.handles[0])
    expect(mainPrompt).toContain('assistant_task_create')
    expect(mainPrompt).toContain('assistant_memory_write')
    expect(mainPrompt).toContain('Compare vendors')

    // Only the memory and task sections differ; identity matches, and a
    // non-coordinator's coordinator section is empty on both.
    const mainSections = sectionsOf(h.handles[0])
    const threadSections = sectionsOf(h.handles[1])
    for (const suffix of ['assistant-identity', 'assistant-coordinator']) {
      const main = [...mainSections].find(([name]) => name.endsWith(suffix))?.[1]
      const thread = [...threadSections].find(([name]) => name.endsWith(suffix))?.[1]
      expect(thread).toBe(main)
    }
  })

  it('keeps coordinator duties on the main Session only', async () => {
    const h = createHarness({ coordinator: true })
    h.teamRows.push(coordinatorTeam())

    await h.runtime.ensureInstance('instance-1')
    await h.runtime.createAssistantThread('instance-1')

    const coordinatorPrompt = (record: AgentRecord | undefined): string => {
      const section = (record?.section.mock.calls ?? [])
        .map(call => call[0] as { name: string; text: () => string })
        .find(candidate => candidate.name.includes('assistant-coordinator'))
      return section?.text() ?? ''
    }

    const main = coordinatorPrompt(h.handles[0])
    expect(main).toContain('Alpha [active]: Leader Alice')
    expect(main).toContain('Coordinator duties:')
    expect(main).toContain('team_send_message')

    // The thread names no team tool and repeats no duty: it cannot run either.
    const thread = coordinatorPrompt(h.handles[1])
    expect(thread).not.toContain('team_mode_')
    expect(thread).not.toContain('team_send_message')
    expect(thread).not.toContain('Coordinator duties:')
    expect(thread).not.toContain('Leader Alice')
    expect(thread).toBe(
      'You are the workspace coordinator, but coordinator duties run in your main Session. '
      + 'This is an additional conversation of the same assistant.',
    )
  })

  it('leaves the coordinator section empty on a non-coordinator thread', async () => {
    const h = createHarness()
    h.teamRows.push(coordinatorTeam())

    await h.runtime.ensureInstance('instance-1')
    await h.runtime.createAssistantThread('instance-1')

    const coordinatorSection = (h.handles[1]?.section.mock.calls ?? [])
      .map(call => call[0] as { name: string; text: () => string })
      .find(candidate => candidate.name.includes('assistant-coordinator'))
    expect(coordinatorSection?.text()).toBe('')
  })

  it('binds an explicit working directory to a thread Session', async () => {
    const h = createHarness()

    const thread = await h.runtime.createAssistantThread('instance-1', '  /tmp/other-project  ')

    const options = h.createMock.mock.calls[0]?.[0] as CreateAgentOptions
    expect(String(options.sessionId)).toBe(thread.sessionId)
    expect(options.meta).toEqual({ cwd: '/tmp/other-project', agentPreset: 'default' })
    expect(h.current().threadSessionIds).toEqual([thread.sessionId])
  })

  it('refuses to create a thread on an archived instance', async () => {
    const h = createHarness()
    await h.runtime.ensureInstance('instance-1')
    h.setInstanceStatus('archived')

    await expect(h.runtime.createAssistantThread('instance-1'))
      .rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(h.createMock).toHaveBeenCalledTimes(1)
    expect(h.attachAssistantThread).not.toHaveBeenCalled()
  })

  it('injects the coordinator roster only while the instance is the coordinator', async () => {
    const h = createHarness({ coordinator: true })
    h.teamRows.push(coordinatorTeam())
    h.teamRows.push(coordinatorTeam({ id: 'team-other', name: 'OtherWorkspace', workspaceId: 'workspace-2' }))

    await h.runtime.ensureInstance('instance-1')
    const sections = h.handles[0]?.section.mock.calls.map(
      call => call[0] as { name: string; order: number; text: () => string },
    ) ?? []
    const coordinator = sections.find(section => section.name.includes('assistant-coordinator'))

    expect(coordinator?.order).toBe(12)
    expect(coordinator?.text()).toContain('Alpha [active]: Leader Alice')
    expect(coordinator?.text()).toContain('Coordinator duties:')
    expect(coordinator?.text()).not.toContain('OtherWorkspace')

    // The flag is read live: a handover empties the section on the next turn,
    // and the system prompt drops empty sections, leaving the other prompt alone.
    h.setCoordinator(false)
    expect(coordinator?.text()).toBe('')
    expect(h.listTeams).toHaveBeenCalled()
  })

  it('keeps the coordinator section empty for a non-coordinator Session', async () => {
    const h = createHarness()
    h.teamRows.push(coordinatorTeam())

    await h.runtime.ensureInstance('instance-1')
    const sections = h.handles[0]?.section.mock.calls.map(
      call => call[0] as { name: string; text: () => string },
    ) ?? []
    const coordinator = sections.find(section => section.name.includes('assistant-coordinator'))

    expect(coordinator?.text()).toBe('')
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

  it('filters assistant memory recall by query, status, and limit without mutating it', async () => {
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
          key: 'tone',
          title: 'Tone',
          body: 'Be terse.',
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: 'mem-2',
          scope: 'assistant',
          visibility: 'private',
          status: 'archived',
          source: 'assistant',
          title: 'Retired',
          body: 'Old tab rule.',
          revision: 2,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: 'mem-3',
          scope: 'assistant',
          visibility: 'team-safe',
          status: 'active',
          source: 'assistant',
          title: 'Style',
          body: 'Use tabs in code.',
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      revision: 3,
      updatedAt: NOW,
    })
    const before = JSON.stringify(h.memories.get('instance-1'))
    await h.runtime.ensureInstance('instance-1')
    const mainAgent = { id: SessionId(h.current().mainSessionId!) } as unknown as Agent
    const read = h.handles[0]?.toolsRegister.mock.calls.find(
      call => (call[0] as { name: string }).name === 'assistant_memory_read',
    )?.[0] as unknown as {
      parameters: { properties?: Record<string, unknown> }
      execute: (args: Record<string, unknown>, exec: { agent: Agent }) => Promise<Record<string, unknown>>
    }
    expect(read.parameters.properties?.query).toBeDefined()
    expect(read.parameters.properties?.status).toBeDefined()
    expect(read.parameters.properties?.limit).toBeDefined()

    const byQuery = await read.execute({ query: 'TABS' }, { agent: mainAgent })
    expect((byQuery.memory as { entries: Array<{ entry_id: string }> }).entries
      .map(entry => entry.entry_id)).toEqual(['mem-3'])
    expect(byQuery).toMatchObject({ total: 1, truncated: false })

    const byStatus = await read.execute({ status: 'archived' }, { agent: mainAgent })
    expect((byStatus.memory as { entries: Array<{ entry_id: string }> }).entries
      .map(entry => entry.entry_id)).toEqual(['mem-2'])

    const limited = await read.execute({ limit: 1 }, { agent: mainAgent })
    expect((limited.memory as { entries: unknown[] }).entries).toHaveLength(1)
    expect(limited).toMatchObject({ total: 3, truncated: true })
    expect(JSON.stringify(h.memories.get('instance-1'))).toBe(before)
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

  it('captures completed worker memory only when memoryAutoCapture is enabled', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Memory task', brief: 'Start.' })
    const worker = h.handles[1]
    h.emit('agent/status', { agent: worker?.agent, status: 'running' })
    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('completed')
    // Default config leaves capture off.
    expect(h.captureAssistantTaskMemory).not.toHaveBeenCalled()

    const enabled = h.createRuntime({ memoryAutoCapture: true })
    const second = await enabled.createTask('instance-1', { title: 'Capture me', brief: 'Start.' })
    const secondWorker = h.handles.at(-1)
    h.emit('agent/status', { agent: secondWorker?.agent, status: 'running' })
    h.emit('agent/status', { agent: secondWorker?.agent, status: 'idle' })
    await settle()

    expect(h.getAssistantSession(second.id).status).toBe('completed')
    expect(h.captureAssistantTaskMemory).toHaveBeenCalledTimes(1)
    expect(h.captureAssistantTaskMemory).toHaveBeenCalledWith('instance-1', second.id)
  })

  it('keeps the worker completion when memory capture fails', async () => {
    const h = createHarness()
    h.captureAssistantTaskMemory.mockRejectedValueOnce(new Error('memory unavailable'))
    const enabled = h.createRuntime({ memoryAutoCapture: true })
    const task = await enabled.createTask('instance-1', { title: 'Capture fails', brief: 'Start.' })
    const worker = h.handles.at(-1)
    h.emit('agent/status', { agent: worker?.agent, status: 'running' })
    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()

    expect(h.captureAssistantTaskMemory).toHaveBeenCalledWith('instance-1', task.id)
    expect(h.getAssistantSession(task.id).status).toBe('completed')
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

  it('marks a worker needs_input while an approval is parked and running once it resolves', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Approval task', brief: 'Start.' })
    const worker = h.handles[1]
    expect(worker).toBeDefined()

    h.fireAgent('approval/request', {
      toolName: 'write_file',
      callId: 'call-1',
      reason: 'needs the workspace',
    }, async () => 'allowed-once')
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('needs_input')

    const pending = await h.runtime.taskInteractions(task.id)
    expect(pending).toMatchObject([{ kind: 'approval', toolName: 'write_file', callId: 'call-1' }])

    await h.runtime.respondTaskInteraction(task.id, pending[0]!.id, {
      kind: 'approval',
      outcome: 'allowed-once',
    })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('running')
    expect(await h.runtime.taskInteractions(task.id)).toEqual([])
  })

  it('keeps a worker needs_input while a question waits on the user', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Question task', brief: 'Start.' })
    const worker = h.handles[1]
    expect(worker).toBeDefined()

    h.fireAgent('user-questions/request', {
      questions: [{ id: 'q1', question: 'Which file?' }],
    }, async () => ({ answers: [] }))
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('needs_input')

    const pending = await h.runtime.taskInteractions(task.id)
    expect(pending).toMatchObject([{ kind: 'question' }])

    await h.runtime.respondTaskInteraction(task.id, pending[0]!.id, {
      kind: 'question',
      answers: [{ id: 'q1', selected: [], custom: 'src/a.ts' }],
    })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('running')
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

  it('cancels active tasks, releases their workers, and stops the main Session before archive', async () => {
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
    // The main Session is the person users talk to: archiving stops it too, or
    // an archived assistant keeps answering in the native sidebar.
    expect(main?.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(main?.dispose).toHaveBeenCalledTimes(1)
  })

  it('refuses to reopen an archived assistant and resumes a fresh main Session only after restore', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Active', brief: 'Start.' })
    const main = h.handles[0]
    const mainSessionId = String(main?.agent.id)

    await h.runtime.stopForArchive('instance-1')

    expect(main?.dispose).toHaveBeenCalledTimes(1)
    // Opening the archived assistant must not revive the disposed Session.
    await expect(h.runtime.ensureInstance('instance-1'))
      .rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(h.resumeMock).not.toHaveBeenCalled()

    // Restore brings back availability only. The task archive cancelled stays
    // cancelled and is not part of the to-do any more; reopening the assistant
    // resumes the persisted log as a fresh Agent.
    h.setInstanceStatus('active')
    const reopened = await h.runtime.ensureInstance('instance-1')
    expect(reopened.instance.status).toBe('active')
    expect(reopened.sessionId).toBe(mainSessionId)
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    const resumeOptions = h.resumeMock.mock.calls[0]?.[0] as ResumeAgentOptions
    expect(String(resumeOptions.resumeSessionId)).toBe(mainSessionId)
    expect(h.getAssistantSession(task.id).status).toBe('cancelled')
    expect(h.listAssistantSessions('instance-1').items
      .filter(row => row.status === 'queued' || row.status === 'running' || row.status === 'needs_input'))
      .toEqual([])
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

  it('refuses a live worker owned by another lifecycle without adopting or disposing it', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    const worker = h.handles[1]
    expect(worker).toBeDefined()
    h.setLive(task.sessionId, worker!.agent)
    const recovered = h.createRuntime()

    const error = await recovered.sendTask('instance-1', task.id, 'Keep going.').catch(value => value)

    expect(error).toBeInstanceOf(AgentTeamError)
    expect(error).toMatchObject({
      code: 'AGENT_HANDLE_OWNERSHIP_CONFLICT',
      details: { taskId: task.id, sessionId: task.sessionId },
    })
    // The foreign worker is neither driven nor resumed by this runtime.
    expect(h.resumeMock).not.toHaveBeenCalled()
    expect(worker?.followup).toHaveBeenCalledTimes(1)

    await recovered.dispose()

    expect(worker?.dispose).not.toHaveBeenCalled()
    expect(worker?.cancel).not.toHaveBeenCalled()
  })

  it('rejects send and open for an archived assistant without resuming a worker', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    const recovered = h.createRuntime()
    h.setInstanceStatus('archived')

    await expect(recovered.sendTask('instance-1', task.id, 'Continue.')).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    await expect(recovered.openTask(task.id)).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(h.resumeMock).not.toHaveBeenCalled()
  })

  it('stops a worker resumed for a completed task before archiving', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    const worker = h.handles[1]
    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('completed')

    // Opening a completed task resumes and maps its worker without changing
    // the task status, so the archive stop loop skips this task.
    await h.runtime.openTask(task.id)
    const resumed = h.handles[2]
    expect(resumed).toBeDefined()

    await h.runtime.stopForArchive('instance-1')

    // Archive releases every mapped worker, including this terminal task's.
    expect(resumed?.dispose).toHaveBeenCalledTimes(1)
    expect(h.getAssistantSession(task.id).status).not.toBe('running')

    // A later send can no longer drive the stopped worker or the archived
    // assistant.
    await expect(h.runtime.sendTask('instance-1', task.id, 'Keep going.')).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(resumed?.followup).not.toHaveBeenCalled()
  })

  it('rejects send when an archived assistant still has a mapped worker handle', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    const worker = h.handles[1]
    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    await h.runtime.openTask(task.id)
    const resumed = h.handles[2]
    expect(resumed).toBeDefined()

    // Another lifecycle archived the assistant after this runtime mapped the
    // worker; the mapped fast path must never bypass the archived gate.
    h.setInstanceStatus('archived')

    await expect(h.runtime.sendTask('instance-1', task.id, 'Keep going.')).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(resumed?.followup).not.toHaveBeenCalled()
  })

  it('shares one recovery between two rapid sends', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    const gate = deferred()
    const original = h.resumeMock.getMockImplementation()
    expect(original).toBeDefined()
    h.resumeMock.mockImplementationOnce(async (options: ResumeAgentOptions) => {
      await gate.promise
      return original!(options)
    })
    const recovered = h.createRuntime()

    const first = recovered.sendTask('instance-1', task.id, 'one')
    const second = recovered.sendTask('instance-1', task.id, 'two')
    await settle()
    gate.resolve()
    const [left, right] = await Promise.all([first, second])

    expect(left.status).toBe('running')
    expect(right.status).toBe('running')
    // Both sends share the single in-flight recovery instead of creating a
    // second handle for the same worker Session.
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    const resumed = h.handles[2]
    expect(resumed?.followup).toHaveBeenCalledTimes(2)
    expect(resumed?.dispose).not.toHaveBeenCalled()
  })

  it('fences a recovery in flight when the task is cancelled', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    const gate = deferred()
    const original = h.resumeMock.getMockImplementation()
    expect(original).toBeDefined()
    h.resumeMock.mockImplementationOnce(async (options: ResumeAgentOptions) => {
      await gate.promise
      return original!(options)
    })
    const recovered = h.createRuntime()

    const sending = recovered.sendTask('instance-1', task.id, 'Continue.')
    await settle() // recoverWorker is awaiting agents.resume
    const cancelled = await recovered.cancelTask('instance-1', task.id)
    expect(cancelled.status).toBe('cancelled')

    gate.resolve()
    await expect(sending).rejects.toMatchObject({
      code: 'ASSISTANT_TASK_NOT_ACTIVE',
      details: { taskId: task.id, reason: 'released' },
    })
    // The stale recovery disposes the handle it created and never reattaches
    // or sends to the released task.
    const resumed = h.handles[2]
    expect(resumed?.dispose).toHaveBeenCalledTimes(1)
    expect(resumed?.followup).not.toHaveBeenCalled()
    expect(h.getAssistantSession(task.id).status).toBe('cancelled')
  })

  it('disposes the stale recovery when a second send races a release', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    const gate = deferred()
    const original = h.resumeMock.getMockImplementation()
    expect(original).toBeDefined()
    h.resumeMock.mockImplementation(async (options: ResumeAgentOptions) => {
      await gate.promise
      return original!(options)
    })
    const recovered = h.createRuntime()

    const stale = recovered.sendTask('instance-1', task.id, 'one')
    await settle()
    const cancelled = await recovered.cancelTask('instance-1', task.id)
    expect(cancelled.status).toBe('cancelled')
    const fresh = recovered.sendTask('instance-1', task.id, 'two')
    await settle()

    gate.resolve()
    await expect(stale).rejects.toMatchObject({
      code: 'ASSISTANT_TASK_NOT_ACTIVE',
      details: { taskId: task.id, reason: 'released' },
    })
    await expect(fresh).resolves.toMatchObject({ status: 'running' })

    // Exactly one live worker survives: the pre-release recovery disposed its
    // own handle, and the post-release recovery owns the mapped worker.
    expect(h.handles[2]?.dispose).toHaveBeenCalledTimes(1)
    expect(h.handles[2]?.followup).not.toHaveBeenCalled()
    expect(h.handles[3]?.dispose).not.toHaveBeenCalled()
    expect(h.handles[3]?.followup).toHaveBeenCalledTimes(1)
    expect(h.getAssistantSession(task.id).status).toBe('running')
  })

  it('fences a completed-task recovery when archive starts during the resume', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', {
      title: 'Research pricing',
      brief: 'Start.',
    })
    const worker = h.handles[1]
    h.emit('agent/status', { agent: worker?.agent, status: 'idle' })
    await settle()
    expect(h.getAssistantSession(task.id).status).toBe('completed')

    const gate = deferred()
    const original = h.resumeMock.getMockImplementation()
    expect(original).toBeDefined()
    h.resumeMock.mockImplementationOnce(async (options: ResumeAgentOptions) => {
      await gate.promise
      return original!(options)
    })

    const opening = h.runtime.openTask(task.id)
    await settle() // recoverWorker is awaiting agents.resume
    const archiving = h.runtime.stopForArchive('instance-1')
    await settle() // archive fenced the in-flight recovery
    gate.resolve()

    await expect(opening).rejects.toMatchObject({
      code: 'ASSISTANT_TASK_NOT_ACTIVE',
      details: { taskId: task.id, reason: 'released' },
    })
    // The resumed handle belongs to this recovery, so archive disposes it
    // exactly once and never sends to it.
    const resumed = h.handles[2]
    expect(resumed?.dispose).toHaveBeenCalledTimes(1)
    expect(resumed?.followup).not.toHaveBeenCalled()
    await expect(archiving).resolves.toMatchObject({ status: 'archived' })

    // Once the archived row is durable, further work is rejected as archived.
    await expect(h.runtime.sendTask('instance-1', task.id, 'Continue.')).rejects
      .toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(resumed?.followup).not.toHaveBeenCalled()
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

  it('queues tasks at the worker limit and drains them FIFO on settle', async () => {
    const h = createHarness({}, { assistantWorkerConcurrency: 1 })
    const first = await h.runtime.createTask('instance-1', { title: 'First', brief: 'First brief.' })
    const second = await h.runtime.createTask('instance-1', { title: 'Second', brief: 'Second brief.' })
    const third = await h.runtime.createTask('instance-1', { title: 'Third', brief: 'Third brief.' })

    expect(first.status).toBe('running')
    expect(second.status).toBe('queued')
    expect(third.status).toBe('queued')
    // Main Session + the one running worker: queued rows allocate no Session.
    expect(h.createMock).toHaveBeenCalledTimes(2)
    expect(second.sessionId).toMatch(/^session-/)
    expect(third.sessionId).not.toBe(second.sessionId)
    expect(second.parentSessionId).toBe(h.current().mainSessionId)
    expect(h.getAssistantSession(second.id)).toMatchObject({
      status: 'queued',
      sessionId: second.sessionId,
    })

    // Settling the live worker frees exactly one slot and starts the oldest row
    // on its reserved Session id.
    h.emit('agent/status', { agent: h.handles[1]!.agent, status: 'idle' })
    await settle()

    expect(h.getAssistantSession(first.id).status).toBe('completed')
    expect(h.getAssistantSession(second.id).status).toBe('running')
    expect(h.getAssistantSession(third.id).status).toBe('queued')
    expect(h.createMock).toHaveBeenCalledTimes(3)
    const started = h.createMock.mock.calls[2]![0] as CreateAgentOptions
    expect(String(started.sessionId)).toBe(second.sessionId)
    expect(textOf(h.handles[2]?.followup.mock.calls[0]?.[0])).toBe('Second brief.')
  })

  it('drains two settles through one single-flight pass without double-starting a row', async () => {
    const h = createHarness({}, { assistantWorkerConcurrency: 2 })
    const first = await h.runtime.createTask('instance-1', { title: 'First', brief: 'A' })
    const second = await h.runtime.createTask('instance-1', { title: 'Second', brief: 'B' })
    const third = await h.runtime.createTask('instance-1', { title: 'Third', brief: 'C' })
    const fourth = await h.runtime.createTask('instance-1', { title: 'Fourth', brief: 'D' })
    expect([first.status, second.status, third.status, fourth.status])
      .toEqual(['running', 'running', 'queued', 'queued'])

    // Two independent settle signals must each admit one row, never the same one.
    h.emit('agent/status', { agent: h.handles[1]!.agent, status: 'idle' })
    h.emit('agent/status', { agent: h.handles[2]!.agent, status: 'idle' })
    await settle()

    expect(h.getAssistantSession(third.id).status).toBe('running')
    expect(h.getAssistantSession(fourth.id).status).toBe('running')
    const started = h.createMock.mock.calls
      .slice(1)
      .map(call => String((call[0] as CreateAgentOptions).sessionId))
    expect(new Set(started).size).toBe(started.length)
    expect(started).toEqual([first.sessionId, second.sessionId, third.sessionId, fourth.sessionId])
  })

  it('recovers queued tasks at startup by creating the reserved Session when absent', async () => {
    const h = createHarness()
    h.tasks.set('task-a', {
      schemaVersion: 1,
      id: 'task-a',
      assistantId: 'instance-1',
      sessionId: 'session-reserved-a',
      role: 'task',
      title: 'Queued A',
      brief: 'Do A',
      parentSessionId: 'session-main',
      status: 'queued',
      createdAt: NOW,
      updatedAt: NOW,
    })

    await h.runtime.recoverAssistantQueues()

    expect(h.resumeMock).not.toHaveBeenCalled()
    expect(h.createMock).toHaveBeenCalledTimes(1)
    const options = h.createMock.mock.calls[0]![0] as CreateAgentOptions
    expect(String(options.sessionId)).toBe('session-reserved-a')
    // Startup never opens a main Session; the stored parent id is just data.
    expect(h.bindAssistantMainSession).not.toHaveBeenCalled()
    expect(h.current().mainSessionId).toBeUndefined()
    expect(h.getAssistantSession('task-a')).toMatchObject({
      status: 'running',
      parentSessionId: 'session-main',
      sessionId: 'session-reserved-a',
    })
    expect(h.handles[0]?.followup).toHaveBeenCalledTimes(1)
  })

  it('recovers queued tasks at startup by resuming an already-flushed Session', async () => {
    const h = createHarness()
    h.seedPersistedSession('session-reserved-b')
    h.tasks.set('task-b', {
      schemaVersion: 1,
      id: 'task-b',
      assistantId: 'instance-1',
      sessionId: 'session-reserved-b',
      role: 'task',
      title: 'Queued B',
      brief: 'Do B',
      parentSessionId: 'session-main',
      status: 'queued',
      createdAt: NOW,
      updatedAt: NOW,
    })

    await h.runtime.recoverAssistantQueues()

    expect(h.createMock).not.toHaveBeenCalled()
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    const options = h.resumeMock.mock.calls[0]![0] as ResumeAgentOptions
    expect(String(options.resumeSessionId)).toBe('session-reserved-b')
    expect(h.getAssistantSession('task-b')).toMatchObject({ status: 'running' })
  })

  it('admits startup queued tasks in createdAt/id order', async () => {
    const h = createHarness({}, { assistantWorkerConcurrency: 1 })
    for (const id of ['task-c', 'task-a', 'task-b']) {
      h.tasks.set(id, {
        schemaVersion: 1,
        id,
        assistantId: 'instance-1',
        sessionId: `session-reserved-${id.slice(-1)}`,
        role: 'task',
        title: id,
        brief: 'Start.',
        parentSessionId: 'session-main',
        status: 'queued',
        createdAt: NOW,
        updatedAt: NOW,
      })
    }

    await h.runtime.recoverAssistantQueues()

    // Equal timestamps: the id is the strict tiebreak, so task-a runs first.
    expect(h.getAssistantSession('task-a').status).toBe('running')
    expect(h.getAssistantSession('task-b').status).toBe('queued')
    expect(h.getAssistantSession('task-c').status).toBe('queued')
    const options = h.createMock.mock.calls[0]![0] as CreateAgentOptions
    expect(String(options.sessionId)).toBe('session-reserved-a')
  })

  it('survives a restart and recovers the queued row a dropped runtime left behind', async () => {
    const h = createHarness({}, { assistantWorkerConcurrency: 1 })
    const running = await h.runtime.createTask('instance-1', { title: 'Running', brief: 'Keep going.' })
    const queued = await h.runtime.createTask('instance-1', { title: 'Queued', brief: 'Do it next.' })
    expect(queued.status).toBe('queued')

    // A new runtime has none of the old handles; the durable rows are all it
    // reads, and only the queued row is started.
    const before = h.createMock.mock.calls.length
    const recovered = h.createRuntime()
    await recovered.recoverAssistantQueues()

    expect(h.getAssistantSession(queued.id)).toMatchObject({
      status: 'running',
      sessionId: queued.sessionId,
      parentSessionId: running.parentSessionId,
    })
    // Only the queued worker is created; no main Session is opened again.
    const created = h.createMock.mock.calls.slice(before)
    expect(created).toHaveLength(1)
    expect(String((created[0]![0] as CreateAgentOptions).sessionId)).toBe(queued.sessionId)
  })

  it('gates the queue at the assistant pause and drains it again on resume', async () => {
    const h = createHarness({}, { assistantWorkerConcurrency: 1 })
    const running = await h.runtime.createTask('instance-1', { title: 'Running', brief: 'A' })
    const queued = await h.runtime.createTask('instance-1', { title: 'Queued', brief: 'B' })
    expect(queued.status).toBe('queued')

    h.setInstancePaused(NOW)
    h.emit('agent/status', { agent: h.handles[1]!.agent, status: 'idle' })
    await settle()
    // The settle pass ran but the assistant-level pause gates admission.
    expect(h.getAssistantSession(running.id).status).toBe('completed')
    expect(h.getAssistantSession(queued.id).status).toBe('queued')
    expect(h.createMock).toHaveBeenCalledTimes(2)

    await h.runtime.drainAssistantQueue('instance-1')
    expect(h.getAssistantSession(queued.id).status).toBe('queued')

    h.setInstancePaused(undefined)
    await h.runtime.drainAssistantQueue('instance-1')
    expect(h.getAssistantSession(queued.id).status).toBe('running')
    expect(h.createMock).toHaveBeenCalledTimes(3)
  })

  it('enqueues a new task without starting it while the assistant is paused', async () => {
    const h = createHarness()
    h.setInstancePaused(NOW)

    const task = await h.runtime.createTask('instance-1', { title: 'Held', brief: 'Later.' })

    expect(task.status).toBe('queued')
    // Only the main Session opened; the paused marker gated the worker start.
    expect(h.createMock).toHaveBeenCalledTimes(1)
  })

  it('pausing an assistant marks its running task paused and releases the worker', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Running', brief: 'A' })
    const worker = h.handles[1]

    await h.runtime.pauseAssistantWorkers('instance-1')

    expect(h.getAssistantSession(task.id)).toMatchObject({
      status: 'paused',
      pausedBy: 'assistant',
    })
    expect(worker?.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(worker?.whenIdle).toHaveBeenCalledTimes(1)
    expect(worker?.dispose).toHaveBeenCalledTimes(1)
  })

  it('pauses a running task destructively and resumes a new turn on the same Session', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Interrupted', brief: 'A' })
    const worker = h.handles[1]

    await h.service.setAssistantTaskPaused(task.id, 'user')
    await h.runtime.stopTaskForPause(task.id)
    expect(worker?.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(worker?.whenIdle).toHaveBeenCalledTimes(1)
    expect(worker?.dispose).toHaveBeenCalledTimes(1)
    expect(h.getAssistantSession(task.id).status).toBe('paused')

    // The service requeues the row; the drain resumes the reserved Session and
    // sends a continue-after-pause turn instead of replaying the brief.
    await h.service.updateAssistantSession(task.id, { status: 'queued' })
    await h.runtime.drainAssistantQueue('instance-1')

    expect(h.getAssistantSession(task.id).status).toBe('running')
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    const options = h.resumeMock.mock.calls[0]![0] as ResumeAgentOptions
    expect(String(options.resumeSessionId)).toBe(task.sessionId)
    const resumed = h.handles[2]
    expect(textOf(resumed?.followup.mock.calls[0]?.[0])).toContain('was paused')
    expect(textOf(resumed?.followup.mock.calls[0]?.[0])).toContain('Interrupted')
  })

  it('pauses a queued task without starting it and resumes it with the original brief', async () => {
    const h = createHarness({}, { assistantWorkerConcurrency: 1 })
    await h.runtime.createTask('instance-1', { title: 'First', brief: 'A' })
    const queued = await h.runtime.createTask('instance-1', { title: 'Second', brief: 'Second brief.' })
    expect(h.createMock).toHaveBeenCalledTimes(2)

    await h.service.setAssistantTaskPaused(queued.id, 'user')
    expect(h.getAssistantSession(queued.id).status).toBe('paused')
    expect(h.createMock).toHaveBeenCalledTimes(2)

    await h.service.updateAssistantSession(queued.id, { status: 'queued' })
    h.emit('agent/status', { agent: h.handles[1]!.agent, status: 'idle' })
    await settle()

    expect(h.getAssistantSession(queued.id).status).toBe('running')
    expect(h.createMock).toHaveBeenCalledTimes(3)
    const started = h.createMock.mock.calls[2]![0] as CreateAgentOptions
    expect(String(started.sessionId)).toBe(queued.sessionId)
    // First delivery was never made, so resume carries the brief.
    expect(textOf(h.handles[2]?.followup.mock.calls[0]?.[0])).toBe('Second brief.')
  })

  it('refuses to open a paused task, then resume starts it once on the same Session', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Paused task', brief: 'Work.' })
    const worker = h.handles[1]
    await h.service.setAssistantTaskPaused(task.id, 'user')
    await h.runtime.stopTaskForPause(task.id)

    await expect(h.runtime.openTask(task.id)).rejects.toMatchObject({
      code: 'ASSISTANT_TASK_NOT_ACTIVE',
      details: { taskId: task.id, status: 'paused' },
    })
    // Opening a paused row never resumes a live worker behind the pause.
    expect(h.resumeMock).not.toHaveBeenCalled()
    expect(worker?.dispose).toHaveBeenCalledTimes(1)

    await h.service.updateAssistantSession(task.id, { status: 'queued' })
    await h.runtime.drainAssistantQueue('instance-1')

    expect(h.getAssistantSession(task.id).status).toBe('running')
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    const options = h.resumeMock.mock.calls[0]![0] as ResumeAgentOptions
    expect(String(options.resumeSessionId)).toBe(task.sessionId)
    // A second open reuses the mapped worker; it never resumes a duplicate.
    const opened = await h.runtime.openTask(task.id)
    expect(opened.sessionId).toBe(task.sessionId)
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    expect(h.createMock).toHaveBeenCalledTimes(2)
  })

  it('targets the clicked queued row instead of the oldest row', async () => {
    // Two durable queued rows, no live worker: the click admits its own row.
    const free = createHarness({}, { assistantWorkerConcurrency: 2 })
    const queuedRow = (id: string, sessionId: string, title: string): AssistantSession => ({
      schemaVersion: 1,
      id,
      assistantId: 'instance-1',
      sessionId,
      role: 'task',
      title,
      brief: `${title} brief.`,
      parentSessionId: 'session-main',
      status: 'queued',
      createdAt: NOW,
      updatedAt: NOW,
    })
    free.tasks.set('task-old', queuedRow('task-old', 'session-old', 'Old row'))
    free.tasks.set('task-clicked', queuedRow('task-clicked', 'session-clicked', 'Clicked row'))

    const opened = await free.runtime.openTask('task-clicked')
    expect(opened.sessionId).toBe('session-clicked')
    expect(free.getAssistantSession('task-clicked').status).toBe('running')
    expect(free.getAssistantSession('task-old').status).toBe('queued')
    expect(free.createMock).toHaveBeenCalledTimes(1)

    // A full worker set starts nothing and reports the queue instead.
    const busy = createHarness({}, { assistantWorkerConcurrency: 1 })
    await busy.runtime.createTask('instance-1', { title: 'Running', brief: 'A' })
    const waiting = await busy.runtime.createTask('instance-1', { title: 'Waiting', brief: 'B' })
    expect(waiting.status).toBe('queued')
    const calls = busy.createMock.mock.calls.length
    await expect(busy.runtime.openTask(waiting.id)).rejects.toMatchObject({
      code: 'ASSISTANT_TASK_NOT_ACTIVE',
      details: { taskId: waiting.id, status: 'queued', liveWorkers: 1 },
    })
    expect(busy.createMock).toHaveBeenCalledTimes(calls)
    expect(busy.getAssistantSession(waiting.id).status).toBe('queued')
  })

  it('releases a just-started worker when the start write finds the row paused', async () => {
    const h = createHarness()
    h.markAssistantTaskStarted.mockImplementationOnce(async (id: string) => {
      const task = h.getAssistantSession(id)
      const paused: AssistantSession = {
        ...task,
        status: 'paused',
        pausedBy: 'user',
        updatedAt: NOW,
      }
      h.tasks.set(id, paused)
      return paused
    })

    const task = await h.runtime.createTask('instance-1', { title: 'Race', brief: 'Work.' })

    expect(task.status).toBe('paused')
    expect(h.handles[1]?.followup).not.toHaveBeenCalled()
    expect(h.handles[1]?.dispose).toHaveBeenCalledTimes(1)
    expect(h.getAssistantSession(task.id).error).toBeUndefined()
  })

  it('releases its own mapped worker before restarting a requeued row', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Redo', brief: 'Work.' })
    const firstWorker = h.handles[1]
    // Force the row back to queued while its worker is still mapped.
    await h.service.updateAssistantSession(task.id, { status: 'queued' })

    await h.runtime.drainAssistantQueue('instance-1')

    expect(firstWorker?.dispose).toHaveBeenCalledTimes(1)
    expect(h.getAssistantSession(task.id).status).toBe('running')
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    expect(h.handles[2]?.followup).toHaveBeenCalledTimes(1)
  })

  it('starts one queued row once when a settle drain and a click race a slow resume', async () => {
    const h = createHarness({}, { assistantWorkerConcurrency: 1 })
    const first = await h.runtime.createTask('instance-1', { title: 'First', brief: 'A' })
    const second = await h.runtime.createTask('instance-1', { title: 'Second', brief: 'B' })
    expect(second.status).toBe('queued')
    // A persisted log makes the queued row start through agents.resume, which
    // this test parks so the click can race the in-flight drain.
    h.seedPersistedSession(second.sessionId)
    const gate = deferred()
    const originalResume = h.resumeMock.getMockImplementation()
    expect(originalResume).toBeDefined()
    h.resumeMock.mockImplementationOnce(async (options: ResumeAgentOptions) => {
      await gate.promise
      return originalResume!(options)
    })

    h.emit('agent/status', { agent: h.handles[1]!.agent, status: 'idle' })
    await settle()
    expect(h.getAssistantSession(first.id).status).toBe('completed')

    // The drain is parked inside resume; the click joins the same claim.
    const clicking = h.runtime.openTask(second.id)
    gate.resolve()
    const opened = await clicking

    expect(opened.sessionId).toBe(second.sessionId)
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
    expect(h.handles[2]?.followup).toHaveBeenCalledTimes(1)
    expect(h.getAssistantSession(second.id).status).toBe('running')
    // The loser path never fails the row or removes the winner's mapping.
    expect(h.getAssistantSession(second.id).error).toBeUndefined()
    const again = await h.runtime.openTask(second.id)
    expect(again.sessionId).toBe(second.sessionId)
    expect(h.resumeMock).toHaveBeenCalledTimes(1)
  })

  it('refuses sendTask for a paused task or a paused assistant', async () => {
    const h = createHarness()
    const task = await h.runtime.createTask('instance-1', { title: 'Held', brief: 'Work.' })
    const worker = h.handles[1]
    expect(worker?.followup).toHaveBeenCalledTimes(1)

    await h.service.setAssistantTaskPaused(task.id, 'user')
    await h.runtime.stopTaskForPause(task.id)
    await expect(h.runtime.sendTask('instance-1', task.id, 'More.'))
      .rejects.toMatchObject({
        code: 'ASSISTANT_TASK_NOT_ACTIVE',
        details: { taskId: task.id, status: 'paused' },
      })
    expect(h.resumeMock).not.toHaveBeenCalled()
    expect(worker?.followup).toHaveBeenCalledTimes(1)

    // A live row still refuses while its assistant is paused.
    await h.service.updateAssistantSession(task.id, { status: 'running' })
    h.setInstancePaused(NOW)
    await expect(h.runtime.sendTask('instance-1', task.id, 'More.'))
      .rejects.toMatchObject({
        code: 'ASSISTANT_TASK_NOT_ACTIVE',
        details: { taskId: task.id, paused: true },
      })
    expect(worker?.followup).toHaveBeenCalledTimes(1)
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

  it('hands a checkpoint into a fresh main Session and retires the old one', async () => {
    const h = createHarness()
    const first = await h.runtime.ensureInstance('instance-1')
    const checkpoint = h.seedCheckpoint({ sourceSessionId: first.sessionId })

    const result = await h.runtime.handoff(checkpoint.id)

    expect(result.sessionId).not.toBe(first.sessionId)
    expect(result.checkpoint).toMatchObject({
      id: checkpoint.id,
      status: 'consumed',
      targetSessionId: result.sessionId,
    })
    expect(h.createMock).toHaveBeenCalledTimes(2)
    const createOptions = h.createMock.mock.calls[1]?.[0] as CreateAgentOptions
    expect(String(createOptions.sessionId)).toBe(result.sessionId)
    expect(createOptions.meta).toEqual({ cwd: WORKSPACE_PATH, agentPreset: 'default' })
    expect(createOptions.agentOptions).toMatchObject({ provider: 'openai', model: 'gpt-5' })

    // Exactly one durable runtime-context message reaches the fresh Session.
    const fresh = h.handles[1]
    expect(fresh?.followup).toHaveBeenCalledTimes(1)
    const delivered = fresh?.followup.mock.calls[0]?.[0] as {
      source: unknown
      content: Array<{ type: string, text: string }>
    }
    expect(delivered.source).toEqual({ kind: 'runtime-context', form: 'instructions' })
    expect(textOf(delivered)).toContain('Handoff at noon')
    expect(textOf(delivered)).toContain('Build the handoff')
    expect(h.attachSession).toHaveBeenCalledWith(result.sessionId)
    expect(h.flush).toHaveBeenCalledWith(fresh?.agent.session)

    // The fresh Session is configured like a normal main Session.
    expect(toolsRegistered(fresh).sort())
      .toEqual([...TASK_TOOL_NAMES, ...MEMORY_TOOL_NAMES].sort())
    expect(fresh?.section).toHaveBeenCalled()

    expect(h.advanceAssistantMainSession).toHaveBeenCalledWith(
      'instance-1',
      result.sessionId,
      first.sessionId,
    )
    expect(h.current()).toMatchObject({
      mainSessionId: result.sessionId,
      retiredMainSessionIds: [first.sessionId],
    })
    expect(h.consumeContextCheckpoint).toHaveBeenCalledWith(checkpoint.id, result.sessionId)

    // The new handle is owned and the old one is disposed; the old log stays.
    expect(h.handles[0]?.dispose).toHaveBeenCalledTimes(1)
    const reused = await h.runtime.ensureInstance('instance-1')
    expect(reused.sessionId).toBe(result.sessionId)
    expect(h.createMock).toHaveBeenCalledTimes(2)
  })

  it('refuses handoff with ASSISTANT_TASKS_ACTIVE before creating an Agent', async () => {
    const h = createHarness({ mainSessionId: 'session-main' })
    h.seedCheckpoint()
    h.tasks.set('task-active', {
      schemaVersion: 1,
      id: 'task-active',
      assistantId: 'instance-1',
      sessionId: 'session-worker',
      role: 'task',
      title: 'Busy task',
      brief: 'Still running',
      parentSessionId: 'session-main',
      status: 'running',
      createdAt: NOW,
      updatedAt: NOW,
    })

    await expect(h.runtime.handoff('checkpoint-1'))
      .rejects.toMatchObject({ code: 'ASSISTANT_TASKS_ACTIVE' })

    expect(h.createMock).not.toHaveBeenCalled()
    expect(h.advanceAssistantMainSession).not.toHaveBeenCalled()
    expect(h.getContextCheckpoint('checkpoint-1').status).toBe('ready')
  })

  it('leaves the old binding, checkpoint, and handle when the fresh Session fails to start', async () => {
    const h = createHarness()
    const first = await h.runtime.ensureInstance('instance-1')
    const checkpoint = h.seedCheckpoint({ sourceSessionId: first.sessionId })
    h.createMock.mockRejectedValueOnce(new Error('agent create exploded'))

    await expect(h.runtime.handoff(checkpoint.id))
      .rejects.toMatchObject({ code: 'SESSION_CREATE_FAILED' })

    expect(h.current().mainSessionId).toBe(first.sessionId)
    expect(h.getContextCheckpoint(checkpoint.id).status).toBe('ready')
    expect(h.advanceAssistantMainSession).not.toHaveBeenCalled()
    expect(h.handles[0]?.dispose).not.toHaveBeenCalled()
    const reused = await h.runtime.ensureInstance('instance-1')
    expect(reused.sessionId).toBe(first.sessionId)
  })

  it('cannot hand off a consumed checkpoint twice', async () => {
    const h = createHarness()
    const first = await h.runtime.ensureInstance('instance-1')
    const checkpoint = h.seedCheckpoint({ sourceSessionId: first.sessionId })
    await h.runtime.handoff(checkpoint.id)

    await expect(h.runtime.handoff(checkpoint.id))
      .rejects.toMatchObject({ code: 'CHECKPOINT_NOT_READY' })

    expect(h.createMock).toHaveBeenCalledTimes(2)
    expect(h.current().mainSessionId).toBe(h.handles[1]?.agent.session.id)
  })

  it('reports unknown checkpoints and missing main Sessions distinctly', async () => {
    const missing = createHarness()
    await expect(missing.runtime.handoff('checkpoint-unknown'))
      .rejects.toMatchObject({ code: 'CHECKPOINT_NOT_FOUND' })

    const archived = createHarness()
    archived.seedCheckpoint({ status: 'archived' })
    await expect(archived.runtime.handoff('checkpoint-1'))
      .rejects.toMatchObject({ code: 'CHECKPOINT_NOT_READY' })

    const unbound = createHarness()
    unbound.seedCheckpoint()
    await expect(unbound.runtime.handoff('checkpoint-1'))
      .rejects.toMatchObject({ code: 'ASSISTANT_SESSION_NOT_READY' })
    expect(unbound.createMock).not.toHaveBeenCalled()
  })

  it('refuses to checkpoint an instance with no main Session using ASSISTANT_SESSION_NOT_READY', async () => {
    const h = createHarness()

    await expect(h.runtime.createCheckpoint('instance-1', ''))
      .rejects.toMatchObject({
        code: 'ASSISTANT_SESSION_NOT_READY',
        message: expect.stringContaining('no main Session'),
      })

    expect(h.createContextCheckpoint).not.toHaveBeenCalled()
    expect(h.checkpoints.size).toBe(0)
  })

  it('creates a ready checkpoint from the live main Session', async () => {
    const h = createHarness()
    const main = await h.runtime.ensureInstance('instance-1')
    const record = h.handles[0]
    expect(record).toBeDefined()
    h.setLive(main.sessionId, record?.agent)
    record?.events.push(
      sessionEvent(0, 'user/message', {
        id: 'user-1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Plan the handoff' }],
      }),
      sessionEvent(1, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
          content: [{ type: 'text', text: 'Ready' }],
        },
        stream: [],
      }),
    )

    const checkpoint = await h.runtime.createCheckpoint('instance-1', 'note')

    expect(checkpoint).toMatchObject({
      assistantId: 'instance-1',
      sourceSessionId: main.sessionId,
      note: 'note',
      status: 'ready',
      capturedThroughSeq: 1,
    })
    expect(checkpoint.facts.recentMessages).toEqual([
      { role: 'user', text: 'Plan the handoff' },
      { role: 'assistant', text: 'Ready' },
    ])
    expect(checkpoint.facts.activeTasks).toEqual([])
    expect(h.createContextCheckpoint).toHaveBeenCalledTimes(1)
  })

  it('refuses handoff while the current main Session is running a turn', async () => {
    const h = createHarness()
    const first = await h.runtime.ensureInstance('instance-1')
    const checkpoint = h.seedCheckpoint({ sourceSessionId: first.sessionId })
    h.setLive(first.sessionId, h.handles[0]!.agent)
    ;(h.handles[0]!.agent as unknown as { status: string }).status = 'running'

    await expect(h.runtime.handoff(checkpoint.id))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    expect(h.createMock).toHaveBeenCalledTimes(1)
    expect(h.current().mainSessionId).toBe(first.sessionId)
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
