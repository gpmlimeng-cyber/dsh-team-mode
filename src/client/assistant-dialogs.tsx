import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import { assistantModelKey, assistantModelOptionLabel } from './assistant-form.js'
import { AvatarGrid } from './avatar-grid.js'
import { MemberAvatar } from './member-avatar.js'
import {
  defaultReasoningLabel,
  reasoningEffortLabel,
  useModelCapabilities,
} from './model-reasoning.js'
import { AnimatedModal, Field } from './shared.js'
import css from './AgentTeam.module.css'
import type { CreateAssistantInstanceInput } from '../domain/types.js'
import type { CatalogView } from '../transport/contracts.js'

const CREATE_FORM_ID = 'assistant-create-form'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Create one Assistant instance directly from identity and engine settings,
 * without a template prerequisite. Creation never opens a Session by itself:
 * `ensure` materializes the main Session and hands navigation to the shipped
 * conversation view. If `ensure` fails after creation, the dialog keeps the
 * created assistant and retries only the ensure step.
 */
export function AssistantCreateDialog({
  open,
  onClose,
  openSession,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  openSession: (sessionId: string) => void
  onCreated: () => Promise<void>
}): JSX.Element | null {
  const [catalog, setCatalog] = useState<CatalogView>()
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [permissionPresetId, setPermissionPresetId] = useState('')
  const [agentPresetId, setAgentPresetId] = useState('')
  const [instructions, setInstructions] = useState('')
  const [reasoningLabels, setReasoningLabels] = useState<Record<string, string>>({})
  const [createdId, setCreatedId] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const modelCapabilities = useModelCapabilities(provider, model)
  const locked = createdId !== undefined
  const busy = saving || locked

  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    setError(undefined)
    setCreatedId(undefined)
    setCatalog(undefined)
    setName('')
    setAvatar('')
    setProvider('')
    setModel('')
    setReasoningEffort('')
    setWorkspaceId('')
    setPermissionPresetId('')
    setAgentPresetId('')
    setInstructions('')
    setReasoningLabels({})
    callAgentTeam('catalog.get')
      .then(value => {
        if (!live) return
        setCatalog(value)
        const nextWorkspaces = value.workspaces.filter(item => item.status === 'ok')
        const nextPresets = value.agentPresets.filter(preset => preset.broken === undefined)
        const firstModelProvider = value.providers.find(entry => (value.models[entry.id]?.length ?? 0) > 0)
        const preferredPreset = nextPresets.find(preset => preset.id === 'standard') ?? nextPresets[0]
        setWorkspaceId(nextWorkspaces[0]?.id ?? '')
        setPermissionPresetId(value.permissionPresets[0]?.value ?? '')
        setAgentPresetId(preferredPreset?.id ?? '')
        setProvider(firstModelProvider?.id ?? '')
        setModel(firstModelProvider === undefined
          ? ''
          : value.models[firstModelProvider.id]?.[0]?.id ?? '')
      })
      .catch(cause => {
        if (live) setError(`读取模型与 Workspace 目录失败：${messageOf(cause)}`)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => { live = false }
  }, [open])

  useEffect(() => {
    // The model select shows the model default reasoning level as its subtitle.
    // Resolve those labels once per catalog so every option can read
    // `Model — Provider · High` without opening the dialog a second time.
    if (catalog === undefined) return
    let live = true
    const selections = catalog.providers.flatMap(providerEntry => (
      (catalog.models[providerEntry.id] ?? []).map(modelEntry => ({
        provider: providerEntry.id,
        model: modelEntry.id,
      }))
    ))
    void Promise.all(selections.map(async selection => {
      try {
        const capabilities = await callAgentTeam('catalog.model.get', selection)
        const defaultEffort = capabilities.reasoning?.defaultEffort
        const label = defaultEffort === undefined
          ? undefined
          : capabilities.reasoning?.efforts.find(effort => effort.id === defaultEffort)?.name
        return [assistantModelKey(selection.provider, selection.model), label ?? ''] as const
      } catch {
        return [assistantModelKey(selection.provider, selection.model), ''] as const
      }
    })).then(entries => {
      if (!live) return
      const next: Record<string, string> = {}
      for (const [key, label] of entries) {
        if (label !== '') next[key] = label
      }
      setReasoningLabels(next)
    })
    return () => { live = false }
  }, [catalog])

  useEffect(() => {
    // A newly selected model may advertise a different set of reasoning efforts
    // (or none at all). Drop an unsupported effort so the select only offers
    // values the current model accepts.
    if (modelCapabilities.loading || modelCapabilities.value === undefined) return
    const efforts = modelCapabilities.value.reasoning?.efforts ?? []
    setReasoningEffort(current => (
      current !== '' && !efforts.some(effort => effort.id === current) ? '' : current
    ))
  }, [modelCapabilities.loading, modelCapabilities.value])

  if (!open) return null

  const modelGroups = (catalog?.providers ?? []).map(providerEntry => ({
    provider: providerEntry,
    models: catalog?.models[providerEntry.id] ?? [],
  })).filter(group => group.models.length > 0)
  const reasoningEfforts = modelCapabilities.value?.reasoning?.efforts ?? []
  const modelSelection = JSON.stringify([provider, model])
  const modelSelectionInCatalog = modelGroups.some(group => (
    group.provider.id === provider && group.models.some(modelEntry => modelEntry.id === model)
  ))
  const canCreate = name.trim() !== ''
    && provider !== ''
    && model !== ''
    && workspaceId !== ''
    && permissionPresetId !== ''
    && agentPresetId !== ''

  function reasoningLabelFor(providerId: string, modelId: string): string | undefined {
    if (providerId === provider && modelId === model) {
      if (reasoningEffort !== '') {
        return reasoningEffortLabel(modelCapabilities.value, reasoningEffort)
      }
      const defaultEffort = modelCapabilities.value?.reasoning?.defaultEffort
      if (defaultEffort !== undefined) {
        return reasoningEffortLabel(modelCapabilities.value, defaultEffort)
      }
    }
    return reasoningLabels[assistantModelKey(providerId, modelId)]
  }

  const modelOptions = modelGroups.flatMap(group => group.models.map(modelEntry => ({
    providerId: group.provider.id,
    modelId: modelEntry.id,
    label: assistantModelOptionLabel(
      group.provider.name,
      modelEntry.name,
      reasoningLabelFor(group.provider.id, modelEntry.id),
    ),
  })))
  const selectedModelLabel = modelOptions.find(option => (
    option.providerId === provider && option.modelId === model
  ))?.label

  const close = (): void => {
    if (saving) return
    onClose()
  }

  async function ensureAndOpen(id: string): Promise<void> {
    try {
      const result = await callAgentTeam('assistant.instance.ensure', { id })
      onClose()
      openSession(result.sessionId)
    } catch (cause) {
      setError(`助手已创建，但打开主会话失败：${messageOf(cause)}。可以点击「重试打开」，不会重复创建助手。`)
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (saving) return
    if (createdId !== undefined) {
      setSaving(true)
      setError(undefined)
      try {
        await ensureAndOpen(createdId)
      } finally {
        setSaving(false)
      }
      return
    }
    const displayName = name.trim()
    if (displayName === '') {
      setError('请填写显示名称')
      return
    }
    if (provider.trim() === '' || model.trim() === '') {
      setError('请选择 Provider 和模型')
      return
    }
    if (workspaceId === '') {
      setError('请选择 Workspace')
      return
    }
    if (permissionPresetId === '') {
      setError('请选择权限预设')
      return
    }
    if (agentPresetId === '') {
      setError('请选择 Agent Preset')
      return
    }
    // A direct Assistant carries its complete configuration; omitting
    // templateId is what makes the service build a template-less instance.
    const payload: CreateAssistantInstanceInput = {
      name: displayName,
      workspaceId,
      provider,
      model,
      agentPresetId,
      permissionPresetId,
      instructions: instructions.trim(),
      ...(avatar === '' ? {} : { avatar }),
      ...(reasoningEffort === '' ? {} : { reasoningEffort }),
    }
    setSaving(true)
    setError(undefined)
    try {
      const created = await callAgentTeam('assistant.instance.create', payload)
      setCreatedId(created.id)
      await onCreated()
      await ensureAndOpen(created.id)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AnimatedModal
      open
      onClose={close}
      title="创建助手"
      closeLabel="关闭"
      className={css.assistantCreateDialog ?? ''}
      contentClassName={css.assistantCreateDialogContent ?? ''}
      footer={(
        <div className={css.assistantCreateFooter}>
          <Button variant="outline" type="button" disabled={saving} onClick={close}>取消</Button>
          <Button
            variant="primary"
            type="submit"
            form={CREATE_FORM_ID}
            disabled={loading || saving || (!locked && !canCreate)}
          >
            {saving
              ? (locked ? '打开中…' : '创建中…')
              : (locked ? '重试打开' : '创建')}
          </Button>
        </div>
      )}
    >
      <form
        id={CREATE_FORM_ID}
        className={css.assistantCreateForm}
        onSubmit={(event) => { void submit(event) }}
      >
        {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
        {loading
          ? <div className={css.dialogEmpty}>正在读取模型、Agent Preset 与 Workspace…</div>
          : (
            <>
              <div className={css.assistantCreateHero}>
                <span className={css.assistantCreateAvatarFrame}>
                  <MemberAvatar
                    name={name.trim() || '助手'}
                    avatar={avatar !== '' ? avatar : undefined}
                    size={88}
                  />
                </span>
                <span
                  className={`${css.assistantCreateAvatarName}${name.trim() === ''
                    ? ` ${css.assistantCreateAvatarPlaceholder}`
                    : ''}`}
                >
                  {name.trim() || '新助手'}
                </span>
              </div>

              <section className={css.assistantCreateAvatarCard} aria-label="形象">
                <div className={css.assistantCreateCardHeading}>
                  <strong>形象</strong>
                  <span className={css.assistantCreateCardHint}>内置 DiceBear 或本地上传</span>
                </div>
                <AvatarGrid
                  value={avatar}
                  disabled={busy}
                  onChange={next => {
                    setAvatar(next)
                    setError(undefined)
                  }}
                />
              </section>

              <Field label="名称">
                <input
                  className={css.input}
                  value={name}
                  disabled={busy}
                  data-modal-autofocus
                  placeholder="例如：写作助手"
                  onChange={event => {
                    setName(event.target.value)
                    setError(undefined)
                  }}
                />
                <span className={css.hint}>必填；预览会随着输入实时更新。</span>
              </Field>

              <Field label="模型">
                <select
                  className={css.input}
                  value={modelSelection}
                  disabled={busy || modelGroups.length === 0}
                  onChange={event => {
                    const [nextProvider, nextModel] = JSON.parse(event.target.value) as [string, string]
                    setProvider(nextProvider)
                    setModel(nextModel)
                    setError(undefined)
                  }}
                >
                  {!modelSelectionInCatalog && (
                    <option value={modelSelection} disabled>
                      {provider === '' ? '暂无可用模型' : assistantModelOptionLabel(provider, model)}
                    </option>
                  )}
                  {modelOptions.map(option => (
                    <option
                      key={`${option.providerId}/${option.modelId}`}
                      value={JSON.stringify([option.providerId, option.modelId])}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className={css.hint}>
                  {selectedModelLabel === undefined
                    ? '选择模型后会显示完整的模型名、Provider 与思考档位。'
                    : `当前：${selectedModelLabel}。创建后仍可在助手设置中修改。`}
                </span>
              </Field>

              {reasoningEfforts.length > 0 && (
                <Field label="思考模式">
                  <select
                    className={css.input}
                    value={reasoningEffort}
                    disabled={busy || modelCapabilities.loading}
                    onChange={event => {
                      setReasoningEffort(event.target.value)
                      setError(undefined)
                    }}
                  >
                    <option value="">{defaultReasoningLabel(modelCapabilities.value)}</option>
                    {reasoningEfforts.map(effort => (
                      <option key={effort.id} value={effort.id}>
                        {effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`}
                      </option>
                    ))}
                  </select>
                  <span className={css.hint}>
                    由当前模型决定可用档位；选择「模型默认」会使用模型默认档位。
                  </span>
                </Field>
              )}

              {modelCapabilities.error !== undefined && (
                <div className={css.inlineError} role="alert">
                  读取模型能力失败：{modelCapabilities.error}
                </div>
              )}

            </>
          )}
      </form>
    </AnimatedModal>
  )
}
