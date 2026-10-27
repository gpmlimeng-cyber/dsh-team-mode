import { z } from 'zod'
import {
  SIDEBAR_GROUP_BRIEF_MAX_CHARS,
  SIDEBAR_GROUP_MAX_CHARS,
  assistantMascotSchema,
} from './schemas.js'
import type { AssistantSnapshot } from './types.js'

/**
 * One portable group document (a "group export"). It is deliberately smaller
 * than the stored records, so an export can be pasted into a chat or committed
 * to a dotfiles repo without leaking state:
 *
 * - never carried: ids/revisions, `memoryKey`, workspace id/path, session ids
 *   (main/thread/retired), assistant memory and journal, team tasks, outbox,
 *   leases, threads, goals, checkpoints, conversations of any kind, avatar
 *   photo bytes, prompts, tool policies, and deployment-only switches;
 * - carried: group name/brief, and per assistant/team-member the portable
 *   profile (model, reasoning effort, permission preset, agent preset, skill
 *   allowlist, MCP servers, persona text) plus the mascot identity (a look,
 *   not a photo) and the auto-capture preference.
 *
 * Import re-derives availability from the local catalogs; the informational
 * `skills`/`mcpServers` unions are a preview aid and are ignored on import.
 */

export const GROUP_SHARE_KIND = 'dsh-team-mode/group-export'
export const GROUP_SHARE_SCHEMA_VERSION = 1

/** Hard cap on one portable document, measured in bytes of its JSON form. */
export const GROUP_SHARE_MAX_DOCUMENT_BYTES = 1024 * 1024
/** Body ceiling for the two import methods: the document plus envelope slack. */
export const GROUP_SHARE_MAX_REQUEST_BYTES = GROUP_SHARE_MAX_DOCUMENT_BYTES + 64 * 1024

/**
 * Portable names share the 80-character member-name convention: longer text
 * cannot survive `renameMember`, so the export refuses it instead of letting
 * an import silently truncate.
 */
export const GROUP_SHARE_NAME_MAX_CHARS = 80
export const GROUP_SHARE_MAX_INSTRUCTIONS_CHARS = 64 * 1024
export const GROUP_SHARE_MAX_TEAMS = 100
export const GROUP_SHARE_MAX_ASSISTANTS = 200
/** Matches the deployment ceiling of one team's member slots. */
export const GROUP_SHARE_MAX_TEAM_MEMBERS = 64
export const GROUP_SHARE_MAX_REFERENCES = 256

const name = z.string().trim().min(1).max(GROUP_SHARE_NAME_MAX_CHARS)
const reference = z.string().trim().min(1).max(200)
const isoDate = z.iso.datetime({ offset: true })

/**
 * The portable half of an Assistant snapshot: everything that makes the
 * Assistant behave the same way, and nothing that binds it to a machine.
 */
export const portableAssistantProfileSchema = z.object({
  name,
  instructions: z.string().max(GROUP_SHARE_MAX_INSTRUCTIONS_CHARS).default(''),
  provider: reference,
  model: reference,
  reasoningEffort: z.string().trim().min(1).max(100).optional(),
  agentPresetId: reference,
  permissionPresetId: reference,
  skillAllowlist: z.array(reference).max(GROUP_SHARE_MAX_REFERENCES).default([]),
  mcpServers: z.array(reference).max(GROUP_SHARE_MAX_REFERENCES).default([]),
}).strict()

/**
 * One team member. `profile` is what the materialized Assistant template is
 * built from; `permissionPresetId`/`reasoningEffort` are the slot's effective
 * values (activation reads the slot, not the template), so they ride along
 * whenever they differ from the profile.
 */
export const portableTeamMemberSchema = z.object({
  displayName: name,
  role: z.enum(['leader', 'member']),
  profile: portableAssistantProfileSchema,
  permissionPresetId: reference.optional(),
  reasoningEffort: z.string().trim().min(1).max(100).optional(),
}).strict()

