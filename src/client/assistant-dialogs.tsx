import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import {
  ASSISTANT_CREATE_SECTIONS,
  ASSISTANT_CREATE_UNSUPPORTED,
  applyStartingRole,
  assistantCreateCanSubmit,
  assistantCreateDefaults,
  assistantCreateGroupOptions,
  assistantCreateIntent,
  assistantCreatePayload,
  assistantCreateValidationError,
  assistantModelKey,
  assistantModelOptionLabel,
  emptyAssistantCreateDraft,
  enabledAssistantRoles,
  type AssistantCreateDraft,
  type AssistantCreateSection,
} from './assistant-form.js'
import { AvatarGrid } from './avatar-grid.js'
import { avatarPickerUploadError, avatarPickerValueError } from './avatar-picker.js'
import { PERMISSION_LABELS } from './labels.js'
import { MemberAvatar } from './member-avatar.js'
import {
  defaultReasoningLabel,
  reasoningEffortLabel,
  useModelCapabilities,
} from './model-reasoning.js'
import { AnimatedModal, Field } from './shared.js'
import css from './AgentTeam.module.css'
import type { AssistantTemplate } from '../domain/types.js'
import type { CatalogView } from '../transport/contracts.js'

const CREATE_FORM_ID = 'assistant-create-form'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export interface AssistantCreateModelGroup {
  providerId: string
  providerName: string
  models: Array<{ id: string; label: string }>
}

/**
 * The body is a pure view of the dialog's state so it can be rendered by
 * `react-dom/server` in tests: no catalog reads, no mutations, no DOM hooks.
 */
export interface AssistantCreateBodyProps {
  loading: boolean
  saving: boolean
  locked: boolean
  catalogError: string | undefined
  error: string | undefined
  warning: string | undefined
  banner: string | undefined
  activeSection: AssistantCreateSection
  draft: AssistantCreateDraft
  roles: readonly AssistantTemplate[]
  roleError: string | undefined
  groups: readonly string[]
  workspaces: ReadonlyArray<{ id: string; title: string }>
  modelGroups: readonly AssistantCreateModelGroup[]
  reasoningOptions: ReadonlyArray<{ id: string; label: string }>
  defaultReasoning: string
  capabilityError: string | undefined
  agentPresets: ReadonlyArray<{ id: string; name: string }>
  permissionPresets: ReadonlyArray<{ value: string; name: string }>
  onSectionChange: (section: AssistantCreateSection) => void
  onDraftChange: (patch: Partial<AssistantCreateDraft>) => void
  onRoleSelect: (templateId: string) => void
  onRetryCatalog: () => void
  onAvatarFile: (file: File) => void
}

function SectionHeading({ title, hint }: { title: string; hint: string }): JSX.Element {
  return (
    <div className={css.assistantCreateSectionHeading}>
      <strong>{title}</strong>
      <span>{hint}</span>
    </div>
  )
}

