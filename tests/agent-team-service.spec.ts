import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import {
  assistantMemorySchema,
  createTeamDraftInputSchema,
  teamAggregateSchema,
  teamTaskSchema,
} from '../src/domain/schemas.js'
import type {
  AssistantInstance,
  AssistantMemory,
  AssistantSession,
  AssistantTemplate,
  CheckpointFacts,
  ContextCheckpoint,
  MemoryEntry,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamGoal,
  TeamMessage,
  TeamTask,
} from '../src/domain/types.js'
import { AssistantRuntime } from '../src/runtime/assistant-runtime.js'
import { AGENT_TEAM_API_PATH } from '../src/transport/contracts.js'
import { registerWebTransport } from '../src/transport/web.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import { isRateLimitMessage, TeamRuntime } from '../src/runtime/team-runtime.js'
import type { TeamCommandHandler } from '../src/runtime/team-command-handler.js'
import type { TeamMessageDispatcher } from '../src/runtime/team-message-dispatcher.js'
import { ASSISTANT_BUILDER_PROMPT } from '../src/runtime/assistant-builder-runtime.js'

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

describe('AgentTeamService', () => {
  it('announces model directory changes so open selectors refresh', () => {
    const { ctx, service } = createHarness()
    const listener = vi.fn()
    service.subscribe(listener)

    ctx.emit('llm/adapters-updated')

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'catalog',
      entityId: 'models',
      kind: 'catalog.models_updated',
    }))
  })

  it('reuses identical uploads and only renames same-name files with different content', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dsh-team-mode-upload-'))
    try {
      const { service } = createHarness(workspacePath)
      const assistant = await service.createAssistant(assistantInput())
      const team = await service.createTeamDraft({
        name: 'Upload team',
        workspaceId: 'workspace-1',
        directMemberChat: true,
        members: [{ assistantId: assistant.id, role: 'leader' }],
      })
      const bytes = new TextEncoder().encode('hello')
      const changedBytes = new TextEncoder().encode('changed')

      const first = await service.uploadWorkspaceFile(team.id, '../notes.txt', bytes)
      const duplicate = await service.uploadWorkspaceFile(team.id, '../notes.txt', bytes)
      const changed = await service.uploadWorkspaceFile(team.id, '../notes.txt', changedBytes)
      const changedDuplicate = await service.uploadWorkspaceFile(team.id, '../notes.txt', changedBytes)

      expect(first).toEqual({ name: 'notes.txt', path: '.dsh-team-mode/uploads/notes.txt', bytes: 5 })
      expect(duplicate).toEqual(first)
      expect(changed).toEqual({ name: 'notes (1).txt', path: '.dsh-team-mode/uploads/notes (1).txt', bytes: 7 })
      expect(changedDuplicate).toEqual(changed)
      await expect(readFile(join(workspacePath, first.path), 'utf8')).resolves.toBe('hello')
      await expect(readFile(join(workspacePath, changed.path), 'utf8')).resolves.toBe('changed')
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('lists the earliest created assistants first', async () => {
    const { service, store } = createHarness()
    const base = {
      schemaVersion: 1 as const,
      description: undefined,
      icon: undefined,
      instructions: 'Coordinate the team.',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
      skillAllowlist: [],
      mcpServers: [],
      enabled: true,
      teamSelectable: true,
      sortOrder: 0,
      prompts: [],
      source: 'user' as const,
      revision: 1,
    }
    await store.putAssistant({
      ...base,
      id: 'older-assistant',
      name: 'Older assistant',
      createdAt: '2026-08-17T08:00:00.000Z',
      updatedAt: '2026-08-17T08:00:00.000Z',
    })
    await store.putAssistant({
      ...base,
      id: 'newer-assistant',
      name: 'Newer assistant',
      createdAt: '2026-08-18T08:00:00.000Z',
      updatedAt: '2026-08-18T08:00:00.000Z',
    })

    expect(service.listAssistants().items.map(assistant => assistant.id)).toEqual([
      'older-assistant',
      'newer-assistant',
    ])
  })

  it('defaults new assistants to enabled and team-selectable and applies explicit sort order', async () => {
    const { service, store } = createHarness()
    const first = await service.createAssistant({ ...assistantInput(), name: 'First' })
    const second = await service.createAssistant({ ...assistantInput(), name: 'Second' })

    expect(first.enabled).toBe(true)
    expect(first.teamSelectable).toBe(true)
    expect(first.sortOrder).toBe(0)
    expect(first.source).toBe('user')
    expect(second.sortOrder).toBe(1)

    const disabled = await service.updateAssistant(first.id, { enabled: false, teamSelectable: false })
    expect(disabled.enabled).toBe(false)
    expect(disabled.teamSelectable).toBe(false)

    const moved = await service.updateAssistant(first.id, { sortOrder: 2 })
    expect(moved.sortOrder).toBe(2)
    expect(service.listAssistants().items.map(assistant => assistant.id)).toEqual([second.id, first.id])

    const generated = await service.createAssistant(assistantInput(), 'generated')
    expect(generated.source).toBe('generated')
    await store.putAssistant({ ...first, id: 'builtin-assistant', name: 'Builtin assistant', source: 'builtin' })
    await expect(service.deleteAssistant('builtin-assistant')).rejects.toMatchObject({
      code: 'ASSISTANT_BUILTIN_READONLY',
    })
  })

  it('stores and clears assistant avatars, and snapshots them into members', async () => {
    const { service } = createHarness()
    const avatar = 'data:image/png;base64,AAAA'
    const assistant = await service.createAssistant({ ...assistantInput(), avatar })
    expect(assistant.avatar).toBe(avatar)

    const draft = await service.createTeamDraft({
      name: 'Avatar team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    expect(Object.values(draft.members)[0]?.assistantSnapshot.avatar).toBe(avatar)

    const cleared = await service.updateAssistant(assistant.id, { avatar: '' })
    expect(cleared.avatar).toBeUndefined()
  })

  it('normalizes recommended prompts and carries them into member snapshots', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      name: 'Prompted',
      prompts: ['  Help me plan  ', 'Help me plan', '', 'Run the tests'],
    })
    expect(assistant.prompts).toEqual(['Help me plan', 'Run the tests'])

    const draft = await service.createTeamDraft({
      name: 'Prompted team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const leader = Object.values(draft.members)[0]
    expect(leader?.assistantSnapshot.prompts).toEqual(['Help me plan', 'Run the tests'])
  })

  it('delegates the built-in assistant builder conversation without storing it as a template', async () => {
    const { service, store } = createHarness()
    const conversation = {
      schemaVersion: 1 as const,
      sessionId: 'dsh-team-mode:assistant-builder',
      status: 'idle' as const,
      throughSeq: -1,
      nodes: [],
      pendingInteractions: [],
      configuration: {
        provider: 'test-provider',
        model: 'test-model',
        agentPresetId: 'standard',
        permissionPresetId: 'workspace-write',
      },
    }
    const draft = {
      schemaVersion: 1 as const,
      configuration: conversation.configuration,
    }
    const builder = {
      listConversations: vi.fn(async () => ({ items: [], total: 0 })),
      getDraft: vi.fn(async () => draft),
      configureDraft: vi.fn(async () => ({
        ...draft,
        configuration: {
          ...draft.configuration,
          provider: 'another-provider',
          model: 'another-model',
        },
      })),
      startConversation: vi.fn(async () => conversation),
      getConversation: vi.fn(async () => conversation),
      configure: vi.fn(async () => ({
        ...conversation,
        configuration: {
          ...conversation.configuration,
          provider: 'another-provider',
          model: 'another-model',
        },
      })),
      sendMessage: vi.fn(async () => ({ messageId: 'message-1' })),
      respondToInteraction: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      archiveConversation: vi.fn(async () => {}),
    }
    service.attachAssistantBuilderRuntime(builder as never)

    await expect(service.listAssistantBuilderConversations()).resolves.toEqual({ items: [], total: 0 })
    await expect(service.getAssistantBuilderDraft()).resolves.toEqual(draft)
    await expect(service.configureAssistantBuilderDraft('another-provider', 'another-model')).resolves.toMatchObject({
      configuration: { provider: 'another-provider', model: 'another-model' },
    })
    await expect(service.startAssistantBuilderConversation(
      'test-provider',
      'test-model',
      'Create a reviewer',
    )).resolves.toEqual(conversation)
    await expect(service.getAssistantBuilderConversation(conversation.sessionId)).resolves.toEqual(conversation)
    await expect(service.configureAssistantBuilder(conversation.sessionId, 'another-provider', 'another-model')).resolves.toMatchObject({
      configuration: { provider: 'another-provider', model: 'another-model' },
    })
    await expect(service.sendAssistantBuilderMessage(conversation.sessionId, 'Create a reviewer')).resolves.toEqual({ messageId: 'message-1' })
    await service.respondToAssistantBuilderInteraction(conversation.sessionId, 'question:1', {
      kind: 'question',
      answers: [{ id: 'name', selected: ['Reviewer'] }],
    })
    await service.stopAssistantBuilder(conversation.sessionId)
    await service.archiveAssistantBuilderConversation(conversation.sessionId)

    expect(builder.sendMessage).toHaveBeenCalledWith(conversation.sessionId, 'Create a reviewer')
    expect(builder.respondToInteraction).toHaveBeenCalledWith(
      conversation.sessionId,
      'question:1',
      { kind: 'question', answers: [{ id: 'name', selected: ['Reviewer'] }] },
    )
    expect(builder.startConversation).toHaveBeenCalledWith('test-provider', 'test-model', 'Create a reviewer')
    expect(builder.configureDraft).toHaveBeenCalledWith('another-provider', 'another-model')
    expect(builder.configure).toHaveBeenCalledWith(conversation.sessionId, 'another-provider', 'another-model')
    expect(builder.stop).toHaveBeenCalledWith(conversation.sessionId)
    expect(builder.archiveConversation).toHaveBeenCalledWith(conversation.sessionId)
    expect(store.listAssistants()).toHaveLength(0)
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_get_catalog')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_prepare')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_commit')
    expect(ASSISTANT_BUILDER_PROMPT).not.toContain('assistant_builder_create')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('必须等待新的用户消息')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('不要要求固定口令')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('明确表达同意')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('不要询问或限制普通工具')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('MCP Servers')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('优先调用 ask_user_question')
  })

  it('lists model- or user-invocable Skills with their invocation policy', async () => {
    const { service } = createHarness()

    await expect(service.skillCatalog('default')).resolves.toEqual({
      agentPresetId: 'default',
      skills: [{
        name: 'code-review',
        description: 'Review code changes.',
        source: 'user-agents',
        modelInvocable: true,
        userInvocable: true,
      }, {
        name: 'manual-only',
        description: 'Only users may invoke this.',
        source: 'user-agents',
        modelInvocable: false,
        userInvocable: true,
      }],
    })
  })

  it('groups MCP tools by Server for the chosen Agent Preset', async () => {
    const { service } = createHarness()

    await expect(service.mcpCatalog('default')).resolves.toEqual({
      agentPresetId: 'default',
      servers: [
        {
          name: 'figma',
          tools: [{ name: 'mcp__figma__inspect', description: 'Inspect a Figma node.' }],
        },
        {
          name: 'github',
          tools: [
            { name: 'mcp__github__create_issue', description: 'Create an issue.' },
            { name: 'mcp__github__list_issues', description: 'List issues.' },
          ],
        },
      ],
    })
  })

  it('localizes built-in permission preset names while preserving their ids', async () => {
    const { service } = createHarness()

    await expect(service.catalog()).resolves.toMatchObject({
      permissionPresets: [
        { value: 'standard', name: '标准' },
        { value: 'workspace-write', name: '工作区可写' },
      ],
    })
  })

  it('reads and validates exact-model reasoning efforts without hard-coded ids', async () => {
    const { service } = createHarness()

    await expect(service.modelCapabilities('openai', 'codex')).resolves.toEqual({
      provider: 'openai',
      model: 'codex',
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low', description: 'Faster reasoning.' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'low',
      },
    })

    const assistant = await service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'high',
    })
    const team = await service.createTeamDraft({
      name: 'Reasoning Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const member = team.members[team.leaderSlotId]!

    expect(assistant.reasoningEffort).toBe('high')
    expect(member.reasoningEffort).toBe('high')
    expect(member.assistantSnapshot.reasoningEffort).toBe('high')
    await expect(service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'invented',
    })).rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
  })

  it('changes a draft member reasoning effort without modifying the assistant default', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'low',
    })
    const team = await service.createTeamDraft({
      name: 'Reasoning Override Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const member = team.members[team.leaderSlotId]!

    const changed = await service.setMemberReasoningEffort(team.id, member.id, 'high')
    const restoredDefault = await service.setMemberReasoningEffort(changed.id, member.id, undefined)

    expect(changed.members[member.id]?.reasoningEffort).toBe('high')
    expect(restoredDefault.members[member.id]?.reasoningEffort).toBeUndefined()
    expect(service.getAssistant(assistant.id).reasoningEffort).toBe('low')
  })

  it('validates an assistant draft without storing it', async () => {
    const { service, store } = createHarness()

    await expect(service.validateAssistantDraft({
      ...assistantInput(),
      name: '  Codex Lead  ',
    })).resolves.toMatchObject({ name: 'Codex Lead' })

    expect(store.listAssistants()).toHaveLength(0)
  })

  it('creates a multi-member draft and dissolves only the team', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Compiler Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })

    expect(Object.values(team.members)).toHaveLength(2)
    expect(Object.values(team.members).map(member => member.displayName)).toEqual(['Codex Lead', 'Codex Lead'])
    expect(new Set(Object.values(team.members).map(member => member.sessionId)).size).toBe(2)
    expect(() => service.getAssistant(assistant.id)).not.toThrow()

    await expect(service.dissolveTeam(team.id, 'wrong')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await service.dissolveTeam(team.id, team.name)

    expect(store.getTeam(team.id)).toBeUndefined()
    expect(store.listMessages(team.id)).toHaveLength(0)
    expect(store.listActivities(team.id)).toHaveLength(0)
    expect(service.getAssistant(assistant.id).name).toBe('Codex Lead')
  })

  it('loads teams and tasks written before Goals existed', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Legacy team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await seedTask(store, team.id, 'task-legacy')

    // The store parses every record through the aggregate schema; a team that
    // never created a Goal must reload with no `goals` record at all.
    const persisted = store.getTeam(team.id)!
    const reloaded = teamAggregateSchema.parse(persisted)
    expect(persisted.goals).toBeUndefined()
    expect(reloaded.goals).toBeUndefined()
    expect(reloaded.schemaVersion).toBe(team.schemaVersion)
    expect(reloaded.tasks['task-legacy']?.goalId).toBeUndefined()
    expect(service.listGoals(team.id)).toEqual({ items: [], total: 0 })
  })

  it('creates, lists, updates and links Goals inside one team', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Goal team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const linkedTask = await seedTask(store, team.id, 'task-linked')
    const unlinkedTask = await seedTask(store, team.id, 'task-unlinked')

    const goal = await service.createGoal(team.id, {
      title: 'Ship Goal layer',
      objective: 'Group team tasks by objective',
      acceptance: 'npm run check passes',
    })
    expect(goal).toMatchObject({
      teamId: team.id,
      title: 'Ship Goal layer',
      acceptance: 'npm run check passes',
      mode: 'single',
      status: 'active',
    })
    expect(service.listGoals(team.id)).toEqual({ items: [goal], total: 1 })

    const updated = await service.updateGoal(team.id, goal.id, {
      mode: 'orchestrated',
      objective: 'Group tasks and drive their modes',
      status: 'completed',
    })
    expect(updated).toMatchObject({
      id: goal.id,
      title: 'Ship Goal layer',
      objective: 'Group tasks and drive their modes',
      mode: 'orchestrated',
      status: 'completed',
    })

    const linked = await service.linkTaskToGoal(team.id, linkedTask.id, goal.id)
    expect(linked.goalId).toBe(goal.id)
    expect(linked.revision).toBe(linkedTask.revision + 1)

    // Persisted aggregate, not just the returned record: this is what the team
    // page and the task tools read after a reload.
    const persisted = teamAggregateSchema.parse(store.getTeam(team.id))
    expect(persisted.goals?.[goal.id]).toMatchObject({ mode: 'orchestrated', status: 'completed' })
    expect(persisted.tasks[linkedTask.id]?.goalId).toBe(goal.id)
    expect(persisted.tasks[unlinkedTask.id]?.goalId).toBeUndefined()

    const unlinked = await service.linkTaskToGoal(team.id, linkedTask.id)
    expect(unlinked.goalId).toBeUndefined()
    expect(store.getTeam(team.id)!.tasks[linkedTask.id]).not.toHaveProperty('goalId')
    expect(teamTaskSchema.parse(store.getTeam(team.id)!.tasks[linkedTask.id]).goalId).toBeUndefined()
  })

  it('refuses to link a task to another team’s Goal', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const own = await service.createTeamDraft({
      name: 'Own team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const foreign = await service.createTeamDraft({
      name: 'Foreign team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const task = await seedTask(store, own.id, 'task-own')
    const ownGoal = await service.createGoal(own.id, { title: 'Own goal', objective: 'Own objective' })
    const foreignGoal = await service.createGoal(foreign.id, { title: 'Foreign goal', objective: 'Foreign objective' })

    await expect(service.linkTaskToGoal(own.id, task.id, foreignGoal.id)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(service.updateGoal(own.id, foreignGoal.id, { title: 'Stolen' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(store.getTeam(own.id)!.tasks[task.id]?.goalId).toBeUndefined()
    expect(store.getTeam(foreign.id)!.goals?.[foreignGoal.id]?.title).toBe('Foreign goal')

    await service.linkTaskToGoal(own.id, task.id, ownGoal.id)
    expect(store.getTeam(own.id)!.tasks[task.id]?.goalId).toBe(ownGoal.id)
  })

  it('lets the human user write team memory with a memory revision fence', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Memory team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })

    const created = await service.writeUserTeamMemory(
      team.id,
      { title: 'Fact', body: 'One', key: 'fact' },
      { expectedMemoryRevision: 0 },
    )
    expect(created.memoryRevision).toBe(1)
    expect(created.entry).toMatchObject({
      scope: 'team',
      visibility: 'team-safe',
      status: 'active',
      source: 'user',
      key: 'fact',
      title: 'Fact',
      body: 'One',
      revision: 1,
    })

    const edited = await service.writeUserTeamMemory(
      team.id,
      { id: created.entry.id, title: 'Fact v2', body: 'Two' },
      { expectedMemoryRevision: 1 },
    )
    expect(edited.memoryRevision).toBe(2)
    expect(edited.entry).toMatchObject({ id: created.entry.id, revision: 2, title: 'Fact v2' })
    expect(edited.entry.key).toBe('fact')

    const replacement = await service.writeUserTeamMemory(
      team.id,
      { title: 'New fact', body: 'Three', key: 'fact' },
      { expectedMemoryRevision: 2 },
    )
    expect(store.getTeam(team.id)!.memory!.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.entry.id, status: 'superseded' }),
      expect.objectContaining({ id: replacement.entry.id, status: 'active' }),
    ]))

    await expect(service.writeUserTeamMemory(
      team.id,
      { title: 'Stale', body: 'Stale' },
      { expectedMemoryRevision: 1 },
    )).rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' })
    expect(store.getTeam(team.id)!.memory?.entries).toHaveLength(2)
  })

  it('lets the user accept or reject a member team-memory proposal once', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Proposal team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const now = new Date().toISOString()
    const proposed: MemoryEntry = {
      id: 'proposal-1',
      scope: 'team',
      visibility: 'team-safe',
      status: 'proposed',
      source: 'member',
      authorSlotId: 'slot-1',
      title: 'Proposal',
      body: 'Pending fact',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await store.updateTeam(team.id, current => ({
      ...current,
      memory: { revision: 3, entries: [proposed], updatedAt: now },
    }))

    const accepted = await service.decideUserTeamMemory(team.id, proposed.id, 'accept', {
      expectedMemoryRevision: 3,
    })
    expect(accepted.memoryRevision).toBe(4)
    expect(accepted.entry).toMatchObject({ status: 'active', source: 'member', revision: 2 })

    await expect(service.decideUserTeamMemory(team.id, proposed.id, 'reject', {
      expectedMemoryRevision: 4,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(store.getTeam(team.id)!.memory?.entries[0]?.status).toBe('active')

    const second: MemoryEntry = { ...proposed, id: 'proposal-2', title: 'Second proposal' }
    await store.updateTeam(team.id, current => ({
      ...current,
      memory: {
        revision: 5,
        entries: [...current.memory!.entries, second],
        updatedAt: now,
      },
    }))
    const rejected = await service.decideUserTeamMemory(team.id, second.id, 'reject', {
      expectedMemoryRevision: 5,
    })
    expect(rejected.entry.status).toBe('archived')
    expect(rejected.memoryRevision).toBe(6)
  })

  it('clones team configuration into fresh members and sessions without runtime records', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'low',
      skillAllowlist: ['code-review'],
      mcpServers: ['github'],
    })
    const draft = await service.createTeamDraft({
      name: 'Source Team',
      workspaceId: 'workspace-1',
      directMemberChat: false,
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const memberId = Object.values(draft.members).find(member => member.role === 'member')!.id
    const configured = await service.setMemberPermissionPreset(draft.id, memberId, 'workspace-write')
    const source = await store.updateTeam(configured.id, team => ({
      ...team,
      tasks: {
        'task-1': {
          id: 'task-1',
          title: 'Existing work',
          description: 'Do not copy this task.',
          status: 'running',
          ownerSlotId: memberId,
          dependencyIds: [],
          fileScopes: [],
          revision: 1,
          createdAt: team.createdAt,
          updatedAt: team.updatedAt,
        },
      },
    }))
    await service.updateAssistant(assistant.id, { instructions: 'Updated after team creation.' })

    const clone = await service.cloneTeam(source.id, {
      name: 'Copied Team',
      workspaceId: 'workspace-1',
    })
    const sourceMembers = Object.values(source.members)
    const clonedMembers = Object.values(clone.members)

    expect(clone).toMatchObject({
      name: 'Copied Team',
      workspaceId: 'workspace-1',
      state: 'draft',
      directMemberChat: false,
      revision: 1,
      tasks: {},
      leases: {},
      outbox: {},
      retiredSessions: {},
    })
    expect(clone.id).not.toBe(source.id)
    expect(clonedMembers.map(member => member.displayName)).toEqual(sourceMembers.map(member => member.displayName))
    expect(clonedMembers.map(member => member.role)).toEqual(sourceMembers.map(member => member.role))
    expect(clonedMembers.map(member => member.permissionPresetId)).toEqual(sourceMembers.map(member => member.permissionPresetId))
    expect(clonedMembers.every(member => member.assistantSnapshot.instructions === 'Coordinate the team.')).toBe(true)
    expect(clonedMembers.every(member => member.assistantSnapshot.skillAllowlist[0] === 'code-review')).toBe(true)
    expect(clonedMembers.every(member => member.assistantSnapshot.mcpServers[0] === 'github')).toBe(true)
    expect(new Set(clonedMembers.map(member => member.id)).size).toBe(clonedMembers.length)
    expect(new Set(clonedMembers.map(member => member.sessionId)).size).toBe(clonedMembers.length)
    expect(clonedMembers.every(member => !sourceMembers.some(sourceMember => sourceMember.id === member.id))).toBe(true)
    expect(clonedMembers.every(member => !sourceMembers.some(sourceMember => sourceMember.sessionId === member.sessionId))).toBe(true)
    expect(clone.members[clone.leaderSlotId]?.role).toBe('leader')
    expect(service.getTeam(source.id).tasks['task-1']).toBeDefined()
  })

  it('rejects cloning into an unavailable Workspace', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const source = await service.createTeamDraft({
      name: 'Source Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })

    await expect(service.cloneTeam(source.id, {
      name: 'Copied Team',
      workspaceId: 'missing-workspace',
    })).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
  })

  it('rejects malformed Skill names before storing a template', async () => {
    const { service } = createHarness()
    await expect(service.createAssistant({
      ...assistantInput(),
      skillAllowlist: ['Not A Skill'],
    })).rejects.toMatchObject({ code: 'SKILL_REFERENCE_INVALID' })
  })

  it('rejects MCP Servers that are malformed or unavailable to the Agent Preset', async () => {
    const { service } = createHarness()

    await expect(service.createAssistant({
      ...assistantInput(),
      mcpServers: ['bad server'],
    })).rejects.toMatchObject({ code: 'MCP_REFERENCE_INVALID' })
    await expect(service.createAssistant({
      ...assistantInput(),
      mcpServers: ['missing'],
    })).rejects.toMatchObject({ code: 'MCP_REFERENCE_INVALID' })
  })

  it('persists selected MCP Servers into new team member snapshots', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      mcpServers: ['github', 'github'],
    })
    const team = await service.createTeamDraft({
      name: 'MCP Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })

    expect(assistant.mcpServers).toEqual(['github'])
    expect(Object.values(team.members)[0]?.assistantSnapshot.mcpServers).toEqual(['github'])
  })

  it('rejects the removed maxTokens field', async () => {
    const { service } = createHarness()
    await expect(service.createAssistant({
      ...assistantInput(),
      maxTokens: 4096,
    } as never)).rejects.toThrow()
  })

  it('dissolves a started team while preserving its assistant template', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Durable Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const agent = fakeAgent()
    runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(agent))

    await service.dissolveTeam(team.id, team.name)

    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(agent.whenIdle).toHaveBeenCalledOnce()
    expect(runtimeInternals(runtime).owned.size).toBe(0)
    expect(store.getTeam(draft.id)).toBeUndefined()
    expect(store.getAssistant(assistant.id)).toBeDefined()
  })

  it('keeps a failed started-team dissolution retryable', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Retryable Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const agent = fakeAgent()
    runtimeInternals(runtime).owned.set(member.sessionId, {
      teamId: team.id,
      slotId: member.id,
      handle: {
        agent,
        dispose: vi.fn(async () => { throw new Error('dispose failed') }),
      },
    })

    await expect(service.dissolveTeam(team.id, team.name)).rejects.toMatchObject({ code: 'TEAM_DELETE_FAILED' })

    expect(store.getTeam(team.id)?.state).toBe('delete_blocked')
    expect(store.getAssistant(assistant.id)).toBeDefined()
  })

  it('adds, promotes, and removes draft members without changing templates', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Mutable Draft',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const added = await service.addMember(draft.id, {
      assistantId: assistant.id,
    }, { expectedRevision: draft.revision })
    const second = Object.values(added.members).find(member => member.id !== draft.leaderSlotId)!
    const sessionsBefore = Object.fromEntries(
      Object.entries(added.members).map(([slotId, member]) => [slotId, member.sessionId]),
    )
    const promoted = await service.changeLeader(added.id, second.id, { expectedRevision: added.revision })
    // A draft never activated a Session, so the epoch bumps without archiving
    // anything and without rotating the pre-allocated session ids.
    expect(promoted.epoch).toBe(2)
    expect(promoted.revision).toBe(added.revision + 1)
    expect(promoted.leaderSlotId).toBe(second.id)
    expect(promoted.members[second.id]?.role).toBe('leader')
    expect(promoted.members[draft.leaderSlotId]?.role).toBe('member')
    expect(promoted.retiredSessions).toEqual({})
    for (const member of Object.values(promoted.members)) {
      expect(member.sessionId).toBe(sessionsBefore[member.id])
    }
    const original = promoted.members[draft.leaderSlotId]!
    const removed = await service.removeMember(promoted.id, original.id, { expectedRevision: promoted.revision })

    expect(Object.values(removed.members).map(member => member.displayName)).toEqual(['Codex Lead'])
    expect(removed.epoch).toBe(2)
    expect(service.getAssistant(assistant.id).revision).toBe(1)
  })

  it('stores a deployment tool policy id on members and rejects unknown ids', async () => {
    const toolPolicies = {
      readonly: { description: 'Read-only members', allow: ['team_members', 'team_mode_task_list'] },
      'empty-surface': { allow: [] },
    }
    const { service } = createHarness(undefined, { toolPolicies })
    const assistant = await service.createAssistant(assistantInput())

    const draft = await service.createTeamDraft({
      name: 'Policy Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader', toolPolicy: 'readonly' },
        { assistantId: assistant.id, role: 'member', toolPolicy: 'empty-surface' },
      ],
    })
    const members = Object.values(draft.members)
    const leader = members.find(member => member.role === 'leader')!
    const coder = members.find(member => member.role === 'member')!
    expect(leader.toolPolicy).toBe('readonly')
    expect(coder.toolPolicy).toBe('empty-surface')

    // Omitted policy keeps the field absent, not an empty default.
    const baseline = await service.createTeamDraft({
      name: 'Baseline Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    expect(Object.values(baseline.members)[0]?.toolPolicy).toBeUndefined()

    await expect(service.createTeamDraft({
      name: 'Unknown Policy Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member', toolPolicy: 'missing' },
      ],
    })).rejects.toMatchObject({ code: 'TOOL_POLICY_INVALID' })

    const added = await service.addMemberWithSlot(draft.id, {
      assistantId: assistant.id,
      toolPolicy: 'readonly',
    }, { expectedRevision: service.getTeam(draft.id).revision })
    expect(added.member.toolPolicy).toBe('readonly')

    await expect(service.addMember(draft.id, {
      assistantId: assistant.id,
      toolPolicy: 'missing',
    })).rejects.toMatchObject({ code: 'TOOL_POLICY_INVALID' })
  })

  it('accepts policy ids only and never raw allow or deny lists', () => {
    const base = {
      name: 'Policy Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: 'assistant-1', role: 'member' }],
    }
    expect(createTeamDraftInputSchema.safeParse(base).success).toBe(true)
    expect(createTeamDraftInputSchema.safeParse({
      ...base,
      members: [{ assistantId: 'assistant-1', role: 'member', toolPolicy: 'readonly' }],
    }).success).toBe(true)

    for (const raw of [
      { allow: ['team_members'] },
      { deny: ['team_members'] },
      ['team_members'],
    ]) {
      expect(createTeamDraftInputSchema.safeParse({
        ...base,
        members: [{ assistantId: 'assistant-1', role: 'member', toolPolicy: raw }],
      }).success, JSON.stringify(raw)).toBe(false)
    }
    // Raw lists next to the id are rejected too, not merged.
    expect(createTeamDraftInputSchema.safeParse({
      ...base,
      members: [{
        assistantId: 'assistant-1',
        role: 'member',
        toolPolicy: 'readonly',
        toolAllow: ['team_members'],
      }],
    }).success).toBe(false)
  })

  it('clones a member tool policy id but re-resolves it on activation', async () => {
    const toolPolicies = { readonly: { allow: ['team_members'] } }
    const { service } = createHarness(undefined, { toolPolicies })
    const assistant = await service.createAssistant(assistantInput())
    const source = await service.createTeamDraft({
      name: 'Source Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member', toolPolicy: 'readonly' },
      ],
    })
    const clone = await service.cloneTeam(source.id, {
      name: 'Cloned Team',
      workspaceId: 'workspace-1',
    })
    expect(Object.values(clone.members).find(member => member.role === 'member')?.toolPolicy)
      .toBe('readonly')
  })

  it('renames the team and refuses to reset the leader context', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Before Rename',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })

    const renamed = await service.renameTeam(draft.id, '  After Rename  ', { expectedRevision: draft.revision })
    expect(renamed.name).toBe('After Rename')
    expect(renamed.revision).toBe(draft.revision + 1)

    await expect(service.contextResetMember(renamed.id, renamed.leaderSlotId))
      .rejects.toMatchObject({ code: 'MEMBER_IS_LEADER' })
  })

  it('applies spawn display names and renames members without changing templates', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Named Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const added = await service.addMemberWithSlot(draft.id, {
      assistantId: assistant.id,
      displayName: 'Scout',
    })
    expect(added.member.displayName).toBe('Scout')

    const renamed = await service.renameMember(draft.id, added.member.id, 'Ranger')
    expect(renamed.members[added.member.id]?.displayName).toBe('Ranger')
    expect(service.getAssistant(assistant.id).name).toBe('Codex Lead')
  })

  it('notifies the leader after a new live member is ready', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Growing Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const leader = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const leaderAgent = fakeAgent()
    const ensureMemberOnline = vi.fn(async () => {})
    runtimeInternals(runtime).owned.set(leader.sessionId, fakeOwned(leaderAgent))
    runtimeInternals(runtime).ensureMemberOnline = ensureMemberOnline

    const added = await service.addMember(team.id, {
      assistantId: assistant.id,
    }, { expectedRevision: team.revision })
    const member = Object.values(added.members).find(value => value.id !== leader.id)!

    expect(ensureMemberOnline).toHaveBeenCalledOnce()
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(leaderAgent.followup.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: 'team-message', plugin: 'dsh-team-mode' },
      content: [{ type: 'text', text: expect.stringContaining(member.id) }],
    })
    expect(Object.keys(added.outbox)).toHaveLength(0)
    expect(service.listMessages(team.id).items).toContainEqual(expect.objectContaining({
      sender: { kind: 'system', id: 'dsh-team-mode' },
      recipient: { kind: 'leader', slotId: leader.id },
      type: 'system',
      deliveryState: 'delivered',
    }))
  })

  it('recovers a persisted active team after a plugin restart', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Recovered Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const active = await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const internals = runtimeInternals(runtime)
    const ensureMembersOnline = vi.fn(async () => {})
    internals.ensureMembersOnline = ensureMembersOnline
    internals.materializedSessions = vi.fn(async () => new Set<string>())
    internals.messages.recover = vi.fn(async () => {})

    await runtime.recoverTeams()

    expect(ensureMembersOnline).toHaveBeenCalledOnce()
    const recovered = service.getTeam(active.id)
    expect(recovered.state).toBe('active')
    expect(store.listActivities(active.id).some(activity => activity.kind === 'team.recovered')).toBe(true)
  })

  it('classifies 429 errors as rate limits', () => {
    expect(isRateLimitMessage('429 Too Many Requests')).toBe(true)
    expect(isRateLimitMessage('rate-limit exceeded')).toBe(true)
    expect(isRateLimitMessage('quota exceeded for this model')).toBe(true)
    expect(isRateLimitMessage('tool execution failed')).toBe(false)
  })

  it('cancels a stuck member and leaves a leader testament', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Watchdog Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const member = Object.values(draft.members).find(value => value.id !== draft.leaderSlotId)!
    const leader = draft.members[draft.leaderSlotId]!
    const active = await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const internals = runtimeInternals(runtime)
    const stuck = { ...fakeAgent(), status: 'running' as const }
    const leaderAgent = fakeAgent()
    internals.owned.set(member.sessionId, {
      ...(fakeOwned(stuck) as object),
      teamId: active.id,
      slotId: member.id,
    } as never)
    internals.owned.set(leader.sessionId, {
      ...(fakeOwned(leaderAgent) as object),
      teamId: active.id,
      slotId: leader.id,
    } as never)

    await internals.handleWatchdogTimeout(active.id, member.id, member.sessionId)

    expect(stuck.cancel).toHaveBeenCalledOnce()
    const team = service.getTeam(active.id)
    expect(team.members[member.id]?.lastRuntimeState).toBe('error')
    expect(team.members[member.id]?.lastError).toContain('WATCHDOG')
    const notice = service.listMessages(active.id).items.find(message =>
      message.sender.kind === 'system' && message.content.includes('运行超时'))
    expect(notice).toBeDefined()
  })

  it('records a rate-limit turn failure with a testament', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Rate Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const member = Object.values(draft.members).find(value => value.id !== draft.leaderSlotId)!
    const leader = draft.members[draft.leaderSlotId]!
    const active = await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const internals = runtimeInternals(runtime)
    const leaderAgent = fakeAgent()
    internals.owned.set(leader.sessionId, {
      ...(fakeOwned(leaderAgent) as object),
      teamId: active.id,
      slotId: leader.id,
    } as never)

    await internals.recordTurnFailure(active.id, member.id, '429 Too Many Requests')

    const team = service.getTeam(active.id)
    expect(team.members[member.id]?.lastRuntimeState).toBe('error')
    expect(team.members[member.id]?.lastError).toContain('RATE_LIMITED')
    expect(service.listMessages(active.id).items.some(message =>
      message.content.includes('速率限制'))).toBe(true)
  })

  it('uses native session-<uuid> identities for member sessions', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Native Sessions',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    for (const member of Object.values(draft.members)) {
      expect(member.sessionId).toMatch(/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    }
  })

  it('pins, reorders and archives a draft team', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Ordered Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const member = Object.values(draft.members).find(value => value.id !== draft.leaderSlotId)!

    const pinned = await service.setTeamPinned(draft.id, true, { expectedRevision: draft.revision })
    expect(pinned.pinned).toBe(true)
    const reordered = await service.reorderMembers(draft.id, [member.id], {
      expectedRevision: pinned.revision,
    })
    expect(reordered.memberOrder).toEqual([draft.leaderSlotId, member.id])
    const archived = await service.setTeamArchived(draft.id, true, {
      expectedRevision: reordered.revision,
    })
    expect(archived.archivedAt).toBeDefined()
    await expect(service.setTeamArchived(draft.id, true, {
      expectedRevision: archived.revision,
    })).resolves.toBeDefined()
  })

  it('delegates member context reset and reconnect to the runtime', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Member Ops',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const member = Object.values(draft.members).find(value => value.id !== draft.leaderSlotId)!
    const active = await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const internals = runtimeInternals(runtime)
    internals.clearMemberContext = vi.fn(async () => ({ sessionId: 'fresh-session', status: 'idle' }))
    internals.reconnectMember = vi.fn(async () => service.getTeam(active.id))

    const reset = await service.contextResetMember(active.id, member.id, {
      expectedRevision: active.revision,
    })
    expect(reset.sessionId).toBe('fresh-session')
    expect(internals.clearMemberContext).toHaveBeenCalledWith(active.id, member.id)

    const reconnected = await service.reconnectMember(active.id, member.id, {
      expectedRevision: reset.team.revision,
    })
    expect(reconnected.id).toBe(active.id)
    expect(internals.reconnectMember).toHaveBeenCalledWith(active.id, member.id)
  })

  it('makes the team usable when the leader is ready and records teammate failures', async () => {
    const { ctx, service } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Partial Warmup',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const member = Object.values(draft.members).find(value => value.id !== draft.leaderSlotId)!
    const runtime = new TeamRuntime(ctx, config, service)
    const internals = runtimeInternals(runtime)
    internals.ensureWorkspaceReady = vi.fn(async () => {})
    internals.materializedSessions = vi.fn(async () => new Set<string>())
    internals.ensureMemberOnline = vi.fn(async (_team, target) => {
      if (target.id !== draft.leaderSlotId) throw new Error('teammate failed')
    })

    const started = await runtime.startTeam(draft.id)
    expect(started.state).toBe('active')
    expect(started.warmup?.phase).toBe('leader-ready')

    await vi.waitFor(() => {
      const team = service.getTeam(draft.id)
      expect(team.warmup?.phase).toBe('ready')
      expect(team.warmup?.failedSlotIds).toContain(member.id)
      expect(team.members[member.id]?.lastError).toContain('teammate failed')
    })
  })

  it('records a per-member warmup failure and exposes it for retry', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Warmup Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const member = Object.values(draft.members).find(value => value.id !== draft.leaderSlotId)!
    const active = await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      warmup: { phase: 'starting', startedAt: new Date().toISOString() },
      members: {
        ...team.members,
        [member.id]: {
          ...team.members[member.id]!,
          lastRuntimeState: 'error',
          lastError: 'previous failure',
        },
      },
    }))
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).ensureMemberOnline = vi.fn(async () => {
      throw new Error('spawn failed')
    })

    const result = await runtime.retryWarmup(active.id, member.id)

    expect(result.members[member.id]).toMatchObject({
      lastRuntimeState: 'error',
      lastError: 'spawn failed',
    })
    expect(result.warmup?.failedSlotIds).toContain(member.id)
  })

  it('atomically queues an assigned task and wakes its owner', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Dispatch Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = runtimeInternals(new TeamRuntime(ctx, config, service))
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    runtime.owned.set(team.members[team.leaderSlotId]!.sessionId, fakeOwned(leaderAgent))
    runtime.owned.set(member.sessionId, fakeOwned(memberAgent))

    const created = await runtime.commands.createTask(team.id, team.leaderSlotId, {
      title: 'Implement parser',
      description: 'Add the parser implementation.',
      ownerSlotId: member.id,
      fileScopes: ['src/parser.ts'],
    })

    expect(created).toMatchObject({ status: 'assigned', deliveryState: 'delivered' })
    expect(memberAgent.followup).toHaveBeenCalledOnce()
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(0)
    const assignment = service.listMessages(team.id).items[0]!
    expect(assignment).toMatchObject({
      deliveryState: 'delivered',
      recipient: { kind: 'member', slotId: member.id },
      relatedTaskId: created.taskId,
    })

    const updated = await runtime.commands.updateTask(team.id, member.id, {
      taskId: created.taskId,
      status: 'completed',
      result: 'Parser implemented and tested.',
      // Members now fence on the task's current attempt token.
      attemptId: created.attemptId!,
    })

    expect(updated.deliveryState).toBe('delivered')
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(leaderAgent.followup.mock.calls[0]?.[0]).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining(`slotId=${member.id}`) }],
    })
    expect(service.listMessages(team.id).items[1]).toMatchObject({
      type: 'result',
      recipient: { kind: 'leader', slotId: team.leaderSlotId },
      relatedTaskId: created.taskId,
    })
  })

  it('keeps failed assignment delivery in the durable outbox and recovers it', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Recovery Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = runtimeInternals(new TeamRuntime(ctx, config, service))
    const memberAgent = fakeAgent()
    memberAgent.followup.mockImplementationOnce(() => { throw new Error('temporary inbox failure') })
    runtime.owned.set(member.sessionId, fakeOwned(memberAgent))

    const created = await runtime.commands.createTask(team.id, team.leaderSlotId, {
      title: 'Recoverable assignment',
      ownerSlotId: member.id,
    })

    expect(created.deliveryState).toBe('queued')
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(1)
    expect(service.listMessages(team.id).items[0]?.deliveryState).toBe('failed')

    memberAgent.followup.mockImplementation(message => {
      memberAgent.session.events.push({
        type: 'agent/inbox/spliced',
        data: { inserted: [message] },
      })
    })
    await runtime.messages.recover(service.getTeam(team.id))

    expect(memberAgent.followup).toHaveBeenCalledTimes(2)
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(0)
    expect(service.listMessages(team.id).items[0]?.deliveryState).toBe('delivered')
  })

  it('stops the active member, clears pending inbox work, and waits for idle', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Stop Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      members: Object.fromEntries(Object.entries(team.members).map(([id, member]) => [
        id,
        { ...member, lastRuntimeState: 'running' },
      ])),
    }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = runtimeInternals(new TeamRuntime(ctx, config, service))
    const agent = fakeAgent()
    agent.status = 'running'
    agent.whenIdle.mockImplementation(async () => { agent.status = 'idle' })
    runtime.owned.set(member.sessionId, fakeOwned(agent))

    await runtime.stopMember(team.id, member.id)

    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(agent.whenIdle).toHaveBeenCalledOnce()
    expect(service.getTeam(team.id).members[member.id]?.lastRuntimeState).toBe('idle')
  })

  it('reliably notifies the leader after removing a live member', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Roster Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const leader = team.members[team.leaderSlotId]!
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    runtimeInternals(runtime).owned.set(leader.sessionId, fakeOwned(leaderAgent))
    runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(memberAgent))

    const removed = await service.removeMember(team.id, member.id, { expectedRevision: team.revision })

    expect(removed.members[member.id]).toBeUndefined()
    expect(removed.retiredSessions[member.sessionId]).toMatchObject({ displayName: member.displayName })
    expect(memberAgent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(leaderAgent.followup.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      source: { kind: 'team-message', plugin: 'dsh-team-mode' },
      content: [{ type: 'text', text: expect.stringContaining(member.id) }],
    })
    expect(Object.keys(removed.outbox)).toHaveLength(0)
    expect(service.listMessages(team.id).items).toContainEqual(expect.objectContaining({
      sender: { kind: 'system', id: 'dsh-team-mode' },
      recipient: { kind: 'leader', slotId: leader.id },
      type: 'system',
      deliveryState: 'delivered',
    }))
  })

  it('changes a live member permission without modifying the assistant default', async () => {
    const { ctx, service, store, permissionSet } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Permission Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(fakeAgent()))

    const changed = await service.setMemberPermissionPreset(team.id, member.id, 'workspace-write')

    expect(permissionSet).toHaveBeenCalledWith(expect.anything(), 'workspace-write')
    expect(changed.members[member.id]?.permissionPresetId).toBe('workspace-write')
    expect(changed.members[member.id]?.assistantSnapshot.permissionPresetId).toBe('standard')
    expect(service.getAssistant(assistant.id).permissionPresetId).toBe('standard')
  })

  it('clears every task and rotates every member onto a fresh Session', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Fresh Context Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const taskId = 'task-1'
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      tasks: {
        [taskId]: {
          id: taskId,
          title: 'Old work',
          description: 'Must not survive the reset.',
          status: 'running',
          ownerSlotId: Object.values(team.members).find(member => member.role === 'member')?.id,
          dependencyIds: [],
          fileScopes: ['src/old.ts'],
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    }))
    const before = service.getTeam(draft.id)
    const oldSessionIds = Object.values(before.members).map(member => member.sessionId)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const ensureMembersOnline = vi.fn(async () => {})
    runtimeInternals(runtime).ensureMembersOnline = ensureMembersOnline
    for (const member of Object.values(before.members)) {
      runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(fakeAgent()))
    }

    await expect(service.resetTeam(before.id, 'wrong')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const reset = await service.resetTeam(before.id, before.name)

    expect(reset.state).toBe('active')
    expect(Object.keys(reset.tasks)).toHaveLength(0)
    expect(Object.keys(reset.leases)).toHaveLength(0)
    expect(Object.keys(reset.outbox)).toHaveLength(0)
    const newSessionIds = Object.values(reset.members).map(member => member.sessionId)
    expect(newSessionIds).toHaveLength(oldSessionIds.length)
    expect(newSessionIds.every(id => !oldSessionIds.includes(id))).toBe(true)
    expect(oldSessionIds.every(id => reset.retiredSessions[id] !== undefined)).toBe(true)
    expect(runtimeInternals(runtime).owned.size).toBe(0)
    expect(ensureMembersOnline).toHaveBeenCalledOnce()
  })

  it('archives every old Session and opens a new epoch on an active Leader change', async () => {
    const { ctx, service, store, workspace } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Epoch Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const leader = draft.members[draft.leaderSlotId]!
    const successor = Object.values(draft.members).find(member => member.id !== leader.id)!
    const now = '2026-01-01T00:00:00.000Z'
    const task = (id: string, overrides: Partial<TeamTask> = {}): TeamTask => ({
      id,
      title: id,
      description: '',
      status: 'pending',
      dependencyIds: [],
      fileScopes: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    const goal = (id: string, status: TeamGoal['status']): TeamGoal => ({
      id,
      teamId: draft.id,
      title: id,
      objective: id,
      acceptance: '',
      mode: 'single',
      status,
      createdAt: now,
      updatedAt: now,
    })
    const active = await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      tasks: {
        assigned: task('assigned', {
          status: 'assigned',
          ownerSlotId: leader.id,
          attemptId: 'attempt-1',
          dependencyIds: ['pending'],
          goalId: 'goal-active',
        }),
        running: task('running', { status: 'running', ownerSlotId: successor.id, attemptId: 'attempt-2' }),
        blocked: task('blocked', { status: 'blocked', ownerSlotId: leader.id, attemptId: 'attempt-3' }),
        pending: task('pending'),
        completed: task('completed', { status: 'completed' }),
        failed: task('failed', { status: 'failed' }),
        cancelled: task('cancelled', { status: 'cancelled' }),
      },
      goals: {
        'goal-active': goal('goal-active', 'active'),
        'goal-completed': goal('goal-completed', 'completed'),
      },
    }))
    await service.putRuntimeMessage({
      schemaVersion: 1,
      id: 'queued-mail',
      teamId: active.id,
      sender: { kind: 'user', id: 'local-user' },
      recipient: { kind: 'leader', slotId: leader.id },
      type: 'instruction',
      content: 'Old-epoch instruction',
      attachments: [],
      readBy: [],
      deliveryState: 'queued',
      idempotencyKey: 'queued-mail',
      createdAt: now,
    })
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const internals = runtimeInternals(runtime)
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    const leaderHandle = { agent: leaderAgent, dispose: vi.fn(async () => {}) }
    const memberHandle = { agent: memberAgent, dispose: vi.fn(async () => {}) }
    internals.owned.set(leader.sessionId, {
      teamId: active.id,
      slotId: leader.id,
      sessionId: leader.sessionId,
      epoch: 1,
      handle: leaderHandle,
      modelSelection: { current: undefined, assembled: undefined },
    })
    internals.owned.set(successor.sessionId, {
      teamId: active.id,
      slotId: successor.id,
      sessionId: successor.sessionId,
      epoch: 1,
      handle: memberHandle,
      modelSelection: { current: undefined, assembled: undefined },
    })
    const ensureMemberOnline = vi.fn(async (
      _team: TeamAggregate,
      _member: TeamAggregate['members'][string],
      _persisted: boolean,
    ) => {})
    internals.ensureMemberOnline = ensureMemberOnline
    internals.warmupRemaining = vi.fn(async () => {})
    internals.messages.recover = vi.fn(async () => {})
    const detachSession = vi.spyOn(workspace, 'detachSession')

    const changed = await service.changeLeader(active.id, successor.id, {
      expectedRevision: active.revision,
    })

    // Archive: the old Leader and every member are cancelled, flushed, disposed,
    // and detached before the epoch write; nothing is reparented.
    expect(leaderAgent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(memberAgent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(leaderAgent.whenIdle).toHaveBeenCalledOnce()
    expect(memberAgent.whenIdle).toHaveBeenCalledOnce()
    expect(leaderHandle.dispose).toHaveBeenCalledOnce()
    expect(memberHandle.dispose).toHaveBeenCalledOnce()
    expect(internals.owned.size).toBe(0)
    expect(detachSession).toHaveBeenCalledTimes(2)

    const stored = service.getTeam(active.id)
    expect(stored.epoch).toBe(2)
    expect(stored.leaderSlotId).toBe(successor.id)
    expect(stored.state).toBe('active')
    expect(stored.members[successor.id]?.role).toBe('leader')
    expect(stored.members[leader.id]?.role).toBe('member')
    expect(stored.memberOrder?.[0]).toBe(successor.id)
    expect(stored.members[leader.id]?.sessionId).not.toBe(leader.sessionId)
    expect(stored.members[successor.id]?.sessionId).not.toBe(successor.sessionId)
    expect(ensureMemberOnline).toHaveBeenCalledOnce()
    expect(ensureMemberOnline.mock.calls[0]?.[1]).toMatchObject({ id: successor.id })

    // Every old Session is a tombstone, and no tombstone is a current member.
    expect(stored.retiredSessions[leader.sessionId]).toMatchObject({
      formerSlotId: leader.id,
      displayName: leader.displayName,
    })
    expect(stored.retiredSessions[successor.sessionId]).toMatchObject({ formerSlotId: successor.id })
    for (const member of Object.values(stored.members)) {
      expect(stored.retiredSessions[member.sessionId]).toBeUndefined()
    }

    // Open work is paused explicitly: blocked, unowned, unfenced.
    expect(stored.tasks.assigned).toMatchObject({ status: 'blocked', revision: 2 })
    expect(stored.tasks.assigned).not.toHaveProperty('ownerSlotId')
    expect(stored.tasks.assigned).not.toHaveProperty('attemptId')
    expect(stored.tasks.assigned?.dependencyIds).toEqual(['pending'])
    expect(stored.tasks.running).toMatchObject({ status: 'blocked', revision: 2 })
    expect(stored.tasks.blocked).toMatchObject({ status: 'blocked', revision: 2 })
    expect(stored.tasks.pending).toMatchObject({ status: 'pending', revision: 1 })
    expect(stored.tasks.completed).toMatchObject({ status: 'completed' })
    expect(stored.tasks.failed).toMatchObject({ status: 'failed' })
    expect(stored.tasks.cancelled).toMatchObject({ status: 'cancelled' })
    expect(Object.keys(stored.tasks)).toHaveLength(7)

    // Active Goals pause; closed ones stay history and keep their task groups.
    expect(stored.goals?.['goal-active']?.status).toBe('paused')
    expect(stored.goals?.['goal-completed']?.status).toBe('completed')
    expect(stored.tasks.assigned?.goalId).toBe('goal-active')

    // Queued mail is retired; the outbox carries exactly the handoff notice.
    expect(service.listMessages(active.id).items.find(message => message.id === 'queued-mail')?.deliveryState)
      .toBe('failed')
    const notices = Object.values(stored.outbox)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      sender: { kind: 'system', id: 'dsh-team-mode' },
      recipient: { kind: 'leader', slotId: successor.id },
      type: 'system',
    })
    expect(notices[0]?.content).toContain('epoch 2')
    expect(notices[0]?.content).toContain('3 task(s) are blocked')
    expect(notices[0]?.content).toContain('1 Goal(s) paused')
    expect(notices[0]?.content).not.toContain('session-')
    expect(stored.revision).toBe(changed.revision)
    expect(store.listActivities(active.id).some(activity => activity.kind === 'team.epoch_changed')).toBe(true)
  })

  it('keeps the epoch bump and rotated Sessions when the new Leader cannot start', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Failed Epoch Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const leader = draft.members[draft.leaderSlotId]!
    const successor = Object.values(draft.members).find(member => member.id !== leader.id)!
    const active = await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const internals = runtimeInternals(runtime)
    const oldSessions = Object.values(active.members).map(member => member.sessionId)
    internals.owned.set(leader.sessionId, {
      teamId: active.id,
      slotId: leader.id,
      sessionId: leader.sessionId,
      epoch: 1,
      handle: { agent: fakeAgent(), dispose: vi.fn(async () => {}) },
      modelSelection: { current: undefined, assembled: undefined },
    })
    internals.ensureMemberOnline = vi.fn(async () => { throw new Error('activation failed') })

    await expect(service.changeLeader(active.id, successor.id, { expectedRevision: active.revision }))
      .rejects.toThrow('activation failed')

    const stored = service.getTeam(active.id)
    // Committed values survive: no rollback after the epoch write.
    expect(stored.epoch).toBe(2)
    expect(stored.state).toBe('error')
    expect(stored.leaderSlotId).toBe(successor.id)
    expect(oldSessions.every(sessionId => stored.retiredSessions[sessionId] !== undefined)).toBe(true)
    expect(Object.values(stored.members).every(member => !oldSessions.includes(member.sessionId))).toBe(true)
    expect(internals.owned.size).toBe(0)
  })

  it('rejects a write authored under a previous epoch inside the serialized update', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Fenced Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await seedTask(store, draft.id, 'task-fenced')
    await store.updateTeam(draft.id, team => ({ ...team, epoch: 2 }))
    const before = JSON.parse(JSON.stringify(store.getTeam(draft.id)))

    await expect(service.updateRuntimeTeam(
      draft.id,
      current => ({
        ...current,
        tasks: {
          ...current.tasks,
          'task-fenced': { ...current.tasks['task-fenced']!, status: 'completed' },
        },
      }),
      'team.task_updated',
      'stale epoch write',
      { expectedEpoch: 1 },
    )).rejects.toMatchObject({ code: 'EPOCH_STALE', details: { teamId: draft.id, epoch: 2, expectedEpoch: 1 } })
    expect(store.getTeam(draft.id)).toEqual(before)

    const accepted = await service.updateRuntimeTeam(
      draft.id,
      current => current,
      'team.current_epoch_write',
      'current epoch write',
      { expectedEpoch: 2 },
    )
    expect(accepted.revision).toBe(before.revision + 1)
  })

  it('writes structured assistant memory entries with a document revision fence', async () => {
    const { service, store } = createHarness()
    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Memory assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    const legacy: AssistantMemory = {
      schemaVersion: 1,
      assistantId: instance.id,
      content: 'Legacy note.',
      revision: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    // A row written before structured memory existed has no `entries` field and
    // must keep parsing unchanged.
    await store.putAssistantMemory(assistantMemorySchema.parse(legacy))
    expect(service.getAssistantMemoryEntries(instance.id)).toEqual([])

    const created = await service.writeAssistantMemoryEntry(
      instance.id,
      { title: 'Tone', body: 'Be terse.' },
      { expectedRevision: 3 },
    )
    expect(created.entry).toMatchObject({
      scope: 'assistant',
      visibility: 'private',
      status: 'active',
      source: 'assistant',
      title: 'Tone',
      body: 'Be terse.',
      revision: 1,
    })
    expect(created.entry.id).not.toBe('')
    expect(created.memory).toMatchObject({ content: 'Legacy note.', revision: 4 })

    const revised = await service.writeAssistantMemoryEntry(
      instance.id,
      { id: created.entry.id, title: 'Tone', body: 'Be terse.', visibility: 'team-safe' },
      { expectedRevision: 4 },
    )
    expect(revised.entry).toMatchObject({
      id: created.entry.id,
      visibility: 'team-safe',
      revision: 2,
    })
    expect(revised.memory).toMatchObject({ content: 'Legacy note.', revision: 5 })

    await expect(service.writeAssistantMemoryEntry(
      instance.id,
      { title: 'Stale', body: 'Should not land.' },
      { expectedRevision: 4 },
    )).rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' })
    expect(service.getAssistantMemoryEntries(instance.id)).toHaveLength(1)
    expect(service.getAssistantMemoryEntries(instance.id)[0]).toMatchObject({
      body: 'Be terse.',
      revision: 2,
    })

    // The legacy content path keeps structured entries untouched.
    const legacyWritten = await service.writeAssistantMemory(instance.id, 'Replaced note.', 'replace', {
      expectedRevision: 5,
    })
    expect(legacyWritten.content).toBe('Replaced note.')
    expect(service.getAssistantMemoryEntries(instance.id)).toHaveLength(1)
  })

  it('serializes concurrent first memory writes so exactly one is stored', async () => {
    const { service, store } = createHarness()
    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Race assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    // The durable store commits on its write chain, after the call returns. The
    // in-memory fake would otherwise land both puts synchronously and hide the
    // very window this regression test exists for.
    const commit = store.putAssistantMemory.bind(store)
    store.putAssistantMemory = async value => {
      await Promise.resolve()
      await commit(value)
    }

    const results = await Promise.allSettled([
      service.writeAssistantMemoryEntry(
        instance.id,
        { title: 'First', body: 'First writer.' },
        { expectedRevision: 0 },
      ),
      service.writeAssistantMemoryEntry(
        instance.id,
        { title: 'Second', body: 'Second writer.' },
        { expectedRevision: 0 },
      ),
    ])

    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'MEMORY_REVISION_CONFLICT',
    })
    const memory = service.getAssistantMemory(instance.id)
    expect(memory?.revision).toBe(1)
    expect(memory?.entries).toHaveLength(1)
  })

  it('rejects an unknown assistant memory entry id instead of creating it', async () => {
    const { service } = createHarness()
    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Unknown id assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    const created = await service.writeAssistantMemoryEntry(
      instance.id,
      { title: 'Real', body: 'Exists.' },
      { expectedRevision: 0 },
    )

    await expect(service.writeAssistantMemoryEntry(
      instance.id,
      { id: 'missing-entry', title: 'Ghost', body: 'Should not exist.' },
      { expectedRevision: created.memory.revision },
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const memory = service.getAssistantMemory(instance.id)
    expect(memory?.revision).toBe(1)
    expect(memory?.entries?.map(entry => entry.id)).toEqual([created.entry.id])
  })

  it('rejects entry writes on an archived instance without touching memory', async () => {
    const { service } = createHarness()
    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Archived assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    const created = await service.writeAssistantMemoryEntry(
      instance.id,
      { title: 'Keep', body: 'Frozen.' },
      { expectedRevision: 0 },
    )
    const before = JSON.parse(JSON.stringify(service.getAssistantMemory(instance.id)))
    await service.archiveAssistantInstance(instance.id)

    await expect(service.writeAssistantMemoryEntry(
      instance.id,
      { title: 'New', body: 'Rejected.' },
      { expectedRevision: created.memory.revision },
    )).rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    await expect(service.writeAssistantMemoryEntry(
      instance.id,
      { id: created.entry.id, title: 'Revise', body: 'Rejected.' },
      { expectedRevision: created.memory.revision },
    )).rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })

    expect(service.getAssistantMemory(instance.id)).toEqual(before)
  })

  it('frees assistant memory budget when entries are archived', async () => {
    const { service, store } = createHarness()
    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Budget assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    const stamp = '2026-01-01T00:00:00.000Z'
    const entry = (index: number, status: 'active' | 'archived', bodyLength: number) => ({
      id: `mem-${index}`,
      scope: 'assistant' as const,
      visibility: 'private' as const,
      status,
      source: 'assistant' as const,
      title: `Entry ${index}`,
      body: 'x'.repeat(bodyLength),
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    })

    // 100 archived entries fill neither cap (their bodies alone exceed 16k): a
    // new write still succeeds, proving history is excluded from both limits.
    await store.putAssistantMemory({
      schemaVersion: 1,
      assistantId: instance.id,
      content: '',
      entries: Array.from({ length: 100 }, (_, index) => entry(index, 'archived', 300)),
      revision: 7,
      updatedAt: stamp,
    })
    const created = await service.writeAssistantMemoryEntry(
      instance.id,
      { title: 'Fresh', body: 'Counts.' },
      { expectedRevision: 7 },
    )
    expect(created.memory.entries).toHaveLength(101)
    expect(created.memory.entries?.filter(value => value.status !== 'archived')).toHaveLength(1)

    // 100 live entries are the hard cap; the advice to archive is actionable.
    await store.putAssistantMemory({
      schemaVersion: 1,
      assistantId: instance.id,
      content: '',
      entries: Array.from({ length: 100 }, (_, index) => entry(index, 'active', 10)),
      revision: 8,
      updatedAt: stamp,
    })
    await expect(service.writeAssistantMemoryEntry(
      instance.id,
      { title: 'Over', body: 'Cap.' },
      { expectedRevision: 8 },
    )).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('archive unused entries first'),
    })
  })

  it('links a member to an explicit assistant instance and injects only its active team-safe memory', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Linked assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    await service.writeAssistantMemoryEntry(instance.id, {
      title: 'Shared style',
      body: 'SHARED-BODY',
      visibility: 'team-safe',
    })
    await service.writeAssistantMemoryEntry(instance.id, {
      title: 'Private note',
      body: 'PRIVATE-BODY',
    })
    await service.writeAssistantMemoryEntry(instance.id, {
      title: 'Withdrawn note',
      body: 'ARCHIVED-BODY',
      visibility: 'team-safe',
      status: 'archived',
    })
    await service.writeAssistantMemory(instance.id, 'LEGACY-BODY')

    const team = await service.createTeamDraft({
      name: 'Linked team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader', assistantInstanceId: instance.id },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const leader = team.members[team.leaderSlotId]!
    const teammate = Object.values(team.members).find(member => member.role === 'member')!

    expect(leader.assistantInstanceId).toBe(instance.id)
    // Nothing is inferred: the unlinked teammate has no link even though the
    // same template and workspace have one instance.
    expect(teammate.assistantInstanceId).toBeUndefined()
    expect(service.getTeam(team.id).members[leader.id]?.assistantInstanceId).toBe(instance.id)

    const linked = service.readMemberAssistantMemory(team.id, leader.id)
    expect(linked.state).toBe('linked')
    expect(linked.entries.map(entry => entry.body)).toEqual(['SHARED-BODY'])
    expect(service.readMemberAssistantMemory(team.id, teammate.id)).toEqual({
      state: 'unlinked',
      entries: [],
    })
  })

  it('validates a supplied assistant instance link and persists updates', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Linkable assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    const team = await service.createTeamDraft({
      name: 'Unlinked team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const slotId = team.leaderSlotId
    expect(team.members[slotId]?.assistantInstanceId).toBeUndefined()

    const linked = await service.setMemberAssistantInstance(team.id, slotId, instance.id)
    expect(linked.members[slotId]?.assistantInstanceId).toBe(instance.id)
    // Same value is a no-op and does not bump the team revision.
    expect(await service.setMemberAssistantInstance(team.id, slotId, instance.id)).toBe(linked)
    const cleared = await service.setMemberAssistantInstance(team.id, slotId, null)
    expect(cleared.members[slotId]?.assistantInstanceId).toBeUndefined()
    expect(cleared.revision).toBe(linked.revision + 1)
    expect(await service.setMemberAssistantInstance(team.id, slotId, null)).toBe(cleared)

    await expect(service.setMemberAssistantInstance(team.id, slotId, 'missing-instance'))
      .rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_NOT_FOUND' })

    // Same-workspace uniqueness: one member per instance, one team per instance.
    await service.setMemberAssistantInstance(team.id, slotId, instance.id)
    await expect(service.addMember(team.id, {
      assistantId: assistant.id,
      assistantInstanceId: instance.id,
    })).rejects.toMatchObject({ code: 'ASSISTANT_IN_USE' })
    await expect(service.createTeamDraft({
      name: 'Second team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader', assistantInstanceId: instance.id }],
    })).rejects.toMatchObject({ code: 'ASSISTANT_IN_USE' })

    // Archived instances cannot be linked, and a linked instance that is
    // archived later degrades to an empty read instead of throwing.
    await service.archiveAssistantInstance(instance.id)
    await expect(service.addMember(team.id, {
      assistantId: assistant.id,
      assistantInstanceId: instance.id,
    })).rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    expect(service.readMemberAssistantMemory(team.id, slotId)).toEqual({
      state: 'archived',
      entries: [],
    })

    // A workspace mismatch is rejected explicitly; no owner field exists in
    // this repository, so the workspace pair is the enforceable scope.
    const other = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Other workspace assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    await store.updateAssistantInstance(other.id, value => ({
      ...value,
      workspaceId: 'workspace-2',
      workspacePath: '/tmp/other-workspace',
    }))
    await expect(service.addMember(team.id, {
      assistantId: assistant.id,
      assistantInstanceId: other.id,
    })).rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_WORKSPACE_MISMATCH' })
  })

  it('persists member assistant instance links across create, add, and clear', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const leaderInstance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Leader assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    const addedInstance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Added assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    const team = await service.createTeamDraft({
      name: 'Link lifecycle',
      workspaceId: 'workspace-1',
      members: [{
        assistantId: assistant.id,
        role: 'leader',
        assistantInstanceId: leaderInstance.id,
      }],
    })
    const leaderSlotId = team.leaderSlotId
    expect(service.getTeam(team.id).members[leaderSlotId]?.assistantInstanceId)
      .toBe(leaderInstance.id)

    const added = await service.addMemberWithSlot(team.id, {
      assistantId: assistant.id,
      displayName: 'Second',
      assistantInstanceId: addedInstance.id,
    })
    expect(added.member.assistantInstanceId).toBe(addedInstance.id)
    expect(service.getTeam(team.id).members[added.member.id]?.assistantInstanceId)
      .toBe(addedInstance.id)

    const cleared = await service.setMemberAssistantInstance(team.id, leaderSlotId, null)
    expect(cleared.members[leaderSlotId]?.assistantInstanceId).toBeUndefined()
    expect(service.getTeam(team.id).members[leaderSlotId]?.assistantInstanceId).toBeUndefined()

    // The cleared instance becomes linkable again; the link is persisted.
    const relinked = await service.setMemberAssistantInstance(
      team.id,
      added.member.id,
      leaderInstance.id,
    )
    expect(relinked.members[added.member.id]?.assistantInstanceId).toBe(leaderInstance.id)
    expect(service.getTeam(team.id).members[added.member.id]?.assistantInstanceId)
      .toBe(leaderInstance.id)
  })

  it('re-checks the instance link inside the add-member atomic update', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Race assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    const team = await service.createTeamDraft({
      name: 'Race team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const other = await service.createTeamDraft({
      name: 'Other team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const otherSlotId = other.leaderSlotId
    const commitUpdate = store.updateTeam.bind(store)
    let raced = false
    store.updateTeam = async (teamId, update) => {
      if (!raced && teamId === team.id) {
        raced = true
        // Simulate a concurrent writer linking the instance to another team
        // after addMember's pre-check but before its atomic updater runs.
        const currentOther = service.getTeam(other.id)
        await store.putTeam({
          ...currentOther,
          members: {
            ...currentOther.members,
            [otherSlotId]: {
              ...currentOther.members[otherSlotId]!,
              assistantInstanceId: instance.id,
            },
          },
        })
      }
      return commitUpdate(teamId, update)
    }

    await expect(service.addMember(team.id, {
      assistantId: assistant.id,
      assistantInstanceId: instance.id,
    })).rejects.toMatchObject({ code: 'ASSISTANT_IN_USE' })
    // The rejected add left the aggregate untouched.
    expect(Object.keys(service.getTeam(team.id).members)).toHaveLength(1)
  })

  it('drops assistant instance links when a team is cloned', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const instance = await service.createAssistantInstance({
      workspaceId: 'workspace-1',
      name: 'Clone source assistant',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
    })
    const source = await service.createTeamDraft({
      name: 'Source team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader', assistantInstanceId: instance.id }],
    })
    expect(source.members[source.leaderSlotId]?.assistantInstanceId).toBe(instance.id)

    const clone = await service.cloneTeam(source.id, {
      name: 'Clone team',
      workspaceId: 'workspace-1',
    })
    expect(Object.values(clone.members).every(member => member.assistantInstanceId === undefined))
      .toBe(true)
  })

  it('serializes archive with worker creation so no worker starts after archive wins', async () => {
    const h = createArchiveHarness()
    await h.store.putAssistantInstance(seedInstance())
    // Bind the main Session up front: the race under test is worker creation,
    // not main-Session startup.
    await h.runtime.ensureInstance('instance-1')
    expect(h.created).toHaveLength(1)

    const archivedWrite = deferred()
    h.store.beforeInstanceWrite = async (_current, next) => {
      if (next.status === 'archived') await archivedWrite.promise
    }

    const archiving = h.service.archiveAssistantInstance('instance-1')
    await tick() // archive holds the assistant lock; its archived write is pending
    const creating = h.runtime.createTask('instance-1', { title: 'Race', brief: 'Work.' })
    await tick()
    await tick()

    // The queued create cannot create a worker while archive owns the lock.
    expect(h.created).toHaveLength(1)

    archivedWrite.resolve()
    const archived = await archiving
    expect(archived.status).toBe('archived')
    await expect(creating).rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    // The archived status won, and no worker row or handle survived.
    expect(h.store.getAssistantInstance('instance-1')?.status).toBe('archived')
    expect(h.store.listAssistantSessions()).toHaveLength(0)
    expect(h.created).toHaveLength(1)
  })

  it('does not let a queued main-Session bind resurrect an archived instance', async () => {
    const h = createArchiveHarness()
    await h.store.putAssistantInstance(seedInstance())

    const archivedWrite = deferred()
    h.store.beforeInstanceWrite = async (_current, next) => {
      if (next.status === 'archived') await archivedWrite.promise
    }

    const archiving = h.service.archiveAssistantInstance('instance-1')
    await tick() // archived write is queued and gated; the bind queues behind it
    const ensuring = h.runtime.ensureInstance('instance-1')
    await tick()
    await tick()

    archivedWrite.resolve()
    await archiving
    await expect(ensuring).rejects.toMatchObject({ code: 'ASSISTANT_INSTANCE_ARCHIVED' })
    // The stale bind threw instead of rewriting status back to 'active', and
    // the losing main-Session handle was disposed rather than leaked.
    const stored = h.store.getAssistantInstance('instance-1')
    expect(stored?.status).toBe('archived')
    expect(stored?.mainSessionId).toBeUndefined()
    expect(h.created[0]?.dispose).toHaveBeenCalledTimes(1)
  }, 15_000)
})

