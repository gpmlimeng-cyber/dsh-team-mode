import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
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
    listAssistantInstances: vi.fn(() => ({ items: [], total: 0 })),
    createAssistantInstance: vi.fn(async (input: object) => ({ id: 'instance-1', ...input })),
    updateAssistantInstance: vi.fn(async (id: string, value: object) => ({ id, ...value })),
    archiveAssistantInstance: vi.fn(async (id: string) => ({ id, status: 'archived' })),
    ensureAssistantInstance: vi.fn(async (id: string) => ({
      instance: { id, status: 'active' },
      sessionId: 'session-main',
    })),
    openAssistantTask: vi.fn(async (taskId: string) => ({
      task: { id: taskId, status: 'completed' },
      sessionId: 'session-worker',
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
    })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toMatchObject({
      ok: true,
      value: { id: 'instance-1', templateId: 'template-1', workspaceId: 'workspace-1' },
    })
    expect(service.createAssistantInstance).toHaveBeenCalledWith({
      templateId: 'template-1',
      workspaceId: 'workspace-1',
    })

    const updated = await post('assistant.instance.update', {
      id: 'instance-1',
      value: { name: 'Renamed', pinned: true },
    })
    expect(updated.status).toBe(200)
    expect(JSON.parse(updated.body)).toMatchObject({
      ok: true,
      value: { id: 'instance-1', name: 'Renamed', pinned: true },
    })
    expect(service.updateAssistantInstance).toHaveBeenCalledWith('instance-1', {
      name: 'Renamed',
      pinned: true,
    })

    const archived = await post('assistant.instance.archive', { id: 'instance-1' })
    expect(archived.status).toBe(200)
    expect(JSON.parse(archived.body)).toMatchObject({
      ok: true,
      value: { id: 'instance-1', status: 'archived' },
    })
    expect(service.archiveAssistantInstance).toHaveBeenCalledWith('instance-1')

    const ensured = await post('assistant.instance.ensure', { id: 'instance-1' })
    expect(ensured.status).toBe(200)
    expect(JSON.parse(ensured.body)).toMatchObject({
      ok: true,
      value: { instance: { id: 'instance-1', status: 'active' }, sessionId: 'session-main' },
    })
    expect(service.ensureAssistantInstance).toHaveBeenCalledWith('instance-1')
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
