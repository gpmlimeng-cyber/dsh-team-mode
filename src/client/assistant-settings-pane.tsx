import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button,
  IconArchiveOutlineRegular,
  IconClockOutlineRegular,
  IconDatabaseOutlineRegular,
  IconFlatListOutlineRegular,
  IconInfoOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconProjectAddOutlineRegular,
  IconSearchOutlineRegular,
  IconShieldOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconSparkleRegular,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { assistantModelKey } from './assistant-form.js'
import { CapabilityList, savableNames, useCapabilityCatalog } from './assistant-capabilities.js'
import {
  assistantAvatarDataUrlError,
  assistantAvatarFileError,
  assistantInstanceName,
} from './assistant-instances.js'
import {
  AssistantDetailFacts,
  AutomationSection,
  HistorySection,
  PersonaSection,
  assistantDetailSections,
} from './assistant-detail.js'
import { AssistantMemorySection } from './assistant-memory-panel.js'
import { PERMISSION_LABELS } from './labels.js'
import { MemberAvatar } from './member-avatar.js'
import { Mascot, usePrefersReducedMotion } from './mascot-view.js'
import { MascotPicker } from './mascot-picker.js'
import {
  randomMascotDraft,
  type MascotBodyFill,
  type MascotEyes,
  type MascotMotion,
  type MascotShape,
  type MascotSpacing,
} from './mascot.js'
import { defaultReasoningLabel, useModelCapabilities } from './model-reasoning.js'
import { SelectControl } from './select-control.js'
import type { SelectControlOption } from './select-control.js'
import { SettingsRow, SettingsRows } from './settings-row.js'
import { FoldGroup } from './fold-group.js'
import { Field } from './shared.js'
import css from './AgentTeam.module.css'
import { isCoordinatorInstance } from '../domain/types.js'
import type {
  AssistantInstance,
  AssistantMemory,
  MemoryEntry,
  UpdateAssistantInstanceInput,
} from '../domain/types.js'
import type {
  AssistantInstanceView,
  CatalogView,
} from '../transport/contracts.js'

/**
 * The page type this plugin owns on the host's right Sidebar. `kind` is the
 * open string `openTab` dispatches on; `id` is also the key the body registers
 * under in `sidebar.right.pane.tab` (see the sidebar-right contract note
 * `docs/superpowers/notes/2026-10-26-sidebar-right.md`).
 */
export const DETAIL_TAB_KIND = 'team-mode'
export const DETAIL_TAB_ID = '@limeng/dsh-team-mode/detail'
export const DETAIL_TAB_TITLE = '助手设置'

/** Shown before any helper was opened through the row menu. */
export const DETAIL_EMPTY_TEXT = '从左侧选择一个助手'

/** Row menu → host listener. The menu never calls `openTab` itself. */
export const OPEN_ASSISTANT_SETTINGS_EVENT = 'dsh-team-mode:open-assistant-settings'

/**
 * The assistant a pane instance was opened for. It is module-level state on
 * purpose: the pane reads the one id that was passed with the open action, not
 * the sidebar's "currently selected" row, so an idle pane never follows the
 * list. `set` happens in the host listener right before `openTab`.
 */
export interface AssistantDetailTarget {
  getSnapshot(): string | undefined
  getServerSnapshot(): string | undefined
  subscribe(listener: () => void): () => void
  set(assistantId: string): void
}

function createAssistantDetailTarget(): AssistantDetailTarget {
  let assistantId: string | undefined
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => assistantId,
    getServerSnapshot: () => assistantId,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      if (next === assistantId) return
      assistantId = next
      for (const listener of listeners) listener()
    },
  }
}

export const assistantDetailTarget = createAssistantDetailTarget()

export type AssistantSettingGroupId =
  | 'overview'
  | 'identity'
  | 'model'
  | 'capabilities'
  | 'memory'
  | 'automations'
  | 'archive'
  | 'history'

export interface AssistantSettingGroup {
  id: AssistantSettingGroupId
  title: string
  /** The words the search matches this group on: its row labels and hints. */
  keywords: string
}

/**
 * The accordion, in the order the settings screenshot shows. 自动化 is kept as
 * its own group because dropping it would drop the Host's scheduled tasks from
 * the pane; everything else follows the screenshot.
 */
