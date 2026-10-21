import type { z } from 'zod'
import type {
  assistantInstanceSchema,
  assistantSessionSchema,
  assistantSnapshotSchema,
  addTeamMemberInputSchema,
  assistantTemplateSchema,
  cloneTeamInputSchema,
  createAssistantInputSchema,
  createAssistantInstanceInputSchema,
  createAssistantSessionInputSchema,
  createTeamDraftInputSchema,
  createTeamMemberInputSchema,
  fileScopeLeaseSchema,
  memberRuntimeStateSchema,
  operationSchema,
  retiredMemberSessionSchema,
  teamActivitySchema,
  teamAggregateSchema,
  teamMemberSlotSchema,
  teamMessageSchema,
  teamTaskSchema,
  updateAssistantInputSchema,
  updateAssistantInstanceInputSchema,
  updateAssistantSessionInputSchema,
} from './schemas.js'

export type AssistantSnapshot = z.infer<typeof assistantSnapshotSchema>
export type AssistantTemplate = z.infer<typeof assistantTemplateSchema>
export type AssistantInstance = z.infer<typeof assistantInstanceSchema>
export type CreateAssistantInstanceInput = z.infer<typeof createAssistantInstanceInputSchema>
export type UpdateAssistantInstanceInput = z.infer<typeof updateAssistantInstanceInputSchema>
export type AssistantSession = z.infer<typeof assistantSessionSchema>
export type CreateAssistantSessionInput = z.infer<typeof createAssistantSessionInputSchema>
export type UpdateAssistantSessionInput = z.infer<typeof updateAssistantSessionInputSchema>
export type CreateAssistantInput = z.infer<typeof createAssistantInputSchema>
export type UpdateAssistantInput = z.infer<typeof updateAssistantInputSchema>
export type MemberRuntimeState = z.infer<typeof memberRuntimeStateSchema>
export type TeamMemberSlot = z.infer<typeof teamMemberSlotSchema>
export type RetiredMemberSession = z.infer<typeof retiredMemberSessionSchema>
export type TeamTask = z.infer<typeof teamTaskSchema>
export type FileScopeLease = z.infer<typeof fileScopeLeaseSchema>
export type TeamAggregate = z.infer<typeof teamAggregateSchema>
export type TeamMessage = z.infer<typeof teamMessageSchema>
export type TeamActivity = z.infer<typeof teamActivitySchema>
export type Operation = z.infer<typeof operationSchema>
export type CreateTeamMemberInput = z.infer<typeof createTeamMemberInputSchema>
export type AddTeamMemberInput = z.infer<typeof addTeamMemberInputSchema>
export type CreateTeamDraftInput = z.infer<typeof createTeamDraftInputSchema>
export type CloneTeamInput = z.infer<typeof cloneTeamInputSchema>

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
