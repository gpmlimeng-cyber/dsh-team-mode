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
import { agentTeamErrorCode, callAgentTeam, subscribeAgentTeam } from './api.js'
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
  assistantNow,
  relativeAssistantTime,
  type AssistantNow,
} from './assistant-instances.js'
import {
  ASSISTANT_BLURB_MAX_CHARS,
  ASSISTANT_TITLE_MAX_CHARS,
  assistantIdentityError,
  assistantIdentityUpdate,
} from './assistant-form.js'
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
import { AssistantCheckpointDialog } from './assistant-checkpoint-dialog.js'
import {
  assistantSessionOps,
  ensureAssistantMainSession,
  openAssistantMainSession,
  openAssistantSession,
} from './store.js'
import { UsageSection, assistantUsageScope } from './usage.js'
import css from './AgentTeam.module.css'
import { isCoordinatorInstance } from '../domain/types.js'
import { LeaderMark } from './team-member-chrome.js'
import type {
  AssistantMemory,
  AssistantSession,
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
  | 'usage'
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
  { id: 'identity', title: '身份与形象', keywords: '身份 形象 头像 显示名称 名称 职能 一句话介绍 介绍 人设 说明' },
  { id: 'model', title: '模型与权限', keywords: '模型 provider model 思考模式 推理强度 权限预设 权限' },
  { id: 'usage', title: '用量', keywords: '用量 token 令牌 缓存 命中 轮数 上下文 会话' },
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
  // 用量 is the same kind of read-only fact sheet as 概览, so it reuses that
  // icon: a new icon export would force every partial primitives mock to grow.
  usage: <IconInfoOutlineRegular size={14} />,
  capabilities: <IconSparkleRegular size={14} />,
  memory: <IconDatabaseOutlineRegular size={14} />,
  automations: <IconClockOutlineRegular size={14} />,
  archive: <IconArchiveOutlineRegular size={14} />,
  history: <IconFlatListOutlineRegular size={14} />,
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
 * The pane's first answer: what this coworker is doing now. It sits under the
 * hero and above 概览, so opening a helper is a status read, not a settings form.
 * Every word comes from `assistantNow` (task activity), not from the lifecycle
 * field the old "活跃" badge read once and never cleared.
 */
export function AssistantNowBlock({
  now,
  at,
  busy,
  compactBusy,
  onOpenChat,
  onOpenTask,
  onCompact,
  onNewRelationship,
  onAllSettings,
}: {
  now: AssistantNow
  /** Milliseconds clock for the relative "最近" stamp; tests pin it. */
  at?: number | undefined
  busy?: boolean | undefined
  compactBusy?: boolean | undefined
  onOpenChat: () => void
  onOpenTask: () => void
  onCompact: () => void
  onNewRelationship: () => void
  onAllSettings: () => void
}): JSX.Element {
  const currentTitle = now.current === undefined
    ? now.hasSession ? '主会话' : '还没有主会话'
    : now.current.title
  const currentMeta = now.current === undefined
    ? now.hasSession ? '没有进行中的任务' : '打开会话开始'
    : now.current.statusLabel
  const recentText = now.recent === undefined
    ? '还没有最近的消息'
    : `${now.recent.role === 'user' ? '你' : '助手'}：${now.recent.text}`
  const recentAt = now.recent === undefined
    ? undefined
    : relativeAssistantTime(new Date(now.recent.time).toISOString(), at)
  const taskAction = now.current?.status === 'needs_input' ? '处理' : '查看'
  return (
    <section className={css.assistantNow} data-dsh-assistant-now aria-label="现在">
      <div className={css.assistantNowHead}>
        <span className={css.assistantNowTitle}>现在</span>
        <span
          className={css.assistantNowStatus}
          data-dsh-assistant-now-status={now.state}
          title={now.statusTitle}
        >
          {now.statusText}
        </span>
      </div>
      <div className={css.assistantNowLine} data-dsh-assistant-now-current>
        <span className={css.assistantNowLabel}>当前</span>
        <span className={css.assistantNowValue} title={currentTitle}>{currentTitle}</span>
        <span className={css.assistantNowMeta}>{currentMeta}</span>
      </div>
      <div className={css.assistantNowLine} data-dsh-assistant-now-recent>
        <span className={css.assistantNowLabel}>最近</span>
        <span className={css.assistantNowValue} title={recentText}>{recentText}</span>
        {recentAt !== undefined && recentAt !== '' && (
          <span className={css.assistantNowMeta}>{recentAt}</span>
        )}
      </div>
      <div className={css.assistantNowActions}>
        <button
          type="button"
          className={css.assistantNowAction}
          data-dsh-assistant-now-action="chat"
          disabled={busy === true}
          onClick={onOpenChat}
        >
          打开会话
        </button>
        <button
          type="button"
          className={css.assistantNowAction}
          data-dsh-assistant-now-action="task"
          disabled={busy === true || now.current === undefined}
          onClick={onOpenTask}
        >
          {taskAction}
        </button>
        <button
          type="button"
          className={css.assistantNowAction}
          data-dsh-assistant-now-action="settings"
          onClick={onAllSettings}
        >
          全部设置
        </button>
        {/* Relationship operations: both are native — a slash command in the
            canonical chat, and the existing checkpoint handoff dialog. */}
        <button
          type="button"
          className={css.assistantNowAction}
          data-dsh-assistant-now-action="compact"
          disabled={busy === true || compactBusy === true}
          title="在主会话里执行原生 /compact；忙碌或不可用时宿主的拒绝会显示在下方"
          onClick={onCompact}
        >
          {compactBusy === true ? '压缩中…' : '压缩上下文'}
        </button>
        <button
          type="button"
          className={css.assistantNowAction}
          data-dsh-assistant-now-action="relationship"
          disabled={busy === true}
          title="用检查点交接开始一个新关系；旧主会话保留，不归档"
          onClick={onNewRelationship}
        >
          开始新关系
        </button>
      </div>
    </section>
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
  // The optional identity lines: staged here and written by the one 保存 bar,
  // where an emptied field clears the stored line.
  const [title, setTitle] = useState(assistant.assistantSnapshot.title ?? '')
  const [blurb, setBlurb] = useState(assistant.assistantSnapshot.blurb ?? '')
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
  /**
   * Server wording for a lifecycle refusal that has an explicit second exit:
   * archive with a live team link (`ASSISTANT_INSTANCE_TEAM_LINKED`) or restore
   * against an archived team (`ASSISTANT_INSTANCE_TEAM_UNAVAILABLE`). Shown
   * verbatim — the service owns the team names and the ways out, and a second
   * copy here would drift the day that message changes.
   */
  const [teamConflict, setTeamConflict] = useState<{
    kind: 'archive' | 'restore'
    message: string
  }>()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [openingChat, setOpeningChat] = useState(false)
  const [openingTask, setOpeningTask] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const [actionNotice, setActionNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [mascotMotion, setMascotMotion] = useState<MascotMotion>('idle')
  const [mascotMotionKey, setMascotMotionKey] = useState(0)
  const [overviewCounts, setOverviewCounts] = useState<AssistantOverviewCounts>({})
  // M1's number: the assistant-scoped entries assistant.memory.get answered
  // with, tagged with the instance it belongs to. `undefined` means the read has
  // not answered yet, so the count row never claims "还没有记录" for an unread
  // memory — and a re-read after a write keeps the old line instead of blinking.
  const [memoryEntryCount, setMemoryEntryCount] = useState<{ assistantId: string; count: number }>()
  // Bumped by the 记忆 block after each of its writes; it re-runs the one read
  // above so the count row never lags behind an edit made in this same pane.
  const [memoryReadNonce, setMemoryReadNonce] = useState(0)
  // The hidden task-worker Sessions are part of this assistant's usage. One
  // scoped read; a failure is labelled on the panel instead of silently
  // shrinking the total.
  const [taskUsage, setTaskUsage] = useState<{ tasks: AssistantSession[]; failed: boolean }>({
    tasks: [],
    failed: false,
  })
  const paneRef = useRef<HTMLDivElement>(null)
  // The Session list selects this assistant's automations; it is also the key
  // that makes the 概览 count re-read when a thread is added or removed.
  const overviewSessionKey = [assistant.mainSessionId ?? '', ...(assistant.threadSessionIds ?? [])].join('\u0000')

  const busy = saving || archiving || restoring || pausing
  const modelCapabilities = useModelCapabilities(provider, model)
  // The pane's first answer, derived from the same live task read as 用量.
  const now = assistantNow(assistant, taskUsage.tasks)
  // The Agent Preset is fixed at creation, so this catalog never changes for
  // one instance: whatever it lists is exactly what a save may carry.
  const capabilities = useCapabilityCatalog(assistant.assistantSnapshot.agentPresetId)

  // The task list drives both 用量 and the 现在 summary. It is read once per
  // assistant the pane is pointed at and re-read on every Host event, because a
  // task changing status must move 现在 with it instead of leaving it stale.
  useEffect(() => {
    let live = true
    setTaskUsage({ tasks: [], failed: false })
    const read = (): void => {
      void callAgentTeam('assistant.task.list', { assistantId: assistant.id }).then(
        value => {
          if (live) setTaskUsage({ tasks: value.items, failed: false })
        },
        () => {
          if (live) setTaskUsage({ tasks: [], failed: true })
        },
      )
    }
    read()
    const unsubscribe = subscribeAgentTeam(read, () => {}, read)
    return () => {
      live = false
      unsubscribe()
    }
  }, [assistant.id])

  // Refresh the editable draft whenever the pane is pointed at another helper.
  // Keyed by id: a list refresh for the same helper must not overwrite typing.
  useEffect(() => {
    let live = true
    setName(assistantInstanceName(assistant))
    setTitle(assistant.assistantSnapshot.title ?? '')
    setBlurb(assistant.assistantSnapshot.blurb ?? '')
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
    setTeamConflict(undefined)
    setSaving(false)
    setArchiving(false)
    setRestoring(false)
    setPausing(false)
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
        setMemoryEntryCount({ assistantId: assistant.id, count: entries })
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
    const identityError = assistantIdentityError({ title, blurb })
    if (identityError !== undefined) {
      setError(identityError)
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
    // A changed identity line travels trimmed; an emptied one travels as '' so
    // the service clears it, and an untouched one stays out of the patch.
    const identityPatch = assistantIdentityUpdate(snapshot, { title, blurb })
    if (identityPatch.title !== undefined) value.title = identityPatch.title
    if (identityPatch.blurb !== undefined) value.blurb = identityPatch.blurb
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

  /**
   * Archive, with the second exit the service asks for. A live team still
   * linking this assistant refuses the call; the refusal is not an error box —
   * it is a choice between "remove it from the team first" and "archive anyway,
   * keep the link as invalidated" (`force`), so the server message is surfaced
   * verbatim next to the force button.
   */
  async function archive(force = false): Promise<void> {
    if (busy) return
    if (!force && !confirmArchive) {
      setConfirmArchive(true)
      setError(undefined)
      setTeamConflict(undefined)
      return
    }
    setArchiving(true)
    setError(undefined)
    try {
      await callAgentTeam(
        'assistant.instance.archive',
        force ? { id: assistant.id, force: true } : { id: assistant.id },
      )
      setTeamConflict(undefined)
      await onSaved()
    } catch (cause) {
      if (!force && agentTeamErrorCode(cause) === 'ASSISTANT_INSTANCE_TEAM_LINKED') {
        setTeamConflict({ kind: 'archive', message: messageOf(cause) })
        setConfirmArchive(false)
        return
      }
      setError(`归档失败：${messageOf(cause)}`)
    } finally {
      setArchiving(false)
    }
  }

  /** Pause stops the live turn (destructive) and gates the queue; resume drains it. */
  async function togglePause(): Promise<void> {
    if (busy) return
    setPausing(true)
    setError(undefined)
    try {
      await callAgentTeam(
        assistant.pausedAt === undefined ? 'assistant.instance.pause' : 'assistant.instance.resume',
        { id: assistant.id },
      )
      await onSaved()
    } catch (cause) {
      setError(`${assistant.pausedAt === undefined ? '暂停' : '继续'}失败：${messageOf(cause)}`)
    } finally {
      setPausing(false)
    }
  }

  /**
   * Restore an archived assistant row; Sessions and the workspace stay
   * untouched. A link whose team is archived refuses the call and offers the
   * same second exit as archive: force, which clears the dead link.
   */
  async function restore(force = false): Promise<void> {
    if (busy) return
    setRestoring(true)
    setError(undefined)
    try {
      await callAgentTeam(
        'assistant.instance.restore',
        force ? { id: assistant.id, force: true } : { id: assistant.id },
      )
      setTeamConflict(undefined)
      await onSaved()
    } catch (cause) {
      if (!force && agentTeamErrorCode(cause) === 'ASSISTANT_INSTANCE_TEAM_UNAVAILABLE') {
        setTeamConflict({ kind: 'restore', message: messageOf(cause) })
        return
      }
      setError(`恢复失败：${messageOf(cause)}`)
    } finally {
      setRestoring(false)
    }
  }

  /** 打开会话: ensure the canonical chat, then hand navigation to the host. */
  async function openChat(): Promise<void> {
    if (openingChat) return
    setOpeningChat(true)
    setError(undefined)
    setActionNotice(undefined)
    try {
      // One door: ensure the canonical chat, name/mark it, then navigate. A
      // raw stored session id is never opened from here.
      const session = await openAssistantMainSession(assistant.id, sessionId => {
        if (!openAssistantSession(sessionId)) {
          setError('暂时打不开会话：会话界面还没就绪')
        }
      }, { bound: assistant.mainSessionId !== undefined })
      if (session.notice !== undefined) setActionNotice(session.notice)
      // ensure binds mainSessionId, so refresh the row after navigating.
      await onSaved()
    } catch (cause) {
      setError(`打开会话失败：${messageOf(cause)}`)
    } finally {
      setOpeningChat(false)
    }
  }

  /** 处理/查看: open the task the 现在 block named. */
  async function openCurrentTask(): Promise<void> {
    const task = now.current
    if (task === undefined || openingTask) return
    setOpeningTask(true)
    setError(undefined)
    try {
      const result = await callAgentTeam('assistant.task.open', { taskId: task.taskId })
      if (!openAssistantSession(result.sessionId)) {
        setError('暂时打不开任务会话：会话界面还没就绪')
      }
    } catch (cause) {
      setError(`打开任务失败：${messageOf(cause)}`)
    } finally {
      setOpeningTask(false)
    }
  }

  /**
   * 压缩上下文: run the shipped `/compact` in the canonical chat through the
   * host's client Session service (the same call the composer uses). No second
   * compactor and no endpoint; a busy/unavailable host refusal is shown inline,
   * and the session opens so the native compaction flow/refusal is visible.
   */
  async function compactMainSession(): Promise<void> {
    if (compacting) return
    setCompacting(true)
    setError(undefined)
    setActionNotice(undefined)
    try {
      const ops = assistantSessionOps()
      if (ops === undefined) {
        setError('宿主会话服务不可用，无法执行 /compact')
        return
      }
      const session = await ensureAssistantMainSession(assistant.id, {
        bound: assistant.mainSessionId !== undefined,
      })
      if (session.notice !== undefined) setActionNotice(session.notice)
      const verdict = await ops.command(session.sessionId, '/compact')
      if (!verdict.ok) {
        setError(`压缩被拒绝：${verdict.message ?? '宿主拒绝执行 /compact'}`)
        return
      }
      if (!verdict.matched) {
        setError('这个会话没有可用的 /compact 命令')
        return
      }
      setActionNotice('已发送原生 /compact')
      if (!openAssistantSession(session.sessionId)) {
        setActionNotice('已发送原生 /compact；会话界面还未就绪')
      }
      await onSaved()
    } catch (cause) {
      setError(`压缩失败：${messageOf(cause)}`)
    } finally {
      setCompacting(false)
    }
  }

  /** 开始新关系: reuse the existing checkpoint handoff; never archive main. */
  function startNewRelationship(): void {
    setError(undefined)
    setActionNotice(undefined)
    setCheckpointOpen(true)
  }

  /** 全部设置: clear the search, open every group, and start at 概览. */
  function showAllSettings(): void {
    setQuery('')
    const allOpen: Partial<Record<AssistantSettingGroupId, boolean>> = {}
    for (const group of ASSISTANT_SETTING_GROUPS) allOpen[group.id] = true
    setOpenGroups(allOpen)
    requestAnimationFrame(() => {
      paneRef.current?.querySelector('[data-dsh-fold="overview"]')?.scrollIntoView({ block: 'start' })
    })
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
  // The subtitle names what the assistant is: its group, role and task-derived
  // status. The lifecycle "活跃" is not read here any more: it was written once
  // at bind time and stayed forever, so it answered nothing.
  const avatarSubtitle = [
    assistant.group,
    isCoordinatorInstance(assistant) ? '总协调' : undefined,
    now.statusText,
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
          <span className={css.assistantAvatarNameRow}>
            <span className={css.assistantAvatarName}>{displayName}</span>
            {isCoordinatorInstance(assistant) && (
              <span
                className={css.assistantAvatarCrownChip}
                data-dsh-assistant-avatar-crown
                role="img"
                aria-label="总协调"
                title="总协调"
              >
                <LeaderMark size={11} />
              </span>
            )}
          </span>
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
      <AssistantNowBlock
        now={now}
        at={Date.now()}
        busy={busy || openingChat || openingTask}
        compactBusy={compacting}
        onOpenChat={() => { void openChat() }}
        onOpenTask={() => { void openCurrentTask() }}
        onCompact={() => { void compactMainSession() }}
        onNewRelationship={startNewRelationship}
        onAllSettings={showAllSettings}
      />
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
      {actionNotice !== undefined && (
        <div className={css.assistantDetailNotice} role="status">{actionNotice}</div>
      )}
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
            {memoryEntryCount?.assistantId === assistant.id && (
              <AssistantOverviewMemoryRow
                count={memoryEntryCount.count}
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
            {shows('职能') && (
              <SettingsRow
                label="职能"
                hint={`最多 ${ASSISTANT_TITLE_MAX_CHARS} 个字；同名助手靠这一行区分，留空则不显示。`}
                control={(
                  <div>
                    <input
                      className={css.input}
                      value={title}
                      disabled={busy}
                      placeholder="例如：后端工程师"
                      aria-label="职能"
                      data-dsh-assistant-title
                      onChange={event => { setTitle(event.target.value); setSaved(false) }}
                    />
                    <span className={css.hint} data-dsh-assistant-title-count>
                      {title.length} / {ASSISTANT_TITLE_MAX_CHARS}
                    </span>
                  </div>
                )}
              />
            )}
            {shows('一句话介绍', '介绍') && (
              <SettingsRow
                label="一句话介绍"
                hint={`最多 ${ASSISTANT_BLURB_MAX_CHARS} 个字；只影响展示，不写入系统提示。留空则不显示。`}
                control={(
                  <div>
                    <textarea
                      className={css.input}
                      rows={2}
                      value={blurb}
                      disabled={busy}
                      placeholder="例如：把需求变成可上线的接口和迁移脚本。"
                      aria-label="一句话介绍"
                      data-dsh-assistant-blurb
                      onChange={event => { setBlurb(event.target.value); setSaved(false) }}
                    />
                    <span className={css.hint} data-dsh-assistant-blurb-count>
                      {blurb.length} / {ASSISTANT_BLURB_MAX_CHARS}
                    </span>
                  </div>
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
                  : `${modelControlHint.subtitle ?? provider} · 模型与推理强度只影响之后启动的会话；已打开的主会话沿用旧模型，重新打开后生效。`}
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

      {isVisible('usage') && (
        <FoldGroup
          icon={GROUP_ICONS.usage}
          title="用量"
          hint="只读 · 来自宿主会话投影"
          open={isOpen('usage')}
          onToggle={open => { toggle('usage', open) }}
          dataKind="usage"
        >
          <UsageSection
            scope={assistantUsageScope(assistant, taskUsage.tasks)}
            {...(taskUsage.failed
              ? { excludeNote: '任务会话暂无法读取，合计不含任务会话' }
              : {})}
          />
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
          {assistant.status !== 'archived' && (
            <div className={css.assistantSettingsArchive}>
              <div className={css.assistantSettingsArchiveCopy}>
                <span className={css.assistantSettingsArchiveTitle}>
                  {assistant.pausedAt === undefined ? '暂停运行' : '继续运行'}
                </span>
                <span className={css.assistantSettingsArchiveHint}>
                  {assistant.pausedAt === undefined
                    ? '暂停会取消正在进行的回合（无法回放），并停止领取排队任务；之后可继续运行。'
                    : '继续会清空暂停标记，重新排队被暂停的任务并从原会话继续。'}
                </span>
              </div>
              <button
                type="button"
                className={css.dangerButton}
                disabled={busy}
                onClick={() => { void togglePause() }}
              >
                {pausing ? '处理中…' : assistant.pausedAt === undefined ? '暂停运行' : '继续运行'}
              </button>
            </div>
          )}
          <div className={css.assistantSettingsArchive}>
            <div className={css.assistantSettingsArchiveCopy}>
              <span className={css.assistantSettingsArchiveTitle}>
                {assistant.status === 'archived' ? '恢复助手' : '归档助手'}
              </span>
              <span className={css.assistantSettingsArchiveHint}>
                {assistant.status === 'archived'
                  ? '恢复只恢复可用性：助手重新出现在「单聊」列表，主会话、线程与工作区文件都还在原处；归档时被取消的后台任务不会复活。'
                  : '归档会立即停用该助手：从「单聊」列表移除、停止主会话与会话线程、取消正在运行的后台任务；记录、日志和工作区文件不会被删除。'}
              </span>
              {confirmArchive && assistant.status !== 'archived' && (
                <span className={css.assistantSettingsArchiveWarning} role="alert">
                  再次点击「确认归档」完成归档。
                </span>
              )}
            </div>
            {assistant.status === 'archived'
              ? (
                <button
                  type="button"
                  className={css.dangerButton}
                  disabled={busy}
                  onClick={() => { void restore() }}
                >
                  {restoring ? '恢复中…' : '恢复助手'}
                </button>
              )
              : (
                <button
                  type="button"
                  className={`${css.dangerButton} ${css.confirmDangerButton} ${confirmArchive ? css.assistantSettingsArchiveConfirm : ''}`}
                  disabled={busy}
                  onClick={() => { void archive() }}
                >
                  {archiving ? '归档中…' : confirmArchive ? '确认归档' : '归档助手'}
                </button>
              )}
          </div>
          {teamConflict !== undefined && (
            <div className={css.assistantSettingsArchive} data-dsh-assistant-team-conflict={teamConflict.kind}>
              <div className={css.assistantSettingsArchiveCopy}>
                <span className={css.assistantSettingsArchiveWarning} role="alert">
                  {teamConflict.message}
                </span>
                <span className={css.assistantSettingsArchiveHint}>
                  {teamConflict.kind === 'archive'
                    ? '两条出口：先到团队页把该成员移除（或归档那个团队）后再归档；或者强制归档，团队侧的关联会被标记为已失效。'
                    : '两条出口：先恢复那个团队后再恢复助手；或者强制恢复，助手以未关联身份回来，失效的关联会被清除。'}
                </span>
              </div>
              <span className={css.assistantSettingsArchiveActions}>
                <button
                  type="button"
                  className={css.dangerButton}
                  disabled={busy}
                  onClick={() => {
                    setTeamConflict(undefined)
                    setError(undefined)
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={`${css.dangerButton} ${css.confirmDangerButton}`}
                  data-dsh-assistant-team-conflict-force
                  disabled={busy}
                  onClick={() => {
                    void (teamConflict.kind === 'archive' ? archive(true) : restore(true))
                  }}
                >
                  {archiving || restoring
                    ? '处理中…'
                    : teamConflict.kind === 'archive' ? '强制归档' : '强制恢复'}
                </button>
              </span>
            </div>
          )}
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
      {/* The one new-relationship path: the existing checkpoint handoff. It
          retires the old main Session into the history list and binds a fresh
          one; this pane never archives the main Session. */}
      <AssistantCheckpointDialog
        open={checkpointOpen}
        assistant={assistant}
        onClose={() => { setCheckpointOpen(false) }}
        openSession={sessionId => {
          if (!openAssistantSession(sessionId)) {
            setError('暂时打不开新会话：会话界面还没就绪')
          }
        }}
      />
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