describe('Assistant checkpoint API', () => {
  it('creates a ready checkpoint from the live main Session and lists it', async () => {
    const h = createCheckpointHarness()
    await h.store.putAssistantInstance(seedInstanceWithMain())
    h.mainEvents.push(
      sessionUserEvent(0, 'user-1', 'Plan the handoff'),
      sessionAssistantEvent(1, 'assistant-1', 'Ready to hand off'),
    )
    await h.store.putAssistantSession(taskRow({ id: 'task-active', status: 'running', updatedAt: '2026-01-02T00:00:00.000Z' }))
    await h.store.putAssistantSession(taskRow({ id: 'task-done', status: 'completed', updatedAt: '2026-01-03T00:00:00.000Z' }))

    const checkpoint = await h.service.createAssistantCheckpoint('instance-1', '  next steps  ')

    expect(checkpoint).toMatchObject({
      schemaVersion: 1,
      assistantId: 'instance-1',
      sourceSessionId: 'session-main',
      note: 'next steps',
      status: 'ready',
      capturedThroughSeq: 1,
    })
    expect(checkpoint.facts.recentMessages).toEqual([
      { role: 'user', text: 'Plan the handoff' },
      { role: 'assistant', text: 'Ready to hand off' },
    ])
    expect(checkpoint.facts.activeTasks).toEqual([
      { id: 'task-active', title: 'Task task-active', status: 'running' },
    ])
    expect(checkpoint.facts.workspacePath).toBe('/tmp/dsh-team-mode-workspace')
    expect(h.store.getContextCheckpoint(checkpoint.id)).toEqual(checkpoint)
    expect(h.service.listAssistantCheckpoints('instance-1')).toEqual([checkpoint])
    expect(h.service.listAssistantCheckpoints('instance-1')[0]?.note).toBe('next steps')
  })

  it('lists only the requested assistant and rejects an unknown instance', async () => {
    const h = createCheckpointHarness()
    await h.store.putAssistantInstance(seedInstanceWithMain())
    await h.store.putAssistantInstance({ ...seedInstanceWithMain(), id: 'instance-2' })
    const first = await h.service.createContextCheckpoint({
      assistantId: 'instance-1',
      sourceSessionId: 'session-main',
      capturedThroughSeq: -1,
      facts: emptyFacts(),
      note: '',
    })
    const second = await h.service.createContextCheckpoint({
      assistantId: 'instance-2',
      sourceSessionId: 'session-other',
      capturedThroughSeq: 3,
      facts: emptyFacts(),
      note: '',
    })

    expect(h.service.listAssistantCheckpoints('instance-1').map(value => value.id)).toEqual([first.id])
    expect(h.service.listAssistantCheckpoints('instance-2').map(value => value.id)).toEqual([second.id])
    expect(() => h.service.listAssistantCheckpoints('missing')).toThrow(
      expect.objectContaining({ code: 'ASSISTANT_INSTANCE_NOT_FOUND' }) as never,
    )
  })

  it('rejects a note over 4000 chars before writing any checkpoint', async () => {
    const h = createCheckpointHarness()
    await h.store.putAssistantInstance(seedInstanceWithMain())

    await expect(h.service.createAssistantCheckpoint('instance-1', 'x'.repeat(4_001)))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(h.store.listContextCheckpoints()).toEqual([])
  })

  it('refuses to checkpoint an instance with no main Session yet', async () => {
    const h = createCheckpointHarness()
    await h.store.putAssistantInstance(seedInstance())

    await expect(h.service.createAssistantCheckpoint('instance-1'))
      .rejects.toMatchObject({
        code: 'ASSISTANT_SESSION_NOT_READY',
        message: expect.stringContaining('no main Session'),
      })
    expect(h.store.listContextCheckpoints()).toEqual([])
  })

  it('reads the durable Session log when no live Agent owns the main Session', async () => {
    const h = createCheckpointHarness({
      live: false,
      storedEvents: [
        sessionUserEvent(0, 'user-1', 'Stored question'),
        sessionAssistantEvent(5, 'assistant-1', 'Stored answer'),
      ],
    })
    await h.store.putAssistantInstance(seedInstanceWithMain())

    const checkpoint = await h.service.createAssistantCheckpoint('instance-1')

    expect(checkpoint.facts.recentMessages).toEqual([
      { role: 'user', text: 'Stored question' },
      { role: 'assistant', text: 'Stored answer' },
    ])
    expect(checkpoint.capturedThroughSeq).toBe(5)
  })

  it('serves create and list through the web transport', async () => {
    const h = createCheckpointHarness()
    await h.store.putAssistantInstance(seedInstanceWithMain())
    h.mainEvents.push(sessionUserEvent(0, 'user-1', 'Handoff me'))
    const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => unknown>()
    h.ctx.provide('webServer', {
      register(route: { path: string, handler: (request: IncomingMessage, response: ServerResponse) => unknown }) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    } as never)
    h.ctx.provide('connection', { requestRejection: () => undefined } as never)
    const transport = registerWebTransport(h.ctx, config, h.service)
    try {
      const created = await callApi(routes, {
        method: 'assistant.checkpoint.create',
        payload: { assistantId: 'instance-1', note: 'web note' },
      })
      expect(created.status).toBe(200)
      const createdBody = JSON.parse(created.body) as {
        ok: boolean
        value: ContextCheckpoint
      }
      expect(createdBody.ok).toBe(true)
      expect(createdBody.value).toMatchObject({
        assistantId: 'instance-1',
        note: 'web note',
        status: 'ready',
      })
      expect(createdBody.value.facts.recentMessages).toEqual([{ role: 'user', text: 'Handoff me' }])

      const listed = await callApi(routes, {
        method: 'assistant.checkpoint.list',
        payload: { assistantId: 'instance-1' },
      })
      expect(listed.status).toBe(200)
      const listedBody = JSON.parse(listed.body) as { ok: boolean, value: ContextCheckpoint[] }
      expect(listedBody.value.map(value => value.id)).toEqual([createdBody.value.id])
    } finally {
      transport.dispose()
    }
  })
})

