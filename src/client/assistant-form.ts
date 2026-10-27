import type { AssistantInstance, AssistantTemplate, CreateAssistantInstanceInput } from '../domain/types.js'
import type { CatalogView } from '../transport/contracts.js'

/**
 * Stable key for one catalog model selection. The create dialog uses it to
 * attach per-model reasoning labels without changing the catalog contract.
 */
export function assistantModelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * One-line label for the create dialog model select, following the DS Bot
 * form shape: model name first, then provider, then the current reasoning
 * subtitle when the model advertises one (for example
 * `DeepSeek-V4.1-Flash — DeepSeek · High`).
 */
export function assistantModelOptionLabel(
  providerName: string,
  modelName: string,
  reasoningLabel?: string,
): string {
  const model = modelName.trim()
  const provider = providerName.trim()
  const reasoning = reasoningLabel?.trim() ?? ''
  const head = provider === '' ? model : `${model} — ${provider}`
  return reasoning === '' ? head : `${head} · ${reasoning}`
}

/**
 * The create dialog's sections. Every one of these writes a real instance
 * field; Memory/Routines/Access/Voice are deliberately absent so the
 * navigation can never offer a tab that has nothing to save (see
 * `ASSISTANT_CREATE_UNSUPPORTED` and docs/research/assistant-create-parity-audit.md).
 * Skills and MCP Servers live inside 模型与环境 because they follow the
 * Agent Preset that section already picks.
 */
export const ASSISTANT_CREATE_SECTIONS = [
  { key: 'identity', label: '身份' },
  { key: 'model', label: '模型与权限' },
  { key: 'capabilities', label: '技能与MCP' },
] as const

export type AssistantCreateSection = (typeof ASSISTANT_CREATE_SECTIONS)[number]['key']

/**
 * The parts of MausBot's nine-section dialog this plugin cannot store for one
 * Assistant created here. They are listed once, read-only, instead of being
 * rendered as tabs whose controls would save nothing.
 */
export const ASSISTANT_CREATE_UNSUPPORTED = [
  {
    key: 'memory',
    title: '记忆',
    detail: '创建后在助手设置/记忆面板维护（持久记忆条目），创建时没有草稿。',
  },
  {
    key: 'routines',
    title: '例程',
    detail: '本插件没有按助手的定时任务；团队任务与提醒走团队流程。',
  },
  {
    key: 'access',
    title: '访问',
    detail: '只保留 Workspace（在「模型与环境」）；浏览器、电脑、连接器、工具授权没有对应字段。',
  },
  {
    key: 'voice',
    title: '语音与通知',
    detail: '不可按助手配置，通知沿用 DSH 全局行为。',
  },
] as const

/** Everything the create dialog collects, kept as one value across sections. */
export interface AssistantCreateDraft {
  name: string
  avatar: string
  instructions: string
  provider: string
  model: string
  reasoningEffort: string
  workspaceId: string
  agentPresetId: string
  permissionPresetId: string
  group: string
  mascotSeed: string
  mascotShape: string
  mascotEyes: string
  mascotColor: string
  /** Body paint: solid for every flat swatch, radial for the chrome ball. */
  mascotFill: string
  /** Skills and MCP Servers the assistant may use; empty means none. */
  skillAllowlist: string[]
  mcpServers: string[]
}

export function emptyAssistantCreateDraft(): AssistantCreateDraft {
  return {
    name: '',
    avatar: '',
    instructions: '',
    provider: '',
    model: '',
    reasoningEffort: '',
    workspaceId: '',
    agentPresetId: '',
    permissionPresetId: '',
    group: '',
    mascotSeed: '',
    mascotShape: '',
    mascotEyes: '',
    mascotColor: '',
    mascotFill: '',
    skillAllowlist: [],
    mcpServers: [],
  }
}

/**
 * The values a freshly opened dialog starts with. Every default comes from the
 * catalog; no value is invented, and a catalog that offers nothing yields empty
 * fields (which the footer then refuses to submit).
 */
export function assistantCreateDefaults(catalog: CatalogView | undefined): AssistantCreateDraft {
  const draft = emptyAssistantCreateDraft()
  if (catalog === undefined) return draft
  const workspace = catalog.workspaces.find(entry => entry.status === 'ok')
  const permission = catalog.permissionPresets.find(entry => entry.value === 'workspace-write')
    ?? catalog.permissionPresets[0]
  const presets = catalog.agentPresets.filter(entry => entry.broken === undefined)
  const agentPreset = presets.find(entry => entry.id === 'standard') ?? presets[0]
  const provider = catalog.providers.find(entry => (catalog.models[entry.id]?.length ?? 0) > 0)
  return {
    ...draft,
    workspaceId: workspace?.id ?? '',
    permissionPresetId: permission?.value ?? '',
    agentPresetId: agentPreset?.id ?? '',
    provider: provider?.id ?? '',
    model: provider === undefined ? '' : catalog.models[provider.id]?.[0]?.id ?? '',
  }
}

/** Enabled templates only: a disabled one is not offered as a starting role. */
export function enabledAssistantRoles(
  templates: readonly AssistantTemplate[],
): AssistantTemplate[] {
  return templates.filter(template => template.enabled)
}

