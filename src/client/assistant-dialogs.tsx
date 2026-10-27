import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular, IconProjectAddOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import {
  ASSISTANT_CREATE_SECTIONS,
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
import { avatarPickerUploadError, avatarPickerValueError } from './avatar-picker.js'
import {
  CapabilityPicker,
  savableNames,
  useCapabilityCatalog,
  type CapabilityOption,
} from './assistant-capabilities.js'
import { MASCOT_EYES, MASCOT_SHAPES, nextMascotSeed, randomMascotDraft, type MascotEyes, type MascotOptions, type MascotShape } from './mascot.js'
import { MascotPicker } from './mascot-picker.js'
import { Mascot } from './mascot-view.js'
import { PERMISSION_LABELS } from './labels.js'
import {
  defaultReasoningLabel,
  reasoningEffortLabel,
  useModelCapabilities,
} from './model-reasoning.js'
import { SelectControl } from './select-control.js'
import type { SelectControlOption } from './select-control.js'
import { SettingsRow, SettingsRows } from './settings-row.js'
import { AnimatedModal } from './shared.js'
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
  /** `label` is the full pill text; `name` is the bare row text. */
  models: Array<{ id: string; name: string; label: string }>
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
  /** Skills and MCP Servers of the draft's Agent Preset (its live catalog). */
  skills: readonly CapabilityOption[]
  mcpServers: readonly CapabilityOption[]
  capabilitiesLoading: boolean
  capabilitiesError: string | undefined
  agentPresets: ReadonlyArray<{ id: string; name: string; description?: string }>
  permissionPresets: ReadonlyArray<{ value: string; name: string }>
  onSectionChange: (section: AssistantCreateSection) => void
  onDraftChange: (patch: Partial<AssistantCreateDraft>) => void
  onRoleSelect: (templateId: string) => void
  onRetryCatalog: () => void
  onAvatarFile: (file: File) => void
  /** Adds a workspace through the host picker and returns it, or null if cancelled. */
  onAddWorkspace: () => Promise<{ id: string; title: string } | null>
}

function SectionHeading({ title, hint }: { title: string; hint: string }): JSX.Element {
  return (
    <div className={css.assistantCreateSectionHeading}>
      <strong>{title}</strong>
      <span>{hint}</span>
    </div>
  )
}

function roleOptions(
  roles: readonly AssistantTemplate[],
): SelectControlOption[] {
  const builtin = roles.filter(role => role.source === 'builtin')
  const mine = roles.filter(role => role.source !== 'builtin')
  return [
    { value: '', label: '自定义配置' },
    ...builtin.map(role => ({ value: role.id, label: role.name, group: '内置角色' })),
    ...mine.map(role => ({ value: role.id, label: role.name, group: '我的模板' })),
  ]
}

/** Model rows share the provider heading, so the pill reads like the old optgroup. */
function modelOptions(
  groups: readonly AssistantCreateModelGroup[],
): SelectControlOption[] {
  return groups.flatMap(group => group.models.map(model => ({
    value: assistantModelKey(group.providerId, model.id),
    // The list row is the model alone; the pill still names the provider.
    label: model.name,
    triggerLabel: model.label,
    group: group.providerName,
  })))
}

/** Split the `provider/model` key back into the pair the draft stores. */
function splitModelKey(key: string): [string, string] {
  const at = key.indexOf('/')
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)]
}

/**
 * The create dialog's 形象 section: collapsed by default, an existing-avatar
 * preview plus the same `MascotPicker` the settings dialog uses. Every option
 * writes the draft, so the preview above re-renders before anything is saved.
 */
