import type { Domain, DomainGlobalSpec } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const modelReferenceSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
}).strict()

const assistantBuilderPreferencesSchema = z.object({
  schemaVersion: z.literal(1),
  lastSelectedModel: modelReferenceSchema.optional(),
  conversationModels: z.record(z.string(), modelReferenceSchema),
  // Compatibility with local development snapshots written before Assistant
  // Builder history switched to the official Workspace archive registry.
  hiddenConversationIds: z.record(z.string(), z.iso.datetime({ offset: true })).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
}).strict()

type AssistantBuilderPreferences = z.infer<typeof assistantBuilderPreferencesSchema>

export interface AssistantBuilderModelReference {
  provider: string
  model: string
}

export interface AssistantBuilderModelPreferenceStore {
  getConversationModel(sessionId: string): AssistantBuilderModelReference | undefined
  getLastSelectedModel(): AssistantBuilderModelReference | undefined
  setConversationModel(
    sessionId: string,
    provider: string,
    model: string,
  ): Promise<void>
  setSelectedModel(
    sessionId: string,
    provider: string,
    model: string,
  ): Promise<void>
  setLastSelectedModel(provider: string, model: string): Promise<void>
}

/**
 * `@deepseek-ai/dsh-storage-domain` bundles its own zod install, so a schema
 * built by this package's zod is structurally identical but not nominally
 * assignable under `exactOptionalPropertyTypes`. The domain layer parses the
 * stored global through the schema object itself, so the version boundary only
 * needs an explicit type crossing; the persisted shape is unchanged.
 */
function storedGlobalSchema<G>(schema: unknown): DomainGlobalSpec<G>['schema'] {
  return schema as DomainGlobalSpec<G>['schema']
}

export const assistantBuilderPreferencesDomainSpec = defineDomain({
  name: 'dsh_team_mode_assistant_builder',
  version: 1,
  global: {
    schema: storedGlobalSchema<AssistantBuilderPreferences>(assistantBuilderPreferencesSchema),
    initial: {
      schemaVersion: 1,
      conversationModels: {},
    } as AssistantBuilderPreferences,
  },
  tables: {},
})

export class DomainAssistantBuilderModelPreferenceStore implements AssistantBuilderModelPreferenceStore {
  constructor(
    private readonly domain: Domain<typeof assistantBuilderPreferencesDomainSpec>,
  ) {}

  getConversationModel(sessionId: string): AssistantBuilderModelReference | undefined {
    return this.domain.global.get().conversationModels[sessionId]
  }

  getLastSelectedModel(): AssistantBuilderModelReference | undefined {
    return this.domain.global.get().lastSelectedModel
  }

  async setConversationModel(sessionId: string, provider: string, model: string): Promise<void> {
    const current = this.domain.global.get()
    await this.domain.global.set({
      ...current,
      conversationModels: {
        ...current.conversationModels,
        [sessionId]: { provider, model },
      },
      updatedAt: new Date().toISOString(),
    })
  }

  async setSelectedModel(sessionId: string, provider: string, model: string): Promise<void> {
    const current = this.domain.global.get()
    const selected = { provider, model }
    await this.domain.global.set({
      ...current,
      lastSelectedModel: selected,
      conversationModels: {
        ...current.conversationModels,
        [sessionId]: selected,
      },
      updatedAt: new Date().toISOString(),
    })
  }

  async setLastSelectedModel(provider: string, model: string): Promise<void> {
    const current = this.domain.global.get()
    await this.domain.global.set({
      ...current,
      lastSelectedModel: { provider, model },
      updatedAt: new Date().toISOString(),
    })
  }

}
