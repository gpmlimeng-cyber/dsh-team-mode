import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button,
  IconArchiveOutlineRegular,
  IconClockOutlineRegular,
  IconDatabaseOutlineRegular,
  IconEditOutlineRegular,
  IconFlatListOutlineRegular,
  IconInfoOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconProjectAddOutlineRegular,
  IconSearchOutlineRegular,
  IconShieldOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconSparkleRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { CapabilityList, savableNames, useCapabilityCatalog } from './assistant-capabilities.js'
import {
  AssistantAvatarEditor,
  AVATAR_EDITOR_ID,
  avatarDraftFromInstance,
  avatarDraftReset,
  type AvatarDraft,
} from './assistant-avatar-editor.js'
import {
  assistantAvatarDataUrlError,
  assistantInstanceName,
} from './assistant-instances.js'
import {
  AutomationSection,
  HistorySection,
  PersonaSection,
  assistantAutomationCount,
} from './assistant-detail.js'
import { ASSISTANT_MEMORY_CHANGED_EVENT, AssistantMemorySection } from './assistant-memory-panel.js'
import {
  assistantMemoryCountLine,
  assistantOverviewLimits,
  assistantOverviewTodos,
  assistantOverviewWho,
  type AssistantOverviewCounts,
  type AssistantOverviewTodo,
} from './assistant-overview.js'
import { PERMISSION_LABELS, assistantMemoryView } from './labels.js'
import { MemberAvatar } from './member-avatar.js'
import { Mascot } from './mascot-view.js'
import type { MascotMotion } from './mascot.js'
import { useModelCapabilities } from './model-reasoning.js'
import {
  ModelControl,
  modelControlReasoning,
  modelControlTrigger,
  type ModelControlModel,
} from './model-control.js'
import { SelectControl } from './select-control.js'
import type { SelectControlOption } from './select-control.js'
import { SettingsRow, SettingsRows } from './settings-row.js'
import { FoldGroup } from './fold-group.js'
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
  { id: 'overview', title: '概览', keywords: '概览 待办 待办清单 它是什么 能力边界 描述 模板 workspace 权限' },
  { id: 'identity', title: '身份与形象', keywords: '身份 形象 头像 显示名称 名称 人设 说明' },
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

/**
 * M1: the memory count row of 概览 — `记忆 · N 条 · 管理 →`, or
 * `记忆 · 还没有记录` when it remembers nothing. The pane is one accordion, so
 * "management" here is the group itself: `onManage` is the existing overview
 * jump, which clears the search and opens + scrolls to 记忆.
 */
