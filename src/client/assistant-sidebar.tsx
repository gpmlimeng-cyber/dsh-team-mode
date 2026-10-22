import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChecklistOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseFillRegular,
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconNewChatOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSlidersTwoOutlineRegular,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { selectAssistant, useAgentTeamUi } from './store.js'
import { AssistantCreateDialog } from './assistant-dialogs.js'
import {
  setAssistantDisplayMode,
  useAssistantDisplayMode,
} from './assistant-display-mode.js'
import { AssistantSettingsDialog } from './assistant-settings-dialog.js'
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
  assistantInstanceName,
  assistantRowActivity,
  assistantRowStatusText,
  assistantRowStatusTitle,
  assistantTaskStatusLabel,
  assistantThreadTasks,
  relativeAssistantTime,
  visibleAssistantInstances,
} from './assistant-instances.js'
import {
  readAssistantThreadExpanded,
  writeAssistantThreadExpanded,
} from './assistant-thread-state.js'
import { MemberAvatar } from './member-avatar.js'
import css from './AgentTeam.module.css'
import type { AssistantInstance, AssistantSession } from '../domain/types.js'
import type { AssistantInstanceView, PendingInteractionView } from '../transport/contracts.js'

const ASSISTANT_EXPANDED_KEY = 'dsh-team-mode:assistant-expanded'

function readAssistantExpanded(): boolean {
  try {
    return window.localStorage.getItem(ASSISTANT_EXPANDED_KEY) !== 'false'
  } catch {
    return true
  }
}

function writeAssistantExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(ASSISTANT_EXPANDED_KEY, String(expanded))
  } catch {
    // Restricted WebViews may reject storage; the current session still works.
  }
}

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

/**
 * The “单聊” section: one row per Assistant instance. Opening a row ensures the
 * instance's main Session in the Host and hands off to the shipped conversation
 * view; Phase 0 deliberately has no assistant-specific chat UI.
 */
