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
import { TeamRuntime } from './runtime/team-runtime.js'
import { dshTeamModeDomainSpec } from './storage/domain.js'
import {
  assistantBuilderPreferencesDomainSpec,
  DomainAssistantBuilderModelPreferenceStore,
} from './storage/assistant-builder-preferences.js'
import { DomainAgentTeamStore } from './storage/store.js'
import { migrateDomain } from './storage/migration.js'
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
  const domain = await ctx.storageDomain.open(dshTeamModeDomainSpec)
  const assistantBuilderPreferencesDomain = await ctx.storageDomain
    .open(assistantBuilderPreferencesDomainSpec)
    .catch(async error => {
      await domain.close()
      throw error
    })
  let runtime: TeamRuntime | undefined
  let assistantBuilderRuntime: AssistantBuilderRuntime | undefined
  let transport: ReturnType<typeof registerWebTransport> | undefined
  let service: AgentTeamService | undefined
  try {
    await migrateDomain(domain)
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
    service.attachRuntime(runtime)
    service.attachAssistantBuilderRuntime(assistantBuilderRuntime)
    transport = registerWebTransport(ctx, config, service)
    ctx.effect(() => async () => {
      transport?.dispose()
      await service?.disposeWorkspaceTracking()
      await assistantBuilderRuntime?.dispose()
      await runtime?.dispose()
      await assistantBuilderPreferencesDomain.close()
      await domain.close()
    }, 'dsh-team-mode: ordered shutdown')
    await runtime.recoverTeams()
    service.startWorkspaceTracking()
  } catch (error) {
    transport?.dispose()
    await service?.disposeWorkspaceTracking()
    await assistantBuilderRuntime?.dispose()
    await runtime?.dispose()
    await assistantBuilderPreferencesDomain.close()
    await domain.close()
    throw error
  }
}

export { AgentTeamError } from './domain/errors.js'
export type * from './domain/types.js'
export type { AgentTeamChange, CatalogSnapshot } from './service/dsh-team-mode-service.js'
