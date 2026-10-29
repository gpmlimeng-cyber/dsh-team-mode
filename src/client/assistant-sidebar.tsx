import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LeaderMark } from './team-member-chrome.js'
import {
  IconArchiveOutlineRegular,
  IconChecklistOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseFillRegular,
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconNewChatOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconPlusOutlineRegular,
  IconProjectAddOutlineRegular,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import {
  openAssistantMainSession,
  selectAssistant,
  useAgentTeamUi,
} from './store.js'
import { AssistantCheckpointDialog } from './assistant-checkpoint-dialog.js'
import { AssistantCreateDialog } from './assistant-dialogs.js'
import { useAssistantDisplayMode } from './assistant-display-mode.js'
import { openAssistantDetail } from './assistant-settings-pane.js'
import {
  approvalDecisionLabel,
  approvalHistory,
  rememberApproval,
} from './approval-history.js'
import {
  assistantReadState,
  isAssistantUnread,
  markAssistantRead,
  markAssistantUnread,
} from './assistant-read-state.js'
import { AssistantTaskDialog } from './assistant-task-dialog.js'
import {
  assistantAvatarSource,
  assistantInstanceLabel,
  assistantInstanceName,
  assistantPendingDecisions,
  assistantRowActivity,
  assistantRowState,
  assistantRowStatusText,
  assistantRowStatusTitle,
  assistantTaskStatusLabel,
  assistantThreadTasks,
  archivedAssistantInstances,
  coordinatorAssistant,
  coordinatorAssistantId,
  coordinatorEscalationBadge,
  relativeAssistantTime,
  visibleAssistantInstances,
} from './assistant-instances.js'
import {
  AssistantConversationList,
  assistantConversationExpanded,
  assistantConversationRows,
} from './assistant-conversations.js'
import {
  writeAssistantThreadExpanded,
} from './assistant-thread-state.js'
import { MemberAvatar } from './member-avatar.js'
import { Mascot } from './mascot-view.js'
import { assistantShowsMascot, mascotMotionForStatus, mascotOptionsFor } from './mascot.js'
import { movedGroupOrder, sidebarPartitions, useSidebarGroups } from './sidebar-groups.js'
import {
  SidebarGroupDialogs,
  SidebarGroupPartition,
  sidebarDragSwallowsClick,
  sidebarGroupActionItems,
  sidebarPartitionLabel,
  useSidebarDrag,
  type SidebarGroupDialog,
} from './sidebar-group-ui.js'
import css from './AgentTeam.module.css'
import type { WorkspaceChoice } from './types.js'
import { isCoordinatorInstance } from '../domain/types.js'
import type { AssistantInstance, AssistantSession, Escalation } from '../domain/types.js'
import type { AssistantInstanceView, PendingInteractionView } from '../transport/contracts.js'

/** Brand-row 搜索 filters both lists through one window event. */
export const SIDEBAR_SEARCH_EVENT = 'dsh-team-mode:sidebar-search'
/** Brand-row ＋ → 新建助手; the dialog itself still lives in this section. */
export const SIDEBAR_ASSISTANT_CREATE_EVENT = 'dsh-team-mode:assistant-create'
/** ＋ menu → 「创建分组」: the group dialogs live with the list they reorder. */
export const SIDEBAR_GROUP_CREATE_EVENT = 'dsh-team-mode:sidebar-group-create'

/**
 * The one size of a 单聊 row's identity: DeepSeek-Bot draws a sidebar Bot at
 * 36px (`sidebar.js:88` → `BotAvatar { size: 36 }`), and our slot is the same
 * 36px. Mascot and uploaded picture must share it — different sizes made the
 * row jump when a helper swapped one for the other.
 */
export const SIDEBAR_ASSISTANT_AVATAR_SIZE = 36

/** Three tiny dots used while an Assistant is thinking, not a static count. */
function AssistantWorkingDots(): JSX.Element {
  return (
    <span className={css.assistantWorkingDots} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

/** Status pill styling for the inline task threads. */
function taskStatusClass(status: AssistantSession['status']): string {
  if (status === 'needs_input') return css.assistantTaskStatusWaiting ?? ''
  if (status === 'running') return css.assistantTaskStatusRunning ?? ''
  return css.assistantTaskStatusIdle ?? ''
}

export interface AssistantMenuEntry {
  id:
    | 'new-thread'
    | 'new-thread-folder'
    | 'checkpoint'
    | 'settings'
    | 'detail'
    | 'pin'
    | 'group'
    | 'coordinator'
    | 'tasks'
    | 'mark-read'
    | 'mark-unread'
    | 'open-main'
  label: string
  icon: JSX.Element
}

/**
 * Row menu of one Assistant. The two new-conversation entries lead, the way a
 * MausBot bot menu leads with its thread actions; the folder variant picks a
 * working directory before creating. `checkpoint` is the single entry for both
 * creating a checkpoint and handing off; there is deliberately no second
 * handoff item, so the dialog owns that flow end to end. The coordinator item
 * flips to 取消总协调 purely from the row's own field.
 */
export function assistantMenuEntries(
  instance: AssistantInstance,
  unread: boolean,
): AssistantMenuEntry[] {
  const pinned = instance.pinned === true
  const coordinator = isCoordinatorInstance(instance)
  return [
    { id: 'new-thread', label: '新建会话', icon: <IconNewChatOutlineRegular size={14} /> },
    {
      id: 'new-thread-folder',
      label: '在工作目录中新建…',
      icon: <IconFolderOpenOutlineRegular size={14} />,
    },
    { id: 'checkpoint', label: '检查点与交接', icon: <IconChecklistOutlineRegular size={14} /> },
    // 助手设置 opens the host's right Sidebar tab; there is no dialog anymore.
    { id: 'settings', label: '助手设置', icon: <IconEditOutlineRegular size={14} /> },
    {
      id: 'pin',
      label: pinned ? '取消置顶' : '置顶',
      icon: pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />,
    },
    // Same slot as a team row's move: after 置顶, before the role switch.
    { id: 'group', label: '移动到分组…', icon: <IconProjectAddOutlineRegular size={14} /> },
    {
      id: 'coordinator',
      label: coordinator ? '取消总协调' : '设为总协调',
      icon: <LeaderMark size={14} />,
    },
    { id: 'tasks', label: '查看任务', icon: <IconChecklistOutlineRegular size={14} /> },
    unread
      ? { id: 'mark-read', label: '标记已读', icon: <IconChecklistOutlineRegular size={14} /> }
      : { id: 'mark-unread', label: '标记未读', icon: <IconChecklistOutlineRegular size={14} /> },
    { id: 'open-main', label: '打开主会话', icon: <IconNewChatOutlineRegular size={14} /> },
  ]
}

/**
 * The “单聊” section: one row per Assistant instance. Opening a row ensures the
 * instance's main Session in the Host and hands off to the shipped conversation
 * view; Phase 0 deliberately has no assistant-specific chat UI.
 */
export function AssistantSidebarSection({
  openSession,
  pickWorkspace,
  children,
}: {
  openSession: (sessionId: string) => void
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  /**
   * The 群聊 section. It is rendered between the coordinator row and 单聊 so the
   * DOM, tab and screen-reader order match the column: 总协调 → 群聊 → 单聊.
   */
  children?: ReactNode
}): JSX.Element {
  const { selectedAssistantId } = useAgentTeamUi()
  const [instances, setInstances] = useState<AssistantInstanceView[]>([])
  const [readState, setReadState] = useState(assistantReadState)
  const [notice, setNotice] = useState<{ assistantId: string; taskId: string; name: string; title: string }>()
  const [interactionsByTask, setInteractionsByTask] = useState<Record<string, PendingInteractionView[]>>({})
  const [interactionBusy, setInteractionBusy] = useState<string>()
  const [interactionError, setInteractionError] = useState<string>()
  const [approvalHistoryState, setApprovalHistoryState] = useState(approvalHistory)
  const [approvalFeedback, setApprovalFeedback] = useState<string>()
  const feedbackTimerRef = useRef<number | undefined>(undefined)
  const browserNotificationsRef = useRef<Map<string, Notification>>(new Map())
  const knownWaitingRef = useRef<Set<string> | undefined>(undefined)
  const [tasks, setTasks] = useState<AssistantSession[]>([])
  // Workspace-wide escalation rows; the coordinator row owns the only badge that
  // reads them, and every other row ignores the list.
  const [escalations, setEscalations] = useState<Escalation[]>([])
  const mode = useAssistantDisplayMode()
  const [query, setQuery] = useState('')

  // The brand-row search drives both lists, and its ＋ menu owns 新建助手, so
  // this section answers events instead of rendering a header of its own.
  useEffect(() => {
    const onSearch = (event: Event): void => {
      setQuery((event as CustomEvent<string>).detail ?? '')
    }
    const onCreate = (): void => {
      setError(undefined)
      setCreateOpen(true)
    }
    const onGroupCreate = (): void => { setGroupDialog({ kind: 'create' }) }
    window.addEventListener(SIDEBAR_SEARCH_EVENT, onSearch)
    window.addEventListener(SIDEBAR_ASSISTANT_CREATE_EVENT, onCreate)
    window.addEventListener(SIDEBAR_GROUP_CREATE_EVENT, onGroupCreate)
    return () => {
      window.removeEventListener(SIDEBAR_SEARCH_EVENT, onSearch)
      window.removeEventListener(SIDEBAR_ASSISTANT_CREATE_EVENT, onCreate)
      window.removeEventListener(SIDEBAR_GROUP_CREATE_EVENT, onGroupCreate)
    }
  }, [])
  const [threadOpenById, setThreadOpenById] = useState<Record<string, boolean>>({})
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [openingId, setOpeningId] = useState<string>()
  const [openingTaskId, setOpeningTaskId] = useState<string>()
  const [creatingThreadId, setCreatingThreadId] = useState<string>()
  const [menuOpenId, setMenuOpenId] = useState<string>()
  const [taskAssistantId, setTaskAssistantId] = useState<string>()
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  const [checkpointAssistant, setCheckpointAssistant] = useState<AssistantInstance>()
  const [checkpointDialogOpen, setCheckpointDialogOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [listError, setListError] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  const [threadError, setThreadError] = useState<{ assistantId: string; message: string }>()
  const { groups, refresh: refreshGroups, adopt: adoptGroups } = useSidebarGroups()
  /** Collapsed named groups, in-memory only: a fold is a view, not a setting. */
  const [collapsedPartitions, setCollapsedPartitions] = useState<Record<string, boolean>>({})
  const [groupDialog, setGroupDialog] = useState<SidebarGroupDialog>()

  useEffect(() => () => {
    if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current)
    for (const notification of browserNotificationsRef.current.values()) notification.close()
    browserNotificationsRef.current.clear()
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const [instancePage, taskPage, escalationPage] = await Promise.all([
        callAgentTeam('assistant.instance.list'),
        callAgentTeam('assistant.task.list', undefined),
        // The badge is decoration: an older Host that does not answer this read
        // must not blank the assistant list it shares a request with.
        callAgentTeam('escalation.list').catch(() => ({ items: [] as Escalation[], total: 0 })),
        // The group list is a view over these rows; a Host without it answers
        // nothing and the list keeps rendering exactly as before.
        refreshGroups(),
      ])
      setInstances(instancePage.items)
      setTasks(taskPage.items)
      setEscalations(escalationPage.items)
      setListError(undefined)
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      // Only the first settled list decides between 正在加载助手… and a real
      // empty state: an unanswered request is not an empty workspace.
      setLoaded(true)
    }
  }, [refreshGroups])

  useEffect(() => {
    void load()
    return subscribeAgentTeam(() => { void load() }, () => {
      setListError('助手事件连接已断开，正在重连')
    }, () => { void load() })
  }, [load])

  // The coordinating assistant is pinned above the groups, so it is not repeated
  // here; every other row is untouched.
  const visible = useMemo(
    () => {
      const coordinatorId = coordinatorAssistantId(instances)
      return visibleAssistantInstances(instances, query)
        .filter(instance => instance.id !== coordinatorId)
    },
    [instances, query],
  )

  // Decisions are workspace-wide: the search box narrows the ordinary row list
  // below, never this block or its count.
  const allPending = useMemo(
    () => assistantPendingDecisions(instances, tasks),
    [instances, tasks],
  )
  const attentionItems = allPending

  useEffect(() => {
    let cancelled = false
    if (attentionItems.length === 0) {
      setInteractionsByTask({})
      return
    }
    void Promise.all(attentionItems.map(async item => {
      try {
        const interactions = await callAgentTeam('assistant.task.interactions', { taskId: item.task.id })
        return [item.task.id, interactions] as const
      } catch {
        return [item.task.id, []] as const
      }
    })).then(entries => {
      if (!cancelled) setInteractionsByTask(Object.fromEntries(entries))
    })
    return () => { cancelled = true }
  }, [attentionItems])

  useEffect(() => {
    if (knownWaitingRef.current === undefined) {
      knownWaitingRef.current = new Set(allPending.map(item => item.task.id))
      return
    }
    const known = knownWaitingRef.current
    const fresh = allPending.filter(item => !known.has(item.task.id))
    for (const item of allPending) known.add(item.task.id)
    const first = fresh[0]
    if (first === undefined) return
    setNotice({
      assistantId: first.instance.id,
      taskId: first.task.id,
      name: assistantInstanceLabel(first.instance),
      title: first.task.title,
    })
    // Desktop notification is best-effort: never prompt for permission here,
    // and never block the in-app notice if the WebView has no Notification.
    try {
      if (typeof window !== 'undefined' && 'Notification' in window && window.Notification.permission === 'granted') {
        const notification = new window.Notification('助手需要你处理', {
          body: `${assistantInstanceLabel(first.instance)} · ${first.task.title}`,
          tag: `dsh-assistant:${first.task.id}`,
        })
        browserNotificationsRef.current.set(first.task.id, notification)
        notification.onclick = () => {
          window.focus()
          selectAssistant(first.instance.id)
          void openThreadTask(first.instance, first.task)
          notification.close()
          browserNotificationsRef.current.delete(first.task.id)
        }
      }
    } catch {
      // Notification is optional; the in-app notice remains.
    }
  }, [allPending])

  const taskAssistant = useMemo(
    () => (taskAssistantId === undefined
      ? undefined
      : instances.find(item => item.id === taskAssistantId)),
    [instances, taskAssistantId],
  )

  const openCreate = (): void => {
    setError(undefined)
    setCreateOpen(true)
  }

  const openTasks = (instance: AssistantInstance): void => {
    setTaskAssistantId(instance.id)
    setTaskDialogOpen(true)
    setMenuOpenId(undefined)
  }

  const openSettings = (instance: AssistantInstance): void => {
    // The pane is the host's; the event → listener path does the layout write.
    openAssistantDetail(instance.id)
    setMenuOpenId(undefined)
  }

  const openCheckpoint = (instance: AssistantInstance): void => {
    setCheckpointAssistant(instance)
    setCheckpointDialogOpen(true)
    setMenuOpenId(undefined)
    setError(undefined)
  }

  async function openAssistant(instance: AssistantInstance): Promise<void> {
    if (openingId !== undefined) return
    selectAssistant(instance.id)
    setReadState(markAssistantRead(instance.id))
    setOpeningId(instance.id)
    setError(undefined)
    try {
      const outcome = await openAssistantMainSession(instance.id, openSession, {
        bound: instance.mainSessionId !== undefined,
      })
      if (outcome.notice !== undefined) setError(outcome.notice)
    } catch (cause) {
      // Ownership conflicts and stale bind failures are shown where the click
      // happened, never swallowed into a session that opens without its setup.
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOpeningId(undefined)
    }
  }

  async function restoreAssistant(instance: AssistantInstance): Promise<void> {
    setError(undefined)
    try {
      await callAgentTeam('assistant.instance.restore', { id: instance.id })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function togglePin(instance: AssistantInstance): Promise<void> {
    setError(undefined)
    try {
      await callAgentTeam('assistant.instance.update', {
        id: instance.id,
        value: { pinned: instance.pinned !== true },
      })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /**
   * Set or clear the workspace's one coordinator. The host enforces uniqueness,
   * so this owns no local state: the reload moves the pinned row.
   */
  async function toggleCoordinator(instance: AssistantInstance): Promise<void> {
    setError(undefined)
    try {
      await callAgentTeam('assistant.coordinator.set', {
        assistantId: isCoordinatorInstance(instance) ? null : instance.id,
      })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function toggleThreads(instance: AssistantInstance, open: boolean): void {
    const next = !open
    writeAssistantThreadExpanded(instance.id, next)
    setThreadOpenById(current => ({ ...current, [instance.id]: next }))
    setThreadError(current => (current?.assistantId === instance.id ? undefined : current))
  }

  /**
   * Create one more visible Session for this Assistant. The Host creates it and
   * answers with the instance that already lists it, so the answer is the only
   * source of the new row — nothing is drawn ahead of it. Expanding afterwards
   * is view state, not data.
   */
  async function createConversation(instance: AssistantInstance, cwd?: string): Promise<void> {
    if (creatingThreadId !== undefined) return
    setCreatingThreadId(instance.id)
    setThreadError(undefined)
    // Open the tree first: this is the row whose list gains the new Session, and
    // a failure has to be visible in the same place. Nothing is drawn into it
    // before the Host answers.
    writeAssistantThreadExpanded(instance.id, true)
    setThreadOpenById(current => ({ ...current, [instance.id]: true }))
    try {
      const next = await callAgentTeam('assistant.thread.create', cwd === undefined
        ? { instanceId: instance.id }
        : { instanceId: instance.id, cwd })
      setInstances(current => current.map(item => item.id === next.id ? { ...item, ...next } : item))
    } catch (cause) {
      setThreadError({
        assistantId: instance.id,
        message: `新建会话失败：${cause instanceof Error ? cause.message : String(cause)}`,
      })
    } finally {
      setCreatingThreadId(undefined)
    }
  }

  /** 在工作目录中新建…: the shipped directory picker first, then the same create. */
  async function createConversationInFolder(instance: AssistantInstance): Promise<void> {
    if (creatingThreadId !== undefined) return
    let choice: WorkspaceChoice | null
    try {
      choice = await pickWorkspace()
    } catch (cause) {
      setThreadError({
        assistantId: instance.id,
        message: `选择工作目录失败：${cause instanceof Error ? cause.message : String(cause)}`,
      })
      return
    }
    if (choice === null) return
    await createConversation(instance, choice.path)
  }

  /** Retire one thread Session. The main Session is the instance and never lands here. */
  async function archiveConversation(
    instance: AssistantInstance,
    sessionId: string,
  ): Promise<void> {
    setThreadError(undefined)
    try {
      const next = await callAgentTeam('assistant.thread.archive', {
        instanceId: instance.id,
        sessionId,
      })
      setInstances(current => current.map(item => item.id === next.id ? { ...item, ...next } : item))
    } catch (cause) {
      setThreadError({
        assistantId: instance.id,
        message: `归档会话失败：${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }
  }

  async function respondInteraction(
    taskId: string,
    interactionId: string,
    outcome: 'allowed-once' | 'rejected',
    toolName: string,
  ): Promise<void> {
    setInteractionBusy(interactionId)
    setInteractionError(undefined)
    try {
      await callAgentTeam('assistant.task.interaction.respond', {
        taskId,
        interactionId,
        response: { kind: 'approval', outcome },
      })
      setInteractionsByTask(current => {
        const next = { ...current }
        next[taskId] = (next[taskId] ?? []).filter(item => item.id !== interactionId)
        if (next[taskId].length === 0) delete next[taskId]
        return next
      })
      setApprovalHistoryState(rememberApproval(toolName, outcome))
      setApprovalFeedback(`${approvalDecisionLabel(outcome)} · ${toolName}`)
      if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current)
      feedbackTimerRef.current = window.setTimeout(() => {
        setApprovalFeedback(undefined)
        feedbackTimerRef.current = undefined
      }, 4000)
      const browserNotification = browserNotificationsRef.current.get(taskId)
      if (browserNotification !== undefined) {
        browserNotification.close()
        browserNotificationsRef.current.delete(taskId)
      }
      setNotice(current => current?.taskId === taskId ? undefined : current)
      await load()
    } catch (cause) {
      setInteractionError(`审批处理失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setInteractionBusy(undefined)
    }
  }

  async function openThreadTask(
    instance: AssistantInstance,
    task: AssistantSession,
  ): Promise<void> {
    if (openingTaskId !== undefined) return
    setReadState(markAssistantRead(instance.id))
    setOpeningTaskId(task.id)
    setThreadError(undefined)
    try {
      const result = await callAgentTeam('assistant.task.open', { taskId: task.id })
      openSession(result.sessionId)
    } catch (cause) {
      setThreadError({
        assistantId: instance.id,
        message: `任务打开失败：${cause instanceof Error ? cause.message : String(cause)}`,
      })
    } finally {
      setOpeningTaskId(undefined)
    }
  }

  const message = error ?? listError

  /** Named groups in the Host's order; one unlabelled partition when none exist. */
  const partitions = useMemo(
    () => sidebarPartitions(groups, visible, instance => instance.group),
    [groups, visible],
  )
  // Archived rows stay reachable after a reload: the list read is unfiltered,
  // so the management fold can offer restore without reopening anything.
  const archived = useMemo(
    () => archivedAssistantInstances(instances, query)
      .filter(instance => instance.id !== coordinatorAssistantId(instances)),
    [instances, query],
  )
  const partitioned = groups.length > 0

  /** Rows move between groups, headers reorder groups: one shared state machine. */
  const drag = useSidebarDrag({
    groups,
    assign: async (id, group) => {
      await callAgentTeam('assistant.instance.update', {
        id,
        // An empty string is the update schema's "clear it".
        value: { group: group ?? '' },
      })
      await load()
    },
    reorder: async names => {
      adoptGroups(await callAgentTeam('sidebar.groups.reorder', { names }))
    },
    onError: cause => { setError(cause instanceof Error ? cause.message : String(cause)) },
  })

  const togglePartition = (id: string): void => {
    setCollapsedPartitions(current => ({ ...current, [id]: current[id] !== true }))
  }

  /** One group header's `⋯`: create/import everywhere; the named group's own ops after. */
  const selectGroupMenu = async (group: string | undefined, id: string): Promise<void> => {
    if (id === 'create') {
      setGroupDialog({ kind: 'create' })
      return
    }
    if (id === 'import') {
      setGroupDialog({ kind: 'import' })
      return
    }
    if (group === undefined) return
    if (id === 'members') {
      setGroupDialog({ kind: 'members', group })
      return
    }
    if (id === 'brief') {
      setGroupDialog({ kind: 'brief', name: group })
      return
    }
    if (id === 'batch') {
      setGroupDialog({ kind: 'batch', group })
      return
    }
    if (id === 'export') {
      setGroupDialog({ kind: 'export', name: group })
      return
    }
    if (id === 'rename') {
      setGroupDialog({ kind: 'rename', from: group })
      return
    }
    if (id === 'delete') {
      setGroupDialog({ kind: 'delete', name: group })
      return
    }
    if (id !== 'move-up' && id !== 'move-down') return
    try {
      adoptGroups(await callAgentTeam('sidebar.groups.reorder', {
        names: movedGroupOrder(groups, group, id === 'move-up' ? -1 : 1),
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const renderAssistantRow = (instance: AssistantInstanceView): JSX.Element => {
    const name = assistantInstanceName(instance)
    // The visible row text carries the optional 职能 line; aria labels and the
    // avatar keep the bare name so the row still reads as one Assistant.
    const label = assistantInstanceLabel(instance)
    const opening = openingId === instance.id
    const active = selectedAssistantId === instance.id
    const menuOpen = menuOpenId === instance.id
    const activity = assistantRowActivity(tasks, instance)
    const state = assistantRowState(activity)
    const statusText = assistantRowStatusText(activity)
    const statusTitle = assistantRowStatusTitle(activity)
    const previewText = instance.preview?.text.trim() ?? ''
    const hasPreview = previewText !== ''
    // An error/starting instance owns the second line: its preview is
    // not more important than "this assistant is broken".
    const activeStatus = state !== 'none'
    const unread = isAssistantUnread(instance, readState)
    // Only the coordinator row ever gets a number; every other row reads
    // undefined and renders nothing at all.
    const escalationBadge = coordinatorEscalationBadge(instance, escalations)
    const secondLine = activeStatus ? statusText : hasPreview ? previewText : statusText
    const secondLineTitle = activeStatus
      ? statusTitle
      : hasPreview
        ? `${instance.preview?.role === 'user' ? '你' : '助手'}：${previewText}`
        : statusTitle
    const dotClass = state === 'needs_input'
      ? css.sidebarAssistantDotWaiting
      : state === 'running'
        ? css.sidebarAssistantDotRunning
        : state === 'error'
          ? css.sidebarAssistantDotError
          : state === 'starting'
            ? css.sidebarAssistantDotStarting
            : css.sidebarAssistantDotQueued
    const rowDrag = drag.row(instance.id, instance.group)
    const statusClass = state === 'needs_input'
      ? css.sidebarAssistantStatusWaiting
      : state === 'running'
        ? css.sidebarAssistantStatusRunning
        : state === 'error'
          ? css.sidebarAssistantStatusError
          : state === 'starting'
            ? css.sidebarAssistantStatusStarting
            : state === 'queued'
              ? css.sidebarAssistantStatusQueued
              : css.sidebarAssistantStatusIdle
    // The disclosure is view state: the persisted per-Assistant value is read
    // lazily, and an instance only earns a chevron once it owns a thread
    // Session (a lone main Session is opened by the row itself) or, in advanced
    // mode, a task thread.
    const conversationRows = assistantConversationRows(instance)
    const hasConversations = (instance.threadSessionIds ?? []).length > 0
    const threadTasks = mode === 'advanced'
      ? assistantThreadTasks(tasks, instance)
      : []
    const disclosure = hasConversations || threadTasks.length > 0
    const threadsOpen = disclosure
      && assistantConversationExpanded(instance.id, threadOpenById)
    const creating = creatingThreadId === instance.id
    const threadErrorForRow = threadError?.assistantId === instance.id
      ? threadError.message
      : undefined
    return (
      <div key={instance.id} className={css.sidebarTeamGroup}>
        <div
          className={`${css.sidebarTeamRowWrap} ${css.sidebarAssistantRowWrap} ${active ? css.sidebarTeamRowWrapActive : ''} ${menuOpen ? css.sidebarTeamRowWrapMenuOpen : ''}`}
          data-dsh-assistant-row
          draggable={rowDrag.draggable}
          onDragStart={rowDrag.onDragStart}
          onDragEnd={rowDrag.onDragEnd}
          {...(rowDrag.dragging ? { 'data-dsh-drag-source': '' } : {})}
        >
          {disclosure && (
            <button
              type="button"
              className={css.sidebarAssistantThreadToggle}
              aria-expanded={threadsOpen}
              aria-controls={threadsOpen
                ? `dsh-team-mode-assistant-threads-${instance.id}`
                : undefined}
              aria-label={threadsOpen
                ? `收起 ${name} 的会话`
                : `展开 ${name} 的会话`}
              title={threadsOpen ? '收起会话' : '展开会话'}
              data-dsh-assistant-thread-toggle
              onClick={() => { toggleThreads(instance, threadsOpen) }}
            >
              <IconChevronRightOutlineRegular
                size={12}
                className={`${css.sidebarAssistantThreadChevron} ${threadsOpen ? css.sidebarAssistantThreadChevronOpen : ''}`}
              />
            </button>
          )}
          <button
            type="button"
            className={`${css.sidebarTeamRow} ${css.sidebarAssistantRow}`}
            onClick={() => {
              // A drag that ended on this row must not also open the assistant.
              if (sidebarDragSwallowsClick()) return
              if (activity.status === 'needs_input') {
                const pendingTask = assistantThreadTasks(tasks, instance)
                  .find(task => task.status === 'needs_input')
                if (pendingTask !== undefined) {
                  selectAssistant(instance.id)
                  void openThreadTask(instance, pendingTask)
                  return
                }
              }
              void openAssistant(instance)
            }}
            disabled={opening}
            aria-busy={opening || activity.status === 'running' ? true : undefined}
            aria-current={active ? 'page' : undefined}
            title={`${label} · ${secondLine} · ${instance.assistantSnapshot.model}`}
          >
            <span className={css.sidebarAssistantAvatar}>
              {assistantShowsMascot(instance)
                ? <Mascot
                    {...mascotOptionsFor(instance)}
                    size={SIDEBAR_ASSISTANT_AVATAR_SIZE}
                    avatarShape="rounded"
                    motion={mascotMotionForStatus(instance.status)}
                  />
                : <MemberAvatar
                    name={name}
                    avatar={assistantAvatarSource(instance)}
                    size={SIDEBAR_ASSISTANT_AVATAR_SIZE}
                    className={css.sidebarAssistantAvatarShape ?? ''}
                  />}
              {/* The coordinator wears its crown on the avatar, the way the
                  reference app marks the assistant in charge. */}
              {isCoordinatorInstance(instance) && (
                <span className={css.sidebarAssistantCrownBadge} data-dsh-assistant-crown aria-hidden="true">
                  <LeaderMark size={8} />
                </span>
              )}
              {state !== 'none' && (
                <span
                  className={`${css.sidebarAssistantDot} ${dotClass} ${state === 'needs_input' ? css.sidebarAssistantWaitingBadge : ''}`}
                  data-dsh-assistant-status={state}
                  title={statusTitle}
                  aria-label={statusTitle}
                  role="img"
                >
                  {activity.status === 'needs_input' && <span aria-hidden="true">!</span>}
                </span>
              )}
            </span>
            <span className={`${css.sidebarTeamCopy} ${css.sidebarAssistantCopy}`}>
              <span className={css.sidebarAssistantTop}>
                <span className={css.sidebarTeamName}>{label}</span>
                {isCoordinatorInstance(instance) && (
                  <span
                    className={css.sidebarAssistantCrown}
                    title="总协调"
                    aria-label="总协调"
                    role="img"
                    data-dsh-assistant-coordinator
                  >
                    <LeaderMark size={11} />
                  </span>
                )}
                {escalationBadge !== undefined && (
                  <span
                    className={css.sidebarTeamBadge}
                    title={`${escalationBadge} 个待处理升级`}
                    aria-label={`${escalationBadge} 个待处理升级`}
                    data-dsh-escalation-count={escalationBadge}
                  >
                    {escalationBadge > 99 ? '99+' : escalationBadge}
                  </span>
                )}
                {instance.pinned === true && (
                  <span
                    className={css.sidebarAssistantPinned}
                    title="已置顶"
                    aria-label="已置顶"
                    role="img"
                  >
                    <IconPinFillRegular size={11} />
                  </span>
                )}
                {unread && (
                  <span
                    className={css.sidebarAssistantUnread}
                    title="未读消息"
                    aria-label="未读消息"
                    role="img"
                  />
                )}
                <span className={css.sidebarTeamTime}>
                  {opening
                    ? '打开中'
                    : creating
                      ? '新建中'
                      : relativeAssistantTime(instance.preview === undefined
                        ? instance.updatedAt
                        : new Date(instance.preview.time).toISOString())}
                </span>
              </span>
              <span
                className={`${css.sidebarAssistantStatus} ${activeStatus ? statusClass : css.sidebarAssistantPreview}`}
                title={secondLineTitle}
                data-dsh-assistant-status-text={state}
                role={state === 'needs_input' || state === 'running' || state === 'error' || state === 'starting'
                  ? 'status'
                  : undefined}
                aria-label={state === 'needs_input' || state === 'running' || state === 'error' || state === 'starting'
                  ? statusTitle
                  : undefined}
              >
                {state === 'running' && <AssistantWorkingDots />}
                {secondLine}
              </span>
            </span>
          </button>
          <span className={css.sidebarAssistantActions}>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpenId(undefined) }}
            align="end"
            side="bottom"
            dense
            portal
            className={css.sidebarAssistantMore ?? ''}
            items={assistantMenuEntries(instance, unread)}
            onSelect={id => {
              setMenuOpenId(undefined)
              if (id === 'checkpoint') openCheckpoint(instance)
              else if (id === 'settings') openSettings(instance)
              else if (id === 'pin') void togglePin(instance)
              else if (id === 'group') {
                setGroupDialog({
                  kind: 'move',
                  title: `移动「${name}」到分组`,
                  ...(instance.group === undefined ? {} : { current: instance.group }),
                  apply: async group => {
                    await callAgentTeam('assistant.instance.update', {
                      id: instance.id,
                      // An empty string is the update schema's "clear it".
                      value: { group: group ?? '' },
                    })
                    await load()
                  },
                })
              }
              else if (id === 'coordinator') void toggleCoordinator(instance)
              else if (id === 'tasks') openTasks(instance)
              else if (id === 'new-thread') void createConversation(instance)
              else if (id === 'new-thread-folder') void createConversationInFolder(instance)
              else if (id === 'mark-read') setReadState(markAssistantRead(instance.id))
              else if (id === 'mark-unread') setReadState(markAssistantUnread(instance.id))
              else if (id === 'open-main') void openAssistant(instance)
            }}
            anchor={(
              <Tooltip label="更多操作" delayMs={400}>
                <button
                  type="button"
                  className={`${css.sidebarTeamManage} ${css.sidebarAssistantMoreButton}`}
                  aria-label={`更多操作 ${name}`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => {
                    setMenuOpenId(current => current === instance.id ? undefined : instance.id)
                  }}
                >
                  <IconEllipsisOutlineRegular size={14} />
                </button>
              </Tooltip>
            )}
          />
          </span>
        </div>
        {threadsOpen && (
          <div
            id={`dsh-team-mode-assistant-threads-${instance.id}`}
            data-dsh-assistant-threads
          >
            {threadErrorForRow !== undefined && (
              <div className={css.sidebarAssistantThreads}>
                <div className={css.sidebarAssistantThreadError} role="alert">
                  {threadErrorForRow}
                </div>
              </div>
            )}
            {hasConversations && (
              <AssistantConversationList
                name={name}
                rows={conversationRows}
                onOpen={sessionId => {
                  // Navigation only: open the Session, keep the row selected.
                  selectAssistant(instance.id)
                  openSession(sessionId)
                }}
                onArchive={sessionId => { void archiveConversation(instance, sessionId) }}
              />
            )}
            {threadTasks.length > 0 && (
              <div className={css.sidebarAssistantThreads}>
                {threadTasks.map(task => {
                  const openingTask = openingTaskId === task.id
                  return (
                    <button
                      key={task.id}
                      type="button"
                      className={css.sidebarAssistantThreadRow}
                      data-dsh-assistant-task={task.id}
                      data-dsh-assistant-task-status={task.status}
                      title={`${task.title} · ${assistantTaskStatusLabel(task.status)}`}
                      disabled={openingTask}
                      aria-busy={openingTask}
                      onClick={() => { void openThreadTask(instance, task) }}
                    >
                      <span className={css.sidebarAssistantThreadCopy}>
                        <span className={css.sidebarAssistantThreadTitle}>{task.title}</span>
                        <span className={css.sidebarAssistantThreadMeta}>
                          <span className={`${css.assistantTaskStatus} ${taskStatusClass(task.status)}`}>
                            {assistantTaskStatusLabel(task.status)}
                          </span>
                          <span className={css.sidebarAssistantThreadTime}>
                            {openingTask ? '打开中' : relativeAssistantTime(task.updatedAt)}
                          </span>
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // The pinned row exists only when the field says so; no name or template guess.
  const coordinator = useMemo(() => coordinatorAssistant(instances), [instances])

  return (
    <>
      {/* The coordinator leads the team list as an ordinary row: it scrolls with
          the list and borrows the 单聊 row's own markup and height. */}
      {coordinator !== undefined && (
        <div className={css.sidebarCoordinatorRow} data-dsh-assistant-coordinator-row>
          {renderAssistantRow(coordinator)}
        </div>
      )}
      {children}
      <section
        className={`${css.sidebarTeamSection} ${css.sidebarAssistantSection}`}
        aria-label="单聊"
        data-dsh-assistant-section
        data-dsh-assistant-display-mode={mode}
      >
        {notice !== undefined && (
          <div className={css.sidebarAssistantNotice} role="status" data-dsh-assistant-notice>
            <span className={css.sidebarAssistantNoticeBadge} aria-hidden="true">!</span>
            <button
              type="button"
              className={css.sidebarAssistantNoticeOpen}
              onClick={() => {
                const entry = allPending.find(item => item.task.id === notice.taskId)
                setNotice(undefined)
                if (entry !== undefined) {
                  selectAssistant(notice.assistantId)
                  void openThreadTask(entry.instance, entry.task)
                }
              }}
              title={`${notice.name} · ${notice.title} · 打开任务`}
            >
              <span className={css.sidebarAssistantNoticeTitle}>{notice.title}</span>
              <span className={css.sidebarAssistantNoticeMeta}>{notice.name} · 待你处理</span>
            </button>
            <button
              type="button"
              className={css.sidebarAssistantNoticeClose}
              onClick={() => { setNotice(undefined) }}
              aria-label="关闭通知"
            >
              <IconCloseFillRegular size={11} />
            </button>
          </div>
        )}
        {attentionItems.length > 0 && (
          <div
            className={css.sidebarAssistantAttention}
            role="region"
            aria-label="待你处理的助手任务"
            data-dsh-assistant-attention
          >
            <div className={css.sidebarAssistantAttentionTitle}>
              <span>待你处理</span>
              <span className={css.sidebarAssistantAttentionCount}>{attentionItems.length}</span>
            </div>
            {attentionItems.map(({ instance, task }) => {
              const interactions = interactionsByTask[task.id] ?? []
              const approval = interactions.find(item => item.kind === 'approval')
              return (
                <div key={task.id} className={css.sidebarAssistantAttentionItem}>
                  <button
                    type="button"
                    className={css.sidebarAssistantAttentionRow}
                    onClick={() => { void openThreadTask(instance, task) }}
                    title={`${task.title} · ${assistantInstanceLabel(instance)} · 待你处理`}
                  >
                    <span className={css.sidebarAssistantAttentionBadge} aria-hidden="true">!</span>
                    <span className={css.sidebarAssistantAttentionCopy}>
                      <span className={css.sidebarAssistantAttentionTask}>{task.title}</span>
                      <span className={css.sidebarAssistantAttentionMeta}>
                        {assistantInstanceLabel(instance)} · {approval === undefined ? '待你处理' : '请求审批'}
                      </span>
                    </span>
                  </button>
                  {approval !== undefined && (
                    <div className={css.sidebarAssistantApproval}>
                      <div className={css.sidebarAssistantApprovalTool}>
                        审批 · <span className={css.sidebarAssistantApprovalName}>{approval.toolName}</span>
                      </div>
                      {approval.reason !== undefined && approval.reason.trim() !== '' && (
                        <div className={css.sidebarAssistantApprovalReason}>{approval.reason}</div>
                      )}
                      {approvalHistoryState[approval.toolName] !== undefined && (
                        <div className={css.sidebarAssistantApprovalHistory}>
                          上次：{approvalDecisionLabel(approvalHistoryState[approval.toolName]!)}
                        </div>
                      )}
                      <div className={css.sidebarAssistantApprovalActions}>
                        <button
                          type="button"
                          className={css.sidebarAssistantApprovalAllow}
                          disabled={interactionBusy === approval.id}
                          onClick={() => { void respondInteraction(task.id, approval.id, 'allowed-once', approval.toolName) }}
                        >
                          允许一次
                        </button>
                        <button
                          type="button"
                          className={css.sidebarAssistantApprovalDeny}
                          disabled={interactionBusy === approval.id}
                          onClick={() => { void respondInteraction(task.id, approval.id, 'rejected', approval.toolName) }}
                        >
                          拒绝
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {approvalFeedback !== undefined && (
              <div className={css.sidebarAssistantApprovalFeedback} role="status">{approvalFeedback}</div>
            )}
            {interactionError !== undefined && (
              <div className={css.sidebarAssistantInteractionError} role="alert">{interactionError}</div>
            )}
          </div>
        )}
        <div id="dsh-team-mode-assistant-list" className={css.sidebarTeamList}>
          {message !== undefined && (
            <div className={css.sidebarTeamError} role="alert">
              <span>{instances.length === 0 ? `助手数据加载失败：${message}` : message}</span>
              {instances.length === 0 && (
                <button
                  type="button"
                  className={css.sidebarTeamRetry}
                  onClick={() => { void load() }}
                >
                  重试
                </button>
              )}
            </div>
          )}
          {!loaded
            ? (
              <div className={css.sidebarTeamEmpty} role="status" data-dsh-assistant-loading>
                正在加载助手…
              </div>
              )
            : visible.length === 0
              ? message !== undefined && instances.length === 0
                ? null
                : query.trim() !== ''
                  ? <div className={css.sidebarTeamEmpty}>没有匹配的助手</div>
                  : (
                    <>
                      <div className={css.sidebarAssistantEmpty}>
                        <div className={css.sidebarTeamEmpty}>还没有助手</div>
                        <button
                          type="button"
                          className={`${css.sidebarTeamRowWrap} ${css.sidebarTeamEmptyRow}`}
                          onClick={openCreate}
                        >
                          <span className={css.sidebarTeamSlot} aria-hidden="true">
                            <IconPlusOutlineRegular size={16} />
                          </span>
                          <span className={css.sidebarTeamEmptyTitle}>新建助手</span>
                        </button>
                      </div>
                    </>
                    )
              : (
                <>
                  {partitions.map(partition => {
                    const group = partition.group
                    return (
                      <SidebarGroupPartition
                        key={partition.id}
                        label={sidebarPartitionLabel(group, partitioned, '默认分组')}
                        count={partition.items.length}
                        collapsed={collapsedPartitions[partition.id] === true}
                        onToggle={() => { togglePartition(partition.id) }}
                        drag={drag.partition({ ...(group === undefined ? {} : { group }) })}
                        menuItems={sidebarGroupActionItems(groups, group)}
                        onSelect={(id: string) => { void selectGroupMenu(group, id) }}
                      >
                        {partition.items.map(renderAssistantRow)}
                      </SidebarGroupPartition>
                    )
                  })}
                </>
              )}
          {archived.length > 0 && (
            <div data-dsh-assistant-archived>
              <button
                type="button"
                className={`${css.sidebarTeamRowWrap} ${css.sidebarTeamEmptyRow}`}
                aria-expanded={archivedOpen}
                aria-label={`已归档的助手 ${archived.length}`}
                onClick={() => { setArchivedOpen(open => !open) }}
              >
                <span className={css.sidebarTeamSlot} aria-hidden="true">
                  <IconArchiveOutlineRegular size={16} />
                </span>
                <span className={css.sidebarTeamEmptyTitle}>已归档 ({archived.length})</span>
              </button>
              {archivedOpen && archived.map(instance => (
                <button
                  key={instance.id}
                  type="button"
                  className={`${css.sidebarTeamRowWrap} ${css.sidebarTeamEmptyRow}`}
                  data-dsh-assistant-archived-row={instance.id}
                  aria-label={`恢复 ${assistantInstanceName(instance)}`}
                  onClick={() => { void restoreAssistant(instance) }}
                >
                  <span className={css.sidebarTeamSlot} aria-hidden="true">
                    {assistantInstanceName(instance).slice(0, 1).toLocaleUpperCase()}
                  </span>
                  <span className={css.sidebarTeamEmptyTitle}>
                    {assistantInstanceLabel(instance)} · 恢复
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <AssistantCreateDialog
          open={createOpen}
          onClose={() => { setCreateOpen(false) }}
          openSession={openSession}
          onCreated={load}
          onAddWorkspace={pickWorkspace}
        />
        {taskAssistant !== undefined && (
          <AssistantTaskDialog
            open={taskDialogOpen}
            assistant={taskAssistant}
            tasks={tasks}
            onClose={() => { setTaskDialogOpen(false) }}
            openSession={openSession}
          />
        )}
        {checkpointAssistant !== undefined && (
          <AssistantCheckpointDialog
            open={checkpointDialogOpen}
            assistant={checkpointAssistant}
            onClose={() => { setCheckpointDialogOpen(false) }}
            openSession={openSession}
          />
        )}
        <SidebarGroupDialogs
          dialog={groupDialog}
          groups={groups}
          onClose={() => { setGroupDialog(undefined) }}
          onListChanged={adoptGroups}
          onChanged={() => { void load() }}
        />
      </section>
    </>
  )
}
