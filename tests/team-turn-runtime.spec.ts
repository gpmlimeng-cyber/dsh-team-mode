import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import type {
  AssistantInstance,
  AssistantMemory,
  AssistantSession,
  AssistantTemplate,
  ContextCheckpoint,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
} from '../src/domain/types.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import { TeamRuntime } from '../src/runtime/team-runtime.js'

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

const assistantInput = {
  name: 'Alpha',
  instructions: 'Lead the team.',
  provider: 'openai',
  model: 'codex',
  agentPresetId: 'default',
  permissionPresetId: 'standard',
  skillAllowlist: [],
  mcpServers: [],
}

function createHarness() {
  const listeners = new Map<string, Set<(event: any) => void>>()
  const ctx = new Context() as any
  ctx.on = (name: string, handler: (event: any) => void) => {
    let bucket = listeners.get(name)
    if (bucket === undefined) {
      bucket = new Set()
      listeners.set(name, bucket)
    }
    bucket.add(handler)
    return () => { bucket?.delete(handler) }
  }
  ctx.emit = (name: string, event: any) => {
    for (const handler of listeners.get(name) ?? []) handler(event)
  }
  ctx.provide('llm', {
    listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
    listModels: async () => [{ id: 'codex', name: 'Codex' }],
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      model,
      reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
    }),
  } as never)
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'default', name: 'Default' }],
    resolve: async (id: string) => ({ id, name: id }),
    acquireScope: async () => ({ key: { kind: 'preset-scope' }, [Symbol.asyncDispose]: async () => {} }),
  } as never)
  ctx.provide('tools', { get: () => undefined, schemas: () => [] } as never)
  ctx.provide('skills', { list: async () => [] } as never)
  ctx.provide('permissionPresets', {
    names: ['standard'],
    optionOf: (name: string) => ({ value: name, name }),
    set: () => {},
  } as never)
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('sessions', { flush: async () => {} } as never)
  ctx.provide('sessionPersistence', { list: async () => [] } as never)
  const workspace = {
    id: 'workspace-1',
    path: '/tmp/dsh-team-mode-turn-workspace',
    title: 'Workspace',
    status: async () => 'ok' as const,
    attachSession: async () => {},
    detachSession: async () => {},
  }
  ctx.provide('workspaceRegistry', {
    get: (id: string) => id === workspace.id ? workspace : undefined,
    list: () => [workspace],
  } as never)
  const store = new MemoryStore()
  return {
    ctx,
    store,
    service: new AgentTeamService(ctx as never, config, store),
    emit: ctx.emit as (name: string, event: unknown) => void,
  }
}

class MemoryStore implements AgentTeamStore {
  private assistants = new Map<string, AssistantTemplate>()
  private assistantInstances = new Map<string, AssistantInstance>()
  private assistantSessions = new Map<string, AssistantSession>()
  private assistantMemory = new Map<string, AssistantMemory>()
  private teams = new Map<string, TeamAggregate>()
  private messages = new Map<string, TeamMessage>()
  private activities = new Map<string, TeamActivity>()
  private operations = new Map<string, Operation>()

  getAssistant(id: string) { return this.assistants.get(id) }
  listAssistants() { return [...this.assistants.values()] }
  async putAssistant(value: AssistantTemplate) { this.assistants.set(value.id, value) }
  async updateAssistant(id: string, update: (current: AssistantTemplate) => AssistantTemplate) {
    return updateMap(this.assistants, id, update)
  }
  async deleteAssistant(id: string) { return this.assistants.delete(id) }

  getAssistantInstance(id: string) { return this.assistantInstances.get(id) }
  listAssistantInstances() { return [...this.assistantInstances.values()] }
  async putAssistantInstance(value: AssistantInstance) { this.assistantInstances.set(value.id, value) }
  async updateAssistantInstance(
    id: string,
    update: (current: AssistantInstance) => AssistantInstance,
  ) {
    return updateMap(this.assistantInstances, id, update)
  }
  async deleteAssistantInstance(id: string) { return this.assistantInstances.delete(id) }

  getAssistantMemory(assistantId: string) { return this.assistantMemory.get(assistantId) }
  async putAssistantMemory(value: AssistantMemory) { this.assistantMemory.set(value.assistantId, value) }
  async updateAssistantMemory(
    assistantId: string,
    update: (current: AssistantMemory) => AssistantMemory,
  ) {
    return updateMap(this.assistantMemory, assistantId, update)
  }

  getAssistantSession(id: string) { return this.assistantSessions.get(id) }
  listAssistantSessions() { return [...this.assistantSessions.values()] }
  async putAssistantSession(value: AssistantSession) { this.assistantSessions.set(value.id, value) }
  async updateAssistantSession(
    id: string,
    update: (current: AssistantSession) => AssistantSession,
  ) {
    return updateMap(this.assistantSessions, id, update)
  }

