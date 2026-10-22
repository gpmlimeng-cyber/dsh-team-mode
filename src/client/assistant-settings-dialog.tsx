import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import {
  assistantAvatarDataUrlError,
  assistantAvatarFileError,
  assistantInstanceName,
} from './assistant-instances.js'
import { PERMISSION_LABELS } from './labels.js'
import { MemberAvatar } from './member-avatar.js'
import { defaultReasoningLabel, useModelCapabilities } from './model-reasoning.js'
import { AnimatedModal, Field } from './shared.js'
import css from './AgentTeam.module.css'
import type { AssistantInstance, UpdateAssistantInstanceInput } from '../domain/types.js'
import type { CatalogView } from '../transport/contracts.js'

const STATUS_LABELS: Record<AssistantInstance['status'], string> = {
  idle: '空闲',
  starting: '启动中',
  active: '活跃',
  error: '出错',
  archived: '已归档',
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function formatCreatedAt(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * Edit one Assistant instance's local identity and engine settings. The model,
 * reasoning effort, and permission preset are validated against the live
 * catalog and saved on the instance snapshot; the referenced template is never
 * changed. Workspace remains fixed after creation.
 */
export function AssistantSettingsDialog({
  open,
  assistant,
  onClose,
  onSaved,
}: {
  open: boolean
  assistant: AssistantInstance
  onClose: () => void
  onSaved: () => Promise<void> | void
}): JSX.Element {
  const [name, setName] = useState(assistantInstanceName(assistant))
  const [avatar, setAvatar] = useState(assistant.assistantSnapshot.avatar ?? '')
  const [avatarChanged, setAvatarChanged] = useState(false)
  const [templateName, setTemplateName] = useState<string>()
  const [workspaceTitle, setWorkspaceTitle] = useState<string>()
  const [catalog, setCatalog] = useState<CatalogView>()
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string>()
  const [provider, setProvider] = useState(assistant.assistantSnapshot.provider)
  const [model, setModel] = useState(assistant.assistantSnapshot.model)
  const [reasoningEffort, setReasoningEffort] = useState(assistant.assistantSnapshot.reasoningEffort ?? '')
  const [permissionPresetId, setPermissionPresetId] = useState(assistant.assistantSnapshot.permissionPresetId)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState<string>()

  const busy = saving || archiving
  const modelCapabilities = useModelCapabilities(provider, model)

  useEffect(() => {
    if (!open) return
    let live = true
    setName(assistantInstanceName(assistant))
    setAvatar(assistant.assistantSnapshot.avatar ?? '')
    setAvatarChanged(false)
    setTemplateName(undefined)
    setWorkspaceTitle(undefined)
    setCatalog(undefined)
    setCatalogLoading(true)
    setCatalogError(undefined)
    setProvider(assistant.assistantSnapshot.provider)
    setModel(assistant.assistantSnapshot.model)
    setReasoningEffort(assistant.assistantSnapshot.reasoningEffort ?? '')
    setPermissionPresetId(assistant.assistantSnapshot.permissionPresetId)
    setConfirmArchive(false)
    setSaving(false)
    setArchiving(false)
    setError(undefined)
    callAgentTeam('catalog.get')
      .then(value => {
        if (!live) return
        setCatalog(value)
        setWorkspaceTitle(value.workspaces.find(item => item.id === assistant.workspaceId)?.title)
      })
      .catch((cause: unknown) => {
        // Keep name/avatar editing available; model and permission controls stay
        // disabled until a catalog is available.
        if (live) setCatalogError(`读取模型/权限目录失败：${messageOf(cause)}`)
      })
      .finally(() => {
        if (live) setCatalogLoading(false)
      })
    if (assistant.templateId !== undefined) {
      callAgentTeam('assistant.list')
        .then(assistantPage => {
          if (live) setTemplateName(assistantPage.items.find(item => item.id === assistant.templateId)?.name)
        })
        .catch(() => {
          // The summary degrades to the stored template id; editing still works.
        })
    }
    return () => { live = false }
  }, [open, assistant.id])

  useEffect(() => {
    // A newly selected model may advertise a different set of reasoning efforts
    // (or none at all). Drop an unsupported effort so the select always shows a
    // value the model accepts; saving then clears it on the snapshot.
    if (modelCapabilities.loading || modelCapabilities.value === undefined) return
    const efforts = modelCapabilities.value.reasoning?.efforts ?? []
    setReasoningEffort(current => (
      current !== '' && !efforts.some(effort => effort.id === current) ? '' : current
    ))
  }, [modelCapabilities.loading, modelCapabilities.value])

  const close = (): void => {
    if (busy) return
    onClose()
  }

  function chooseAvatar(file: File): void {
    const fileError = assistantAvatarFileError(file)
    if (fileError !== undefined) {
      setError(fileError)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') return
      const dataUrlError = assistantAvatarDataUrlError(reader.result)
      if (dataUrlError !== undefined) {
        setError(dataUrlError)
        return
      }
      setAvatar(reader.result)
      setAvatarChanged(true)
      setError(undefined)
    }
    reader.onerror = () => { setError('读取头像失败，请重试') }
    reader.readAsDataURL(file)
  }

  function clearAvatar(): void {
    setAvatar('')
    setAvatarChanged(true)
    setError(undefined)
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    const displayName = name.trim()
    if (displayName === '') {
      setError('显示名称不能为空')
      return
    }
    if (provider.trim() === '' || model.trim() === '') {
      setError('请选择 Provider 和模型')
      return
    }
    if (permissionPresetId.trim() === '') {
      setError('请选择权限预设')
      return
    }
    const avatarError = assistantAvatarDataUrlError(avatar)
    if (avatarError !== undefined) {
      setError(avatarError)
      return
    }
    const snapshot = assistant.assistantSnapshot
    const value: UpdateAssistantInstanceInput = { name: displayName }
    if (avatarChanged) value.avatar = avatar
    if (provider !== snapshot.provider || model !== snapshot.model) {
      // provider and model always travel together so the service can validate
      // the pair against the current model catalog.
      value.provider = provider
      value.model = model
    }
    const nextReasoningEffort = reasoningEffort.trim()
    if (nextReasoningEffort !== (snapshot.reasoningEffort ?? '')) {
      // An empty string clears the effort and falls back to the model default.
      value.reasoningEffort = nextReasoningEffort
    }
    if (permissionPresetId !== snapshot.permissionPresetId) {
      value.permissionPresetId = permissionPresetId
    }
    setSaving(true)
    setError(undefined)
    try {
      await callAgentTeam('assistant.instance.update', {
        id: assistant.id,
        value,
      })
      onClose()
      await onSaved()
    } catch (cause) {
      setError(`保存失败：${messageOf(cause)}`)
    } finally {
      setSaving(false)
    }
  }

  async function archive(): Promise<void> {
    if (busy) return
    if (!confirmArchive) {
      setConfirmArchive(true)
      setError(undefined)
      return
    }
    setArchiving(true)
    setError(undefined)
    try {
      await callAgentTeam('assistant.instance.archive', { id: assistant.id })
      onClose()
      await onSaved()
    } catch (cause) {
      setError(`归档失败：${messageOf(cause)}`)
    } finally {
      setArchiving(false)
    }
  }

  const displayName = name.trim() === '' ? '助手' : name.trim()
  const templateLabel = assistant.templateId === undefined
    ? '无（直接创建）'
    : templateName === undefined
      ? assistant.templateId
      : `${templateName}（${assistant.templateId}）`
  const workspaceLabel = workspaceTitle === undefined
    ? assistant.workspacePath
    : `${workspaceTitle} — ${assistant.workspacePath}`
  const modelGroups = (catalog?.providers ?? []).map(providerEntry => ({
    provider: providerEntry,
    models: catalog?.models[providerEntry.id] ?? [],
  })).filter(group => group.models.length > 0)
  const modelSelection = JSON.stringify([provider, model])
  const modelSelectionInCatalog = modelGroups.some(group => (
    group.provider.id === provider && group.models.some(modelEntry => modelEntry.id === model)
  ))
  const permissionOptions = catalog?.permissionPresets ?? []
  const permissionInCatalog = permissionOptions.some(option => option.value === permissionPresetId)
  const reasoningEfforts = modelCapabilities.value?.reasoning?.efforts ?? []

  return (
    <AnimatedModal
      open={open}
      onClose={close}
      title="助手设置"
      description="修改显示名称、头像、模型、思考模式与权限；Workspace 在创建后保持只读。"
      closeLabel="关闭"
      className={css.assistantSettingsDialog ?? ''}
    >
      <form className={css.assistantSettingsForm} onSubmit={(event) => { void save(event) }}>
        {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
        {catalogError !== undefined && <div className={css.inlineError} role="alert">{catalogError}</div>}
        <div className={css.assistantSettingsAvatarRow}>
          <MemberAvatar name={displayName} avatar={avatar} size={52} />
          <div className={css.assistantSettingsAvatarCopy}>
            <span className={css.assistantSettingsAvatarTitle}>头像</span>
            <div className={css.assistantSettingsAvatarActions}>
              <label className={css.avatarUpload}>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className={css.avatarFileInput}
                  disabled={busy}
                  onChange={event => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file !== undefined) chooseAvatar(file)
                  }}
                />
                选择图片
              </label>
              {avatar !== '' && (
                <Button variant="outline" type="button" disabled={busy} onClick={clearAvatar}>
                  清除头像
                </Button>
              )}
            </div>
            <span className={css.assistantSettingsAvatarHint}>支持 PNG、JPEG、WebP，最大 256KB。</span>
          </div>
        </div>
        <Field label="显示名称">
          <input
            className={css.input}
            value={name}
            disabled={busy}
            autoFocus
            placeholder="助手名称"
            onChange={event => { setName(event.target.value) }}
          />
        </Field>
        <Field label="模型">
          <select
            className={css.input}
            value={modelSelection}
            disabled={busy || catalog === undefined}
            onChange={event => {
              const [nextProvider, nextModel] = JSON.parse(event.target.value) as [string, string]
              setProvider(nextProvider)
              setModel(nextModel)
              setError(undefined)
            }}
          >
            {!modelSelectionInCatalog && (
              <option value={modelSelection}>{provider} / {model}（当前）</option>
            )}
            {modelGroups.map(group => (
              <optgroup key={group.provider.id} label={group.provider.name}>
                {group.models.map(modelEntry => (
                  <option
                    key={`${group.provider.id}/${modelEntry.id}`}
                    value={JSON.stringify([group.provider.id, modelEntry.id])}
                  >
                    {modelEntry.name === modelEntry.id ? modelEntry.id : `${modelEntry.name}（${modelEntry.id}）`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className={css.assistantSettingsAvatarHint}>
            {catalogLoading
              ? '正在读取模型列表…'
              : '按 Provider 分组；保存时同时写入 Provider 与模型。'}
          </span>
        </Field>
        {reasoningEfforts.length > 0 && (
          <Field label="思考模式">
            <select
              className={css.input}
              value={reasoningEffort}
              disabled={busy}
              onChange={event => { setReasoningEffort(event.target.value) }}
            >
              <option value="">{defaultReasoningLabel(modelCapabilities.value)}</option>
              {reasoningEfforts.map(effort => (
                <option key={effort.id} value={effort.id}>
                  {effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`}
                </option>
              ))}
            </select>
            <span className={css.assistantSettingsAvatarHint}>
              由当前模型决定可用档位；选择「模型默认」会清除已保存的档位。
            </span>
          </Field>
        )}
        {modelCapabilities.error !== undefined && (
          <div className={css.inlineError} role="alert">
            读取模型能力失败：{modelCapabilities.error}
          </div>
        )}
        <Field label="权限预设">
          <select
            className={css.input}
            value={permissionPresetId}
            disabled={busy || catalog === undefined}
            onChange={event => {
              setPermissionPresetId(event.target.value)
              setError(undefined)
            }}
          >
            {!permissionInCatalog && (
              <option value={permissionPresetId}>
                {PERMISSION_LABELS[permissionPresetId] ?? permissionPresetId}（当前）
              </option>
            )}
            {permissionOptions.map(option => (
              <option key={option.value} value={option.value}>
                {PERMISSION_LABELS[option.value] ?? option.name}
              </option>
            ))}
          </select>
          <span className={css.assistantSettingsAvatarHint}>
            权限只影响之后创建或恢复的会话；已打开的主会话保持原权限。
          </span>
        </Field>
        <div className={css.assistantSettingsSummary} aria-label="助手信息">
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>助手模板</span>
            <span className={css.assistantSettingsSummaryValue} title={assistant.templateId}>{templateLabel}</span>
          </div>
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>Workspace</span>
            <span className={css.assistantSettingsSummaryValue} title={assistant.workspacePath}>{workspaceLabel}</span>
          </div>
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>状态</span>
            <span
              className={css.assistantSettingsSummaryValue}
              data-dsh-assistant-settings-status={assistant.status}
            >
              {STATUS_LABELS[assistant.status]}
            </span>
          </div>
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>创建时间</span>
            <span className={css.assistantSettingsSummaryValue}>{formatCreatedAt(assistant.createdAt)}</span>
          </div>
        </div>
        <span className={css.assistantSettingsAvatarHint}>
          已打开的主会话会沿用旧模型，直到重新创建或恢复；新建的后台任务和未来恢复的主会话使用保存后的配置。
        </span>
        <div className={css.assistantCreateActions}>
          <Button variant="outline" type="button" disabled={busy} onClick={close}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
      <div className={css.assistantSettingsArchive}>
        <div className={css.assistantSettingsArchiveCopy}>
          <span className={css.assistantSettingsArchiveTitle}>归档助手</span>
          <span className={css.assistantSettingsArchiveHint}>
            归档后该助手将从「单聊」列表移除，并停止正在运行的后台任务；主会话记录不会被删除。
          </span>
          {confirmArchive && (
            <span className={css.assistantSettingsArchiveWarning} role="alert">
              再次点击「确认归档」完成归档。
            </span>
          )}
        </div>
        <button
          type="button"
          className={`${css.dangerButton} ${css.confirmDangerButton} ${confirmArchive ? css.assistantSettingsArchiveConfirm : ''}`}
          disabled={busy}
          onClick={() => { void archive() }}
        >
          {archiving ? '归档中…' : confirmArchive ? '确认归档' : '归档助手'}
        </button>
      </div>
    </AnimatedModal>
  )
}
