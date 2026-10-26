import type {
  AddTeamMemberInput,
  AssistantInstance,
  AssistantMemory,
  AssistantPreview,
  AssistantSession,
  AssistantTemplate,
  CloneTeamInput,
  ContextCheckpoint,
  CreateAssistantInput,
  CreateAssistantInstanceInput,
  CreateTeamDraftInput,
  Escalation,
  MemoryEntry,
  TeamAggregate,
  TeamGoal,
  TeamCheckpoint,
  TeamMessage,
  UpdateAssistantInput,
  UpdateAssistantInstanceInput,
  UpdateTeamGoalInput,
  WriteAssistantMemoryEntryInput,
} from '../domain/types.js'

export type AssistantInstanceView = AssistantInstance & { preview?: AssistantPreview }

export const AGENT_TEAM_API_PATH = '/dsh-team-mode/api'
export const AGENT_TEAM_EVENTS_PATH = '/dsh-team-mode/events'
export const AGENT_TEAM_UPLOAD_PATH = '/dsh-team-mode/upload'

/** Custom header names are part of the wire contract; one copy serves both halves. */
export const AGENT_TEAM_FILE_NAME_HEADER = 'x-dsh-team-mode-file-name'
export const AGENT_TEAM_REQUEST_ID_HEADER = 'x-dsh-team-mode-request-id'

export const AGENT_TEAM_METHODS = [
  'catalog.get',
  'catalog.model.get',
  'skill.catalog',
  'mcp.catalog',
  'assistant.list',
  'assistant.get',
  'assistant.create',
  'assistant.update',
  'assistant.clone',
  'assistant.delete',
  'assistant.instance.list',
  'assistant.instance.create',
  'assistant.instance.update',
  'assistant.instance.archive',
  'assistant.instance.ensure',
  'assistant.thread.create',
  'assistant.thread.archive',
  'assistant.coordinator.get',
  'assistant.coordinator.set',
  'assistant.memory.get',
  'assistant.memory.write',
  'assistant.memory.entry.write',
  'assistant.memory.undo',
  'assistant.checkpoint.create',
  'assistant.checkpoint.list',
  'assistant.checkpoint.handoff',
  'assistant.task.list',
  'assistant.task.interactions',
  'assistant.task.interaction.respond',
  'assistant.task.open',
  'assistant.builder.list',
  'assistant.builder.draft.get',
  'assistant.builder.draft.configure',
  'assistant.builder.start',
  'assistant.builder.get',
  'assistant.builder.configure',
  'assistant.builder.send',
  'assistant.builder.interaction.respond',
  'assistant.builder.stop',
  'assistant.builder.archive',
  /** Workspace-wide escalation rows; the coordinator row badge reads this. */
  'escalation.list',
  /** Workspace-wide sidebar groups: an ordered entity list, not a derived name set. */
  'sidebar.groups.list',
  'sidebar.groups.create',
  'sidebar.groups.rename',
  'sidebar.groups.delete',
  'sidebar.groups.reorder',
  'team.list',
  'team.get',
  'team.createDraft',
  'team.clone',
  'team.start',
  'team.warmup.retry',
  'team.addMember',
  'team.renameMember',
  'team.rename',
  'team.removeMember',
  'team.changeLeader',
  'team.updateGoal',
  'team.reset',
  'team.message.list',
  'team.message.send',
  'team.workbench.get',
  'team.member.stop',
  'team.member.contextReset',
  'team.checkpoint.create',
  'team.checkpoint.list',
  'team.checkpoint.handoff',
  'team.member.reconnect',
  'team.members.reorder',
  'team.pin',
  'team.archive',
  'team.group.set',
  'team.memory.write',
  'team.memory.decide',
  'team.memory.undo',
  'team.interaction.respond',
  'team.member.setPermissionPreset',
  'team.member.setReasoningEffort',
  'team.member.setAssistantInstance',
  'team.workspace.list',
  'team.workspace.search',
  'team.workspace.changes',
  'team.workspace.diff',
  'team.dissolve',
] as const

export type AgentTeamMethod = typeof AGENT_TEAM_METHODS[number]