function MascotEditor({
  draft,
  disabled,
  onChange,
  onAvatarFile,
}: {
  draft: AssistantCreateDraft
  disabled: boolean
  onChange: (patch: Partial<AssistantCreateDraft>) => void
  onAvatarFile: (file: File) => void
}): JSX.Element {
  const seed = draft.mascotSeed.trim() === '' ? 'assistant' : draft.mascotSeed
  const options: MascotOptions = {
    ...(draft.mascotShape === '' ? {} : { shapeVariant: draft.mascotShape as MascotShape }),
    ...(draft.mascotEyes === '' ? {} : { eyesVariant: draft.mascotEyes as MascotEyes }),
    ...(draft.mascotColor === '' ? {} : { bodyColor: draft.mascotColor }),
    bodyColorFill: draft.mascotFill === 'radial' ? 'radial' : 'solid',
  }
  const reset = (): void => onChange({
    avatar: '',
    mascotSeed: nextMascotSeed(),
    mascotShape: '',
    mascotEyes: '',
    mascotColor: '',
    mascotFill: '',
  })
  return (
    <details className={css.mascotEditor} data-dsh-assistant-create-mascot open>
      <summary className={css.mascotEditorSummary}>
        <span>形象</span>
        <span className={css.assistantCreateCardHint}>表情 · 颜色 · 身体</span>
      </summary>
      <div className={css.mascotPreview}>
        {draft.avatar === ''
          ? <Mascot seed={seed} options={options} size={112} motion="idle" />
          : <img className={css.mascotPreviewImage} src={draft.avatar} alt="助手头像预览" />}
      </div>
      <div className={css.mascotActions}>
        <label className={css.mascotAction} aria-label="上传本地头像">
          上传头像
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
        <button type="button" className={css.mascotAction} disabled={disabled} onClick={() => {
            const next = randomMascotDraft()
            onChange({
              mascotSeed: next.seed,
              mascotShape: next.shape,
              mascotEyes: next.eyes,
              mascotColor: next.color,
            })
          }}>
          随机
        </button>
        <button type="button" className={css.mascotAction} disabled={disabled} onClick={reset}>
          重置形象
        </button>
        {draft.avatar !== '' && (
          <button type="button" className={css.mascotAction} disabled={disabled} onClick={() => onChange({ avatar: '' })}>
            移除图片
          </button>
        )}
      </div>
      <MascotPicker
        seed={seed}
        value={options}
        disabled={disabled}
        onChange={next => onChange({
          mascotShape: next.shapeVariant ?? '',
          mascotEyes: next.eyesVariant ?? '',
          mascotColor: next.bodyColor ?? '',
          mascotFill: next.bodyColorFill ?? 'solid',
        })}
      />
    </details>
  )
}

function IdentitySection(props: AssistantCreateBodyProps, disabled: boolean): JSX.Element {
  const { draft, roles, roleError, groups, onDraftChange, onRoleSelect, onAvatarFile } = props
  const groupOptions = assistantCreateGroupOptions(groups)
  return (
    <>
      <SectionHeading title="人设与形象" hint="名称、描述、形象与分组" />
      <SettingsRows>
        {roleError === undefined
          ? (
            <SettingsRow
              label="选择模板"
              hint="选中后填入该模板的真实名称、描述、头像与模型；之后仍可逐项修改，实例不会绑定模板。"
              control={(
                <SelectControl
                  ariaLabel="选择模板"
                  value=""
                  options={roleOptions(roles)}
                  disabled={disabled}
                  onChange={onRoleSelect}
                />
              )}
            />
          )
          : (
            <SettingsRow
              label="选择模板"
              hint={`读取助手模板失败：${roleError}。可以直接自定义创建，不影响其他字段。`}
              control={null}
            />
          )}
        <SettingsRow
          label="名称"
          hint="显示在侧栏和会话里，必填。"
          control={(
            <input
              className={css.input}
              value={draft.name}
              disabled={disabled}
              data-modal-autofocus
              placeholder="输入名称"
              aria-label="助手名称"
              onChange={event => { onDraftChange({ name: event.target.value }) }}
            />
          )}
        />
        <details className={css.assistantCreateFold} data-dsh-assistant-create-description>
          <summary className={css.assistantCreateFoldSummary}>
            <span className={css.assistantCreateFoldCopy}>
              <span className={css.assistantCreateFoldTitle}>描述</span>
              <span className={css.settingsRowHint}>
                写入助手的系统提示；留空则使用 Agent Preset 默认。只影响之后创建或恢复的会话。
              </span>
            </span>
            <span className={css.assistantCreateFoldAction}>编辑</span>
          </summary>
          <textarea
            className={`${css.input} ${css.assistantCreateDescription}`}
            aria-label="描述"
            rows={3}
            value={draft.instructions}
            disabled={disabled}
            placeholder="例如：你负责整理需求并给出可执行的实现建议；先读代码再回答。"
            onChange={event => { props.onDraftChange({ instructions: event.target.value }) }}
          />
        </details>
        {groupOptions.visible && (
          <SettingsRow
            label="分组"
            hint="创建后立即写入侧栏分组；写入失败不会影响助手创建，可稍后在行菜单里移动。"
            control={(
              <SelectControl
                ariaLabel="分组"
                value={draft.group}
                options={groupOptions.options.map(option => ({
                  value: option.value,
                  label: option.label,
                }))}
                disabled={disabled}
                onChange={next => { onDraftChange({ group: next }) }}
              />
            )}
          />
        )}
      </SettingsRows>
      {!groupOptions.visible && (
        <span className={css.hint}>还没有分组；先在侧栏新建分组，再回来选择。</span>
      )}
      <MascotEditor
        draft={draft}
        disabled={disabled}
        onChange={onDraftChange}
        onAvatarFile={onAvatarFile}
      />
    </>
  )
}


