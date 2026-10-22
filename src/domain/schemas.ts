import { z } from 'zod'

const isoDate = z.iso.datetime({ offset: true })
const nonEmpty = z.string().trim().min(1)

export const assistantSnapshotSchema = z.object({
  assistantId: nonEmpty,
  revision: z.int().positive(),
  name: nonEmpty,
  avatar: z.string().max(400_000).optional(),
  instructions: z.string(),
  provider: nonEmpty,
  model: nonEmpty,
  reasoningEffort: nonEmpty.optional(),
  agentPresetId: nonEmpty,
  permissionPresetId: nonEmpty,
  skillAllowlist: z.array(nonEmpty),
  mcpServers: z.array(nonEmpty),
  /** Suggestions shown on the member's empty-session hero. */
  prompts: z.array(nonEmpty).default([]),
}).strict()

export const assistantTemplateSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  name: nonEmpty,
  description: z.string().optional(),
  icon: z.string().optional(),
  /** Optional avatar as a bounded data URL; empty string clears it. */
  avatar: z.string().max(400_000).optional(),
  instructions: z.string(),
  provider: nonEmpty,
  model: nonEmpty,
  reasoningEffort: nonEmpty.optional(),
  agentPresetId: nonEmpty,
  permissionPresetId: nonEmpty,
  skillAllowlist: z.array(nonEmpty),
  mcpServers: z.array(nonEmpty),
  /** Whether the template appears in assistant pickers (AionUi "已启用"). */
  enabled: z.boolean().default(true),
  /** Whether teams may recruit this template; false keeps it out of team pickers. */
  teamSelectable: z.boolean().default(true),
  /** Ascending display order shared by the assistant library and every picker. */
  sortOrder: z.int().nonnegative().default(0),
  /** Suggestions shown on the member's empty-session hero. */
  prompts: z.array(nonEmpty).default([]),
  /** Provenance: manual template, AI-generated template, or shipped built-in. */
  source: z.enum(['builtin', 'generated', 'user']).default('user'),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

/**
 * One persisted Assistant: a snapshot bound to a workspace, with the lazily
 * created main Session recorded on first open. Creation never makes a Session;
 * `mainSessionId` stays absent until the runtime binds it. `templateId` is
 * present only when the instance was derived from an assistant template; a
 * directly configured instance has none.
 */
export const assistantInstanceSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  templateId: nonEmpty.optional(),
  assistantSnapshot: assistantSnapshotSchema,
  workspaceId: nonEmpty,
  workspacePath: nonEmpty,
  mainSessionId: nonEmpty.optional(),
  status: z.enum(['idle', 'starting', 'active', 'error', 'archived']),
  pinned: z.boolean().default(false),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
  archivedAt: isoDate.optional(),
}).strict()

export const assistantTaskStatusSchema = z.enum([
  'queued',
  'running',
  'needs_input',
  'completed',
  'failed',
  'cancelled',
])

/**
 * One hidden worker Session owned by an Assistant instance. Phase 1 only
 * creates `task` rows: the main conversation is tracked on the instance itself,
 * and no assignment/consult lifecycle exists yet.
 */
export const assistantSessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  assistantId: nonEmpty,
  sessionId: nonEmpty,
  role: z.literal('task'),
  title: nonEmpty,
  brief: z.string(),
  /** The assistant instance's main Session that requested this task. */
  parentSessionId: nonEmpty,
  status: assistantTaskStatusSchema,
  /** Compact result written by `assistant_task_summary`. */
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  archivedAt: isoDate.optional(),
}).strict()

/** Who may read one entry; `private` never leaves its own scope. */
export const memoryVisibilitySchema = z.enum(['private', 'team-safe'])

/** Lifecycle of one entry; only `active` entries enter a prompt. */
export const memoryEntryStatusSchema = z.enum(['active', 'proposed', 'superseded', 'archived'])

/** Who wrote one entry. `auto` is reserved for future capture. */
export const memoryEntrySourceSchema = z.enum(['user', 'leader', 'member', 'assistant', 'auto'])