export type AssistantView = AssistantTemplate
export type TeamView = TeamAggregate

export interface PageView<T> {
  items: T[]
  total: number
}

export interface CatalogView {
  providers: Array<{ id: string; name: string }>
  models: Record<string, Array<{ id: string; name: string; description?: string }>>
  agentPresets: Array<{ id: string; name: string; description?: string; broken?: string }>
  permissionPresets: Array<{ value: string; name: string; description?: string }>
  workspaces: Array<{ id: string; path: string; title: string; status: 'ok' | 'missing-dir' }>
}

export interface ModelCapabilitiesView {
  provider: string
  model: string
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
}

export interface SkillCatalogView {
  agentPresetId: string
  skills: Array<{
    name: string
    description: string
    source: string
    modelInvocable: boolean
    userInvocable: boolean
  }>
}

export interface McpCatalogView {
  agentPresetId: string
  servers: Array<{
    name: string
    tools: Array<{ name: string; description: string }>
  }>
}

export type ConversationNode =
  | {
    id: string
    kind: 'user' | 'assistant'
    seq: number
    time: number
    text: string
    reasoning?: string
    reasoningStartedAt?: number
    reasoningCompletedAt?: number
    streaming?: boolean
  }
  | {
    id: string
    kind: 'team-message'
    seq: number
    time: number
    text: string
    senderName: string
    senderId: string
    senderRole: 'leader' | 'member' | 'system'
    messageType: 'instruction' | 'progress' | 'result' | 'question' | 'warning' | 'system'
    relatedTaskId?: string
  }
  | {
    id: string
    kind: 'tool'
    seq: number
    time: number
    callId: string
    name: string
    arguments: string
    status: 'running' | 'success' | 'error'
    result?: string
    error?: string
  }
  | {
    id: string
    kind: 'notice'
    seq: number
    time: number
    tone: 'neutral' | 'error' | 'warning'
    text: string
  }

export interface QuestionOptionView {
  label: string
  description?: string
}

export interface QuestionItemView {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOptionView[]
  multiSelect?: boolean
  intent?: {
    kind: 'plan-review'
    approve: string
  }
}

export type PendingInteractionView =
  | {
    id: string
    kind: 'question'
    questions: QuestionItemView[]
  }
  | {
    id: string
    kind: 'approval'
    approvalId: string
    toolName: string
    callId?: string
    reason?: string
  }

export interface QuestionAnswerView {
  id: string
  selected: string[]
  custom?: string
}

export type InteractionResponseInput =
  | {
    kind: 'question'
    answers: QuestionAnswerView[]
  }
  | {
    kind: 'approval'
    outcome: 'allowed-once' | 'rejected'
  }

export interface MemberConversationView {
  slotId: string
  sessionId: string
  throughSeq: number
  status: 'offline' | 'starting' | 'idle' | 'running' | 'waiting_approval' | 'error'
  nodes: ConversationNode[]
  pendingInteractions: PendingInteractionView[]
  contextUsage?: {
    usedTokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    contextWindow?: number
  }
}

export interface TeamWorkbenchView {
  schemaVersion: 1
  teamId: string
  revision: number
  conversations: MemberConversationView[]
}

export interface AssistantBuilderConversationView {
  schemaVersion: 1
  sessionId: string
  status: 'starting' | 'idle' | 'running' | 'error'
  throughSeq: number
  nodes: ConversationNode[]
  pendingInteractions: PendingInteractionView[]
  configuration: {
    provider: string
    model: string
    agentPresetId: string
    permissionPresetId: string
  }
}

export interface AssistantBuilderConversationSummary {
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
  state: 'new' | 'in_progress' | 'completed'
}

export interface AssistantBuilderConversationListView {
  items: AssistantBuilderConversationSummary[]
  total: number
}

export interface AssistantBuilderDraftView {
  schemaVersion: 1
  configuration: AssistantBuilderConversationView['configuration']
}

export interface WorkspaceEntryView {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink'
}

