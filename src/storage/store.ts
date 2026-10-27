import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  AssistantInstance,
  AssistantMemory,
  AssistantSession,
  AssistantTemplate,
  ContextCheckpoint,
  Escalation,
  Operation,
  SidebarGroups,
  SidebarGroupRecord,
  StoredSidebarGroups,
  TeamActivity,
  TeamAggregate,
  TeamCheckpoint,
  TeamMessage,
} from '../domain/types.js'
import { legacySidebarGroupMemoryKey } from '../domain/schemas.js'
import { dshTeamModeDomainSpec } from './domain.js'

/**
 * Checkpoint persistence, kept separate from `AgentTeamStore` so existing store
 * doubles stay valid without new mandatory methods. The service that reads
 * checkpoints takes `AgentTeamStoreWithCheckpoints`.
 */
export interface AgentTeamCheckpointStore {
  getContextCheckpoint(id: string): ContextCheckpoint | undefined
  listContextCheckpoints(): ContextCheckpoint[]
  putContextCheckpoint(value: ContextCheckpoint): Promise<void>
  updateContextCheckpoint(
    id: string,
    update: (current: ContextCheckpoint) => ContextCheckpoint,
  ): Promise<ContextCheckpoint>
}

export type AgentTeamStoreWithCheckpoints = AgentTeamStore & AgentTeamCheckpointStore

/**
 * Leader Team Session checkpoints. Separate from the Assistant checkpoint
 * interface for the same reason: the team aggregate never carries a checkpoint,
 * and a store double that never handoff-tests stays valid.
 */
export interface AgentTeamLeaderCheckpointStore {
  getTeamCheckpoint(id: string): TeamCheckpoint | undefined
  listTeamCheckpoints(teamId: string): TeamCheckpoint[]
  putTeamCheckpoint(value: TeamCheckpoint): Promise<void>
  updateTeamCheckpoint(
    id: string,
    update: (current: TeamCheckpoint) => TeamCheckpoint,
  ): Promise<TeamCheckpoint>
  deleteTeamCheckpoint(id: string): Promise<boolean>
}

/**
 * Persisted escalations, kept separate from `AgentTeamStore` for the same reason
 * as the checkpoint interfaces: a store double written before the table existed
 * stays valid, and the escalation service takes only this slice.
 */
export interface AgentTeamEscalationStore {
  getEscalation(id: string): Escalation | undefined
  listEscalations(): Escalation[]
  putEscalation(value: Escalation): Promise<void>
  deleteEscalation(id: string): Promise<boolean>
}

export type AgentTeamStoreWithEscalations = AgentTeamStore & AgentTeamEscalationStore

/** The one row that holds the ordered sidebar group records. */
export const SIDEBAR_GROUPS_KEY = 'sidebar'

/**
 * Read a stored row as the current record shape. v1 held only names, so it
 * maps to records with an empty brief and a deterministic `memoryKey`; a v2
 * row is returned unchanged, which makes repeated reads idempotent. The next
 * group write persists the normalized shape.
 */
export function migrateSidebarGroups(value: StoredSidebarGroups): SidebarGroups {
  if (value.schemaVersion === 2) return value
  return {
    schemaVersion: 2,
    groups: value.groups.map((name): SidebarGroupRecord => ({
      name,
      brief: '',
      memoryKey: legacySidebarGroupMemoryKey(name),
      updatedAt: value.updatedAt,
    })),
    revision: value.revision,
    updatedAt: value.updatedAt,
  }
}

/**
 * Sidebar group records, kept separate from `AgentTeamStore` for the same reason
 * as the other slice interfaces: a store double written before groups existed
 * stays valid. Membership (`group`) lives on the teams and instances in
 * `AgentTeamStore`; this slice only owns existence, order, and the brief.
 */
export interface AgentTeamSidebarGroupStore {
  getSidebarGroups(): SidebarGroups | undefined
  putSidebarGroups(value: SidebarGroups): Promise<void>
}

export type AgentTeamStoreWithSidebarGroups = AgentTeamStore & AgentTeamSidebarGroupStore

export interface AgentTeamStore {
  getAssistant(id: string): AssistantTemplate | undefined
  listAssistants(): AssistantTemplate[]
  putAssistant(value: AssistantTemplate): Promise<void>
  updateAssistant(id: string, update: (current: AssistantTemplate) => AssistantTemplate): Promise<AssistantTemplate>
  deleteAssistant(id: string): Promise<boolean>

  getAssistantInstance(id: string): AssistantInstance | undefined
  listAssistantInstances(): AssistantInstance[]
  putAssistantInstance(value: AssistantInstance): Promise<void>
  updateAssistantInstance(
    id: string,
    update: (current: AssistantInstance) => AssistantInstance,
  ): Promise<AssistantInstance>
  deleteAssistantInstance(id: string): Promise<boolean>

