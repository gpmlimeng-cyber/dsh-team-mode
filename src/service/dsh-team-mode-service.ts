import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { isModelInvocable, isSkillName, isUserInvocable } from '@deepseek-ai/dsh-skill'
import type { Config } from '../config.js'
import { AgentTeamError } from '../domain/errors.js'
import { isMcpServerName, mcpServerFromToolName } from '../domain/mcp.js'
import {
  createAssistantInputSchema,
  addTeamMemberInputSchema,
  assistantMemoryModeSchema,
  cloneTeamInputSchema,
  createAssistantInstanceInputSchema,
  createAssistantSessionInputSchema,
  createTeamDraftInputSchema,
  updateAssistantInputSchema,
  updateAssistantInstanceInputSchema,
  updateAssistantSessionInputSchema,
} from '../domain/schemas.js'
import {
  snapshotAssistant,
  type AddTeamMemberInput,
  type AssistantInstance,
  type AssistantMemory,
  type AssistantMemoryMode,
  type AssistantPreview,
  type AssistantSession,
  type AssistantSnapshot,
  type AssistantTemplate,
  type CloneTeamInput,
  type CreateAssistantInput,
  type CreateAssistantInstanceInput,
  type CreateAssistantSessionInput,
  type CreateTeamDraftInput,
  type Operation,
  type Page,
  type TeamActivity,
  type TeamAggregate,
  type TeamMemberSlot,
  type TeamMessage,
  type UpdateAssistantInput,
  type UpdateAssistantInstanceInput,
  type UpdateAssistantSessionInput,
} from '../domain/types.js'
import type { AgentTeamStore } from '../storage/store.js'
import type { AssistantBuilderRuntime } from '../runtime/assistant-builder-runtime.js'
import type { AssistantEnsureResult, AssistantRuntime } from '../runtime/assistant-runtime.js'
import type { TeamRuntime } from '../runtime/team-runtime.js'
import { WorkspaceService } from './workspace-service.js'
import type {
  AssistantBuilderConversationView,
  AssistantBuilderConversationListView,
  AssistantBuilderDraftView,
  InteractionResponseInput,
  MemberConversationView,
  PendingInteractionView,
  TeamWorkbenchView,
  WorkspaceEntryView,
  WorkspaceGitStatusView,
  WorkspaceGitDiffView,
  WorkspaceUploadView,
} from '../transport/contracts.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshTeamMode: AgentTeamService
  }
}

export interface MutationOptions {
  expectedRevision?: number
}

/**
 * Durable memory is a single string per Assistant instance. Writes over the
 * budget are rejected instead of truncated: silently dropping durable context
 * is worse than an explicit retry with a shorter note.
 */
export const ASSISTANT_MEMORY_MAX_CHARS = 16_000

export interface WriteAssistantMemoryOptions {
  /** Expected memory revision; 0 means "no memory written yet". */
  expectedRevision?: number
}

export interface AgentTeamChange {
  cursor: number
  entityType: 'assistant' | 'assistant-instance' | 'assistant-session' | 'assistant-builder' | 'team' | 'operation' | 'conversation' | 'workspace' | 'catalog'
  entityId: string
  revision: number
  kind: string
  conversation?: MemberConversationView
  assistantBuilderConversation?: AssistantBuilderConversationView
}

export interface CatalogSnapshot {
  providers: ReturnType<Context['llm']['listProviders']>
  models: Record<string, Array<{ id: string; name: string; description?: string }>>
  agentPresets: Array<{ id: string; name: string; description?: string; broken?: string }>
  permissionPresets: Array<ReturnType<Context['permissionPresets']['optionOf']>>
  workspaces: Array<{
    id: string
    path: string
    title: string
    status: 'ok' | 'missing-dir'
  }>
}

export interface SkillCatalogSnapshot {
  agentPresetId: string
  skills: Array<{
    name: string
    description: string
    source: string
    modelInvocable: boolean
    userInvocable: boolean
  }>
}

export interface ModelCapabilitiesSnapshot {
  provider: string
  model: string
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
}

export interface McpCatalogSnapshot {
  agentPresetId: string
  servers: Array<{
    name: string
    tools: Array<{ name: string; description: string }>
  }>
}

const PERMISSION_PRESET_LABELS: Readonly<Record<string, string>> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
  standard: '标准',
}

export class AgentTeamService extends Service {
  private readonly listeners = new Set<(change: AgentTeamChange) => void>()
  private cursor = 0
  private runtime?: TeamRuntime
  private assistantBuilderRuntime?: AssistantBuilderRuntime
  private assistantRuntime?: AssistantRuntime
  private readonly workspace: WorkspaceService

  constructor(
    ctx: Context,
    readonly config: Config,
    private readonly store: AgentTeamStore,
  ) {
    super(ctx, 'dshTeamMode')
    this.workspace = new WorkspaceService(
      ctx,
      store,
      teamId => {
        const team = this.store.getTeam(teamId)
        if (team !== undefined) this.publish('workspace', teamId, team.revision, 'workspace.changed')
      },
      (teamId, error) => {
        this.ctx.logger.warn(`dsh-team-mode: Workspace watcher failed for team '${teamId}'`, error)
      },
    )
    ctx.on('llm/adapters-updated', () => {
      this.publish('catalog', 'models', 0, 'catalog.models_updated')
    })
  }

