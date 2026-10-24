import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import type {
  AssistantInstance,
  AssistantMemory,
  AssistantSession,
  CreateAssistantInstanceInput,
  MemoryEntry,
  TeamGoal,
  UpdateAssistantInstanceInput,
  UpdateTeamGoalInput,
  WriteAssistantMemoryEntryInput,
} from '../src/domain/types.js'
import type {
  AssistantInstanceView,
  AssistantMemoryEntryWriteView,
  AssistantMemoryView,
  TeamMemoryWriteInput,
  TeamMemoryWriteView,
  TeamView,
} from '../src/transport/contracts.js'
import {
  AGENT_TEAM_API_PATH,
  AGENT_TEAM_METHODS,
  type AgentTeamPayload,
  type AgentTeamResult,
  type PageView,
  type WorkspaceEntryView,
  type WorkspaceGitDiffView,
} from '../src/transport/contracts.js'
import { registerWebTransport } from '../src/transport/web.js'
import type { AgentTeamService } from '../src/service/dsh-team-mode-service.js'

describe('Agent Team transport contracts', () => {
  it('keeps API method names unique', () => {
    expect(new Set(AGENT_TEAM_METHODS).size).toBe(AGENT_TEAM_METHODS.length)
  })

  it('associates Workspace methods with their payload and result types', () => {
    expectTypeOf<AgentTeamPayload<'team.workspace.diff'>>().toEqualTypeOf<{
      teamId: string
      path: string
      scope: 'staged' | 'unstaged'
      layout: 'unified' | 'split'
      theme: 'light' | 'dark'
    }>()
    expectTypeOf<AgentTeamResult<'team.workspace.diff'>>().toEqualTypeOf<WorkspaceGitDiffView>()
    expectTypeOf<AgentTeamResult<'team.workspace.list'>>().toEqualTypeOf<WorkspaceEntryView[]>()
  })

  it('associates Assistant instance methods with their payload and result types', () => {
    expectTypeOf<AgentTeamPayload<'assistant.instance.list'>>().toEqualTypeOf<undefined>()
    expectTypeOf<AgentTeamResult<'assistant.instance.list'>>().toEqualTypeOf<PageView<AssistantInstanceView>>()
    expectTypeOf<AgentTeamPayload<'assistant.instance.create'>>()
      .toEqualTypeOf<CreateAssistantInstanceInput>()
    expectTypeOf<AgentTeamResult<'assistant.instance.create'>>().toEqualTypeOf<AssistantInstance>()
    expectTypeOf<AgentTeamPayload<'assistant.instance.update'>>().toEqualTypeOf<{
      id: string
      value: UpdateAssistantInstanceInput
    }>()
    expectTypeOf<AgentTeamResult<'assistant.instance.update'>>().toEqualTypeOf<AssistantInstance>()
    expectTypeOf<AgentTeamPayload<'assistant.instance.archive'>>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<AgentTeamResult<'assistant.instance.archive'>>().toEqualTypeOf<AssistantInstance>()
    expectTypeOf<AgentTeamPayload<'assistant.instance.ensure'>>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<AgentTeamResult<'assistant.instance.ensure'>>().toEqualTypeOf<{
      instance: AssistantInstance
      sessionId: string
    }>()
    expectTypeOf<AgentTeamPayload<'assistant.task.open'>>().toEqualTypeOf<{ taskId: string }>()
    expectTypeOf<AgentTeamResult<'assistant.task.open'>>().toEqualTypeOf<{
      task: AssistantSession
      sessionId: string
    }>()
  })

  it('maps the explicit member assistant-instance update method', () => {
    expect(AGENT_TEAM_METHODS).toContain('team.member.setAssistantInstance')
    expectTypeOf<AgentTeamPayload<'team.member.setAssistantInstance'>>().toEqualTypeOf<{
      teamId: string
      slotId: string
      assistantInstanceId: string | null
    }>()
    expectTypeOf<AgentTeamResult<'team.member.setAssistantInstance'>>().toEqualTypeOf<TeamView>()
  })

  it('associates assistant memory methods with their payload and result types', () => {
    expect(AGENT_TEAM_METHODS).toContain('assistant.memory.get')
    expect(AGENT_TEAM_METHODS).toContain('assistant.memory.write')
    expect(AGENT_TEAM_METHODS).toContain('assistant.memory.entry.write')
    expectTypeOf<AgentTeamPayload<'assistant.memory.get'>>().toEqualTypeOf<{ assistantId: string }>()
    expectTypeOf<AgentTeamResult<'assistant.memory.get'>>().toEqualTypeOf<AssistantMemoryView>()
    expectTypeOf<AgentTeamPayload<'assistant.memory.write'>>().toEqualTypeOf<{
      assistantId: string
      content: string
      mode?: 'replace' | 'append'
      expectedRevision?: number
    }>()
    expectTypeOf<AgentTeamResult<'assistant.memory.write'>>().toEqualTypeOf<AssistantMemory>()
    expectTypeOf<AgentTeamPayload<'assistant.memory.entry.write'>>().toEqualTypeOf<{
      assistantId: string
      expectedRevision?: number
      entry: WriteAssistantMemoryEntryInput
    }>()
    expectTypeOf<AgentTeamResult<'assistant.memory.entry.write'>>()
      .toEqualTypeOf<AssistantMemoryEntryWriteView>()
    expectTypeOf<AssistantMemoryEntryWriteView['entry']>().toEqualTypeOf<MemoryEntry>()
    // Undo returns the same write-shaped envelope; the panel unwraps `.memory`.
    expect(AGENT_TEAM_METHODS).toContain('assistant.memory.undo')
    expectTypeOf<AgentTeamResult<'assistant.memory.undo'>>()
      .toEqualTypeOf<AssistantMemoryEntryWriteView>()
  })

  it('associates user-authority team memory methods with the memory revision fence', () => {
    expect(AGENT_TEAM_METHODS).toContain('team.memory.write')
    expect(AGENT_TEAM_METHODS).toContain('team.memory.decide')
    expectTypeOf<AgentTeamPayload<'team.memory.write'>>().toEqualTypeOf<{
      teamId: string
      expectedMemoryRevision?: number
      value: TeamMemoryWriteInput
    }>()
    expectTypeOf<AgentTeamResult<'team.memory.write'>>().toEqualTypeOf<TeamMemoryWriteView>()
    expectTypeOf<AgentTeamPayload<'team.memory.decide'>>().toEqualTypeOf<{
      teamId: string
      entryId: string
      expectedMemoryRevision?: number
      decision: 'accept' | 'reject'
    }>()
    expectTypeOf<AgentTeamResult<'team.memory.decide'>>().toEqualTypeOf<TeamMemoryWriteView>()
    expectTypeOf<TeamMemoryWriteView['entry']>().toEqualTypeOf<MemoryEntry>()
  })

  it('maps the Leader Goal status write used to resume a paused Goal', () => {
    expect(AGENT_TEAM_METHODS).toContain('team.updateGoal')
    expectTypeOf<AgentTeamPayload<'team.updateGoal'>>().toEqualTypeOf<{
      teamId: string
      goalId: string
      value: UpdateTeamGoalInput
    }>()
    expectTypeOf<AgentTeamResult<'team.updateGoal'>>().toEqualTypeOf<TeamGoal>()
  })
})