export function AssistantOverviewMemoryRow({
  count,
  onManage,
}: {
  count: number
  onManage: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={css.assistantOverviewTodo}
      data-dsh-memory-count={count}
      onClick={onManage}
    >
      <span className={css.assistantOverviewTodoText}>{assistantMemoryCountLine(count)}</span>
    </button>
  )
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
  // The avatar, its mascot options and its seed are one draft; the floating
  // editor stages it and 保存 writes it.
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>(() => avatarDraftFromInstance(assistant))
  const [avatarEditing, setAvatarEditing] = useState(false)
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
  const [mascotMotion, setMascotMotion] = useState<MascotMotion>('idle')
  const [mascotMotionKey, setMascotMotionKey] = useState(0)
  const [overviewCounts, setOverviewCounts] = useState<AssistantOverviewCounts>({})
  // M1's number: the assistant-scoped entries assistant.memory.get answered
  // with. It stays `undefined` until that read lands, so the count row never
  // claims "还没有记录" for a read that has not happened.
  const [memoryEntryCount, setMemoryEntryCount] = useState<number>()
  // Bumped by the 记忆 block after each of its writes; it re-runs the one read
  // above so the count row never lags behind an edit made in this same pane.
  const [memoryReadNonce, setMemoryReadNonce] = useState(0)
  const paneRef = useRef<HTMLDivElement>(null)
  // The Session list selects this assistant's automations; it is also the key
  // that makes the 概览 count re-read when a thread is added or removed.
  const overviewSessionKey = [assistant.mainSessionId ?? '', ...(assistant.threadSessionIds ?? [])].join('\u0000')

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
    setAvatarDraft(avatarDraftFromInstance(assistant))
    setAvatarEditing(false)
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

  // 概览 asks two questions the instance row cannot answer. Both reads degrade to
  // `undefined`, which the report treats as "nothing to claim", never as "none".
  useEffect(() => {
    let live = true
    setOverviewCounts({})
    setMemoryEntryCount(undefined)
    void assistantAutomationCount(assistant).then(count => {
      if (live && count !== undefined) {
        setOverviewCounts(current => ({ ...current, automations: count }))
      }
    })
    void callAgentTeam('assistant.memory.get', { assistantId: assistant.id }).then(
      value => {
        if (!live) return
        const view = assistantMemoryView(value.memory)
        // The assistant-scoped entries the read answered with: exactly the rows
        // the 记忆 block lists, so its count row and the block never disagree.
        const entries = view.active.length + view.proposed.length + view.historyTotal
        setMemoryEntryCount(entries)
        // Any stored entry — even an archived one, or a legacy note — means it
        // does remember something, so the count only ever answers zero vs not.
        setOverviewCounts(current => ({
          ...current,
          memory: view.empty ? 0 : Math.max(1, entries),
        }))
      },
      () => {
        // The 记忆 group reports its own read failure; 概览 just stays silent.
      },
    )
    return () => { live = false }
  }, [assistant.id, overviewSessionKey, memoryReadNonce])

  // M1: a write inside the 记忆 block announces itself, because only this
  // count row lives outside the block and would otherwise keep the old N.
  useEffect(() => {
    const onChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{ assistantId?: string } | undefined>).detail
      if (detail?.assistantId === assistant.id) setMemoryReadNonce(value => value + 1)
    }
    window.addEventListener(ASSISTANT_MEMORY_CHANGED_EVENT, onChanged)
    return () => { window.removeEventListener(ASSISTANT_MEMORY_CHANGED_EVENT, onChanged) }
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

  const closeAvatarEditor = useCallback((): void => { setAvatarEditing(false) }, [])

  /** Stage one avatar edit; the 保存 bar still owns writing it. */
  function stageAvatar(update: (draft: AvatarDraft) => AvatarDraft): void {
    setAvatarDraft(update)
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
    const avatarError = assistantAvatarDataUrlError(avatarDraft.avatar)
    if (avatarError !== undefined) {
      setError(avatarError)
      return
    }
    const snapshot = assistant.assistantSnapshot
    const value: UpdateAssistantInstanceInput = { name: displayName }
    if (avatarDraft.avatar !== (snapshot.avatar ?? '')) value.avatar = avatarDraft.avatar
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
      seed: avatarDraft.seed.trim() === '' ? assistant.id : avatarDraft.seed.trim(),
      ...(avatarDraft.mascot.shapeVariant === undefined ? {} : { shape: avatarDraft.mascot.shapeVariant }),
      ...(avatarDraft.mascot.eyesVariant === undefined ? {} : { eyes: avatarDraft.mascot.eyesVariant }),
      ...(avatarDraft.mascot.spacingVariant === undefined ? {} : { spacing: avatarDraft.mascot.spacingVariant }),
      ...(avatarDraft.mascot.bodyColor === undefined ? {} : { color: avatarDraft.mascot.bodyColor }),
      ...(avatarDraft.mascot.bodyColorFill === 'radial' ? { fill: 'radial' as const } : {}),
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
    : workspaceTitle
  // 概览 reports the saved state, not the form draft: only 保存 changes it.
  const savedPermissionId = assistant.assistantSnapshot.permissionPresetId
  const permissionLabel = PERMISSION_LABELS[savedPermissionId]
    ?? catalog?.permissionPresets.find(option => option.value === savedPermissionId)?.name
    ?? savedPermissionId
  const modelGroups = (catalog?.providers ?? []).map(providerEntry => ({
    provider: providerEntry,
    models: catalog?.models[providerEntry.id] ?? [],
  })).filter(group => group.models.length > 0)
  const modelSelectionInCatalog = modelGroups.some(group => (
    group.provider.id === provider && group.models.some(modelEntry => modelEntry.id === model)
  ))
  // The merged model/level control reads one flat row list. A stored model the
  // catalog dropped stays in it, so the menu never hides what is saved.
  const modelControlModels: ModelControlModel[] = [
    ...modelGroups.flatMap(group => group.models.map(modelEntry => ({
      providerId: group.provider.id,
      providerName: group.provider.name,
      modelId: modelEntry.id,
      label: modelEntry.name,
    }))),
    ...(modelSelectionInCatalog || model === ''
      ? []
      : [{ providerId: provider, providerName: provider, modelId: model, label: model }]),
  ]
  const modelControlHint = modelControlTrigger(
    provider,
    model,
    modelControlModels,
    modelControlReasoning(modelCapabilities.value),
    reasoningEffort,
  )
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
  // 概览: a checklist, what this assistant is, and where its limits really are.
  // The component only maps these three pure results.
  const overviewLabels = {
    template: templateLabel,
    workspace: workspaceLabel,
    permission: permissionLabel,
  }
  const overviewTodos: AssistantOverviewTodo[] = assistantOverviewTodos(assistant, overviewCounts)
  const overviewWho = assistantOverviewWho(assistant, overviewLabels)
  const overviewLimits = assistantOverviewLimits(assistant, { ...overviewCounts, ...overviewLabels })
  const jumpToOverviewTarget = (target: AssistantOverviewTodo['target']): void => {
    // Searching hides every group the query does not match; clearing it is what
    // keeps the target the user just asked for reachable.
    setQuery('')
    setOpenGroups(current => ({ ...current, [target]: true }))
    requestAnimationFrame(() => {
      paneRef.current?.querySelector(`[data-dsh-fold="${target}"]`)?.scrollIntoView({ block: 'start' })
    })
  }
  // The subtitle names what the assistant is: its group, role and status.
  const avatarSubtitle = [
    assistant.group,
    isCoordinatorInstance(assistant) ? '总协调' : undefined,
    STATUS_LABELS[assistant.status],
  ].filter((part): part is string => part !== undefined && part !== '').join(' · ')

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
      {/* Only the avatar shows; the pencil at its corner floats the editor. */}
      <div className={css.assistantAvatarHero} data-dsh-assistant-avatar-hero>
        <div className={css.assistantAvatarAnchor}>
          <button
            type="button"
            className={css.assistantAvatarTrigger}
            data-dsh-avatar-trigger
            aria-label="编辑头像"
            aria-expanded={avatarEditing}
            aria-controls={avatarEditing ? AVATAR_EDITOR_ID : undefined}
            onClick={() => { setAvatarEditing(open => !open) }}
          >
            {avatarDraft.avatar === ''
              ? (
                <Mascot
                  seed={avatarDraft.seed}
                  options={avatarDraft.mascot}
                  size={64}
                  avatarShape="rounded"
                  motion={mascotMotion}
                  motionKey={mascotMotionKey}
                />
              )
              : <MemberAvatar name={displayName} avatar={avatarDraft.avatar} size={64} />}
            <span className={css.assistantAvatarBadge} aria-hidden="true">
              <IconEditOutlineRegular size={12} />
            </span>
          </button>
        </div>
        <div className={css.assistantAvatarWho}>
          <span className={css.assistantAvatarName}>{displayName}</span>
          <span className={css.assistantAvatarSub}>{avatarSubtitle}</span>
        </div>
        {avatarEditing && (
          <AssistantAvatarEditor
            draft={avatarDraft}
            disabled={busy}
            onDraftChange={stageAvatar}
            onReset={() => { stageAvatar(() => avatarDraftReset(assistant.id)) }}
            onClose={closeAvatarEditor}
          />
        )}
      </div>
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
          <div className={css.assistantOverview} data-dsh-assistant-overview>
            {/* M1: the memory count and its one-step way in. It appears only
                once the read answered — an unread count makes no claim. */}
            {memoryEntryCount !== undefined && (
              <AssistantOverviewMemoryRow
                count={memoryEntryCount}
                onManage={() => { jumpToOverviewTarget('memory') }}
              />
            )}
            {/* A checklist, not a score: nothing is rendered once nothing is missing. */}
            {overviewTodos.length > 0 && (
              <section
                className={css.assistantOverviewSection}
                aria-label="待办清单"
                data-dsh-assistant-overview-todos
              >
                <span className={css.assistantOverviewTitle}>待办清单</span>
                <ul className={css.assistantOverviewTodos}>
                  {overviewTodos.map(todo => (
                    <li key={todo.id}>
                      <button
                        type="button"
                        className={css.assistantOverviewTodo}
                        data-dsh-assistant-overview-todo={todo.id}
                        onClick={() => { jumpToOverviewTarget(todo.target) }}
                      >
                        <span className={css.assistantOverviewTodoText}>{todo.text}</span>
                        <span className={css.assistantOverviewArrow} aria-hidden="true">→</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section
              className={css.assistantOverviewSection}
              aria-label="它是什么"
              data-dsh-assistant-overview-who
            >
              <span className={css.assistantOverviewTitle}>它是什么</span>
              <div className={css.assistantOverviewWho}>
                {avatarDraft.avatar === ''
                  ? (
                    <Mascot
                      seed={avatarDraft.seed}
                      options={avatarDraft.mascot}
                      size={24}
                      avatarShape="rounded"
                      motion="idle"
                    />
                  )
                  : <MemberAvatar name={overviewWho.name} avatar={avatarDraft.avatar} size={24} />}
                <span className={css.assistantOverviewWhoName}>{overviewWho.name}</span>
              </div>
              {overviewWho.description === ''
                ? (
                  <button
                    type="button"
                    className={css.assistantOverviewDescriptionEmpty}
                    data-dsh-assistant-overview-description
                    onClick={() => { jumpToOverviewTarget('identity') }}
                  >
                    还没有描述
                  </button>
                )
                : (
                  <>
                    <p
                      className={css.assistantOverviewDescription}
                      title={overviewWho.description}
                      data-dsh-assistant-overview-description
                    >
                      {overviewWho.description}
                    </p>
                    {/* The clamp hides the rest of the text; this text action is
                        the keyboard and touch way into 身份与形象 (a title is
                        neither focusable nor reachable on touch). It shares the
                        empty-description placeholder's text-button look and is
                        always shown for a non-empty description: measuring
                        scrollHeight in a narrow clamped column is not reliable. */}
                    <button
                      type="button"
                      className={css.assistantOverviewDescriptionEmpty}
                      data-dsh-assistant-overview-read-all
                      onClick={() => { jumpToOverviewTarget('identity') }}
                    >
                      读全部
                    </button>
                  </>
                )}
              <p className={css.assistantOverviewMeta}>{overviewWho.meta.join(' · ')}</p>
            </section>

            <section
              className={css.assistantOverviewSection}
              aria-label="能力边界"
              data-dsh-assistant-overview-limits
            >
              <span className={css.assistantOverviewTitle}>能力边界</span>
              {overviewLimits.capable.length === 0
                ? <p className={css.assistantOverviewNothing}>还没有授予任何能力</p>
                : (
                  <>
                    <span className={css.assistantOverviewListTitle}>能做到</span>
                    <ul className={css.assistantOverviewList} data-dsh-assistant-overview-capable>
                      {overviewLimits.capable.map(line => <li key={line}>{line}</li>)}
                    </ul>
                  </>
                )}
              {overviewLimits.unable.length > 0 && (
                <>
                  <span className={css.assistantOverviewListTitle}>不会做</span>
                  <ul className={css.assistantOverviewList} data-dsh-assistant-overview-unable>
                    {overviewLimits.unable.map(line => <li key={line}>{line}</li>)}
                  </ul>
                </>
              )}
            </section>
          </div>
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
            {/* One merged row: a search for 模型 or 思考模式 must both show it. */}
            {shows('模型', '思考模式', '推理强度') && (
              <SettingsRow
                label="模型"
                hint={catalogLoading
                  ? '正在读取模型列表…'
                  : modelControlHint.subtitle ?? provider}
                control={(
                  <ModelControl
                    provider={provider}
                    model={model}
                    reasoningEffort={reasoningEffort}
                    models={modelControlModels}
                    capabilities={modelCapabilities.value}
                    disabled={busy || catalog === undefined}
                    onChange={patch => {
                      if (patch.provider !== undefined) setProvider(patch.provider)
                      if (patch.model !== undefined) setModel(patch.model)
                      if (patch.reasoningEffort !== undefined) setReasoningEffort(patch.reasoningEffort)
                      setError(undefined)
                      setSaved(false)
                    }}
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