function RolePicker({
  roles,
  disabled,
  onSelect,
}: {
  roles: readonly AssistantTemplate[]
  disabled: boolean
  onSelect: (templateId: string) => void
}): JSX.Element {
  const builtin = roles.filter(role => role.source === 'builtin')
  const mine = roles.filter(role => role.source !== 'builtin')
  return (
    <Field label="起始角色">
      <select
        className={css.input}
        value=""
        disabled={disabled}
        onChange={event => { onSelect(event.target.value) }}
      >
        <option value="">自定义配置</option>
        {builtin.length > 0 && (
          <optgroup label="内置角色">
            {builtin.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
          </optgroup>
        )}
        {mine.length > 0 && (
          <optgroup label="我的模板">
            {mine.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
          </optgroup>
        )}
      </select>
      <span className={css.hint}>
        选中后填入该模板的真实名称、人设、头像与模型；之后仍可逐项修改，实例不会绑定模板。
      </span>
    </Field>
  )
}

function IdentitySection(props: AssistantCreateBodyProps, disabled: boolean): JSX.Element {
  const { draft, roles, roleError, groups, onDraftChange, onRoleSelect, onAvatarFile } = props
  const groupOptions = assistantCreateGroupOptions(groups)
  return (
    <>
      <SectionHeading title="身份" hint="名称、形象与分组" />
      {roleError === undefined
        ? <RolePicker roles={roles} disabled={disabled} onSelect={onRoleSelect} />
        : (
          <span className={css.hint}>
            读取助手模板失败：{roleError}。可以直接自定义创建，不影响其他字段。
          </span>
        )}
      <div className={css.assistantCreateHero}>
        <label className={css.assistantCreateAvatarFrame} aria-label="上传本地头像">
          <MemberAvatar
            name={draft.name.trim() || '助手'}
            avatar={draft.avatar !== '' ? draft.avatar : undefined}
            size={72}
          />
          <span className={css.assistantCreateAvatarUpload} aria-hidden="true">本地上传</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className={css.avatarFileInput}
            disabled={disabled}
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) onAvatarFile(file)
            }}
          />
        </label>
        <div className={css.assistantCreateHeroCopy}>
          <Field label="名称">
            <input
              className={css.input}
              value={draft.name}
              disabled={disabled}
              data-modal-autofocus
              placeholder="输入名称"
              aria-label="助手名称"
              onChange={event => { onDraftChange({ name: event.target.value }) }}
            />
          </Field>
          <span className={css.hint}>显示在侧栏和会话里，必填。</span>
        </div>
      </div>
      <div className={css.assistantCreateAvatarCard}>
        <div className={css.assistantCreateCardHeading}>
          <strong>形象</strong>
          <span className={css.assistantCreateCardHint}>点选内置头像，或使用本地上传</span>
        </div>
        <AvatarGrid
          value={draft.avatar}
          disabled={disabled}
          onChange={next => { onDraftChange({ avatar: next }) }}
        />
      </div>
      {groupOptions.visible
        ? (
          <Field label="分组">
            <select
              className={css.input}
              value={draft.group}
              disabled={disabled}
              onChange={event => { onDraftChange({ group: event.target.value }) }}
            >
              {groupOptions.options.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <span className={css.hint}>
              创建后立即写入侧栏分组；写入失败不会影响助手创建，可稍后在行菜单里移动。
            </span>
          </Field>
        )
        : <span className={css.hint}>还没有分组；先在侧栏新建分组，再回来选择。</span>}
    </>
  )
}

function PersonaSection(props: AssistantCreateBodyProps, disabled: boolean): JSX.Element {
  return (
    <>
      <SectionHeading title="人设" hint="写入助手的系统提示" />
      <Field label="人设">
        <textarea
          className={`${css.input} ${css.assistantCreatePersona}`}
          aria-label="人设"
          rows={8}
          value={props.draft.instructions}
          disabled={disabled}
          placeholder="例如：你负责整理需求并给出可执行的实现建议；先读代码再回答。"
          onChange={event => { props.onDraftChange({ instructions: event.target.value }) }}
        />
        <span className={css.hint}>
          会写入助手的系统提示；留空则使用 Agent Preset 默认。只影响之后创建或恢复的会话。
        </span>
      </Field>
    </>
  )
}