function ModelSection(props: AssistantCreateBodyProps, disabled: boolean): JSX.Element {
  const { draft, workspaces, modelGroups, reasoningOptions, defaultReasoning, capabilityError } = props
  return (
    <>
      <SectionHeading title="模型与权限" hint="会话在哪里运行、用哪个模型、什么权限" />
      <SettingsRows>
        <SettingsRow
          label="Workspace"
          hint="主会话在这个 Workspace 里运行；创建后不可更改。"
          control={(
            <SelectControl
              ariaLabel="Workspace"
              value={draft.workspaceId}
              placeholder="没有可用 Workspace"
              options={workspaces.map(workspace => ({
                value: workspace.id,
                label: workspace.title,
                // Same folder glyph the shipped workspace picker draws.
                icon: <IconFolderOpenOutlineRegular size={14} />,
              }))}
              disabled={disabled}
              onChange={next => { props.onDraftChange({ workspaceId: next }) }}
              footerAction={{
                label: '添加工作区…',
                icon: <IconPlusOutlineRegular size={14} />,
                onSelect: () => {
                  void props.onAddWorkspace().then(added => {
                    if (added !== null) props.onDraftChange({ workspaceId: added.id })
                  })
                },
              }}
            />
          )}
        />
        <SettingsRow
          label="模型"
          hint="Provider 与模型一起保存；创建后仍可在助手设置里改。"
          control={(
            <SelectControl
              ariaLabel="模型"
              value={assistantModelKey(draft.provider, draft.model)}
              placeholder="没有可用模型"
              options={modelOptions(modelGroups)}
              disabled={disabled}
              onChange={next => {
                const [provider, model] = splitModelKey(next)
                props.onDraftChange({ provider, model })
              }}
            />
          )}
        />
        {reasoningOptions.length > 0 && (
          <SettingsRow
            label="思考模式"
            hint="由当前模型决定可用档位；选择「模型默认」会清除档位。"
            control={(
              <SelectControl
                ariaLabel="思考模式"
                value={draft.reasoningEffort}
                options={[
                  { value: '', label: defaultReasoning },
                  ...reasoningOptions.map(option => ({
                    value: option.id,
                    label: option.label,
                  })),
                ]}
                disabled={disabled}
                onChange={next => { props.onDraftChange({ reasoningEffort: next }) }}
              />
            )}
          />
        )}
        <SettingsRow
          label="Agent Preset"
          hint="决定工具与策略包；创建时定死，之后不可修改。"
          control={(
            <SelectControl
              ariaLabel="Agent Preset"
              value={draft.agentPresetId}
              placeholder="没有可用 Agent Preset"
              options={props.agentPresets.map(preset => ({
                value: preset.id,
                label: preset.name,
                ...(preset.description === undefined ? {} : { description: preset.description }),
              }))}
              disabled={disabled}
              onChange={next => { props.onDraftChange({ agentPresetId: next }) }}
            />
          )}
        />
        <SettingsRow
          label="权限预设"
          hint="只影响之后创建或恢复的会话；已打开的主会话保持原权限。"
          control={(
            <SelectControl
              ariaLabel="权限预设"
              value={draft.permissionPresetId}
              placeholder="没有可用权限预设"
              options={props.permissionPresets.map(preset => ({
                value: preset.value,
                label: PERMISSION_LABELS[preset.value] ?? preset.name,
              }))}
              disabled={disabled}
              onChange={next => { props.onDraftChange({ permissionPresetId: next }) }}
            />
          )}
        />
      </SettingsRows>
      <div className={css.assistantCreateReadonlyNote}>
        总协调（Coordinator）在侧栏行菜单设置，创建时不设。
      </div>
    </>
  )
}

