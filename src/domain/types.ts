import type { z } from 'zod'
import type {
  assistantInstanceSchema,
  assistantMemoryModeSchema,
  assistantMemorySchema,
  checkpointFactsSchema,
  contextCheckpointSchema,
  contextCheckpointStatusSchema,
  memoryEntrySchema,
  assistantSessionSchema,
  assistantSnapshotSchema,
  addTeamMemberInputSchema,
  assistantTemplateSchema,
  cloneTeamInputSchema,
  createAssistantInputSchema,
  createAssistantInstanceInputSchema,
  createAssistantSessionInputSchema,
  createTeamDraftInputSchema,
  createTeamGoalInputSchema,
  createTeamMemberInputSchema,
  fileScopeLeaseSchema,
  memoryEntrySourceSchema,
  memoryEntryStatusSchema,
  memoryJournalActionSchema,
  memoryJournalEntrySchema,
  memoryJournalSnapshotSchema,
  memoryVisibilitySchema,
  memberRuntimeStateSchema,
  operationSchema,
  retiredMemberSessionSchema,
  teamActivitySchema,
  teamAggregateSchema,
  teamGoalModeSchema,
  teamGoalSchema,
  teamGoalStatusSchema,
  teamMemberSlotSchema,
  teamMemorySchema,
  teamMessageSchema,
  teamTaskKindSchema,
  teamTaskSchema,
  teamTaskVerdictSchema,
  updateAssistantInputSchema,
  updateAssistantInstanceInputSchema,
  updateAssistantSessionInputSchema,
  updateTeamGoalInputSchema,
  writeAssistantMemoryEntryInputSchema,
} from './schemas.js'

export type AssistantSnapshot = z.infer<typeof assistantSnapshotSchema>
export type AssistantTemplate = z.infer<typeof assistantTemplateSchema>
export type AssistantInstance = z.infer<typeof assistantInstanceSchema>
export type CreateAssistantInstanceInput = z.infer<typeof createAssistantInstanceInputSchema>
export type UpdateAssistantInstanceInput = z.infer<typeof updateAssistantInstanceInputSchema>
export type AssistantMemory = z.infer<typeof assistantMemorySchema>
export type AssistantMemoryMode = z.infer<typeof assistantMemoryModeSchema>
export type MemoryEntry = z.infer<typeof memoryEntrySchema>
export type MemoryVisibility = z.infer<typeof memoryVisibilitySchema>
export type MemoryEntryStatus = z.infer<typeof memoryEntryStatusSchema>
export type MemoryEntrySource = z.infer<typeof memoryEntrySourceSchema>
export type MemoryJournalAction = z.infer<typeof memoryJournalActionSchema>
export type MemoryJournalSnapshot = z.infer<typeof memoryJournalSnapshotSchema>
export type MemoryJournalEntry = z.infer<typeof memoryJournalEntrySchema>
export type WriteAssistantMemoryEntryInput = z.infer<typeof writeAssistantMemoryEntryInputSchema>
export type CheckpointFacts = z.infer<typeof checkpointFactsSchema>
export type ContextCheckpoint = z.infer<typeof contextCheckpointSchema>
export type ContextCheckpointStatus = z.infer<typeof contextCheckpointStatusSchema>
export type AssistantSession = z.infer<typeof assistantSessionSchema>
/** Last visible message in an assistant's main Session, for sidebar preview. */
export interface AssistantPreview {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly time: number
}
export type CreateAssistantSessionInput = z.infer<typeof createAssistantSessionInputSchema>
export type UpdateAssistantSessionInput = z.infer<typeof updateAssistantSessionInputSchema>
export type CreateAssistantInput = z.infer<typeof createAssistantInputSchema>
export type UpdateAssistantInput = z.infer<typeof updateAssistantInputSchema>
export type MemberRuntimeState = z.infer<typeof memberRuntimeStateSchema>
export type TeamMemberSlot = z.infer<typeof teamMemberSlotSchema>
export type RetiredMemberSession = z.infer<typeof retiredMemberSessionSchema>
export type TeamTask = z.infer<typeof teamTaskSchema>
export type TeamTaskKind = z.infer<typeof teamTaskKindSchema>
export type TeamTaskVerdict = z.infer<typeof teamTaskVerdictSchema>

/**
 * The single reader for the optional task kind: absent means `work`, the
 * pre-vocabulary behavior. Never write `?? 'work'` inline.
 */
export function taskKindOf(task: Pick<TeamTask, 'kind'>): TeamTaskKind {
  return task.kind ?? 'work'
}
export type TeamGoal = z.infer<typeof teamGoalSchema>
export type TeamGoalMode = z.infer<typeof teamGoalModeSchema>
export type TeamGoalStatus = z.infer<typeof teamGoalStatusSchema>
export type CreateTeamGoalInput = z.infer<typeof createTeamGoalInputSchema>
export type UpdateTeamGoalInput = z.infer<typeof updateTeamGoalInputSchema>

