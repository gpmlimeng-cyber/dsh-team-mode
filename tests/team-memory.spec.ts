import { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import type {
  AssistantInstance,
  AssistantMemory,
  AssistantSession,
  AssistantTemplate,
  ContextCheckpoint,
  MemoryEntry,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMemberSlot,
  TeamMessage,
} from '../src/domain/types.js'
import { TeamCommandHandler } from '../src/runtime/team-command-handler.js'
import {
  groupBriefPrompt,
  linkedAssistantMemoryPrompt,
  memberPrompt,
  teamMemoryPrompt,
} from '../src/runtime/team-prompts.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import { teamMemoryView } from '../src/client/labels.js'
import { MemoryEntryCard } from '../src/client/teams/TeamPanel.js'

// The shipped primitives package expects browser peers (clsx) that this node
// test does not install; the shared entry card renders plain elements.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (): null => null
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => property === 'then' ? undefined : Stub,
  })
})

const NOW = '2026-01-01T00:00:00.000Z'

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

function member(id: string, role: 'leader' | 'member'): TeamMemberSlot {
  return {
    id,
    assistantId: `assistant-${id}`,
    displayName: id,
    role,
    assistantSnapshot: {
      assistantId: `assistant-${id}`,
      revision: 1,
      name: id,
      instructions: '',
      provider: 'test',
      model: 'test-model',
      agentPresetId: 'default',
      permissionPresetId: 'default',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    permissionPresetId: 'default',
    sessionId: `session-${id}`,
    desiredState: 'online',
    lastRuntimeState: 'idle',
    joinedAt: NOW,
  }
}

function entry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, 'id'>): MemoryEntry {
  return {
    scope: 'team',
    visibility: 'team-safe',
    status: 'active',
    source: 'user',
    title: `Title ${overrides.id}`,
    body: `Body ${overrides.id}`,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function teamAggregate(memory?: TeamAggregate['memory']): TeamAggregate {
  return {
    schemaVersion: 2,
    id: 'team-1',
    name: 'Memory team',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/team-memory-workspace',
    epoch: 1,
    state: 'active',
    leaderSlotId: 'leader',
    members: { leader: member('leader', 'leader'), worker: member('worker', 'member') },
    tasks: {},
    ...(memory === undefined ? {} : { memory }),
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as TeamAggregate
}

describe('M2 team memory scope and UI', () => {
  it('renders team-scoped entries through the shared MemoryEntry component', () => {
    const active = entry({ id: 'active', title: 'Ship on Friday', body: 'Agreed in review.' })
    const html = renderToStaticMarkup(createElement(MemoryEntryCard, { entry: active }))
    expect(html).toContain('Ship on Friday')
    expect(html).toContain('Agreed in review.')
    expect(html).toContain('团队可见')
    expect(html).toContain('生效')
    expect(html).toContain('v1')
  })

  it('shows only team-safe team entries in the team view', () => {
    const view = teamMemoryView({
      revision: 3,
      entries: [
        entry({ id: 'active' }),
        entry({ id: 'private', visibility: 'private' }),
        entry({ id: 'assistant-scope', scope: 'assistant' }),
        entry({ id: 'proposed', status: 'proposed' }),
      ],
      updatedAt: NOW,
    })
    expect(view.revision).toBe(3)
    expect(view.active.map(value => value.id)).toEqual(['active'])
    expect(view.proposed.map(value => value.id)).toEqual(['proposed'])
    expect(view.active.some(value => value.visibility !== 'team-safe')).toBe(false)
  })

  it('loads team memory into the Leader prompt and never into a member prompt', () => {
    const team = teamAggregate({
      revision: 1,
      entries: [
        entry({ id: 'active', title: 'Lint', body: 'Use eslint.' }),
        entry({ id: 'proposed', status: 'proposed', title: 'Proposal', body: 'PROPOSED-BODY' }),
        entry({ id: 'private', visibility: 'private', title: 'Private', body: 'PRIVATE-BODY' }),
        entry({ id: 'assistant-scope', scope: 'assistant', title: 'Other scope', body: 'ASSISTANT-BODY' }),
      ],
      updatedAt: NOW,
    })

    const leaderText = memberPrompt(team, team.members.leader!)
    expect(leaderText).toContain('Team memory — decisions')
    expect(leaderText).toContain('Lint: Use eslint.')
    expect(leaderText).not.toContain('PROPOSED-BODY')
    expect(leaderText).not.toContain('PRIVATE-BODY')
    expect(leaderText).not.toContain('ASSISTANT-BODY')

    // The shared rules mention team memory by name; the block itself, and its
    // agreed facts, must not reach an ordinary member.
    const memberText = memberPrompt(team, team.members.worker!)
    expect(memberText).not.toContain('Team memory — decisions')
    expect(memberText).not.toContain('Use eslint.')
    expect(teamMemoryPrompt(team)).toContain('Use eslint.')
  })

  it('injects a group brief into members of that group and nothing when empty', () => {
    const team = { ...teamAggregate(), group: '工作' }

    // The runtime resolves the brief for this team's own group and passes the
    // formatted block; both roles in the group receive it.
    const brief = groupBriefPrompt(team.group, 'Answer in Chinese and cite files.')
    expect(brief).toContain('Sidebar group brief')
    expect(brief).toContain('工作')
    expect(brief).toContain('Answer in Chinese and cite files.')
    expect(brief).toContain('no tool can change it')
    for (const slot of ['leader', 'worker'] as const) {
      const prompt = memberPrompt(team, team.members[slot]!, brief)
      expect(prompt).toContain('Answer in Chinese and cite files.')
    }

    // An empty or whitespace-only brief contributes no block, so an ungrouped
    // member assembles exactly as before.
    expect(groupBriefPrompt('工作', '')).toBe('')
    expect(groupBriefPrompt('工作', '   ')).toBe('')
    expect(groupBriefPrompt(undefined, 'ignored')).toBe('')
    expect(memberPrompt(team, team.members.worker!, '')).not.toContain('Sidebar group brief')
  })

  it('keeps one group brief out of another group prompt', () => {
    const alpha = groupBriefPrompt('A', 'ALPHA-BRIEF')
    const beta = groupBriefPrompt('B', 'BETA-BRIEF')
    expect(alpha).toContain('ALPHA-BRIEF')
    expect(alpha).not.toContain('BETA-BRIEF')
    expect(beta).toContain('BETA-BRIEF')
    expect(beta).not.toContain('ALPHA-BRIEF')
  })

  it('lets a member propose but keeps the entry proposed until the Leader accepts', async () => {
    let team = teamAggregate()
    const service = {
      getTeam: () => team,
      updateRuntimeTeam: vi.fn(async (
        _teamId: string,
        update: (current: TeamAggregate) => TeamAggregate,
      ) => {
        team = update(team)
        return team
      }),
    }
    const handler = new TeamCommandHandler(service as never, {
      deliverMessage: async () => true,
      followup: () => {},
    })

    const proposal = await handler.proposeMemory(team.id, 'worker', {
      title: 'Use tabs',
      body: 'Agreed in the design review.',
      expected_revision: 0,
    })
    expect(proposal.entry).toMatchObject({
      status: 'proposed',
      visibility: 'team-safe',
      source: 'member',
      author_slot: 'worker',
    })
    // The proposal stays visible in the list, but is not an active agreement.
    expect(handler.listMemory(team.id).entries.map(value => value.status)).toContain('proposed')
    expect(teamMemoryPrompt(team)).toBe('')

    // A stale revision is rejected instead of overwriting the proposal.
    await expect(handler.proposeMemory(team.id, 'worker', {
      title: 'Stale edit',
      body: 'Stale',
      expected_revision: 0,
    })).rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' })

    // A member cannot decide its own proposal, and cannot promote it directly.
    await expect(handler.decideMemory(team.id, 'worker', {
      entry_id: proposal.entry.entry_id,
      expected_revision: 1,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(team.memory?.entries[0]?.status).toBe('proposed')

    const accepted = await handler.decideMemory(team.id, 'leader', {
      entry_id: proposal.entry.entry_id,
      expected_revision: 1,
    })
    expect(accepted.entry).toMatchObject({ status: 'active', revision: 2 })
    expect(teamMemoryPrompt(team)).toContain('Use tabs')
  })

  it('keeps assistant and team memory unable to read each other', () => {
    const teamEntry = entry({ id: 'team-entry', title: 'Team rule', body: 'TEAM-BODY' })
    const assistantEntry = entry({
      id: 'assistant-entry',
      scope: 'assistant',
      title: 'Assistant rule',
      body: 'ASSISTANT-BODY',
    })
    expect(teamMemoryPrompt(teamAggregate({
      revision: 1,
      entries: [teamEntry, assistantEntry],
      updatedAt: NOW,
    }))).not.toContain('ASSISTANT-BODY')
    expect(linkedAssistantMemoryPrompt({
      state: 'linked',
      entries: [assistantEntry, teamEntry],
    })).not.toContain('TEAM-BODY')
  })

  it('writes explicit team edits as team-safe active entries with a revision fence', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant({
      name: 'Alpha',
      instructions: 'Lead.',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    })
    const team = await service.createTeamDraft({
      name: 'Memory team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const assistantMemory: AssistantMemory = {
      schemaVersion: 1,
      assistantId: assistant.id,
      content: '',
      entries: [entry({
        id: 'assistant-only',
        scope: 'assistant',
        visibility: 'private',
        title: 'Assistant only',
        body: 'ASSISTANT-BODY',
      })],
      revision: 1,
      updatedAt: NOW,
    }
    await store.putAssistantMemory(assistantMemory)
    const assistantBefore = store.getAssistantMemory(assistant.id)!

    const created = await service.writeUserTeamMemory(
      team.id,
      { title: 'Fact', body: 'One', key: 'fact' },
      { expectedMemoryRevision: 0 },
    )
    expect(created.entry).toMatchObject({
      scope: 'team',
      visibility: 'team-safe',
      status: 'active',
      source: 'user',
      revision: 1,
    })
    // A team write never reaches the Assistant memory row.
    expect(store.getAssistantMemory(assistant.id)).toEqual(assistantBefore)

    const edited = await service.writeUserTeamMemory(
      team.id,
      { id: created.entry.id, title: 'Fact v2', body: 'Two' },
      { expectedMemoryRevision: 1 },
    )
    expect(edited.entry).toMatchObject({ id: created.entry.id, revision: 2, title: 'Fact v2' })
    expect(edited.entry.visibility).toBe('team-safe')

    await expect(service.writeUserTeamMemory(
      team.id,
      { id: created.entry.id, title: 'Stale', body: 'Stale' },
      { expectedMemoryRevision: 1 },
    )).rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' })
    expect(store.getTeam(team.id)!.memory?.entries).toHaveLength(1)
    expect(store.getTeam(team.id)!.memory?.entries[0]?.title).toBe('Fact v2')
  })
})

function createHarness() {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const ctx = new Context() as any
  ctx.on = (name: string, handler: (event: unknown) => void) => {
    let bucket = listeners.get(name)
    if (bucket === undefined) {
      bucket = new Set()
      listeners.set(name, bucket)
    }
    bucket.add(handler)
    return () => { bucket?.delete(handler) }
  }
  ctx.emit = (name: string, event: unknown) => {
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
    path: '/tmp/dsh-team-mode-memory-workspace',
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
  return { ctx, store, service: new AgentTeamService(ctx as never, config, store) }
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

  getContextCheckpoint(_id: string): ContextCheckpoint | undefined { return undefined }
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