export const ASSISTANT_SETTING_GROUPS: readonly AssistantSettingGroup[] = [
  { id: 'overview', title: '概览', keywords: '概览 名称 状态 所属分组 会话 模板 workspace 总协调 创建时间' },
  { id: 'identity', title: '身份与形象', keywords: '身份 形象 头像 显示名称 名称 吉祥物 动画 人设 说明' },
  { id: 'model', title: '模型与权限', keywords: '模型 provider model 思考模式 推理强度 权限预设 权限' },
  { id: 'capabilities', title: '技能与MCP', keywords: '技能 skills mcp 工具 server' },
  { id: 'memory', title: '记忆', keywords: '记忆 条目 旧版 变更 日志 待确认' },
  { id: 'automations', title: '自动化', keywords: '自动化 定时 任务 提醒' },
  { id: 'archive', title: '归档', keywords: '归档 删除' },
  { id: 'history', title: '会话历史', keywords: '会话 历史 主会话 附加 归档会话' },
]

/** One search token matches a title or keyword list, case-insensitively. */
export function settingMatches(query: string, ...texts: Array<string | undefined>): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return true
  return texts.some(text => text !== undefined && text.toLocaleLowerCase().includes(needle))
}

/** The groups a search leaves visible; empty means the pane shows its empty state. */
export function visibleSettingGroups(
  query: string,
  groups: readonly AssistantSettingGroup[] = ASSISTANT_SETTING_GROUPS,
): AssistantSettingGroupId[] {
  return groups
    .filter(group => settingMatches(query, group.title, group.keywords))
    .map(group => group.id)
}

const GROUP_ICONS: Record<AssistantSettingGroupId, JSX.Element> = {
  overview: <IconInfoOutlineRegular size={14} />,
  identity: <IconPersonalizationOutlineRegular size={14} />,
  model: <IconSlidersTwoOutlineRegular size={14} />,
  capabilities: <IconSparkleRegular size={14} />,
  memory: <IconDatabaseOutlineRegular size={14} />,
  automations: <IconClockOutlineRegular size={14} />,
  archive: <IconArchiveOutlineRegular size={14} />,
  history: <IconFlatListOutlineRegular size={14} />,
}

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
 * One assistant's settings, as an accordion: a search field over every group,
 * the groups themselves, and one sticky save bar. There is deliberately no
 * modal and no second copy of the fields — this *is* 助手设置.
 */
