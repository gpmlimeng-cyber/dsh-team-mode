import { useCallback, useEffect, useMemo, useState } from 'react'
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
import type { AssistantInstanceView } from '../transport/contracts.js'

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

  async function openThreadTask(
    instance: AssistantInstance,
    task: AssistantSession,
  ): Promise<void> {
    if (openingTaskId !== undefined) return
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
                const secondLine = hasPreview ? previewText : statusText
                const secondLineTitle = hasPreview
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
                        onClick={() => { void openAssistant(instance) }}
                        disabled={opening}
                        aria-busy={opening}
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
                              className={`${css.sidebarAssistantDot} ${dotClass}`}
                              data-dsh-assistant-status={activity.status}
                              title={statusTitle}
                              aria-label={statusTitle}
                              role="img"
                            />
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
                            <span className={css.sidebarTeamTime}>
                              {opening
                                ? '打开中'
                                : relativeAssistantTime(instance.preview === undefined
                                  ? instance.updatedAt
                                  : new Date(instance.preview.time).toISOString())}
                            </span>
                          </span>
                          <span
                            className={`${css.sidebarAssistantStatus} ${hasPreview ? css.sidebarAssistantPreview : statusClass}`}
                            title={secondLineTitle}
                            data-dsh-assistant-status-text={activity.status}
                          >
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
                          { id: 'open-main', label: '打开主会话', icon: <IconNewChatOutlineRegular size={14} /> },
                        ]}
                        onSelect={id => {
                          setMenuOpenId(undefined)
                          if (id === 'settings') openSettings(instance)
                          else if (id === 'tasks') openTasks(instance)
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