function ModelSection(props: AssistantCreateBodyProps, disabled: boolean): JSX.Element {
  const { draft, workspaces, modelGroups, reasoningOptions, defaultReasoning, capabilityError } = props
  const modelSelection = JSON.stringify([draft.provider, draft.model])
  return (
    <>
      <SectionHeading title="模型与环境" hint="会话在哪里运行、使用哪个模型" />
      <Field label="Workspace">
        <select
          className={css.input}
          value={draft.workspaceId}
          disabled={disabled}
          onChange={event => { props.onDraftChange({ workspaceId: event.target.value }) }}
        >
          {workspaces.length === 0
            ? <option value="">没有可用 Workspace</option>
            : draft.workspaceId === '' && <option value="">请选择</option>}
          {workspaces.map(workspace => (
            <option key={workspace.id} value={workspace.id}>{workspace.title}</option>
          ))}
        </select>
        <span className={css.hint}>主会话在这个 Workspace 里运行；创建后不可更改。</span>
      </Field>
      <Field label="模型">
        <select
          className={css.input}
          value={modelSelection}
          disabled={disabled}
          onChange={event => {
            const [provider, model] = JSON.parse(event.target.value) as [string, string]
            props.onDraftChange({ provider, model })
          }}
        >
          {modelGroups.length === 0 && <option value="">没有可用模型</option>}
          {modelGroups.map(group => (
            <optgroup key={group.providerId} label={group.providerName}>
              {group.models.map(model => (
                <option
                  key={model.id}
                  value={JSON.stringify([group.providerId, model.id])}
                >
                  {model.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      {reasoningOptions.length > 0 && (
        <Field label="思考模式">
          <select
            className={css.input}
            value={draft.reasoningEffort}
            disabled={disabled}
            onChange={event => { props.onDraftChange({ reasoningEffort: event.target.value }) }}
          >
            <option value="">{defaultReasoning}</option>
            {reasoningOptions.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <span className={css.hint}>由当前模型决定可用档位；选择「模型默认」会清除档位。</span>
        </Field>
      )}
      <Field label="Agent Preset">
        <select
          className={css.input}
          value={draft.agentPresetId}
          disabled={disabled}
          onChange={event => { props.onDraftChange({ agentPresetId: event.target.value }) }}
        >
          {props.agentPresets.length === 0
            ? <option value="">没有可用 Agent Preset</option>
            : draft.agentPresetId === '' && <option value="">请选择</option>}
          {props.agentPresets.map(preset => (
            <option key={preset.id} value={preset.id}>{preset.name}</option>
          ))}
        </select>
        <span className={css.hint}>决定工具与策略包；创建时定死，之后不可修改。</span>
      </Field>
      {capabilityError !== undefined && (
        <div className={css.inlineError} role="alert">读取模型能力失败：{capabilityError}</div>
      )}
    </>
  )
}

function PermissionsSection(props: AssistantCreateBodyProps, disabled: boolean): JSX.Element {
  const { draft, permissionPresets } = props
  return (
    <>
      <SectionHeading title="权限" hint="只影响之后创建或恢复的会话" />
      <Field label="权限预设">
        <select
          className={css.input}
          value={draft.permissionPresetId}
          disabled={disabled}
          onChange={event => { props.onDraftChange({ permissionPresetId: event.target.value }) }}
        >
          {permissionPresets.length === 0
            ? <option value="">没有可用权限预设</option>
            : draft.permissionPresetId === '' && <option value="">请选择</option>}
          {permissionPresets.map(preset => (
            <option key={preset.value} value={preset.value}>
              {PERMISSION_LABELS[preset.value] ?? preset.name}
            </option>
          ))}
        </select>
        <span className={css.hint}>已打开的主会话保持原权限，直到它被重新创建或恢复。</span>
      </Field>
      <div className={css.assistantCreateReadonlyNote}>
        总协调（Coordinator）在侧栏行菜单设置，创建时不设。
      </div>
    </>
  )
}

function sectionContent(
  props: AssistantCreateBodyProps,
  disabled: boolean,
): JSX.Element {
  switch (props.activeSection) {
    case 'identity':
      return IdentitySection(props, disabled)
    case 'persona':
      return PersonaSection(props, disabled)
    case 'model':
      return ModelSection(props, disabled)
    case 'permissions':
      return PermissionsSection(props, disabled)
  }
}

export function AssistantCreateBody(props: AssistantCreateBodyProps): JSX.Element {
  const navDisabled = props.loading || props.saving || props.locked
  const fieldsDisabled = navDisabled
  const activeLabel = ASSISTANT_CREATE_SECTIONS
    .find(section => section.key === props.activeSection)?.label ?? '身份'
  return (
    <div
      className={css.assistantCreateLayout}
      aria-busy={props.saving || props.locked ? true : undefined}
      data-dsh-assistant-create-body
    >
      {props.banner !== undefined && (
        <div className={css.assistantCreateBanner}>{props.banner}</div>
      )}
      {props.error !== undefined && (
        <div className={css.inlineError} role="alert">{props.error}</div>
      )}
      {props.warning !== undefined && (
        <div className={css.assistantCreateWarning} role="status">{props.warning}</div>
      )}
      <div className={css.assistantCreateSplit}>
        <nav className={css.assistantCreateNav} aria-label="创建助手的区块">
          {ASSISTANT_CREATE_SECTIONS.map(section => (
            <button
              key={section.key}
              type="button"
              className={css.assistantCreateNavItem}
              aria-current={section.key === props.activeSection ? 'page' : undefined}
              aria-disabled={navDisabled ? true : undefined}
              tabIndex={navDisabled ? -1 : undefined}
              onClick={() => { if (!navDisabled) props.onSectionChange(section.key) }}
            >
              {section.label}
            </button>
          ))}
        </nav>
        <section className={css.assistantCreatePane} aria-label={activeLabel}>
          {props.catalogError !== undefined
            ? (
              <div className={css.assistantCreatePaneEmpty}>
                <div className={css.inlineError} role="alert">
                  读取配置失败：{props.catalogError}
                </div>
                <Button variant="outline" type="button" onClick={props.onRetryCatalog}>重试</Button>
              </div>
            )
            : props.loading
              ? <div className={css.dialogEmpty} role="status">正在读取配置…</div>
              : (
                <fieldset className={css.assistantCreateFieldset} disabled={fieldsDisabled}>
                  {sectionContent(props, fieldsDisabled)}
                </fieldset>
              )}
        </section>
      </div>
      <details className={css.assistantCreateUnavailable}>
        <summary>还有 5 项创建时不提供</summary>
        <ul aria-label="未提供的区块">
          {ASSISTANT_CREATE_UNSUPPORTED.map(item => (
            <li key={item.key}><strong>{item.title}</strong>：{item.detail}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

export interface AssistantCreateFooterProps {
  loading: boolean
  saving: boolean
  locked: boolean
  canCreate: boolean
  onCancel: () => void
}

export function AssistantCreateFooter({
  loading,
  saving,
  locked,
  canCreate,
  onCancel,
}: AssistantCreateFooterProps): JSX.Element {
  return (
    <div className={css.assistantCreateFooter} data-dsh-assistant-create-footer>
      <Button variant="outline" type="button" disabled={saving} onClick={onCancel}>取消</Button>
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
  )
}

/**
 * Create one Assistant instance directly from identity and engine settings,
 * without a template prerequisite. Creation never opens a Session by itself:
 * `ensure` materializes the main Session and hands navigation to the shipped
 * conversation view. If `ensure` fails after creation, the dialog keeps the
 * created assistant and retries only the ensure step.
 *
 * The dialog is sectioned like the reference product, but every section maps to
 * a field this plugin can store. Group placement reuses
 * `assistant.instance.update` after `create` (the create schema is strict and
 * rejects `group`); a failed group write is a warning, never a failed creation.
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
  const [catalogError, setCatalogError] = useState<string>()
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [draft, setDraft] = useState<AssistantCreateDraft>(() => emptyAssistantCreateDraft())
  const [activeSection, setActiveSection] = useState<AssistantCreateSection>('identity')
  const [roles, setRoles] = useState<AssistantTemplate[]>([])
  const [roleError, setRoleError] = useState<string>()
  const [groups, setGroups] = useState<string[]>([])
  const [createdId, setCreatedId] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [warning, setWarning] = useState<string>()
  const [groupApplied, setGroupApplied] = useState(false)
  const [reasoningLabels, setReasoningLabels] = useState<Record<string, string>>({})

  const modelCapabilities = useModelCapabilities(draft.provider, draft.model)
  const locked = createdId !== undefined

  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    setCatalog(undefined)
    setCatalogError(undefined)
    setRoles([])
    setRoleError(undefined)
    setGroups([])
    setDraft(emptyAssistantCreateDraft())
    setActiveSection('identity')
    setCreatedId(undefined)
    setSaving(false)
    setError(undefined)
    setWarning(undefined)
    setGroupApplied(false)
    setReasoningLabels({})
    callAgentTeam('catalog.get')
      .then(value => {
        if (!live) return
        setCatalog(value)
        setDraft(assistantCreateDefaults(value))
      })
      .catch(cause => {
        if (live) setCatalogError(messageOf(cause))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    callAgentTeam('assistant.list')
      .then(page => {
        if (live) setRoles(enabledAssistantRoles(page.items))
      })
      .catch(cause => {
        // A role is a convenience: a failed template read must not block a
        // directly configured creation.
        if (live) setRoleError(messageOf(cause))
      })
    callAgentTeam('sidebar.groups.list')
      .then(value => {
        if (live) setGroups(value)
      })
      .catch(() => {
        // No group list is a valid sidebar; the picker stays hidden.
      })
    return () => { live = false }
  }, [open, catalogAttempt])

  useEffect(() => {
    // A model advertises its own reasoning levels; the picker shows each model's
    // default as a subtitle, resolved once per catalog.
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
    setDraft(current => (
      current.reasoningEffort !== '' && !efforts.some(effort => effort.id === current.reasoningEffort)
        ? { ...current, reasoningEffort: '' }
        : current
    ))
  }, [modelCapabilities.loading, modelCapabilities.value])

  if (!open) return null

  const workspaces = (catalog?.workspaces ?? [])
    .filter(workspace => workspace.status === 'ok')
    .map(workspace => ({ id: workspace.id, title: workspace.title }))
  const agentPresets = (catalog?.agentPresets ?? [])
    .filter(preset => preset.broken === undefined)
    .map(preset => ({ id: preset.id, name: preset.name }))
  const permissionPresets = catalog?.permissionPresets ?? []
  const reasoningEfforts = modelCapabilities.value?.reasoning?.efforts ?? []
  const reasoningOptions = reasoningEfforts.map(effort => ({
    id: effort.id,
    label: effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`,
  }))
  const activeWorkspace = workspaces.find(workspace => workspace.id === draft.workspaceId)
  const banner = catalog !== undefined && workspaces.length > 1 && activeWorkspace !== undefined
    ? `将在「${activeWorkspace.title}」中创建 · 可在「模型与环境」切换`
    : undefined
  const canCreate = assistantCreateCanSubmit(draft)

  function reasoningLabelFor(providerId: string, modelId: string): string | undefined {
    if (providerId === draft.provider && modelId === draft.model) {
      if (draft.reasoningEffort !== '') {
        return reasoningEffortLabel(modelCapabilities.value, draft.reasoningEffort)
      }
      const defaultEffort = modelCapabilities.value?.reasoning?.defaultEffort
      if (defaultEffort !== undefined) {
        return reasoningEffortLabel(modelCapabilities.value, defaultEffort)
      }
    }
    return reasoningLabels[assistantModelKey(providerId, modelId)]
  }

  const modelGroups = (catalog?.providers ?? []).flatMap(providerEntry => {
    const models = (catalog?.models[providerEntry.id] ?? []).map(modelEntry => ({
      id: modelEntry.id,
      label: assistantModelOptionLabel(
        providerEntry.name,
        modelEntry.name,
        reasoningLabelFor(providerEntry.id, modelEntry.id),
      ),
    }))
    return models.length === 0
      ? []
      : [{ providerId: providerEntry.id, providerName: providerEntry.name, models }]
  })

  function patchDraft(patch: Partial<AssistantCreateDraft>): void {
    setDraft(current => ({ ...current, ...patch }))
    setError(undefined)
  }

  function selectRole(templateId: string): void {
    const template = roles.find(role => role.id === templateId)
    if (template === undefined) return
    // Applying a role replaces the fields it owns once; later edits survive
    // section switches and are never overwritten again until another role is
    // picked.
    setDraft(current => applyStartingRole(current, template, catalog))
    setError(undefined)
  }

  function uploadAvatar(file: File): void {
    const fileError = avatarPickerUploadError(file)
    if (fileError !== undefined) {
      setError(fileError)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result
      if (typeof dataUrl !== 'string') return
      const valueError = avatarPickerValueError(dataUrl)
      if (valueError !== undefined) {
        setError(valueError)
        return
      }
      setDraft(current => ({ ...current, avatar: dataUrl }))
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
    const intent = assistantCreateIntent({ createdId, saving })
    if (intent === 'ignore') return
    if (intent === 'ensure' && createdId !== undefined) {
      setSaving(true)
      setError(undefined)
      try {
        await ensureAndOpen(createdId)
      } finally {
        setSaving(false)
      }
      return
    }
    const validationError = assistantCreateValidationError(draft)
    if (validationError !== undefined) {
      setError(validationError)
      return
    }
    // A direct Assistant carries its complete configuration; omitting
    // templateId is what makes the service build a template-less instance.
    const payload = assistantCreatePayload(draft)
    setSaving(true)
    setError(undefined)
    setWarning(undefined)
    try {
      const created = await callAgentTeam('assistant.instance.create', payload)
      setCreatedId(created.id)
      // The create schema is strict and rejects `group`, so placement is one
      // follow-up update. It is not part of creation success: a refusal becomes
      // an inline warning and the assistant still opens.
      if (draft.group !== '' && !groupApplied) {
        try {
          await callAgentTeam('assistant.instance.update', {
            id: created.id,
            value: { group: draft.group },
          })
          setGroupApplied(true)
        } catch (cause) {
          setWarning(
            `助手已创建，但分组未写入：${messageOf(cause)}。可在侧栏行菜单的「移动到分组」里稍后设置。`,
          )
        }
      }
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
        <AssistantCreateFooter
          loading={loading}
          saving={saving}
          locked={locked}
          canCreate={canCreate}
          onCancel={close}
        />
      )}
    >
      <form
        id={CREATE_FORM_ID}
        className={css.assistantCreateForm}
        onSubmit={(event) => { void submit(event) }}
      >
        <AssistantCreateBody
          loading={loading}
          saving={saving}
          locked={locked}
          catalogError={catalogError}
          error={error}
          warning={warning}
          banner={banner}
          activeSection={activeSection}
          draft={draft}
          roles={roles}
          roleError={roleError}
          groups={groups}
          workspaces={workspaces}
          modelGroups={modelGroups}
          reasoningOptions={reasoningOptions}
          defaultReasoning={defaultReasoningLabel(modelCapabilities.value)}
          capabilityError={modelCapabilities.error}
          agentPresets={agentPresets}
          permissionPresets={permissionPresets}
          onSectionChange={setActiveSection}
          onDraftChange={patchDraft}
          onRoleSelect={selectRole}
          onRetryCatalog={() => { setCatalogAttempt(attempt => attempt + 1) }}
          onAvatarFile={uploadAvatar}
        />
      </form>
    </AnimatedModal>
  )
}
