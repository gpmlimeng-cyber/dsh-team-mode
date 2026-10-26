import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as AgentTeamConfig } from './config.js'
import { AgentTeamService } from './service/dsh-team-mode-service.js'
import { AssistantBuilderRuntime } from './runtime/assistant-builder-runtime.js'
import { AssistantRuntime } from './runtime/assistant-runtime.js'
import { TeamRuntime } from './runtime/team-runtime.js'
import { dshTeamModeDomainSpec } from './storage/domain.js'
import {
  assistantBuilderPreferencesDomainSpec,
  DomainAssistantBuilderModelPreferenceStore,
} from './storage/assistant-builder-preferences.js'
import { DomainAgentTeamStore } from './storage/store.js'
import { adoptChiefCoordinator, migrateDomain } from './storage/migration.js'
import { registerWebTransport } from './transport/web.js'

export const name = 'dsh-team-mode'
export const inject = [
  'agents',
  'connection',
  'agentPresets',
  'llm',
  'permissionPresets',
  'sessionPersistence',
  'sessions',
  'skills',
  'storageDomain',
  'systemPrompt',
  'tools',
  'webServer',
  'workspaceRegistry',
]
export { Config }

export async function apply(ctx: Context, config: AgentTeamConfig): Promise<void> {
  let disposed = false
  let closing: Promise<void> | undefined
  let domain: Awaited<ReturnType<Context['storageDomain']['open']>> | undefined
  let assistantBuilderPreferencesDomain: typeof domain
  let runtime: TeamRuntime | undefined
  let assistantBuilderRuntime: AssistantBuilderRuntime | undefined
  let assistantRuntime: AssistantRuntime | undefined
  let transport: ReturnType<typeof registerWebTransport> | undefined
  let service: AgentTeamService | undefined

  const closeResources = (): Promise<void> => {
    if (closing !== undefined) return closing
    closing = (async () => {
      transport?.dispose()
      await service?.disposeWorkspaceTracking()
      await assistantBuilderRuntime?.dispose()
      await assistantRuntime?.dispose()
      await runtime?.dispose()
      await assistantBuilderPreferencesDomain?.close()
      await domain?.close()
      assistantBuilderPreferencesDomain = undefined
      domain = undefined
    })()
    return closing
  }

  // Register the teardown effect before the first await. Initialization below
  // is intentionally split into await-for-data stages followed by one
  // synchronous registration block, so an unload during storage open or
  // migration cannot register resources after the plugin started UNLOADING.
  ctx.effect(() => async () => {
    disposed = true
    await closeResources()
  }, 'dsh-team-mode: ordered shutdown')

  try {
    domain = await ctx.storageDomain.open(dshTeamModeDomainSpec)
    if (disposed) {
      await domain.close()
      domain = undefined
      return
    }
    assistantBuilderPreferencesDomain = await ctx.storageDomain.open(assistantBuilderPreferencesDomainSpec)
    if (disposed) {
      await assistantBuilderPreferencesDomain.close()
      assistantBuilderPreferencesDomain = undefined
      await domain.close()
      domain = undefined
      return
    }
    await migrateDomain(domain)
    await adoptChiefCoordinator(domain)
    if (disposed) {
      await closeResources()
      return
    }

    // From here to registerWebTransport(), do not await: all tool, service,
    // session, and transport registrations must land in one synchronous chunk
    // after the final data await.
    const store = new DomainAgentTeamStore(domain)
    const assistantBuilderModelPreferences = new DomainAssistantBuilderModelPreferenceStore(
      assistantBuilderPreferencesDomain,
    )
    service = new AgentTeamService(ctx, config, store)
    runtime = new TeamRuntime(ctx, config, service)
    assistantBuilderRuntime = new AssistantBuilderRuntime(
      ctx,
      config,
      service,
      assistantBuilderModelPreferences,
      runtime.interactionBridge(),
    )
    assistantRuntime = new AssistantRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    service.attachAssistantBuilderRuntime(assistantBuilderRuntime)
    service.attachAssistantRuntime(assistantRuntime)
    transport = registerWebTransport(ctx, config, service)

    try {
      await service.ensureBuiltinAssistants()
      await service.ensureDefaultChiefAssistant()
    } catch (error) {
      ctx.logger.warn('dsh-team-mode: failed to seed built-in assistants', error)
    }

    await runtime.recoverTeams()
    if (disposed) return
    service.startWorkspaceTracking()
  } catch (error) {
    await closeResources()
    throw error
  }
}

export { AgentTeamError } from './domain/errors.js'
export type * from './domain/types.js'
export type { AgentTeamChange, CatalogSnapshot } from './service/dsh-team-mode-service.js'
