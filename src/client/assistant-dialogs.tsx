import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconSparkleRegular,
  IconThinkOutlineRegular,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import { assistantModelKey, assistantModelOptionLabel } from './assistant-form.js'
import { AvatarGrid } from './avatar-grid.js'
import { avatarPickerUploadError, avatarPickerValueError } from './avatar-picker.js'
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
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false)

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
    setModelMenuOpen(false)
    setReasoningMenuOpen(false)
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
  ))?.label ?? (provider === '' ? '选择模型' : assistantModelOptionLabel(provider, model))
  const selectedModelName = modelGroups.find(group => group.provider.id === provider)
    ?.models.find(modelEntry => modelEntry.id === model)?.name ?? model
  const selectedReasoningLabel = reasoningEffort === ''
    ? defaultReasoningLabel(modelCapabilities.value)
    : reasoningEffortLabel(modelCapabilities.value, reasoningEffort)
  const reasoningMenuItems = [
    { id: '__default__', label: defaultReasoningLabel(modelCapabilities.value) },
    ...reasoningEfforts.map(effort => ({
      id: effort.id,
      label: effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`,
    })),
  ]
  const modelMenuItems = modelGroups.flatMap(group => [
    { type: 'label' as const, id: `provider-${group.provider.id}`, text: group.provider.name },
    ...group.models.map(modelEntry => ({
      id: JSON.stringify([group.provider.id, modelEntry.id]),
      label: modelEntry.name,
    })),
  ])
  function uploadAvatar(file: File): void {
    const fileError = avatarPickerUploadError(file)
    if (fileError !== undefined) {
      setError(fileError)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') return
      const valueError = avatarPickerValueError(reader.result)
      if (valueError !== undefined) {
        setError(valueError)
        return
      }
      setAvatar(reader.result)
      setError(undefined)
    }
    reader.onerror = () => { setError('读取头像失败，请重试') }
    reader.readAsDataURL(file)
  }

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
          ? <div className={css.dialogEmpty}>正在读取配置…</div>
          : (
            <>
              <div className={css.assistantCreateHero}>
                <label className={css.assistantCreateAvatarFrame} aria-label="上传本地头像">
                  <MemberAvatar
                    name={name.trim() || '助手'}
                    avatar={avatar !== '' ? avatar : undefined}
                    size={96}
                  />
                  <span className={css.assistantCreateAvatarUpload} aria-hidden="true">本地上传</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className={css.avatarFileInput}
                    disabled={busy}
                    onChange={event => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      if (file !== undefined) uploadAvatar(file)
                    }}
                  />
                </label>
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
              </Field>

              <Field label="模型">
                <Menu
                  open={modelMenuOpen}
                  onClose={() => { setModelMenuOpen(false) }}
                  items={modelMenuItems}
                  selectedId={modelSelection}
                  align="start"
                  side="bottom"
                  portal
                  onSelect={id => {
                    const [nextProvider, nextModel] = JSON.parse(id) as [string, string]
                    setProvider(nextProvider)
                    setModel(nextModel)
                    setModelMenuOpen(false)
                    setError(undefined)
                  }}
                  anchor={(
                    <button
                      type="button"
                      className={css.modelTrigger}
                      disabled={busy || modelGroups.length === 0}
                      aria-label={`选择模型，当前 ${selectedModelLabel}`}
                      aria-haspopup="menu"
                      aria-expanded={modelMenuOpen}
                      title={selectedModelLabel}
                      onClick={() => {
                        setReasoningMenuOpen(false)
                        setModelMenuOpen(value => !value)
                      }}
                    >
                      <IconSparkleRegular size={16} className={css.modelTriggerIcon} />
                      <span className={css.modelTriggerLabel}>{selectedModelName || '选择模型'}</span>
                      <IconChevronDownOutlineRegular size={14} />
                    </button>
                  )}
                />
              </Field>

              {reasoningEfforts.length > 0 && (
                <Field label="思考模式">
                  <Menu
                    open={reasoningMenuOpen}
                    onClose={() => { setReasoningMenuOpen(false) }}
                    items={reasoningMenuItems}
                    selectedId={reasoningEffort === '' ? '__default__' : reasoningEffort}
                    align="start"
                    side="bottom"
                    portal
                    onSelect={id => {
                      setReasoningEffort(id === '__default__' ? '' : id)
                      setReasoningMenuOpen(false)
                      setError(undefined)
                    }}
                    anchor={(
                      <button
                        type="button"
                        className={css.modelTrigger}
                        disabled={busy || modelCapabilities.loading}
                        aria-label={`选择思考模式，当前 ${selectedReasoningLabel}`}
                        aria-haspopup="menu"
                        aria-expanded={reasoningMenuOpen}
                        title={selectedReasoningLabel}
                        onClick={() => {
                          setModelMenuOpen(false)
                          setReasoningMenuOpen(value => !value)
                        }}
                      >
                        <IconThinkOutlineRegular size={16} className={css.modelTriggerIcon} />
                        <span className={css.modelTriggerLabel}>{selectedReasoningLabel}</span>
                        <IconChevronDownOutlineRegular size={14} />
                      </button>
                    )}
                  />
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