/** Turns a Goal has already spent; absent counters mean none. Never write `?? 0` inline. */
export function goalTurnsUsed(goal: Pick<TeamGoal, 'usedTurns'>): number {
  return goal.usedTurns ?? 0
}

/**
 * The single reader for a Goal's budget state. `unbounded` is every Goal stored
 * before budgets existed (and every Goal that never set `maxTurns`); `exhausted`
 * is derived from the counters alone, so a renewal takes effect immediately and
 * `goal.status` stays the only lifecycle authority.
 */
export function goalBudgetOf(goal: Pick<TeamGoal, 'maxTurns' | 'usedTurns'>): 'unbounded' | 'available' | 'exhausted' {
  if (goal.maxTurns === undefined) return 'unbounded'
  return goalTurnsUsed(goal) >= goal.maxTurns ? 'exhausted' : 'available'
}

/** Whether the Leader-set ceiling is reached. */
export function goalBudgetExhausted(goal: Pick<TeamGoal, 'maxTurns' | 'usedTurns'>): boolean {
  return goalBudgetOf(goal) === 'exhausted'
}

/**
 * Record one dispatch turn against a Goal budget. The caller charges only when
 * the operation actually starts another member's turn, so plain bookkeeping
 * stays free. The stamp is kept on later over-budget writes.
 */
export function chargeGoalTurn(goal: TeamGoal, now: string): TeamGoal {
  const usedTurns = goalTurnsUsed(goal) + 1
  const exhausted = goal.maxTurns !== undefined && usedTurns >= goal.maxTurns
  return {
    ...goal,
    usedTurns,
    ...(exhausted && goal.budgetExhaustedAt === undefined
      ? { budgetExhaustedAt: now }
      : {}),
    updatedAt: now,
  }
}

/**
 * Set/replace a Goal ceiling (the renewal path). Raising it above the spent
 * count clears the exhaustion stamp; the counters themselves are never reset,
 * so a renewal is auditable and the next charge continues from `usedTurns`.
 */
export function setGoalBudget(goal: TeamGoal, maxTurns: number, now: string): TeamGoal {
  const usedTurns = goalTurnsUsed(goal)
  const next: TeamGoal = {
    ...goal,
    maxTurns,
    usedTurns,
    updatedAt: now,
  }
  if (usedTurns < maxTurns) delete next.budgetExhaustedAt
  else next.budgetExhaustedAt = goal.budgetExhaustedAt ?? now
  return next
}
export type FileScopeLease = z.infer<typeof fileScopeLeaseSchema>
export type TeamAggregate = z.infer<typeof teamAggregateSchema>

/**
 * Leadership generation of one team. An absent field means the first epoch: a
 * team that never changed Leader behaves exactly as before the field existed.
 * This is the single reader for the optional persisted field; never write
 * `?? 1` inline.
 */
export function epochOf(team: Pick<TeamAggregate, 'epoch'>): number {
  return team.epoch ?? 1
}
export type TeamMemory = z.infer<typeof teamMemorySchema>
export type TeamMessage = z.infer<typeof teamMessageSchema>
export type TeamActivity = z.infer<typeof teamActivitySchema>
export type Operation = z.infer<typeof operationSchema>
export type CreateTeamMemberInput = z.infer<typeof createTeamMemberInputSchema>
export type AddTeamMemberInput = z.infer<typeof addTeamMemberInputSchema>
export type CreateTeamDraftInput = z.infer<typeof createTeamDraftInputSchema>
export type CloneTeamInput = z.infer<typeof cloneTeamInputSchema>

/** How a member's explicit Assistant instance link resolved for prompt injection. */
export type AssistantMemoryLinkState = 'unlinked' | 'linked' | 'archived' | 'unavailable'

/**
 * Prompt-facing read of one linked Assistant instance's memory. A stale or
 * unavailable link degrades to a non-`linked` state with no entries instead of
 * throwing, so an archived instance never breaks a running member session.
 */
export interface LinkedAssistantMemory {
  state: AssistantMemoryLinkState
  entries: MemoryEntry[]
}

export interface Page<T> {
  items: T[]
  total: number
}

export function snapshotAssistant(assistant: AssistantTemplate): AssistantSnapshot {
  return {
    assistantId: assistant.id,
    revision: assistant.revision,
    name: assistant.name,
    ...(assistant.avatar === undefined ? {} : { avatar: assistant.avatar }),
    instructions: assistant.instructions,
    provider: assistant.provider,
    model: assistant.model,
    ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
    agentPresetId: assistant.agentPresetId,
    permissionPresetId: assistant.permissionPresetId,
    skillAllowlist: [...assistant.skillAllowlist],
    mcpServers: [...assistant.mcpServers],
    prompts: [...assistant.prompts],
  }
}
