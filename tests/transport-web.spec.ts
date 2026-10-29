import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import { TEAM_ANNOUNCEMENT_MAX_CHARS, ASSISTANT_CREATE_DRAFT_MAX_SENTENCE_CHARS } from '../src/domain/schemas.js'
import type { Escalation } from '../src/domain/types.js'
import type { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import {
  AGENT_TEAM_API_PATH,
  AGENT_TEAM_EVENTS_PATH,
  AGENT_TEAM_FILE_NAME_HEADER,
  AGENT_TEAM_REQUEST_ID_HEADER,
  AGENT_TEAM_UPLOAD_PATH,
} from '../src/transport/contracts.js'
import { registerWebTransport } from '../src/transport/web.js'

interface FakeResponse extends ServerResponse {
  status: number
  body: string
  headers: Record<string, string>
}

function response(): FakeResponse {
  const value = {
    status: 0,
    body: '',
    headers: {},
    writeHead(status: number, headers: Record<string, string>) {
      value.status = status
      value.headers = headers
      return value
    },
    write(chunk: unknown) {
      value.body += String(chunk)
      return true
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) value.body += String(chunk)
      return value
    },
    once() {
      return value
    },
    on() {
      return value
    },
  }
  return value as unknown as FakeResponse
}

function request(input: {
  method?: string
  url?: string
  headers?: Record<string, string | string[]>
  body?: string
}): IncomingMessage {
  const stream = Readable.from(input.body === undefined ? [] : [Buffer.from(input.body)])
  return Object.assign(stream, {
    method: input.method ?? 'POST',
    url: input.url ?? AGENT_TEAM_API_PATH,
    headers: input.headers ?? {},
  }) as unknown as IncomingMessage
}