  subscribe(listener: (change: AgentTeamChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  attachRuntime(runtime: TeamRuntime): void {
    if (this.runtime !== undefined) throw new Error('Agent Team runtime is already attached')
    this.runtime = runtime
  }

  attachAssistantBuilderRuntime(runtime: AssistantBuilderRuntime): void {
    if (this.assistantBuilderRuntime !== undefined) throw new Error('Assistant Builder runtime is already attached')
    this.assistantBuilderRuntime = runtime
  }

  attachAssistantRuntime(runtime: AssistantRuntime): void {
    if (this.assistantRuntime !== undefined) throw new Error('Assistant runtime is already attached')
    this.assistantRuntime = runtime
  }

  startWorkspaceTracking(): void {
    this.workspace.startTracking()
  }

  disposeWorkspaceTracking(): Promise<void> {
    return this.workspace.dispose()
  }

  async catalog(): Promise<CatalogSnapshot> {
    const providers = this.ctx.llm.listProviders()
    const modelEntries = await Promise.all(providers.map(async provider => [
      provider.id,
      (await this.ctx.llm.listModels(provider.id)).map(model => ({
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      })),
    ] as const))
    const presets = await this.ctx.agentPresets.list()
    const workspaces = await Promise.all(this.ctx.workspaceRegistry.list().map(async workspace => ({
      id: String(workspace.id),
      path: workspace.path,
      title: workspace.title,
      status: await workspace.status(),
    })))
    return {
      providers,
      models: Object.fromEntries(modelEntries),
      agentPresets: presets.map(preset => ({
        id: preset.id,
        name: preset.name ?? preset.id,
        ...(preset.description === undefined ? {} : { description: preset.description }),
        ...(preset.broken === undefined ? {} : { broken: preset.broken }),
      })),
      permissionPresets: this.ctx.permissionPresets.names.map(name => {
        const option = this.ctx.permissionPresets.optionOf(name)
        return {
          ...option,
          name: PERMISSION_PRESET_LABELS[option.value] ?? option.name,
        }
      }),
      workspaces,
    }
  }

  async modelCapabilities(providerValue: string, modelValue: string): Promise<ModelCapabilitiesSnapshot> {
    const provider = providerValue.trim()
    const model = modelValue.trim()
    let info: Awaited<ReturnType<Context['llm']['resolveModelInfo']>>
    try {
      info = await this.ctx.llm.resolveModelInfo(provider, model)
    } catch (error) {
      throw new AgentTeamError(
        'MODEL_REFERENCE_INVALID',
        `Cannot resolve model '${provider}/${model}'`,
        undefined,
        { cause: error },
      )
    }
    return {
      provider,
      model,
      ...(info.reasoning === undefined
        ? {}
        : {
            reasoning: {
              efforts: info.reasoning.efforts.map(effort => ({
                id: String(effort.id),
                name: effort.name,
                ...(effort.description === undefined ? {} : { description: effort.description }),
              })),
              ...(info.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: String(info.reasoning.defaultEffort) }),
            },
          }),
    }
  }

  async skillCatalog(agentPresetId: string): Promise<SkillCatalogSnapshot> {
    try {
      await this.ctx.agentPresets.resolve(agentPresetId)
      // Lease the preset revision's scope for one cold catalog read; the lease
      // keeps the revision live and is released as soon as the read completes.
      const lease = await this.ctx.agentPresets.acquireScope(agentPresetId)
      try {
        const scope = lease.key
        if (this.ctx.tools.get('skill', scope) === undefined) {
          return { agentPresetId, skills: [] }
        }
        const skills = await this.ctx.skills.list({ scope })
        return {
          agentPresetId,
          skills: skills.filter(skill => isModelInvocable(skill) || isUserInvocable(skill)).map(skill => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
            modelInvocable: isModelInvocable(skill),
            userInvocable: isUserInvocable(skill),
          })),
        }
      } finally {
        await lease[Symbol.asyncDispose]()
      }
    } catch (error) {
      if (error instanceof AgentTeamError) throw error
      throw new AgentTeamError(
        'PRESET_REFERENCE_INVALID',
        `Cannot read Skills for agent preset '${agentPresetId}'`,
        undefined,
        { cause: error },
      )
    }
  }

  async mcpCatalog(agentPresetId: string): Promise<McpCatalogSnapshot> {
    try {
      await this.ctx.agentPresets.resolve(agentPresetId)
      const lease = await this.ctx.agentPresets.acquireScope(agentPresetId)
      try {
        const scope = lease.key
        const servers = new Map<string, Array<{ name: string; description: string }>>()
        for (const tool of this.ctx.tools.schemas(scope)) {
          const serverName = mcpServerFromToolName(tool.name)
          if (serverName === undefined) continue
          const entries = servers.get(serverName) ?? []
          entries.push({ name: tool.name, description: tool.description })
          servers.set(serverName, entries)
        }
        return {
          agentPresetId,
          servers: [...servers.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, tools]) => ({
            name,
            tools: tools.sort((left, right) => left.name.localeCompare(right.name)),
          })),
        }
      } finally {
        await lease[Symbol.asyncDispose]()
      }
    } catch (error) {
      if (error instanceof AgentTeamError) throw error
      throw new AgentTeamError(
        'PRESET_REFERENCE_INVALID',
        `Cannot read MCP Servers for agent preset '${agentPresetId}'`,
        undefined,
        { cause: error },
      )
    }
  }

  getAssistant(id: string): AssistantTemplate {
    return requireAssistant(this.store, id)
  }

  listAssistants(): Page<AssistantTemplate> {
    const items = this.store.listAssistants()
      .sort((left, right) => left.sortOrder - right.sortOrder
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
    return { items, total: items.length }
  }

  /** Append new templates after the current library order (AionUi drag ordering). */
  private nextAssistantSortOrder(): number {
    return this.store.listAssistants()
      .reduce((max, assistant) => Math.max(max, assistant.sortOrder), -1) + 1
  }

  async createAssistant(raw: CreateAssistantInput, source: AssistantTemplate['source'] = 'user'): Promise<AssistantTemplate> {
    const input = await this.validateAssistantDraft(raw)
    const now = new Date().toISOString()
    const assistant: AssistantTemplate = {
      schemaVersion: 1,
      id: randomUUID(),
      ...input,
      avatar: input.avatar?.trim() || undefined,
      enabled: input.enabled ?? true,
      teamSelectable: input.teamSelectable ?? true,
      sortOrder: this.nextAssistantSortOrder(),
      prompts: uniqueOrdered(input.prompts ?? []).slice(0, 12),
      source,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putAssistant(assistant)
    await this.activity('assistant.created', assistant.id, assistant.revision, `Assistant ${assistant.name} created`)
    this.publish('assistant', assistant.id, assistant.revision, 'assistant.created')
    return assistant
  }

  async validateAssistantDraft(raw: CreateAssistantInput): Promise<CreateAssistantInput> {
    const input = normalizeAssistantInput(createAssistantInputSchema.parse(raw))
    await this.validateAssistantReferences(input)
    return input
  }

  async updateAssistant(
    id: string,
    raw: UpdateAssistantInput,
    options: MutationOptions = {},
  ): Promise<AssistantTemplate> {
    const patch = updateAssistantInputSchema.parse(raw)
    const current = requireAssistant(this.store, id)
    assertRevision('assistant', current.revision, options.expectedRevision)
    const { sortOrder: patchedSortOrder, ...patchInput } = patch
    const candidate = normalizeAssistantInput(createAssistantInputSchema.parse({
      ...assistantInputOf(current),
      ...patchInput,
    }))
    await this.validateAssistantReferences(candidate)
    const next = await this.store.updateAssistant(id, value => ({
      ...value,
      ...candidate,
      enabled: candidate.enabled ?? value.enabled,
      teamSelectable: candidate.teamSelectable ?? value.teamSelectable,
      prompts: candidate.prompts ?? value.prompts,
      avatar: candidate.avatar === '' ? undefined : (candidate.avatar ?? value.avatar),
      ...(patchedSortOrder === undefined ? {} : { sortOrder: patchedSortOrder }),
      revision: value.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
    await this.activity('assistant.updated', next.id, next.revision, `Assistant ${next.name} updated`)
    this.publish('assistant', next.id, next.revision, 'assistant.updated')
    return next
  }

  async cloneAssistant(id: string, name?: string): Promise<AssistantTemplate> {
    const source = requireAssistant(this.store, id)
    return this.createAssistant({
      ...assistantInputOf(source),
      name: name?.trim() || `${source.name} Copy`,
    })
  }

  async deleteAssistant(id: string): Promise<void> {
    const assistant = requireAssistant(this.store, id)
    if (assistant.source === 'builtin') {
      throw new AgentTeamError('ASSISTANT_BUILTIN_READONLY', 'Built-in assistants cannot be deleted')
    }
    const references = this.store.listTeams()
      .filter(team => Object.values(team.members).some(member => member.assistantId === id))
      .map(team => ({ id: team.id, name: team.name }))
    if (references.length > 0) {
      throw new AgentTeamError(
        'ASSISTANT_IN_USE',
        `Assistant '${assistant.name}' is used by active team members`,
        { teams: references },
      )
    }
    await this.store.deleteAssistant(id)
    await this.activity('assistant.deleted', id, assistant.revision + 1, `Assistant ${assistant.name} deleted`)
    this.publish('assistant', id, assistant.revision + 1, 'assistant.deleted')
  }

  /**
   * Instances are returned unfiltered — archived rows stay in `items` — so the
   * Sidebar owns the presentation choice and an archive stays reversible
   * without a second read. Pinned rows sort first, then most recent activity.
   */
  listAssistantInstances(): Page<AssistantInstance> {
    const items = this.store.listAssistantInstances()
      .sort((left, right) => Number(right.pinned) - Number(left.pinned)
        || right.updatedAt.localeCompare(left.updatedAt)
        || left.id.localeCompare(right.id))
    return { items, total: items.length }
  }

  getAssistantInstance(id: string): AssistantInstance {
    return requireAssistantInstance(this.store, id)
  }
  /**
   * Sidebar view: the persisted instances plus a bounded latest-message
   * preview. A preview failure is presentation-only and never hides the row.
   */
  async listAssistantInstanceViews(): Promise<Page<AssistantInstance & { preview?: AssistantPreview }>> {
    const page = this.listAssistantInstances()
    if (this.assistantRuntime === undefined) return page
    const items = await Promise.all(page.items.map(async instance => {
      try {
        const preview = await this.assistantRuntime?.latestPreview(instance.id)
        return preview === undefined ? instance : { ...instance, preview }
      } catch {
        return instance
      }
    }))
    return { items, total: page.total }
  }


  /**
   * Persist a snapshot for a workspace; no Session is created here. A payload
   * with `templateId` uses the template as its base and applies any provided
   * fields as overrides. A payload without `templateId` is a direct Assistant:
   * it must carry a complete configuration, builds its own snapshot, and does
   * not reference any template row.
   */
  async createAssistantInstance(raw: CreateAssistantInstanceInput): Promise<AssistantInstance> {
    const input = createAssistantInstanceInputSchema.parse(raw)
    const id = randomUUID()
    let templateId: string | undefined
    let assistantSnapshot: AssistantSnapshot
    if (input.templateId === undefined) {
      assistantSnapshot = directAssistantSnapshot(id, input)
    } else {
      const assistant = requireAssistant(this.store, input.templateId)
      templateId = assistant.id
      assistantSnapshot = applyAssistantSnapshotOverrides(snapshotAssistant(assistant), input)
    }
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(input.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${input.workspaceId}' is unavailable`)
    }
    await this.validateAssistantInstanceSnapshot(assistantSnapshot)
    const now = new Date().toISOString()
    const instance: AssistantInstance = {
      schemaVersion: 1,
      id,
      ...(templateId === undefined ? {} : { templateId }),
      assistantSnapshot,
      workspaceId: String(workspace.id),
      workspacePath: workspace.path,
      status: 'idle',
      pinned: input.pinned ?? false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putAssistantInstance(instance)
    this.publish('assistant-instance', instance.id, instance.revision, 'assistant.instance.created')
    return instance
  }

  /**
   * Rewrite the instance-local display name/avatar, pin flag, and engine
   * settings on the stored snapshot. Model references and reasoning efforts are
   * validated exactly like assistant templates, and permission presets must
   * exist in the current catalog. The referenced template is untouched, and a
   * patch that changes nothing is a no-op rather than a revision bump.
   *
   * The snapshot only affects Sessions created or resumed after this call.
   * Already-live Sessions (the visible main Session in particular) keep their
   * current model until they are recreated/resumed; newly created workers and a
   * future main-Session resume read the updated snapshot.
   */
  async updateAssistantInstance(
    id: string,
    raw: UpdateAssistantInstanceInput,
  ): Promise<AssistantInstance> {
    const patch = updateAssistantInstanceInputSchema.parse(raw)
    const current = requireAssistantInstance(this.store, id)

    if ((patch.provider === undefined) !== (patch.model === undefined)) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        'Changing the Assistant model requires both provider and model',
      )
    }

    const permissionPresetId = patch.permissionPresetId?.trim()
    if (
      permissionPresetId !== undefined
      && !this.ctx.permissionPresets.names.includes(permissionPresetId)
    ) {
      throw new AgentTeamError(
        'PERMISSION_PRESET_INVALID',
        `Unknown permission preset '${permissionPresetId}'`,
      )
    }

    const provider = patch.provider?.trim() ?? current.assistantSnapshot.provider
    const model = patch.model?.trim() ?? current.assistantSnapshot.model
    const modelReferenceChanged = provider !== current.assistantSnapshot.provider
      || model !== current.assistantSnapshot.model
    let reasoningEffort = patch.reasoningEffort === undefined
      ? current.assistantSnapshot.reasoningEffort
      : patch.reasoningEffort.trim() || undefined

    if (modelReferenceChanged || patch.reasoningEffort !== undefined) {
      const capabilities = await this.modelCapabilities(provider, model)
      const supported = capabilities.reasoning?.efforts.some(effort => effort.id === reasoningEffort) ?? false
      if (
        modelReferenceChanged
        && patch.reasoningEffort === undefined
        && reasoningEffort !== undefined
        && !supported
      ) {
        // The inherited effort is not available on the new model. Fall back to
        // the model default instead of blocking an otherwise valid model change.
        reasoningEffort = undefined
      }
      await this.validateReasoningEffort(provider, model, reasoningEffort, capabilities)
    }

    const display = overrideAssistantSnapshot(current.assistantSnapshot, patch.name, patch.avatar)
    const {
      reasoningEffort: _previousReasoning,
      ...snapshotRest
    } = display
    const snapshot: AssistantSnapshot = {
      ...snapshotRest,
      provider,
      model,
      permissionPresetId: permissionPresetId ?? current.assistantSnapshot.permissionPresetId,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
    const pinned = patch.pinned ?? current.pinned
    const changed = snapshot.name !== current.assistantSnapshot.name
      || snapshot.avatar !== current.assistantSnapshot.avatar
      || snapshot.provider !== current.assistantSnapshot.provider
      || snapshot.model !== current.assistantSnapshot.model
      || snapshot.reasoningEffort !== current.assistantSnapshot.reasoningEffort
      || snapshot.permissionPresetId !== current.assistantSnapshot.permissionPresetId
      || pinned !== current.pinned
    if (!changed) return current
    const next = await this.store.updateAssistantInstance(id, value => ({
      ...value,
      assistantSnapshot: snapshot,
      pinned,
      revision: value.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.updated')
    return next
  }

  /**
   * Hide an instance from listings without deleting it or its main Session.
   * Idempotent: archiving an archived instance returns the stored record.
   * When the Assistant runtime is attached, active workers are cancelled and
   * disposed before the instance is marked archived.
   */
  async archiveAssistantInstance(id: string): Promise<AssistantInstance> {
    const current = requireAssistantInstance(this.store, id)
    if (current.status === 'archived') return current
    if (this.assistantRuntime !== undefined) {
      await this.assistantRuntime.stopForArchive(id)
    }
    const now = new Date().toISOString()
    const next = await this.store.updateAssistantInstance(id, value => ({
      ...value,
      status: 'archived',
      archivedAt: now,
      revision: value.revision + 1,
      updatedAt: now,
    }))
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.archived')
    return next
  }

  /**
   * Runtime-only hook: record the lazily created main Session. Re-binding the
   * same Session is a no-op so ensure/open can call it on every click.
   */
  async bindAssistantMainSession(id: string, sessionId: string): Promise<AssistantInstance> {
    const mainSessionId = sessionId.trim()
    if (mainSessionId === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Main Session id cannot be empty')
    }
    const current = requireAssistantInstance(this.store, id)
    if (current.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${id}' is archived`,
      )
    }
    if (current.mainSessionId === mainSessionId && current.status === 'active') return current
    const next = await this.store.updateAssistantInstance(id, value => ({
      ...value,
      mainSessionId,
      status: 'active',
      revision: value.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.bound')
    return next
  }

  /**
   * Read one Assistant instance's durable memory. A missing document returns
   * `undefined`; this is a plain store read so callers can render an empty
   * memory prompt without creating a row.
   */
  getAssistantMemory(assistantId: string): AssistantMemory | undefined {
    const id = assistantId.trim()
    if (id === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant instance id cannot be empty')
    }
    return this.store.getAssistantMemory(id)
  }

  /**
   * Replace or append durable memory. `append` joins with one newline and each
   * successful write bumps the memory revision. Content over
   * {@link ASSISTANT_MEMORY_MAX_CHARS} is rejected (not truncated) after the
   * combined value is computed, so an append can fail even when the new text
   * alone fits. Archived instances can be read but not written.
   */
  async writeAssistantMemory(
    assistantId: string,
    content: string,
    mode: AssistantMemoryMode = 'replace',
    options: WriteAssistantMemoryOptions = {},
  ): Promise<AssistantMemory> {
    const instance = requireAssistantInstance(this.store, assistantId)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${instance.id}' is archived`,
      )
    }
    const normalizedMode = assistantMemoryModeSchema.parse(mode)
    if (typeof content !== 'string') {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant memory content must be a string')
    }
    const current = this.store.getAssistantMemory(instance.id)
    if (
      options.expectedRevision !== undefined
      && options.expectedRevision !== (current?.revision ?? 0)
    ) {
      throw new AgentTeamError(
        'ASSISTANT_REVISION_CONFLICT',
        `Assistant memory revision conflict: expected ${options.expectedRevision}, current ${current?.revision ?? 0}`,
        { expected: options.expectedRevision, actual: current?.revision ?? 0 },
      )
    }
    const nextContent = normalizedMode === 'append'
      ? appendMemory(current?.content ?? '', content)
      : content
    if (nextContent.length > ASSISTANT_MEMORY_MAX_CHARS) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Assistant memory content exceeds ${ASSISTANT_MEMORY_MAX_CHARS} characters`,
        { length: nextContent.length, limit: ASSISTANT_MEMORY_MAX_CHARS },
      )
    }
    const now = new Date().toISOString()
    if (current === undefined) {
      const memory: AssistantMemory = {
        schemaVersion: 1,
        assistantId: instance.id,
        content: nextContent,
        revision: 1,
        updatedAt: now,
      }
      await this.store.putAssistantMemory(memory)
      return memory
    }
    return this.store.updateAssistantMemory(instance.id, value => ({
      ...value,
      content: nextContent,
      revision: value.revision + 1,
      updatedAt: now,
    }))
  }

  /** Materialize the instance's main Session through the attached runtime. */
  async ensureAssistantInstance(id: string): Promise<AssistantEnsureResult> {
    return this.requireAssistantRuntime().ensureInstance(id)
  }

  /** Reattach one task's worker Session and return the Session to navigate to. */
  async openAssistantTask(taskId: string): Promise<{ task: AssistantSession; sessionId: string }> {
    return this.requireAssistantRuntime().openTask(taskId)
  }

  /**
   * Persist one hidden worker Session created by the runtime. This table has no
   * revision counter (Phase 1 only needs lifecycle truth), so the change event
   * carries revision 0 and clients react by reloading their snapshot.
   */
  async createAssistantSession(raw: CreateAssistantSessionInput): Promise<AssistantSession> {
    const input = createAssistantSessionInputSchema.parse(raw)
    const instance = requireAssistantInstance(this.store, input.assistantId)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${instance.id}' is archived`,
      )
    }
    const now = new Date().toISOString()
    const session: AssistantSession = {
      schemaVersion: 1,
      id: randomUUID(),
      assistantId: instance.id,
      sessionId: input.sessionId,
      role: 'task',
      title: input.title,
      brief: input.brief,
      parentSessionId: input.parentSessionId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putAssistantSession(session)
    this.publish('assistant-session', session.id, 0, 'assistant.session.created')
    return session
  }

  /** Newest-first worker Sessions, optionally scoped to one assistant instance. */
  async listAssistantTaskInteractions(taskId: string): Promise<PendingInteractionView[]> {
    if (this.assistantRuntime === undefined) return []
    return this.assistantRuntime.taskInteractions(taskId)
  }

  async respondAssistantTaskInteraction(
    taskId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    if (this.assistantRuntime === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant runtime is not attached')
    }
    await this.assistantRuntime.respondTaskInteraction(taskId, interactionId, response)
  }

  /** Wake sidebar clients when a worker raises or settles an interaction. */
  notifyAssistantTaskChanged(taskId: string): void {
    if (this.store.getAssistantSession(taskId) === undefined) return
    this.publish('assistant-session', taskId, 0, 'assistant.task.interaction')
  }

  listAssistantSessions(assistantId?: string): Page<AssistantSession> {
    const items = this.store.listAssistantSessions()
      .filter(session => assistantId === undefined || session.assistantId === assistantId)
    return { items, total: items.length }
  }

  getAssistantSession(id: string): AssistantSession {
    return requireAssistantSession(this.store, id)
  }

  /** Apply a status/result patch; an empty patch leaves the record unchanged. */
  async updateAssistantSession(
    id: string,
    raw: UpdateAssistantSessionInput,
  ): Promise<AssistantSession> {
    const patch = updateAssistantSessionInputSchema.parse(raw)
    const current = requireAssistantSession(this.store, id)
    const next = {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.resultSummary === undefined ? {} : { resultSummary: patch.resultSummary }),
      ...(patch.error === undefined ? {} : { error: patch.error }),
      ...(patch.archivedAt === undefined ? {} : { archivedAt: patch.archivedAt }),
    }
    if (Object.keys(next).length === 0) return current
    return this.store.updateAssistantSession(id, value => ({
      ...value,
      ...next,
      updatedAt: new Date().toISOString(),
    }))
  }

  listAssistantBuilderConversations(): Promise<AssistantBuilderConversationListView> {
    return this.requireAssistantBuilderRuntime().listConversations()
  }

  getAssistantBuilderDraft(): Promise<AssistantBuilderDraftView> {
    return this.requireAssistantBuilderRuntime().getDraft()
  }

  configureAssistantBuilderDraft(provider: string, model: string): Promise<AssistantBuilderDraftView> {
    return this.requireAssistantBuilderRuntime().configureDraft(provider, model)
  }

  startAssistantBuilderConversation(
    provider: string,
    model: string,
    content: string,
  ): Promise<AssistantBuilderConversationView> {
    return this.requireAssistantBuilderRuntime().startConversation(provider, model, content)
  }

  getAssistantBuilderConversation(sessionId: string): Promise<AssistantBuilderConversationView> {
    return this.requireAssistantBuilderRuntime().getConversation(sessionId)
  }

  configureAssistantBuilder(
    sessionId: string,
    provider: string,
    model: string,
  ): Promise<AssistantBuilderConversationView> {
    return this.requireAssistantBuilderRuntime().configure(sessionId, provider, model)
  }

  sendAssistantBuilderMessage(sessionId: string, content: string): Promise<{ messageId: string }> {
    return this.requireAssistantBuilderRuntime().sendMessage(sessionId, content)
  }

  respondToAssistantBuilderInteraction(
    sessionId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    return this.requireAssistantBuilderRuntime().respondToInteraction(sessionId, interactionId, response)
  }

  stopAssistantBuilder(sessionId: string): Promise<void> {
    return this.requireAssistantBuilderRuntime().stop(sessionId)
  }

  archiveAssistantBuilderConversation(sessionId: string): Promise<void> {
    return this.requireAssistantBuilderRuntime().archiveConversation(sessionId)
  }

  getTeam(id: string): TeamAggregate {
    return requireTeam(this.store, id)
  }

  listTeams(): Page<TeamAggregate> {
    const items = this.store.listTeams()
    return { items, total: items.length }
  }

  async createTeamDraft(raw: CreateTeamDraftInput): Promise<TeamAggregate> {
    const input = createTeamDraftInputSchema.parse(raw)
    const leaders = input.members.filter(member => member.role === 'leader')
    if (leaders.length !== 1) {
      throw new AgentTeamError('TEAM_INVALID_LEADER', 'A team must contain exactly one leader')
    }
    const memberLimit = this.config.maxTeamMembers ?? 8
    if (input.members.length > memberLimit) {
      throw new AgentTeamError(
        'TEAM_LIMIT_REACHED',
        `A team may contain at most ${memberLimit} members`,
        { limit: memberLimit, requested: input.members.length },
      )
    }
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(input.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${input.workspaceId}' is unavailable`)
    }

    const now = new Date().toISOString()
    const members: Record<string, TeamMemberSlot> = {}
    let leaderSlotId = ''
    for (const item of input.members) {
      const assistant = requireAssistant(this.store, item.assistantId)
      const slotId = randomUUID()
      members[slotId] = {
        id: slotId,
        assistantId: assistant.id,
        displayName: assistant.name,
        role: item.role,
        assistantSnapshot: snapshotAssistant(assistant),
        permissionPresetId: assistant.permissionPresetId,
        ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
        sessionId: `session-${randomUUID()}`,
        desiredState: 'offline',
        lastRuntimeState: 'offline',
        joinedAt: now,
      }
      if (item.role === 'leader') leaderSlotId = slotId
    }

    const team: TeamAggregate = {
      schemaVersion: 2,
      id: randomUUID(),
      name: input.name.trim(),
      workspaceId: String(workspace.id),
      workspacePath: workspace.path,
      leaderSlotId,
      state: 'draft',
      directMemberChat: input.directMemberChat ?? this.config.directMemberChatDefault,
      pinned: false,
      memberOrder: [leaderSlotId, ...Object.keys(members).filter(id => id !== leaderSlotId)],
      members,
      retiredSessions: {},
      tasks: {},
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putTeam(team)
    this.workspace.watch(team.id, team.workspacePath)
    await this.activity('team.created', team.id, team.revision, `Team ${team.name} draft created`)
    this.publish('team', team.id, team.revision, 'team.created')
    return team
  }

  async cloneTeam(sourceTeamId: string, raw: CloneTeamInput): Promise<TeamAggregate> {
    const input = cloneTeamInputSchema.parse(raw)
    const source = requireTeam(this.store, sourceTeamId)
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(input.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${input.workspaceId}' is unavailable`)
    }

    const now = new Date().toISOString()
    const members: Record<string, TeamMemberSlot> = {}
    let leaderSlotId = ''
    for (const sourceMember of Object.values(source.members)) {
      const member = cloneMemberSlot(sourceMember, now)
      members[member.id] = member
      if (sourceMember.id === source.leaderSlotId) leaderSlotId = member.id
    }
    if (leaderSlotId === '') {
      throw new AgentTeamError('TEAM_INVALID_LEADER', 'Source team has no valid leader')
    }

    const team: TeamAggregate = {
      schemaVersion: 2,
      id: randomUUID(),
      name: input.name.trim(),
      workspaceId: String(workspace.id),
      workspacePath: workspace.path,
      leaderSlotId,
      state: 'draft',
      directMemberChat: source.directMemberChat,
      pinned: false,
      memberOrder: [leaderSlotId, ...Object.keys(members).filter(id => id !== leaderSlotId)],
      members,
      retiredSessions: {},
      tasks: {},
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putTeam(team)
    this.workspace.watch(team.id, team.workspacePath)
    await this.activity('team.cloned', team.id, team.revision, `Team ${team.name} cloned from ${source.name}`)
    this.publish('team', team.id, team.revision, 'team.cloned')
    return team
  }

  async changeLeader(
    teamId: string,
    successorSlotId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const current = requireTeam(this.store, teamId)
    assertTeamMutable(current)
    assertRevision('team', current.revision, options.expectedRevision)
    if (current.members[successorSlotId] === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${successorSlotId}'`)
    }
    if (current.leaderSlotId === successorSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'The selected member is already the team leader')
    }
    const next = await this.store.updateTeam(teamId, team => ({
      ...team,
      members: Object.fromEntries(Object.entries(team.members).map(([slotId, member]) => [
        slotId,
        { ...member, role: slotId === successorSlotId ? 'leader' : 'member' },
      ])),
      leaderSlotId: successorSlotId,
      memberOrder: [
        successorSlotId,
        ...(team.memberOrder ?? Object.keys(team.members)).filter(id => id !== successorSlotId),
      ],
      revision: team.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
    await this.activity('team.leader_changed', teamId, next.revision, 'Team leader changed')
    this.publish('team', teamId, next.revision, 'team.leader_changed')
    return next
  }

  async addMember(
    teamId: string,
    raw: AddTeamMemberInput,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    return (await this.addMemberWithSlot(teamId, raw, options)).team
  }

  /**
   * Add one member and return both the updated aggregate and the exact slot.
   * The tool surface uses the slot id to hand the caller a spawn receipt.
   */
  async addMemberWithSlot(
    teamId: string,
    raw: AddTeamMemberInput,
    options: MutationOptions = {},
  ): Promise<{ team: TeamAggregate; member: TeamMemberSlot }> {
    const input = addTeamMemberInputSchema.parse(raw)
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    if (team.state !== 'draft' && team.state !== 'active') {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot add a member while team is '${team.state}'`)
    }
    const memberLimit = this.config.maxTeamMembers ?? 8
    if (Object.keys(team.members).length >= memberLimit) {
      throw new AgentTeamError(
        'TEAM_LIMIT_REACHED',
        `Team '${team.name}' already has ${memberLimit} members`,
        { limit: memberLimit },
      )
    }
    const assistant = requireAssistant(this.store, input.assistantId)
    const displayName = normalizeMemberDisplayName(input.displayName ?? assistant.name)
    if (input.displayName !== undefined) assertMemberDisplayNameAvailable(team, displayName)
    const now = new Date().toISOString()
    const member = createMemberSlot(assistant, displayName, 'member', now, team.state === 'draft' ? 'offline' : 'online')
    const next = await this.store.updateTeam(teamId, current => ({
      ...current,
      members: { ...current.members, [member.id]: member },
      memberOrder: [...(current.memberOrder ?? Object.keys(current.members)), member.id],
      revision: current.revision + 1,
      updatedAt: now,
    }))
    await this.activity('team.member_added', teamId, next.revision, `Member ${displayName} added`)
    this.publish('team', teamId, next.revision, 'team.member_added')
    if (next.state !== 'draft') {
      const activated = await this.requireRuntime().activateMember(teamId, member.id)
      return { team: activated, member: activated.members[member.id] ?? member }
    }
    return { team: next, member }
  }

  /**
   * Rename a member's team-local display name without touching its assistant
   * template, session, or configuration snapshot.
   */
  async renameMember(
    teamId: string,
    slotId: string,
    rawDisplayName: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    const displayName = normalizeMemberDisplayName(rawDisplayName)
    if (member.displayName === displayName) return team
    assertMemberDisplayNameAvailable(team, displayName, slotId)
    const next = await this.store.updateTeam(teamId, current => ({
      ...current,
      members: Object.fromEntries(Object.entries(current.members).map(([id, currentMember]) => [
        id,
        id === slotId ? { ...currentMember, displayName } : currentMember,
      ])),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
    await this.activity('team.member_renamed', teamId, next.revision, `Member renamed to ${displayName}`)
    this.publish('team', teamId, next.revision, 'team.member_renamed')
    return next
  }

  /**
   * Rename the team itself. Members, sessions, workspace, and the task board
   * are untouched; only the team-local display name changes.
   */
  async renameTeam(
    teamId: string,
    rawName: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    const name = rawName.trim()
    if (name.length === 0 || name.length > 80) {
      throw new AgentTeamError('TEAM_NAME_INVALID', 'A team name must be 1-80 characters')
    }
    if (name === team.name) return team
    const next = await this.store.updateTeam(teamId, current => ({
      ...current,
      name,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
    await this.activity('team.renamed', teamId, next.revision, `Team renamed to ${name}`)
    this.publish('team', teamId, next.revision, 'team.renamed')
    return next
  }

  async removeMember(
    teamId: string,
    slotId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (slotId === team.leaderSlotId) {
      throw new AgentTeamError('MEMBER_IS_LEADER', 'Choose a successor before removing the current leader')
    }
    assertMemberHasNoOpenTasks(team, slotId)
    if (team.state === 'draft') {
      const next = await this.store.updateTeam(teamId, current => {
        const members = { ...current.members }
        delete members[slotId]
        return {
          ...current,
          members,
          memberOrder: (current.memberOrder ?? Object.keys(current.members)).filter(id => id !== slotId),
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        }
      })
      await this.activity('team.member_removed', teamId, next.revision, `Member ${member.displayName} removed`)
      this.publish('team', teamId, next.revision, 'team.member_removed')
      return next
    }
    return this.requireRuntime().removeMember(teamId, slotId)
  }

  async startTeam(teamId: string, options: MutationOptions = {}): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    return this.requireRuntime().startTeam(teamId)
  }

  async retryWarmup(
    teamId: string,
    slotId?: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    return this.requireRuntime().retryWarmup(teamId, slotId)
  }

  async contextResetMember(
    teamId: string,
    slotId: string,
    options: MutationOptions = {},
  ): Promise<{ team: TeamAggregate; sessionId: string; status: string }> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (slotId === team.leaderSlotId) {
      throw new AgentTeamError(
        'MEMBER_IS_LEADER',
        'The leader cannot be reset; transfer leadership to another member first',
      )
    }
    const result = await this.requireRuntime().clearMemberContext(teamId, slotId)
    return { team: this.getTeam(teamId), ...result }
  }

  async reconnectMember(
    teamId: string,
    slotId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    return this.requireRuntime().reconnectMember(teamId, slotId)
  }

  async reorderMembers(
    teamId: string,
    order: readonly string[],
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    const known = Object.keys(team.members)
    const unique = [...new Set(order)]
    if (unique.some(id => !known.includes(id))) {
      throw new AgentTeamError('INVALID_REQUEST', 'Member order contains an unknown slot')
    }
    const leader = team.leaderSlotId
    const nextOrder = [
      leader,
      ...unique.filter(id => id !== leader),
      ...known.filter(id => id !== leader && !unique.includes(id)),
    ]
    return this.updateRuntimeTeam(
      teamId,
      current => ({ ...current, memberOrder: nextOrder }),
      'team.members_reordered',
      'Team member order changed',
    )
  }

  async setTeamPinned(
    teamId: string,
    pinned: boolean,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    return this.updateRuntimeTeam(
      teamId,
      current => ({ ...current, pinned }),
      'team.pinned',
      pinned ? 'Team pinned' : 'Team unpinned',
    )
  }

  async setTeamArchived(
    teamId: string,
    archived: boolean,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    if (archived && team.state !== 'draft') {
      // Archive is a list presentation action; a live team must be dissolved
      // first so its members cannot keep running invisibly.
      throw new AgentTeamError('TEAM_NOT_ACTIVE', 'Dissolve the running team before archiving it')
    }
    return this.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        ...(archived
          ? { archivedAt: new Date().toISOString() }
          : { archivedAt: undefined }),
      }),
      archived ? 'team.archived' : 'team.unarchived',
      archived ? 'Team archived' : 'Team unarchived',
    )
  }

  async resetTeam(
    teamId: string,
    confirmation: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    if (confirmation !== team.name) {
      throw new AgentTeamError('INVALID_REQUEST', 'Team name confirmation does not match')
    }
    return this.requireRuntime().resetTeam(teamId)
  }

  async sendUserMessage(
    teamId: string,
    content: string,
    targetSlotId?: string,
  ): Promise<TeamMessage> {
    return this.requireRuntime().sendUserMessage(teamId, content, targetSlotId)
  }

  getWorkbench(teamId: string): Promise<TeamWorkbenchView> {
    requireTeam(this.store, teamId)
    return this.requireRuntime().getWorkbench(teamId)
  }

  stopMember(teamId: string, slotId: string): Promise<void> {
    requireTeam(this.store, teamId)
    return this.requireRuntime().stopMember(teamId, slotId)
  }

  async respondToInteraction(
    teamId: string,
    slotId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    const team = requireTeam(this.store, teamId)
    if (team.members[slotId] === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    }
    await this.requireRuntime().respondToInteraction(teamId, slotId, interactionId, response)
  }

  async setMemberPermissionPreset(
    teamId: string,
    slotId: string,
    rawPermissionPresetId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const permissionPresetId = rawPermissionPresetId.trim()
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (!this.ctx.permissionPresets.names.includes(permissionPresetId)) {
      throw new AgentTeamError(
        'PERMISSION_PRESET_INVALID',
        `Unknown permission preset '${permissionPresetId}'`,
      )
    }
    if (member.permissionPresetId === permissionPresetId) return team
    if (team.state === 'draft') {
      const next = await this.store.updateTeam(teamId, current => ({
        ...current,
        members: Object.fromEntries(Object.entries(current.members).map(([id, currentMember]) => [
          id,
          id === slotId ? { ...currentMember, permissionPresetId } : currentMember,
        ])),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }))
      await this.activity(
        'team.member_permission_changed',
        teamId,
        next.revision,
        `Member ${member.displayName} permission changed to ${permissionPresetId}`,
      )
      this.publish('team', teamId, next.revision, 'team.member_permission_changed')
      return next
    }
    return this.requireRuntime().setMemberPermissionPreset(teamId, slotId, permissionPresetId)
  }

  async setMemberReasoningEffort(
    teamId: string,
    slotId: string,
    rawReasoningEffort: string | undefined,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const reasoningEffort = rawReasoningEffort?.trim() || undefined
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    await this.validateReasoningEffort(
      member.assistantSnapshot.provider,
      member.assistantSnapshot.model,
      reasoningEffort,
    )
    if (member.reasoningEffort === reasoningEffort) return team
    if (team.state === 'draft') {
      const next = await this.store.updateTeam(teamId, current => ({
        ...current,
        members: Object.fromEntries(Object.entries(current.members).map(([id, currentMember]) => [
          id,
          id === slotId ? withReasoningEffort(currentMember, reasoningEffort) : currentMember,
        ])),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }))
      await this.activity(
        'team.member_reasoning_changed',
        teamId,
        next.revision,
        `Member ${member.displayName} reasoning changed to ${reasoningEffort ?? 'model default'}`,
      )
      this.publish('team', teamId, next.revision, 'team.member_reasoning_changed')
      return next
    }
    return this.requireRuntime().setMemberReasoningEffort(teamId, slotId, reasoningEffort)
  }

  publishConversation(teamId: string, revision: number, conversation?: MemberConversationView): void {
    this.publish('conversation', teamId, revision, 'member.conversation', conversation)
  }

  publishAssistantBuilderConversation(conversation: AssistantBuilderConversationView): void {
    const change: AgentTeamChange = {
      cursor: ++this.cursor,
      entityType: 'assistant-builder',
      entityId: conversation.sessionId,
      revision: Math.max(0, conversation.throughSeq + 1),
      kind: 'assistant.builder.conversation',
      assistantBuilderConversation: conversation,
    }
    for (const listener of this.listeners) listener(change)
  }

  async listWorkspace(teamId: string, rawPath = ''): Promise<WorkspaceEntryView[]> {
    return this.workspace.list(teamId, rawPath)
  }

  async searchWorkspace(teamId: string, query = '', limit = 40): Promise<WorkspaceEntryView[]> {
    return this.workspace.search(teamId, query, limit)
  }

  async getWorkspaceChanges(teamId: string): Promise<WorkspaceGitStatusView> {
    return this.workspace.changes(teamId)
  }

  async getWorkspaceDiff(
    teamId: string,
    path: string,
    scope: 'staged' | 'unstaged',
    layout: 'unified' | 'split',
    theme: 'light' | 'dark',
  ): Promise<WorkspaceGitDiffView> {
    return this.workspace.diff(teamId, path, scope, layout, theme)
  }

  async uploadWorkspaceFile(
    teamId: string,
    rawName: string,
    data: Uint8Array,
  ): Promise<WorkspaceUploadView> {
    return this.workspace.upload(teamId, rawName, data)
  }

  listMessages(teamId: string): Page<TeamMessage> {
    requireTeam(this.store, teamId)
    const items = this.store.listMessages(teamId)
    return { items, total: items.length }
  }

  async updateRuntimeTeam(
    teamId: string,
    update: (team: TeamAggregate) => TeamAggregate,
    kind: string,
    summary: string,
  ): Promise<TeamAggregate> {
    const next = await this.store.updateTeam(teamId, current => {
      const candidate = update(current)
      return {
        ...candidate,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }
    })
    await this.activity(kind, teamId, next.revision, summary)
    this.publish('team', teamId, next.revision, kind)
    return next
  }

  async putRuntimeMessage(message: TeamMessage): Promise<void> {
    await this.store.putMessage(message)
    const team = requireTeam(this.store, message.teamId)
    this.publish('team', team.id, team.revision, 'team.message')
  }

  async retireQueuedMessages(teamId: string): Promise<void> {
    requireTeam(this.store, teamId)
    const queued = this.store.listMessages(teamId).filter(message => message.deliveryState === 'queued')
    await Promise.all(queued.map(message => this.store.putMessage({ ...message, deliveryState: 'failed' })))
  }

  async dissolveTeam(
    teamId: string,
    confirmation: string,
    options: MutationOptions = {},
  ): Promise<void> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    if (confirmation !== team.name) {
      throw new AgentTeamError('INVALID_REQUEST', 'Team name confirmation does not match')
    }
    if (team.state !== 'draft') return this.requireRuntime().dissolveTeam(teamId)
    await this.deleteTeamRecords(teamId)
  }

  async deleteTeamRecords(teamId: string): Promise<void> {
    const team = requireTeam(this.store, teamId)
    await Promise.all(this.store.listMessages(teamId).map(message => this.store.deleteMessage(message.id)))
    await Promise.all(this.store.listActivities(teamId).map(activity => this.store.deleteActivity(activity.id)))
    await this.store.deleteTeam(teamId)
    await this.workspace.unwatch(teamId)
    this.publish('team', teamId, team.revision + 1, 'team.deleted')
  }

  getOperation(id: string): Operation {
    const operation = this.store.getOperation(id)
    if (operation === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown operation '${id}'`)
    }
    return operation
  }

  /**
   * Validate the final instance snapshot exactly like an Assistant template
   * draft. Direct creation has no template row to lean on, so this is the only
   * place that checks the model/reasoning pair, agent preset, permission
   * preset, and Skill/MCP references before the instance is persisted.
   */
  private async validateAssistantInstanceSnapshot(snapshot: AssistantSnapshot): Promise<void> {
    const candidate: CreateAssistantInput = {
      name: snapshot.name,
      instructions: snapshot.instructions,
      provider: snapshot.provider,
      model: snapshot.model,
      ...(snapshot.reasoningEffort === undefined ? {} : { reasoningEffort: snapshot.reasoningEffort }),
      agentPresetId: snapshot.agentPresetId,
      permissionPresetId: snapshot.permissionPresetId,
      skillAllowlist: [...snapshot.skillAllowlist],
      mcpServers: [...snapshot.mcpServers],
      prompts: [...snapshot.prompts],
      ...(snapshot.avatar === undefined ? {} : { avatar: snapshot.avatar }),
    }
    await this.validateAssistantReferences(candidate)
  }

  private async validateAssistantReferences(input: CreateAssistantInput): Promise<void> {
    const invalidSkill = input.skillAllowlist.find(name => !isSkillName(name))
    if (invalidSkill !== undefined) {
      throw new AgentTeamError('SKILL_REFERENCE_INVALID', `Invalid Skill name '${invalidSkill}'`)
    }
    const invalidMcpServer = input.mcpServers.find(name => !isMcpServerName(name))
    if (invalidMcpServer !== undefined) {
      throw new AgentTeamError('MCP_REFERENCE_INVALID', `Invalid MCP Server name '${invalidMcpServer}'`)
    }
    await this.validateReasoningEffort(input.provider, input.model, input.reasoningEffort)
    try {
      await this.ctx.agentPresets.resolve(input.agentPresetId)
    } catch (error) {
      throw new AgentTeamError(
        'PRESET_REFERENCE_INVALID',
        `Unknown agent preset '${input.agentPresetId}'`,
        undefined,
        { cause: error },
      )
    }
    if (!this.ctx.permissionPresets.names.includes(input.permissionPresetId)) {
      throw new AgentTeamError(
        'PERMISSION_PRESET_INVALID',
        `Unknown permission preset '${input.permissionPresetId}'`,
      )
    }
    if (input.mcpServers.length > 0) {
      const catalog = await this.mcpCatalog(input.agentPresetId)
      const available = new Set(catalog.servers.map(server => server.name))
      const missing = input.mcpServers.filter(name => !available.has(name))
      if (missing.length > 0) {
        throw new AgentTeamError(
          'MCP_REFERENCE_INVALID',
          `Agent Preset '${input.agentPresetId}' cannot access MCP Server(s): ${missing.join(', ')}`,
          { missing },
        )
      }
    }
  }

  private async validateReasoningEffort(
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
    capabilities?: ModelCapabilitiesSnapshot,
  ): Promise<void> {
    const resolved = capabilities ?? await this.modelCapabilities(provider, model)
    if (reasoningEffort === undefined) return
    const supported = resolved.reasoning?.efforts.some(effort => effort.id === reasoningEffort) ?? false
    if (!supported) {
      throw new AgentTeamError(
        'MODEL_REFERENCE_INVALID',
        `Model '${provider}/${model}' does not support reasoning effort '${reasoningEffort}'`,
        {
          reasoningEffort,
          supportedEfforts: resolved.reasoning?.efforts.map(effort => effort.id) ?? [],
        },
      )
    }
  }

  private async activity(kind: string, entityId: string, revision: number, summary: string): Promise<void> {
    const activity: TeamActivity = {
      schemaVersion: 1,
      id: randomUUID(),
      teamId: kind.startsWith('team.') ? entityId : 'assistant-library',
      kind,
      entityId,
      summary,
      revision,
      createdAt: new Date().toISOString(),
    }
    try {
      await this.store.putActivity(activity)
    } catch (error) {
      this.ctx.logger.warn('dsh-team-mode: activity write failed after primary mutation', error)
    }
  }

  private publish(
    entityType: AgentTeamChange['entityType'],
    entityId: string,
    revision: number,
    kind: string,
    conversation?: MemberConversationView,
  ): void {
    const change: AgentTeamChange = {
      cursor: ++this.cursor,
      entityType,
      entityId,
      revision,
      kind,
      ...(conversation === undefined ? {} : { conversation }),
    }
    for (const listener of this.listeners) listener(change)
  }

  private requireRuntime(): TeamRuntime {
    if (this.runtime === undefined) throw new Error('Agent Team runtime is not attached')
    return this.runtime
  }


  private requireAssistantBuilderRuntime(): AssistantBuilderRuntime {
    if (this.assistantBuilderRuntime === undefined) throw new Error('Assistant Builder runtime is not attached')
    return this.assistantBuilderRuntime
  }

  private requireAssistantRuntime(): AssistantRuntime {
    if (this.assistantRuntime === undefined) throw new Error('Assistant runtime is not attached')
    return this.assistantRuntime
  }
}

function requireAssistant(store: AgentTeamStore, id: string): AssistantTemplate {
  const assistant = store.getAssistant(id)
  if (assistant === undefined) {
    throw new AgentTeamError('ASSISTANT_NOT_FOUND', `Unknown assistant '${id}'`)
  }
  return assistant
}

function requireAssistantInstance(store: AgentTeamStore, id: string): AssistantInstance {
  const instance = store.getAssistantInstance(id)
  if (instance === undefined) {
    throw new AgentTeamError('ASSISTANT_INSTANCE_NOT_FOUND', `Unknown assistant instance '${id}'`)
  }
  return instance
}

function requireAssistantSession(store: AgentTeamStore, id: string): AssistantSession {
  const session = store.getAssistantSession(id)
  if (session === undefined) {
    throw new AgentTeamError('ASSISTANT_TASK_NOT_FOUND', `Unknown assistant task '${id}'`)
  }
  return session
}

/**
 * Apply instance-local name/avatar overrides to a template snapshot. An absent
 * name keeps the snapshot's name; an absent avatar keeps the snapshot's
 * avatar, while an empty string clears it (matching template editing).
 */
function overrideAssistantSnapshot(
  snapshot: AssistantSnapshot,
  name: string | undefined,
  avatar: string | undefined,
): AssistantSnapshot {
  const trimmedName = name?.trim()
  const next: AssistantSnapshot = trimmedName === undefined || trimmedName === ''
    ? { ...snapshot }
    : { ...snapshot, name: trimmedName }
  if (avatar === undefined) return next
  const trimmedAvatar = avatar.trim()
  if (trimmedAvatar === '') {
    const { avatar: _current, ...rest } = next
    return rest
  }
  return { ...next, avatar: trimmedAvatar }
}

interface AssistantSnapshotOverrides {
  name?: string | undefined
  avatar?: string | undefined
  provider?: string | undefined
  model?: string | undefined
  reasoningEffort?: string | undefined
  agentPresetId?: string | undefined
  permissionPresetId?: string | undefined
  instructions?: string | undefined
}

interface DirectAssistantSnapshotInput {
  name: string
  avatar?: string | undefined
  provider: string
  model: string
  reasoningEffort?: string | undefined
  agentPresetId: string
  permissionPresetId: string
  instructions?: string | undefined
}

/**
 * Build the snapshot of a template-less Assistant. The snapshot is owned by the
 * new instance (`assistantId` equals its id) and starts at revision 1 with no
 * Skills, MCP Servers, or prompts.
 */
function directAssistantSnapshot(id: string, input: DirectAssistantSnapshotInput): AssistantSnapshot {
  const avatar = input.avatar?.trim()
  const reasoningEffort = input.reasoningEffort?.trim()
  return {
    assistantId: id,
    revision: 1,
    name: input.name.trim(),
    ...(avatar === undefined || avatar === '' ? {} : { avatar }),
    instructions: input.instructions ?? '',
    provider: input.provider.trim(),
    model: input.model.trim(),
    ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }),
    agentPresetId: input.agentPresetId.trim(),
    permissionPresetId: input.permissionPresetId.trim(),
    skillAllowlist: [],
    mcpServers: [],
    prompts: [],
  }
}

/**
 * Apply explicit creation overrides on top of a template snapshot. Absent
 * fields keep the template value; an empty reasoning effort clears it, and an
 * empty avatar clears the template avatar (matching update semantics).
 */
function applyAssistantSnapshotOverrides(
  snapshot: AssistantSnapshot,
  overrides: AssistantSnapshotOverrides,
): AssistantSnapshot {
  const display = overrideAssistantSnapshot(snapshot, overrides.name, overrides.avatar)
  const {
    reasoningEffort: previousReasoning,
    ...rest
  } = display
  const reasoningEffort = overrides.reasoningEffort === undefined
    ? previousReasoning
    : overrides.reasoningEffort.trim() || undefined
  return {
    ...rest,
    ...(overrides.provider === undefined ? {} : { provider: overrides.provider.trim() }),
    ...(overrides.model === undefined ? {} : { model: overrides.model.trim() }),
    ...(overrides.agentPresetId === undefined ? {} : { agentPresetId: overrides.agentPresetId.trim() }),
    ...(overrides.permissionPresetId === undefined
      ? {}
      : { permissionPresetId: overrides.permissionPresetId.trim() }),
    ...(overrides.instructions === undefined ? {} : { instructions: overrides.instructions }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/**
 * Append with exactly one separating newline. An empty existing document is
 * treated as no separator, so the first append does not start with a blank line.
 */
function appendMemory(current: string, addition: string): string {
  if (current === '') return addition
  if (addition === '') return current
  return `${current}\n${addition}`
}

function requireTeam(store: AgentTeamStore, id: string): TeamAggregate {  const team = store.getTeam(id)
  if (team === undefined) throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${id}'`)
  return team
}

function assertRevision(entity: string, actual: number, expected?: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new AgentTeamError(
      entity === 'assistant' ? 'ASSISTANT_REVISION_CONFLICT' : 'TEAM_REVISION_CONFLICT',
      `${entity} revision conflict: expected ${expected}, current ${actual}`,
      { expected, actual },
    )
  }
}

function assertTeamMutable(team: TeamAggregate): void {
  if (team.state === 'deleting' || team.state === 'delete_blocked') {
    throw new AgentTeamError('TEAM_DELETING', `Team '${team.id}' is deleting`)
  }
}

function assistantInputOf(assistant: AssistantTemplate): CreateAssistantInput {
  return {
    name: assistant.name,
    ...(assistant.description === undefined ? {} : { description: assistant.description }),
    ...(assistant.icon === undefined ? {} : { icon: assistant.icon }),
    instructions: assistant.instructions,
    provider: assistant.provider,
    model: assistant.model,
    ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
    agentPresetId: assistant.agentPresetId,
    permissionPresetId: assistant.permissionPresetId,
    skillAllowlist: [...assistant.skillAllowlist],
    mcpServers: [...assistant.mcpServers],
    ...(assistant.avatar === undefined ? {} : { avatar: assistant.avatar }),
    enabled: assistant.enabled,
    teamSelectable: assistant.teamSelectable,
    prompts: [...assistant.prompts],
  }
}

function normalizeAssistantInput(input: CreateAssistantInput): CreateAssistantInput {
  return {
    ...input,
    name: input.name.trim(),
    provider: input.provider.trim(),
    model: input.model.trim(),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort.trim() }),
    agentPresetId: input.agentPresetId.trim(),
    permissionPresetId: input.permissionPresetId.trim(),
    skillAllowlist: unique(input.skillAllowlist),
    mcpServers: unique(input.mcpServers),
    prompts: uniqueOrdered(input.prompts ?? []).slice(0, 12),
  }
}

function uniqueOrdered(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    ordered.push(trimmed)
  }
  return ordered
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function createMemberSlot(
  assistant: AssistantTemplate,
  displayName: string,
  role: 'leader' | 'member',
  now: string,
  desiredState: 'online' | 'offline',
): TeamMemberSlot {
  const slotId = randomUUID()
  return {
    id: slotId,
    assistantId: assistant.id,
    displayName,
    role,
    assistantSnapshot: snapshotAssistant(assistant),
    permissionPresetId: assistant.permissionPresetId,
    ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
    sessionId: `session-${randomUUID()}`,
    desiredState,
    lastRuntimeState: desiredState === 'online' ? 'starting' : 'offline',
    joinedAt: now,
  }
}

function cloneMemberSlot(source: TeamMemberSlot, now: string): TeamMemberSlot {
  const slotId = randomUUID()
  return {
    id: slotId,
    assistantId: source.assistantId,
    displayName: source.displayName,
    role: source.role,
    assistantSnapshot: {
      ...source.assistantSnapshot,
      skillAllowlist: [...source.assistantSnapshot.skillAllowlist],
      mcpServers: [...source.assistantSnapshot.mcpServers],
    },
    permissionPresetId: source.permissionPresetId,
    ...(source.reasoningEffort === undefined ? {} : { reasoningEffort: source.reasoningEffort }),
    sessionId: `session-${randomUUID()}`,
    desiredState: 'offline',
    lastRuntimeState: 'offline',
    joinedAt: now,
  }
}

function withReasoningEffort(
  member: TeamMemberSlot,
  reasoningEffort: string | undefined,
): TeamMemberSlot {
  const { reasoningEffort: _current, ...rest } = member
  return reasoningEffort === undefined ? rest : { ...rest, reasoningEffort }
}

export function normalizeMemberDisplayName(value: string): string {
  const displayName = value.trim().slice(0, 80)
  if (displayName.length === 0) {
    throw new AgentTeamError('INVALID_REQUEST', 'Member display name cannot be empty')
  }
  return displayName
}

function assertMemberDisplayNameAvailable(
  team: TeamAggregate,
  displayName: string,
  exceptSlotId?: string,
): void {
  const collision = Object.values(team.members).find(member => (
    member.id !== exceptSlotId && member.displayName === displayName
  ))
  if (collision !== undefined) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Team member name '${displayName}' is already in use`,
      { memberId: collision.id },
    )
  }
}

function assertMemberHasNoOpenTasks(team: TeamAggregate, slotId: string): void {
  const open = Object.values(team.tasks).filter(task =>
    task.ownerSlotId === slotId && !['completed', 'failed', 'cancelled'].includes(task.status))
  if (open.length > 0) {
    throw new AgentTeamError(
      'MEMBER_BUSY',
      'Reassign, complete, fail, or cancel this member’s open tasks before removal',
      { taskIds: open.map(task => task.id) },
    )
  }
}