export interface WorkspaceGitChangeView {
  path: string
  originalPath?: string
  kind: 'added' | 'copied' | 'deleted' | 'modified' | 'renamed' | 'type-changed' | 'unmerged' | 'untracked'
  staged: boolean
  unstaged: boolean
  indexCode: string
  workTreeCode: string
}

export interface WorkspaceGitStatusView {
  state: 'repository' | 'not-repository'
  changes: WorkspaceGitChangeView[]
  truncated: boolean
}

export interface WorkspaceGitDiffView {
  path: string
  scope: 'staged' | 'unstaged'
  layout: 'unified' | 'split'
  theme: 'light' | 'dark'
  html: string
  binary: boolean
}

export interface WorkspaceUploadView {
  name: string
  path: string
  bytes: number
}

/** A missing assistant memory document is null, not an invented empty row. */
export interface AssistantMemoryView {
  memory: AssistantMemory | null
}

export interface AssistantMemoryEntryWriteView {
  memory: AssistantMemory
  entry: MemoryEntry
}

/** User-authority team memory write; visibility is always `team-safe`. */
export interface TeamMemoryWriteInput {
  id?: string
  key?: string
  title: string
  body: string
}

export interface TeamMemoryWriteView {
  memoryRevision: number
  entry: MemoryEntry
}