interface FakeResponse extends ServerResponse {
  status: number
  body: string
}

function response(): FakeResponse {
  const value = {
    status: 0,
    body: '',
    writeHead(status: number) {
      value.status = status
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

function request(body: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)])
  return Object.assign(stream, {
    method: 'POST',
    url: AGENT_TEAM_API_PATH,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
}

describe('assistant.memory.undo wire shape', () => {
  it('returns the write-shaped { memory, entry } envelope', async () => {
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
    const ctx = {
      webServer: {
        register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }) {
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      },
      connection: { requestRejection: () => undefined },
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    } as never
    const entry: MemoryEntry = {
      id: 'mem-1',
      scope: 'assistant',
      visibility: 'private',
      status: 'active',
      source: 'user',
      title: 'Tone',
      body: 'Be terse.',
      revision: 2,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    }
    const memory: AssistantMemory = {
      schemaVersion: 1,
      assistantId: 'instance-1',
      content: 'Note',
      entries: [entry],
      revision: 2,
      updatedAt: '2026-10-23T00:00:00.000Z',
    }
    const undoAssistantMemory = vi.fn(async () => ({ memory, entry }))
    const service = {
      subscribe: () => () => {},
      undoAssistantMemory,
    } as unknown as AgentTeamService
    registerWebTransport(
      ctx,
      { maxRequestBytes: 1024, sseHeartbeatMs: 60_000 } as Config,
      service,
    )
    const handler = routes.get(AGENT_TEAM_API_PATH)!
    const outgoing = response()
    await handler(request(JSON.stringify({
      requestId: 'r1',
      method: 'assistant.memory.undo',
      payload: { assistantId: 'instance-1', journalId: 'memj-1', expectedRevision: 2 },
    })), outgoing)

    const body = JSON.parse(outgoing.body) as {
      ok: boolean
      value: { memory: AssistantMemory; entry: MemoryEntry }
    }
    expect(body.ok).toBe(true)
    expect(body.value).toMatchObject({
      memory: { content: 'Note', revision: 2, entries: [{ id: 'mem-1' }] },
      entry: { id: 'mem-1' },
    })
    // The envelope must not be flattened into the memory document.
    expect(body.value).not.toHaveProperty('content')
    expect(undoAssistantMemory).toHaveBeenCalledWith('instance-1', 'memj-1', {
      expectedRevision: 2,
      actor: 'user',
    })
  })
})
