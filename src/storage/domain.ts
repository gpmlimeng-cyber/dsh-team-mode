import type { DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  assistantInstanceSchema,
  assistantMemorySchema,
  assistantSessionSchema,
  assistantTemplateSchema,
  contextCheckpointSchema,
  escalationSchema,
  migrationBackupSchema,
  migrationRecordSchema,
  operationSchema,
  storedSidebarGroupsSchema,
  teamActivitySchema,
  teamAggregateSchema,
  teamCheckpointSchema,
  teamMessageSchema,
} from '../domain/schemas.js'
import type {
  AssistantInstance,
  AssistantMemory,
  AssistantSession,
  AssistantTemplate,
  ContextCheckpoint,
  Escalation,
  Operation,
  StoredSidebarGroups,
  TeamActivity,
  TeamAggregate,
  TeamCheckpoint,
  TeamMessage,
} from '../domain/types.js'

export type AssistantId = string
export type AssistantInstanceId = string
export type AssistantSessionId = string
export type TeamId = string
export type MessageId = string
export type ActivityId = string
export type OperationId = string
export type ContextCheckpointId = string
export type TeamCheckpointId = string
export type EscalationId = string

/**
 * `@deepseek-ai/dsh-storage-domain` bundles its own zod install, so a schema
 * built by this package's zod is structurally identical but not nominally
 * assignable under `exactOptionalPropertyTypes`. The domain layer parses every
 * record through the schema object itself, so the version boundary only needs
 * an explicit type crossing; stored bytes, keys, and versions are unchanged.
 */
function storedTableSchema<K extends string, V>(schema: unknown): DomainTableSpec<K, V>['valueSchema'] {
  return schema as DomainTableSpec<K, V>['valueSchema']
}

export const dshTeamModeDomainSpec = defineDomain({
  name: 'dsh_team_mode',
  version: 1,
  tables: {
    assistants: domainTable<AssistantId, AssistantTemplate>(
      storedTableSchema<AssistantId, AssistantTemplate>(assistantTemplateSchema),
    ),
    assistant_instances: domainTable<AssistantInstanceId, AssistantInstance>(
      storedTableSchema<AssistantInstanceId, AssistantInstance>(assistantInstanceSchema),
    ),
    assistant_sessions: domainTable<AssistantSessionId, AssistantSession>(
      storedTableSchema<AssistantSessionId, AssistantSession>(assistantSessionSchema),
    ),
    assistant_memory: domainTable<AssistantId, AssistantMemory>(
      storedTableSchema<AssistantId, AssistantMemory>(assistantMemorySchema),
    ),
    context_checkpoints: domainTable<ContextCheckpointId, ContextCheckpoint>(
      storedTableSchema<ContextCheckpointId, ContextCheckpoint>(contextCheckpointSchema),
    ),
    team_checkpoints: domainTable<TeamCheckpointId, TeamCheckpoint>(
      storedTableSchema<TeamCheckpointId, TeamCheckpoint>(teamCheckpointSchema),
    ),
    escalations: domainTable<EscalationId, Escalation>(
      storedTableSchema<EscalationId, Escalation>(escalationSchema),
    ),
    teams: domainTable<TeamId, TeamAggregate>(
      storedTableSchema<TeamId, TeamAggregate>(teamAggregateSchema),
    ),
    messages: domainTable<MessageId, TeamMessage>(
      storedTableSchema<MessageId, TeamMessage>(teamMessageSchema),
    ),
    activities: domainTable<ActivityId, TeamActivity>(
      storedTableSchema<ActivityId, TeamActivity>(teamActivitySchema),
    ),
    operations: domainTable<OperationId, Operation>(
      storedTableSchema<OperationId, Operation>(operationSchema),
    ),
    /**
     * One row (`SIDEBAR_GROUPS_KEY`) holding the ordered group records. The
     * schema accepts the legacy `string[]` shape so old rows open; the store
     * normalizes them on read.
     */
    sidebar_groups: domainTable<string, StoredSidebarGroups>(
      storedTableSchema<string, StoredSidebarGroups>(storedSidebarGroupsSchema),
    ),
    migrations: domainTable<string, { schemaVersion: 1, id: string, appliedAt: string, fromVersion: number, toVersion: number }>(
      storedTableSchema<string, { schemaVersion: 1, id: string, appliedAt: string, fromVersion: number, toVersion: number }>(migrationRecordSchema),
    ),
    migration_backups: domainTable<string, { schemaVersion: 1, table: string, key: string, capturedAt: string, record: unknown }>(
      storedTableSchema<string, { schemaVersion: 1, table: string, key: string, capturedAt: string, record: unknown }>(migrationBackupSchema),
    ),
  },
})