export function AssistantSettingsPane({
  assistant,
  expanded,
  onSaved,
}: {
  assistant: AssistantInstanceView
  expanded?: boolean | undefined
  onSaved: () => Promise<void> | void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Partial<Record<AssistantSettingGroupId, boolean>>>({
    overview: true,
  })
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
  const [selectedSkills, setSelectedSkills] = useState<string[]>([...assistant.assistantSnapshot.skillAllowlist])
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([...assistant.assistantSnapshot.mcpServers])
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState<string>()
  const [mascotSeed, setMascotSeed] = useState(assistant.mascot?.seed ?? assistant.id)
  const [mascotShape, setMascotShape] = useState(assistant.mascot?.shape ?? '')
  const [mascotEyes, setMascotEyes] = useState(assistant.mascot?.eyes ?? '')
  const [mascotSpacing, setMascotSpacing] = useState(assistant.mascot?.spacing ?? '')
  const [mascotColor, setMascotColor] = useState(assistant.mascot?.color ?? '')
  const [mascotFill, setMascotFill] = useState<MascotBodyFill>(assistant.mascot?.fill ?? 'solid')
  const [mascotAnimated, setMascotAnimated] = useState(true)
  const [mascotMotion, setMascotMotion] = useState<MascotMotion>('idle')
  const [mascotMotionKey, setMascotMotionKey] = useState(0)
  const reducedMotion = usePrefersReducedMotion()
  const paneRef = useRef<HTMLDivElement>(null)

  const busy = saving || archiving
  const modelCapabilities = useModelCapabilities(provider, model)
  // The Agent Preset is fixed at creation, so this catalog never changes for
  // one instance: whatever it lists is exactly what a save may carry.
  const capabilities = useCapabilityCatalog(assistant.assistantSnapshot.agentPresetId)

  // Refresh the editable draft whenever the pane is pointed at another helper.
  // Keyed by id: a list refresh for the same helper must not overwrite typing.
  useEffect(() => {
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
    setSelectedSkills([...assistant.assistantSnapshot.skillAllowlist])
    setSelectedMcpServers([...assistant.assistantSnapshot.mcpServers])
    setConfirmArchive(false)
    setSaving(false)
    setArchiving(false)
    setSaved(false)
    setError(undefined)
    setMascotSeed(assistant.mascot?.seed ?? assistant.id)
    setMascotShape(assistant.mascot?.shape ?? '')
    setMascotEyes(assistant.mascot?.eyes ?? '')
    setMascotSpacing(assistant.mascot?.spacing ?? '')
    setMascotColor(assistant.mascot?.color ?? '')
    setMascotFill(assistant.mascot?.fill ?? 'solid')
    setMascotAnimated(true)
    setMascotMotion('idle')
    setMascotMotionKey(0)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on identity, not on every list refresh
  }, [assistant.id])

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
      setSaved(false)
    }
    reader.onerror = () => { setError('读取头像失败，请重试') }
    reader.readAsDataURL(file)
  }

  function clearAvatar(): void {
    setAvatar('')
    setAvatarChanged(true)
    setError(undefined)
    setSaved(false)
  }

  async function save(): Promise<void> {
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
    // Only a successful catalog read can say a stored reference is gone; the
    // picker shows such a row as unavailable, and it is not written back.
    if (capabilities.loaded) {
      const nextSkills = savableNames(selectedSkills, capabilities.skills)
      if (JSON.stringify(nextSkills) !== JSON.stringify(snapshot.skillAllowlist)) {
        value.skillAllowlist = nextSkills
      }
      const nextMcpServers = savableNames(selectedMcpServers, capabilities.mcpServers)
      if (JSON.stringify(nextMcpServers) !== JSON.stringify(snapshot.mcpServers)) {
        value.mcpServers = nextMcpServers
      }
    }
    const nextMascot = {
      seed: mascotSeed.trim() === '' ? assistant.id : mascotSeed.trim(),
      ...(mascotShape === '' ? {} : { shape: mascotShape }),
      ...(mascotEyes === '' ? {} : { eyes: mascotEyes }),
      ...(mascotSpacing === '' ? {} : { spacing: mascotSpacing }),
      ...(mascotColor === '' ? {} : { color: mascotColor }),
      ...(mascotFill === 'radial' ? { fill: 'radial' as const } : {}),
    }
    if (JSON.stringify(nextMascot) !== JSON.stringify(assistant.mascot)) value.mascot = nextMascot
    setSaving(true)
    setError(undefined)
    setSaved(false)
    try {
      await callAgentTeam('assistant.instance.update', { id: assistant.id, value })
      setSaved(true)
      setMascotMotion('success')
      setMascotMotionKey(key => key + 1)
      await onSaved()
    } catch (cause) {
      setError(`保存失败：${messageOf(cause)}`)
      setMascotMotion('failure')
      setMascotMotionKey(key => key + 1)
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
  const modelSelection = assistantModelKey(provider, model)
  const modelSelectionInCatalog = modelGroups.some(group => (
    group.provider.id === provider && group.models.some(modelEntry => modelEntry.id === model)
  ))
  // A stored value the catalog dropped stays selectable and labelled 「当前」,
  // so the pill never hides what is saved on the instance.
  const modelOptions: SelectControlOption[] = [
    ...(modelSelectionInCatalog
      ? []
      : [{ value: modelSelection, label: `${provider} / ${model}（当前）` }]),
    ...modelGroups.flatMap(group => group.models.map(modelEntry => ({
      value: assistantModelKey(group.provider.id, modelEntry.id),
      label: modelEntry.name === modelEntry.id
        ? modelEntry.id
        : `${modelEntry.name}（${modelEntry.id}）`,
      group: group.provider.name,
    }))),
  ]
  const permissionOptions = catalog?.permissionPresets ?? []
  const permissionInCatalog = permissionOptions.some(option => option.value === permissionPresetId)
  const permissionSelectOptions: SelectControlOption[] = [
    ...(permissionInCatalog
      ? []
      : [{
          value: permissionPresetId,
          label: `${PERMISSION_LABELS[permissionPresetId] ?? permissionPresetId}（当前）`,
        }]),
    ...permissionOptions.map(option => ({
      value: option.value,
      label: PERMISSION_LABELS[option.value] ?? option.name,
    })),
  ]
  const reasoningEfforts = modelCapabilities.value?.reasoning?.efforts ?? []
  const mascotOptions = {
    ...(mascotShape === '' ? {} : { shapeVariant: mascotShape as MascotShape }),
    ...(mascotEyes === '' ? {} : { eyesVariant: mascotEyes as MascotEyes }),
    ...(mascotSpacing === '' ? {} : { spacingVariant: mascotSpacing as MascotSpacing }),
    ...(mascotColor === '' ? {} : { bodyColor: mascotColor }),
    bodyColorFill: mascotFill,
  }

  const searching = query.trim() !== ''
  const visible = visibleSettingGroups(query)
  const shows = (...texts: Array<string | undefined>): boolean => settingMatches(query, ...texts)
  const isVisible = (id: AssistantSettingGroupId): boolean => visible.includes(id)
  // While searching, every hit opens and everything else is gone; otherwise the
  // pane keeps the user's own open/closed choice.
  const isOpen = (id: AssistantSettingGroupId): boolean => (
    searching ? isVisible(id) : openGroups[id] === true
  )
  const toggle = (id: AssistantSettingGroupId, open: boolean): void => {
    if (searching) return
    setOpenGroups(current => ({ ...current, [id]: open }))
  }

  return (
    <div
      className={css.assistantDetail}
      data-dsh-assistant-detail
      data-expanded={expanded}
      ref={paneRef}
    >
      <label className={css.settingsSearch}>
        <IconSearchOutlineRegular size={14} />
        <input
          type="search"
          value={query}
          aria-label="搜索设置"
          placeholder="搜索设置"
          onChange={event => { setQuery(event.target.value) }}
        />
      </label>
      {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
      {catalogError !== undefined && <div className={css.inlineError} role="alert">{catalogError}</div>}
      {visible.length === 0 && (
        <p className={css.assistantDetailHint} role="status">
          {`没有匹配「${query.trim()}」的设置`}
        </p>
      )}

      {isVisible('overview') && (
        <FoldGroup
          icon={GROUP_ICONS.overview}
          title="概览"
          open={isOpen('overview')}
          onToggle={open => { toggle('overview', open) }}
          dataKind="overview"
        >
          <AssistantDetailFacts section={assistantDetailSections(assistant)[0]!} />
          <dl className={css.assistantDetailFacts}>
            {shows('助手模板') && (
              <div className={css.assistantDetailFact}>
                <dt className={css.assistantDetailFactLabel}>助手模板</dt>
                <dd className={css.assistantDetailFactValue} title={assistant.templateId}>{templateLabel}</dd>
              </div>
            )}
            {shows('Workspace') && (
              <div className={css.assistantDetailFact}>
                <dt className={css.assistantDetailFactLabel}>Workspace</dt>
                <dd className={css.assistantDetailFactValue} title={assistant.workspacePath}>{workspaceLabel}</dd>
              </div>
            )}
            {shows('总协调') && (
              <div className={css.assistantDetailFact}>
                <dt className={css.assistantDetailFactLabel}>总协调</dt>
                <dd
                  className={css.assistantDetailFactValue}
                  data-dsh-assistant-settings-coordinator={String(isCoordinatorInstance(assistant))}
                >
                  {isCoordinatorInstance(assistant) ? '是' : '否'}
                </dd>
              </div>
            )}
            {shows('状态') && (
              <div className={css.assistantDetailFact}>
                <dt className={css.assistantDetailFactLabel}>状态</dt>
                <dd
                  className={css.assistantDetailFactValue}
                  data-dsh-assistant-settings-status={assistant.status}
                >
                  {STATUS_LABELS[assistant.status]}
                </dd>
              </div>
            )}
            {shows('创建时间') && (
              <div className={css.assistantDetailFact}>
                <dt className={css.assistantDetailFactLabel}>创建时间</dt>
                <dd className={css.assistantDetailFactValue}>{formatCreatedAt(assistant.createdAt)}</dd>
              </div>
            )}
          </dl>
        </FoldGroup>
      )}

      {isVisible('identity') && (
        <FoldGroup
          icon={GROUP_ICONS.identity}
          title="身份与形象"
          open={isOpen('identity')}
          onToggle={open => { toggle('identity', open) }}
          dataKind="identity"
        >
          <SettingsRows>
            {shows('头像') && (
              <SettingsRow
                label="头像"
                hint="支持 PNG、JPEG、WebP，最大 256KB；清空后显示吉祥物。"
                control={(
                  <>
                    <MemberAvatar name={displayName} avatar={avatar} size={32} />
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
                        清除
                      </Button>
                    )}
                  </>
                )}
              />
            )}
            {shows('显示名称') && (
              <SettingsRow
                label="显示名称"
                hint="显示在侧栏和会话里，必填。"
                control={(
                  <input
                    className={css.input}
                    value={name}
                    disabled={busy}
                    placeholder="助手名称"
                    aria-label="显示名称"
                    onChange={event => { setName(event.target.value); setSaved(false) }}
                  />
                )}
              />
            )}
          </SettingsRows>
          <div className={css.assistantMascotSection} data-dsh-assistant-mascot>
            <div className={css.assistantMascotPreview}>
              <Mascot
                seed={mascotSeed}
                options={mascotOptions}
                size={52}
                avatarShape="rounded"
                motion={mascotMotion}
                motionKey={mascotMotionKey}
                animated={mascotAnimated}
              />
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => {
                  const next = randomMascotDraft()
                  setMascotSeed(next.seed)
                  setMascotShape(next.shape)
                  setMascotEyes(next.eyes)
                  setMascotColor(next.color)
                }}
              >
                随机
              </Button>
            </div>
            <div className={css.assistantMascotFields}>
              <span className={css.assistantSettingsAvatarTitle}>吉祥物</span>
              <span className={css.assistantSettingsAvatarHint}>
                没有上传头像时显示；同一个种子永远是同一只。
              </span>
              <MascotPicker
                seed={mascotSeed}
                value={mascotOptions}
                disabled={busy}
                onChange={next => {
                  setMascotShape(next.shapeVariant ?? '')
                  setMascotEyes(next.eyesVariant ?? '')
                  setMascotColor(next.bodyColor ?? '')
                  setMascotFill(next.bodyColorFill ?? 'solid')
                }}
              />
              <div className={css.assistantMascotToggle}>
                <span>{reducedMotion ? '动画（系统已要求减少动效）' : '动画'}</span>
                <Switch
                  label="动画"
                  checked={mascotAnimated && !reducedMotion}
                  disabled={busy || reducedMotion}
                  onChange={next => { setMascotAnimated(next) }}
                />
              </div>
            </div>
          </div>
          <div className={css.assistantDetailBody} data-dsh-assistant-detail-section="persona">
            <PersonaSection instance={assistant} onSaved={() => { void onSaved() }} />
          </div>
        </FoldGroup>
      )}

      {isVisible('model') && (
        <FoldGroup
          icon={GROUP_ICONS.model}
          title="模型与权限"
          open={isOpen('model')}
          onToggle={open => { toggle('model', open) }}
          dataKind="model"
        >
          <SettingsRows>
            {shows('模型') && (
              <SettingsRow
                label="模型"
                hint={catalogLoading
                  ? '正在读取模型列表…'
                  : '按 Provider 分组；保存时同时写入 Provider 与模型。'}
                control={(
                  <SelectControl
                    ariaLabel="模型"
                    value={modelSelection}
                    options={modelOptions}
                    disabled={busy || catalog === undefined}
                    onChange={next => {
                      const [nextProvider, nextModel] = next.split('/') as [string, string]
                      setProvider(nextProvider)
                      setModel(nextModel)
                      setError(undefined)
                      setSaved(false)
                    }}
                  />
                )}
              />
            )}
            {reasoningEfforts.length > 0 && shows('思考模式') && (
              <SettingsRow
                label="思考模式"
                hint="由当前模型决定可用档位；选择「模型默认」会清除已保存的档位。"
                control={(
                  <SelectControl
                    ariaLabel="思考模式"
                    value={reasoningEffort}
                    options={[
                      { value: '', label: defaultReasoningLabel(modelCapabilities.value) },
                      ...reasoningEfforts.map(effort => ({
                        value: effort.id,
                        label: effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`,
                      })),
                    ]}
                    disabled={busy}
                    onChange={next => { setReasoningEffort(next); setSaved(false) }}
                  />
                )}
              />
            )}
            {shows('权限预设') && (
              <SettingsRow
                label="权限预设"
                hint="权限只影响之后创建或恢复的会话；已打开的主会话保持原权限。"
                control={(
                  <SelectControl
                    ariaLabel="权限预设"
                    value={permissionPresetId}
                    options={permissionSelectOptions}
                    disabled={busy || catalog === undefined}
                    onChange={next => {
                      setPermissionPresetId(next)
                      setError(undefined)
                      setSaved(false)
                    }}
                  />
                )}
              />
            )}
          </SettingsRows>
          {modelCapabilities.error !== undefined && (
            <div className={css.inlineError} role="alert">
              读取模型能力失败：{modelCapabilities.error}
            </div>
          )}
        </FoldGroup>
      )}

      {isVisible('capabilities') && (
        <FoldGroup
          icon={GROUP_ICONS.capabilities}
          title="技能与MCP"
          meta={`已选 ${selectedSkills.length + selectedMcpServers.length} 项`}
          open={isOpen('capabilities')}
          onToggle={open => { toggle('capabilities', open) }}
          dataKind="capabilities"
        >
          <div className={css.assistantDetailBody}>
            <strong className={css.settingsRowLabel}>技能</strong>
            <CapabilityList
              ariaLabel="选择助手可使用的 Skills"
              icon={<IconSparkleRegular size={14} />}
              emptyText="该 Agent Preset 没有可用的 Skill。"
              missingDetail="该 Agent Preset 不再提供这个 Skill，保存时不会带上"
              selected={selectedSkills}
              options={capabilities.skills}
              loading={capabilities.loading}
              error={capabilities.error}
              disabled={busy}
              query={query}
              onChange={next => {
                setSelectedSkills(next)
                setError(undefined)
                setSaved(false)
              }}
            />
            <strong className={css.settingsRowLabel}>MCP</strong>
            <CapabilityList
              ariaLabel="选择助手可使用的 MCP Server"
              icon={<IconProjectAddOutlineRegular size={14} />}
              emptyText="该 Agent Preset 没有可用的 MCP Server。"
              missingDetail="该 Agent Preset 不再提供这个 MCP Server，保存时不会带上"
              selected={selectedMcpServers}
              options={capabilities.mcpServers}
              loading={capabilities.loading}
              error={capabilities.error}
              disabled={busy}
              query={query}
              onChange={next => {
                setSelectedMcpServers(next)
                setError(undefined)
                setSaved(false)
              }}
            />
          </div>
        </FoldGroup>
      )}

      {isVisible('memory') && (
        <FoldGroup
          icon={GROUP_ICONS.memory}
          title="记忆"
          open={isOpen('memory')}
          onToggle={open => { toggle('memory', open) }}
          dataKind="memory"
        >
          <AssistantMemorySection assistantId={assistant.id} />
        </FoldGroup>
      )}

      {isVisible('automations') && (
        <FoldGroup
          icon={GROUP_ICONS.automations}
          title="自动化"
          open={isOpen('automations')}
          onToggle={open => { toggle('automations', open) }}
          dataKind="automations"
        >
          <AutomationSection instance={assistant} />
        </FoldGroup>
      )}

      {isVisible('archive') && (
        <FoldGroup
          icon={GROUP_ICONS.archive}
          title="归档"
          open={isOpen('archive')}
          onToggle={open => { toggle('archive', open) }}
          dataKind="archive"
        >
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
        </FoldGroup>
      )}

      {isVisible('history') && (
        <FoldGroup
          icon={GROUP_ICONS.history}
          title="会话历史"
          open={isOpen('history')}
          onToggle={open => { toggle('history', open) }}
          dataKind="history"
        >
          <HistorySection instance={assistant} onChanged={() => { void onSaved() }} />
        </FoldGroup>
      )}

      {/* One save bar for the staged fields; memory/persona/history write on
          their own buttons and never ride this save. */}
      <div className={css.settingsSaveBar}>
        {saved && <span className={css.assistantDetailNotice} role="status">已保存</span>}
        <span className={css.settingsSaveHint}>
          已打开的主会话沿用旧模型，直到重新创建或恢复。
        </span>
        <Button variant="primary" type="button" disabled={busy} onClick={() => { void save() }}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}

interface InstancesState {
  instances: AssistantInstanceView[]
  loading: boolean
  error?: string
}

/** Read the one row this pane shows through the existing list transport. */
function useAssistantInstances(enabled: boolean): InstancesState & { refresh: () => void } {
  const [state, setState] = useState<InstancesState>({ instances: [], loading: enabled })
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => { setNonce(value => value + 1) }, [])
  useEffect(() => {
    if (!enabled) {
      setState({ instances: [], loading: false })
      return
    }
    let live = true
    const read = (): void => {
      void callAgentTeam('assistant.instance.list').then(
        value => { if (live) setState({ instances: value.items, loading: false }) },
        cause => {
          if (!live) return
          setState({
            instances: [],
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        },
      )
    }
    setState({ instances: [], loading: true })
    read()
    const unsubscribe = subscribeAgentTeam(read, () => {}, read)
    return () => {
      live = false
      unsubscribe()
    }
  }, [enabled, nonce])
  return { ...state, refresh }
}

/**
 * The pane body. The identity it shows comes from the open action's module
 * state (injected by the host registration), never from the sidebar's current
 * selection, so opening helper B then A leaves no stale row behind.
 */
export function AssistantDetailBody(
  props: PropsRuntime<'sidebar.right.pane.tab'>,
): JSX.Element {
  const { useTabInfo } = props
  const { sidebar } = useTabInfo()
  const state = (props as unknown as { state: AssistantDetailTarget }).state
  const assistantId = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getServerSnapshot)
  const { instances, loading, error, refresh } = useAssistantInstances(assistantId !== undefined)
  const instance = instances.find(candidate => candidate.id === assistantId)
  const notice = error !== undefined
    ? `助手数据加载失败：${error}`
    : loading
      ? '正在加载助手…'
      : DETAIL_EMPTY_TEXT
  return (
    <AssistantDetailPanel
      {...(instance === undefined ? {} : { instance })}
      notice={instance === undefined ? notice : undefined}
      expanded={sidebar.expanded}
      onRefresh={refresh}
    />
  )
}

/** The pane shell: the empty instruction, or the settings of the open helper. */
export function AssistantDetailPanel({
  instance,
  notice,
  expanded,
  onRefresh,
}: {
  instance?: AssistantInstanceView | undefined
  notice?: string | undefined
  expanded?: boolean | undefined
  onRefresh?: (() => void) | undefined
}): JSX.Element {
  if (instance === undefined) {
    return (
      <div
        className={css.assistantDetail}
        data-dsh-assistant-detail
        data-dsh-assistant-detail-empty
        data-expanded={expanded}
      >
        <p className={css.assistantDetailEmpty} role="status">{notice ?? DETAIL_EMPTY_TEXT}</p>
      </div>
    )
  }
  return (
    <AssistantSettingsPane
      key={instance.id}
      assistant={instance}
      expanded={expanded}
      onSaved={() => { onRefresh?.() }}
    />
  )
}

/** The services the host listener needs; the host's face, narrowed to two reads. */
export interface DetailSidebar {
  mounted: { getSnapshot(): string | undefined }
  openTab(kind: string): void
}

/**
 * Point the pane at one helper and open its tab — the host side of the row
 * menu's event. Every write throws while no Session surface is mounted, so the
 * mounted guard runs first and the caller can report the refusal.
 */
export function applyAssistantDetail(
  sidebar: DetailSidebar | undefined,
  assistantId: string,
): boolean {
  assistantDetailTarget.set(assistantId)
  if (sidebar === undefined || sidebar.mounted.getSnapshot() === undefined) return false
  try {
    sidebar.openTab(DETAIL_TAB_KIND)
    return true
  } catch {
    return false
  }
}

/**
 * The row menu's half: publish the target, let the host listener own the layout
 * write. No service handle travels through the component tree.
 */
export function openAssistantDetail(assistantId: string): void {
  assistantDetailTarget.set(assistantId)
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_SETTINGS_EVENT, {
    detail: { assistantId },
  }))
}
