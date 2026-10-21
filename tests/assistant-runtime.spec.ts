import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import type { AssistantInstance } from '../src/domain/types.js'
import { AssistantRuntime } from '../src/runtime/assistant-runtime.js'
import type { AgentTeamService } from '../src/service/dsh-team-mode-service.js'

vi.mock('@deepseek-ai/dsh-agent', () => ({
  installModelSelection: vi.fn(),
}))

const NOW = '2026-10-21T00:00:00.000Z'
const WORKSPACE_ID = 'workspace-1'
const WORKSPACE_PATH = '/tmp/dsh-assistant-runtime-workspace'

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
  dispose: ReturnType<typeof vi.fn>
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

  const createHandle = async (sessionId: string, setup?: AgentSetup): Promise<AgentRecord> => {
    const session = { id: SessionId(sessionId) }
    const agent = {
      id: SessionId(sessionId),
      session,
      cancel: vi.fn(),
      status: 'idle',
    } as unknown as Agent
    const section = vi.fn()
    const agentCtx = {
      systemPrompt: { section },
    } as unknown as Context
    if (setup !== undefined) await setup(agentCtx, agent)
    const dispose = vi.fn(async () => {})
    const record: AgentRecord = {
      handle: { agent, dispose },
      agent,
      agentCtx,
      section,
      dispose,
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
  const service = {
    getAssistantInstance,
    bindAssistantMainSession,
  } as unknown as AgentTeamService

  return {
    runtime: new AssistantRuntime(ctx, config, service),
    ctx,
    service,
    getAssistantInstance,
    bindAssistantMainSession,
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
    current: () => current,
    setLive(sessionId: string) {
      live.set(sessionId, { id: SessionId(sessionId) } as unknown as Agent)
    },
  }
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