function harness(overrides: {
  rejection?: (request: IncomingMessage) => 401 | 403 | undefined
  upload?: (teamId: string, name: string, data: Uint8Array) => Promise<unknown>
} = {}) {
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => unknown>()
  const ctx = {
    webServer: {
      register(route: { path: string, handler: (request: IncomingMessage, response: ServerResponse) => unknown }) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    connection: {
      requestRejection: overrides.rejection ?? (() => undefined),
    },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  } as unknown as Context
  let changeListener: ((change: Parameters<Parameters<AgentTeamService['subscribe']>[0]>[0]) => void) | undefined
  const service = {
    subscribe: (listener: (change: Parameters<Parameters<AgentTeamService['subscribe']>[0]>[0]) => void) => {
      changeListener = listener
      return () => { changeListener = undefined }
    },
    uploadWorkspaceFile: vi.fn(overrides.upload ?? (async (teamId: string, name: string, data: Uint8Array) => ({
      name,
      path: `.dsh-team-mode/uploads/${name}`,
      bytes: data.byteLength,
    }))),
    listTeams: vi.fn(() => ({ items: [], total: 0 })),
    refreshEscalations: vi.fn(async () => {}),
    listEscalations: vi.fn(() => []),
    listAssistantInstances: vi.fn(() => ({ items: [], total: 0 })),
    listAssistantInstanceViews: vi.fn(async () => ({ items: [], total: 0 })),
    createAssistantInstance: vi.fn(async (input: object) => ({ id: 'instance-1', ...input })),
    updateAssistantInstance: vi.fn(async (id: string, value: object) => ({ id, ...value })),
    archiveAssistantInstance: vi.fn(async (id: string) => ({ id, status: 'archived' })),
    restoreAssistantInstance: vi.fn(async (id: string) => ({ id, status: 'active' })),
    pauseAssistantInstance: vi.fn(async (id: string) => ({ id, pausedAt: '2026-01-01T00:00:00.000Z' })),
    resumeAssistantInstance: vi.fn(async (id: string) => ({ id })),
    listAssistantSessions: vi.fn((assistantId?: string) => ({
      items: [{ id: 'task-1', assistantId: assistantId ?? 'instance-1', status: 'queued' }],
      total: 1,
    })),
    pauseAssistantTask: vi.fn(async (taskId: string) => ({ id: taskId, status: 'paused' })),
    resumeAssistantTask: vi.fn(async (taskId: string) => ({ id: taskId, status: 'queued' })),
    archiveAssistantTask: vi.fn(async (taskId: string) => ({
      id: taskId,
      status: 'completed',
      archivedAt: '2026-01-01T00:00:00.000Z',
    })),
    restoreAssistantTask: vi.fn(async (taskId: string) => ({ id: taskId, status: 'completed' })),
    ensureAssistantInstance: vi.fn(async (id: string) => ({
      instance: { id, status: 'active' },
      sessionId: 'session-main',
    })),
    createAssistantThread: vi.fn(async (id: string) => ({
      instance: { id, status: 'active', threadSessionIds: ['session-thread'] },
      sessionId: 'session-thread',
    })),
    archiveAssistantThread: vi.fn(async (id: string, sessionId: string) => ({ id, sessionId })),
    restoreAssistantThread: vi.fn(async (id: string, sessionId: string) => ({ id, sessionId })),
    writeAssistantMemoryEntry: vi.fn(async (
      assistantId: string,
      entry: Record<string, unknown>,
    ) => ({
      memory: { assistantId, revision: 2 },
      entry: { id: 'mem-1', ...entry },
    })),
    askAssistantMemory: vi.fn(async (_assistantId: string, memoryText: string) =>
      memoryText === 'remember'
        ? { kind: 'change', entries: [{ id: 'mem-1', status: 'proposed' }] }
        : { kind: 'answer', answer: memoryText }),
    draftAssistantFromSentence: vi.fn(async (input: {
      sentence: string
      provider: string
      model: string
    }) => ({
      name: 'Code reviewer',
      title: 'Reviewer',
      blurb: `Drafts for ${input.provider}/${input.model}`,
      instructions: 'Review changes carefully.',
      presetId: 'reviewer',
      warnings: [],
    })),
    setAssistantMemoryAutoCapture: vi.fn(async (assistantId: string, enabled: boolean) => ({
      id: assistantId,
      memoryAutoCapture: enabled,
    })),
    getAssistantMemory: vi.fn(() => ({ assistantId: 'instance-1', revision: 2 })),
    getAssistantMemoryAutoCapture: vi.fn(() => true),
    openAssistantTask: vi.fn(async (taskId: string) => ({
      task: { id: taskId, status: 'completed' },
      sessionId: 'session-worker',
    })),
    setTeamGroup: vi.fn(async (teamId: string, group: string | null) => ({ id: teamId, group })),
    setTeamAnnouncement: vi.fn(async (teamId: string, announcement: string) => ({
      id: teamId,
      announcement,
    })),
    listGroups: vi.fn(() => ['工作']),
    createGroup: vi.fn(async (name: string) => ['工作', name]),
    renameGroup: vi.fn(async (_from: string, to: string) => [to]),
    deleteGroup: vi.fn(async () => ['工作']),
    setGroupOrder: vi.fn(async (names: readonly string[]) => [...names]),
    listGroupBriefs: vi.fn(() => [
      { name: '工作', brief: 'Working brief.', memoryKey: 'key-work', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]),
    setGroupBrief: vi.fn(async (name: string, brief: string) => ({
      name,
      brief,
      memoryKey: 'key-work',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    exportGroup: vi.fn((name: string) => ({
      kind: 'dsh-team-mode/group-export',
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      group: { name, brief: 'Working brief.' },
      assistants: [{ profile: { name: 'Reviewer' } }],
      teams: [],
    })),
    previewGroupImport: vi.fn(async (document: unknown, workspaceId: string) => ({
      schemaVersion: 1,
      group: { requested: '工作', plannedName: '工作 (2)', renamed: true, briefChars: 12 },
      assistants: [],
      templates: [],
      teams: [],
      skills: [],
      mcpServers: [],
      warnings: [],
      counts: { assistants: 0, templates: 0, teams: 0, members: 0, skipped: 0 },
      planHash: 'hash-1',
      document,
      workspaceId,
    })),
    importGroup: vi.fn(async (document: unknown, workspaceId: string, expectedPlanHash: string) => ({
      schemaVersion: 1,
      groupName: '工作 (2)',
      rows: [],
      warnings: [],
      counts: { created: 1, reused: 0, skipped: 0, rejected: 0 },
      document,
      workspaceId,
      expectedPlanHash,
    })),
    createThread: vi.fn(async (teamId: string) => ({ id: teamId, revision: 2 })),
    createTeamThread: vi.fn(async (teamId: string) => ({ id: teamId, revision: 2 })),
    renameThread: vi.fn(async (teamId: string, threadId: string, title: string) => ({
      id: teamId,
      threads: { [threadId]: { id: threadId, title } },
    })),
    archiveThread: vi.fn(async (teamId: string, threadId: string) => ({
      id: teamId,
      archivedThreadId: threadId,
    })),
  } as unknown as AgentTeamService
  const transport = registerWebTransport(
    ctx,
    { maxRequestBytes: 1024, sseHeartbeatMs: 60_000 } as Config,
    service,
  )
  return {
    transport,
    service,
    publish(change: Parameters<Parameters<AgentTeamService['subscribe']>[0]>[0]) {
      changeListener?.(change)
    },
    async call(path: string, incoming: IncomingMessage): Promise<FakeResponse> {
      const handler = routes.get(path)
      if (handler === undefined) throw new Error(`route not registered: ${path}`)
      const outgoing = response()
      await handler(incoming, outgoing)
      return outgoing
    },
  }
}

const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
  'x-test-auth': 'ok',
  ...extra,
})

describe('web transport authentication and upload contract', () => {
  it('rejects an unauthenticated API request with 401 before dispatch', async () => {
    const { call, service } = harness({ rejection: () => 401 })
    const reply = await call(AGENT_TEAM_API_PATH, request({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r1', method: 'team.list', payload: {} }),
    }))

    expect(reply.status).toBe(401)
    expect(JSON.parse(reply.body)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    expect(service.listTeams).not.toHaveBeenCalled()
  })

  it('rejects an untrusted origin with 403', async () => {
    const { call } = harness({ rejection: () => 403 })
    const reply = await call(AGENT_TEAM_API_PATH, request({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r1', method: 'team.list', payload: {} }),
    }))

    expect(reply.status).toBe(403)
    expect(JSON.parse(reply.body)).toMatchObject({ ok: false, error: { code: 'ORIGIN_REJECTED' } })
  })

  it('dispatches an authenticated API request', async () => {
    const { call } = harness()
    const reply = await call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: 'r1', method: 'team.list', payload: {} }),
    }))

    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toMatchObject({ ok: true, value: { items: [], total: 0 } })
  })

  it('refreshes live gates before returning escalation rows', async () => {
    const { call, service } = harness()
    const row: Escalation = {
      schemaVersion: 1,
      id: 'team-1:member-1:approval:gate-1',
      teamId: 'team-1',
      teamName: 'Alpha',
      memberSlotId: 'member-1',
      sessionId: 'session-1',
      kind: 'approval',
      gateId: 'gate-1',
      summary: 'Alice: write_file',
      status: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const rows: Escalation[] = []
    vi.mocked(service.refreshEscalations).mockImplementation(async () => { rows.push(row) })
    vi.mocked(service.listEscalations).mockReturnValue(rows)

    const reply = await call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: 'r1', method: 'escalation.list', payload: {} }),
    }))

    expect(service.refreshEscalations).toHaveBeenCalledTimes(1)
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toMatchObject({ ok: true, value: { items: [row], total: 1 } })
  })

  it('dispatches the Assistant instance methods', async () => {
    const { call, service } = harness()
    const post = (method: string, payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: method, method, payload }),
    }))

    const listed = await post('assistant.instance.list', {})
    expect(listed.status).toBe(200)
    expect(JSON.parse(listed.body)).toMatchObject({ ok: true, value: { items: [], total: 0 } })

    const created = await post('assistant.instance.create', {
      templateId: 'template-1',
      workspaceId: 'workspace-1',
      title: 'Code reviewer',
      blurb: 'Finds the bug before you ship it.',
    })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toMatchObject({
      ok: true,
      value: { id: 'instance-1', templateId: 'template-1', workspaceId: 'workspace-1' },
    })
    expect(service.createAssistantInstance).toHaveBeenCalledWith({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
      title: 'Code reviewer',
      blurb: 'Finds the bug before you ship it.',
    })

    const updated = await post('assistant.instance.update', {
      id: 'instance-1',
      value: { name: 'Renamed', title: 'Renamed reviewer', blurb: '', pinned: true },
    })
    expect(updated.status).toBe(200)
    expect(JSON.parse(updated.body)).toMatchObject({
      ok: true,
      value: { id: 'instance-1', name: 'Renamed', pinned: true },
    })
    expect(service.updateAssistantInstance).toHaveBeenCalledWith('instance-1', {
      name: 'Renamed',
      title: 'Renamed reviewer',
      blurb: '',
      pinned: true,
    })

    const archived = await post('assistant.instance.archive', { id: 'instance-1' })
    expect(archived.status).toBe(200)
    expect(JSON.parse(archived.body)).toMatchObject({
      ok: true,
      value: { id: 'instance-1', status: 'archived' },
    })
    expect(service.archiveAssistantInstance).toHaveBeenCalledWith('instance-1', { force: undefined })

    const ensured = await post('assistant.instance.ensure', { id: 'instance-1' })
    expect(ensured.status).toBe(200)
    expect(JSON.parse(ensured.body)).toMatchObject({
      ok: true,
      value: { instance: { id: 'instance-1', status: 'active' }, sessionId: 'session-main' },
    })
    expect(service.ensureAssistantInstance).toHaveBeenCalledWith('instance-1')
  })

  it('dispatches the Assistant thread create and archive writes', async () => {
    const { call, service } = harness()
    const post = (method: string, payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: method, method, payload }),
    }))

    const created = await post('assistant.thread.create', {
      instanceId: 'instance-1',
      cwd: '/tmp/workspace',
    })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toMatchObject({
      ok: true,
      value: { id: 'instance-1', status: 'active' },
    })
    expect(service.createAssistantThread).toHaveBeenCalledWith('instance-1', '/tmp/workspace')

    const archived = await post('assistant.thread.archive', {
      instanceId: 'instance-1',
      sessionId: 'session-a',
    })
    expect(archived.status).toBe(200)
    expect(JSON.parse(archived.body)).toMatchObject({
      ok: true,
      value: { id: 'instance-1', sessionId: 'session-a' },
    })
    expect(service.archiveAssistantThread).toHaveBeenCalledWith('instance-1', 'session-a')

    // Strict payloads: a field the contract does not carry is refused, not ignored.
    const extra = await post('assistant.thread.archive', {
      instanceId: 'instance-1',
      sessionId: 'session-a',
      force: true,
    })
    expect(extra.status).toBe(400)
    expect(JSON.parse(extra.body)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('refuses to archive the main Session as a thread', async () => {
    const { call, service } = harness()
    vi.mocked(service.archiveAssistantThread).mockRejectedValueOnce(
      new AgentTeamError('INVALID_REQUEST', 'The main Session cannot be archived as a thread'),
    )
    const reply = await call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        requestId: 'r1',
        method: 'assistant.thread.archive',
        payload: { instanceId: 'instance-1', sessionId: 'session-main' },
      }),
    }))

    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.body)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(service.archiveAssistantThread).toHaveBeenCalledWith('instance-1', 'session-main')
  })

  it('dispatches pause/resume and restore for the assistant, its threads and tasks', async () => {
    const { call, service } = harness()
    const post = (method: string, payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: method, method, payload }),
    }))

    // `includeArchived` is carried explicitly; omitting the payload keeps the
    // historical unfiltered read.
    const listed = await post('assistant.instance.list', { includeArchived: false })
    expect(listed.status).toBe(200)
    expect(service.listAssistantInstanceViews).toHaveBeenCalledWith({ includeArchived: false })
    await post('assistant.instance.list', {})
    expect(service.listAssistantInstanceViews).toHaveBeenLastCalledWith({})

    const restored = await post('assistant.instance.restore', { id: 'instance-1' })
    expect(restored.status).toBe(200)
    expect(JSON.parse(restored.body)).toMatchObject({ ok: true, value: { id: 'instance-1', status: 'active' } })
    expect(service.restoreAssistantInstance).toHaveBeenCalledWith('instance-1', { force: undefined })

    const paused = await post('assistant.instance.pause', { id: 'instance-1' })
    expect(JSON.parse(paused.body)).toMatchObject({ ok: true, value: { id: 'instance-1' } })
    expect(service.pauseAssistantInstance).toHaveBeenCalledWith('instance-1')

    const resumed = await post('assistant.instance.resume', { id: 'instance-1' })
    expect(JSON.parse(resumed.body)).toMatchObject({ ok: true, value: { id: 'instance-1' } })
    expect(service.resumeAssistantInstance).toHaveBeenCalledWith('instance-1')

    const thread = await post('assistant.thread.restore', {
      instanceId: 'instance-1',
      sessionId: 'session-a',
    })
    expect(JSON.parse(thread.body)).toMatchObject({ ok: true, value: { id: 'instance-1', sessionId: 'session-a' } })
    expect(service.restoreAssistantThread).toHaveBeenCalledWith('instance-1', 'session-a')

    const taskPaused = await post('assistant.task.pause', { taskId: 'task-1' })
    expect(JSON.parse(taskPaused.body)).toMatchObject({ ok: true, value: { id: 'task-1', status: 'paused' } })
    expect(service.pauseAssistantTask).toHaveBeenCalledWith('task-1')

    const taskResumed = await post('assistant.task.resume', { taskId: 'task-1' })
    expect(JSON.parse(taskResumed.body)).toMatchObject({ ok: true, value: { id: 'task-1', status: 'queued' } })
    expect(service.resumeAssistantTask).toHaveBeenCalledWith('task-1')

    const taskArchived = await post('assistant.task.archive', { taskId: 'task-1' })
    expect(JSON.parse(taskArchived.body)).toMatchObject({ ok: true, value: { id: 'task-1' } })
    expect(service.archiveAssistantTask).toHaveBeenCalledWith('task-1')

    const taskRestored = await post('assistant.task.restore', { taskId: 'task-1' })
    expect(JSON.parse(taskRestored.body)).toMatchObject({ ok: true, value: { id: 'task-1', status: 'completed' } })
    expect(service.restoreAssistantTask).toHaveBeenCalledWith('task-1')

    const taskList = await post('assistant.task.list', { includeArchived: false })
    expect(taskList.status).toBe(200)
    expect(service.listAssistantSessions).toHaveBeenCalledWith(undefined, { includeArchived: false })

    // Strict payloads: unknown fields are refused, never silently dropped.
    const extra = await post('assistant.task.pause', { taskId: 'task-1', force: true })
    expect(extra.status).toBe(400)
    expect(JSON.parse(extra.body)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('dispatches assistant memory entry writes with a proposed status', async () => {
    const { call, service } = harness()
    const post = (entry: Record<string, unknown>) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        requestId: 'r1',
        method: 'assistant.memory.entry.write',
        payload: { assistantId: 'instance-1', expectedRevision: 3, entry },
      }),
    }))

    const proposed = await post({ title: 'Tone', body: 'Keep answers short.', status: 'proposed' })
    expect(proposed.status).toBe(200)
    expect(JSON.parse(proposed.body)).toMatchObject({
      ok: true,
      value: { memory: { assistantId: 'instance-1', revision: 2 } },
    })
    expect(service.writeAssistantMemoryEntry).toHaveBeenLastCalledWith(
      'instance-1',
      { title: 'Tone', body: 'Keep answers short.', status: 'proposed' },
      { expectedRevision: 3, actor: 'user' },
    )

    // The statuses that already worked stay valid through the same path.
    for (const status of ['active', 'archived']) {
      const reply = await post({ title: 'Tone', body: 'Keep answers short.', status })
      expect(reply.status).toBe(200)
    }
  })

  it('dispatches assistant.memory.ask with a strict payload and the fixed union', async () => {
    const { call, service } = harness()
    const post = (payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: 'r1', method: 'assistant.memory.ask', payload }),
    }))

    const answered = await post({ assistantId: 'instance-1', text: 'How do we format tables?' })
    expect(answered.status).toBe(200)
    expect(JSON.parse(answered.body)).toMatchObject({
      ok: true,
      value: { kind: 'answer', answer: 'How do we format tables?' },
    })
    expect(service.askAssistantMemory).toHaveBeenCalledWith(
      'instance-1',
      'How do we format tables?',
    )

    const changed = await post({ assistantId: 'instance-1', text: 'remember' })
    expect(changed.status).toBe(200)
    expect(JSON.parse(changed.body)).toMatchObject({
      ok: true,
      value: { kind: 'change', entries: [{ id: 'mem-1', status: 'proposed' }] },
    })
    // The transport exposes the runtime's outcome; it never writes entries itself.
    expect(service.writeAssistantMemoryEntry).not.toHaveBeenCalled()

    const extra = await post({ assistantId: 'instance-1', text: 'x', expectedRevision: 3 })
    expect(extra.status).toBe(400)
    expect(JSON.parse(extra.body)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })

    const missing = await post({ assistantId: 'instance-1' })
    expect(missing.status).toBe(400)
    const blankId = await post({ assistantId: '  ', text: 'x' })
    expect(blankId.status).toBe(400)
  })

  it('dispatches the read-only create draft without reaching a creation path', async () => {
    const { call, service } = harness()
    const post = (payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: 'r1', method: 'assistant.create.draft', payload }),
    }))

    const drafted = await post({ sentence: '做一个代码审查员', provider: 'openai', model: 'gpt-5' })
    expect(drafted.status).toBe(200)
    expect(JSON.parse(drafted.body)).toMatchObject({
      ok: true,
      value: {
        name: 'Code reviewer',
        title: 'Reviewer',
        blurb: 'Drafts for openai/gpt-5',
        instructions: 'Review changes carefully.',
        presetId: 'reviewer',
        warnings: [],
      },
    })
    expect(service.draftAssistantFromSentence).toHaveBeenCalledWith({
      sentence: '做一个代码审查员',
      provider: 'openai',
      model: 'gpt-5',
    })
    // A draft seeds the form; the transport never creates anything itself.
    expect(service.createAssistantInstance).not.toHaveBeenCalled()

    // Strict and bounded: blank, oversized, incomplete and unknown-key
    // payloads are refused before the service is reached.
    for (const payload of [
      { sentence: '  ', provider: 'openai', model: 'gpt-5' },
      {
        sentence: 'x'.repeat(ASSISTANT_CREATE_DRAFT_MAX_SENTENCE_CHARS + 1),
        provider: 'openai',
        model: 'gpt-5',
      },
      { sentence: 'ok', provider: ' ', model: 'gpt-5' },
      { sentence: 'ok', provider: 'openai' },
      { sentence: 'ok', provider: 'openai', model: 'gpt-5', expectedRevision: 2 },
    ]) {
      const rejected = await post(payload)
      expect(rejected.status).toBe(400)
      expect(JSON.parse(rejected.body)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      })
    }
    expect(service.draftAssistantFromSentence).toHaveBeenCalledTimes(1)
  })

  it('returns the auto-capture switch beside the memory document', async () => {
    const { call, service } = harness()
    const reply = await call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        requestId: 'r1',
        method: 'assistant.memory.get',
        payload: { assistantId: 'instance-1' },
      }),
    }))

    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toMatchObject({
      ok: true,
      value: {
        memory: { assistantId: 'instance-1', revision: 2 },
        memoryAutoCapture: true,
      },
    })
    expect(service.getAssistantMemoryAutoCapture).toHaveBeenCalledWith('instance-1')
  })

  it('dispatches assistant.memory.autoCapture.set with a strict payload', async () => {
    const { call, service } = harness()
    const post = (payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        requestId: 'r1',
        method: 'assistant.memory.autoCapture.set',
        payload,
      }),
    }))

    const enabled = await post({ assistantId: 'instance-1', enabled: true })
    expect(enabled.status).toBe(200)
    expect(JSON.parse(enabled.body)).toMatchObject({
      ok: true,
      value: { id: 'instance-1', memoryAutoCapture: true },
    })
    expect(service.setAssistantMemoryAutoCapture).toHaveBeenLastCalledWith('instance-1', true)

    const disabled = await post({ assistantId: 'instance-1', enabled: false })
    expect(disabled.status).toBe(200)
    expect(JSON.parse(disabled.body)).toMatchObject({
      ok: true,
      value: { id: 'instance-1', memoryAutoCapture: false },
    })
    expect(service.setAssistantMemoryAutoCapture).toHaveBeenLastCalledWith('instance-1', false)

    // Strict: unknown keys, a non-boolean switch, and a missing switch all fail.
    for (const payload of [
      { assistantId: 'instance-1', enabled: true, expectedRevision: 2 },
      { assistantId: 'instance-1', enabled: 'yes' },
      { assistantId: 'instance-1' },
      { enabled: true },
      { assistantId: '  ', enabled: true },
    ]) {
      const rejected = await post(payload)
      expect(rejected.status).toBe(400)
      expect(JSON.parse(rejected.body)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      })
    }
    expect(service.setAssistantMemoryAutoCapture).toHaveBeenCalledTimes(2)
  })

  it('dispatches assistant.task.open', async () => {
    const { call, service } = harness()
    const reply = await call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        requestId: 'r1',
        method: 'assistant.task.open',
        payload: { taskId: 'task-1' },
      }),
    }))

    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toMatchObject({
      ok: true,
      value: {
        task: { id: 'task-1', status: 'completed' },
        sessionId: 'session-worker',
      },
    })
    expect(service.openAssistantTask).toHaveBeenCalledWith('task-1')
  })

  it('dispatches team.group.set for a named group and for null', async () => {
    const { call, service } = harness()
    const post = (payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: 'team.group.set', method: 'team.group.set', payload }),
    }))

    const moved = await post({ teamId: 'team-1', group: '工作' })
    expect(moved.status).toBe(200)
    expect(JSON.parse(moved.body)).toMatchObject({ ok: true, value: { id: 'team-1', group: '工作' } })
    expect(service.setTeamGroup).toHaveBeenCalledWith('team-1', '工作', {})

    const cleared = await post({ teamId: 'team-1', group: null })
    expect(cleared.status).toBe(200)
    expect(JSON.parse(cleared.body)).toMatchObject({ ok: true, value: { id: 'team-1', group: null } })
    expect(service.setTeamGroup).toHaveBeenCalledWith('team-1', null, {})
  })

  it('dispatches the sidebar group list and its four writes', async () => {
    const { call, service } = harness()
    const post = (method: string, payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: method, method, payload }),
    }))

    const listed = await post('sidebar.groups.list', {})
    expect(listed.status).toBe(200)
    expect(JSON.parse(listed.body)).toMatchObject({ ok: true, value: ['工作'] })
    expect(service.listGroups).toHaveBeenCalled()

    // The transport trims: the service never sees the surrounding spaces.
    const created = await post('sidebar.groups.create', { name: ' 生活 ' })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toMatchObject({ ok: true, value: ['工作', '生活'] })
    expect(service.createGroup).toHaveBeenCalledWith('生活')

    const renamed = await post('sidebar.groups.rename', { from: '工作', to: '办公' })
    expect(renamed.status).toBe(200)
    expect(JSON.parse(renamed.body)).toMatchObject({ ok: true, value: ['办公'] })
    expect(service.renameGroup).toHaveBeenCalledWith('工作', '办公')

    const deleted = await post('sidebar.groups.delete', { name: '办公' })
    expect(deleted.status).toBe(200)
    expect(JSON.parse(deleted.body)).toMatchObject({ ok: true, value: ['工作'] })
    expect(service.deleteGroup).toHaveBeenCalledWith('办公')

    const reordered = await post('sidebar.groups.reorder', { names: ['生活', '工作'] })
    expect(reordered.status).toBe(200)
    expect(JSON.parse(reordered.body)).toMatchObject({ ok: true, value: ['生活', '工作'] })
    expect(service.setGroupOrder).toHaveBeenCalledWith(['生活', '工作'])

    const blank = await post('sidebar.groups.delete', { name: '   ' })
    expect(blank.status).toBe(400)
    expect(JSON.parse(blank.body)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(service.deleteGroup).toHaveBeenCalledTimes(1)
  })

  it('reads and writes a group brief only through the user transport', async () => {
    const { call, service } = harness()
    const post = (method: string, payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: method, method, payload }),
    }))

    const listed = await post('sidebar.groups.briefs', {})
    expect(listed.status).toBe(200)
    expect(JSON.parse(listed.body)).toMatchObject({
      ok: true,
      value: [{ name: '工作', brief: 'Working brief.', memoryKey: 'key-work' }],
    })
    expect(service.listGroupBriefs).toHaveBeenCalled()

    // The transport trims the label; the brief itself is stored verbatim.
    const written = await post('sidebar.groups.brief.set', { name: ' 工作 ', brief: 'New brief.' })
    expect(written.status).toBe(200)
    expect(JSON.parse(written.body)).toMatchObject({
      ok: true,
      value: { name: '工作', brief: 'New brief.', memoryKey: 'key-work' },
    })
    expect(service.setGroupBrief).toHaveBeenCalledWith('工作', 'New brief.')

    const oversized = await post('sidebar.groups.brief.set', {
      name: '工作',
      brief: 'x'.repeat(24_577),
    })
    expect(oversized.status).toBe(400)
    expect(JSON.parse(oversized.body)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
    expect(service.setGroupBrief).toHaveBeenCalledTimes(1)
  })

  it('writes the team announcement through the user transport only', async () => {
    const { call, service } = harness()
    const post = (method: string, payload: unknown, expectedRevision?: number) => call(
      AGENT_TEAM_API_PATH,
      request({
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ requestId: method, method, payload, expectedRevision }),
      }),
    )

    const written = await post('team.announcement.set', {
      teamId: 'team-1',
      announcement: 'Freeze: ship fixes only.',
    })
    expect(written.status).toBe(200)
    expect(JSON.parse(written.body)).toMatchObject({
      ok: true,
      value: { id: 'team-1', announcement: 'Freeze: ship fixes only.' },
    })
    expect(service.setTeamAnnouncement).toHaveBeenCalledWith('team-1', 'Freeze: ship fixes only.')

    const cleared = await post('team.announcement.set', { teamId: 'team-1', announcement: '' })
    expect(cleared.status).toBe(200)
    expect(service.setTeamAnnouncement).toHaveBeenLastCalledWith('team-1', '')

    // The service's own revision fence stays unused: the user-transport
    // boundary is what protects this write, matching the group brief.
    const fenced = await post('team.announcement.set', {
      teamId: 'team-1',
      announcement: 'Ignored fence.',
    }, 99)
    expect(fenced.status).toBe(200)
    expect(service.setTeamAnnouncement).toHaveBeenLastCalledWith('team-1', 'Ignored fence.')

    const oversized = await post('team.announcement.set', {
      teamId: 'team-1',
      announcement: 'x'.repeat(TEAM_ANNOUNCEMENT_MAX_CHARS + 1),
    })
    expect(oversized.status).toBe(400)
    expect(JSON.parse(oversized.body)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
    expect(service.setTeamAnnouncement).toHaveBeenCalledTimes(3)

    const extra = await post('team.announcement.set', {
      teamId: 'team-1',
      announcement: 'Extra field.',
      pinned: true,
    })
    expect(extra.status).toBe(400)
    expect(service.setTeamAnnouncement).toHaveBeenCalledTimes(3)
  })

  it('dispatches the portable group export, preview and apply with strict payloads', async () => {
    const { call, service } = harness()
    const post = (method: string, payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: method, method, payload }),
    }))

    const exported = await post('sidebar.groups.export', { name: ' 工作 ' })
    expect(exported.status).toBe(200)
    expect(JSON.parse(exported.body)).toMatchObject({
      ok: true,
      value: { kind: 'dsh-team-mode/group-export', schemaVersion: 1, group: { name: '工作' } },
    })
    expect(service.exportGroup).toHaveBeenCalledWith('工作')

    const document = { kind: 'dsh-team-mode/group-export', schemaVersion: 1 }
    const previewed = await post('sidebar.groups.import.preview', {
      document,
      workspaceId: 'workspace-1',
    })
    expect(previewed.status).toBe(200)
    expect(JSON.parse(previewed.body)).toMatchObject({
      ok: true,
      value: { schemaVersion: 1, planHash: 'hash-1', group: { plannedName: '工作 (2)' } },
    })
    expect(service.previewGroupImport).toHaveBeenCalledWith(document, 'workspace-1')

    const applied = await post('sidebar.groups.import', {
      document,
      workspaceId: 'workspace-1',
      expectedPlanHash: 'hash-1',
    })
    expect(applied.status).toBe(200)
    expect(JSON.parse(applied.body)).toMatchObject({ ok: true, value: { groupName: '工作 (2)' } })
    expect(service.importGroup).toHaveBeenCalledWith(document, 'workspace-1', 'hash-1')

    // The fence is required, and an unknown field is refused rather than ignored.
    const unfenced = await post('sidebar.groups.import', { document, workspaceId: 'workspace-1' })
    expect(unfenced.status).toBe(400)
    expect(JSON.parse(unfenced.body)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
    const extra = await post('sidebar.groups.import.preview', {
      document,
      workspaceId: 'workspace-1',
      overwrite: true,
    })
    expect(extra.status).toBe(400)
    expect(service.previewGroupImport).toHaveBeenCalledTimes(1)
  })

  it('reads the import body against the portable ceiling but keeps other methods capped', async () => {
    const { call, service } = harness()
    const post = (method: string, payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: method, method, payload }),
    }))

    // `maxRequestBytes` is 1024 in this harness. A normal method stays capped...
    const large = await post('sidebar.groups.create', { name: 'x'.repeat(4000) })
    expect(large.status).toBe(400)
    expect(JSON.parse(large.body)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'Request body exceeds 1024 bytes' },
    })
    expect(service.createGroup).not.toHaveBeenCalled()

    // ...while an import document of the same size is read and dispatched.
    const document = { kind: 'dsh-team-mode/group-export', schemaVersion: 1, padding: 'x'.repeat(4000) }
    const previewed = await post('sidebar.groups.import.preview', {
      document,
      workspaceId: 'workspace-1',
    })
    expect(previewed.status).toBe(200)
    expect(service.previewGroupImport).toHaveBeenCalledWith(document, 'workspace-1')
  })

  it('dispatches the three team thread writes with strict payloads', async () => {
    const { call, service } = harness()
    const post = (method: string, payload: unknown) => call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: method, method, payload }),
    }))

    const created = await post('team.thread.create', { id: 'team-1' })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toMatchObject({ ok: true, value: { id: 'team-1', revision: 2 } })
    expect(service.createTeamThread).toHaveBeenCalledWith('team-1', {})
    // The raw record write never creates the Session the row would name.
    expect(service.createThread).not.toHaveBeenCalled()

    const renamed = await post('team.thread.rename', {
      id: 'team-1',
      threadId: 'thread-1',
      title: '新对话',
    })
    expect(renamed.status).toBe(200)
    expect(JSON.parse(renamed.body)).toMatchObject({
      ok: true,
      value: { id: 'team-1', threads: { 'thread-1': { title: '新对话' } } },
    })
    expect(service.renameThread).toHaveBeenCalledWith('team-1', 'thread-1', '新对话', {})

    const archived = await post('team.thread.archive', { id: 'team-1', threadId: 'thread-1' })
    expect(archived.status).toBe(200)
    expect(JSON.parse(archived.body)).toMatchObject({
      ok: true,
      value: { id: 'team-1', archivedThreadId: 'thread-1' },
    })
    expect(service.archiveThread).toHaveBeenCalledWith('team-1', 'thread-1', {})

    // Strict payloads: fields the contract does not carry are refused, not ignored.
    for (const method of ['team.thread.create', 'team.thread.rename', 'team.thread.archive']) {
      const payload = method === 'team.thread.create'
        ? { id: 'team-1', extra: true }
        : { id: 'team-1', threadId: 'thread-1', title: 'x', extra: true }
      const rejected = await post(method, payload)
      expect(rejected.status).toBe(400)
      expect(JSON.parse(rejected.body)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      })
    }
    expect(service.createThread).not.toHaveBeenCalled()
    expect(service.createTeamThread).toHaveBeenCalledTimes(1)
    expect(service.renameThread).toHaveBeenCalledTimes(1)
    expect(service.archiveThread).toHaveBeenCalledTimes(1)

    // A blank title is refused before the service sees it.
    const blank = await post('team.thread.rename', { id: 'team-1', threadId: 'thread-1', title: '  ' })
    expect(blank.status).toBe(400)
    expect(JSON.parse(blank.body)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(service.renameThread).toHaveBeenCalledTimes(1)
  })

  it('returns a typed error for an unknown method', async () => {
    const { call } = harness()
    const reply = await call(AGENT_TEAM_API_PATH, request({
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requestId: 'r1', method: 'team.nope', payload: {} }),
    }))

    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.body)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('accepts the client upload header contract end to end', async () => {
    const upload = vi.fn(async (_teamId: string, name: string, data: Uint8Array) => ({
      name,
      path: `.dsh-team-mode/uploads/${name}`,
      bytes: data.byteLength,
    }))
    const { call } = harness({ upload })
    const reply = await call(AGENT_TEAM_UPLOAD_PATH, request({
      url: `${AGENT_TEAM_UPLOAD_PATH}?teamId=team-1`,
      headers: authed({
        'content-type': 'application/octet-stream',
        [AGENT_TEAM_FILE_NAME_HEADER]: encodeURIComponent('会议 notes.txt'),
        [AGENT_TEAM_REQUEST_ID_HEADER]: 'upload-1',
      }),
      body: 'hello',
    }))

    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toMatchObject({ ok: true, value: { bytes: 5 } })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]?.[0]).toBe('team-1')
    expect(upload.mock.calls[0]?.[1]).toBe('会议 notes.txt')
    expect(Buffer.from(upload.mock.calls[0]?.[2] ?? []).toString()).toBe('hello')
  })

  it('rejects an upload that omits the file-name header', async () => {
    const upload = vi.fn()
    const { call } = harness({ upload })
    const reply = await call(AGENT_TEAM_UPLOAD_PATH, request({
      url: `${AGENT_TEAM_UPLOAD_PATH}?teamId=team-1`,
      headers: authed({ 'content-type': 'application/octet-stream' }),
      body: 'hello',
    }))

    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.body)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(upload).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated event stream', async () => {
    const { call } = harness({ rejection: () => 401 })
    const reply = await call(AGENT_TEAM_EVENTS_PATH, request({ method: 'GET', url: AGENT_TEAM_EVENTS_PATH }))

    expect(reply.status).toBe(401)
    expect(reply.headers['Content-Type']).toContain('application/json')
  })

  it('opens an authenticated event stream', async () => {
    const { call, transport } = harness()
    const reply = await call(AGENT_TEAM_EVENTS_PATH, request({
      method: 'GET',
      url: AGENT_TEAM_EVENTS_PATH,
      headers: authed(),
    }))

    expect(reply.status).toBe(200)
    expect(reply.headers['Content-Type']).toContain('text/event-stream')
    expect(reply.body).toContain('retry:')
    transport.dispose()
  })
})