/**
 * Apply one starting role exactly once. The role is a convenience: its name,
 * persona, avatar, engine defaults and capabilities are copied into the draft,
 * but a value the catalog no longer offers is skipped rather than written into
 * a create call that would certainly fail. The template itself is never sent
 * (`templateId`), so the instance stays a directly configured Assistant — which
 * is why the capabilities have to travel through the draft to reach it.
 */
export function applyStartingRole(
  draft: AssistantCreateDraft,
  template: Pick<
    AssistantTemplate,
    | 'name'
    | 'instructions'
    | 'avatar'
    | 'provider'
    | 'model'
    | 'reasoningEffort'
    | 'agentPresetId'
    | 'permissionPresetId'
    | 'skillAllowlist'
    | 'mcpServers'
  >,
  catalog: CatalogView | undefined,
): AssistantCreateDraft {
  const pairInCatalog = catalog !== undefined
    && catalog.providers.some(providerEntry => providerEntry.id === template.provider
      && (catalog.models[providerEntry.id] ?? []).some(modelEntry => modelEntry.id === template.model))
  const agentPreset = catalog?.agentPresets.find(entry => entry.id === template.agentPresetId)
  const permission = catalog?.permissionPresets.find(entry => entry.value === template.permissionPresetId)
  return {
    ...draft,
    name: template.name,
    instructions: template.instructions,
    avatar: template.avatar ?? '',
    reasoningEffort: template.reasoningEffort ?? '',
    skillAllowlist: [...template.skillAllowlist],
    mcpServers: [...template.mcpServers],
    ...(pairInCatalog ? { provider: template.provider, model: template.model } : {}),
    ...(agentPreset !== undefined && agentPreset.broken === undefined
      ? { agentPresetId: agentPreset.id }
      : {}),
    ...(permission === undefined ? {} : { permissionPresetId: permission.value }),
  }
}

/**
 * The mascot travels in the create payload (`mascot` is part of the create
 * contract, the same precedent as `instructions`), so the picked look is the
 * one the instance is born with. An empty seed means "let the instance fall
 * back to its id"; the dialog seeds it when it opens.
 */
export function assistantCreateMascot(draft: AssistantCreateDraft): AssistantInstance['mascot'] {
  if (draft.mascotSeed.trim() === '') return undefined
  return {
    seed: draft.mascotSeed.trim(),
    ...(draft.mascotShape === '' ? {} : { shape: draft.mascotShape }),
    ...(draft.mascotEyes === '' ? {} : { eyes: draft.mascotEyes }),
    ...(draft.mascotColor === '' ? {} : { color: draft.mascotColor }),
    ...(draft.mascotFill === 'radial' ? { fill: 'radial' as const } : {}),
  }
}

/** The direct-create shape; only `group` and `templateId` stay outside it. */
export function assistantCreatePayload(draft: AssistantCreateDraft): CreateAssistantInstanceInput {
  const mascot = assistantCreateMascot(draft)
  return {
    name: draft.name.trim(),
    workspaceId: draft.workspaceId,
    provider: draft.provider,
    model: draft.model,
    agentPresetId: draft.agentPresetId,
    permissionPresetId: draft.permissionPresetId,
    instructions: draft.instructions.trim(),
    ...(draft.avatar === '' ? {} : { avatar: draft.avatar }),
    ...(draft.reasoningEffort === '' ? {} : { reasoningEffort: draft.reasoningEffort }),
    ...(draft.skillAllowlist.length === 0 ? {} : { skillAllowlist: draft.skillAllowlist }),
    ...(draft.mcpServers.length === 0 ? {} : { mcpServers: draft.mcpServers }),
    ...(mascot === undefined ? {} : { mascot }),
  }
}

/** The first reason the create call would be refused, or undefined when ready. */
export function assistantCreateValidationError(draft: AssistantCreateDraft): string | undefined {
  if (draft.name.trim() === '') return '请填写显示名称'
  if (draft.provider.trim() === '' || draft.model.trim() === '') return '请选择 Provider 和模型'
  if (draft.workspaceId === '') return '请选择 Workspace'
  if (draft.permissionPresetId === '') return '请选择权限预设'
  if (draft.agentPresetId === '') return '请选择 Agent Preset'
  return undefined
}

export function assistantCreateCanSubmit(draft: AssistantCreateDraft): boolean {
  return assistantCreateValidationError(draft) === undefined
}

/**
 * The group picker. An empty Host list means groups do not exist yet: hiding
 * the select is better than offering only "不分组". The Host guarantees ordered,
 * unique names, so this neither trims nor de-duplicates.
 */
export function assistantCreateGroupOptions(groups: readonly string[]): {
  visible: boolean
  options: Array<{ value: string; label: string }>
} {
  return groups.length === 0
    ? { visible: false, options: [] }
    : {
        visible: true,
        options: [
          { value: '', label: '不分组' },
          ...groups.map(group => ({ value: group, label: group })),
        ],
      }
}

export type AssistantCreateIntent = 'create' | 'ensure' | 'ignore'

/**
 * One confirmation per Assistant: a second submit after creation retries only
 * the ensure step, never create again, and a submit while saving is ignored.
 */
export function assistantCreateIntent(state: {
  createdId: string | undefined
  saving: boolean
}): AssistantCreateIntent {
  if (state.saving) return 'ignore'
  return state.createdId === undefined ? 'create' : 'ensure'
}
