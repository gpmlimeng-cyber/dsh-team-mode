import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  AssistantInstance,
  AssistantSession,
  AssistantTemplate,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
} from '../domain/types.js'
import { dshTeamModeDomainSpec } from './domain.js'

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

export class DomainAgentTeamStore implements AgentTeamStore {
  private readonly assistants: KvTable<string, AssistantTemplate>
  private readonly assistantInstances: KvTable<string, AssistantInstance>
  private readonly assistantSessions: KvTable<string, AssistantSession>
  private readonly teams: KvTable<string, TeamAggregate>
  private readonly messages: KvTable<string, TeamMessage>
  private readonly activities: KvTable<string, TeamActivity>
  private readonly operations: KvTable<string, Operation>

  constructor(readonly domain: Domain<typeof dshTeamModeDomainSpec>) {
    this.assistants = domain.table('assistants')
    this.assistantInstances = domain.table('assistant_instances')
    this.assistantSessions = domain.table('assistant_sessions')
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
