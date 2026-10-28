import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { ZodError } from 'zod'
import { isModelInvocable, isSkillName, isUserInvocable } from '@deepseek-ai/dsh-skill'
import type { Config } from '../config.js'
import { CHIEF_ASSISTANT } from '../domain/chief.js'
import { AgentTeamError, epochStaleError, sessionRetiredError } from '../domain/errors.js'
import {
  memoryDedupeKey,
  redactMemoryText,
  type MemoryAskResult,
} from '../domain/memory.js'
import { isMcpServerName, mcpServerFromToolName } from '../domain/mcp.js'
import {
  GROUP_SHARE_KIND,
  GROUP_SHARE_MAX_DOCUMENT_BYTES,
  GROUP_SHARE_NAME_MAX_CHARS,
  GROUP_SHARE_SCHEMA_VERSION,
  groupExportDocumentSchema,
  largestPortableFields,
  portableDocumentBytes,
  portableProfileFromSnapshot,
  samePortableProfile,
  uniqueName,
  type GroupExportDocument,
  type GroupImportAssistantPlan,
  type GroupImportDropped,
  type GroupImportMemberPlan,
  type GroupImportPreview,
  type GroupImportResult,
  type GroupImportResultRow,
  type GroupImportTeamPlan,
  type GroupImportTemplatePlan,
  type PortableAssistantEntry,
  type PortableAssistantProfile,
  type PortableTeamMember,
} from '../domain/group-share.js'
import {
  assistantCreateDraftSchema,
  ASSISTANT_BLURB_MAX_CHARS,
  ASSISTANT_CREATE_DRAFT_MAX_INSTRUCTIONS_CHARS,
  ASSISTANT_CREATE_DRAFT_MAX_NAME_CHARS,
  ASSISTANT_CREATE_DRAFT_MAX_SENTENCE_CHARS,
  ASSISTANT_CREATE_DRAFT_MAX_TOKENS,
  ASSISTANT_TITLE_MAX_CHARS,
  createAssistantInputSchema,
  addTeamMemberInputSchema,
  assistantMemoryModeSchema,
  cloneTeamInputSchema,
  contextCheckpointSchema,
  createAssistantInstanceInputSchema,
  createAssistantSessionInputSchema,
  createTeamDraftInputSchema,
  createTeamGoalInputSchema,
  memberAssistantInstanceLinkSchema,
  SIDEBAR_GROUP_BRIEF_MAX_CHARS,
  SIDEBAR_GROUP_MAX_CHARS,
  SIDEBAR_GROUP_MAX_COUNT,
  TEAM_ANNOUNCEMENT_MAX_CHARS,
  teamCheckpointSchema,
  updateAssistantInputSchema,
  updateAssistantInstanceInputSchema,
  updateAssistantSessionInputSchema,
  updateTeamGoalInputSchema,
  writeAssistantMemoryEntryInputSchema,
  type AssistantCreateDraftInput,
  type AssistantCreateDraftReply,
} from '../domain/schemas.js'
import {
  epochOf,
  isCoordinatorInstance,
  snapshotAssistant,
  type AddTeamMemberInput,
  type AssistantInstance,
  type AssistantMemory,
  type AssistantMemoryMode,
  type AssistantPreview,
  type AssistantSession,
  type AssistantSnapshot,
  type AssistantTemplate,
  type CheckpointFacts,
  type CloneTeamInput,
  type ContextCheckpoint,
  type CreateAssistantInput,
  type CreateAssistantInstanceInput,
  type CreateAssistantSessionInput,
  type CreateTeamDraftInput,
  type CreateTeamGoalInput,
  type Escalation,
  type EscalationKind,
  type LinkedAssistantMemory,
  type MemoryEntry,
  type MemoryEntrySource,
  type MemoryJournalAction,
  type MemoryJournalEntry,
  type MemoryJournalSnapshot,
  type Operation,
  type Page,
  type SidebarGroupRecord,
  type SidebarGroups,
  type TeamActivity,
  type TeamAggregate,
  type TeamCheckpoint,
  type TeamCheckpointFacts,
  type TeamGoal,
  type TeamMemberSlot,
  type TeamMessage,
  type TeamTask,
  type TeamThread,
  type UpdateAssistantInput,
  type UpdateAssistantInstanceInput,
  type UpdateAssistantSessionInput,
  type UpdateTeamGoalInput,
  type WriteAssistantMemoryEntryInput,
} from '../domain/types.js'
import type {
  AgentTeamCheckpointStore,
  AgentTeamEscalationStore,
  AgentTeamLeaderCheckpointStore,
  AgentTeamSidebarGroupStore,
  AgentTeamStore,
} from '../storage/store.js'
import type { AssistantBuilderRuntime } from '../runtime/assistant-builder-runtime.js'
import type { AssistantEnsureResult, AssistantRuntime } from '../runtime/assistant-runtime.js'
import { resolveMemberToolPolicy } from '../runtime/team-tools.js'
import type { TeamRuntime } from '../runtime/team-runtime.js'
import { liftEscalations, recordEscalation, type EscalationGate } from './escalations.js'
import { WorkspaceService } from './workspace-service.js'
import type {
  AssistantBuilderConversationView,
  AssistantBuilderConversationListView,
  AssistantBuilderDraftView,
  AssistantCreateDraftView,
  InteractionResponseInput,
  MemberConversationView,
  PendingInteractionView,
  TeamMemoryWriteInput,
  TeamMemoryWriteView,
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
 * What a caller may pin when creating a team thread. Everything is optional:
 * the transport creates a plain thread (minted Session, default title, Leader as
 * speaker), while the runtime may hand over the Session id its factory created.
 */
export interface CreateTeamThreadInput {
  title?: string
  sessionId?: string
  speakerSlotId?: string
}

/** Thread titles are short row labels, bounded like a team name. */
export const THREAD_TITLE_MAX_CHARS = 80

/**
 * Fences for one runtime write. `expectedEpoch` rejects a write authored under a
 * previous leadership generation; `expectedMemberSession` rejects a write whose
 * Session has since been retired by a context handoff or reset, which the epoch
 * never changes. Both are re-checked inside the store's serialized write chain.
 */
export interface RuntimeWriteOptions {
  expectedRevision?: number
  expectedEpoch?: number
  expectedMemberSession?: { slotId: string; sessionId: string }
}

/**
 * Durable memory is a single string per Assistant instance. Writes over the
 * budget are rejected instead of truncated: silently dropping durable context
 * is worse than an explicit retry with a shorter note.
 */
export const ASSISTANT_MEMORY_MAX_CHARS = 16_000

/**
 * One checkpoint's optional handoff note. Longer notes are rejected rather than
 * truncated, matching the schema bound the client validates against.
 */
export const CHECKPOINT_NOTE_LIMIT = 4_000

/**
 * How many Leader checkpoints one team keeps. Older records can never be handed
 * off (their Session is gone or superseded), so they are pruned on create
 * instead of accumulating forever.
 */
export const TEAM_CHECKPOINT_LIMIT = 20

/**
 * How many retired main Sessions one instance remembers for sidebar hiding.
 * The schema bound is the same number; keep the newest entries.
 */
export const ASSISTANT_RETIRED_SESSION_LIMIT = 100

/**
 * How many extra visible Sessions one instance may own. The schema bound is the
 * same number; a longer list would be more than the sidebar can show.
 */
export const ASSISTANT_THREAD_SESSION_LIMIT = 20

/**
 * Directory under a base workspace that owns every private Assistant
 * workspace. Kept out of the base directory's own files by nesting one level
 * and git-ignoring the whole marker tree.
 */
export const ASSISTANT_WORKSPACE_ROOT = '.dsh-team-mode/assistants'

/**
 * Filesystem-safe ASCII slug for one private Assistant directory. A non-Latin
 * name yields no usable slug, and the id suffix keeps the directory unique
 * either way.
 */
export function assistantWorkspaceSlug(name: string): string {
  const slug = name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug === '' ? 'assistant' : slug
}

/**
 * The private directory for one Assistant: a function of the base directory,
 * the display name, and the instance id only. Retrying an allocation therefore
 * resolves to the same path instead of leaving a second directory behind.
 */
export function assistantWorkspacePath(
  basePath: string,
  name: string,
  assistantId: string,
): string {
  const id8 = assistantId.replace(/-/g, '').slice(0, 8).toLowerCase()
  return join(basePath, ASSISTANT_WORKSPACE_ROOT, `${assistantWorkspaceSlug(name)}-${id8}`)
}

/**
 * Create the private directory (idempotently) and register it with the host
 * workspace registry. The registry canonicalizes the path and reuses an
 * existing registration for it, so a repeated call returns the same workspace
 * id; a real registration is required because Session attach validates the
 * Session header's cwd against the registered workspace path.
 */
export async function ensureIsolatedAssistantWorkspace(
  registry: { create(path: string, title?: string): Promise<Workspace> },
  basePath: string,
  name: string,
  assistantId: string,
): Promise<{ workspaceId: string; workspacePath: string }> {
  const directory = assistantWorkspacePath(basePath, name, assistantId)
  await mkdir(directory, { recursive: true })
  // Keep the base checkout's own `git status` clean: the marker root is an
  // implementation detail, never a project directory to commit. Never replace a
  // `.gitignore` the user already keeps there; only create the missing one.
  try {
    await writeFile(join(basePath, '.dsh-team-mode', '.gitignore'), '*\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const workspace = await registry.create(directory, `${name.trim()} · 独立工作区`)
  return { workspaceId: String(workspace.id), workspacePath: workspace.path }
}

/**
 * Structured memory is unbounded by design only up to this many entries; past it
 * a runaway writer would keep growing the record with no reader able to show it.
 */
export const ASSISTANT_MEMORY_MAX_ENTRIES = 100

/**
 * Team memory keeps a much smaller shared budget than an assistant's private
 * memory. The caps live here so member/Leader tools and the user-facing
 * transport share one limit instead of drifting apart.
 */
export const TEAM_MEMORY_MAX_CHARS = 8_000
export const TEAM_MEMORY_MAX_ENTRIES = 100
export const TEAM_MEMORY_MAX_TITLE_CHARS = 200
export const TEAM_MEMORY_MAX_BODY_CHARS = 4_000

/**
 * The undo trail lives inside the same memory container: no new table, no
 * schema-version bump. Newest records win when either cap is exceeded; a
 * snapshot that had to be redacted or truncated is not undoable.
 */
export const MEMORY_JOURNAL_MAX_RECORDS = 10
export const ASSISTANT_MEMORY_JOURNAL_MAX_CHARS = 16_000
export const TEAM_MEMORY_JOURNAL_MAX_CHARS = 8_000
export const MEMORY_JOURNAL_REASON_MAX_CHARS = 200

/** Automatic capture is deliberately small: one short entry per source unit. */
export const MEMORY_CAPTURE_MAX_TITLE_CHARS = 200
export const MEMORY_CAPTURE_MAX_BODY_CHARS = 4_000
export const MEMORY_CAPTURE_MAX_TASK_RESULTS = 3

export interface WriteAssistantMemoryOptions {
  /** Expected memory revision; 0 means "no memory written yet". */
  expectedRevision?: number
  /** Journal actor for structured writes; defaults to the model (`assistant`). */
  actor?: MemoryEntrySource
}

/** One audited mutation, appended atomically with the memory write itself. */
export interface MemoryJournalChange {
  scope: 'assistant' | 'team'
  actor: MemoryEntrySource
  action: MemoryJournalAction
  entryId: string
  reason: string
  before: MemoryJournalSnapshot | null
  after: MemoryJournalSnapshot | null
}

export interface AgentTeamChange {
  cursor: number
  entityType: 'assistant' | 'assistant-instance' | 'assistant-session' | 'assistant-checkpoint' | 'assistant-builder' | 'team' | 'operation' | 'conversation' | 'workspace' | 'catalog'
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
    /** Private Assistant workspace: listed for settings, skipped by pickers. */
    isolated?: boolean
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
  /**
   * Per-assistant memory write chain. The store offers no conditional create,
   * so the create path is a plain put; serializing here makes every
   * check-then-write window (legacy note and structured entries alike)
   * unreachable from this service.
   */
  private readonly memoryWrites = new Map<string, Promise<void>>()
  /**
   * Coordinator switching touches two instance rows (clear the old flag, set the
   * new one) and the store offers no cross-row transaction, so every switch runs
   * one at a time: the read-check-write window is unreachable from a concurrent
   * switch. A failed switch never poisons the queue.
   */
  private coordinatorQueue: Promise<unknown> = Promise.resolve()
  /**
   * Serializes escalation aggregation passes. `liftEscalations` closes every
   * open gate missing from the batch it was given, so two overlapping passes
   * could lift a gate the other just recorded; one pass at a time keeps the
   * read-triggered aggregation monotonic.
   */
  private escalationPass: Promise<void> = Promise.resolve()

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

  /**
   * The escalation table is its own store slice so a store double written
   * before the table existed stays valid. Probe for it instead of widening
   * `AgentTeamStore`: a store without it records and lifts nothing.
   */
  private get escalationStore(): AgentTeamEscalationStore | undefined {
    const store = this.store as Partial<AgentTeamEscalationStore>
    return 'listEscalations' in store ? store as AgentTeamEscalationStore : undefined
  }

  /** Every persisted escalation row; empty when the store has no such table. */
  listEscalations(): Escalation[] {
    return this.escalationStore?.listEscalations() ?? []
  }

  /**
   * Run the lazy gate aggregation before a read. A transport test or a store
   * double has no runtime attached, so there is nothing live to aggregate and
   * the persisted rows are already the whole truth.
   */
  refreshEscalations(now = new Date().toISOString()): Promise<void> {
    const pass = this.escalationPass
      .then(() => this.runtime?.refreshEscalations(now))
      .then(() => undefined)
    this.escalationPass = pass.catch(() => undefined)
    return pass
  }

  /** Record one stalled gate; undefined when this store has no escalation table. */
  recordEscalation(gate: EscalationGate, now = new Date().toISOString()): Promise<Escalation | undefined> {
    const store = this.escalationStore
    return store === undefined ? Promise.resolve(undefined) : recordEscalation(store, gate, now)
  }

  /** Lazily close the gates of one Session + kind that left the newest batch. */
  liftEscalations(
    sessionId: string,
    kind: EscalationKind,
    activeGateIds: Iterable<string>,
    now = new Date().toISOString(),
  ): Promise<Escalation[]> {
    const store = this.escalationStore
    return store === undefined
      ? Promise.resolve([])
      : liftEscalations(store, sessionId, kind, activeGateIds, now)
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
    // The switch lives on the persisted instance row while the capture path reads
    // the runtime's cache every completed turn. Replay the enabled rows on attach
    // so a restart cannot silently stop capturing for an assistant left on.
    for (const instance of this.store.listAssistantInstances()) {
      if (instance.memoryAutoCapture === true) runtime.setMemoryAutoCapture(instance.id, true)
    }
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
    // Private Assistant workspaces stay in the catalog (settings surfaces name
    // them) but are marked so pickers never offer one as a base.
    const isolatedWorkspaceIds = new Set(this.store.listAssistantInstances()
      .filter(instance => instance.workspaceIsolated === true)
      .map(instance => instance.workspaceId))
    const workspaces = await Promise.all(this.ctx.workspaceRegistry.list().map(async workspace => ({
      id: String(workspace.id),
      path: workspace.path,
      title: workspace.title,
      status: await workspace.status(),
      ...(isolatedWorkspaceIds.has(String(workspace.id)) ? { isolated: true } : {}),
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

  /**
   * One read-only model call behind the create dialog's 一句话 field. It returns
   * text only: nothing is persisted, no Session, template or instance row is
   * created, and no agent tool reaches this path. The dialog's own submit stays
   * the only creation authority.
   */
  async draftAssistantFromSentence(
    input: AssistantCreateDraftInput,
  ): Promise<AssistantCreateDraftView> {
    const sentence = input.sentence.trim()
    if ([...sentence].length < 2 || [...sentence].length > ASSISTANT_CREATE_DRAFT_MAX_SENTENCE_CHARS) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `A create draft needs 2-${ASSISTANT_CREATE_DRAFT_MAX_SENTENCE_CHARS} characters`,
        { limit: ASSISTANT_CREATE_DRAFT_MAX_SENTENCE_CHARS },
      )
    }
    const provider = input.provider.trim()
    const model = input.model.trim()
    // The same resolution `catalog.model.get` uses: an unknown pair is refused
    // before any model call, and nothing is written either way.
    await this.modelCapabilities(provider, model)
    const reply = parseCreateDraftReply(
      await this.completeCreateDraft(provider, model, sentence),
    )
    const warnings: string[] = []
    const clip = (label: string, value: string | undefined, limit: number): string | undefined => {
      if (value === undefined || value === '') return undefined
      const characters = [...value]
      if (characters.length <= limit) return value
      warnings.push(`${label} was longer than ${limit} characters and was shortened`)
      return `${characters.slice(0, limit - 1).join('')}…`
    }
    const name = clip('name', reply.name, ASSISTANT_CREATE_DRAFT_MAX_NAME_CHARS)
    const title = clip('title', reply.title, ASSISTANT_TITLE_MAX_CHARS)
    const blurb = clip('blurb', reply.blurb, ASSISTANT_BLURB_MAX_CHARS)
    const instructions = clip(
      'instructions',
      reply.instructions,
      ASSISTANT_CREATE_DRAFT_MAX_INSTRUCTIONS_CHARS,
    )
    return {
      ...(name === undefined ? {} : { name }),
      ...(title === undefined ? {} : { title }),
      ...(blurb === undefined ? {} : { blurb }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(reply.presetId === undefined ? {} : { presetId: reply.presetId }),
      warnings,
    }
  }

  /**
   * The single model call behind the draft: one hand-built one-shot request on
   * the pair the dialog picked, no tools and no Session turn.
   */
  private async completeCreateDraft(
    provider: string,
    model: string,
    sentence: string,
  ): Promise<string> {
    let text = ''
    for await (const chunk of this.ctx.llm.stream({
      provider,
      model,
      system: CREATE_DRAFT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: sentence }] }],
      maxTokens: ASSISTANT_CREATE_DRAFT_MAX_TOKENS,
    })) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Create draft model call failed: ${chunk.reason.failure.message}`,
            { reason: chunk.reason.failure.code },
          )
        }
        break
      }
    }
    return text
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

  /**
   * Seed the shipped Chief template once. The template needs a real model,
   * preset, and permission name, so this runs after the catalog is available
   * and leaves an existing user-customized row untouched.
   */
  async ensureBuiltinAssistants(): Promise<void> {
    if (this.store.getAssistant(CHIEF_ASSISTANT.id) !== undefined) return
    const catalog = await this.catalog()
    const configuredProvider = this.config.assistantBuilderProvider.trim()
    const configuredModel = this.config.assistantBuilderModel.trim()
    const provider = configuredProvider !== ''
      && catalog.providers.some(entry => entry.id === configuredProvider)
      ? configuredProvider
      : catalog.providers.find(entry => (catalog.models[entry.id]?.length ?? 0) > 0)?.id
    if (provider === undefined) return
    const models = catalog.models[provider] ?? []
    const model = configuredModel !== ''
      && models.some(entry => entry.id === configuredModel)
      ? configuredModel
      : models[0]?.id
    if (model === undefined) return

    const configuredPreset = this.config.assistantBuilderAgentPresetId.trim()
    const agentPresetId = configuredPreset !== ''
      && catalog.agentPresets.some(entry => entry.id === configuredPreset)
      ? configuredPreset
      : catalog.agentPresets.find(entry => entry.broken === undefined)?.id
    if (agentPresetId === undefined) return

    const configuredPermission = this.config.assistantBuilderPermissionPresetId.trim()
    const permissionPresetId = configuredPermission !== ''
      && catalog.permissionPresets.some(entry => entry.value === configuredPermission)
      ? configuredPermission
      : catalog.permissionPresets.find(entry => entry.value === 'workspace-write')?.value
        ?? catalog.permissionPresets[0]?.value
    if (permissionPresetId === undefined) return

    const input = await this.validateAssistantDraft({
      name: CHIEF_ASSISTANT.name,
      description: CHIEF_ASSISTANT.description,
      instructions: CHIEF_ASSISTANT.instructions,
      avatar: CHIEF_ASSISTANT.avatar,
      provider,
      model,
      agentPresetId,
      permissionPresetId,
      skillAllowlist: [],
      mcpServers: [],
      prompts: [...CHIEF_ASSISTANT.prompts],
      enabled: true,
      teamSelectable: true,
    })
    const now = new Date().toISOString()
    const assistant: AssistantTemplate = {
      schemaVersion: 1,
      id: CHIEF_ASSISTANT.id,
      ...input,
      avatar: input.avatar?.trim() || undefined,
      enabled: true,
      teamSelectable: true,
      sortOrder: 0,
      prompts: uniqueOrdered(input.prompts ?? []).slice(0, 12),
      source: 'builtin',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putAssistant(assistant)
    await this.activity('assistant.created', assistant.id, assistant.revision, 'Built-in Chief assistant created')
    this.publish('assistant', assistant.id, assistant.revision, 'assistant.created')
  }

  /**
   * Add Chief as the default single-chat assistant exactly once. The archived
   * row also counts as a prior installation, so a user who archives Chief does
   * not get it recreated on the next restart.
   */
  async ensureDefaultChiefAssistant(): Promise<void> {
    if (this.store.getAssistant(CHIEF_ASSISTANT.id) === undefined) return
    const installed = this.store.listAssistantInstances()
      .some(instance => instance.templateId === CHIEF_ASSISTANT.id)
    if (installed) return
    const catalog = await this.catalog()
    const workspace = catalog.workspaces.find(entry => entry.status === 'ok')
    if (workspace === undefined) return
    const created = await this.createAssistantInstance({
      templateId: CHIEF_ASSISTANT.id,
      workspaceId: workspace.id,
      name: CHIEF_ASSISTANT.name,
      avatar: CHIEF_ASSISTANT.avatar,
      pinned: true,
    })
    // The seeded Chief is the out-of-the-box coordinator. Only when nobody else
    // holds that role: an explicit choice must survive a reinstall of the sample.
    if (this.getCoordinatorInstance() === undefined) {
      await this.setCoordinatorInstance(created.id)
    }
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
      .map(coordinatorVisible)
      .sort((left, right) => Number(right.pinned) - Number(left.pinned)
        || right.updatedAt.localeCompare(left.updatedAt)
        || left.id.localeCompare(right.id))
    return { items, total: items.length }
  }

  getAssistantInstance(id: string): AssistantInstance {
    return coordinatorVisible(requireAssistantInstance(this.store, id))
  }

  /**
   * The workspace's one coordinator, or undefined when none is set. The flag is
   * the only source of truth: no name or template match can make an instance the
   * coordinator.
   */
  getCoordinatorInstance(): AssistantInstance | undefined {
    const instance = this.store.listAssistantInstances().find(isCoordinatorInstance)
    return instance === undefined ? undefined : coordinatorVisible(instance)
  }

  /**
   * Set or clear the workspace coordinator. A switch clears the previous flag
   * and sets the new one inside one serialized critical section, so two rows can
   * never both be coordinators; `null` clears it. An archived instance cannot
   * become the coordinator (the read guards would then be lying about it).
   */
  async setCoordinatorInstance(assistantId: string | null): Promise<AssistantInstance | undefined> {
    const targetId = assistantId === null ? undefined : assistantId.trim()
    if (targetId === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant instance id cannot be empty')
    }
    return this.queueCoordinatorWrite(async () => {
      // Re-read inside the serialized slot: a queued switch may have committed a
      // different coordinator, and an archive may have landed while waiting.
      const target = targetId === undefined
        ? undefined
        : requireAssistantInstance(this.store, targetId)
      if (target !== undefined && target.status === 'archived') {
        throw new AgentTeamError(
          'ASSISTANT_INSTANCE_ARCHIVED',
          `Assistant instance '${target.id}' is archived; it cannot be the coordinator`,
          { instanceId: target.id },
        )
      }
      const now = new Date().toISOString()
      const next: { instance?: AssistantInstance } = {}
      for (const instance of this.store.listAssistantInstances()) {
        if (instance.id === targetId) {
          if (!isCoordinatorInstance(instance)) {
            next.instance = await this.store.updateAssistantInstance(instance.id, value => ({
              ...value,
              coordinator: true,
              revision: value.revision + 1,
              updatedAt: now,
            }))
            this.publishCoordinator(next.instance)
          } else {
            next.instance = instance
          }
          continue
        }
        if (!isCoordinatorInstance(instance)) continue
        this.publishCoordinator(await this.clearCoordinatorFlag(instance.id, now))
      }
      return next.instance
    })
  }

  /** Remove the flag entirely so a cleared row looks like a pre-feature row. */
  private clearCoordinatorFlag(id: string, now: string): Promise<AssistantInstance> {
    return this.store.updateAssistantInstance(id, value => {
      const { coordinator: _coordinator, ...rest } = value
      return { ...rest, revision: value.revision + 1, updatedAt: now }
    })
  }

  private publishCoordinator(instance: AssistantInstance): void {
    this.publish('assistant-instance', instance.id, instance.revision, 'assistant.instance.updated')
  }

  /** One coordinator write at a time; a rejection must not block the next one. */
  private queueCoordinatorWrite<T>(work: () => Promise<T>): Promise<T> {
    const next = this.coordinatorQueue.then(work, work)
    this.coordinatorQueue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Sidebar view: the persisted instances plus a bounded latest-message
   * preview. A preview failure is presentation-only and never hides the row.
   * `includeArchived:false` is an explicit filter; the default keeps the
   * historical unfiltered page so an archive stays reversible from the client.
   */
  async listAssistantInstanceViews(
    options: { includeArchived?: boolean | undefined } = {},
  ): Promise<Page<AssistantInstance & { preview?: AssistantPreview }>> {
    const page = this.listAssistantInstances()
    const items = options.includeArchived === false
      ? page.items.filter(instance => instance.status !== 'archived')
      : page.items
    if (this.assistantRuntime === undefined) return { items, total: items.length }
    const withPreviews = await Promise.all(items.map(async instance => {
      try {
        const preview = await this.assistantRuntime?.latestPreview(instance.id)
        return preview === undefined ? instance : { ...instance, preview }
      } catch {
        return instance
      }
    }))
    return { items: withPreviews, total: withPreviews.length }
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
    let workspaceId = String(workspace.id)
    let workspacePath = workspace.path
    let workspaceIsolated = false
    if (input.workspaceIsolated === true) {
      try {
        const isolated = await ensureIsolatedAssistantWorkspace(
          this.ctx.workspaceRegistry,
          workspace.path,
          assistantSnapshot.name,
          id,
        )
        workspaceId = isolated.workspaceId
        workspacePath = isolated.workspacePath
        workspaceIsolated = true
      } catch (cause) {
        // A base directory that cannot host a subdirectory (permissions,
        // read-only checkout) fails here rather than creating a broken row
        // whose workspace does not exist.
        throw new AgentTeamError(
          'WORKSPACE_UNAVAILABLE',
          `Cannot allocate an isolated workspace under '${workspace.path}': ${errorMessage(cause)}`,
          { workspaceId: input.workspaceId, workspacePath: workspace.path },
        )
      }
    }
    const now = new Date().toISOString()
    const instance: AssistantInstance = {
      schemaVersion: 1,
      id,
      ...(templateId === undefined ? {} : { templateId }),
      assistantSnapshot,
      workspaceId,
      workspacePath,
      ...(workspaceIsolated ? { workspaceIsolated: true } : {}),
      status: 'idle',
      pinned: input.pinned ?? false,
      ...(input.mascot === undefined ? {} : { mascot: input.mascot }),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putAssistantInstance(instance)
    this.publish('assistant-instance', instance.id, instance.revision, 'assistant.instance.created')
    return instance
  }

  /**
   * Rewrite the instance-local display name/avatar, pin flag, capability
   * allowlists, and engine settings on the stored snapshot. Model references and
   * reasoning efforts are validated exactly like assistant templates, and
   * permission presets must exist in the current catalog. The referenced
   * template is untouched, and a patch that changes nothing is a no-op rather
   * than a revision bump.
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
      title: _previousTitle,
      blurb: _previousBlurb,
      ...snapshotRest
    } = display
    // Absent keeps the stored identity line; an empty string clears it.
    const title = patch.title === undefined
      ? current.assistantSnapshot.title
      : identityLine(patch.title)
    const blurb = patch.blurb === undefined
      ? current.assistantSnapshot.blurb
      : identityLine(patch.blurb)
    const snapshot: AssistantSnapshot = {
      ...snapshotRest,
      ...(title === undefined ? {} : { title }),
      ...(blurb === undefined ? {} : { blurb }),
      // The persona is part of the snapshot the create dialog fills; a patch may
      // replace it, and an absent field keeps the stored text.
      instructions: patch.instructions ?? current.assistantSnapshot.instructions,
      provider,
      model,
      permissionPresetId: permissionPresetId ?? current.assistantSnapshot.permissionPresetId,
      // Capability allowlists follow the same rule: an absent patch keeps the
      // stored lists, and an empty array clears them.
      ...(patch.skillAllowlist === undefined
        ? {}
        : { skillAllowlist: unique(patch.skillAllowlist) }),
      ...(patch.mcpServers === undefined
        ? {}
        : { mcpServers: unique(patch.mcpServers) }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
    const pinned = patch.pinned ?? current.pinned
    // Same convention as teams: an absent patch field keeps the stored group,
    // a blank one clears it, and a new label must already exist as a group.
    const group = patch.group === undefined
      ? current.group
      : normalizeSidebarGroup(patch.group)
    if (patch.group !== undefined) this.assertKnownGroup(group)
    // Absent keeps the stored mascot; the value itself is validated by the schema.
    const mascot = patch.mascot ?? current.mascot
    // The auto-capture switch is stored on the instance row; absent keeps it.
    const memoryAutoCapture = patch.memoryAutoCapture ?? current.memoryAutoCapture
    const changed = snapshot.name !== current.assistantSnapshot.name
      || snapshot.title !== current.assistantSnapshot.title
      || snapshot.blurb !== current.assistantSnapshot.blurb
      || snapshot.avatar !== current.assistantSnapshot.avatar
      || snapshot.instructions !== current.assistantSnapshot.instructions
      || snapshot.provider !== current.assistantSnapshot.provider
      || snapshot.model !== current.assistantSnapshot.model
      || snapshot.reasoningEffort !== current.assistantSnapshot.reasoningEffort
      || snapshot.permissionPresetId !== current.assistantSnapshot.permissionPresetId
      || JSON.stringify(snapshot.skillAllowlist) !== JSON.stringify(current.assistantSnapshot.skillAllowlist)
      || JSON.stringify(snapshot.mcpServers) !== JSON.stringify(current.assistantSnapshot.mcpServers)
      || pinned !== current.pinned
      || group !== current.group
      || JSON.stringify(mascot) !== JSON.stringify(current.mascot)
      || memoryAutoCapture !== current.memoryAutoCapture
    if (!changed) return current
    // The capability lists are the only snapshot fields this patch can make
    // invalid on its own (model and permission presets are checked above), so
    // they run through the same reference rules as creation.
    if (patch.skillAllowlist !== undefined) this.assertSkillNames(snapshot.skillAllowlist)
    if (patch.mcpServers !== undefined) await this.assertMcpServers(snapshot.mcpServers, snapshot.agentPresetId)
    const next = await this.store.updateAssistantInstance(id, value => {
      const { group: _previousGroup, ...rest } = value
      return {
        ...rest,
        assistantSnapshot: snapshot,
        pinned,
        ...(group === undefined ? {} : { group }),
        ...(mascot === undefined ? {} : { mascot }),
        ...(memoryAutoCapture === undefined ? {} : { memoryAutoCapture }),
        revision: value.revision + 1,
        updatedAt: new Date().toISOString(),
      }
    })
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.updated')
    // The runtime cache is what the capture path reads on every completed turn,
    // so a persisted switch change is reflected there as part of the same call.
    this.assistantRuntime?.setMemoryAutoCapture(next.id, memoryAutoCapture === true)
    return next
  }

  /**
   * Persist the per-assistant auto-capture switch (the row is what survives a
   * restart) and keep the runtime's in-memory cache in step. The dedicated UI
   * path goes through here so the two copies of the switch cannot diverge.
   */
  async setAssistantMemoryAutoCapture(
    assistantId: string,
    enabled: boolean,
  ): Promise<AssistantInstance> {
    const instance = await this.updateAssistantInstance(assistantId, { memoryAutoCapture: enabled })
    // updateAssistantInstance returns early when the value already matches, so
    // sync here as well: replaying the same value must still reach the runtime.
    this.assistantRuntime?.setMemoryAutoCapture(instance.id, enabled)
    return instance
  }

  /**
   * Hide an instance from listings without deleting it or its main Session.
   * Idempotent: archiving an archived instance returns the stored record.
   * When the Assistant runtime is attached, active workers are cancelled and
   * the archived row is persisted while the assistant lock is still held, so
   * no concurrent worker creation can slip in after the stop pass.
   */
  async archiveAssistantInstance(id: string): Promise<AssistantInstance> {
    const current = requireAssistantInstance(this.store, id)
    if (current.status === 'archived') return current
    // The coordinator is the one visible "person" of the workspace; archiving it
    // would silently remove the pinned row, so the action is refused with the
    // step that makes it legal.
    assertNotCoordinator(current)
    if (this.assistantRuntime !== undefined) {
      await this.assistantRuntime.stopForArchive(id)
    }
    // Idempotent re-read: when the runtime already persisted inside its lock
    // this returns the stored row without a second write or publish.
    return this.persistAssistantArchived(id)
  }

  /**
   * Runtime-only hook: persist the archived status under the assistant lock
   * held by {@link AssistantRuntime.stopForArchive}. The stored row is
   * re-read first so a second archive stays a no-op and a queued writer
   * cannot raise the revision of an already archived instance.
   */
  async persistAssistantArchived(id: string): Promise<AssistantInstance> {
    const current = requireAssistantInstance(this.store, id)
    if (current.status === 'archived') return current
    const now = new Date().toISOString()
    const next = await this.store.updateAssistantInstance(id, value => {
      // Re-checked inside the write: a coordinator set while this archive waited
      // wins, exactly like the bind/archive ordering above.
      assertNotCoordinator(value)
      return {
        ...value,
        status: 'archived',
        archivedAt: now,
        revision: value.revision + 1,
        updatedAt: now,
      }
    })
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.archived')
    return next
  }

  /**
   * Bring one archived instance back. This is a row write only: the main Session
   * log, thread Sessions, worker Sessions, the workspace and its files are all
   * left exactly where archive left them. A paused assistant stays paused.
   */
  async restoreAssistantInstance(id: string): Promise<AssistantInstance> {
    const current = requireAssistantInstance(this.store, id)
    if (current.status !== 'archived') return current
    const now = new Date().toISOString()
    const next = await this.store.updateAssistantInstance(id, value => {
      const { archivedAt: _archivedAt, ...rest } = value
      return {
        ...rest,
        // A bound main Session is still usable; an unbound one keeps the row idle
        // until the user opens it and the runtime binds a fresh Session.
        status: value.mainSessionId === undefined ? 'idle' : 'active',
        revision: value.revision + 1,
        updatedAt: now,
      }
    })
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.restored')
    return next
  }

  /**
   * Pause one Assistant. The marker is persisted before the runtime is asked to
   * stop anything, so a queue drain that starts in between already sees the
   * pause. Running worker turns are cancelled and their tasks marked paused;
   * queued rows stay queued and simply do not start.
   */
  async pauseAssistantInstance(id: string): Promise<AssistantInstance> {
    const current = requireAssistantInstance(this.store, id)
    if (current.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${id}' is archived`,
        { instanceId: id },
      )
    }
    if (current.pausedAt !== undefined) {
      await this.assistantRuntime?.pauseAssistantWorkers(id)
      return current
    }
    const now = new Date().toISOString()
    const next = await this.store.updateAssistantInstance(id, value => ({
      ...value,
      pausedAt: now,
      revision: value.revision + 1,
      updatedAt: now,
    }))
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.paused')
    await this.assistantRuntime?.pauseAssistantWorkers(id)
    return next
  }

  /**
   * Clear the Assistant pause, re-admit the tasks the pause stopped, and drain
   * the queue. A task paused by the user stays paused: only `pausedBy:
   * 'assistant'` rows are re-admitted.
   */
  async resumeAssistantInstance(id: string): Promise<AssistantInstance> {
    const current = requireAssistantInstance(this.store, id)
    if (current.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${id}' is archived`,
        { instanceId: id },
      )
    }
    if (current.pausedAt === undefined) return current
    const now = new Date().toISOString()
    const next = await this.store.updateAssistantInstance(id, value => {
      const { pausedAt: _pausedAt, ...rest } = value
      return {
        ...rest,
        revision: value.revision + 1,
        updatedAt: now,
      }
    })
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.resumed')
    for (const task of this.listAssistantSessions(id).items) {
      if (task.status === 'paused' && task.pausedBy === 'assistant') {
        await this.requeueAssistantTask(task.id)
      }
    }
    await this.assistantRuntime?.drainAssistantQueue(id)
    return next
  }

  /**
   * Pause one worker task. A queued task only changes status and is never
   * started. A running task is marked paused first, then its live turn is
   * cancelled and the worker released — that cancellation is destructive, the
   * cancelled turn is not replayed, and resume starts a fresh turn on the same
   * Session.
   */
  async pauseAssistantTask(rawTaskId: string): Promise<AssistantSession> {
    const taskId = rawTaskId.trim()
    if (taskId === '') throw new AgentTeamError('INVALID_REQUEST', 'Task id cannot be empty')
    const task = requireAssistantSession(this.store, taskId)
    if (this.getAssistantInstance(task.assistantId).status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${task.assistantId}' is archived`,
        { instanceId: task.assistantId, taskId },
      )
    }
    if (task.archivedAt !== undefined) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Task '${taskId}' is archived; restore it before pausing`,
        { taskId },
      )
    }
    if (task.status === 'paused') return task
    if (isTerminalAssistantTaskStatus(task.status)) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Task '${taskId}' is already ${task.status}; only queued or live tasks can pause`,
        { taskId },
      )
    }
    const paused = await this.writeAssistantTask(task.id, value => ({
      ...value,
      status: 'paused',
      pausedBy: 'user',
    }))
    if (task.status === 'running' || task.status === 'needs_input') {
      await this.assistantRuntime?.stopTaskForPause(task.id)
    }
    return paused
  }

  /** Re-admit one paused task and drain; the worker resumes its stored Session. */
  async resumeAssistantTask(rawTaskId: string): Promise<AssistantSession> {
    const taskId = rawTaskId.trim()
    if (taskId === '') throw new AgentTeamError('INVALID_REQUEST', 'Task id cannot be empty')
    const task = requireAssistantSession(this.store, taskId)
    if (this.getAssistantInstance(task.assistantId).status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${task.assistantId}' is archived`,
        { instanceId: task.assistantId, taskId },
      )
    }
    if (task.status !== 'paused') {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Task '${taskId}' is ${task.status}; only a paused task can resume`,
        { taskId, status: task.status },
      )
    }
    await this.requeueAssistantTask(task.id)
    await this.assistantRuntime?.drainAssistantQueue(task.assistantId)
    return this.getAssistantSession(task.id)
  }

  /**
   * Archive one finished task row. Only terminal tasks archive: a live or paused
   * task must first be cancelled (or resumed/completed), so archiving can never
   * strand a worker. The row, its Session log and the workspace are untouched.
   */
  async archiveAssistantTask(rawTaskId: string): Promise<AssistantSession> {
    const taskId = rawTaskId.trim()
    if (taskId === '') throw new AgentTeamError('INVALID_REQUEST', 'Task id cannot be empty')
    const task = requireAssistantSession(this.store, taskId)
    if (task.archivedAt !== undefined) return task
    if (!isTerminalAssistantTaskStatus(task.status)) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Task '${taskId}' is ${task.status}; cancel it before archiving`,
        { taskId, status: task.status },
      )
    }
    return this.writeAssistantTask(task.id, value => ({
      ...value,
      archivedAt: new Date().toISOString(),
    }))
  }

  /** Restore one archived task row to its previous finished status. */
  async restoreAssistantTask(rawTaskId: string): Promise<AssistantSession> {
    const taskId = rawTaskId.trim()
    if (taskId === '') throw new AgentTeamError('INVALID_REQUEST', 'Task id cannot be empty')
    const task = requireAssistantSession(this.store, taskId)
    if (task.archivedAt === undefined) return task
    return this.writeAssistantTask(task.id, value => {
      const { archivedAt: _archivedAt, ...rest } = value
      return rest
    })
  }

  /**
   * Runtime-only hook: the first turn has been handed to a task's worker. The
   * started stamp is what a later pause/resume uses to decide whether the brief
   * still needs delivering or the Session only needs a continue instruction.
   */
  async markAssistantTaskStarted(rawTaskId: string): Promise<AssistantSession> {
    const task = requireAssistantSession(this.store, rawTaskId.trim())
    if (task.status === 'running' && task.startedAt !== undefined) return task
    const now = new Date().toISOString()
    // Conditional inside the store write: a pause, cancel or terminal transition
    // that committed after the read above must never be turned back into
    // running. Only a row still queued may start, and a legitimate running
    // transition clears the pause provenance so a later pause starts clean.
    return this.writeAssistantTask(task.id, value => {
      if (value.status !== 'queued') return value
      const { pausedBy: _pausedBy, ...rest } = value
      return {
        ...rest,
        status: 'running',
        ...(value.startedAt === undefined ? { startedAt: now } : {}),
      }
    })
  }

  /** Runtime-only hook: mark a live task paused by the assistant-level pause. */
  async setAssistantTaskPaused(
    rawTaskId: string,
    pausedBy: NonNullable<AssistantSession['pausedBy']>,
  ): Promise<AssistantSession> {
    const task = requireAssistantSession(this.store, rawTaskId.trim())
    if (isTerminalAssistantTaskStatus(task.status)) return task
    return this.writeAssistantTask(task.id, value => ({
      ...value,
      status: 'paused',
      pausedBy,
    }))
  }

  /** Re-admit one paused (or queued) row without touching its Session or brief. */
  private async requeueAssistantTask(taskId: string): Promise<AssistantSession> {
    return this.writeAssistantTask(taskId, value => {
      const { pausedBy: _pausedBy, ...rest } = value
      return { ...rest, status: 'queued' }
    })
  }

  private async writeAssistantTask(
    taskId: string,
    mutate: (current: AssistantSession) => AssistantSession,
  ): Promise<AssistantSession> {
    const now = new Date().toISOString()
    const next = await this.store.updateAssistantSession(taskId, value => ({
      ...mutate(value),
      updatedAt: now,
    }))
    this.publish('assistant-session', next.id, 0, 'assistant.session.updated')
    return next
  }

  /**
   * Runtime-only hook: record the lazily created main Session. Re-binding the
   * same Session is a no-op so ensure/open can call it on every click. A bind
   * that was queued behind an archive write never resurrects the archived row.
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
    const next = await this.store.updateAssistantInstance(id, value => {
      // This update runs after every earlier queued instance write. Re-check
      // the stored row so an archive that committed while this bind waited
      // wins instead of being overwritten back to 'active'.
      if (value.status === 'archived') {
        throw new AgentTeamError(
          'ASSISTANT_INSTANCE_ARCHIVED',
          `Assistant instance '${id}' is archived`,
        )
      }
      return {
        ...value,
        mainSessionId,
        status: 'active',
        revision: value.revision + 1,
        updatedAt: new Date().toISOString(),
      }
    })
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
   * The persisted auto-capture switch for one Assistant instance. A missing row
   * or a row stored before the switch existed reads as off; this is a plain
   * store read so rendering the switch never creates a row.
   */
  getAssistantMemoryAutoCapture(assistantId: string): boolean {
    const id = assistantId.trim()
    if (id === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant instance id cannot be empty')
    }
    return this.store.getAssistantInstance(id)?.memoryAutoCapture === true
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
    return this.withMemoryWriteLock(
      instance.id,
      () => this.writeAssistantMemoryLocked(instance.id, content, mode, options),
    )
  }

  private async writeAssistantMemoryLocked(
    assistantId: string,
    content: string,
    mode: AssistantMemoryMode,
    options: WriteAssistantMemoryOptions,
  ): Promise<AssistantMemory> {
    // Re-read inside the serialized slot: the instance may have been archived
    // while this write waited for an earlier one.
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

  /**
   * Read one Assistant instance's structured memory entries. A row written
   * before structured memory existed has none, so this returns an empty array
   * rather than inventing an entry from the legacy `content` note.
   */
  getAssistantMemoryEntries(assistantId: string): MemoryEntry[] {
    return [...(this.getAssistantMemory(assistantId)?.entries ?? [])]
  }

  /**
   * One explicit ask-or-change request over this Assistant instance's
   * structured memory. The runtime owns the single model call: an `answer`
   * writes nothing, while a `change` writes every entry as `proposed` through
   * the revision-fenced entry write path, so acceptance stays a user action.
   */
  async askAssistantMemory(assistantId: string, text: string): Promise<MemoryAskResult> {
    return this.requireAssistantRuntime().askAssistantMemory(assistantId, text)
  }

  /**
   * Prompt-facing read of one member's explicitly linked Assistant memory. Read
   * live on every turn: a link, a clear, or an archive is reflected on the next
   * turn without restarting the member Session. A stale link never throws — a
   * missing, archived, or workspace-mismatched instance degrades to an empty
   * projection. Only `active`, `assistant`-scoped, `team-safe` structured
   * entries qualify; the legacy `content` note is never injected.
   */
  readMemberAssistantMemory(teamId: string, slotId: string): LinkedAssistantMemory {
    const team = this.store.getTeam(teamId)
    const member = team?.members[slotId]
    if (team === undefined || member?.assistantInstanceId === undefined) {
      return { state: 'unlinked', entries: [] }
    }
    const instance = this.store.getAssistantInstance(member.assistantInstanceId)
    if (instance === undefined) return { state: 'unavailable', entries: [] }
    if (instance.status === 'archived') return { state: 'archived', entries: [] }
    if (instance.workspaceId !== team.workspaceId || instance.workspacePath !== team.workspacePath) {
      return { state: 'unavailable', entries: [] }
    }
    const entries = (this.store.getAssistantMemory(instance.id)?.entries ?? [])
      .filter(entry => entry.status === 'active'
        && entry.scope === 'assistant'
        && entry.visibility === 'team-safe')
    return { state: 'linked', entries }
  }

  /**
   * Create or update one structured entry. `options.expectedRevision` fences the
   * whole memory document (not the entry): 0 means "no memory row yet". Writes
   * are serialized per instance, and the fence is re-checked inside the store's
   * atomic read-modify-write, so a concurrent writer (including a concurrent
   * first write) is rejected with {@link MEMORY_REVISION_CONFLICT} instead of
   * being overwritten. A provided `id` must name an existing entry; an unknown
   * id is rejected rather than silently created. New entries default to
   * `private` visibility and `active` status, and are written with the
   * `assistant` source. Each successful write bumps the document revision and,
   * for an existing entry, its own revision. Archived entries do not count
   * toward the entry or character budgets.
   */
  async writeAssistantMemoryEntry(
    assistantId: string,
    raw: WriteAssistantMemoryEntryInput,
    options: WriteAssistantMemoryOptions = {},
  ): Promise<{ memory: AssistantMemory; entry: MemoryEntry }> {
    const instance = requireAssistantInstance(this.store, assistantId)
    return this.withMemoryWriteLock(
      instance.id,
      () => this.writeAssistantMemoryEntryLocked(instance.id, raw, options),
    )
  }

  private async writeAssistantMemoryEntryLocked(
    assistantId: string,
    raw: WriteAssistantMemoryEntryInput,
    options: WriteAssistantMemoryOptions,
  ): Promise<{ memory: AssistantMemory; entry: MemoryEntry }> {
    // Re-read inside the serialized slot: archiving and sibling writes land
    // while this one waits.
    const instance = requireAssistantInstance(this.store, assistantId)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${instance.id}' is archived`,
      )
    }
    const input = writeAssistantMemoryEntryInputSchema.parse(raw)
    const current = this.store.getAssistantMemory(instance.id)
    requireMemoryRevision(options.expectedRevision, current?.revision ?? 0)
    const now = new Date().toISOString()
    if (current === undefined) {
      if (input.id !== undefined) {
        throw new AgentTeamError(
          'INVALID_REQUEST',
          `Unknown assistant memory entry '${input.id}'`,
          { entryId: input.id },
        )
      }
      const entry = newMemoryEntry(input, now)
      const memory: AssistantMemory = {
        schemaVersion: 1,
        assistantId: instance.id,
        content: '',
        entries: [entry],
        journal: appendMemoryJournal(undefined, assistantJournalChange(
          entry,
          undefined,
          options.actor ?? 'assistant',
        ), 1, ASSISTANT_MEMORY_JOURNAL_MAX_CHARS),
        revision: 1,
        updatedAt: now,
      }
      await this.store.putAssistantMemory(memory)
      return { memory, entry }
    }
    const written: { entry?: MemoryEntry } = {}
    const memory = await this.store.updateAssistantMemory(instance.id, value => {
      requireMemoryRevision(options.expectedRevision, value.revision)
      const entries = value.entries ?? []
      const existing = input.id === undefined
        ? undefined
        : entries.find(entry => entry.id === input.id)
      if (input.id !== undefined && existing === undefined) {
        throw new AgentTeamError(
          'INVALID_REQUEST',
          `Unknown assistant memory entry '${input.id}'`,
          { entryId: input.id },
        )
      }
      // Archived entries are history: they stay stored but no longer occupy
      // budget, so the "archive unused entries first" advice is actionable.
      if (
        existing === undefined
        && entries.filter(value => value.status !== 'archived').length >= ASSISTANT_MEMORY_MAX_ENTRIES
      ) {
        throw new AgentTeamError(
          'INVALID_REQUEST',
          `Assistant memory already holds ${ASSISTANT_MEMORY_MAX_ENTRIES} entries; archive unused entries first`,
          { limit: ASSISTANT_MEMORY_MAX_ENTRIES },
        )
      }
      // A revision proposal is its own pending entry that names the live target:
      // the target is validated here and stays untouched until the user accepts.
      if (input.supersedes !== undefined) {
        if (input.supersedes === input.id) {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Assistant memory entry '${input.supersedes}' cannot supersede itself`,
            { entryId: input.supersedes },
          )
        }
        if (!entries.some(candidate => candidate.id === input.supersedes)) {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Unknown assistant memory entry '${input.supersedes}' to revise`,
            { entryId: input.supersedes },
          )
        }
      }
      const entry = existing === undefined
        ? newMemoryEntry(input, now)
        : reviseMemoryEntry(existing, input, now)
      // An active entry is prompt-injected. Turning it back into a proposal would
      // silently remove it from the prompt, so a revision has to be its own
      // pending entry with `supersedes` instead.
      if (existing !== undefined && existing.status === 'active' && entry.status === 'proposed') {
        throw new AgentTeamError(
          'INVALID_REQUEST',
          `Active assistant memory entry '${existing.id}' cannot be demoted to proposed; write a separate proposed entry with supersedes instead`,
          { entryId: existing.id },
        )
      }
      const nextEntries = existing === undefined
        ? [...entries, entry]
        : entries.map(value => value.id === entry.id ? entry : value)
      const totalChars = nextEntries
        .filter(value => value.status !== 'archived')
        .reduce((sum, value) => sum + value.title.length + value.body.length, 0)
      if (totalChars > ASSISTANT_MEMORY_MAX_CHARS) {
        throw new AgentTeamError(
          'INVALID_REQUEST',
          `Assistant memory entries exceed ${ASSISTANT_MEMORY_MAX_CHARS} characters; archive unused entries first`,
          { length: totalChars, limit: ASSISTANT_MEMORY_MAX_CHARS },
        )
      }
      written.entry = entry
      const revision = value.revision + 1
      let journal = appendMemoryJournal(
        value.journal,
        assistantJournalChange(entry, existing, options.actor ?? 'assistant'),
        revision,
        ASSISTANT_MEMORY_JOURNAL_MAX_CHARS,
      )
      // Accepting a revision proposal applies it and retires its target in the
      // SAME revision: one fenced write leaves no window where both bodies are
      // live, and a concurrent writer is rejected by the fence instead of
      // accepting half of the pair.
      const target = existing !== undefined
        && existing.status === 'proposed'
        && entry.status === 'active'
        ? existing.supersedes
        : undefined
      if (target !== undefined) {
        const position = nextEntries.findIndex(candidate => candidate.id === target)
        const live = position === -1 ? undefined : nextEntries[position]
        if (position !== -1 && live !== undefined && live.status === 'active') {
          const superseded: MemoryEntry = {
            ...live,
            status: 'superseded',
            revision: live.revision + 1,
            updatedAt: now,
          }
          nextEntries[position] = superseded
          journal = appendMemoryJournal(journal, {
            scope: 'assistant',
            actor: options.actor ?? 'assistant',
            action: 'supersede',
            entryId: superseded.id,
            reason: `superseded by '${entry.title}'`,
            before: memoryEntrySnapshot(live),
            after: memoryEntrySnapshot(superseded),
          }, revision, ASSISTANT_MEMORY_JOURNAL_MAX_CHARS)
        }
      }
      return {
        ...value,
        entries: nextEntries,
        journal,
        revision,
        updatedAt: now,
      }
    })
    if (written.entry === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant memory entry write produced no entry')
    }
    return { memory, entry: written.entry }
  }

  /**
   * Undo one journaled assistant-memory change. The journal record must live in
   * this instance's own memory and must be the change that produced the current
   * revision: undoing an older record would silently discard everything after
   * it, so that is `MEMORY_UNDO_STALE`. A redacted or truncated record cannot
   * prove its prior content and is `MEMORY_UNDO_UNAVAILABLE`. Undoing a create
   * archives the entry; every other action restores the recorded before-image
   * as a new entry revision.
   */
  async undoAssistantMemory(
    assistantId: string,
    journalId: string,
    options: WriteAssistantMemoryOptions = {},
  ): Promise<{ memory: AssistantMemory; entry: MemoryEntry }> {
    const instance = requireAssistantInstance(this.store, assistantId)
    return this.withMemoryWriteLock(
      instance.id,
      () => this.undoAssistantMemoryLocked(instance.id, journalId, options),
    )
  }

  private async undoAssistantMemoryLocked(
    assistantId: string,
    journalId: string,
    options: WriteAssistantMemoryOptions,
  ): Promise<{ memory: AssistantMemory; entry: MemoryEntry }> {
    const instance = requireAssistantInstance(this.store, assistantId)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${instance.id}' is archived`,
      )
    }
    const id = journalId.trim()
    if (id === '') throw new AgentTeamError('INVALID_REQUEST', 'Memory journal id is required')
    const current = this.store.getAssistantMemory(instance.id)
    if (current === undefined) throw undoUnavailable(id, 'no memory is stored')
    if (
      options.expectedRevision !== undefined
      && options.expectedRevision !== current.revision
    ) {
      throw undoStale(options.expectedRevision, current.revision)
    }
    const now = new Date().toISOString()
    const undone: { entry?: MemoryEntry } = {}
    const memory = await this.store.updateAssistantMemory(instance.id, value => {
      if (
        options.expectedRevision !== undefined
        && options.expectedRevision !== value.revision
      ) {
        throw undoStale(options.expectedRevision, value.revision)
      }
      const record = value.journal?.find(candidate => candidate.id === id)
      if (record === undefined) throw undoUnavailable(id, 'unknown journal entry')
      if (record.scope !== 'assistant') throw undoUnavailable(id, 'journal entry belongs to another scope')
      if (record.redacted === true) throw undoUnavailable(id, 'snapshot was redacted')
      if (record.trimmed === true) throw undoUnavailable(id, 'snapshot was truncated')
      if (record.revision !== value.revision) throw undoStale(record.revision, value.revision)
      const entries = [...(value.entries ?? [])]
      const index = entries.findIndex(entry => entry.id === record.entryId)
      if (index === -1) throw undoUnavailable(id, 'the entry no longer exists')
      const live = entries[index]!
      if (live.scope !== 'assistant') throw undoUnavailable(id, 'the entry belongs to another scope')
      const entry: MemoryEntry = record.before === null
        ? { ...live, status: 'archived', revision: live.revision + 1, updatedAt: now }
        : restoreMemoryEntry(live, record.before, now)
      entries[index] = entry
      const revision = value.revision + 1
      undone.entry = entry
      return {
        ...value,
        entries,
        journal: restampJournalRevision(
          appendMemoryJournal(value.journal, {
            scope: 'assistant',
            actor: options.actor ?? 'user',
            action: 'undo',
            entryId: entry.id,
            reason: `undo ${record.action} '${record.before?.title ?? record.after?.title ?? entry.title}'`,
            before: memoryEntrySnapshot(live),
            after: memoryEntrySnapshot(entry),
          }, revision, ASSISTANT_MEMORY_JOURNAL_MAX_CHARS),
          value.revision,
          revision,
          record.id,
        ),
        revision,
        updatedAt: now,
      }
    })
    if (undone.entry === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant memory undo produced no entry')
    }
    return { memory, entry: undone.entry }
  }

  /**
   * Opt-in capture after a worker task completes. Writes exactly one `private`
   * `proposed` entry (`task:<id>`) derived from the task title and its bounded
   * result summary; it never activates anything, never calls a model, and is
   * skipped when capture is off, the task is not completed, or an entry with the
   * same key/text already exists. Capture failures are swallowed: completing a
   * task must never fail because memory could not be written.
   */
  async captureAssistantTaskMemory(assistantId: string, taskId: string): Promise<boolean> {
    if (this.config.memoryAutoCapture !== true) return false
    try {
      const instance = requireAssistantInstance(this.store, assistantId)
      if (instance.status === 'archived') return false
      const task = this.getAssistantSession(taskId.trim())
      if (task.assistantId !== instance.id || task.status !== 'completed') return false
      return await this.withMemoryWriteLock(
        instance.id,
        () => this.captureAssistantTaskMemoryLocked(instance.id, task),
      )
    } catch (error) {
      this.ctx.logger.warn(
        `dsh-team-mode: assistant task memory capture failed for '${taskId}'`,
        error,
      )
      return false
    }
  }

  private async captureAssistantTaskMemoryLocked(
    assistantId: string,
    task: AssistantSession,
  ): Promise<boolean> {
    if (this.config.memoryAutoCapture !== true) return false
    const instance = requireAssistantInstance(this.store, assistantId)
    if (instance.status === 'archived') return false
    const now = new Date().toISOString()
    const candidate = assistantTaskCaptureEntry(task, now)
    const key = candidate.key
    const dedupe = memoryDedupeKey(candidate)
    const existing = this.store.getAssistantMemory(instance.id)
    if (existing !== undefined && hasCapturedEntry(existing.entries ?? [], key, dedupe)) return false
    if (existing === undefined) {
      const memory: AssistantMemory = {
        schemaVersion: 1,
        assistantId: instance.id,
        content: '',
        entries: [candidate],
        journal: appendMemoryJournal(undefined, assistantCaptureChange(candidate), 1, ASSISTANT_MEMORY_JOURNAL_MAX_CHARS),
        revision: 1,
        updatedAt: now,
      }
      await this.store.putAssistantMemory(memory)
      return true
    }
    const written = { added: false }
    await this.store.updateAssistantMemory(instance.id, value => {
      const entries = value.entries ?? []
      if (hasCapturedEntry(entries, key, dedupe)) return value
      const live = entries.filter(entry => entry.status !== 'archived')
      const nextChars = live.reduce((sum, entry) => sum + entry.title.length + entry.body.length, 0)
        + candidate.title.length + candidate.body.length
      if (
        live.length >= ASSISTANT_MEMORY_MAX_ENTRIES
        || nextChars > ASSISTANT_MEMORY_MAX_CHARS
      ) return value
      written.added = true
      const revision = value.revision + 1
      return {
        ...value,
        entries: [...entries, candidate],
        journal: appendMemoryJournal(
          value.journal,
          assistantCaptureChange(candidate),
          revision,
          ASSISTANT_MEMORY_JOURNAL_MAX_CHARS,
        ),
        revision,
        updatedAt: now,
      }
    })
    return written.added
  }

  /** Run one memory write at a time per assistant instance. */
  private async withMemoryWriteLock<T>(assistantId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.memoryWrites.get(assistantId) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.memoryWrites.set(assistantId, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.memoryWrites.get(assistantId) === tail) {
        this.memoryWrites.delete(assistantId)
      }
    }
  }

  /** Materialize the instance's main Session through the attached runtime. */
  async ensureAssistantInstance(id: string): Promise<AssistantEnsureResult> {
    return this.requireAssistantRuntime().ensureInstance(id)
  }

  /**
   * Create one extra visible Session in the instance's workspace and list it as
   * a thread, through the attached runtime.
   */
  async createAssistantThread(assistantId: string, cwd?: string): Promise<AssistantEnsureResult> {
    const id = assistantId.trim()
    if (id === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant instance id cannot be empty')
    }
    return this.requireAssistantRuntime().createAssistantThread(id, cwd)
  }

  /**
   * Capture one checkpoint from the instance's current main Session. The note
   * is trimmed and bounded here; the facts themselves are built deterministically
   * by the runtime (no model call, no tool output).
   */
  async createAssistantCheckpoint(assistantId: string, note = ''): Promise<ContextCheckpoint> {
    const id = assistantId.trim()
    if (id === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant instance id cannot be empty')
    }
    requireAssistantInstance(this.store, id)
    const text = note.trim()
    if (text.length > CHECKPOINT_NOTE_LIMIT) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Checkpoint note must be at most ${CHECKPOINT_NOTE_LIMIT} characters`,
      )
    }
    return this.requireAssistantRuntime().createCheckpoint(id, text)
  }

  /** Newest-first checkpoints of one Assistant instance. */
  listAssistantCheckpoints(assistantId: string): ContextCheckpoint[] {
    const id = assistantId.trim()
    if (id === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant instance id cannot be empty')
    }
    requireAssistantInstance(this.store, id)
    return this.checkpointStore().listContextCheckpoints()
      .filter(checkpoint => checkpoint.assistantId === id)
  }

  /**
   * Runtime-only hook: persist the bounded facts the runtime captured. The
   * checkpoint is created `ready`; only a handoff consumes it.
   */
  async createContextCheckpoint(input: {
    assistantId: string
    sourceSessionId: string
    capturedThroughSeq: number
    facts: CheckpointFacts
    note: string
  }): Promise<ContextCheckpoint> {
    const instance = requireAssistantInstance(this.store, input.assistantId)
    const now = new Date().toISOString()
    const checkpoint = contextCheckpointSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      assistantId: instance.id,
      sourceSessionId: input.sourceSessionId,
      title: `检查点 ${now}`,
      note: input.note,
      capturedThroughSeq: input.capturedThroughSeq,
      facts: input.facts,
      status: 'ready',
      createdAt: now,
    })
    await this.checkpointStore().putContextCheckpoint(checkpoint)
    this.publish('assistant-checkpoint', checkpoint.id, 0, 'assistant.checkpoint.created')
    return checkpoint
  }

  /** Read one checkpoint; an unknown id is CHECKPOINT_NOT_FOUND. */
  getContextCheckpoint(id: string): ContextCheckpoint {
    const checkpointId = id.trim()
    if (checkpointId === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Checkpoint id cannot be empty')
    }
    const checkpoint = this.checkpointStore().getContextCheckpoint(checkpointId)
    if (checkpoint === undefined) {
      throw new AgentTeamError('CHECKPOINT_NOT_FOUND', `Unknown checkpoint '${checkpointId}'`)
    }
    return checkpoint
  }

  /**
   * Move one instance to a freshly created main Session in a single update:
   * the previous id is appended to `retiredMainSessionIds` (deduplicated) and
   * the retired list stays bounded. An archive that committed first wins.
   */
  async advanceAssistantMainSession(
    assistantId: string,
    mainSessionId: string,
    retiredSessionId: string,
  ): Promise<AssistantInstance> {
    const id = assistantId.trim()
    const nextSessionId = mainSessionId.trim()
    if (id === '' || nextSessionId === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant instance id and main Session id cannot be empty')
    }
    const retired = retiredSessionId.trim()
    const now = new Date().toISOString()
    const next = await this.store.updateAssistantInstance(id, value => {
      if (value.status === 'archived') {
        throw new AgentTeamError(
          'ASSISTANT_INSTANCE_ARCHIVED',
          `Assistant instance '${id}' is archived`,
        )
      }
      const retiredIds = [...(value.retiredMainSessionIds ?? [])]
      if (retired !== '' && retired !== nextSessionId && !retiredIds.includes(retired)) {
        retiredIds.push(retired)
      }
      return {
        ...value,
        mainSessionId: nextSessionId,
        retiredMainSessionIds: retiredIds.slice(-ASSISTANT_RETIRED_SESSION_LIMIT),
        status: 'active',
        revision: value.revision + 1,
        updatedAt: now,
      }
    })
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.handoff')
    return next
  }

  /**
   * Attach one extra visible Session to an instance. The main Session is not a
   * thread (it has its own field and always sorts first), so it is rejected
   * here instead of being listed twice.
   */
  async attachAssistantThread(assistantId: string, sessionId: string): Promise<AssistantInstance> {
    const id = assistantId.trim()
    const threadSessionId = sessionId.trim()
    if (id === '' || threadSessionId === '') {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        'Assistant instance id and thread Session id cannot be empty',
      )
    }
    assertThreadSession(requireAssistantInstance(this.store, id), threadSessionId)
    const now = new Date().toISOString()
    const next = await this.store.updateAssistantInstance(id, value => {
      // Re-checked inside the write: an archive that committed while this attach
      // waited wins instead of gaining a thread it can never list.
      assertThreadSession(value, threadSessionId)
      return {
        ...value,
        threadSessionIds: [...(value.threadSessionIds ?? []), threadSessionId],
        revision: value.revision + 1,
        updatedAt: now,
      }
    })
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.thread_attached')
    return next
  }

  /**
   * Archive one thread Session off the visible list. The main Session is the
   * instance's own conversation, so only the instance archive may retire it.
   */
  async archiveAssistantThread(assistantId: string, sessionId: string): Promise<AssistantInstance> {
    const id = assistantId.trim()
    const threadSessionId = sessionId.trim()
    if (id === '' || threadSessionId === '') {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        'Assistant instance id and thread Session id cannot be empty',
      )
    }
    const current = requireAssistantInstance(this.store, id)
    if (current.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${id}' is archived`,
        { instanceId: id },
      )
    }
    if (current.mainSessionId === threadSessionId) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        'The main Session cannot be archived as a thread; archive the assistant instead',
        { instanceId: id, sessionId: threadSessionId },
      )
    }
    if (!(current.threadSessionIds ?? []).includes(threadSessionId)) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Session '${threadSessionId}' is not a thread of assistant instance '${id}'`,
        { instanceId: id, sessionId: threadSessionId },
      )
    }
    const now = new Date().toISOString()
    const next = await this.store.updateAssistantInstance(id, value => {
      if (value.status === 'archived') {
        throw new AgentTeamError(
          'ASSISTANT_INSTANCE_ARCHIVED',
          `Assistant instance '${id}' is archived`,
          { instanceId: id },
        )
      }
      const retiredIds = [...(value.retiredThreadSessionIds ?? [])]
      if (!retiredIds.includes(threadSessionId)) retiredIds.push(threadSessionId)
      return {
        ...value,
        threadSessionIds: (value.threadSessionIds ?? []).filter(item => item !== threadSessionId),
        retiredThreadSessionIds: retiredIds.slice(-ASSISTANT_RETIRED_SESSION_LIMIT),
        revision: value.revision + 1,
        updatedAt: now,
      }
    })
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.thread_archived')
    return next
  }

  /**
   * Put one archived thread back on the visible thread list. The Session log was
   * never deleted by archive, so this is the same row update in reverse.
   */
  async restoreAssistantThread(assistantId: string, sessionId: string): Promise<AssistantInstance> {
    const id = assistantId.trim()
    const threadSessionId = sessionId.trim()
    if (id === '' || threadSessionId === '') {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        'Assistant instance id and thread Session id cannot be empty',
      )
    }
    const current = requireAssistantInstance(this.store, id)
    if (current.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${id}' is archived`,
        { instanceId: id },
      )
    }
    if (!(current.retiredThreadSessionIds ?? []).includes(threadSessionId)) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Session '${threadSessionId}' is not archived for assistant instance '${id}'`,
        { instanceId: id, sessionId: threadSessionId },
      )
    }
    if ((current.threadSessionIds ?? []).length >= ASSISTANT_THREAD_SESSION_LIMIT) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Assistant instance '${id}' already lists ${ASSISTANT_THREAD_SESSION_LIMIT} threads`,
        { instanceId: id, sessionId: threadSessionId },
      )
    }
    const now = new Date().toISOString()
    const next = await this.store.updateAssistantInstance(id, value => {
      if (value.status === 'archived') {
        throw new AgentTeamError(
          'ASSISTANT_INSTANCE_ARCHIVED',
          `Assistant instance '${id}' is archived`,
          { instanceId: id },
        )
      }
      const threads = [...(value.threadSessionIds ?? [])]
      if (!threads.includes(threadSessionId)) threads.push(threadSessionId)
      return {
        ...value,
        threadSessionIds: threads,
        retiredThreadSessionIds: (value.retiredThreadSessionIds ?? [])
          .filter(item => item !== threadSessionId),
        revision: value.revision + 1,
        updatedAt: now,
      }
    })
    this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.thread_restored')
    return next
  }

  /**
   * Runtime-only hook: mark a checkpoint consumed by the handoff that used it.
   * A checkpoint that is no longer `ready` cannot be consumed twice.
   */
  async consumeContextCheckpoint(
    checkpointId: string,
    targetSessionId: string,
  ): Promise<ContextCheckpoint> {
    const current = this.getContextCheckpoint(checkpointId)
    if (current.status !== 'ready') {
      throw new AgentTeamError(
        'CHECKPOINT_NOT_READY',
        `Checkpoint '${current.id}' is ${current.status}`,
        { checkpointId: current.id, status: current.status },
      )
    }
    const sessionId = targetSessionId.trim()
    const now = new Date().toISOString()
    const next = await this.checkpointStore().updateContextCheckpoint(current.id, value => {
      if (value.status !== 'ready') {
        throw new AgentTeamError(
          'CHECKPOINT_NOT_READY',
          `Checkpoint '${value.id}' is ${value.status}`,
          { checkpointId: value.id, status: value.status },
        )
      }
      return {
        ...value,
        status: 'consumed',
        targetSessionId: sessionId,
        consumedAt: now,
      }
    })
    this.publish('assistant-checkpoint', next.id, 0, 'assistant.checkpoint.consumed')
    return next
  }

  /** Hand one checkpoint into a fresh main Session through the attached runtime. */
  async handoffAssistant(checkpointId: string): Promise<{
    checkpoint: ContextCheckpoint
    sessionId: string
  }> {
    const id = checkpointId.trim()
    if (id === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Checkpoint id cannot be empty')
    }
    return this.requireAssistantRuntime().handoff(id)
  }

  /**
   * Capture one checkpoint of the current Leader Session. The note is trimmed
   * and bounded here; the runtime builds the facts deterministically.
   */
  async createTeamLeaderCheckpoint(
    teamId: string,
    note = '',
    options: MutationOptions = {},
  ): Promise<TeamCheckpoint> {
    const id = teamId.trim()
    if (id === '') throw new AgentTeamError('INVALID_REQUEST', 'Team id cannot be empty')
    requireTeam(this.store, id)
    const text = note.trim()
    if (text.length > CHECKPOINT_NOTE_LIMIT) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Checkpoint note must be at most ${CHECKPOINT_NOTE_LIMIT} characters`,
      )
    }
    return this.requireRuntime().createLeaderCheckpoint(id, text, options)
  }

  /** Newest-first Leader checkpoints of one team. */
  listTeamCheckpoints(teamId: string): TeamCheckpoint[] {
    const team = requireTeam(this.store, teamId.trim())
    return this.teamCheckpointStore().listTeamCheckpoints(team.id)
  }

  /** Read one checkpoint of one team; an unknown id is CHECKPOINT_NOT_FOUND. */
  getTeamCheckpoint(teamId: string, checkpointId: string): TeamCheckpoint {
    const team = requireTeam(this.store, teamId.trim())
    const id = checkpointId.trim()
    if (id === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Checkpoint id cannot be empty')
    }
    const checkpoint = this.teamCheckpointStore().getTeamCheckpoint(id)
    if (checkpoint === undefined || checkpoint.teamId !== team.id) {
      throw new AgentTeamError('CHECKPOINT_NOT_FOUND', `Unknown checkpoint '${id}'`)
    }
    return checkpoint
  }

  /**
   * Runtime-only hook: persist one bounded Leader checkpoint and prune the
   * oldest records so the table stays bounded per team.
   */
  async createTeamCheckpoint(input: {
    teamId: string
    leaderSlotId: string
    epoch: number
    sourceSessionId: string
    capturedThroughSeq: number
    facts: TeamCheckpointFacts
    note: string
    expectedRevision?: number
  }): Promise<TeamCheckpoint> {
    const team = requireTeam(this.store, input.teamId)
    if (input.expectedRevision !== undefined && input.expectedRevision !== team.revision) {
      throw new AgentTeamError(
        'TEAM_REVISION_CONFLICT',
        `team revision conflict: expected ${input.expectedRevision}, current ${team.revision}`,
        { expected: input.expectedRevision, actual: team.revision },
      )
    }
    const now = new Date().toISOString()
    const checkpoint = teamCheckpointSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      teamId: team.id,
      leaderSlotId: input.leaderSlotId,
      epoch: input.epoch,
      sourceSessionId: input.sourceSessionId,
      title: `检查点 ${now}`,
      note: input.note,
      capturedThroughSeq: input.capturedThroughSeq,
      facts: input.facts,
      origin: 'manual',
      status: 'ready',
      createdAt: now,
    })
    await this.persistTeamCheckpoint(checkpoint)
    return checkpoint
  }

  /**
   * Runtime-only hook for the opt-in context-pressure checkpoint. It never
   * touches the aggregate: the record is `origin: 'threshold'` and a second
   * capture for the same (team, Leader Session) replaces the previous one in
   * place, so sustained pressure cannot grow the table or produce a history
   * nobody reads. Manual checkpoints are never replaced.
   */
  async createThresholdTeamCheckpoint(input: {
    teamId: string
    leaderSlotId: string
    epoch: number
    sourceSessionId: string
    capturedThroughSeq: number
    facts: TeamCheckpointFacts
    at: string
  }): Promise<TeamCheckpoint> {
    const team = requireTeam(this.store, input.teamId)
    const store = this.teamCheckpointStore()
    const existing = store.listTeamCheckpoints(team.id).find(checkpoint => (
      checkpoint.origin === 'threshold'
      && checkpoint.sourceSessionId === input.sourceSessionId
      && checkpoint.status === 'ready'
    ))
    const next = existing === undefined
      ? teamCheckpointSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        teamId: team.id,
        leaderSlotId: input.leaderSlotId,
        epoch: input.epoch,
        sourceSessionId: input.sourceSessionId,
        title: `检查点 ${input.at}`,
        note: '',
        capturedThroughSeq: input.capturedThroughSeq,
        facts: input.facts,
        origin: 'threshold',
        status: 'ready',
        createdAt: input.at,
      })
      : await store.updateTeamCheckpoint(existing.id, value => ({
        ...value,
        leaderSlotId: input.leaderSlotId,
        epoch: input.epoch,
        capturedThroughSeq: input.capturedThroughSeq,
        facts: input.facts,
        note: '',
        title: `检查点 ${input.at}`,
        createdAt: input.at,
      }))
    if (existing === undefined) await this.persistTeamCheckpoint(next)
    else this.publish('team', team.id, team.revision, 'team.checkpoint.created')
    return next
  }

  /**
   * One durable checkpoint write plus the per-team bound. Kept private so a
   * manual and a threshold checkpoint cannot drift apart on pruning.
   */
  private async persistTeamCheckpoint(checkpoint: TeamCheckpoint): Promise<void> {
    const store = this.teamCheckpointStore()
    await store.putTeamCheckpoint(checkpoint)
    for (const stale of store.listTeamCheckpoints(checkpoint.teamId).slice(TEAM_CHECKPOINT_LIMIT)) {
      await store.deleteTeamCheckpoint(stale.id)
    }
    this.publish('team', checkpoint.teamId, this.getTeam(checkpoint.teamId).revision, 'team.checkpoint.created')
  }

  /**
   * Runtime-only hook: mark a checkpoint consumed by the handoff that used it.
   * A checkpoint that is no longer `ready` cannot be consumed twice.
   */
  async consumeTeamCheckpoint(
    teamId: string,
    checkpointId: string,
    targetSessionId: string,
  ): Promise<TeamCheckpoint> {
    const current = this.getTeamCheckpoint(teamId, checkpointId)
    if (current.status !== 'ready') {
      throw new AgentTeamError(
        'CHECKPOINT_NOT_READY',
        `Checkpoint '${current.id}' is ${current.status}`,
        { checkpointId: current.id, status: current.status },
      )
    }
    const sessionId = targetSessionId.trim()
    const now = new Date().toISOString()
    const next = await this.teamCheckpointStore().updateTeamCheckpoint(current.id, value => {
      if (value.status !== 'ready') {
        throw new AgentTeamError(
          'CHECKPOINT_NOT_READY',
          `Checkpoint '${value.id}' is ${value.status}`,
          { checkpointId: value.id, status: value.status },
        )
      }
      return { ...value, status: 'consumed', targetSessionId: sessionId, consumedAt: now }
    })
    this.publish('team', next.teamId, this.getTeam(next.teamId).revision, 'team.checkpoint.consumed')
    return next
  }

  /**
   * Hand the Leader role to a fresh Session of the same member: the explicit
   * user action. The epoch, Leader slot, tasks, Goals, memory and Workspace are
   * untouched; only the Leader's `sessionId` (and its tombstone) changes.
   */
  async handoffTeamLeader(
    teamId: string,
    checkpointId: string,
    options: MutationOptions = {},
  ): Promise<{ team: TeamAggregate; checkpoint: TeamCheckpoint; sessionId: string }> {
    const id = teamId.trim()
    if (id === '') throw new AgentTeamError('INVALID_REQUEST', 'Team id cannot be empty')
    requireTeam(this.store, id)
    const checkpoint = checkpointId.trim()
    if (checkpoint === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Checkpoint id cannot be empty')
    }
    const result = await this.requireRuntime().handoffLeader(id, checkpoint, options)
    return { team: this.getTeam(id), ...result }
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

  /**
   * Worker task rows, newest-first from the store. Archived rows stay in the
   * default page (the Historical behaviour) because the client owns hiding;
   * `includeArchived:false` filters them for readers that need finished work out
   * of the way.
   */
  listAssistantSessions(
    assistantId?: string,
    options: { includeArchived?: boolean } = {},
  ): Page<AssistantSession> {
    const items = this.store.listAssistantSessions()
      .filter(session => assistantId === undefined || session.assistantId === assistantId)
      .filter(session => options.includeArchived !== false || session.archivedAt === undefined)
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

  /** Goals belonging to one team; a legacy team simply has none. */
  listGoals(teamId: string): Page<TeamGoal> {
    const team = requireTeam(this.store, teamId)
    const items = Object.values(team.goals ?? {})
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    return { items, total: items.length }
  }

  async createGoal(
    teamId: string,
    raw: CreateTeamGoalInput,
    options: RuntimeWriteOptions = {},
  ): Promise<TeamGoal> {
    const input = createTeamGoalInputSchema.parse(raw)
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    const now = new Date().toISOString()
    const goal: TeamGoal = {
      id: randomUUID(),
      teamId,
      title: input.title,
      objective: input.objective,
      acceptance: input.acceptance ?? '',
      mode: input.mode ?? 'single',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    await this.updateRuntimeTeam(
      teamId,
      current => ({ ...current, goals: { ...current.goals, [goal.id]: goal } }),
      'team.goal_created',
      `Goal ${goal.title} created`,
      options,
    )
    return goal
  }

  async updateGoal(
    teamId: string,
    goalId: string,
    raw: UpdateTeamGoalInput,
    options: RuntimeWriteOptions = {},
  ): Promise<TeamGoal> {
    const input = updateTeamGoalInputSchema.parse(raw)
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    const previous = requireGoal(team, goalId)
    const now = new Date().toISOString()
    const next = await this.updateRuntimeTeam(
      teamId,
      current => {
        const existing = requireGoal(current, goalId)
        const updated: TeamGoal = {
          ...existing,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.objective === undefined ? {} : { objective: input.objective }),
          ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.status === undefined ? {} : { status: input.status }),
          updatedAt: now,
        }
        return { ...current, goals: { ...current.goals, [goalId]: updated } }
      },
      'team.goal_updated',
      `Goal ${goalId} updated`,
      options,
    )
    // Capture only on the transition into `completed`, and never let an
    // optional memory write turn a successful Goal update into a failure.
    if (
      this.config.memoryAutoCapture === true
      && input.status === 'completed'
      && previous.status !== 'completed'
    ) {
      await this.captureTeamGoalMemory(teamId, goalId, options.expectedEpoch)
    }
    return requireGoal(next, goalId)
  }

  /**
   * Link one task to a Goal of its own team, or unlink it with `goalId`
   * undefined. Both records are resolved inside the same aggregate, so another
   * team's Goal is never reachable here and is rejected as unknown.
   */
  async linkTaskToGoal(teamId: string, taskId: string, goalId?: string): Promise<TeamTask> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    requireTask(team, taskId)
    if (goalId !== undefined) requireGoal(team, goalId)
    const now = new Date().toISOString()
    const next = await this.updateRuntimeTeam(
      teamId,
      current => {
        const task = requireTask(current, taskId)
        if (goalId !== undefined) requireGoal(current, goalId)
        const updated: TeamTask = goalId === undefined
          ? { ...withoutGoal(task), revision: task.revision + 1, updatedAt: now }
          : { ...task, goalId, revision: task.revision + 1, updatedAt: now }
        return { ...current, tasks: { ...current.tasks, [taskId]: updated } }
      },
      goalId === undefined ? 'team.goal_unlinked' : 'team.task_goal_linked',
      goalId === undefined ? `Task ${taskId} unlinked from its goal` : `Task ${taskId} linked to goal ${goalId}`,
    )
    return requireTask(next, taskId)
  }

  /**
   * User-authority write of one team memory entry. Team entries are always
   * `team-safe` and active: a private or proposed entry has no meaning for the
   * human owner of the team. `expectedMemoryRevision` fences the memory
   * container (0 means "no team memory yet") and is re-checked inside the
   * serialized aggregate update, so a concurrent proposal cannot be lost. An
   * existing `id` is revised in place; a new `key` supersedes the active entry
   * it replaces, matching the Leader write path.
   */
  async writeUserTeamMemory(
    teamId: string,
    input: TeamMemoryWriteInput,
    options: { expectedMemoryRevision?: number } = {},
  ): Promise<TeamMemoryWriteView> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    const title = input.title.trim()
    if (title === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Team memory title is required')
    }
    requireTeamMemoryText(title.length, TEAM_MEMORY_MAX_TITLE_CHARS, 'Team memory title')
    requireTeamMemoryText(input.body.length, TEAM_MEMORY_MAX_BODY_CHARS, 'Team memory body')
    const key = normalizeTeamMemoryKey(input.key)
    const expected = normalizeTeamMemoryRevision(options.expectedMemoryRevision)
    const now = new Date().toISOString()
    const entryId = input.id ?? `mem-${randomUUID()}`
    const next = await this.updateRuntimeTeam(
      teamId,
      current => {
        requireTeamMemoryRevision(expected, current.memory?.revision ?? 0)
        const entries = [...(current.memory?.entries ?? [])]
        const index = input.id === undefined
          ? -1
          : entries.findIndex(entry => entry.id === input.id)
        if (input.id !== undefined && index === -1) {
          throw new AgentTeamError('INVALID_REQUEST', `Unknown team memory entry '${input.id}'`, {
            entryId: input.id,
          })
        }
        const existing = index === -1 ? undefined : entries[index]!
        const wasLive = existing !== undefined
          && (existing.status === 'active' || existing.status === 'proposed')
        if (!wasLive && liveTeamMemoryEntries(entries).length >= TEAM_MEMORY_MAX_ENTRIES) {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Team memory already holds ${TEAM_MEMORY_MAX_ENTRIES} live entries (active or proposed)`,
            { limit: TEAM_MEMORY_MAX_ENTRIES },
          )
        }
        const entry: MemoryEntry = existing === undefined
          ? {
              id: entryId,
              scope: 'team',
              visibility: 'team-safe',
              status: 'active',
              source: 'user',
              ...(key === undefined ? {} : { key }),
              title,
              body: input.body,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            }
          : {
              ...existing,
              visibility: 'team-safe',
              status: 'active',
              source: 'user',
              ...(key === undefined ? {} : { key }),
              title,
              body: input.body,
              revision: existing.revision + 1,
              updatedAt: now,
            }
        if (existing === undefined) entries.push(entry)
        else entries[index] = entry
        const revision = (current.memory?.revision ?? 0) + 1
        let journal = current.memory?.journal
        const action: MemoryJournalAction = existing === undefined ? 'create' : 'update'
        journal = appendMemoryJournal(journal, {
          scope: 'team',
          actor: 'user',
          action,
          entryId: entry.id,
          reason: `${action} '${title}'`,
          before: existing === undefined ? null : memoryEntrySnapshot(existing),
          after: memoryEntrySnapshot(entry),
        }, revision, TEAM_MEMORY_JOURNAL_MAX_CHARS)
        if (key !== undefined) {
          for (let position = 0; position < entries.length; position += 1) {
            const other = entries[position]!
            if (other.id === entry.id || other.status !== 'active' || other.key !== key) continue
            const superseded: MemoryEntry = {
              ...other,
              status: 'superseded',
              revision: other.revision + 1,
              updatedAt: now,
            }
            entries[position] = superseded
            journal = appendMemoryJournal(journal, {
              scope: 'team',
              actor: 'user',
              action: 'supersede',
              entryId: other.id,
              reason: `superseded by '${title}'`,
              before: memoryEntrySnapshot(other),
              after: memoryEntrySnapshot(superseded),
            }, revision, TEAM_MEMORY_JOURNAL_MAX_CHARS)
          }
        }
        assertTeamMemoryBudget(entries)
        return {
          ...current,
          memory: { revision, entries, journal, updatedAt: now },
        }
      },
      'team.memory_written',
      `Team memory entry '${title}' written`,
    )
    return { memoryRevision: next.memory?.revision ?? 0, entry: requireTeamMemoryEntry(next, entryId) }
  }

  /**
   * User-authority decision on a member proposal. The human owner is not a
   * member, so the "cannot decide your own proposal" rule does not apply, but
   * the entry must still be pending. Accepting activates it and supersedes a
   * conflicting active entry with the same key; rejecting archives it.
   */
  async decideUserTeamMemory(
    teamId: string,
    entryId: string,
    decision: 'accept' | 'reject',
    options: { expectedMemoryRevision?: number } = {},
  ): Promise<TeamMemoryWriteView> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    const id = entryId.trim()
    if (id === '') {
      throw new AgentTeamError('INVALID_REQUEST', 'Memory entry id is required')
    }
    if (decision !== 'accept' && decision !== 'reject') {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown memory decision '${String(decision)}'`)
    }
    const expected = normalizeTeamMemoryRevision(options.expectedMemoryRevision)
    const now = new Date().toISOString()
    const next = await this.updateRuntimeTeam(
      teamId,
      current => {
        requireTeamMemoryRevision(expected, current.memory?.revision ?? 0)
        const entries = [...(current.memory?.entries ?? [])]
        const index = entries.findIndex(entry => entry.id === id)
        if (index === -1) {
          throw new AgentTeamError('INVALID_REQUEST', `Unknown team memory entry '${id}'`, { entryId: id })
        }
        const entry = entries[index]!
        if (entry.status !== 'proposed') {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            `Team memory entry '${id}' is ${entry.status}, not proposed`,
            { entryId: id, status: entry.status },
          )
        }
        const decided: MemoryEntry = {
          ...entry,
          status: decision === 'reject' ? 'archived' : 'active',
          revision: entry.revision + 1,
          updatedAt: now,
        }
        entries[index] = decided
        const revision = (current.memory?.revision ?? 0) + 1
        let journal = appendMemoryJournal(current.memory?.journal, {
          scope: 'team',
          actor: 'user',
          action: decision,
          entryId: decided.id,
          reason: `${decision} '${decided.title}'`,
          before: memoryEntrySnapshot(entry),
          after: memoryEntrySnapshot(decided),
        }, revision, TEAM_MEMORY_JOURNAL_MAX_CHARS)
        if (decision === 'accept' && decided.key !== undefined) {
          for (let position = 0; position < entries.length; position += 1) {
            const other = entries[position]!
            if (other.id === decided.id || other.status !== 'active' || other.key !== decided.key) continue
            const superseded: MemoryEntry = {
              ...other,
              status: 'superseded',
              revision: other.revision + 1,
              updatedAt: now,
            }
            entries[position] = superseded
            journal = appendMemoryJournal(journal, {
              scope: 'team',
              actor: 'user',
              action: 'supersede',
              entryId: other.id,
              reason: `superseded by '${decided.title}'`,
              before: memoryEntrySnapshot(other),
              after: memoryEntrySnapshot(superseded),
            }, revision, TEAM_MEMORY_JOURNAL_MAX_CHARS)
          }
        }
        return {
          ...current,
          memory: { revision, entries, journal, updatedAt: now },
        }
      },
      decision === 'accept' ? 'team.memory_accepted' : 'team.memory_rejected',
      `Team memory entry ${id} ${decision === 'accept' ? 'accepted' : 'rejected'}`,
    )
    return { memoryRevision: next.memory?.revision ?? 0, entry: requireTeamMemoryEntry(next, id) }
  }

  /**
   * Undo one journaled team-memory change. The record must live inside this
   * team's own aggregate and must be the change that produced the current
   * memory revision; an older record is `MEMORY_UNDO_STALE`. Redacted or
   * truncated records are `MEMORY_UNDO_UNAVAILABLE`, as is a restore that would
   * leave two active entries with one key. Undoing a create archives the entry.
   */
  async undoUserTeamMemory(
    teamId: string,
    journalId: string,
    options: { expectedMemoryRevision?: number } = {},
  ): Promise<TeamMemoryWriteView> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    const id = journalId.trim()
    if (id === '') throw new AgentTeamError('INVALID_REQUEST', 'Memory journal id is required')
    const expected = normalizeTeamMemoryRevision(options.expectedMemoryRevision)
    const now = new Date().toISOString()
    const undone: { entryId?: string } = {}
    const next = await this.updateRuntimeTeam(
      teamId,
      current => {
        const currentRevision = current.memory?.revision ?? 0
        if (expected !== undefined && expected !== currentRevision) {
          throw undoStale(expected, currentRevision)
        }
        const record = current.memory?.journal?.find(candidate => candidate.id === id)
        if (record === undefined) throw undoUnavailable(id, 'unknown journal entry')
        if (record.scope !== 'team') throw undoUnavailable(id, 'journal entry belongs to another scope')
        if (record.redacted === true) throw undoUnavailable(id, 'snapshot was redacted')
        if (record.trimmed === true) throw undoUnavailable(id, 'snapshot was truncated')
        if (record.revision !== currentRevision) throw undoStale(record.revision, currentRevision)
        const entries = [...(current.memory?.entries ?? [])]
        const index = entries.findIndex(entry => entry.id === record.entryId)
        if (index === -1) throw undoUnavailable(id, 'the entry no longer exists')
        const live = entries[index]!
        if (live.scope !== 'team') throw undoUnavailable(id, 'the entry belongs to another scope')
        const entry: MemoryEntry = record.before === null
          ? { ...live, status: 'archived', revision: live.revision + 1, updatedAt: now }
          : restoreMemoryEntry(live, record.before, now)
        if (
          entry.status === 'active'
          && entry.key !== undefined
          && entries.some(other => other.id !== entry.id
            && other.status === 'active'
            && other.key === entry.key)
        ) {
          throw undoUnavailable(id, 'restoring it would duplicate an active key')
        }
        entries[index] = entry
        const revision = currentRevision + 1
        undone.entryId = entry.id
        return {
          ...current,
          memory: {
            revision,
            entries,
            journal: restampJournalRevision(
              appendMemoryJournal(current.memory?.journal, {
                scope: 'team',
                actor: 'user',
                action: 'undo',
                entryId: entry.id,
                reason: `undo ${record.action} '${record.before?.title ?? record.after?.title ?? entry.title}'`,
                before: memoryEntrySnapshot(live),
                after: memoryEntrySnapshot(entry),
              }, revision, TEAM_MEMORY_JOURNAL_MAX_CHARS),
              currentRevision,
              revision,
              record.id,
            ),
            updatedAt: now,
          },
        }
      },
      'team.memory_undone',
      `Team memory journal '${id}' undone`,
    )
    if (undone.entryId === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', 'Team memory undo produced no entry')
    }
    return {
      memoryRevision: next.memory?.revision ?? 0,
      entry: requireTeamMemoryEntry(next, undone.entryId),
    }
  }

  /**
   * Opt-in capture after an explicit Goal completion. The atomic aggregate
   * update (the same serialized write path as every other team mutation)
   * re-reads the Goal and appends at most two `proposed`, `team-safe`,
   * `source=auto` entries: `goal:<id>` from objective/acceptance and
   * `goal-results:<id>` from up to three completed task results. Entries are
   * redacted, deduped by key and normalized text, and skipped when the entry or
   * character budget is full. The epoch fence is re-checked inside the closure.
   * No model is called and nothing is ever accepted; failures are swallowed.
   */
  async captureTeamGoalMemory(teamId: string, goalId: string, epoch?: number): Promise<boolean> {
    if (this.config.memoryAutoCapture !== true) return false
    const id = goalId.trim()
    if (id === '') return false
    const snapshot = this.store.getTeam(teamId)
    const goal = snapshot?.goals?.[id]
    if (snapshot === undefined || goal === undefined || goal.status !== 'completed') return false
    // The aggregate update below always bumps the team revision and writes an
    // activity record. Skip it entirely when every candidate is already
    // captured or over budget; the closure re-checks under the write lock.
    if (!acceptsTeamCaptureCandidates(
      snapshot,
      goalCaptureEntries(goal, snapshot.tasks, new Date().toISOString()),
    )) return false
    const captured = { count: 0 }
    try {
      await this.updateRuntimeTeam(
        teamId,
        current => {
          const goal = current.goals?.[id]
          if (goal === undefined || goal.status !== 'completed') return current
          const now = new Date().toISOString()
          const candidates = goalCaptureEntries(goal, current.tasks, now)
          const entries = [...(current.memory?.entries ?? [])]
          const knownKeys = new Set(entries.flatMap(entry => entry.key === undefined ? [] : [entry.key]))
          const knownText = new Set(entries.map(entry => memoryDedupeKey(entry)))
          const revision = (current.memory?.revision ?? 0) + 1
          let journal = current.memory?.journal
          for (const candidate of candidates) {
            if (candidate.key === undefined) continue
            if (knownKeys.has(candidate.key)) continue
            const dedupe = memoryDedupeKey(candidate)
            if (knownText.has(dedupe)) continue
            if (liveTeamMemoryEntries(entries).length >= TEAM_MEMORY_MAX_ENTRIES) break
            entries.push(candidate)
            if (liveTeamMemoryChars(entries) > TEAM_MEMORY_MAX_CHARS) {
              entries.pop()
              break
            }
            knownKeys.add(candidate.key)
            knownText.add(dedupe)
            captured.count += 1
            journal = appendMemoryJournal(journal, {
              scope: 'team',
              actor: 'auto',
              action: 'create',
              entryId: candidate.id,
              reason: `captured from completed goal '${boundCapturedText(goal.title, MEMORY_CAPTURE_MAX_TITLE_CHARS)}'`,
              before: null,
              after: memoryEntrySnapshot(candidate),
            }, revision, TEAM_MEMORY_JOURNAL_MAX_CHARS)
          }
          if (captured.count === 0) return current
          return {
            ...current,
            memory: { revision, entries, journal, updatedAt: now },
          }
        },
        'team.memory_captured',
        `Goal ${id} memory captured`,
        epoch === undefined ? {} : { expectedEpoch: epoch },
      )
    } catch (error) {
      this.ctx.logger.warn(`dsh-team-mode: goal memory capture failed for '${teamId}'`, error)
      return false
    }
    return captured.count > 0
  }

  /**
   * Create a draft team. Assistant instance links named by `members[]` are
   * validated pre-write only: the aggregate does not exist yet, so there is no
   * record whose atomic update could re-check them. `addMemberWithSlot` and
   * `setMemberAssistantInstance` both re-check inside `store.updateTeam`; a
   * concurrent creation can therefore win a workspace-uniqueness race, which is
   * documented as best-effort (no global lock).
   */
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
    // A brand-new team is not stored yet, so its link scope uses an empty team
    // id; every existing team is still checked for an existing link.
    const linkScope: AssistantInstanceLinkScope = {
      teamId: '',
      workspaceId: String(workspace.id),
      workspacePath: workspace.path,
      members,
    }
    let leaderSlotId = ''
    for (const item of input.members) {
      const assistant = requireAssistant(this.store, item.assistantId)
      // A policy id must exist in deployment config at creation time; the
      // persisted id is re-resolved on every activation.
      resolveMemberToolPolicy(this.config.toolPolicies, item.toolPolicy)
      const assistantInstanceId = item.assistantInstanceId === undefined
        ? undefined
        : this.requireLinkableAssistantInstance(linkScope, item.assistantInstanceId).id
      const slotId = randomUUID()
      members[slotId] = {
        id: slotId,
        assistantId: assistant.id,
        ...(assistantInstanceId === undefined ? {} : { assistantInstanceId }),
        displayName: assistant.name,
        role: item.role,
        assistantSnapshot: snapshotAssistant(assistant),
        permissionPresetId: assistant.permissionPresetId,
        ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
        ...(item.toolPolicy === undefined ? {} : { toolPolicy: item.toolPolicy }),
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

  /**
   * Change the Leader. This is the only writer of `epoch`: a Leader change is a
   * new leadership generation, so every Session activated under the previous
   * epoch is archived instead of being silently reparented.
   *
   * A draft team has never activated a Session, so the swap is one aggregate
   * write. A running team goes through the runtime transition, which disposes
   * the old handles and re-reads the revision inside its exclusive lock (a
   * double-click cannot stack two epoch bumps).
   */
  async changeLeader(
    teamId: string,
    successorSlotId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const current = requireTeam(this.store, teamId)
    assertTeamMutable(current)
    assertRevision('team', current.revision, options.expectedRevision)
    const successor = current.members[successorSlotId]
    if (successor === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${successorSlotId}'`)
    }
    if (current.leaderSlotId === successorSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'The selected member is already the team leader')
    }
    if (current.state !== 'draft') {
      return this.requireRuntime().changeLeaderEpoch(teamId, successorSlotId, options)
    }
    const epoch = epochOf(current) + 1
    const next = await this.updateRuntimeTeam(
      teamId,
      team => {
        // Re-check inside the serialized write: a queued second click would
        // otherwise bump a draft's epoch twice.
        assertRevision('team', team.revision, options.expectedRevision)
        return {
          ...team,
          epoch,
          members: Object.fromEntries(Object.entries(team.members).map(([slotId, member]) => [
            slotId,
            { ...member, role: slotId === successorSlotId ? 'leader' : 'member' },
          ])),
          leaderSlotId: successorSlotId,
          memberOrder: [
            successorSlotId,
            ...(team.memberOrder ?? Object.keys(team.members)).filter(id => id !== successorSlotId),
          ],
        }
      },
      'team.leader_changed',
      `Team leader changed to ${successor.displayName} (epoch ${epoch})`,
    )
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
    resolveMemberToolPolicy(this.config.toolPolicies, input.toolPolicy)
    const displayName = normalizeMemberDisplayName(input.displayName ?? assistant.name)
    if (input.displayName !== undefined) assertMemberDisplayNameAvailable(team, displayName)
    const assistantInstanceId = input.assistantInstanceId === undefined
      ? undefined
      : this.requireLinkableAssistantInstance(linkScopeOf(team), input.assistantInstanceId).id
    const now = new Date().toISOString()
    const member = createMemberSlot(
      assistant,
      displayName,
      'member',
      now,
      team.state === 'draft' ? 'offline' : 'online',
      assistantInstanceId,
      input.toolPolicy,
    )
    const next = await this.store.updateTeam(teamId, current => {
      // Re-check inside the atomic update: another team may have linked the
      // instance after the pre-check. The new slot id is not in `current` yet,
      // so it can never be excluded accidentally.
      if (assistantInstanceId !== undefined) {
        this.requireLinkableAssistantInstance(linkScopeOf(current), assistantInstanceId, member.id)
      }
      return {
        ...current,
        members: { ...current.members, [member.id]: member },
        memberOrder: [...(current.memberOrder ?? Object.keys(current.members)), member.id],
        revision: current.revision + 1,
        updatedAt: now,
      }
    })
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
   * Link or unlink one member to an Assistant instance. The link is explicit:
   * nothing is inferred from the member's template id or from the workspace.
   * `null` clears it and an unchanged value is a no-op. The link is validated
   * again inside the atomic team update so a concurrent link cannot slip in
   * between the pre-check and the write.
   */
  async setMemberAssistantInstance(
    teamId: string,
    slotId: string,
    rawAssistantInstanceId: string | null,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const link = memberAssistantInstanceLinkSchema.parse(rawAssistantInstanceId)
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (link === null) {
      if (member.assistantInstanceId === undefined) return team
    } else {
      this.requireLinkableAssistantInstance(linkScopeOf(team), link, slotId)
      if (member.assistantInstanceId === link) return team
    }
    const next = await this.store.updateTeam(teamId, current => {
      const currentMember = current.members[slotId]
      if (currentMember === undefined) {
        throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      }
      if (link !== null) this.requireLinkableAssistantInstance(linkScopeOf(current), link, slotId)
      return {
        ...current,
        members: {
          ...current.members,
          [slotId]: withAssistantInstanceId(currentMember, link),
        },
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }
    })
    await this.activity(
      'team.member_assistant_linked',
      teamId,
      next.revision,
      link === null
        ? `Member ${member.displayName} assistant link cleared`
        : `Member ${member.displayName} linked to assistant instance ${link}`,
    )
    this.publish('team', teamId, next.revision, 'team.member_assistant_linked')
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

  /**
   * Runtime-aware thread creation: the Session is created and attached in the
   * team Workspace through the shared thread Session factory before the record
   * is written, so the transport never records a Session the Host never made.
   * The runtime defaults the speaker to the Leader.
   */
  async createTeamThread(teamId: string, options: MutationOptions = {}): Promise<TeamAggregate> {
    return this.requireRuntime().createThread(teamId, options)
  }

  /**
   * Create one team thread. The thread is a new conversation layer under the
   * team: it owns a freshly minted `sessionId` (the same id-first path a member
   * Session takes; the runtime materializes it), and it never touches any
   * member's `sessionId`. A caller that already created the Session (the
   * runtime's session factory) may pass its id instead of letting this mint one.
   */
  async createThread(
    teamId: string,
    input: CreateTeamThreadInput = {},
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    const sessionId = input.sessionId?.trim() ?? ''
    if (sessionId !== '') requireUnusedThreadSession(team, sessionId)
    const speakerSlotId = input.speakerSlotId?.trim() ?? ''
    if (speakerSlotId !== '' && team.members[speakerSlotId] === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown thread speaker '${speakerSlotId}'`, {
        teamId,
        speakerSlotId,
      })
    }
    const requestedTitle = input.title === undefined ? '' : requireThreadTitle(input.title)
    const now = Date.now()
    const threadId = `thread-${randomUUID()}`
    const next = await this.store.updateTeam(teamId, current => {
      const threads = { ...(current.threads ?? {}) }
      threads[threadId] = {
        id: threadId,
        title: requestedTitle === '' ? `新对话 ${Object.keys(threads).length + 1}` : requestedTitle,
        sessionId: sessionId === '' ? `session-${randomUUID()}` : sessionId,
        ...(speakerSlotId === '' ? {} : { speakerSlotId }),
        createdAt: now,
        updatedAt: now,
      }
      return {
        ...current,
        threads,
        revision: current.revision + 1,
        updatedAt: new Date(now).toISOString(),
      }
    })
    await this.activity('team.thread_created', teamId, next.revision, 'Thread created')
    this.publish('team', teamId, next.revision, 'team.thread_created')
    return next
  }

  /**
   * Rename one active thread. Only the thread's `title` and `updatedAt` change:
   * its Session, its speaker, and every member Session stay exactly as they are.
   */
  async renameThread(
    teamId: string,
    threadId: string,
    rawTitle: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    requireThread(team, threadId)
    const title = requireThreadTitle(rawTitle)
    if (team.threads?.[threadId]?.title === title) return team
    const now = Date.now()
    const next = await this.store.updateTeam(teamId, current => {
      const thread = requireThread(current, threadId)
      return {
        ...current,
        threads: { ...(current.threads ?? {}), [threadId]: { ...thread, title, updatedAt: now } },
        revision: current.revision + 1,
        updatedAt: new Date(now).toISOString(),
      }
    })
    await this.activity('team.thread_renamed', teamId, next.revision, `Thread renamed to ${title}`)
    this.publish('team', teamId, next.revision, 'team.thread_renamed')
    return next
  }

  /**
   * Archive one thread off the active list. Same semantics as member
   * archiving: the record moves to `retiredThreads` instead of being deleted, so
   * its Session id stays known to `listTeamSessionIds` until the team goes away.
   */
  async archiveThread(
    teamId: string,
    threadId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    requireThread(team, threadId)
    const now = Date.now()
    const next = await this.store.updateTeam(teamId, current => {
      const thread = requireThread(current, threadId)
      const threads = { ...(current.threads ?? {}) }
      delete threads[threadId]
      return {
        ...current,
        threads,
        retiredThreads: { ...(current.retiredThreads ?? {}), [threadId]: thread },
        revision: current.revision + 1,
        updatedAt: new Date(now).toISOString(),
      }
    })
    await this.activity('team.thread_archived', teamId, next.revision, 'Thread archived; Session retained')
    this.publish('team', teamId, next.revision, 'team.thread_archived')
    return next
  }

  /**
   * Every Session this team owns: member Sessions, retired member Sessions, and
   * both live and archived thread Sessions. Dissolution sweeps exactly this set,
   * so a thread's Session can never be orphaned by leaving it out.
   */
  listTeamSessionIds(teamId: string): string[] {
    const team = requireTeam(this.store, teamId)
    return [...new Set([
      ...Object.values(team.members).map(member => member.sessionId),
      ...Object.keys(team.retiredSessions),
      ...Object.values(team.threads ?? {}).map(thread => thread.sessionId),
      ...Object.values(team.retiredThreads ?? {}).map(thread => thread.sessionId),
    ])]
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

  /**
   * Set the user-authored announcement for the whole team, or clear it with
   * blank text. This is the only write path: no agent tool accepts an
   * announcement, so a member cannot post a standing notice for everyone else.
   * The text is prompt context for every member and every team thread, so it is
   * refused over the cap instead of truncated, and blank text removes the field
   * entirely instead of storing an empty string. The fence here is the
   * user-transport boundary, not the aggregate revision (same precedent as the
   * group brief), so a stale panel edit still lands on the latest record.
   */
  async setTeamAnnouncement(teamId: string, announcement: string): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    const text = announcement.trim()
    if (text.length > TEAM_ANNOUNCEMENT_MAX_CHARS) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Team announcement exceeds ${TEAM_ANNOUNCEMENT_MAX_CHARS} characters`,
        { length: text.length, limit: TEAM_ANNOUNCEMENT_MAX_CHARS },
      )
    }
    if ((team.announcement ?? '') === text) return team
    return this.updateRuntimeTeam(
      teamId,
      current => {
        const { announcement: _previous, ...rest } = current
        return text === '' ? rest : { ...rest, announcement: text }
      },
      'team.announcement',
      text === '' ? 'Team announcement cleared' : 'Team announcement updated',
    )
  }

  /**
   * Move a team into a sidebar group, or back to ungrouped with `null`/blank.
   * `group` is only a label; the group itself must exist in the ordered list, so
   * a move can never invent a group that no one can see or delete.
   */
  async setTeamGroup(
    teamId: string,
    group: string | null,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    const next = normalizeSidebarGroup(group)
    this.assertKnownGroup(next)
    return this.updateRuntimeTeam(
      teamId,
      current => {
        const { group: _previous, ...rest } = current
        return {
          ...rest,
          ...(next === undefined ? {} : { group: next }),
        }
      },
      'team.group',
      next === undefined ? 'Team group cleared' : `Team moved to group ${next}`,
    )
  }

  /**
   * The sidebar group list lives in its own store slice, probed exactly like
   * `escalationStore`, so a store double written before groups existed stays
   * valid. A store without the slice has no groups and cannot create one.
   */
  private get sidebarGroupStore(): AgentTeamSidebarGroupStore | undefined {
    const store = this.store as Partial<AgentTeamSidebarGroupStore>
    return 'getSidebarGroups' in store ? store as AgentTeamSidebarGroupStore : undefined
  }

  /** Ordered group labels; empty for a store that never created one. */
  listGroups(): string[] {
    return this.groupRecords().map(record => record.name)
  }

  /**
   * Full group records for the sidebar editor, including the user-authored
   * brief. Copies are returned so a caller cannot mutate the store row.
   */
  listGroupBriefs(): SidebarGroupRecord[] {
    return this.groupRecords().map(record => ({ ...record }))
  }

  /**
   * The current brief for one group. Read live on every prompt assembly, so an
   * edit lands on the member's next turn. Unknown or ungrouped reads as empty,
   * which contributes no prompt section.
   */
  groupBriefFor(group: string | undefined): string {
    if (group === undefined) return ''
    return this.groupRecords().find(record => record.name === group)?.brief ?? ''
  }

  private groupRecords(): SidebarGroupRecord[] {
    return this.sidebarGroupStore?.getSidebarGroups()?.groups ?? []
  }

  async createGroup(name: string): Promise<string[]> {
    const label = requireGroupLabel(name)
    const groups = this.groupRecords()
    if (groups.some(record => record.name === label)) {
      throw new AgentTeamError('INVALID_REQUEST', `Group '${label}' already exists`, { group: label })
    }
    if (groups.length >= SIDEBAR_GROUP_MAX_COUNT) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `At most ${SIDEBAR_GROUP_MAX_COUNT} sidebar groups are allowed`,
        { limit: SIDEBAR_GROUP_MAX_COUNT },
      )
    }
    const now = new Date().toISOString()
    return this.namesOf(await this.writeGroups([
      ...groups,
      { name: label, brief: '', memoryKey: randomUUID(), updatedAt: now },
    ]))
  }

  /**
   * Rename a group and every member that points at it. The member writes run
   * first and the list last: a failed list write leaves members on the old
   * label, which still exists, instead of on a label nobody can see. The brief
   * and `memoryKey` ride along, so a rename never loses the group's brief.
   */
  async renameGroup(from: string, to: string): Promise<string[]> {
    const previous = requireGroupLabel(from)
    const label = requireGroupLabel(to)
    const groups = this.groupRecords()
    const names = this.namesOf(groups)
    if (!names.includes(previous)) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown group '${previous}'`, { group: previous })
    }
    if (previous === label) return names
    if (names.includes(label)) {
      throw new AgentTeamError('INVALID_REQUEST', `Group '${label}' already exists`, { group: label })
    }
    await this.moveGroupMembers(previous, label)
    const now = new Date().toISOString()
    return this.namesOf(await this.writeGroups(groups.map(record => record.name === previous
      ? { ...record, name: label, updatedAt: now }
      : record)))
  }

  /** Delete a group; its members fall back to ungrouped. */
  async deleteGroup(name: string): Promise<string[]> {
    const label = requireGroupLabel(name)
    const groups = this.groupRecords()
    if (!groups.some(record => record.name === label)) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown group '${label}'`, { group: label })
    }
    await this.moveGroupMembers(label, undefined)
    return this.namesOf(await this.writeGroups(groups.filter(record => record.name !== label)))
  }

  /** Reorder the list; `names` must be exactly the existing groups. */
  async setGroupOrder(names: readonly string[]): Promise<string[]> {
    const groups = this.groupRecords()
    const unique = names.map(name => requireGroupLabel(name))
    const existing = this.namesOf(groups)
    const valid = unique.length === groups.length
      && new Set(unique).size === unique.length
      && unique.every(name => existing.includes(name))
    if (!valid) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        'Group order must list every existing group exactly once',
        { groups: existing },
      )
    }
    const byName = new Map(groups.map(record => [record.name, record]))
    return this.namesOf(await this.writeGroups(
      unique.map(name => byName.get(name) as SidebarGroupRecord),
    ))
  }

  /**
   * Set the user-authored brief for one group. This is the only write path:
   * no agent tool accepts a group brief, so a member cannot seed instructions
   * for everyone else. An empty string clears the brief; over-long text is
   * refused instead of truncated.
   */
  async setGroupBrief(name: string, brief: string): Promise<SidebarGroupRecord> {
    const label = requireGroupLabel(name)
    const text = requireGroupBrief(brief)
    const groups = this.groupRecords()
    const index = groups.findIndex(record => record.name === label)
    if (index === -1) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown group '${label}'`, { group: label })
    }
    const current = groups[index] as SidebarGroupRecord
    if (current.brief === text) return { ...current }
    const now = new Date().toISOString()
    const next = groups.map((record, at) => at === index ? { ...record, brief: text, updatedAt: now } : record)
    const written = await this.writeGroups(next)
    return { ...(written[index] as SidebarGroupRecord) }
  }

  /** Reject a group label that was never created; clearing is always legal. */
  private assertKnownGroup(group: string | undefined): void {
    if (group === undefined || this.listGroups().includes(group)) return
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Unknown group '${group}'; create it before moving anything into it`,
      { group },
    )
  }

  private namesOf(groups: readonly SidebarGroupRecord[]): string[] {
    return groups.map(record => record.name)
  }

  private async writeGroups(groups: SidebarGroupRecord[]): Promise<SidebarGroupRecord[]> {
    const store = this.sidebarGroupStore
    if (store === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', 'This store cannot persist sidebar groups')
    }
    const value: SidebarGroups = {
      schemaVersion: 2,
      groups,
      revision: (store.getSidebarGroups()?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    }
    await store.putSidebarGroups(value)
    this.publish('catalog', 'sidebar-groups', value.revision, 'sidebar.groups.changed')
    return groups
  }

  /** Rewrite every member of one group, teams first then Assistant instances. */
  private async moveGroupMembers(from: string, to: string | undefined): Promise<void> {
    const now = new Date().toISOString()
    for (const team of this.store.listTeams()) {
      if (team.group !== from) continue
      const next = await this.store.updateTeam(team.id, current => {
        const { group: _previous, ...rest } = current
        return {
          ...rest,
          ...(to === undefined ? {} : { group: to }),
          revision: current.revision + 1,
          updatedAt: now,
        }
      })
      this.publish('team', next.id, next.revision, 'team.group')
    }
    for (const instance of this.store.listAssistantInstances()) {
      if (instance.group !== from) continue
      const next = await this.store.updateAssistantInstance(instance.id, current => {
        const { group: _previous, ...rest } = current
        return {
          ...rest,
          ...(to === undefined ? {} : { group: to }),
          revision: current.revision + 1,
          updatedAt: now,
        }
      })
      this.publish('assistant-instance', next.id, next.revision, 'assistant.instance.updated')
    }
  }

  /**
   * Snapshot one group as a portable document. Read-only, and deliberately
   * narrow: no ids, sessions, memory, conversations, avatars or workspace
   * bindings travel (see `domain/group-share.ts`). Archived teams and archived
   * Assistant instances are left out; the caller sees only what can come back.
   */
  exportGroup(name: string): GroupExportDocument {
    const label = requireGroupLabel(name)
    const record = this.groupRecords().find(item => item.name === label)
    if (record === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown group '${label}'`, { group: label })
    }
    const assistants = this.store.listAssistantInstances()
      .filter(instance => instance.group === label && instance.status !== 'archived')
      .sort((left, right) => left.assistantSnapshot.name.localeCompare(right.assistantSnapshot.name)
        || left.id.localeCompare(right.id))
      .map(instance => this.portableAssistantEntry(instance))
    const teams = this.store.listTeams()
      .filter(team => team.group === label
        && team.archivedAt === undefined
        && team.state !== 'deleting'
        && team.state !== 'delete_blocked')
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map(team => ({
        name: team.name,
        directMemberChat: team.directMemberChat,
        members: orderedTeamMembers(team).map(member => this.portableTeamMember(member)),
      }))
    const document: GroupExportDocument = {
      kind: GROUP_SHARE_KIND,
      schemaVersion: GROUP_SHARE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      group: { name: record.name, brief: record.brief },
      assistants,
      teams,
      skills: uniqueSorted([
        ...assistants.flatMap(entry => entry.profile.skillAllowlist),
        ...teams.flatMap(team => team.members.flatMap(member => member.profile.skillAllowlist)),
      ]),
      mcpServers: uniqueSorted([
        ...assistants.flatMap(entry => entry.profile.mcpServers),
        ...teams.flatMap(team => team.members.flatMap(member => member.profile.mcpServers)),
      ]),
    }
    // Parsing our own output is the cheapest guarantee that the document can
    // come back: a name or persona this format cannot carry is refused here
    // with its field path instead of failing on the importing machine.
    const parsed = groupExportDocumentSchema.safeParse(document)
    if (!parsed.success) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Group '${label}' cannot be exported — ${portableIssue(parsed.error)}`,
        { group: label, issues: portableIssues(parsed.error) },
      )
    }
    const bytes = portableDocumentBytes(parsed.data)
    if (bytes > GROUP_SHARE_MAX_DOCUMENT_BYTES) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `Group '${label}' exports ${bytes} bytes, above the ${GROUP_SHARE_MAX_DOCUMENT_BYTES}-byte `
        + `portable limit; largest fields: ${largestPortableFields(parsed.data).join(', ') || 'none'}`,
        { group: label, bytes, limit: GROUP_SHARE_MAX_DOCUMENT_BYTES },
      )
    }
    return parsed.data
  }

  /**
   * Compute what an import would do, without writing anything. The returned
   * plan is also the fence: `importGroup` recomputes it and refuses a document
   * whose plan no longer hashes to the previewed one.
   */
  async previewGroupImport(rawDocument: unknown, workspaceId: string): Promise<GroupImportPreview> {
    const document = this.parsePortableGroupDocument(rawDocument)
    const targetWorkspaceId = await this.requireImportWorkspace(workspaceId)
    const plan = await this.buildGroupImportPlan(document)
    return { ...plan, planHash: groupImportPlanHash(document, plan) }
  }

  /**
   * Apply a previewed document, one item at a time. Nothing is written before
   * the whole document parses and the plan hash matches; after that there is no
   * rollback, so a failure leaves the new group partially filled and the report
   * says exactly what landed (created/reused/skipped/rejected with a reason).
   * Existing groups and Assistants are never modified: a name collision only
   * earns a ` (2)` suffix.
   */
  async importGroup(
    rawDocument: unknown,
    workspaceId: string,
    expectedPlanHash: string,
  ): Promise<GroupImportResult> {
    const document = this.parsePortableGroupDocument(rawDocument)
    const targetWorkspaceId = await this.requireImportWorkspace(workspaceId)
    const plan = await this.buildGroupImportPlan(document)
    const planHash = groupImportPlanHash(document, plan)
    // `errors.ts` is outside this change's file scope, so the fence reuses
    // INVALID_REQUEST with an explicit "preview again" message instead of a new
    // STALE_PREVIEW code; the web transport answers 400 either way.
    if (expectedPlanHash.trim() !== planHash) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        'The import preview is out of date; preview this document again before importing',
        { expectedPlanHash: expectedPlanHash.trim(), planHash },
      )
    }
    return this.applyGroupImport(document, { ...plan, planHash }, targetWorkspaceId)
  }

  /** One Assistant-instance row: portable profile plus the row-only preferences. */
  private portableAssistantEntry(instance: AssistantInstance): PortableAssistantEntry {
    return {
      profile: portableProfileFromSnapshot(instance.assistantSnapshot),
      ...(instance.mascot === undefined ? {} : { mascot: instance.mascot }),
      ...(instance.memoryAutoCapture === undefined ? {} : { memoryAutoCapture: instance.memoryAutoCapture }),
    }
  }

  /** One team-member row: the template materialization input plus slot values. */
  private portableTeamMember(member: TeamMemberSlot): PortableTeamMember {
    return {
      displayName: member.displayName,
      role: member.role,
      profile: portableProfileFromSnapshot(member.assistantSnapshot),
      permissionPresetId: member.permissionPresetId,
      ...(member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort }),
    }
  }

  /** Refuse a document before any schema work: size first, then shape. */
  private parsePortableGroupDocument(raw: unknown): GroupExportDocument {
    let bytes: number
    try {
      bytes = portableDocumentBytes(raw)
    } catch {
      throw new AgentTeamError('INVALID_REQUEST', 'The import document is not JSON serializable')
    }
    if (bytes > GROUP_SHARE_MAX_DOCUMENT_BYTES) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `The import document is ${bytes} bytes, above the ${GROUP_SHARE_MAX_DOCUMENT_BYTES}-byte portable limit`,
        { bytes, limit: GROUP_SHARE_MAX_DOCUMENT_BYTES },
      )
    }
    const parsed = groupExportDocumentSchema.safeParse(raw)
    if (!parsed.success) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `The import document is not a portable group export — ${portableIssue(parsed.error)}`,
        { issues: portableIssues(parsed.error) },
      )
    }
    return parsed.data
  }

  /** One workspace for the whole import: workspace ids and paths are not portable. */
  private async requireImportWorkspace(workspaceId: string): Promise<string> {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${workspaceId}' is unavailable`)
    }
    return String(workspace.id)
  }

  /**
   * Turn a document into the exact write plan: conflict-suffixed names, rows
   * this machine cannot honour skipped with a reason, references it cannot
   * resolve dropped with a warning. Pure with respect to the store — the only
   * reads are the catalogs and the current names.
   */
  private async buildGroupImportPlan(
    document: GroupExportDocument,
  ): Promise<Omit<GroupImportPreview, 'planHash'>> {
    const groupNames = this.listGroups()
    if (groupNames.length >= SIDEBAR_GROUP_MAX_COUNT) {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        `At most ${SIDEBAR_GROUP_MAX_COUNT} sidebar groups are allowed; delete one before importing`,
        { limit: SIDEBAR_GROUP_MAX_COUNT },
      )
    }
    const plannedGroupName = uniqueName(document.group.name, groupNames, SIDEBAR_GROUP_MAX_CHARS)
    const cache: ImportCatalogCache = {
      presets: new Map(),
      efforts: new Map(),
      skills: new Map(),
      mcpServers: new Map(),
    }
    const warnings: string[] = [
      // The format never carries avatar photo bytes; say so before the user
      // wonders why the imported Assistants look different.
      'Portable documents carry mascot identities, not avatar photos; imported Assistants fall back to their mascot or initials.',
    ]
    const skillAvailability = new Map<string, boolean>()
    const mcpAvailability = new Map<string, boolean>()

    const takenInstances = new Set(
      this.store.listAssistantInstances().map(instance => instance.assistantSnapshot.name),
    )
    const assistants: GroupImportAssistantPlan[] = []
    for (const entry of document.assistants) {
      const resolved = await this.resolvePortableProfile(entry.profile, cache)
      if (!resolved.ok) {
        assistants.push({
          name: entry.profile.name,
          plannedName: entry.profile.name,
          action: 'skip',
          reason: resolved.reason,
        })
        warnings.push(`Assistant '${entry.profile.name}' skipped: ${resolved.reason}`)
        continue
      }
      const plannedName = uniqueName(resolved.profile.name, takenInstances, GROUP_SHARE_NAME_MAX_CHARS)
      takenInstances.add(plannedName)
      markAvailability(skillAvailability, entry.profile.skillAllowlist, resolved.dropped.skills)
      markAvailability(mcpAvailability, entry.profile.mcpServers, resolved.dropped.mcpServers)
      const warning = droppedWarning(`Assistant '${entry.profile.name}'`, resolved.dropped)
      if (warning !== undefined) warnings.push(warning)
      assistants.push({
        name: entry.profile.name,
        plannedName,
        action: 'create',
        profile: resolved.profile,
        ...(entry.mascot === undefined ? {} : { mascot: entry.mascot }),
        ...(entry.memoryAutoCapture === undefined ? {} : { memoryAutoCapture: entry.memoryAutoCapture }),
        ...(hasDropped(resolved.dropped) ? { dropped: resolved.dropped } : {}),
      })
    }

    const takenTeams = new Set(this.store.listTeams().map(team => team.name))
    const takenTemplates = new Set(this.store.listAssistants().map(assistant => assistant.name))
    const templates: GroupImportTemplatePlan[] = []
    const teams: GroupImportTeamPlan[] = []
    const memberLimit = this.config.maxTeamMembers ?? 8
    for (const team of document.teams) {
      const skip = (reason: string): void => {
        teams.push({ name: team.name, plannedName: team.name, action: 'skip', reason, members: [] })
        warnings.push(`Team '${team.name}' skipped: ${reason}`)
      }
      if (team.members.length > memberLimit) {
        skip(`it has ${team.members.length} members and this deployment allows ${memberLimit}`)
        continue
      }
      const leaders = team.members.filter(member => member.role === 'leader')
      if (leaders.length !== 1) {
        skip(`it declares ${leaders.length} leaders; exactly one is required`)
        continue
      }
      // Resolve the whole roster before creating anything: a half-valid team
      // must not be materialized and then abandoned.
      const roster: Array<{
        member: PortableTeamMember
        profile: PortableAssistantProfile
        dropped: GroupImportDropped
      }> = []
      let failure: string | undefined
      for (const member of team.members) {
        const resolved = await this.resolvePortableProfile(member.profile, cache)
        if (!resolved.ok) {
          failure = `member '${member.displayName}': ${resolved.reason}`
          break
        }
        const permissionPresetId = (member.permissionPresetId ?? resolved.profile.permissionPresetId).trim()
        if (!this.ctx.permissionPresets.names.includes(permissionPresetId)) {
          failure = `member '${member.displayName}': unknown permission preset '${permissionPresetId}'`
          break
        }
        roster.push({ member, profile: resolved.profile, dropped: resolved.dropped })
      }
      if (failure !== undefined) {
        skip(failure)
        continue
      }
      const memberPlans: GroupImportMemberPlan[] = []
      const takenMemberNames = new Set<string>()
      for (const { member, profile, dropped } of roster) {
        const template = this.templatePlanFor(profile, templates, takenTemplates)
        const displayName = uniqueName(member.displayName, takenMemberNames, GROUP_SHARE_NAME_MAX_CHARS)
        takenMemberNames.add(displayName)
        const permissionPresetId = (member.permissionPresetId ?? profile.permissionPresetId).trim()
        // A member's availability is the same policy as an Assistant row's, so
        // every reference it names is marked here too — a team-only document
        // must not report an empty skill/MCP list.
        markAvailability(skillAvailability, member.profile.skillAllowlist, dropped.skills)
        markAvailability(mcpAvailability, member.profile.mcpServers, dropped.mcpServers)
        const efforts = cache.efforts.get(`${profile.provider}/${profile.model}`) ?? []
        const requestedEffort = member.reasoningEffort ?? profile.reasoningEffort
        const reasoningEffort = requestedEffort !== undefined && efforts.includes(requestedEffort)
          ? requestedEffort
          : undefined
        // The member loses what its template loses, plus any slot override the
        // model cannot do. Both are reported instead of letting the cleaned
        // profile look like the document never asked for them.
        const memberDropped: GroupImportDropped = { ...dropped }
        if (member.reasoningEffort !== undefined && reasoningEffort === undefined) {
          memberDropped.reasoningEffort = member.reasoningEffort
        }
        const warning = droppedWarning(`Team '${team.name}' member '${displayName}'`, memberDropped)
        if (warning !== undefined) warnings.push(warning)
        memberPlans.push({
          displayName,
          role: member.role,
          templateName: template.plannedName,
          permissionPresetId,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(hasDropped(memberDropped) ? { dropped: memberDropped } : {}),
        })
      }
      const plannedName = uniqueName(team.name, takenTeams, GROUP_SHARE_NAME_MAX_CHARS)
      takenTeams.add(plannedName)
      teams.push({
        name: team.name,
        plannedName,
        action: 'create',
        ...(team.directMemberChat === undefined ? {} : { directMemberChat: team.directMemberChat }),
        members: memberPlans,
      })
    }

    const createdTeams = teams.filter(team => team.action === 'create')
    return {
      schemaVersion: 1,
      group: {
        requested: document.group.name,
        plannedName: plannedGroupName,
        renamed: plannedGroupName !== document.group.name,
        briefChars: document.group.brief.length,
      },
      assistants,
      templates,
      teams,
      skills: availabilityList(skillAvailability),
      mcpServers: availabilityList(mcpAvailability),
      warnings,
      counts: {
        assistants: assistants.filter(row => row.action === 'create').length,
        templates: templates.filter(row => row.action === 'create').length,
        teams: createdTeams.length,
        members: createdTeams.reduce((total, team) => total + team.members.length, 0),
        skipped: assistants.filter(row => row.action === 'skip').length
          + teams.filter(team => team.action === 'skip').length,
      },
    }
  }

  /**
   * One Assistant template per distinct portable profile: an exact local match
   * is reused (importing twice must not double the library), anything else gets
   * a conflict-suffixed name of its own.
   */
  private templatePlanFor(
    profile: PortableAssistantProfile,
    plans: GroupImportTemplatePlan[],
    taken: Set<string>,
  ): GroupImportTemplatePlan {
    const planned = plans.find(candidate => samePortableProfile(candidate.profile, profile))
    if (planned !== undefined) return planned
    const existing = this.findPortableTemplate(profile)
    if (existing !== undefined) {
      const reuse: GroupImportTemplatePlan = {
        name: profile.name,
        plannedName: existing.name,
        action: 'reuse',
        profile,
      }
      plans.push(reuse)
      return reuse
    }
    const plannedName = uniqueName(profile.name, taken, GROUP_SHARE_NAME_MAX_CHARS)
    taken.add(plannedName)
    const create: GroupImportTemplatePlan = {
      name: profile.name,
      plannedName,
      action: 'create',
      profile,
    }
    plans.push(create)
    return create
  }

  /** The local Assistant template whose portable profile matches exactly. */
  private findPortableTemplate(profile: PortableAssistantProfile): AssistantTemplate | undefined {
    return this.store.listAssistants().find(assistant => samePortableProfile(
      portableProfileFromSnapshot(snapshotAssistant(assistant)),
      profile,
    ))
  }

  /**
   * Decide whether one portable profile can land here: model, agent preset and
   * permission preset must resolve (else the row is skipped), while skill and
   * MCP references this machine cannot resolve are dropped with a warning.
   */
  private async resolvePortableProfile(
    profile: PortableAssistantProfile,
    cache: ImportCatalogCache,
  ): Promise<
    | { ok: false, reason: string }
    | { ok: true, profile: PortableAssistantProfile, dropped: GroupImportDropped }
  > {
    const presetId = profile.agentPresetId.trim()
    let presetOk = cache.presets.get(presetId)
    if (presetOk === undefined) {
      presetOk = await this.ctx.agentPresets.resolve(presetId).then(() => true, () => false)
      cache.presets.set(presetId, presetOk)
    }
    if (!presetOk) return { ok: false, reason: `unknown agent preset '${presetId}'` }
    if (!this.ctx.permissionPresets.names.includes(profile.permissionPresetId.trim())) {
      return { ok: false, reason: `unknown permission preset '${profile.permissionPresetId.trim()}'` }
    }
    const modelKey = `${profile.provider}/${profile.model}`
    let efforts = cache.efforts.get(modelKey)
    if (efforts === undefined) {
      efforts = await this.modelCapabilities(profile.provider, profile.model)
        .then(capabilities => capabilities.reasoning?.efforts.map(effort => effort.id) ?? [], () => null)
      cache.efforts.set(modelKey, efforts)
    }
    if (efforts === null) return { ok: false, reason: `unknown model '${modelKey}'` }
    const skills = await this.availableReferences(presetId, cache.skills, () => this.skillCatalog(presetId)
      .then(catalog => new Set(catalog.skills.map(skill => skill.name))))
    const mcpServers = await this.availableReferences(presetId, cache.mcpServers, () => this.mcpCatalog(presetId)
      .then(catalog => new Set(catalog.servers.map(server => server.name))))
    const keptSkills = profile.skillAllowlist.filter(name => isSkillName(name) && skills.has(name))
    const keptMcpServers = profile.mcpServers.filter(name => isMcpServerName(name) && mcpServers.has(name))
    const requestedEffort = profile.reasoningEffort?.trim() || undefined
    const keptEffort = requestedEffort !== undefined && efforts.includes(requestedEffort)
      ? requestedEffort
      : undefined
    const dropped: GroupImportDropped = {}
    const droppedSkills = profile.skillAllowlist.filter(name => !keptSkills.includes(name))
    if (droppedSkills.length > 0) dropped.skills = droppedSkills
    const droppedMcpServers = profile.mcpServers.filter(name => !keptMcpServers.includes(name))
    if (droppedMcpServers.length > 0) dropped.mcpServers = droppedMcpServers
    if (requestedEffort !== undefined && keptEffort === undefined) dropped.reasoningEffort = requestedEffort
    const { reasoningEffort: _ignored, ...rest } = profile
    return {
      ok: true,
      profile: {
        ...rest,
        skillAllowlist: keptSkills,
        mcpServers: keptMcpServers,
        ...(keptEffort === undefined ? {} : { reasoningEffort: keptEffort }),
      },
      dropped,
    }
  }

  /** Cached catalog read; an unreadable catalog reads as "nothing available". */
  private async availableReferences(
    presetId: string,
    cache: Map<string, Set<string>>,
    read: () => Promise<Set<string>>,
  ): Promise<Set<string>> {
    const cached = cache.get(presetId)
    if (cached !== undefined) return cached
    const names = await read().then(value => value, () => new Set<string>())
    cache.set(presetId, names)
    return names
  }

  /** The per-item write pass; see `importGroup` for the failure contract. */
  private async applyGroupImport(
    document: GroupExportDocument,
    plan: GroupImportPreview,
    workspaceId: string,
  ): Promise<GroupImportResult> {
    const rows: GroupImportResultRow[] = []
    // Apply never re-resolves references: the plan's availability decisions
    // (including a member's dropped skill/MCP/effort) ride into the result, so
    // the outcome report cannot disagree with the preview the user approved.
    const warnings = [...plan.warnings]
    // The group itself is the one hard prerequisite: if it cannot be created
    // (a race, or the list filled up) the import aborts before any row lands.
    await this.createGroup(plan.group.plannedName)
    rows.push({
      kind: 'group',
      name: plan.group.requested,
      plannedName: plan.group.plannedName,
      status: 'created',
    })
    if (document.group.brief !== '') await this.setGroupBrief(plan.group.plannedName, document.group.brief)

    for (const row of plan.assistants) {
      if (row.action !== 'create' || row.profile === undefined) {
        rows.push({ kind: 'assistant', name: row.name, status: 'skipped', reason: row.reason ?? 'not portable' })
        continue
      }
      try {
        const instance = await this.createAssistantInstance({
          workspaceId,
          name: row.plannedName,
          instructions: row.profile.instructions,
          provider: row.profile.provider,
          model: row.profile.model,
          ...(row.profile.reasoningEffort === undefined ? {} : { reasoningEffort: row.profile.reasoningEffort }),
          agentPresetId: row.profile.agentPresetId,
          permissionPresetId: row.profile.permissionPresetId,
          skillAllowlist: [...row.profile.skillAllowlist],
          mcpServers: [...row.profile.mcpServers],
          ...(row.mascot === undefined ? {} : { mascot: row.mascot }),
        })
        await this.updateAssistantInstance(instance.id, {
          group: plan.group.plannedName,
          ...(row.memoryAutoCapture === undefined ? {} : { memoryAutoCapture: row.memoryAutoCapture }),
        })
        rows.push({ kind: 'assistant', name: row.name, plannedName: row.plannedName, status: 'created' })
      } catch (error) {
        rows.push({
          kind: 'assistant',
          name: row.name,
          plannedName: row.plannedName,
          status: 'rejected',
          reason: errorMessage(error),
        })
      }
    }

    const templateIds = new Map<string, string>()
    for (const template of plan.templates) {
      const existing = this.findPortableTemplate(template.profile)
      if (existing !== undefined) {
        templateIds.set(template.plannedName, existing.id)
        rows.push({ kind: 'template', name: template.name, plannedName: existing.name, status: 'reused' })
        continue
      }
      try {
        const created = await this.createAssistant({
          name: template.plannedName,
          instructions: template.profile.instructions,
          provider: template.profile.provider,
          model: template.profile.model,
          ...(template.profile.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: template.profile.reasoningEffort }),
          agentPresetId: template.profile.agentPresetId,
          permissionPresetId: template.profile.permissionPresetId,
          skillAllowlist: [...template.profile.skillAllowlist],
          mcpServers: [...template.profile.mcpServers],
        })
        templateIds.set(template.plannedName, created.id)
        rows.push({ kind: 'template', name: template.name, plannedName: template.plannedName, status: 'created' })
      } catch (error) {
        rows.push({
          kind: 'template',
          name: template.name,
          plannedName: template.plannedName,
          status: 'rejected',
          reason: errorMessage(error),
        })
      }
    }

    for (const team of plan.teams) {
      if (team.action !== 'create') {
        rows.push({ kind: 'team', name: team.name, status: 'skipped', reason: team.reason ?? 'not portable' })
        continue
      }
      const missing = team.members.find(member => !templateIds.has(member.templateName))
      if (missing !== undefined) {
        rows.push({
          kind: 'team',
          name: team.name,
          plannedName: team.plannedName,
          status: 'skipped',
          reason: `its Assistant template '${missing.templateName}' was not created`,
        })
        continue
      }
      try {
        const created = await this.createTeamDraft({
          name: team.plannedName,
          workspaceId,
          ...(team.directMemberChat === undefined ? {} : { directMemberChat: team.directMemberChat }),
          members: team.members.map(member => ({
            assistantId: templateIds.get(member.templateName) as string,
            role: member.role,
          })),
        })
        // The draft rebuilds each slot from its template, so the slot values the
        // export recorded separately are only written where they differ. Slot
        // order is the member order this call passed in.
        const slots = Object.values(created.members)
        for (const [index, slot] of slots.entries()) {
          const member = team.members[index]
          if (member === undefined) continue
          try {
            if (slot.displayName !== member.displayName) {
              await this.renameMember(created.id, slot.id, member.displayName)
            }
            if (slot.permissionPresetId !== member.permissionPresetId) {
              await this.setMemberPermissionPreset(created.id, slot.id, member.permissionPresetId)
            }
            if ((slot.reasoningEffort ?? '') !== (member.reasoningEffort ?? '')) {
              await this.setMemberReasoningEffort(created.id, slot.id, member.reasoningEffort)
            }
          } catch (error) {
            warnings.push(
              `Team '${team.plannedName}' member '${member.displayName}': ${errorMessage(error)}`,
            )
          }
        }
        await this.setTeamGroup(created.id, plan.group.plannedName)
        rows.push({ kind: 'team', name: team.name, plannedName: team.plannedName, status: 'created' })
      } catch (error) {
        rows.push({
          kind: 'team',
          name: team.name,
          plannedName: team.plannedName,
          status: 'rejected',
          reason: errorMessage(error),
        })
      }
    }

    const counts = { created: 0, reused: 0, skipped: 0, rejected: 0 }
    for (const row of rows) counts[row.status] += 1
    return {
      schemaVersion: 1,
      groupName: plan.group.plannedName,
      rows,
      warnings,
      counts,
    }
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

  /**
   * One atomic aggregate write plus its activity/publish. The fences run in the
   * store's serialized write chain, so a Session that was already waiting inside
   * a tool handler when a Leader change (epoch) or a context handoff (Session)
   * committed is rejected before anything is written.
   */
  async updateRuntimeTeam(
    teamId: string,
    update: (team: TeamAggregate) => TeamAggregate,
    kind: string,
    summary: string,
    options: RuntimeWriteOptions = {},
  ): Promise<TeamAggregate> {
    const next = await this.store.updateTeam(teamId, current => {
      assertRevision('team', current.revision, options.expectedRevision)
      requireEpoch(current, options.expectedEpoch)
      requireMemberSession(current, options.expectedMemberSession)
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

  /**
   * Write one durable message. Messages live outside the aggregate, so the
   * fences are checked here instead of inside `updateRuntimeTeam`; without them
   * a handler that started before a Leader change or a handoff could still
   * deliver mail under the superseded Session.
   */
  async putRuntimeMessage(
    message: TeamMessage,
    options: RuntimeWriteOptions = {},
  ): Promise<void> {
    const team = requireTeam(this.store, message.teamId)
    requireEpoch(team, options.expectedEpoch)
    requireMemberSession(team, options.expectedMemberSession)
    await this.store.putMessage(message)
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
   * Validate one explicit member→Assistant instance link before it is stored.
   * The instance must exist, must not be archived, and must share the team's
   * workspace id and path. It must not already be linked by this team or by any
   * other stored team. This repository models no Assistant owner, so owner
   * identity cannot be checked; the workspace pair is the strongest available
   * scope. Cross-team uniqueness is best-effort: it is checked before and
   * inside the per-team atomic update, not under a global lock.
   */
  private requireLinkableAssistantInstance(
    scope: AssistantInstanceLinkScope,
    assistantInstanceId: string,
    exceptSlotId?: string,
  ): AssistantInstance {
    const instance = requireAssistantInstance(this.store, assistantInstanceId)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${instance.id}' is archived and cannot be linked`,
        { instanceId: instance.id },
      )
    }
    // An isolated Assistant runs alone in its private workspace by design, so
    // the generic workspace mismatch would read as a bug. Name the actual
    // conflict; a team can never move into that private directory (pickers
    // exclude it) and the Assistant must stay where its Sessions attach.
    if (instance.workspaceIsolated === true) {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_WORKSPACE_MISMATCH',
        `Assistant instance '${instance.id}' runs in its own isolated workspace `
          + `'${instance.workspacePath}' and cannot be linked to a team in '${scope.workspacePath}'. `
          + 'Turn 独立工作区 off when creating the Assistant if it must join a team.',
        {
          instanceId: instance.id,
          instanceWorkspaceId: instance.workspaceId,
          teamWorkspaceId: scope.workspaceId,
          isolatedWorkspace: true,
        },
      )
    }
    if (instance.workspaceId !== scope.workspaceId || instance.workspacePath !== scope.workspacePath) {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_WORKSPACE_MISMATCH',
        `Assistant instance '${instance.id}' belongs to a different workspace than this team`,
        {
          instanceId: instance.id,
          instanceWorkspaceId: instance.workspaceId,
          teamWorkspaceId: scope.workspaceId,
        },
      )
    }
    const sameTeam = Object.values(scope.members).find(member => (
      member.id !== exceptSlotId && member.assistantInstanceId === instance.id
    ))
    if (sameTeam !== undefined) {
      throw new AgentTeamError(
        'ASSISTANT_IN_USE',
        `Assistant instance '${instance.id}' is already linked to member '${sameTeam.id}'`,
        { instanceId: instance.id, memberId: sameTeam.id },
      )
    }
    const otherTeam = this.store.listTeams().find(team => (
      team.id !== scope.teamId
      && Object.values(team.members).some(member => member.assistantInstanceId === instance.id)
    ))
    if (otherTeam !== undefined) {
      throw new AgentTeamError(
        'ASSISTANT_IN_USE',
        `Assistant instance '${instance.id}' is already linked by team '${otherTeam.id}'`,
        { instanceId: instance.id, teamId: otherTeam.id },
      )
    }
    return instance
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
    this.assertSkillNames(input.skillAllowlist)
    await this.assertMcpServers(input.mcpServers, input.agentPresetId)
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
  }

  /**
   * Skill and MCP reference rules shared by every write path (templates,
   * instance creation, instance updates). Skill names are checked against the
   * public name grammar; MCP Servers must also exist in the preset's catalog.
   */
  private assertSkillNames(names: readonly string[]): void {
    const invalidSkill = names.find(name => !isSkillName(name))
    if (invalidSkill !== undefined) {
      throw new AgentTeamError('SKILL_REFERENCE_INVALID', `Invalid Skill name '${invalidSkill}'`)
    }
  }

  private async assertMcpServers(names: readonly string[], agentPresetId: string): Promise<void> {
    const invalidMcpServer = names.find(name => !isMcpServerName(name))
    if (invalidMcpServer !== undefined) {
      throw new AgentTeamError('MCP_REFERENCE_INVALID', `Invalid MCP Server name '${invalidMcpServer}'`)
    }
    if (names.length === 0) return
    const catalog = await this.mcpCatalog(agentPresetId)
    const available = new Set(catalog.servers.map(server => server.name))
    const missing = names.filter(name => !available.has(name))
    if (missing.length > 0) {
      throw new AgentTeamError(
        'MCP_REFERENCE_INVALID',
        `Agent Preset '${agentPresetId}' cannot access MCP Server(s): ${missing.join(', ')}`,
        { missing },
      )
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

  /**
   * Checkpoint persistence is a superset of the base store interface: the
   * production domain store implements it, while `AgentTeamStore` stays free of
   * mandatory checkpoint members so older store doubles keep compiling.
   */
  private checkpointStore(): AgentTeamCheckpointStore {
    return this.store as AgentTeamStore & AgentTeamCheckpointStore
  }

  /** Leader checkpoints use the same superset pattern as Assistant checkpoints. */
  private teamCheckpointStore(): AgentTeamLeaderCheckpointStore {
    return this.store as AgentTeamStore & AgentTeamLeaderCheckpointStore
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

/**
 * The one gate every thread attach goes through, checked again inside the write
 * so a queued archive or a full list cannot slip past the pre-check.
 */
function assertThreadSession(instance: AssistantInstance, sessionId: string): void {
  if (instance.status === 'archived') {
    throw new AgentTeamError(
      'ASSISTANT_INSTANCE_ARCHIVED',
      `Assistant instance '${instance.id}' is archived`,
      { instanceId: instance.id },
    )
  }
  if (instance.mainSessionId === sessionId) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Session '${sessionId}' is the main Session of assistant instance '${instance.id}'; `
        + 'a thread must be a different Session',
      { instanceId: instance.id, sessionId },
    )
  }
  const threadSessionIds = instance.threadSessionIds ?? []
  if (threadSessionIds.includes(sessionId)) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Session '${sessionId}' is already a thread of assistant instance '${instance.id}'`,
      { instanceId: instance.id, sessionId },
    )
  }
  if (threadSessionIds.length >= ASSISTANT_THREAD_SESSION_LIMIT) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Assistant instance '${instance.id}' already has ${ASSISTANT_THREAD_SESSION_LIMIT} thread Sessions`,
      { instanceId: instance.id, limit: ASSISTANT_THREAD_SESSION_LIMIT },
    )
  }
}

/**
 * The read-side guard for the coordinator's "never silently hidden" rule. The
 * archive entry point already refuses a coordinator, so this only ever fires for
 * a record written by an older build or edited outside the service; reporting it
 * as idle keeps the pinned row reachable instead of dropping it from the list.
 */
function coordinatorVisible(instance: AssistantInstance): AssistantInstance {
  if (!isCoordinatorInstance(instance) || instance.status !== 'archived') return instance
  const { archivedAt: _archivedAt, ...rest } = instance
  return { ...rest, status: 'idle' }
}

/** One message for every coordinator-archive refusal; it names the way out. */
function assertNotCoordinator(instance: AssistantInstance): void {
  if (!isCoordinatorInstance(instance)) return
  throw new AgentTeamError(
    'ASSISTANT_INSTANCE_COORDINATOR',
    `Assistant instance '${instance.id}' is the workspace coordinator and cannot be archived; `
      + 'clear the coordinator first (assistant.coordinator.set with null), then archive it',
    { instanceId: instance.id },
  )
}

function requireAssistantSession(store: AgentTeamStore, id: string): AssistantSession {
  const session = store.getAssistantSession(id)
  if (session === undefined) {
    throw new AgentTeamError('ASSISTANT_TASK_NOT_FOUND', `Unknown assistant task '${id}'`)
  }
  return session
}

/**
 * Trim an optional identity line. `undefined` means "keep the stored value";
 * an empty result means "clear it", so callers drop the field from the
 * snapshot instead of storing an empty string.
 */
function identityLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.trim() || undefined
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
  title?: string | undefined
  blurb?: string | undefined
  avatar?: string | undefined
  provider?: string | undefined
  model?: string | undefined
  reasoningEffort?: string | undefined
  agentPresetId?: string | undefined
  permissionPresetId?: string | undefined
  instructions?: string | undefined
  skillAllowlist?: string[] | undefined
  mcpServers?: string[] | undefined
}

interface DirectAssistantSnapshotInput {
  name: string
  title?: string | undefined
  blurb?: string | undefined
  avatar?: string | undefined
  provider: string
  model: string
  reasoningEffort?: string | undefined
  agentPresetId: string
  permissionPresetId: string
  instructions?: string | undefined
  skillAllowlist?: string[] | undefined
  mcpServers?: string[] | undefined
}

/**
 * Build the snapshot of a template-less Assistant. The snapshot is owned by the
 * new instance (`assistantId` equals its id) and starts at revision 1 with the
 * Skills and MCP Servers the caller named (none otherwise) and no prompts.
 */
function directAssistantSnapshot(id: string, input: DirectAssistantSnapshotInput): AssistantSnapshot {
  const avatar = input.avatar?.trim()
  const reasoningEffort = input.reasoningEffort?.trim()
  const title = identityLine(input.title)
  const blurb = identityLine(input.blurb)
  return {
    assistantId: id,
    revision: 1,
    name: input.name.trim(),
    ...(title === undefined ? {} : { title }),
    ...(blurb === undefined ? {} : { blurb }),
    ...(avatar === undefined || avatar === '' ? {} : { avatar }),
    instructions: input.instructions ?? '',
    provider: input.provider.trim(),
    model: input.model.trim(),
    ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }),
    agentPresetId: input.agentPresetId.trim(),
    permissionPresetId: input.permissionPresetId.trim(),
    skillAllowlist: unique(input.skillAllowlist ?? []),
    mcpServers: unique(input.mcpServers ?? []),
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
    title: previousTitle,
    blurb: previousBlurb,
    ...rest
  } = display
  const reasoningEffort = overrides.reasoningEffort === undefined
    ? previousReasoning
    : overrides.reasoningEffort.trim() || undefined
  // Absent keeps the inherited identity line; an empty string clears it.
  const title = overrides.title === undefined ? previousTitle : identityLine(overrides.title)
  const blurb = overrides.blurb === undefined ? previousBlurb : identityLine(overrides.blurb)
  return {
    ...rest,
    ...(title === undefined ? {} : { title }),
    ...(blurb === undefined ? {} : { blurb }),
    ...(overrides.provider === undefined ? {} : { provider: overrides.provider.trim() }),
    ...(overrides.model === undefined ? {} : { model: overrides.model.trim() }),
    ...(overrides.agentPresetId === undefined ? {} : { agentPresetId: overrides.agentPresetId.trim() }),
    ...(overrides.permissionPresetId === undefined
      ? {}
      : { permissionPresetId: overrides.permissionPresetId.trim() }),
    ...(overrides.instructions === undefined ? {} : { instructions: overrides.instructions }),
    ...(overrides.skillAllowlist === undefined
      ? {}
      : { skillAllowlist: unique(overrides.skillAllowlist) }),
    ...(overrides.mcpServers === undefined
      ? {}
      : { mcpServers: unique(overrides.mcpServers) }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/**
 * Append with exactly one separating newline. An empty existing document is
 * treated as no separator, so the first append does not start with a blank line.
 */
function requireMemoryRevision(expected: number | undefined, actual: number): void {
  if (expected === undefined || expected === actual) return
  throw new AgentTeamError(
    'MEMORY_REVISION_CONFLICT',
    `Memory revision conflict: expected ${expected}, current ${actual}`,
    { expected, actual },
  )
}

function newMemoryEntry(input: WriteAssistantMemoryEntryInput, now: string): MemoryEntry {
  return {
    id: input.id ?? `mem-${randomUUID()}`,
    scope: 'assistant',
    visibility: input.visibility ?? 'private',
    status: input.status ?? 'active',
    source: 'assistant',
    ...(input.key === undefined ? {} : { key: input.key }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    title: input.title,
    body: input.body,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function reviseMemoryEntry(
  existing: MemoryEntry,
  input: WriteAssistantMemoryEntryInput,
  now: string,
): MemoryEntry {
  const supersedes = input.supersedes ?? existing.supersedes
  return {
    ...existing,
    title: input.title,
    body: input.body,
    visibility: input.visibility ?? existing.visibility,
    status: input.status ?? existing.status,
    ...(input.key === undefined ? {} : { key: input.key }),
    ...(supersedes === undefined ? {} : { supersedes }),
    revision: existing.revision + 1,
    updatedAt: now,
  }
}

function appendMemory(current: string, addition: string): string {
  if (current === '') return addition
  if (addition === '') return current
  return `${current}\n${addition}`
}

/** The content fields an undo restores; provenance and timestamps stay live. */
export function memoryEntrySnapshot(entry: MemoryEntry): MemoryJournalSnapshot {
  return {
    title: entry.title,
    body: entry.body,
    visibility: entry.visibility,
    status: entry.status,
    ...(entry.key === undefined ? {} : { key: entry.key }),
  }
}

/**
 * Append one audited change and keep the journal bounded: at most
 * {@link MEMORY_JOURNAL_MAX_RECORDS} records within the scope's character
 * budget, oldest dropped first. Snapshots are redacted and, if a single record
 * still cannot fit, truncated with a flag so undo refuses them.
 */
export function appendMemoryJournal(
  journal: readonly MemoryJournalEntry[] | undefined,
  change: MemoryJournalChange,
  revision: number,
  maxChars: number,
): MemoryJournalEntry[] {
  const record = buildMemoryJournalEntry(change, revision, maxChars)
  const appended = [...(journal ?? []), record]
  let bounded = appended.length > MEMORY_JOURNAL_MAX_RECORDS
    ? appended.slice(-MEMORY_JOURNAL_MAX_RECORDS)
    : appended
  while (bounded.length > 0 && memoryJournalChars(bounded) > maxChars) {
    bounded = bounded.slice(1)
  }
  return bounded
}

function buildMemoryJournalEntry(
  change: MemoryJournalChange,
  revision: number,
  maxChars: number,
): MemoryJournalEntry {
  const reason = change.reason.slice(0, MEMORY_JOURNAL_REASON_MAX_CHARS)
  const snapshotCap = Math.max(
    Math.floor(maxChars / 2) - MEMORY_JOURNAL_REASON_MAX_CHARS - 64,
    64,
  )
  const before = change.before === null
    ? undefined
    : boundJournalSnapshot(change.before, snapshotCap)
  const after = change.after === null
    ? undefined
    : boundJournalSnapshot(change.after, snapshotCap)
  return {
    id: `memj-${randomUUID()}`,
    scope: change.scope,
    at: new Date().toISOString(),
    actor: change.actor,
    action: change.action,
    entryId: change.entryId,
    reason,
    before: before?.snapshot ?? null,
    after: after?.snapshot ?? null,
    revision,
    ...(before?.redacted === true || after?.redacted === true ? { redacted: true } : {}),
    ...(before?.trimmed === true || after?.trimmed === true ? { trimmed: true } : {}),
  }
}

function boundJournalSnapshot(
  snapshot: MemoryJournalSnapshot,
  cap: number,
): { snapshot: MemoryJournalSnapshot; redacted: boolean; trimmed: boolean } {
  const title = redactMemoryText(snapshot.title)
  const body = redactMemoryText(snapshot.body)
  let titleText = title.text
  let bodyText = body.text
  const keyChars = snapshot.key?.length ?? 0
  let trimmed = false
  if (titleText.length + bodyText.length + keyChars > cap) {
    trimmed = true
    const titleCap = Math.max(Math.floor(cap / 4), 1)
    if (titleText.length > titleCap) titleText = titleText.slice(0, titleCap)
    const bodyCap = Math.max(cap - titleText.length - keyChars, 1)
    if (bodyText.length > bodyCap) bodyText = bodyText.slice(0, bodyCap)
  }
  return {
    snapshot: {
      title: titleText,
      body: bodyText,
      visibility: snapshot.visibility,
      status: snapshot.status,
      ...(snapshot.key === undefined ? {} : { key: snapshot.key }),
    },
    redacted: title.redacted || body.redacted,
    trimmed,
  }
}

function memoryJournalChars(journal: readonly MemoryJournalEntry[]): number {
  return journal.reduce((sum, record) => sum
    + record.reason.length
    + journalSnapshotChars(record.before)
    + journalSnapshotChars(record.after), 0)
}

function journalSnapshotChars(snapshot: MemoryJournalSnapshot | null): number {
  if (snapshot === null) return 0
  return snapshot.title.length + snapshot.body.length + (snapshot.key?.length ?? 0)
}

function assistantJournalChange(
  entry: MemoryEntry,
  existing: MemoryEntry | undefined,
  actor: MemoryEntrySource,
): MemoryJournalChange {
  const action: MemoryJournalAction = existing === undefined
    ? 'create'
    : entry.status === 'archived' && existing.status !== 'archived'
      ? 'archive'
      : entry.status === 'active' && existing.status === 'proposed'
        ? 'accept'
        : 'update'
  return {
    scope: 'assistant',
    actor,
    action,
    entryId: entry.id,
    reason: `${action} '${entry.title}'`,
    before: existing === undefined ? null : memoryEntrySnapshot(existing),
    after: memoryEntrySnapshot(entry),
  }
}

/** Redact then bound one captured text field; capture never grows unbounded. */
function boundCapturedText(text: string, limit: number): string {
  const redacted = redactMemoryText(text).text
  return redacted.length <= limit ? redacted : redacted.slice(0, limit)
}

function hasCapturedEntry(
  entries: readonly MemoryEntry[],
  key: string | undefined,
  dedupe: string,
): boolean {
  return entries.some(entry =>
    (key !== undefined && entry.key === key) || memoryDedupeKey(entry) === dedupe)
}

function assistantTaskCaptureEntry(task: AssistantSession, now: string): MemoryEntry {
  const summary = task.resultSummary?.trim() ?? ''
  const rawBody = summary === '' ? `Completed task: ${task.title}` : summary
  return {
    id: `mem-${randomUUID()}`,
    scope: 'assistant',
    visibility: 'private',
    status: 'proposed',
    source: 'auto',
    key: `task:${task.id}`,
    title: boundCapturedText(task.title, MEMORY_CAPTURE_MAX_TITLE_CHARS),
    body: boundCapturedText(rawBody, MEMORY_CAPTURE_MAX_BODY_CHARS),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function assistantCaptureChange(entry: MemoryEntry): MemoryJournalChange {
  return {
    scope: 'assistant',
    actor: 'auto',
    action: 'create',
    entryId: entry.id,
    reason: `captured from completed task '${entry.title}'`,
    before: null,
    after: memoryEntrySnapshot(entry),
  }
}

/**
 * Deterministic goal capture candidates. Ordered by the Goal then by completion
 * time, so the same Goal always produces the same key/title pair.
 */
function goalCaptureEntries(
  goal: TeamGoal,
  tasks: Readonly<Record<string, TeamTask>>,
  now: string,
): MemoryEntry[] {
  const base = {
    scope: 'team' as const,
    visibility: 'team-safe' as const,
    status: 'proposed' as const,
    source: 'auto' as const,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  const objective = boundCapturedText(goal.objective, MEMORY_CAPTURE_MAX_BODY_CHARS)
  const acceptance = goal.acceptance.trim() === ''
    ? ''
    : boundCapturedText(goal.acceptance, MEMORY_CAPTURE_MAX_BODY_CHARS)
  const body = boundCapturedText([
    `Objective: ${objective}`,
    ...(acceptance === '' ? [] : [`Acceptance: ${acceptance}`]),
  ].join('\n'), MEMORY_CAPTURE_MAX_BODY_CHARS)
  const entries: MemoryEntry[] = [{
    ...base,
    id: `mem-${randomUUID()}`,
    key: `goal:${goal.id}`,
    title: boundCapturedText(goal.title, MEMORY_CAPTURE_MAX_TITLE_CHARS),
    body,
  }]
  const results = Object.values(tasks)
    .filter(task => task.goalId === goal.id && task.status === 'completed')
    .map(task => ({ task, result: task.result?.trim() ?? '' }))
    .filter(item => item.result !== '')
    .sort((left, right) =>
      left.task.updatedAt.localeCompare(right.task.updatedAt)
      || left.task.id.localeCompare(right.task.id))
    .slice(0, MEMORY_CAPTURE_MAX_TASK_RESULTS)
  if (results.length > 0) {
    const resultBody = boundCapturedText(results.map(({ task, result }) =>
      `- ${boundCapturedText(task.title, 200)}: ${boundCapturedText(result, 1_000)}`).join('\n'),
    MEMORY_CAPTURE_MAX_BODY_CHARS)
    entries.push({
      ...base,
      id: `mem-${randomUUID()}`,
      key: `goal-results:${goal.id}`,
      title: boundCapturedText(`Results: ${goal.title}`, MEMORY_CAPTURE_MAX_TITLE_CHARS),
      body: resultBody,
    })
  }
  return entries
}

/** Restore the recorded content as a new revision; never rewinds history. */
function restoreMemoryEntry(
  entry: MemoryEntry,
  before: MemoryJournalSnapshot,
  now: string,
): MemoryEntry {
  const restored: MemoryEntry = {
    ...entry,
    title: before.title,
    body: before.body,
    visibility: before.visibility,
    status: before.status,
    revision: entry.revision + 1,
    updatedAt: now,
  }
  if (before.key === undefined) delete restored.key
  else restored.key = before.key
  return restored
}

/**
 * One operation can journal several entry deltas under one memory revision
 * (goal capture does two; a keyed write adds a supersede). After one of them is
 * undone, the surviving deltas of that revision would fail the revision fence,
 * so re-stamp them onto the new revision. The undone record and earlier undo
 * records keep their own revision and stay stale by design.
 */
function restampJournalRevision(
  journal: readonly MemoryJournalEntry[],
  fromRevision: number,
  toRevision: number,
  undoneRecordId: string,
): MemoryJournalEntry[] {
  return journal.map(record => record.id === undoneRecordId
    || record.revision !== fromRevision
    || record.action === 'undo'
    ? record
    : { ...record, revision: toRevision })
}

function undoStale(expected: number | undefined, actual: number): AgentTeamError {
  return new AgentTeamError(
    'MEMORY_UNDO_STALE',
    `Memory revision changed to ${actual}; reload and retry the undo`,
    { expected, actual },
  )
}

function undoUnavailable(journalId: string, reason: string): AgentTeamError {
  return new AgentTeamError(
    'MEMORY_UNDO_UNAVAILABLE',
    `Memory journal entry '${journalId}' cannot be undone: ${reason}`,
    { journalId, reason },
  )
}

/** A memory fence is a whole non-negative number; anything else means "unfenced". */
export function normalizeTeamMemoryRevision(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(Math.floor(value), 0)
}

export function requireTeamMemoryRevision(expected: number | undefined, actual: number): void {
  if (expected === undefined || expected === actual) return
  throw new AgentTeamError(
    'MEMORY_REVISION_CONFLICT',
    `Team memory revision conflict: expected ${expected}, current ${actual}`,
    { expected, actual },
  )
}

export function normalizeTeamMemoryKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/** Entries that still participate in the caps and the prompt decision. */
export function liveTeamMemoryEntries(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return entries.filter(entry => entry.status === 'active' || entry.status === 'proposed')
}

/** Characters live entries occupy; the same budget the prompt and tools honour. */
export function liveTeamMemoryChars(entries: readonly MemoryEntry[]): number {
  return liveTeamMemoryEntries(entries).reduce(
    (sum, entry) => sum + entry.title.length + entry.body.length,
    0,
  )
}

/** Mirrors the capture closure's accept/dedupe/budget decision without writing. */
function acceptsTeamCaptureCandidates(
  team: TeamAggregate,
  candidates: readonly MemoryEntry[],
): boolean {
  const entries = [...(team.memory?.entries ?? [])]
  const knownKeys = new Set(entries.flatMap(entry => entry.key === undefined ? [] : [entry.key]))
  const knownText = new Set(entries.map(entry => memoryDedupeKey(entry)))
  for (const candidate of candidates) {
    if (candidate.key === undefined) continue
    if (knownKeys.has(candidate.key)) continue
    const dedupe = memoryDedupeKey(candidate)
    if (knownText.has(dedupe)) continue
    if (liveTeamMemoryEntries(entries).length >= TEAM_MEMORY_MAX_ENTRIES) return false
    entries.push(candidate)
    if (liveTeamMemoryChars(entries) > TEAM_MEMORY_MAX_CHARS) return false
    return true
  }
  return false
}

export function assertTeamMemoryBudget(entries: readonly MemoryEntry[]): void {
  const totalChars = liveTeamMemoryChars(entries)
  if (totalChars > TEAM_MEMORY_MAX_CHARS) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Team memory exceeds ${TEAM_MEMORY_MAX_CHARS} characters across live entries`,
      { length: totalChars, limit: TEAM_MEMORY_MAX_CHARS },
    )
  }
}