  getContextCheckpoint(id: string): ContextCheckpoint | undefined { return undefined }
  listContextCheckpoints(): ContextCheckpoint[] { return [] }
  async putContextCheckpoint(_value: ContextCheckpoint) {}

  getTeam(id: string) { return this.teams.get(id) }
  listTeams() { return [...this.teams.values()] }
  async putTeam(value: TeamAggregate) { this.teams.set(value.id, value) }
  async updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate) {
    return updateMap(this.teams, id, update)
  }
  async deleteTeam(id: string) { return this.teams.delete(id) }

  listMessages(teamId: string) { return [...this.messages.values()].filter(value => value.teamId === teamId) }
  async putMessage(value: TeamMessage) { this.messages.set(value.id, value) }
  async deleteMessage(id: string) { return this.messages.delete(id) }

  listActivities(teamId: string) { return [...this.activities.values()].filter(value => value.teamId === teamId) }
  async putActivity(value: TeamActivity) { this.activities.set(value.id, value) }
  async deleteActivity(id: string) { return this.activities.delete(id) }

  getOperation(id: string) { return this.operations.get(id) }
  listOperations() { return [...this.operations.values()] }
  async putOperation(value: Operation) { this.operations.set(value.id, value) }
  async updateOperation(id: string, update: (current: Operation) => Operation) {
    return updateMap(this.operations, id, update)
  }
  async deleteOperation(id: string) { return this.operations.delete(id) }
}