export interface AgentTeamRequestMap {
  'catalog.get': { payload: undefined; result: CatalogView }
  'catalog.model.get': {
    payload: { provider: string; model: string }
    result: ModelCapabilitiesView
  }
  'skill.catalog': { payload: { agentPresetId: string }; result: SkillCatalogView }
  'mcp.catalog': { payload: { agentPresetId: string }; result: McpCatalogView }
  'assistant.list': { payload: undefined; result: PageView<AssistantView> }
  'assistant.get': { payload: { id: string }; result: AssistantView }
  'assistant.create': { payload: CreateAssistantInput; result: AssistantView }
  'assistant.update': { payload: { id: string; value: UpdateAssistantInput }; result: AssistantView }
  'assistant.clone': { payload: { id: string; name?: string }; result: AssistantView }
  'assistant.delete': { payload: { id: string }; result: null }
  'assistant.instance.list': { payload: undefined; result: PageView<AssistantInstanceView> }
  'assistant.instance.create': { payload: CreateAssistantInstanceInput; result: AssistantInstance }
  'assistant.instance.update': {
    payload: { id: string; value: UpdateAssistantInstanceInput }
    result: AssistantInstance
  }
  'assistant.instance.archive': { payload: { id: string }; result: AssistantInstance }
  'assistant.instance.ensure': {
    payload: { id: string }
    result: { instance: AssistantInstance; sessionId: string }
  }
  /** One more visible Session for an instance; `cwd` overrides its workspace. */
  'assistant.thread.create': {
    payload: { instanceId: string; cwd?: string }
    result: AssistantInstanceView
  }
  /** Move one thread Session to the retired list; the main Session is refused. */
  'assistant.thread.archive': {
    payload: { instanceId: string; sessionId: string }
    result: AssistantInstanceView
  }
  /** The workspace coordinator; null when none is set (never an invented row). */
  'assistant.coordinator.get': { payload: undefined; result: AssistantInstance | null }
  /**
   * Set or clear the single workspace coordinator. `null` clears it; setting a
   * different instance clears the previous one in the same write.
   */
  'assistant.coordinator.set': {
    payload: { assistantId: string | null }
    result: AssistantInstance | null
  }
  'assistant.memory.get': {
    payload: { assistantId: string }
    result: AssistantMemoryView
  }
  'assistant.memory.write': {
    payload: {
      assistantId: string
      content: string
      mode?: 'replace' | 'append'
      /** Memory document revision; 0 means "no memory written yet". */
      expectedRevision?: number
    }
    result: AssistantMemory
  }
  'assistant.memory.entry.write': {
    payload: {
      assistantId: string
      expectedRevision?: number
      entry: WriteAssistantMemoryEntryInput
    }
    result: AssistantMemoryEntryWriteView
  }
  'assistant.memory.undo': {
    payload: {
      assistantId: string
      journalId: string
      expectedRevision?: number
    }
    result: AssistantMemoryEntryWriteView
  }
  'assistant.checkpoint.create': {
    payload: { assistantId: string; note?: string }
    result: ContextCheckpoint
  }
  'assistant.checkpoint.list': {
    payload: { assistantId: string }
    result: ContextCheckpoint[]
  }
  'assistant.checkpoint.handoff': {
    payload: { checkpointId: string }
    result: { checkpoint: ContextCheckpoint; sessionId: string }
  }
  'assistant.task.list': {
    payload: { assistantId?: string } | undefined
    result: PageView<AssistantSession>
  }
  'assistant.task.open': {
    payload: { taskId: string }
    result: { task: AssistantSession; sessionId: string }
  }
  'assistant.task.interactions': {
    payload: { taskId: string }
    result: PendingInteractionView[]
  }
  'assistant.task.interaction.respond': {
    payload: { taskId: string; interactionId: string; response: InteractionResponseInput }
    result: null
  }
  'assistant.builder.list': { payload: undefined; result: AssistantBuilderConversationListView }
  'assistant.builder.draft.get': { payload: undefined; result: AssistantBuilderDraftView }
  'assistant.builder.draft.configure': {
    payload: { provider: string; model: string }
    result: AssistantBuilderDraftView
  }
  'assistant.builder.start': {
    payload: { provider: string; model: string; content: string }
    result: AssistantBuilderConversationView
  }
  'assistant.builder.get': { payload: { sessionId: string }; result: AssistantBuilderConversationView }
  'assistant.builder.configure': {
    payload: { sessionId: string; provider: string; model: string }
    result: AssistantBuilderConversationView
  }
  'assistant.builder.send': {
    payload: { sessionId: string; content: string }
    result: { messageId: string }
  }
  'assistant.builder.interaction.respond': {
    payload: {
      sessionId: string
      interactionId: string
      response: InteractionResponseInput
    }
    result: { accepted: boolean }
  }
  'assistant.builder.stop': { payload: { sessionId: string }; result: { accepted: boolean } }
  'assistant.builder.archive': { payload: { sessionId: string }; result: { archived: boolean } }
  /**
   * Every persisted escalation row, open and lifted. The coordinator row badge
   * counts `open` only, so the client never needs a second filtered read.
   */
  'escalation.list': { payload: undefined; result: PageView<Escalation> }
  /** Ordered sidebar group labels; empty means every team and Assistant is ungrouped. */
  'sidebar.groups.list': { payload: undefined; result: string[] }
  /** Create, rename, delete and reorder all answer with the resulting ordered list. */
  'sidebar.groups.create': { payload: { name: string }; result: string[] }
  'sidebar.groups.rename': { payload: { from: string; to: string }; result: string[] }
  'sidebar.groups.delete': { payload: { name: string }; result: string[] }
  'sidebar.groups.reorder': { payload: { names: string[] }; result: string[] }
  'team.list': { payload: undefined; result: PageView<TeamView> }
  'team.get': { payload: { id: string }; result: TeamView }
  'team.createDraft': { payload: CreateTeamDraftInput; result: TeamView }
  'team.clone': { payload: CloneTeamInput & { teamId: string }; result: TeamView }
  'team.start': { payload: { id: string }; result: TeamView }
  'team.warmup.retry': { payload: { teamId: string; slotId?: string }; result: TeamView }
  'team.addMember': { payload: { teamId: string; value: AddTeamMemberInput }; result: TeamView }
  'team.renameMember': { payload: { teamId: string; slotId: string; displayName: string }; result: TeamView }
  'team.rename': { payload: { teamId: string; name: string }; result: TeamView }
  'team.removeMember': { payload: { teamId: string; slotId: string }; result: TeamView }
  'team.changeLeader': { payload: { teamId: string; successorSlotId: string }; result: TeamView }
  'team.updateGoal': {
    payload: { teamId: string; goalId: string; value: UpdateTeamGoalInput }
    result: TeamGoal
  }
  'team.reset': { payload: { teamId: string; confirmation: string }; result: TeamView }
  'team.message.list': { payload: { id: string }; result: PageView<TeamMessage> }
  'team.message.send': {
    payload: { teamId: string; content: string; targetSlotId?: string }
    result: TeamMessage
  }
  'team.workbench.get': { payload: { id: string }; result: TeamWorkbenchView }
  'team.member.stop': { payload: { teamId: string; slotId: string }; result: { accepted: boolean } }
  'team.member.contextReset': {
    payload: { teamId: string; slotId: string }
    result: { team: TeamView; sessionId: string; status: string }
  }
  /** Capture one deterministic Leader checkpoint; the only handoff source. */
  'team.checkpoint.create': {
    payload: { teamId: string; note?: string }
    result: TeamCheckpoint
  }
  'team.checkpoint.list': { payload: { teamId: string }; result: TeamCheckpoint[] }
  /** Explicit Leader handoff: fresh Leader Session, same team and epoch. */
  'team.checkpoint.handoff': {
    payload: { teamId: string; checkpointId: string }
    result: { team: TeamView; checkpoint: TeamCheckpoint; sessionId: string }
  }
  'team.member.reconnect': { payload: { teamId: string; slotId: string }; result: TeamView }
  'team.members.reorder': { payload: { teamId: string; order: string[] }; result: TeamView }
  'team.pin': { payload: { teamId: string; pinned: boolean }; result: TeamView }
  'team.archive': { payload: { teamId: string; archived: boolean }; result: TeamView }
  /** Sidebar group move; `null` (or a blank string) puts the team back to ungrouped. */
  'team.group.set': { payload: { teamId: string; group: string | null }; result: TeamView }
  /** User-authority team memory write; the fence is the memory revision, not the aggregate revision. */
  'team.memory.write': {
    payload: {
      teamId: string
      expectedMemoryRevision?: number
      value: TeamMemoryWriteInput
    }
    result: TeamMemoryWriteView
  }
  'team.memory.decide': {
    payload: {
      teamId: string
      entryId: string
      expectedMemoryRevision?: number
      decision: 'accept' | 'reject'
    }
    result: TeamMemoryWriteView
  }
  'team.memory.undo': {
    payload: {
      teamId: string
      journalId: string
      expectedMemoryRevision?: number
    }
    result: TeamMemoryWriteView
  }
  'team.interaction.respond': {
    payload: {
      teamId: string
      slotId: string
      interactionId: string
      response: InteractionResponseInput
    }
    result: { accepted: boolean }
  }
  'team.member.setPermissionPreset': {
    payload: { teamId: string; slotId: string; permissionPresetId: string }
    result: TeamView
  }
  'team.member.setReasoningEffort': {
    payload: { teamId: string; slotId: string; reasoningEffort?: string }
    result: TeamView
  }
  /** Explicit member→Assistant instance link; null clears it. */
  'team.member.setAssistantInstance': {
    payload: { teamId: string; slotId: string; assistantInstanceId: string | null }
    result: TeamView
  }
  'team.workspace.list': {
    payload: { teamId: string; path?: string }
    result: WorkspaceEntryView[]
  }
  'team.workspace.search': {
    payload: { teamId: string; query?: string; limit?: number }
    result: WorkspaceEntryView[]
  }
  'team.workspace.changes': { payload: { teamId: string }; result: WorkspaceGitStatusView }
  'team.workspace.diff': {
    payload: {
      teamId: string
      path: string
      scope: 'staged' | 'unstaged'
      layout: 'unified' | 'split'
      theme: 'light' | 'dark'
    }
    result: WorkspaceGitDiffView
  }
  'team.dissolve': { payload: { teamId: string; confirmation: string }; result: null }
}

export type AgentTeamPayload<M extends AgentTeamMethod> = AgentTeamRequestMap[M]['payload']
export type AgentTeamResult<M extends AgentTeamMethod> = AgentTeamRequestMap[M]['result']

export interface AgentTeamRequest {
  requestId: string
  method: AgentTeamMethod
  expectedRevision?: number
  payload: unknown
}

export type AgentTeamResponse =
  | { requestId: string; ok: true; value: unknown }
  | {
    requestId: string
    ok: false
    error: {
      code: string
      message: string
      details?: Readonly<Record<string, unknown>>
    }
  }