function requireTeamMemoryText(actual: number, limit: number, label: string): void {
  if (actual <= limit) return
  throw new AgentTeamError('INVALID_REQUEST', `${label} exceeds ${limit} characters`, {
    length: actual,
    limit,
  })
}

/**
 * Trim one sidebar group label. Blank means "no group"; an over-long label is
 * refused instead of silently truncated, so the caller never stores a value the
 * domain schema would then reject.
 */
function normalizeSidebarGroup(group: string | null): string | undefined {
  const trimmed = group?.trim() ?? ''
  if (trimmed === '') return undefined
  if (trimmed.length > SIDEBAR_GROUP_MAX_CHARS) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Group name exceeds ${SIDEBAR_GROUP_MAX_CHARS} characters`,
      { length: trimmed.length, limit: SIDEBAR_GROUP_MAX_CHARS },
    )
  }
  return trimmed
}

/** Same normalization, but a blank label is an error (creating/renaming a group). */
function requireGroupLabel(group: string): string {
  const label = normalizeSidebarGroup(group)
  if (label === undefined) throw new AgentTeamError('INVALID_REQUEST', 'Group name cannot be empty')
  return label
}

/**
 * A group brief is stored verbatim (it is user prose); only the hard cap is
 * enforced, and over-long text is refused instead of truncated.
 */
function requireGroupBrief(brief: string): string {
  if (brief.length > SIDEBAR_GROUP_BRIEF_MAX_CHARS) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Group brief exceeds ${SIDEBAR_GROUP_BRIEF_MAX_CHARS} characters`,
      { length: brief.length, limit: SIDEBAR_GROUP_BRIEF_MAX_CHARS },
    )
  }
  return brief
}