/** Skills and MCP granted to the assistant: what it may reach for. */
function CapabilitiesSection(props: AssistantCreateBodyProps, disabled: boolean): JSX.Element {
  const { draft, capabilityError } = props
  const [query, setQuery] = useState('')
  return (
    <>
      <SectionHeading title="技能与MCP" hint="这个助手能用的技能与 MCP" />
      {/* One search over both groups, like the shipped plugin page. */}
      <label className={css.capabilitySearch}>
        <IconSearchOutlineRegular size={14} />
        <input
          type="search"
          value={query}
          aria-label="搜索技能与 MCP"
          placeholder="搜索技能与 MCP"
          disabled={disabled}
          onChange={event => { setQuery(event.target.value) }}
        />
      </label>
      <CapabilityPicker
        label={`技能（已选 ${draft.skillAllowlist.length} 个）`}
        icon={<IconSparkleRegular size={14} />}
        ariaLabel="选择助手可使用的 Skills"
        hint="运行时按任务需要加载具体 Skill 指令；一个都不选表示不开放 Skill。"
        emptyText="该 Agent Preset 没有可用的 Skill。"
        missingDetail="该 Agent Preset 不再提供这个 Skill，保存时不会带上"
        selected={draft.skillAllowlist}
        options={props.skills}
        loading={props.capabilitiesLoading}
        error={props.capabilitiesError}
        disabled={disabled}
        query={query}
        onChange={next => { props.onDraftChange({ skillAllowlist: next }) }}
      />
      <CapabilityPicker
        label={`MCP（已选 ${draft.mcpServers.length} 个）`}
        icon={<IconProjectAddOutlineRegular size={14} />}
        ariaLabel="选择助手可使用的 MCP Server"
        hint="MCP 连接与密钥由 Harness Profile/Preset 管理；一个都不选表示不开放 Server 工具。"
        emptyText="该 Agent Preset 没有可用的 MCP Server。"
        missingDetail="该 Agent Preset 不再提供这个 MCP Server，保存时不会带上"
        selected={draft.mcpServers}
        options={props.mcpServers}
        loading={props.capabilitiesLoading}
        error={props.capabilitiesError}
        disabled={disabled}
        query={query}
        onChange={next => { props.onDraftChange({ mcpServers: next }) }}
      />
      {capabilityError !== undefined && (
        <div className={css.inlineError} role="alert">读取模型能力失败：{capabilityError}</div>
      )}
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
    case 'model':
      return ModelSection(props, disabled)
    case 'capabilities':
      return CapabilitiesSection(props, disabled)
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
  onAddWorkspace,
}: {
  open: boolean
  onClose: () => void
  openSession: (sessionId: string) => void
  onCreated: () => Promise<void>
  onAddWorkspace?: () => Promise<{ id: string; title: string } | null>
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
  const capabilities = useCapabilityCatalog(draft.agentPresetId)
  // Only a read that succeeded can tell "this preset lost it" from "not read".
  const capabilitiesJudged = capabilities.loaded
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
    setDraft({ ...emptyAssistantCreateDraft(), mascotSeed: nextMascotSeed() })
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
        setDraft(current => ({ ...assistantCreateDefaults(value), mascotSeed: current.mascotSeed }))
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

  const addWorkspace = async (): Promise<{ id: string; title: string } | null> => {
    if (onAddWorkspace === undefined) return null
    const added = await onAddWorkspace()
    if (added !== null) setCatalogAttempt(current => current + 1)
    return added
  }

  if (!open) return null

  const workspaces = (catalog?.workspaces ?? [])
    .filter(workspace => workspace.status === 'ok')
    .map(workspace => ({ id: workspace.id, title: workspace.title }))
  const agentPresets = (catalog?.agentPresets ?? [])
    .filter(preset => preset.broken === undefined)
    .map(preset => ({
      id: preset.id,
      name: preset.name,
      ...(preset.description === undefined ? {} : { description: preset.description }),
    }))
  const permissionPresets = catalog?.permissionPresets ?? []
  const reasoningEfforts = modelCapabilities.value?.reasoning?.efforts ?? []
  const reasoningOptions = reasoningEfforts.map(effort => ({
    id: effort.id,
    label: effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`,
  }))
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
      name: modelEntry.name,
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
    // A row the catalog already lost stays visible in the picker but is not
    // sent: it would be refused, and the row says so. While the catalog is
    // unknown nothing can be judged, so the selection travels as it is.
    const payload = assistantCreatePayload(capabilitiesJudged
      ? {
          ...draft,
          skillAllowlist: savableNames(draft.skillAllowlist, capabilities.skills),
          mcpServers: savableNames(draft.mcpServers, capabilities.mcpServers),
        }
      : draft)
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
            `助手已创建，但分组未写入：${messageOf(cause)}。可在行菜单里稍后移动。`,
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
          activeSection={activeSection}
          draft={draft}
          roles={roles}
          roleError={roleError}
          groups={groups}
          onAddWorkspace={addWorkspace}
        workspaces={workspaces}
          modelGroups={modelGroups}
          reasoningOptions={reasoningOptions}
          defaultReasoning={defaultReasoningLabel(modelCapabilities.value)}
          capabilityError={modelCapabilities.error}
          skills={capabilities.skills}
          mcpServers={capabilities.mcpServers}
          capabilitiesLoading={capabilities.loading}
          capabilitiesError={capabilities.error}
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