export const portableTeamSchema = z.object({
  name,
  directMemberChat: z.boolean().optional(),
  members: z.array(portableTeamMemberSchema).min(1).max(GROUP_SHARE_MAX_TEAM_MEMBERS),
}).strict()

/** One Assistant instance that belongs to the exported group. */
export const portableAssistantEntrySchema = z.object({
  profile: portableAssistantProfileSchema,
  mascot: assistantMascotSchema.optional(),
  memoryAutoCapture: z.boolean().optional(),
}).strict()

export const groupExportDocumentSchema = z.object({
  kind: z.literal(GROUP_SHARE_KIND),
  schemaVersion: z.literal(GROUP_SHARE_SCHEMA_VERSION),
  exportedAt: isoDate,
  group: z.object({
    name: z.string().trim().min(1).max(SIDEBAR_GROUP_MAX_CHARS),
    brief: z.string().max(SIDEBAR_GROUP_BRIEF_MAX_CHARS).default(''),
  }).strict(),
  assistants: z.array(portableAssistantEntrySchema).max(GROUP_SHARE_MAX_ASSISTANTS).default([]),
  teams: z.array(portableTeamSchema).max(100).default([]),
  /** Informational unions; import ignores them and re-derives availability. */
  skills: z.array(reference).max(512).optional(),
  mcpServers: z.array(reference).max(512).optional(),
}).strict()

export type PortableAssistantProfile = z.infer<typeof portableAssistantProfileSchema>
export type PortableAssistantEntry = z.infer<typeof portableAssistantEntrySchema>
export type PortableTeamMember = z.infer<typeof portableTeamMemberSchema>
export type PortableTeam = z.infer<typeof portableTeamSchema>
export type PortableMascot = z.infer<typeof assistantMascotSchema>
export type GroupExportDocument = z.infer<typeof groupExportDocumentSchema>

/** Names dropped from one profile because this machine cannot resolve them. */
export interface GroupImportDropped {
  skills?: string[]
  mcpServers?: string[]
  reasoningEffort?: string
}

export type GroupImportAction = 'create' | 'reuse' | 'skip'
export type GroupImportRowStatus = 'created' | 'reused' | 'skipped' | 'rejected'

export interface GroupImportAssistantPlan {
  name: string
  plannedName: string
  action: GroupImportAction
  reason?: string
  profile?: PortableAssistantProfile
  mascot?: PortableMascot
  memoryAutoCapture?: boolean
  dropped?: GroupImportDropped
}

export interface GroupImportTemplatePlan {
  name: string
  plannedName: string
  action: 'create' | 'reuse'
  profile: PortableAssistantProfile
}

export interface GroupImportMemberPlan {
  displayName: string
  role: 'leader' | 'member'
  /** Planned name of the Assistant template this member is built from. */
  templateName: string
  permissionPresetId: string
  reasoningEffort?: string
}

export interface GroupImportTeamPlan {
  name: string
  plannedName: string
  action: GroupImportAction
  reason?: string
  directMemberChat?: boolean
  members: GroupImportMemberPlan[]
}

/** What one import will do, reviewable before any write. */
export interface GroupImportPreview {
  schemaVersion: 1
  group: {
    requested: string
    plannedName: string
    renamed: boolean
    briefChars: number
  }
  assistants: GroupImportAssistantPlan[]
  templates: GroupImportTemplatePlan[]
  teams: GroupImportTeamPlan[]
  /** Availability of every referenced name, across the presets that use it. */
  skills: Array<{ name: string, available: boolean }>
  mcpServers: Array<{ name: string, available: boolean }>
  warnings: string[]
  counts: {
    assistants: number
    templates: number
    teams: number
    members: number
    skipped: number
  }
  /** Fence: `import` refuses a document whose plan no longer hashes to this. */
  planHash: string
}

