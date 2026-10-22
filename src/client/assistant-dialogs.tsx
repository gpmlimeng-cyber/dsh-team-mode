import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import { AvatarPickerDialog } from './avatar-picker-dialog.js'
import { PERMISSION_LABELS } from './labels.js'
import { MemberAvatar } from './member-avatar.js'
import { defaultReasoningLabel, useModelCapabilities } from './model-reasoning.js'
import { AnimatedModal, Field } from './shared.js'
import css from './AgentTeam.module.css'
import type { CreateAssistantInstanceInput } from '../domain/types.js'
import type { CatalogView } from '../transport/contracts.js'

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
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [permissionPresetId, setPermissionPresetId] = useState('')
  const [agentPresetId, setAgentPresetId] = useState('')
  const [instructions, setInstructions] = useState('')
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
    setAvatarPickerOpen(false)
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
  const workspaces = catalog?.workspaces.filter(item => item.status === 'ok') ?? []
  const permissionOptions = catalog?.permissionPresets ?? []
  const agentPresets = (catalog?.agentPresets ?? []).filter(preset => preset.broken === undefined)
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
      title="新建单聊助手"
      description="直接设置身份、模型、Workspace、权限与规则；首次打开时才创建它的主会话。"
      closeLabel="关闭"
      className={css.assistantCreateDialog ?? ''}
      contentClassName={css.assistantCreateDialogContent ?? ''}
    >
      <form className={css.assistantCreateForm} onSubmit={(event) => { void submit(event) }}>
        {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
        {loading
          ? <div className={css.dialogEmpty}>正在读取模型、Agent Preset 与 Workspace…</div>
          : (
            <>
              <div className={css.assistantFormSection}>
                <div className={css.assistantFormSectionHeading}>
                  <strong>身份</strong>
                </div>
                <div className={css.assistantIdentityGrid}>
                  <div className={css.assistantIdentityAvatar}>
                    <MemberAvatar
                      name={name.trim() || '助手'}
                      avatar={avatar !== '' ? avatar : undefined}
                      size={48}
                    />
                    <button
                      type="button"
                      className={css.assistantAvatarButton}
                      disabled={busy}
                      onClick={() => { setAvatarPickerOpen(true) }}
                    >
                      {avatar === '' ? '选择头像' : '更换头像'}
                    </button>
                    {avatar !== '' && !busy && (
                      <button type="button" className={css.assistantRemoveAvatar} onClick={() => { setAvatar('') }}>
                        移除
                      </button>
                    )}
                  </div>
                  <Field label="显示名称">
                    <input
                      className={css.input}
                      value={name}
                      disabled={busy}
                      autoFocus
                      placeholder="例如：写作助手"
                      onChange={event => {
                        setName(event.target.value)
                        setError(undefined)
                      }}
                    />
                    <span className={css.hint}>
                      必填。头像可选：内置 DiceBear 头像或本地上传（PNG/JPEG/WebP，≤256KB）。
                    </span>
                  </Field>
                </div>
              </div>

              <div className={css.assistantFormSection}>
                <div className={css.assistantFormSectionHeading}>
                  <strong>运行配置</strong>
                </div>
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
                        {provider === '' ? '暂无可用模型' : `${provider} / ${model}`}
                      </option>
                    )}
                    {modelGroups.map(group => (
                      <optgroup key={group.provider.id} label={group.provider.name}>
                        {group.models.map(modelEntry => (
                          <option
                            key={`${group.provider.id}/${modelEntry.id}`}
                            value={JSON.stringify([group.provider.id, modelEntry.id])}
                          >
                            {modelEntry.name === modelEntry.id
                              ? modelEntry.id
                              : `${modelEntry.name}（${modelEntry.id}）`}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <span className={css.hint}>按 Provider 分组；创建后仍可在助手设置中修改。</span>
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
                <Field label="Workspace">
                  <select
                    className={css.input}
                    value={workspaceId}
                    disabled={busy || workspaces.length === 0}
                    onChange={event => {
                      setWorkspaceId(event.target.value)
                      setError(undefined)
                    }}
                  >
                    {workspaces.length === 0
                      ? <option value="">暂无可用 Workspace</option>
                      : workspaces.map(item => (
                        <option key={item.id} value={item.id}>{item.title} — {item.path}</option>
                      ))}
                  </select>
                  <span className={css.hint}>助手及其后台任务只在这个 Workspace 内工作；创建后保持只读。</span>
                </Field>
                <Field label="权限预设">
                  <select
                    className={css.input}
                    value={permissionPresetId}
                    disabled={busy || permissionOptions.length === 0}
                    onChange={event => {
                      setPermissionPresetId(event.target.value)
                      setError(undefined)
                    }}
                  >
                    {permissionOptions.length === 0 && (
                      <option value="">暂无可用权限预设</option>
                    )}
                    {permissionOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {PERMISSION_LABELS[option.value] ?? option.name}
                      </option>
                    ))}
                  </select>
                  <span className={css.hint}>权限只影响之后创建或恢复的会话。</span>
                </Field>
                <Field label="Agent Preset">
                  <select
                    className={css.input}
                    value={agentPresetId}
                    disabled={busy || agentPresets.length === 0}
                    onChange={event => {
                      setAgentPresetId(event.target.value)
                      setError(undefined)
                    }}
                  >
                    {agentPresets.length === 0 && (
                      <option value="">暂无可用 Agent Preset</option>
                    )}
                    {agentPresets.map(preset => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name === preset.id ? preset.id : `${preset.name}（${preset.id}）`}
                      </option>
                    ))}
                  </select>
                  <span className={css.hint}>决定工具、Skills 与 MCP 的可用范围；优先选用 standard。</span>
                </Field>
              </div>

              <div className={css.assistantFormSection}>
                <div className={css.assistantFormSectionHeading}>
                  <strong>助手规则</strong>
                </div>
                <Field label="人设与规则（可选）">
                  <textarea
                    className={css.input}
                    value={instructions}
                    disabled={busy}
                    rows={4}
                    placeholder="例如：先读代码再修改；完成后运行测试并汇报结果。"
                    onChange={event => {
                      setInstructions(event.target.value)
                      setError(undefined)
                    }}
                  />
                  <span className={css.hint}>会写入该助手的实例快照，作为主会话与后台任务共享的长期人设。</span>
                </Field>
              </div>

              <p className={css.assistantCreateHint}>
                单聊助手直接创建，无需先选择助手模板；模板仍可在助手库中维护，并用于团队。
              </p>
            </>
          )}
        <div className={css.assistantCreateActions}>
          <Button variant="outline" type="button" disabled={saving} onClick={close}>取消</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={loading || saving || (!locked && !canCreate)}
          >
            {saving
              ? (locked ? '打开中…' : '创建中…')
              : (locked ? '重试打开' : '创建并打开')}
          </Button>
        </div>
      </form>
      <AvatarPickerDialog
        open={avatarPickerOpen}
        value={avatar}
        onClose={() => { setAvatarPickerOpen(false) }}
        onApply={(value) => {
          setAvatar(value)
          setError(undefined)
        }}
      />
    </AnimatedModal>
  )
}