async function updateMap<T>(map: Map<string, T>, id: string, update: (current: T) => T): Promise<T> {
  const current = map.get(id)
  if (current === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown record '${id}'`)
  const next = update(current)
  map.set(id, next)
  return next
}

function fakeAgent() {
  const session = {
    events: [] as unknown[],
    snapshotEvents: () => session.events,
  }
  const agent = {
    id: 'unknown',
    session,
    status: 'idle',
    followup: vi.fn((message: { id: unknown }) => {
      session.events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    }),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
  return agent
}

type RuntimeInternals = {
  owned: Map<string, {
    teamId: string
    slotId: string
    sessionId: string
    epoch: number
    handle: { agent: Agent; dispose: () => Promise<void> }
    modelSelection: unknown
  }>
  turns: {
    releaseSession(sessionId: string): Promise<void>
    drain(teamId: string): Promise<void>
    drainAll(teamIds: readonly string[]): Promise<void>
  }
  ensureMembersOnline(team: TeamAggregate): Promise<void>
}

function internals(runtime: TeamRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function adopt(
  runtime: TeamRuntime,
  team: TeamAggregate,
  slotId: string,
  agent: ReturnType<typeof fakeAgent>,
): void {
  const member = team.members[slotId]
  if (member === undefined) throw new Error(`missing member ${slotId}`)
  agent.id = member.sessionId
  internals(runtime).owned.set(member.sessionId, {
    teamId: team.id,
    slotId,
    sessionId: member.sessionId,
    epoch: team.epoch ?? 1,
    handle: { agent: agent as unknown as Agent, dispose: async () => {} },
    modelSelection: { current: undefined, assembled: undefined },
  })
}

function emitTurnEnd(emit: (name: string, event: unknown) => void, sessionId: string): void {
  emit('session/event', { session: { id: sessionId }, event: {
    type: 'turn/end',
    data: { reason: { kind: 'completed' } },
  } })
}

async function twoMemberTeam(service: AgentTeamService, _store: MemoryStore): Promise<TeamAggregate> {
  const assistant = await service.createAssistant(assistantInput)
  const draft = await service.createTeamDraft({
    name: 'Turn Team',
    workspaceId: 'workspace-1',
    members: [
      { assistantId: assistant.id, role: 'leader' },
      { assistantId: assistant.id, role: 'member' },
    ],
  })
  const memberId = Object.keys(draft.members).find(id => id !== draft.leaderSlotId)!
  // Both members keep the assistant name on purpose: the routing matrix requires
  // two known mentions (@Alpha and @Beta) to be rejected, which exercises the
  // multi-mention guard through the runtime path too.
  await service.renameMember(draft.id, memberId, 'Beta')
  await service.renameMember(draft.id, draft.leaderSlotId, 'Alpha')
  await service.updateRuntimeTeam(draft.id, current => ({ ...current, state: 'active' }), 'test.active', 'active for tests')
  return service.getTeam(draft.id)
}

describe('team turn runtime wiring', () => {
  it('routes a default user message to the leader and a mention to the member', async () => {
    const { ctx, service, store } = createHarness()
    const team = await twoMemberTeam(service, store)
    const runtime = new TeamRuntime(ctx, config, service)
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    const memberId = Object.keys(team.members).find(id => id !== team.leaderSlotId)!
    adopt(runtime, team, team.leaderSlotId, leaderAgent)
    adopt(runtime, team, memberId, memberAgent)

    const first = await runtime.sendUserMessage(team.id, 'hello team')
    expect(first.recipient.slotId).toBe(team.leaderSlotId)
    expect(first.deliveryState).toBe('delivered')
    expect(leaderAgent.followup).toHaveBeenCalledOnce()

    await expect(runtime.sendUserMessage(team.id, '@Alpha and @Beta both help')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })

    // An explicit UI-selected target still wins over any mention in the body.
    const second = await runtime.sendUserMessage(team.id, 'hand this to the member', memberId)
    expect(second.recipient.slotId).toBe(memberId)
  })

  it('queues a member message while another turn is active and returns queued', async () => {
    const { ctx, service, store } = createHarness()
    const team = await twoMemberTeam(service, store)
    const runtime = new TeamRuntime(ctx, config, service)
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    adopt(runtime, team, team.leaderSlotId, leaderAgent)
    const memberId = Object.keys(team.members).find(id => id !== team.leaderSlotId)!
    adopt(runtime, team, memberId, memberAgent)

    await runtime.sendUserMessage(team.id, 'start working')
    const sent = await (runtime as unknown as { commands: { sendMemberMessage: (
      teamId: string, senderSlotId: string, recipientSlotId: string, content: string, type?: string,
    ) => Promise<{ messageId: string; deliveryState: string; deliveredTo: string[]; queuedFor?: string[] }> } })
      .commands.sendMemberMessage(team.id, memberId, team.leaderSlotId, 'done with part one', 'progress')

    expect(sent.deliveryState).toBe('queued')
    expect(sent.queuedFor).toEqual([team.leaderSlotId])
    expect(leaderAgent.followup).toHaveBeenCalledOnce()

    await internals(runtime).turns.releaseSession(team.members[team.leaderSlotId]!.sessionId)
    expect(leaderAgent.followup).toHaveBeenCalledTimes(2)
  })

  it('releases the active turn on agent idle and on turn/end', async () => {
    const { ctx, service, store, emit } = createHarness()
    const team = await twoMemberTeam(service, store)
    const runtime = new TeamRuntime(ctx, config, service)
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    adopt(runtime, team, team.leaderSlotId, leaderAgent)
    const memberId = Object.keys(team.members).find(id => id !== team.leaderSlotId)!
    adopt(runtime, team, memberId, memberAgent)
    const leaderSession = team.members[team.leaderSlotId]!.sessionId
    const memberSession = team.members[memberId]!.sessionId

    await runtime.sendUserMessage(team.id, 'first')
    await runtime.sendUserMessage(team.id, 'second for member', memberId)
    expect(memberAgent.followup).not.toHaveBeenCalled()

    emit('agent/status', { agent: { id: leaderSession }, status: 'idle' })
    await vi.waitFor(() => { expect(memberAgent.followup).toHaveBeenCalledOnce() })

    // The member now holds the turn; a followup user message waits for its release.
    await runtime.sendUserMessage(team.id, 'third for leader')
    const third = service.listMessages(team.id).items.find(m => m.content === 'third for leader')
    expect(third?.deliveryState).toBe('queued')
    emitTurnEnd(emit, memberSession)
    await vi.waitFor(() => {
      expect(service.listMessages(team.id).items.find(m => m.content === 'third for leader')?.deliveryState).toBe('delivered')
    })
  })

  it('drains persisted queued messages exactly once during recovery', async () => {
    const { ctx, service, store } = createHarness()
    const team = await twoMemberTeam(service, store)
    const runtime = new TeamRuntime(ctx, config, service)
    const internalsRef = internals(runtime)
    const leaderAgent = fakeAgent()
    adopt(runtime, team, team.leaderSlotId, leaderAgent)
    const queued = await service.putRuntimeMessage({
      schemaVersion: 1,
      id: 'persisted-1',
      teamId: team.id,
      sender: { kind: 'user', id: 'local-user' },
      recipient: { kind: 'leader', slotId: team.leaderSlotId },
      type: 'instruction',
      content: 'persisted instruction',
      attachments: [],
      readBy: [],
      deliveryState: 'queued',
      idempotencyKey: 'persisted-1',
      createdAt: new Date(Date.now() - 1_000).toISOString(),
    } as never).then(() => service.listMessages(team.id).items.find(m => m.id === 'persisted-1')!)

    expect(queued.deliveryState).toBe('queued')
    internalsRef.ensureMembersOnline = vi.fn(async () => {})

    await runtime.recoverTeams()

    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(service.listMessages(team.id).items.find(m => m.id === 'persisted-1')?.deliveryState).toBe('delivered')

    // A second recovery must not deliver it again.
    await runtime.recoverTeams()
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
  })
})
