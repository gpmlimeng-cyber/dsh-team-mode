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
 * One persisted Assistant: a template snapshot bound to a workspace, with the
 * lazily created main Session recorded on first open. Creation never makes a
 * Session; `mainSessionId` stays absent until the runtime binds it.
 */
export const assistantInstanceSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  templateId: nonEmpty,
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

export const teamTaskSchema = z.object({
  id: nonEmpty,
  title: nonEmpty,
  description: z.string(),
  status: z.enum(['pending', 'assigned', 'running', 'blocked', 'completed', 'failed', 'cancelled']),
  ownerSlotId: nonEmpty.optional(),
  createdBySlotId: nonEmpty.optional(),
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
  leases: z.record(z.string(), fileScopeLeaseSchema),
  outbox: z.record(z.string(), teamMessageSchema),
  /** Sidebar/team-list presentation state (v2). */
  pinned: z.boolean().optional(),
  archivedAt: isoDate.optional(),
  /** Stable member order for the capsule bar; Leader remains first (v2). */
  memberOrder: z.array(nonEmpty).optional(),
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

export const createAssistantInstanceInputSchema = z.object({
  templateId: nonEmpty,
  name: nonEmpty.optional(),
  avatar: z.string().max(400_000).optional(),
  workspaceId: nonEmpty,
  pinned: z.boolean().optional(),
}).strict()

/** Patch an instance snapshot; an empty object leaves every field unchanged. */
export const updateAssistantInstanceInputSchema = z.object({
  name: nonEmpty.optional(),
  avatar: z.string().max(400_000).optional(),
  pinned: z.boolean().optional(),
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
}).strict()

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