export function AssistantSidebarSection({
  openSession,
}: {
  openSession: (sessionId: string) => void
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
  const mode = useAssistantDisplayMode()
  const [expanded, setExpanded] = useState(readAssistantExpanded)
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [threadOpenById, setThreadOpenById] = useState<Record<string, boolean>>({})
  const [openingId, setOpeningId] = useState<string>()
  const [openingTaskId, setOpeningTaskId] = useState<string>()
  const [menuOpenId, setMenuOpenId] = useState<string>()
  const [taskAssistantId, setTaskAssistantId] = useState<string>()
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  const [settingsAssistant, setSettingsAssistant] = useState<AssistantInstance>()
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [listError, setListError] = useState<string>()
  const [error, setError] = useState<string>()
  const [threadError, setThreadError] = useState<{ assistantId: string; message: string }>()

  useEffect(() => () => {
    if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current)
    for (const notification of browserNotificationsRef.current.values()) notification.close()
    browserNotificationsRef.current.clear()
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const [instancePage, taskPage] = await Promise.all([
        callAgentTeam('assistant.instance.list'),
        callAgentTeam('assistant.task.list', undefined),
      ])
      setInstances(instancePage.items)
      setTasks(taskPage.items)
      setListError(undefined)
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    return subscribeAgentTeam(() => { void load() }, () => {
      setListError('助手事件连接已断开，正在重连')
    }, () => { void load() })
  }, [load])

  const visible = useMemo(
    () => visibleAssistantInstances(instances, query),
    [instances, query],
  )

  const allPending = useMemo(
    () => instances.flatMap(instance => assistantThreadTasks(tasks, instance)
      .filter(task => task.status === 'needs_input')
      .map(task => ({ instance, task }))),
    [tasks, instances],
  )

  const attentionItems = useMemo(
    () => allPending.filter(item => visible.some(instance => instance.id === item.instance.id)),
    [allPending, visible],
  )

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

  const attentionSummary = useMemo(() => {
    let waiting = 0
    let working = 0
    let queued = 0
    let unread = 0
    for (const instance of visible) {
      const activity = assistantRowActivity(tasks, instance)
      if (activity.status === 'needs_input') waiting += 1
      else if (activity.status === 'running') working += 1
      else if (activity.status === 'queued') queued += 1
      if (isAssistantUnread(instance, readState)) unread += 1
    }
    return { waiting, working, queued, unread }
  }, [tasks, visible, readState])

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
      name: assistantInstanceName(first.instance),
      title: first.task.title,
    })
    // Desktop notification is best-effort: never prompt for permission here,
    // and never block the in-app notice if the WebView has no Notification.
    try {
      if (typeof window !== 'undefined' && 'Notification' in window && window.Notification.permission === 'granted') {
        const notification = new window.Notification('助手需要你处理', {
          body: `${assistantInstanceName(first.instance)} · ${first.task.title}`,
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

  const summaryText = [
    attentionSummary.waiting > 0 ? `${attentionSummary.waiting} 待处理` : '',
    attentionSummary.working > 0 ? `${attentionSummary.working} 思考中` : '',
    attentionSummary.queued > 0 ? `${attentionSummary.queued} 排队` : '',
    attentionSummary.unread > 0 ? `${attentionSummary.unread} 未读` : '',
  ].filter(Boolean).join(' · ')

  const taskAssistant = useMemo(
    () => (taskAssistantId === undefined
      ? undefined
      : instances.find(item => item.id === taskAssistantId)),
    [instances, taskAssistantId],
  )

  const toggle = (): void => {
    setExpanded(current => {
      const next = !current
      writeAssistantExpanded(next)
      return next
    })
  }

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
    setSettingsAssistant(instance)
    setSettingsDialogOpen(true)
    setMenuOpenId(undefined)
  }

  async function openAssistant(instance: AssistantInstance): Promise<void> {
    if (openingId !== undefined) return
    selectAssistant(instance.id)
    setReadState(markAssistantRead(instance.id))
    setOpeningId(instance.id)
    setError(undefined)
    try {
      const result = await callAgentTeam('assistant.instance.ensure', { id: instance.id })
      openSession(result.sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOpeningId(undefined)
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

  function toggleThreads(instance: AssistantInstance, open: boolean): void {
    const next = !open
    writeAssistantThreadExpanded(instance.id, next)
    setThreadOpenById(current => ({ ...current, [instance.id]: next }))
    setThreadError(current => (current?.assistantId === instance.id ? undefined : current))
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

  return (
    <section
      className={`${css.sidebarTeamSection} ${css.sidebarAssistantSection}`}
      aria-label="单聊"
      data-dsh-assistant-section
      data-dsh-assistant-display-mode={mode}
    >
      <div className={css.sidebarTeamHeader} data-dsh-assistant-header>
        {searchExpanded
          ? (
            <div className={css.sidebarTeamSearch}>
              <IconSearchOutlineRegular size={14} />
              <input
                autoFocus
                type="search"
                value={query}
                placeholder="搜索助手"
                aria-label="搜索助手"
                onChange={event => { setQuery(event.target.value) }}
                onKeyDown={event => {
                  if (event.key !== 'Escape') return
                  setQuery('')
                  setSearchExpanded(false)
                }}
              />
              <button
                type="button"
                className={css.sidebarTeamSearchClear}
                aria-label="清除搜索"
                onClick={() => { setQuery(''); setSearchExpanded(false) }}
              >
                <IconCloseFillRegular size={12} />
              </button>
            </div>
            )
          : (
            <>
              <button
                type="button"
                className={css.sidebarTeamToggle}
                onClick={toggle}
                aria-expanded={expanded}
                aria-controls="dsh-team-mode-assistant-list"
              >
                <span className={css.sidebarTeamTitle} data-dsh-assistant-title>单聊</span>
                <IconChevronRightOutlineRegular
                  size={12}
                  className={`${css.sidebarTeamChevron} ${expanded ? css.sidebarTeamChevronOpen : ''}`}
                />
              </button>
              {summaryText !== '' && (
                <span
                  className={css.sidebarAssistantSummary}
                  aria-live="polite"
                  aria-label={summaryText}
                  title={summaryText}
                >
                  {summaryText}
                </span>
              )}
              <div className={css.sidebarTeamSearchSlot}>
                <Tooltip label="搜索助手" delayMs={400}>
                  <button
                    type="button"
                    className={`${css.sidebarTeamIconButton} ${css.sidebarTeamSearchButton}`}
                    onClick={() => { setSearchExpanded(true) }}
                    aria-label="搜索助手"
                  >
                    <IconSearchOutlineRegular size={14} />
                  </button>
                </Tooltip>
              </div>
              <div className={css.sidebarTeamHeaderActions}>
                <Menu
                  open={modeMenuOpen}
                  onClose={() => { setModeMenuOpen(false) }}
                  align="end"
                  dense
                  portal
                  items={[
                    { type: 'label', id: 'display-mode-label', text: '显示方式' },
                    { id: 'mode-simple', label: '简洁：每个助手一行' },
                    { id: 'mode-advanced', label: '进阶：显示任务线程' },
                  ]}
                  selectedIds={[mode === 'simple' ? 'mode-simple' : 'mode-advanced']}
                  onSelect={id => {
                    setModeMenuOpen(false)
                    if (id === 'mode-simple') setAssistantDisplayMode('simple')
                    else if (id === 'mode-advanced') setAssistantDisplayMode('advanced')
                  }}
                  anchor={(
                    <Tooltip label="显示方式" delayMs={400}>
                      <button
                        type="button"
                        className={css.sidebarTeamIconButton}
                        aria-label="显示方式"
                        aria-haspopup="menu"
                        aria-expanded={modeMenuOpen}
                        data-dsh-assistant-display-options
                        onClick={() => { setModeMenuOpen(current => !current) }}
                      >
                        <IconSlidersTwoOutlineRegular size={14} />
                      </button>
                    </Tooltip>
                  )}
                />
                <Tooltip label="新建单聊助手" delayMs={400}>
                  <button
                    type="button"
                    className={css.sidebarTeamIconButton}
                    onClick={openCreate}
                    aria-label="新建单聊助手"
                    data-dsh-assistant-add
                  >
                    <IconPlusOutlineRegular size={16} />
                  </button>
                </Tooltip>
              </div>
            </>
            )}
      </div>
      {expanded && notice !== undefined && (
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
      {expanded && attentionItems.length > 0 && (
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
                  title={`${task.title} · ${assistantInstanceName(instance)} · 待你处理`}
                >
                  <span className={css.sidebarAssistantAttentionBadge} aria-hidden="true">!</span>
                  <span className={css.sidebarAssistantAttentionCopy}>
                    <span className={css.sidebarAssistantAttentionTask}>{task.title}</span>
                    <span className={css.sidebarAssistantAttentionMeta}>
                      {assistantInstanceName(instance)} · {approval === undefined ? '待你处理' : '请求审批'}
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
      {expanded && (
        <div id="dsh-team-mode-assistant-list" className={css.sidebarTeamList}>
          {message !== undefined && <div className={css.sidebarTeamError} role="alert">{message}</div>}
          {visible.length === 0
            ? query.trim() !== ''
              ? <div className={css.sidebarTeamEmpty}>没有匹配的助手</div>
              : (
                <div className={css.sidebarAssistantEmpty}>
                  <div className={css.sidebarTeamEmpty}>还没有助手</div>
                  <button
                    type="button"
                    className={`${css.sidebarTeamRowWrap} ${css.sidebarTeamEmptyRow}`}
                    onClick={openCreate}
                    aria-label="新建单聊助手"
                  >
                    <span className={css.sidebarTeamSlot} aria-hidden="true">
                      <IconPlusOutlineRegular size={16} />
                    </span>
                    <span className={css.sidebarTeamEmptyTitle}>新建助手</span>
                  </button>
                </div>
                )
            : visible.map(instance => {
                const name = assistantInstanceName(instance)
                const opening = openingId === instance.id
                const active = selectedAssistantId === instance.id
                const menuOpen = menuOpenId === instance.id
                const activity = assistantRowActivity(tasks, instance)
                const statusText = assistantRowStatusText(activity)
                const statusTitle = assistantRowStatusTitle(activity)
                const previewText = instance.preview?.text.trim() ?? ''
                const hasPreview = previewText !== ''
                const activeStatus = activity.status !== 'none'
                const unread = isAssistantUnread(instance, readState)
                const secondLine = activeStatus ? statusText : hasPreview ? previewText : statusText
                const secondLineTitle = activeStatus
                  ? statusTitle
                  : hasPreview
                    ? `${instance.preview?.role === 'user' ? '你' : '助手'}：${previewText}`
                    : statusTitle
                const dotClass = activity.status === 'needs_input'
                  ? css.sidebarAssistantDotWaiting
                  : activity.status === 'running'
                    ? css.sidebarAssistantDotRunning
                    : css.sidebarAssistantDotQueued
                const statusClass = activity.status === 'needs_input'
                  ? css.sidebarAssistantStatusWaiting
                  : activity.status === 'running'
                    ? css.sidebarAssistantStatusRunning
                    : activity.status === 'queued'
                      ? css.sidebarAssistantStatusQueued
                      : css.sidebarAssistantStatusIdle
                // Advanced mode only: the persisted disclosure is read lazily so
                // simple mode never touches thread storage at all.
                const threadTasks = mode === 'advanced'
                  ? assistantThreadTasks(tasks, instance)
                  : []
                const hasThreads = threadTasks.length > 0
                const threadsOpen = hasThreads
                  && (threadOpenById[instance.id] ?? readAssistantThreadExpanded(instance.id))
                const threadErrorForRow = threadError?.assistantId === instance.id
                  ? threadError.message
                  : undefined
                return (
                  <div key={instance.id} className={css.sidebarTeamGroup}>
                    <div
                      className={`${css.sidebarTeamRowWrap} ${css.sidebarAssistantRowWrap} ${active ? css.sidebarTeamRowWrapActive : ''} ${menuOpen ? css.sidebarTeamRowWrapMenuOpen : ''}`}
                      data-dsh-assistant-row
                    >
                      {hasThreads && (
                        <button
                          type="button"
                          className={css.sidebarAssistantThreadToggle}
                          aria-expanded={threadsOpen}
                          aria-controls={threadsOpen
                            ? `dsh-team-mode-assistant-threads-${instance.id}`
                            : undefined}
                          aria-label={threadsOpen
                            ? `收起 ${name} 的任务线程`
                            : `展开 ${name} 的任务线程`}
                          title={threadsOpen ? '收起任务线程' : '展开任务线程'}
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
                        title={`${name} · ${secondLine} · ${instance.assistantSnapshot.model}`}
                      >
                        <span className={css.sidebarAssistantAvatar}>
                          <MemberAvatar
                            name={name}
                            avatar={assistantAvatarSource(instance)}
                            size={34}
                            className={css.sidebarAssistantAvatarShape ?? ''}
                          />
                          {activity.status !== 'none' && (
                            <span
                              className={`${css.sidebarAssistantDot} ${dotClass} ${activity.status === 'needs_input' ? css.sidebarAssistantWaitingBadge : ''}`}
                              data-dsh-assistant-status={activity.status}
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
                            <span className={css.sidebarTeamName}>{name}</span>
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
                                : relativeAssistantTime(instance.preview === undefined
                                  ? instance.updatedAt
                                  : new Date(instance.preview.time).toISOString())}
                            </span>
                          </span>
                          <span
                            className={`${css.sidebarAssistantStatus} ${activeStatus ? statusClass : css.sidebarAssistantPreview}`}
                            title={secondLineTitle}
                            data-dsh-assistant-status-text={activity.status}
                            role={activity.status === 'needs_input' || activity.status === 'running' ? 'status' : undefined}
                            aria-label={activity.status === 'needs_input' || activity.status === 'running' ? statusTitle : undefined}
                          >
                            {activity.status === 'running' && <AssistantWorkingDots />}
                            {secondLine}
                          </span>
                        </span>
                      </button>
                      <span className={css.sidebarAssistantActions}>
                      <Tooltip label={instance.pinned === true ? '取消置顶' : '置顶'} delayMs={400}>
                        <button
                          type="button"
                          className={`${css.sidebarTeamManage} ${instance.pinned === true ? css.sidebarTeamManagePinned : ''}`}
                          onClick={() => { void togglePin(instance) }}
                          aria-label={instance.pinned === true ? `取消置顶 ${name}` : `置顶 ${name}`}
                        >
                          {instance.pinned === true
                            ? <IconPinFillRegular size={14} />
                            : <IconPinOutlineRegular size={14} />}
                        </button>
                      </Tooltip>
                      <Menu
                        open={menuOpen}
                        onClose={() => { setMenuOpenId(undefined) }}
                        align="end"
                        side="bottom"
                        dense
                        portal
                        className={css.sidebarAssistantMore ?? ''}
                        items={[
                          { id: 'settings', label: '助手设置', icon: <IconEditOutlineRegular size={14} /> },
                          { id: 'tasks', label: '查看任务', icon: <IconChecklistOutlineRegular size={14} /> },
                          unread
                            ? { id: 'mark-read', label: '标记已读', icon: <IconChecklistOutlineRegular size={14} /> }
                            : { id: 'mark-unread', label: '标记未读', icon: <IconChecklistOutlineRegular size={14} /> },
                          { id: 'open-main', label: '打开主会话', icon: <IconNewChatOutlineRegular size={14} /> },
                        ]}
                        onSelect={id => {
                          setMenuOpenId(undefined)
                          if (id === 'settings') openSettings(instance)
                          else if (id === 'tasks') openTasks(instance)
                          else if (id === 'mark-read') setReadState(markAssistantRead(instance.id))
                          else if (id === 'mark-unread') setReadState(markAssistantUnread(instance.id))
                          else if (id === 'open-main') void openAssistant(instance)
                        }}
                        anchor={(
                          <Tooltip label="更多操作" delayMs={400}>
                            <button
                              type="button"
                              className={css.sidebarTeamManage}
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
                        className={css.sidebarAssistantThreads}
                        data-dsh-assistant-threads
                      >
                        {threadErrorForRow !== undefined && (
                          <div className={css.sidebarAssistantThreadError} role="alert">
                            {threadErrorForRow}
                          </div>
                        )}
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
                )
              })}
        </div>
      )}
      <AssistantCreateDialog
        open={createOpen}
        onClose={() => { setCreateOpen(false) }}
        openSession={openSession}
        onCreated={load}
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
      {settingsAssistant !== undefined && (
        <AssistantSettingsDialog
          open={settingsDialogOpen}
          assistant={settingsAssistant}
          onClose={() => { setSettingsDialogOpen(false) }}
          onSaved={load}
        />
      )}
    </section>
  )
}