  getAssistantMemory(assistantId: string): AssistantMemory | undefined
  putAssistantMemory(value: AssistantMemory): Promise<void>
  updateAssistantMemory(
    assistantId: string,
    update: (current: AssistantMemory) => AssistantMemory,
  ): Promise<AssistantMemory>

  getAssistantSession(id: string): AssistantSession | undefined
  listAssistantSessions(): AssistantSession[]
  putAssistantSession(value: AssistantSession): Promise<void>
  updateAssistantSession(
    id: string,
    update: (current: AssistantSession) => AssistantSession,
  ): Promise<AssistantSession>

  getTeam(id: string): TeamAggregate | undefined
  listTeams(): TeamAggregate[]
  putTeam(value: TeamAggregate): Promise<void>
  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate): Promise<TeamAggregate>
  deleteTeam(id: string): Promise<boolean>

  listMessages(teamId: string): TeamMessage[]
  putMessage(value: TeamMessage): Promise<void>
  deleteMessage(id: string): Promise<boolean>

  listActivities(teamId: string): TeamActivity[]
  putActivity(value: TeamActivity): Promise<void>
  deleteActivity(id: string): Promise<boolean>

  getOperation(id: string): Operation | undefined
  listOperations(): Operation[]
  putOperation(value: Operation): Promise<void>
  updateOperation(id: string, update: (current: Operation) => Operation): Promise<Operation>
  deleteOperation(id: string): Promise<boolean>
}