/**
 * One structured memory entry. The owning record supplies the scope id, so an
 * entry carries only its kind. Added without a schema-version bump: legacy rows
 * have no `entries` array and keep parsing.
 */
export const memoryEntrySchema = z.object({
  id: nonEmpty,
  scope: z.enum(['assistant', 'team']),
  visibility: memoryVisibilitySchema.default('private'),
  status: memoryEntryStatusSchema.default('active'),
  source: memoryEntrySourceSchema,
  /** Member slot that proposed or wrote the entry; absent for assistant-only writes. */
  authorSlotId: nonEmpty.optional(),
  /** Stable team-facing key; assistant entries usually leave it unset. */
  key: nonEmpty.optional(),
  title: nonEmpty,
  body: z.string(),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

/**
 * Durable memory for one Assistant instance, keyed by `assistantId`. `content`
 * is the legacy shared note; `entries` adds structured, visibility-aware rows.
 * Both are optional-by-history: a row written before structured memory existed
 * carries no `entries` and loads unchanged.
 */
export const assistantMemorySchema = z.object({
  schemaVersion: z.literal(1),
  assistantId: nonEmpty,
  content: z.string(),
  entries: z.array(memoryEntrySchema).optional(),
  revision: z.int().positive(),
  updatedAt: isoDate,
}).strict()

/**
 * Team-scoped structured memory. Stored inside the team aggregate without a
 * schema-version bump: a team that never wrote memory carries no `memory` field
 * and loads unchanged. `revision` fences memory writes only; the aggregate
 * revision keeps tracking board, roster, and Goal changes.
 */
export const teamMemorySchema = z.object({
  revision: z.int().positive(),
  entries: z.array(memoryEntrySchema).default([]),
  updatedAt: isoDate,
}).strict()

/** Statuses an Assistant main Session may set directly; `proposed` is team-only. */
export const assistantMemoryEntryStatusSchema = z.enum(['active', 'archived'])

/**
 * One structured-memory write. `id` must name an existing entry (revision bump);
 * an absent id creates a new entry. Visibility defaults to `private`.
 */
export const writeAssistantMemoryEntryInputSchema = z.object({
  id: nonEmpty.optional(),
  visibility: memoryVisibilitySchema.optional(),
  status: assistantMemoryEntryStatusSchema.optional(),
  key: nonEmpty.optional(),
  title: nonEmpty,
  body: z.string(),
}).strict()

export const assistantMemoryModeSchema = z.enum(['replace', 'append'])

export const memberRuntimeStateSchema = z.enum([
  'offline',
  'starting',
  'idle',
  'running',
  'waiting_approval',
  'error',
])

export const teamMemberSlotSchema = z.object({
  id: nonEmpty,
  assistantId: nonEmpty,
  /**
   * Explicitly linked Assistant instance. Added without a schema-version bump:
   * a member stored before the link existed carries no field and loads
   * unchanged, and no template or workspace inference ever fills it in.
   */
  assistantInstanceId: nonEmpty.optional(),
  displayName: nonEmpty,
  role: z.enum(['leader', 'member']),
  assistantSnapshot: assistantSnapshotSchema,
  permissionPresetId: nonEmpty,
  reasoningEffort: nonEmpty.optional(),
  sessionId: nonEmpty,
  desiredState: z.enum(['online', 'offline', 'removing']),
  lastRuntimeState: memberRuntimeStateSchema,
  /** Last startup/context-reset failure, kept for the member's retry affordance. */
  lastError: z.string().optional(),
  joinedAt: isoDate,
}).strict()

export const retiredMemberSessionSchema = z.object({
  formerSlotId: nonEmpty,
  sessionId: nonEmpty,
  displayName: nonEmpty,
  removedAt: isoDate,
}).strict()

/** How much orchestration one Goal warrants; the Leader classifies before creating tasks. */
export const teamGoalModeSchema = z.enum(['direct', 'single', 'orchestrated'])

/**
 * `paused` is set by the epoch transition (a Leader change) and cleared by the
 * new Leader through `team_mode_goal_update`; a Goal that was already
 * completed or cancelled stays as history.
 */
export const teamGoalStatusSchema = z.enum(['active', 'paused', 'completed', 'cancelled'])

/**
 * One objective above the task board. Added without a schema-version bump: a
 * team that never created a Goal carries no `goals` record and loads unchanged.
 */
export const teamGoalSchema = z.object({
  id: nonEmpty,
  teamId: nonEmpty,
  title: nonEmpty,
  objective: nonEmpty,
  /** Done-when statement; empty for a `direct` goal that needs no deliverable. */
  acceptance: z.string(),
  mode: teamGoalModeSchema,
  status: teamGoalStatusSchema,
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

/**
 * Optional task protocol vocabulary, added without a schema-version bump. Only
 * `review` and `verification` carry an enforced rule: they complete only with
 * `verdict=pass`. A task without a kind is legacy and reads as `work` through
 * `taskKindOf`, so old boards behave exactly as before.
 */
export const teamTaskKindSchema = z.enum([
  'work',
  'implementation',
  'repair',
  'verification',
  'review',
])
export const teamTaskVerdictSchema = z.enum(['pass', 'needs_revision', 'reject'])

export const teamTaskSchema = z.object({
  id: nonEmpty,
  title: nonEmpty,
  description: z.string(),
  status: z.enum(['pending', 'assigned', 'running', 'blocked', 'completed', 'failed', 'cancelled']),
  ownerSlotId: nonEmpty.optional(),
  /** Task kind; absent on legacy rows, which read as `work`. */
  kind: teamTaskKindSchema.optional(),
  /** Done-when statement for a reviewable task; absent when not stated. */
  acceptance: z.string().optional(),
  /** The implementation/repair task a review or verification task judges. */
  reviewedTaskId: nonEmpty.optional(),
  /**
   * Decision recorded by the review/verification owner; findings for a failing
   * verdict stay in `error`. Cleared whenever the task leaves a terminal state.
   */
  verdict: teamTaskVerdictSchema.optional(),
  /**
   * Ownership fence, added without a schema-version bump: minted whenever the
   * task gains or changes an owner. Member updates must present this token, so
   * a late update from a taken-over owner is rejected. Tasks stored before this
   * field existed carry no token and stay unfenced (see updateTask).
   */
  attemptId: nonEmpty.optional(),
  createdBySlotId: nonEmpty.optional(),
  /**
   * Optional Goal grouping, added without a schema-version bump. A task stored
   * before Goals existed (or never grouped) carries none and stays valid.
   */
  goalId: nonEmpty.optional(),
  dependencyIds: z.array(nonEmpty),
  fileScopes: z.array(nonEmpty),
  result: z.string().optional(),
  error: z.string().optional(),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const fileScopeLeaseSchema = z.object({
  id: nonEmpty,
  slotId: nonEmpty,
  taskId: nonEmpty,
  path: nonEmpty,
  acquiredAt: isoDate,
  expiresAt: isoDate.optional(),
}).strict()

const attachmentRefSchema = z.object({
  kind: z.enum(['workspace_path', 'url']),
  value: nonEmpty,
  label: z.string().optional(),
}).strict()

export const teamMessageSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty,
  sender: z.object({
    kind: z.enum(['user', 'member', 'system']),
    id: nonEmpty,
  }).strict(),
  recipient: z.object({
    kind: z.enum(['leader', 'member', 'broadcast']),
    slotId: nonEmpty.optional(),
  }).strict(),
  type: z.enum(['instruction', 'progress', 'result', 'question', 'warning', 'system']),
  content: z.string(),
  /** Short mailbox preview; the full message stays in `content`. */
  summary: z.string().optional(),
  relatedTaskId: nonEmpty.optional(),
  /**
   * Optional thread context, added without a schema-version bump: a thread is
   * a conversation key shared by related messages, separate from the single
   * task link in `relatedTaskId`. Legacy records carry none and parse as-is.
   */
  threadId: nonEmpty.optional(),
  /** Goal this message contributes to; always the task's Goal for dispatch mail. */
  goalId: nonEmpty.optional(),
  /** Message this one replies to, for a handoff/result pair. */
  replyTo: nonEmpty.optional(),
  attachments: z.array(attachmentRefSchema),
  /** Per-recipient read receipts; broadcast messages share one record. */
  readBy: z.array(nonEmpty).default([]),
  deliveryState: z.enum(['queued', 'delivered', 'read', 'failed']),
  idempotencyKey: nonEmpty,
  createdAt: isoDate,
}).strict()

export const teamAggregateSchema = z.object({
  // v1 records open unchanged; the store migrates them to v2 at startup.
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  id: nonEmpty,
  name: nonEmpty,
  workspaceId: nonEmpty,
  workspacePath: nonEmpty,
  leaderSlotId: nonEmpty,
  state: z.enum([
    'draft',
    'starting',
    'active',
    'ownership_conflict',
    'deleting',
    'delete_blocked',
    'error',
  ]),
  directMemberChat: z.boolean(),
  members: z.record(z.string(), teamMemberSlotSchema),
  retiredSessions: z.record(z.string(), retiredMemberSessionSchema),
  tasks: z.record(z.string(), teamTaskSchema),
  /** Optional Goal layer; absent for every team that never created one. */
  goals: z.record(z.string(), teamGoalSchema).optional(),
  /** Optional team memory; absent for every team that never wrote any. */
  memory: teamMemorySchema.optional(),
  leases: z.record(z.string(), fileScopeLeaseSchema),
  outbox: z.record(z.string(), teamMessageSchema),
  /** Sidebar/team-list presentation state (v2). */
  pinned: z.boolean().optional(),
  archivedAt: isoDate.optional(),
  /** Stable member order for the capsule bar; Leader remains first (v2). */
  memberOrder: z.array(nonEmpty).optional(),
  /**
   * Leadership generation (`epochOf` = this ?? 1). Optional on purpose: no
   * schema-version bump, no migration, and every v1/v2 record opens unchanged
   * (same precedent as `goals` and `memory`). Only `changeLeader` writes it, and
   * it only ever increases.
   */
  epoch: z.int().positive().optional(),
  /** Startup/warmup projection (v2); absent for a team that never warmed up. */
  warmup: z.object({
    phase: z.enum(['idle', 'starting', 'leader-ready', 'ready', 'error']),
    startedAt: isoDate,
    leaderReadyAt: isoDate.optional(),
    failedSlotIds: z.array(nonEmpty).optional(),
  }).strict().optional(),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const teamActivitySchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty,
  kind: nonEmpty,
  entityId: nonEmpty.optional(),
  summary: z.string(),
  revision: z.int().nonnegative(),
  createdAt: isoDate,
}).strict()

export const operationSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty.optional(),
  kind: z.enum(['dissolve_team', 'remove_member', 'sync_member', 'migrate_records']),
  state: z.enum(['pending', 'running', 'blocked', 'completed', 'failed']),
  stage: nonEmpty,
  cursor: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const migrationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  appliedAt: isoDate,
  fromVersion: z.int().nonnegative(),
  toVersion: z.int().positive(),
}).strict()

export const migrationBackupSchema = z.object({
  schemaVersion: z.literal(1),
  table: nonEmpty,
  key: nonEmpty,
  capturedAt: isoDate,
  record: z.unknown(),
}).strict()

export const createAssistantInputSchema = assistantTemplateSchema.pick({
  name: true,
  description: true,
  icon: true,
  avatar: true,
  instructions: true,
  provider: true,
  model: true,
  reasoningEffort: true,
  agentPresetId: true,
  permissionPresetId: true,
  skillAllowlist: true,
  mcpServers: true,
}).extend({
  /** Omitted on legacy callers; the service applies the enabled/team defaults. */
  enabled: z.boolean().optional(),
  teamSelectable: z.boolean().optional(),
  prompts: z.array(z.string()).optional(),
})

export const updateAssistantInputSchema = createAssistantInputSchema.partial().extend({
  sortOrder: z.int().nonnegative().optional(),
}).strict()

/**
 * Fields shared by both creation shapes. A template-backed instance may name
 * any of them to override the template snapshot; a direct instance must supply
 * the identity and engine fields.
 */
const assistantInstanceOverrides = {
  workspaceId: nonEmpty,
  name: nonEmpty.optional(),
  avatar: z.string().max(400_000).optional(),
  provider: nonEmpty.optional(),
  model: nonEmpty.optional(),
  /** Empty clears the inherited effort; an absent field keeps it. */
  reasoningEffort: z.string().trim().optional(),
  agentPresetId: nonEmpty.optional(),
  permissionPresetId: nonEmpty.optional(),
  instructions: z.string().optional(),
  pinned: z.boolean().optional(),
} as const

/**
 * Create an Assistant instance from a template (with optional snapshot
 * overrides) or directly from a complete configuration. The direct shape is
 * what the DS Bot-style create dialog sends: no template row is needed, but
 * name, provider, model, agent preset, and permission preset are required.
 */
export const createAssistantInstanceInputSchema = z.union([
  z.object({
    ...assistantInstanceOverrides,
    templateId: nonEmpty,
  }).strict(),
  z.object({
    ...assistantInstanceOverrides,
    templateId: z.undefined().optional(),
    name: nonEmpty,
    provider: nonEmpty,
    model: nonEmpty,
    agentPresetId: nonEmpty,
    permissionPresetId: nonEmpty,
  }).strict(),
])

/**
 * Patch an instance snapshot; an empty object leaves every field unchanged.
 * `provider` and `model` travel together: changing either one must name both so
 * the service can validate the pair. An empty `reasoningEffort` clears the
 * recorded effort and falls back to the model default.
 */
export const updateAssistantInstanceInputSchema = z.object({
  name: nonEmpty.optional(),
  avatar: z.string().max(400_000).optional(),
  pinned: z.boolean().optional(),
  provider: nonEmpty.optional(),
  model: nonEmpty.optional(),
  reasoningEffort: z.string().trim().optional(),
  permissionPresetId: nonEmpty.optional(),
}).strict()

/** Runtime-owned record of one hidden worker Session; the service assigns ids and timestamps. */
export const createAssistantSessionInputSchema = z.object({
  assistantId: nonEmpty,
  sessionId: nonEmpty,
  title: nonEmpty,
  brief: z.string(),
  parentSessionId: nonEmpty,
}).strict()

/** Status/result updates; an empty patch leaves the record unchanged. */
export const updateAssistantSessionInputSchema = z.object({
  title: nonEmpty.optional(),
  status: assistantTaskStatusSchema.optional(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  archivedAt: isoDate.optional(),
}).strict()

export const createTeamMemberInputSchema = z.object({
  assistantId: nonEmpty,
  role: z.enum(['leader', 'member']),
  /** Optional explicit Assistant instance link; never inferred. */
  assistantInstanceId: nonEmpty.optional(),
}).strict()

/**
 * One member→Assistant instance link update. `null` clears the link; a string
 * must name an existing, linkable instance of the same workspace.
 */
export const memberAssistantInstanceLinkSchema = z.string().trim().min(1).nullable()

export const addTeamMemberInputSchema = createTeamMemberInputSchema.omit({ role: true }).extend({
  /** Team-local display name; defaults to the assistant template name. */
  displayName: nonEmpty.max(80).optional(),
}).strict()

export const createTeamDraftInputSchema = z.object({
  name: nonEmpty,
  workspaceId: nonEmpty,
  directMemberChat: z.boolean().optional(),
  members: z.array(createTeamMemberInputSchema).min(1),
}).strict()

export const cloneTeamInputSchema = z.object({
  name: nonEmpty,
  workspaceId: nonEmpty,
}).strict()

/** A Goal is created for an objective, not for chatter; mode defaults to one deliverable. */
export const createTeamGoalInputSchema = z.object({
  title: nonEmpty,
  objective: nonEmpty,
  acceptance: z.string().optional(),
  mode: teamGoalModeSchema.optional(),
}).strict()

export const updateTeamGoalInputSchema = z.object({
  title: nonEmpty.optional(),
  objective: nonEmpty.optional(),
  acceptance: z.string().optional(),
  mode: teamGoalModeSchema.optional(),
  status: teamGoalStatusSchema.optional(),
}).strict()
