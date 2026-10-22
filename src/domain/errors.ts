export type AgentTeamErrorCode =
  | 'ASSISTANT_NOT_FOUND'
  | 'ASSISTANT_IN_USE'
  | 'ASSISTANT_BUILTIN_READONLY'
  | 'ASSISTANT_REVISION_CONFLICT'
  | 'MEMORY_REVISION_CONFLICT'
  | 'ASSISTANT_INSTANCE_NOT_FOUND'
  | 'ASSISTANT_INSTANCE_ARCHIVED'
  | 'ASSISTANT_INSTANCE_WORKSPACE_MISMATCH'
  | 'ASSISTANT_TASK_NOT_FOUND'
  | 'ASSISTANT_TASK_NOT_ACTIVE'
  | 'ASSISTANT_WORKER_LIMIT'
  | 'TEAM_NOT_FOUND'
  | 'TEAM_INVALID_LEADER'
  | 'TEAM_NAME_INVALID'
  | 'TEAM_REVISION_CONFLICT'
  | 'EPOCH_STALE'
  | 'TEAM_NOT_ACTIVE'
  | 'TEAM_DELETING'
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_IS_LEADER'
  | 'MEMBER_BUSY'
  | 'WORKSPACE_UNAVAILABLE'
  | 'WORKSPACE_GIT_UNAVAILABLE'
  | 'MODEL_REFERENCE_INVALID'
  | 'PRESET_REFERENCE_INVALID'
  | 'PERMISSION_PRESET_INVALID'
  | 'SKILL_REFERENCE_INVALID'
  | 'MCP_REFERENCE_INVALID'
  | 'PRESET_PROMPT_INCOMPATIBLE'
  | 'AGENT_HANDLE_OWNERSHIP_CONFLICT'
  | 'INTERACTION_INVALID'
  | 'INTERACTION_NOT_FOUND'
  | 'INTERACTION_NOT_PENDING'
  | 'SESSION_CREATE_FAILED'
  | 'TEAM_LIMIT_REACHED'
  | 'TEAM_DELETE_FAILED'
  | 'INVALID_REQUEST'

export class AgentTeamError extends Error {
  constructor(
    readonly code: AgentTeamErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AgentTeamError'
  }
}

export function isAgentTeamError(error: unknown): error is AgentTeamError {
  return error instanceof AgentTeamError
}

/**
 * One message for every stale-epoch rejection. A Session belongs to the epoch
 * it was activated under; after a Leader change it keeps its transcript but no
 * write authority, so the wording has to tell the model what to do instead of
 * inviting a retry.
 */
export function epochStaleError(teamId: string, epoch: number, expectedEpoch: number): AgentTeamError {
  return new AgentTeamError(
    'EPOCH_STALE',
    `Team epoch changed to ${epoch}; this Session belongs to epoch ${expectedEpoch} and is read-only. `
      + 'Wait for the Leader to re-dispatch or ask the user to reopen the team.',
    { teamId, epoch, expectedEpoch },
  )
}