export class DomainAgentTeamStore
implements
  AgentTeamStore,
  AgentTeamCheckpointStore,
  AgentTeamLeaderCheckpointStore,
  AgentTeamEscalationStore,
  AgentTeamSidebarGroupStore {
  private readonly assistants: KvTable<string, AssistantTemplate>
  private readonly assistantInstances: KvTable<string, AssistantInstance>
  private readonly assistantSessions: KvTable<string, AssistantSession>
  private readonly assistantMemory: KvTable<string, AssistantMemory>
  private readonly contextCheckpoints: KvTable<string, ContextCheckpoint>
  private readonly teamCheckpoints: KvTable<string, TeamCheckpoint>
  private readonly escalations: KvTable<string, Escalation>
  private readonly sidebarGroups: KvTable<string, StoredSidebarGroups>
  private readonly teams: KvTable<string, TeamAggregate>
  private readonly messages: KvTable<string, TeamMessage>
  private readonly activities: KvTable<string, TeamActivity>
  private readonly operations: KvTable<string, Operation>

  constructor(readonly domain: Domain<typeof dshTeamModeDomainSpec>) {
    this.assistants = domain.table('assistants')
    this.assistantInstances = domain.table('assistant_instances')
    this.assistantSessions = domain.table('assistant_sessions')
    this.assistantMemory = domain.table('assistant_memory')
    this.contextCheckpoints = domain.table('context_checkpoints')
    this.teamCheckpoints = domain.table('team_checkpoints')
    this.escalations = domain.table('escalations')
    this.sidebarGroups = domain.table('sidebar_groups')
    this.teams = domain.table('teams')
    this.messages = domain.table('messages')
    this.activities = domain.table('activities')
    this.operations = domain.table('operations')
  }

  getAssistant(id: string): AssistantTemplate | undefined {
    return this.assistants.get(id)
  }

  listAssistants(): AssistantTemplate[] {
    return values(this.assistants)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putAssistant(value: AssistantTemplate): Promise<void> {
    return this.assistants.put(value.id, value)
  }

  updateAssistant(
    id: string,
    update: (current: AssistantTemplate) => AssistantTemplate,
  ): Promise<AssistantTemplate> {
    return this.assistants.update(id, update)
  }

  deleteAssistant(id: string): Promise<boolean> {
    return this.assistants.delete(id)
  }

  getAssistantInstance(id: string): AssistantInstance | undefined {
    return this.assistantInstances.get(id)
  }

  listAssistantInstances(): AssistantInstance[] {
    return values(this.assistantInstances)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putAssistantInstance(value: AssistantInstance): Promise<void> {
    return this.assistantInstances.put(value.id, value)
  }

  updateAssistantInstance(
    id: string,
    update: (current: AssistantInstance) => AssistantInstance,
  ): Promise<AssistantInstance> {
    return this.assistantInstances.update(id, update)
  }

  deleteAssistantInstance(id: string): Promise<boolean> {
    return this.assistantInstances.delete(id)
  }

  getAssistantMemory(assistantId: string): AssistantMemory | undefined {
    return this.assistantMemory.get(assistantId)
  }

  putAssistantMemory(value: AssistantMemory): Promise<void> {
    return this.assistantMemory.put(value.assistantId, value)
  }

  updateAssistantMemory(
    assistantId: string,
    update: (current: AssistantMemory) => AssistantMemory,
  ): Promise<AssistantMemory> {
    return this.assistantMemory.update(assistantId, update)
  }

  getAssistantSession(id: string): AssistantSession | undefined {
    return this.assistantSessions.get(id)
  }

  listAssistantSessions(): AssistantSession[] {
    return values(this.assistantSessions)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  }

  putAssistantSession(value: AssistantSession): Promise<void> {
    return this.assistantSessions.put(value.id, value)
  }

  updateAssistantSession(
    id: string,
    update: (current: AssistantSession) => AssistantSession,
  ): Promise<AssistantSession> {
    return this.assistantSessions.update(id, update)
  }

  getContextCheckpoint(id: string): ContextCheckpoint | undefined {
    return this.contextCheckpoints.get(id)
  }

  listContextCheckpoints(): ContextCheckpoint[] {
    return values(this.contextCheckpoints)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  }

  putContextCheckpoint(value: ContextCheckpoint): Promise<void> {
    return this.contextCheckpoints.put(value.id, value)
  }

  updateContextCheckpoint(
    id: string,
    update: (current: ContextCheckpoint) => ContextCheckpoint,
  ): Promise<ContextCheckpoint> {
    return this.contextCheckpoints.update(id, update)
  }

  getTeamCheckpoint(id: string): TeamCheckpoint | undefined {
    return this.teamCheckpoints.get(id)
  }

  listTeamCheckpoints(teamId: string): TeamCheckpoint[] {
    return values(this.teamCheckpoints)
      .filter(checkpoint => checkpoint.teamId === teamId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
  }

  putTeamCheckpoint(value: TeamCheckpoint): Promise<void> {
    return this.teamCheckpoints.put(value.id, value)
  }

  updateTeamCheckpoint(
    id: string,
    update: (current: TeamCheckpoint) => TeamCheckpoint,
  ): Promise<TeamCheckpoint> {
    return this.teamCheckpoints.update(id, update)
  }

  deleteTeamCheckpoint(id: string): Promise<boolean> {
    return this.teamCheckpoints.delete(id)
  }

  getEscalation(id: string): Escalation | undefined {
    return this.escalations.get(id)
  }

  listEscalations(): Escalation[] {
    return values(this.escalations)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putEscalation(value: Escalation): Promise<void> {
    return this.escalations.put(value.id, value)
  }

  deleteEscalation(id: string): Promise<boolean> {
    return this.escalations.delete(id)
  }

  getSidebarGroups(): SidebarGroups | undefined {
    const stored = this.sidebarGroups.get(SIDEBAR_GROUPS_KEY)
    return stored === undefined ? undefined : migrateSidebarGroups(stored)
  }

  putSidebarGroups(value: SidebarGroups): Promise<void> {
    return this.sidebarGroups.put(SIDEBAR_GROUPS_KEY, value)
  }

  getTeam(id: string): TeamAggregate | undefined {
    return this.teams.get(id)
  }

  listTeams(): TeamAggregate[] {
    return values(this.teams)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
  }

  putTeam(value: TeamAggregate): Promise<void> {
    return this.teams.put(value.id, value)
  }

  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate): Promise<TeamAggregate> {
    return this.teams.update(id, update)
  }

  deleteTeam(id: string): Promise<boolean> {
    return this.teams.delete(id)
  }

  listMessages(teamId: string): TeamMessage[] {
    return values(this.messages)
      .filter(message => message.teamId === teamId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putMessage(value: TeamMessage): Promise<void> {
    return this.messages.put(value.id, value)
  }

  deleteMessage(id: string): Promise<boolean> {
    return this.messages.delete(id)
  }

  listActivities(teamId: string): TeamActivity[] {
    return values(this.activities)
      .filter(activity => activity.teamId === teamId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putActivity(value: TeamActivity): Promise<void> {
    return this.activities.put(value.id, value)
  }

  deleteActivity(id: string): Promise<boolean> {
    return this.activities.delete(id)
  }

  getOperation(id: string): Operation | undefined {
    return this.operations.get(id)
  }

  listOperations(): Operation[] {
    return values(this.operations)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putOperation(value: Operation): Promise<void> {
    return this.operations.put(value.id, value)
  }

  updateOperation(id: string, update: (current: Operation) => Operation): Promise<Operation> {
    return this.operations.update(id, update)
  }

  deleteOperation(id: string): Promise<boolean> {
    return this.operations.delete(id)
  }
}

function values<K extends string, V>(table: KvTable<K, V>): V[] {
  return [...table.entries()].map(([, value]) => value)
}
