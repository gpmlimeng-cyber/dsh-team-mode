import type { DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  assistantTemplateSchema,
  operationSchema,
  teamActivitySchema,
  teamAggregateSchema,
  teamMessageSchema,
} from '../domain/schemas.js'
import type {
  AssistantTemplate,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
} from '../domain/types.js'

export type AssistantId = string
export type TeamId = string
export type MessageId = string
export type ActivityId = string
export type OperationId = string

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
  },
})
