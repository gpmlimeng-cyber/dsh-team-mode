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
import type { TeamCommandHandler } from '../src/runtime/team-command-handler.js'
import { teamContextPrompt } from '../src/runtime/team-prompts.js'
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

function createHarness(overrides: Partial<Config> = {}) {
  const harnessConfig: Config = { ...config, ...overrides }
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
    config: harnessConfig,
    service: new AgentTeamService(ctx as never, harnessConfig, store),
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

/** A running member whose followup immediately starts a turn, so sessionState is `running` at drain time. */
function fakeRunningAgent() {
  const agent = fakeAgent()
  agent.status = 'running'
  agent.followup = vi.fn((message: { id: unknown }) => {
    agent.session.events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    agent.status = 'running'
  })
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

/**
 * A routine `now` that is `extraMs` past the newest durable message. Message
 * factories use wall-clock time, so routine tests derive the window from the
 * stored messages instead of hard-coding an absolute timestamp.
 */
function afterSilence(service: AgentTeamService, teamId: string, extraMs: number): string {
  const latest = Math.max(
    0,
    ...service.listMessages(teamId).items.map(message => Date.parse(message.createdAt)).filter(Number.isFinite),
  )
  return new Date(latest + extraMs).toISOString()
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

  it('recovers the queue when turn/end raced ahead of the idle transition', async () => {
    const { ctx, service, store, emit } = createHarness()
    const team = await twoMemberTeam(service, store)
    const runtime = new TeamRuntime(ctx, config, service)
    const leaderAgent = fakeAgent()
    // The member reports `running` at drain time, exactly like a live agent
    // whose turn/end event has not yet been followed by the idle transition.
    const memberAgent = fakeRunningAgent()
    adopt(runtime, team, team.leaderSlotId, leaderAgent)
    const memberId = Object.keys(team.members).find(id => id !== team.leaderSlotId)!
    adopt(runtime, team, memberId, memberAgent)

    await runtime.sendUserMessage(team.id, 'start working')
    await runtime.sendUserMessage(team.id, 'follow up with member', memberId)
    expect(memberAgent.followup).not.toHaveBeenCalled()

    // turn/end arrives while the member is still running: the release clears the
    // active turn but cannot deliver yet (sessionState stays `running`).
    emit('session/event', { session: { id: team.members[team.leaderSlotId]!.sessionId }, event: {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    } })
    await vi.waitFor(() => {
      expect(service.listMessages(team.id).items.find(m => m.content === 'follow up with member')?.deliveryState).toBe('queued')
    })
    expect(memberAgent.followup).not.toHaveBeenCalled()

    // The idle transition must still find the member's team and drain the queue.
    memberAgent.status = 'idle'
    emit('agent/status', { agent: { id: team.members[memberId]!.sessionId }, status: 'idle' })
    await vi.waitFor(() => {
      expect(memberAgent.followup).toHaveBeenCalledOnce()
      expect(service.listMessages(team.id).items.find(m => m.content === 'follow up with member')?.deliveryState).toBe('delivered')
    })
  })

  it('queues turn/end and idle back-to-back without letting a third message jump the member turn', async () => {
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

    await runtime.sendUserMessage(team.id, 'm1 to member', memberId)
    expect(memberAgent.followup).toHaveBeenCalledOnce()
    // From here the member reports `running`, like a live agent mid-turn.
    memberAgent.status = 'running'

    // Two queued messages land while the member turn is still active. Their
    // createdAt must be strictly ordered so the queue head is deterministic:
    // without it the equal timestamps fall through to the random message id
    // and m3 can become the head, which is not what this test asserts.
    const m2 = await runtime.sendUserMessage(team.id, 'm2 to leader')
    const m3 = await runtime.sendUserMessage(team.id, 'm3 to leader')
    expect(m2.id).not.toBe(m3.id)
    await store.putMessage({ ...m2, createdAt: '2026-10-23T10:00:01.000Z' })
    await store.putMessage({ ...m3, createdAt: '2026-10-23T10:00:02.000Z' })

    // turn/end and idle fire back-to-back before the drain runs.
    memberAgent.status = 'idle'
    emit('session/event', { session: { id: memberSession }, event: {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    } })
    emit('agent/status', { agent: { id: memberSession }, status: 'idle' })

    // m2 (oldest) is delivered to the leader; m3 stays queued behind it.
    await vi.waitFor(() => {
      expect(service.listMessages(team.id).items.find(m => m.content === 'm2 to leader')?.deliveryState).toBe('delivered')
    })
    expect(service.listMessages(team.id).items.find(m => m.content === 'm3 to leader')?.deliveryState).toBe('queued')
    expect(leaderAgent.followup).toHaveBeenCalledTimes(1)

    // Releasing the leader delivers the third message in order.
    emit('session/event', { session: { id: leaderSession }, event: {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    } })
    await vi.waitFor(() => {
      expect(service.listMessages(team.id).items.find(m => m.content === 'm3 to leader')?.deliveryState).toBe('delivered')
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

  it('parks a busy target in the inbox and resumes it once when the member goes idle', async () => {
    const { ctx, service, store, emit } = createHarness()
    const team = await twoMemberTeam(service, store)
    const runtime = new TeamRuntime(ctx, config, service)
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    adopt(runtime, team, team.leaderSlotId, leaderAgent)
    const memberId = Object.keys(team.members).find(id => id !== team.leaderSlotId)!
    adopt(runtime, team, memberId, memberAgent)
    const memberSession = team.members[memberId]!.sessionId
    const commands = (runtime as unknown as { commands: {
      sendMemberMessage: (
        teamId: string, senderSlotId: string, recipientSlotId: string, content: string, type?: string,
      ) => Promise<{ messageId: string; deliveryState: string }>
      inbox: (teamId: string, slotId: string) => {
        unread: Array<{ id: string; parked?: { reason: string; since: string } }>
      }
    } }).commands

    // The leader starts a turn, then the member reports `running`.
    await runtime.sendUserMessage(team.id, 'start working')
    memberAgent.status = 'running'
    emit('agent/status', { agent: { id: memberSession }, status: 'running' })
    await vi.waitFor(() => {
      expect(service.getTeam(team.id).members[memberId]?.lastRuntimeState).toBe('running')
    })

    // A leader instruction to the busy member stays queued and is visible as
    // parked busy in the member's read-only inbox.
    const sent = await commands.sendMemberMessage(team.id, team.leaderSlotId, memberId, 'take this next', 'instruction')
    expect(sent.deliveryState).toBe('queued')
    expect(memberAgent.followup).not.toHaveBeenCalled()
    expect(commands.inbox(team.id, memberId).unread.find(row => row.id === sent.messageId)?.parked)
      .toMatchObject({ reason: 'busy' })

    // The leader's turn can end, but the running target still cannot be woken.
    emitTurnEnd(emit, team.members[team.leaderSlotId]!.sessionId)
    await vi.waitFor(() => {
      expect(service.listMessages(team.id).items.find(m => m.id === sent.messageId)?.deliveryState).toBe('queued')
    })

    // The idle transition resumes the one parked delivery exactly once.
    memberAgent.status = 'idle'
    emit('agent/status', { agent: { id: memberSession }, status: 'idle' })
    await vi.waitFor(() => {
      expect(service.listMessages(team.id).items.find(m => m.id === sent.messageId)?.deliveryState).toBe('delivered')
    })
    expect(memberAgent.followup).toHaveBeenCalledOnce()
    // Delivered mail can still be unread, but it is no longer parked.
    expect(commands.inbox(team.id, memberId).unread.find(row => row.id === sent.messageId)?.parked)
      .toBeUndefined()

    // A repeated idle event must not replay the delivered instruction.
    emit('agent/status', { agent: { id: memberSession }, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(memberAgent.followup).toHaveBeenCalledOnce()
  })

  it('nudges an idle team with open work once, without executing or approving anything', async () => {
    const { ctx, service, store, config: routineConfig } = createHarness({ teamRoutineIdleMs: 60_000 })
    const team = await twoMemberTeam(service, store)
    const runtime = new TeamRuntime(ctx, routineConfig, service)
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    adopt(runtime, team, team.leaderSlotId, leaderAgent)
    const memberId = Object.keys(team.members).find(id => id !== team.leaderSlotId)!
    adopt(runtime, team, memberId, memberAgent)
    const commands = (runtime as unknown as { commands: TeamCommandHandler }).commands
    const leaderSession = team.members[team.leaderSlotId]!.sessionId
    const routineThread = `routine:${team.id}`

    const goal = await commands.createGoal(team.id, team.leaderSlotId, {
      title: 'Ship routine',
      objective: 'Exercise the idle nudge',
    })
    const task = await commands.createTask(team.id, team.leaderSlotId, {
      subject: 'Open work',
      owner: memberId,
      goal_id: goal.goal_id,
    })
    const beforeTask = service.getTeam(team.id).tasks[task.taskId]!
    const beforeGoal = service.getTeam(team.id).goals![goal.goal_id]!

    // A recent dispatch message keeps the window closed.
    expect(await commands.runDueRoutine(team.id, afterSilence(service, team.id, 31_000)))
      .toMatchObject({ nudged: false })
    expect(service.listMessages(team.id).items.filter(m => m.threadId === routineThread)).toHaveLength(0)

    // The Leader is busy: the one nudge is submitted through the coordinator
    // and parks instead of being delivered immediately.
    leaderAgent.status = 'running'
    const first = await commands.runDueRoutine(team.id, afterSilence(service, team.id, 61_000))
    expect(first).toMatchObject({ nudged: true, deliveryState: 'queued' })
    expect(leaderAgent.followup).not.toHaveBeenCalled()
    const nudge = service.listMessages(team.id).items.find(message => message.id === first.messageId)!
    expect(nudge).toMatchObject({
      type: 'instruction',
      sender: { kind: 'system', id: 'dsh-team-mode' },
      recipient: { kind: 'leader', slotId: team.leaderSlotId },
      threadId: routineThread,
      deliveryState: 'queued',
    })
    expect(nudge.content).toContain('Routine idle check')
    expect(nudge.content).toContain('starts no work')

    // Idle release delivers that single nudge exactly once.
    leaderAgent.status = 'idle'
    await internals(runtime).turns.releaseSession(leaderSession)
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(service.listMessages(team.id).items.find(message => message.id === first.messageId)?.deliveryState)
      .toBe('delivered')
    await internals(runtime).turns.releaseSession(leaderSession)
    expect(service.listMessages(team.id).items.filter(m => m.threadId === routineThread)).toHaveLength(1)

    // The nudge itself resets the silence window: the next tick is silent.
    expect(await commands.runDueRoutine(team.id, afterSilence(service, team.id, 30_000)))
      .toMatchObject({ nudged: false })
    expect(await commands.runDueRoutine(team.id, afterSilence(service, team.id, 30_000)))
      .toMatchObject({ nudged: false })
    expect(service.listMessages(team.id).items.filter(m => m.threadId === routineThread)).toHaveLength(1)

    // No auto-execution: the board is byte-identical to before the nudge.
    expect(service.getTeam(team.id).tasks[task.taskId]).toMatchObject({
      status: beforeTask.status,
      revision: beforeTask.revision,
      ownerSlotId: beforeTask.ownerSlotId,
      updatedAt: beforeTask.updatedAt,
    })
    expect(service.getTeam(team.id).goals?.[goal.goal_id]).toMatchObject({
      status: beforeGoal.status,
      updatedAt: beforeGoal.updatedAt,
    })
    expect(service.getTeam(team.id).tasks[task.taskId]).not.toHaveProperty('verdict')
    expect(leaderAgent.followup).toHaveBeenCalledOnce()

    // An active turn blocks the routine even after a full silence window.
    await runtime.sendUserMessage(team.id, 'leader, check the board')
    expect(await commands.runDueRoutine(team.id, afterSilence(service, team.id, 61_000)))
      .toMatchObject({ nudged: false })
    await internals(runtime).turns.releaseSession(leaderSession)
    expect(await commands.runDueRoutine(team.id, afterSilence(service, team.id, 61_000)))
      .toMatchObject({ nudged: true })
    expect(service.listMessages(team.id).items.filter(m => m.threadId === routineThread)).toHaveLength(2)

    // A running member is working: no nudge, even though the channel is silent.
    await service.updateRuntimeTeam(team.id, current => ({
      ...current,
      members: {
        ...current.members,
        [memberId]: { ...current.members[memberId]!, lastRuntimeState: 'running' },
      },
    }), 'test.member_running', 'member running')
    expect(await commands.runDueRoutine(team.id, afterSilence(service, team.id, 61_000)))
      .toMatchObject({ nudged: false })
    await service.updateRuntimeTeam(team.id, current => ({
      ...current,
      members: {
        ...current.members,
        [memberId]: { ...current.members[memberId]!, lastRuntimeState: 'idle' },
      },
    }), 'test.member_idle', 'member idle')

    // Inactive and archived teams are skipped.
    await service.updateRuntimeTeam(team.id, current => ({ ...current, state: 'deleting' }), 'test.deleting', 'deleting')
    expect(await commands.runDueRoutine(team.id, afterSilence(service, team.id, 61_000)))
      .toMatchObject({ nudged: false })
    await service.updateRuntimeTeam(team.id, current => ({
      ...current,
      state: 'active',
      archivedAt: '2026-01-01T00:00:00.000Z',
    }), 'test.archived', 'archived')
    expect(await commands.runDueRoutine(team.id, afterSilence(service, team.id, 61_000)))
      .toMatchObject({ nudged: false })
    await service.updateRuntimeTeam(team.id, current => {
      const next = { ...current, state: 'active' as const }
      delete next.archivedAt
      return next
    }, 'test.active', 'active')

    // No open task and no active Goal: the routine has nothing to nudge about.
    await commands.updateTask(team.id, memberId, {
      task_id: task.taskId,
      status: 'completed',
      result: 'done',
      attempt_id: task.attemptId!,
    })
    await commands.updateGoal(team.id, team.leaderSlotId, {
      goal_id: goal.goal_id,
      status: 'completed',
    })
    expect(await commands.runDueRoutine(team.id, afterSilence(service, team.id, 61_000)))
      .toMatchObject({ nudged: false })
    expect(service.listMessages(team.id).items.filter(m => m.threadId === routineThread)).toHaveLength(2)
  })

  it('keeps the routine disabled by default', async () => {
    const { ctx, service, store } = createHarness()
    const team = await twoMemberTeam(service, store)
    // The base test config has no teamRoutineIdleMs: the default is off.
    const runtime = new TeamRuntime(ctx, config, service)
    adopt(runtime, team, team.leaderSlotId, fakeAgent())
    const memberId = Object.keys(team.members).find(id => id !== team.leaderSlotId)!
    adopt(runtime, team, memberId, fakeAgent())
    const commands = (runtime as unknown as { commands: TeamCommandHandler }).commands

    const goal = await commands.createGoal(team.id, team.leaderSlotId, {
      title: 'Off by default',
      objective: 'No routine',
    })
    const task = await commands.createTask(team.id, team.leaderSlotId, {
      subject: 'Open work',
      owner: memberId,
      goal_id: goal.goal_id,
    })

    expect(await commands.runDueRoutine(team.id, afterSilence(service, team.id, 61_000)))
      .toMatchObject({ nudged: false })
    expect(service.listMessages(team.id).items.some(message => message.threadId === `routine:${team.id}`))
      .toBe(false)
    // The task remains exactly as created: the routine never executes it.
    expect(service.getTeam(team.id).tasks[task.taskId]?.status).toBe(task.status)
  })

  it('gives the roster section team memory to the Leader and to no member', async () => {
    const { ctx, service, store } = createHarness()
    const team = await twoMemberTeam(service, store)
    const memberId = Object.keys(team.members).find(id => id !== team.leaderSlotId)!
    await service.writeUserTeamMemory(
      team.id,
      { title: 'Release', body: 'Ship on Friday.' },
      { expectedMemoryRevision: 0 },
    )
    const latest = service.getTeam(team.id)

    const leaderPrompt = teamContextPrompt(latest, team.leaderSlotId)
    expect(leaderPrompt).toContain('Team memory')
    expect(leaderPrompt).toContain('Ship on Friday.')

    const memberPrompt = teamContextPrompt(latest, memberId)
    expect(memberPrompt).toContain('Team roster')
    expect(memberPrompt).not.toContain('Team memory')
    expect(memberPrompt).not.toContain('Ship on Friday.')
  })
})