function createHarness(
  workspacePath = '/tmp/dsh-team-mode-workspace',
  configOverrides: Partial<Config> = {},
): {
  ctx: Context
  service: AgentTeamService
  store: MemoryStore
  workspace: {
    id: string
    path: string
    status: () => Promise<'ok'>
    attachSession: () => Promise<void>
    detachSession: () => Promise<void>
  }
  permissionSet: ReturnType<typeof vi.fn>
} {
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
    listModels: async () => [{ id: 'codex', name: 'Codex' }],
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      model,
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low', description: 'Faster reasoning.' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'low',
      },
    }),
  } as never)
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'default', name: 'Default' }],
    resolve: async (id: string) => ({ id, name: id }),
    // 0.2.x leases the preset revision's scope for a cold catalog read; the
    // lease exposes `key` and releases through Symbol.asyncDispose.
    acquireScope: async () => ({
      key: { kind: 'preset-scope' },
      [Symbol.asyncDispose]: async () => {},
    }),
  } as never)
  ctx.provide('tools', {
    get: (name: string) => name === 'skill' ? { name: 'skill' } : undefined,
    schemas: () => [
      { name: 'skill', description: 'Load one Skill.' },
      { name: 'mcp__github__list_issues', description: 'List issues.' },
      { name: 'mcp__figma__inspect', description: 'Inspect a Figma node.' },
      { name: 'mcp__github__create_issue', description: 'Create an issue.' },
    ],
  } as never)
  ctx.provide('skills', {
    list: async () => [
      {
        name: 'code-review',
        description: 'Review code changes.',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'user-agents',
        provider: 'filesystem',
      },
      {
        name: 'manual-only',
        description: 'Only users may invoke this.',
        invocation: { modelInvocable: false, userInvocable: true },
        source: 'user-agents',
        provider: 'filesystem',
      },
    ],
  } as never)
  const permissionSet = vi.fn()
  ctx.provide('permissionPresets', {
    names: ['standard', 'workspace-write'],
    optionOf: (name: string) => ({ value: name, name }),
    set: permissionSet,
  } as never)
  ctx.provide('agents', {
    get: () => undefined,
  } as never)
  ctx.provide('sessions', {
    flush: async () => {},
  } as never)
  const workspace = {
    id: 'workspace-1',
    path: workspacePath,
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
    service: new AgentTeamService(ctx, { ...config, ...configOverrides }, store),
    store,
    workspace,
    permissionSet,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function seedInstance(): AssistantInstance {
  return {
    schemaVersion: 1,
    id: 'instance-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: 'Researcher',
      instructions: 'Cite sources.',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/dsh-team-mode-workspace',
    status: 'idle',
    pinned: false,
    revision: 1,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  }
}

interface ArchiveAgentRecord {
  agent: Agent
  handle: AgentHandle
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  whenIdle: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

/**
 * Real service and real Assistant runtime over the shared MemoryStore, used by
 * the archive barrier regressions. Agent handles are fakes: no Agent setup
 * runs, so only lifecycle calls (create/resume, follow-up, cancel, dispose)
 * are observed.
 */
function createArchiveHarness(): {
  service: AgentTeamService
  store: MemoryStore
  runtime: AssistantRuntime
  created: ArchiveAgentRecord[]
} {
  const { service, store } = createHarness()
  const created: ArchiveAgentRecord[] = []
  const live = new Map<string, Agent>()

  const makeHandle = (sessionId: string): AgentHandle => {
    const session = {
      id: SessionId(sessionId),
      snapshotEvents: () => [],
    }
    const followup = vi.fn()
    const cancel = vi.fn()
    const whenIdle = vi.fn(async () => {})
    const dispose = vi.fn(async () => {})
    const agent = {
      id: SessionId(sessionId),
      session,
      status: 'idle',
      followup,
      cancel,
      whenIdle,
    } as unknown as Agent
    const handle: AgentHandle = { agent, dispose }
    created.push({ agent, handle, followup, cancel, whenIdle, dispose })
    return handle
  }

  const workspace = {
    id: 'workspace-1',
    path: '/tmp/dsh-team-mode-workspace',
    title: 'Workspace',
    status: async () => 'ok' as const,
    attachSession: async () => {},
  }
  const runtimeCtx = {
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    on: () => () => {},
    agents: {
      get: (id: SessionId) => live.get(String(id)),
      create: async (options: { sessionId: SessionId }) => makeHandle(String(options.sessionId)),
      resume: async (options: { resumeSessionId: SessionId }) => makeHandle(String(options.resumeSessionId)),
    },
    sessions: { flush: async () => {} },
    workspaceRegistry: {
      get: () => workspace,
      list: () => [workspace],
    },
    agentPresets: { mount: async () => {} },
    permissionPresets: { set: () => {} },
  }
  const runtime = new AssistantRuntime(runtimeCtx as never, config, service)
  service.attachAssistantRuntime(runtime)
  return { service, store, runtime, created }
}

interface FakeAgent {
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  whenIdle: ReturnType<typeof vi.fn>
  status: 'idle' | 'running'
  session: {
    events: Array<{ type: string; data: { inserted: unknown[] } }>
    snapshotEvents: () => Array<{ type: string; data: { inserted: unknown[] } }>
  }
}

interface RuntimeInternals {
  owned: Map<string, unknown>
  commands: TeamCommandHandler
  messages: TeamMessageDispatcher
  ensureMembersOnline: (team: TeamAggregate) => Promise<void>
  ensureMemberOnline: (team: TeamAggregate, member: TeamAggregate['members'][string], persisted: boolean) => Promise<void>
  ensureWorkspaceReady: (team: TeamAggregate) => Promise<void>
  warmupRemaining: (teamId: string) => Promise<void>
  materializedSessions: () => Promise<Set<string>>
  clearMemberContext(teamId: string, slotId: string): Promise<{ sessionId: string; status: string }>
  reconnectMember(teamId: string, slotId: string): Promise<TeamAggregate>
  handleWatchdogTimeout(teamId: string, slotId: string, sessionId: string): Promise<void>
  recordTurnFailure(teamId: string, slotId: string, message: string): Promise<void>
  stopMember(teamId: string, slotId: string): Promise<void>
}

function runtimeInternals(runtime: TeamRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function fakeAgent(): FakeAgent {
  const session: FakeAgent['session'] = {
    events: [],
    snapshotEvents: () => session.events,
  }
  return {
    session,
    status: 'idle',
    followup: vi.fn(message => {
      session.events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    }),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
}

function fakeOwned(agent: FakeAgent): unknown {
  return {
    teamId: 'test-team',
    slotId: 'test-slot',
    handle: { agent, dispose: vi.fn(async () => {}) },
    modelSelection: { current: undefined, assembled: undefined },
  }
}

function assistantInput() {
  return {
    name: 'Codex Lead',
    instructions: 'Coordinate the team.',
    provider: 'openai',
    model: 'codex',
    agentPresetId: 'default',
    permissionPresetId: 'standard',
    skillAllowlist: [],
    mcpServers: [],
  }
}


/**
 * Real service and real Assistant runtime over the shared MemoryStore, with a
 * fake live main Agent and an optional durable Session log.
 */
function createCheckpointHarness(options: {
  live?: boolean
  storedEvents?: SessionEvent[]
} = {}): {
  ctx: Context
  service: AgentTeamService
  store: MemoryStore
  runtime: AssistantRuntime
  mainEvents: SessionEvent[]
} {
  const { ctx, service, store } = createHarness()
  const mainEvents: SessionEvent[] = []
  const mainAgent = {
    id: SessionId('session-main'),
    session: {
      id: SessionId('session-main'),
      snapshotEvents: () => mainEvents,
    },
    status: 'idle',
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  } as unknown as Agent
  const workspace = {
    id: 'workspace-1',
    path: '/tmp/dsh-team-mode-workspace',
    title: 'Workspace',
    status: async () => 'ok' as const,
    attachSession: async () => {},
  }
  const runtimeCtx = {
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    on: () => () => {},
    agents: {
      get: (id: SessionId) => (
        options.live === false || String(id) !== 'session-main' ? undefined : mainAgent
      ),
      create: async () => { throw new Error('unexpected main Agent create') },
      resume: async () => { throw new Error('unexpected main Agent resume') },
    },
    sessions: { flush: async () => {} },
    sessionPersistence: {
      open: async () => ({
        read: async () => ({ events: options.storedEvents ?? [] }),
        close: async () => {},
      }),
    },
    workspaceRegistry: { get: () => workspace, list: () => [workspace] },
    agentPresets: { mount: async () => {} },
    permissionPresets: { set: () => {} },
  }
  const runtime = new AssistantRuntime(runtimeCtx as never, config, service)
  service.attachAssistantRuntime(runtime)
  return { ctx, service, store, runtime, mainEvents }
}

function seedInstanceWithMain(): AssistantInstance {
  return { ...seedInstance(), mainSessionId: 'session-main', status: 'active' }
}

function sessionEvent(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent
}

function sessionUserEvent(seq: number, id: string, text: string): SessionEvent {
  return sessionEvent(seq, 'user/message', {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

function sessionAssistantEvent(seq: number, id: string, text: string): SessionEvent {
  return sessionEvent(seq, 'assistant/message', {
    turn: seq + 1,
    step: 1,
    message: {
      id,
      role: 'assistant',
      source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
      content: [{ type: 'text', text }],
    },
    stream: [],
  })
}

function taskRow(input: {
  id: string
  status: AssistantSession['status']
  updatedAt: string
}): AssistantSession {
  return {
    schemaVersion: 1,
    id: input.id,
    assistantId: 'instance-1',
    sessionId: `session-${input.id}`,
    role: 'task',
    title: `Task ${input.id}`,
    brief: 'Do the thing',
    parentSessionId: 'session-main',
    status: input.status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: input.updatedAt,
  }
}

function emptyFacts(): CheckpointFacts {
  return {
    recentMessages: [],
    activeTasks: [],
    workspacePath: '/tmp/dsh-team-mode-workspace',
    note: '',
  }
}

function webResponse(): ServerResponse & { status: number, body: string } {
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
  return value as unknown as ServerResponse & { status: number, body: string }
}

async function callApi(
  routes: Map<string, (request: IncomingMessage, response: ServerResponse) => unknown>,
  body: { method: string, payload: unknown },
): Promise<{ status: number, body: string }> {
  const handler = routes.get(AGENT_TEAM_API_PATH)
  if (handler === undefined) throw new Error('api route not registered')
  const request = Object.assign(
    Readable.from([Buffer.from(JSON.stringify({ requestId: 'r1', ...body }))]),
    {
      method: 'POST',
      url: AGENT_TEAM_API_PATH,
      headers: { 'content-type': 'application/json' },
    },
  ) as unknown as IncomingMessage
  const response = webResponse()
  await handler(request, response)
  return response
}

class MemoryStore implements AgentTeamStore {
  private assistants = new Map<string, AssistantTemplate>()
  private assistantInstances = new Map<string, AssistantInstance>()
  private assistantSessions = new Map<string, AssistantSession>()
  private assistantMemory = new Map<string, AssistantMemory>()
  private contextCheckpoints = new Map<string, ContextCheckpoint>()
  private teams = new Map<string, TeamAggregate>()
  private messages = new Map<string, TeamMessage>()
  private activities = new Map<string, TeamActivity>()
  private operations = new Map<string, Operation>()
  /** Hook that models a slow durable write of one instance row. */
  beforeInstanceWrite: (
    (current: AssistantInstance, next: AssistantInstance) => Promise<void>
  ) | undefined
  /** FIFO instance writes, like the domain store's single write chain. */
  private instanceWrites: Promise<unknown> = Promise.resolve()

  getAssistant(id: string) { return this.assistants.get(id) }
  listAssistants() { return [...this.assistants.values()] }
  async putAssistant(value: AssistantTemplate) { this.assistants.set(value.id, value) }
  updateAssistant(id: string, update: (current: AssistantTemplate) => AssistantTemplate) {
    return updateMap(this.assistants, id, update)
  }
  async deleteAssistant(id: string) { return this.assistants.delete(id) }

  getAssistantInstance(id: string) { return this.assistantInstances.get(id) }
  listAssistantInstances() { return [...this.assistantInstances.values()] }
  async putAssistantInstance(value: AssistantInstance) { this.assistantInstances.set(value.id, value) }
  updateAssistantInstance(id: string, update: (current: AssistantInstance) => AssistantInstance) {
    // Serialize instance writes so an archive and a queued bind observe each
    // other exactly as they do through the domain store's write chain.
    const write = this.instanceWrites.then(async () => {
      const current = this.assistantInstances.get(id)
      if (current === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown record '${id}'`)
      const next = update(current)
      await this.beforeInstanceWrite?.(current, next)
      this.assistantInstances.set(id, next)
      return next
    })
    this.instanceWrites = write.then(() => undefined, () => undefined)
    return write
  }
  async deleteAssistantInstance(id: string) { return this.assistantInstances.delete(id) }

  getAssistantMemory(assistantId: string) { return this.assistantMemory.get(assistantId) }
  async putAssistantMemory(value: AssistantMemory) { this.assistantMemory.set(value.assistantId, value) }
  updateAssistantMemory(
    assistantId: string,
    update: (current: AssistantMemory) => AssistantMemory,
  ) {
    return updateMap(this.assistantMemory, assistantId, update)
  }

  getContextCheckpoint(id: string) { return this.contextCheckpoints.get(id) }
  listContextCheckpoints() {
    return [...this.contextCheckpoints.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  }
  async putContextCheckpoint(value: ContextCheckpoint) { this.contextCheckpoints.set(value.id, value) }
  updateContextCheckpoint(id: string, update: (current: ContextCheckpoint) => ContextCheckpoint) {
    return updateMap(this.contextCheckpoints, id, update)
  }

  getAssistantSession(id: string) { return this.assistantSessions.get(id) }
  listAssistantSessions() { return [...this.assistantSessions.values()] }
  async putAssistantSession(value: AssistantSession) { this.assistantSessions.set(value.id, value) }
  updateAssistantSession(id: string, update: (current: AssistantSession) => AssistantSession) {
    return updateMap(this.assistantSessions, id, update)
  }

  getTeam(id: string) { return this.teams.get(id) }
  listTeams() { return [...this.teams.values()] }
  async putTeam(value: TeamAggregate) { this.teams.set(value.id, value) }
  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate) {
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
  updateOperation(id: string, update: (current: Operation) => Operation) {
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

/** Seed a persisted task without going through the runtime command handler. */
async function seedTask(store: MemoryStore, teamId: string, id: string): Promise<TeamTask> {
  const team = store.getTeam(teamId)!
  const task: TeamTask = {
    id,
    title: id,
    description: '',
    status: 'pending',
    dependencyIds: [],
    fileScopes: [],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  await store.putTeam({ ...team, tasks: { ...team.tasks, [id]: task } })
  return task
}