function requireTeamMemoryEntry(team: TeamAggregate, entryId: string): MemoryEntry {
  const entry = team.memory?.entries.find(value => value.id === entryId)
  if (entry === undefined) {
    throw new AgentTeamError('INVALID_REQUEST', `Unknown team memory entry '${entryId}'`)
  }
  return entry
}

function requireTeam(store: AgentTeamStore, id: string): TeamAggregate {  const team = store.getTeam(id)
  if (team === undefined) throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${id}'`)
  return team
}

/** One active (non-archived) thread of the team. */
function requireThread(team: TeamAggregate, threadId: string): TeamThread {
  const thread = team.threads?.[threadId]
  if (thread === undefined) {
    throw new AgentTeamError('THREAD_NOT_FOUND', `Unknown thread '${threadId}' in team '${team.id}'`, {
      teamId: team.id,
      threadId,
    })
  }
  return thread
}

/** Trim and bound a thread title; an empty title is refused, never stored. */
function requireThreadTitle(raw: string): string {
  const title = raw.trim()
  if (title.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Thread title cannot be empty')
  if (title.length > THREAD_TITLE_MAX_CHARS) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Thread title exceeds ${THREAD_TITLE_MAX_CHARS} characters`,
      { length: title.length, limit: THREAD_TITLE_MAX_CHARS },
    )
  }
  return title
}

/**
 * A Session belongs to exactly one thing. Refuse a thread Session id that is
 * already a member Session (or another thread's), so the two layers can never
 * overwrite each other.
 */
function requireUnusedThreadSession(team: TeamAggregate, sessionId: string): void {
  const taken = Object.values(team.members).some(member => member.sessionId === sessionId)
    || Object.keys(team.retiredSessions).includes(sessionId)
    || Object.values(team.threads ?? {}).some(thread => thread.sessionId === sessionId)
    || Object.values(team.retiredThreads ?? {}).some(thread => thread.sessionId === sessionId)
  if (taken) {
    throw new AgentTeamError('INVALID_REQUEST', `Session '${sessionId}' already belongs to this team`, {
      teamId: team.id,
      sessionId,
    })
  }
}

function requireGoal(team: TeamAggregate, goalId: string): TeamGoal {
  const goal = team.goals?.[goalId]
  if (goal === undefined) {
    throw new AgentTeamError('INVALID_REQUEST', `Unknown goal '${goalId}' in team '${team.id}'`)
  }
  return goal
}

function requireTask(team: TeamAggregate, taskId: string): TeamTask {
  const task = team.tasks[taskId]
  if (task === undefined) {
    throw new AgentTeamError('INVALID_REQUEST', `Unknown task '${taskId}' in team '${team.id}'`)
  }
  return task
}

/** Unlink helper: `exactOptionalPropertyTypes` forbids assigning goalId: undefined. */
function withoutGoal(task: TeamTask): Omit<TeamTask, 'goalId'> {
  const { goalId: _goalId, ...rest } = task
  return rest
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

/** Reject a write authored under a previous leadership epoch. */
function requireEpoch(team: TeamAggregate, expected?: number): void {
  if (expected === undefined) return
  const epoch = epochOf(team)
  if (epoch === expected) return
  throw epochStaleError(team.id, epoch, expected)
}

/**
 * Reject a write authored by a Session that is no longer the member's Session.
 * The epoch does not change on a context handoff or a member reset, so this is
 * the only fence that closes the in-flight-write window those create.
 */
function requireMemberSession(
  team: TeamAggregate,
  expected?: { slotId: string; sessionId: string },
): void {
  if (expected === undefined) return
  const member = team.members[expected.slotId]
  if (member !== undefined && member.sessionId === expected.sessionId) return
  throw sessionRetiredError(team.id, expected.slotId, expected.sessionId)
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
  assistantInstanceId?: string,
  toolPolicy?: string,
): TeamMemberSlot {
  const slotId = randomUUID()
  return {
    id: slotId,
    assistantId: assistant.id,
    ...(assistantInstanceId === undefined ? {} : { assistantInstanceId }),
    displayName,
    role,
    assistantSnapshot: snapshotAssistant(assistant),
    permissionPresetId: assistant.permissionPresetId,
    ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
    ...(toolPolicy === undefined ? {} : { toolPolicy }),
    sessionId: `session-${randomUUID()}`,
    desiredState,
    lastRuntimeState: desiredState === 'online' ? 'starting' : 'offline',
    joinedAt: now,
  }
}

/**
 * A clone is a new team: it deliberately drops every member's explicit
 * Assistant instance link instead of sharing memory with the source team.
 * A tool policy id is copied because it describes the member's role, and the
 * deployment config re-resolves it on the clone's first activation.
 */
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
    ...(source.toolPolicy === undefined ? {} : { toolPolicy: source.toolPolicy }),
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

/** The team fields needed to validate a member's Assistant instance link. */
interface AssistantInstanceLinkScope {
  /** Empty while a new team draft is not stored yet. */
  teamId: string
  workspaceId: string
  workspacePath: string
  members: Record<string, TeamMemberSlot>
}

function linkScopeOf(team: TeamAggregate): AssistantInstanceLinkScope {
  return {
    teamId: team.id,
    workspaceId: team.workspaceId,
    workspacePath: team.workspacePath,
    members: team.members,
  }
}

/** Apply or clear the explicit link; `null` removes the field entirely. */
function withAssistantInstanceId(
  member: TeamMemberSlot,
  assistantInstanceId: string | null,
): TeamMemberSlot {
  const { assistantInstanceId: _current, ...rest } = member
  return assistantInstanceId === null ? rest : { ...rest, assistantInstanceId }
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

/**
 * Per-import memo of catalog answers. One preview and one apply each build a
 * fresh cache, so a catalog change between them changes the plan hash and the
 * stale preview is refused instead of applying a different plan.
 */
interface ImportCatalogCache {
  presets: Map<string, boolean>
  /** `provider/model` → supported effort ids, or `null` for an unknown model. */
  efforts: Map<string, string[] | null>
  skills: Map<string, Set<string>>
  mcpServers: Map<string, Set<string>>
}

/** Leader first, then the stored member order, then anything left over. */
function orderedTeamMembers(team: TeamAggregate): TeamMemberSlot[] {
  const seen = new Set<string>()
  const ordered: TeamMemberSlot[] = []
  const push = (id: string): void => {
    const member = team.members[id]
    if (member === undefined || seen.has(id)) return
    seen.add(id)
    ordered.push(member)
  }
  push(team.leaderSlotId)
  for (const id of team.memberOrder ?? []) push(id)
  for (const id of Object.keys(team.members)) push(id)
  return ordered
}

/** Fence over the document plus the plan it produced. */
function groupImportPlanHash(
  document: GroupExportDocument,
  plan: Omit<GroupImportPreview, 'planHash'>,
): string {
  return createHash('sha256').update(JSON.stringify({ document, plan })).digest('hex')
}

/** `field.path: message` for the first schema problem, for a readable rejection. */
function portableIssue(error: ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'document does not match the portable group schema'
  const path = issue.path.map(String).join('.')
  return `${path === '' ? 'document' : path}: ${issue.message}`
}

function portableIssues(error: ZodError): Array<{ path: string, message: string }> {
  return error.issues.map(issue => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

/** Whether a task row can no longer move on its own (pause/archive refuse it). */
function isTerminalAssistantTaskStatus(status: AssistantSession['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function hasDropped(dropped: GroupImportDropped): boolean {
  return dropped.skills !== undefined
    || dropped.mcpServers !== undefined
    || dropped.reasoningEffort !== undefined
}

function droppedWarning(label: string, dropped: GroupImportDropped): string | undefined {
  const parts: string[] = []
  if (dropped.skills !== undefined) parts.push(`skill(s) ${dropped.skills.join(', ')}`)
  if (dropped.mcpServers !== undefined) parts.push(`MCP server(s) ${dropped.mcpServers.join(', ')}`)
  if (dropped.reasoningEffort !== undefined) {
    parts.push(`reasoning effort '${dropped.reasoningEffort}'`)
  }
  return parts.length === 0 ? undefined : `${label}: dropped unavailable ${parts.join('; ')}`
}

/** A name is available unless some profile that referenced it had to drop it. */
function markAvailability(
  availability: Map<string, boolean>,
  referenced: readonly string[],
  dropped: readonly string[] | undefined,
): void {
  for (const name of referenced) {
    if (!availability.has(name)) availability.set(name, true)
  }
  for (const name of dropped ?? []) availability.set(name, false)
}

function availabilityList(availability: Map<string, boolean>): Array<{ name: string, available: boolean }> {
  return [...availability.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, available]) => ({ name, available }))
}

/**
 * The one system prompt of the draft call. It asks for the same identity block
 * the create form edits, in one JSON object, so the reply is validated field by
 * field instead of parsed out of prose. `presetId` names the fixed starting
 * roles the form offers; an unknown id is ignored there, not a draft failure.
 */
const CREATE_DRAFT_SYSTEM_PROMPT = [
  'You name and describe one DeepSeek Harness coworker from the user\'s one-sentence request.',
  'Reply with one JSON object and no other text.',
  'Allowed keys: "name" (display name), "title" (persona line), "blurb" (one-line summary),',
  '"instructions" (the operating persona), and "presetId" (one of researcher, reviewer,',
  'implementer, tester, coordinator when one fits; otherwise omit it).',
  'Omit any key you cannot answer. Write the identity fields in the language of the request.',
].join('\n')

function parseCreateDraftReply(reply: string): AssistantCreateDraftReply {
  const parsed = assistantCreateDraftSchema.safeParse(draftReplyJson(reply))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `Create draft reply was not usable: ${issue === undefined
        ? 'it does not match the draft contract'
        : `${issue.path.join('.') || 'reply'}: ${issue.message}`}`,
      { reason: 'reply' },
    )
  }
  return parsed.data
}

/** Accept a bare JSON object, a fenced block, or prose around one JSON object. */
function draftReplyJson(reply: string): unknown {
  const text = reply.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      'Create draft reply was not usable: the reply contains no JSON object',
      { reason: 'reply' },
    )
  }
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      'Create draft reply was not usable: the reply is not valid JSON',
      { reason: 'reply' },
    )
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}