export interface GroupImportResultRow {
  kind: 'group' | 'assistant' | 'template' | 'team'
  /** Name as written in the document (or the planned one for a template). */
  name: string
  plannedName?: string
  status: GroupImportRowStatus
  reason?: string
}

/** What one import actually did, item by item. */
export interface GroupImportResult {
  schemaVersion: 1
  groupName: string
  rows: GroupImportResultRow[]
  warnings: string[]
  counts: { created: number, reused: number, skipped: number, rejected: number }
}

/**
 * Deterministic conflict suffix: `工作` → `工作 (2)` → `工作 (3)`. The base is
 * truncated so the suffix still fits, and an existing suffixed name is skipped
 * instead of reused, so a collision never overwrites anything.
 */
export function uniqueName(
  desired: string,
  taken: Iterable<string>,
  maxChars = GROUP_SHARE_NAME_MAX_CHARS,
): string {
  const used = new Set(taken)
  const base = desired.trim().slice(0, maxChars)
  if (!used.has(base)) return base
  for (let index = 2; ; index += 1) {
    const suffix = ` (${index})`
    const candidate = `${base.slice(0, Math.max(1, maxChars - suffix.length)).trimEnd()}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/** Bytes of the document's JSON form; the cap applies to this number. */
export function portableDocumentBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

/**
 * The handful of fields that make a document too large, biggest first. An
 * error names them so the user knows what to shorten instead of guessing.
 */
export function largestPortableFields(document: GroupExportDocument, limit = 3): string[] {
  const rows: Array<{ field: string, bytes: number }> = [
    { field: 'group.brief', bytes: byteSize(document.group.brief) },
    ...document.assistants.map((entry, index) => ({
      field: `assistants[${index}].instructions`,
      bytes: byteSize(entry.profile.instructions),
    })),
    ...document.teams.flatMap((team, teamIndex) => team.members.map((member, index) => ({
      field: `teams[${teamIndex}].members[${index}].instructions`,
      bytes: byteSize(member.profile.instructions),
    }))),
  ]
  return rows
    .filter(row => row.bytes > 0)
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit)
    .map(row => `${row.field} (${row.bytes} bytes)`)
}

/** The portable profile of one stored snapshot: ids, avatar, prompts dropped. */
export function portableProfileFromSnapshot(snapshot: AssistantSnapshot): PortableAssistantProfile {
  return {
    name: snapshot.name,
    instructions: snapshot.instructions,
    provider: snapshot.provider,
    model: snapshot.model,
    ...(snapshot.reasoningEffort === undefined ? {} : { reasoningEffort: snapshot.reasoningEffort }),
    agentPresetId: snapshot.agentPresetId,
    permissionPresetId: snapshot.permissionPresetId,
    skillAllowlist: [...snapshot.skillAllowlist],
    mcpServers: [...snapshot.mcpServers],
  }
}

/**
 * Whether two portable profiles describe the same Assistant. Used to reuse one
 * local template for repeated snapshots; list order and whitespace never count.
 */
export function samePortableProfile(
  left: PortableAssistantProfile,
  right: PortableAssistantProfile,
): boolean {
  return JSON.stringify(normalizedProfile(left)) === JSON.stringify(normalizedProfile(right))
}

function normalizedProfile(profile: PortableAssistantProfile): Record<string, unknown> {
  return {
    name: profile.name.trim(),
    instructions: profile.instructions,
    provider: profile.provider.trim(),
    model: profile.model.trim(),
    reasoningEffort: profile.reasoningEffort?.trim() ?? '',
    agentPresetId: profile.agentPresetId.trim(),
    permissionPresetId: profile.permissionPresetId.trim(),
    skillAllowlist: sortedReferences(profile.skillAllowlist),
    mcpServers: sortedReferences(profile.mcpServers),
  }
}

function sortedReferences(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort()
}

function byteSize(text: string): number {
  return new TextEncoder().encode(text).byteLength
}