describe('web transport response framing', () => {
  it('does not pin a manual Content-Length that the server compression layer would contradict', async () => {
    const { call } = harness()
    const reply = await call(AGENT_TEAM_API_PATH, request({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r1', method: 'team.list', payload: {} }),
    }))
    expect(reply.status).toBe(200)
    expect(reply.headers['Content-Length']).toBeUndefined()
    expect(reply.body).toContain('"ok":true')
  })
})

describe('web transport SSE replay', () => {
  it('replays a frame missed before Last-Event-ID', async () => {
    const { call, publish } = harness()
    const first = await call(AGENT_TEAM_EVENTS_PATH, request({
      method: 'GET',
      url: AGENT_TEAM_EVENTS_PATH,
      headers: authed(),
    }))
    expect(first.status).toBe(200)
    publish({
      cursor: 1,
      entityType: 'team',
      entityId: 'team-1',
      revision: 2,
      kind: 'team.started',
    })
    expect(first.body).toContain('id: 1')

    const second = await call(AGENT_TEAM_EVENTS_PATH, request({
      method: 'GET',
      url: AGENT_TEAM_EVENTS_PATH,
      headers: authed({ 'last-event-id': '0' }),
    }))
    expect(second.body).toContain('id: 1')
    expect(second.body).toContain('event: change')
  })

  it('asks for a resync when the cursor fell out of the retained window', async () => {
    const { call, publish } = harness()
    await call(AGENT_TEAM_EVENTS_PATH, request({
      method: 'GET',
      url: AGENT_TEAM_EVENTS_PATH,
      headers: authed(),
    }))
    for (let cursor = 1; cursor <= 300; cursor += 1) {
      publish({
        cursor,
        entityType: 'team',
        entityId: 'team-1',
        revision: cursor,
        kind: 'team.started',
      })
    }
    const reply = await call(AGENT_TEAM_EVENTS_PATH, request({
      method: 'GET',
      url: `${AGENT_TEAM_EVENTS_PATH}?cursor=0`,
      headers: authed(),
    }))
    expect(reply.body).toContain('event: resync')
  })
})
