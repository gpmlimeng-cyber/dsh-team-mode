import { SelectControl } from './select-control.js'
import type { SelectControlOption, SelectControlTrigger } from './select-control.js'
import { defaultReasoningLabel } from './model-reasoning.js'
import type { ModelCapabilitiesView } from '../transport/contracts.js'

/** One model row of the merged control, with the provider that owns it. */
export interface ModelControlModel {
  providerId: string
  providerName: string
  modelId: string
  /** Menu row text, usually the model name. */
  label: string
  /** Optional second line under the row, e.g. that model's default level. */
  description?: string | undefined
}

/** What one menu pick changes, so the two row kinds stay distinguishable. */
export interface ModelControlPatch {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** The thinking levels of the shown model, already worded for the menu. */
export interface ModelControlReasoning {
  /** The clearing row's label, e.g. 模型默认（Medium）. */
  defaultLabel: string
  levels: ReadonlyArray<{ id: string; label: string }>
  /** The model's own default level name, shown when no explicit pick is stored. */
  defaultLevel?: string | undefined
}

/** Row-id prefixes keep the two independent groups apart inside one menu. */
export const MODEL_ROW_PREFIX = 'model:'
export const EFFORT_ROW_PREFIX = 'effort:'
/** Group heading the effort rows share, after every provider group. */
export const EFFORT_GROUP = '思考模式'

export function modelControlModelRow(providerId: string, modelId: string): string {
  return `${MODEL_ROW_PREFIX}${providerId}/${modelId}`
}

export function modelControlEffortRow(effortId: string): string {
  return `${EFFORT_ROW_PREFIX}${effortId}`
}

/**
 * The fields one menu row writes. A model row always carries the provider with
 * the model (the service validates the pair); an effort row writes only the
 * level, with the empty id meaning "the model's own default".
 */
export function modelControlPick(selection: string): ModelControlPatch | undefined {
  if (selection.startsWith(EFFORT_ROW_PREFIX)) {
    return { reasoningEffort: selection.slice(EFFORT_ROW_PREFIX.length) }
  }
  if (!selection.startsWith(MODEL_ROW_PREFIX)) return undefined
  const reference = selection.slice(MODEL_ROW_PREFIX.length)
  const at = reference.indexOf('/')
  if (at <= 0 || at === reference.length - 1) return undefined
  return { provider: reference.slice(0, at), model: reference.slice(at + 1) }
}

/**
 * The catalog's capabilities as the control needs them. No levels means no
 * thinking row at all, so a model without levels never gets an empty section.
 */
export function modelControlReasoning(
  capabilities: ModelCapabilitiesView | undefined,
): ModelControlReasoning | undefined {
  const efforts = capabilities?.reasoning?.efforts ?? []
  if (efforts.length === 0) return undefined
  const defaultEffort = capabilities?.reasoning?.defaultEffort
  return {
    defaultLabel: defaultReasoningLabel(capabilities),
    // The menu and the trigger both show the level's name, like the reference
    // control; the id stays the stored value only.
    levels: efforts.map(effort => ({ id: effort.id, label: effort.name })),
    ...(defaultEffort === undefined
      ? {}
      : { defaultLevel: efforts.find(effort => effort.id === defaultEffort)?.name ?? defaultEffort }),
  }
}

/**
 * Every row of the merged menu: the models grouped by provider, then the
 * thinking levels of the shown model in their own group. Reuses
 * `SelectControlOption.group`, so there is one grouped menu, not two pickers.
 */
export function modelControlOptions(
  models: readonly ModelControlModel[],
  reasoning: ModelControlReasoning | undefined,
): SelectControlOption[] {
  const rows: SelectControlOption[] = models.map(model => ({
    value: modelControlModelRow(model.providerId, model.modelId),
    label: model.label,
    group: model.providerName,
    ...(model.description === undefined ? {} : { description: model.description }),
  }))
  if (reasoning === undefined) return rows
  return [
    ...rows,
    {
      value: modelControlEffortRow(''),
      label: reasoning.defaultLabel,
      group: EFFORT_GROUP,
    },
    ...reasoning.levels.map(level => ({
      value: modelControlEffortRow(level.id),
      label: level.label,
      group: EFFORT_GROUP,
    })),
  ]
}

/**
 * The rows shown as chosen: the current model, and — when the model has levels —
 * the stored level or the clearing row. A level the model no longer serves is
 * not a row anymore, so the default row is marked instead.
 */
export function modelControlSelection(
  provider: string,
  model: string,
  reasoningEffort: string,
  reasoning: ModelControlReasoning | undefined,
): string[] {
  const selected: string[] = []
  if (provider !== '' && model !== '') selected.push(modelControlModelRow(provider, model))
  if (reasoning !== undefined) {
    const picked = reasoning.levels.some(level => level.id === reasoningEffort) ? reasoningEffort : ''
    selected.push(modelControlEffortRow(picked))
  }
  return selected
}

/**
 * The closed control, two lines: the model name over `provider · level`. A model
 * with no levels shows the provider alone; an unsupported stored level falls
 * back to the model's default name so the second line is never blank.
 */
export function modelControlTrigger(
  provider: string,
  model: string,
  models: readonly ModelControlModel[],
  reasoning: ModelControlReasoning | undefined,
  reasoningEffort = '',
): SelectControlTrigger {
  const row = models.find(candidate => (
    candidate.providerId === provider && candidate.modelId === model
  ))
  const title = row?.label ?? (model === '' ? '选择模型' : model)
  const providerName = row?.providerName ?? provider
  const picked = reasoning === undefined
    ? undefined
    : reasoning.levels.some(level => level.id === reasoningEffort) ? reasoningEffort : undefined
  const level = picked === undefined
    ? reasoning?.defaultLevel ?? reasoning?.defaultLabel
    : reasoning?.levels.find(candidate => candidate.id === picked)?.label ?? picked
  const subtitle = providerName === ''
    ? level
    : level === undefined ? providerName : `${providerName} · ${level}`
  return {
    title,
    ...(subtitle === undefined || subtitle === '' ? {} : { subtitle }),
  }
}

/**
 * 模型 and 思考模式 in one control, built on the shared `SelectControl`: the
 * trigger names the model over its provider and level, and one menu carries the
 * provider-grouped models plus the shown model's levels. Nothing here fetches;
 * the caller passes the catalog rows and its `useModelCapabilities` value.
 */
export function ModelControl({
  provider,
  model,
  reasoningEffort,
  models,
  capabilities,
  disabled = false,
  ariaLabel = '模型与思考模式',
  onChange,
}: {
  provider: string
  model: string
  /** `''` means the model's own default level. */
  reasoningEffort: string
  models: readonly ModelControlModel[]
  capabilities: ModelCapabilitiesView | undefined
  disabled?: boolean
  ariaLabel?: string
  onChange: (patch: ModelControlPatch) => void
}): JSX.Element {
  const reasoning = modelControlReasoning(capabilities)
  const trigger = modelControlTrigger(provider, model, models, reasoning, reasoningEffort)
  const selected = modelControlSelection(provider, model, reasoningEffort, reasoning)
  return (
    <SelectControl
      ariaLabel={trigger.subtitle === undefined
        ? `${ariaLabel}：${trigger.title}`
        : `${ariaLabel}：${trigger.title}，${trigger.subtitle}`}
      value=""
      selectedIds={selected}
      options={modelControlOptions(models, reasoning)}
      triggerLines={trigger}
      title={provider === '' || model === '' ? undefined : `${provider} / ${model}`}
      disabled={disabled}
      onChange={next => {
        const patch = modelControlPick(next)
        if (patch !== undefined) onChange(patch)
      }}
    />
  )
}
