import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconChevronRightOutlineRegular,
  IconCloseFillRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { AssistantCreateDialog } from './assistant-dialogs.js'
import {
  assistantAvatarSource,
  assistantInstanceName,
  assistantTaskBadge,
  relativeAssistantTime,
  visibleAssistantInstances,
} from './assistant-instances.js'
import { MemberAvatar } from './member-avatar.js'
import css from './AgentTeam.module.css'
import type { AssistantInstance, AssistantSession } from '../domain/types.js'

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
  const [instances, setInstances] = useState<AssistantInstance[]>([])
  const [tasks, setTasks] = useState<AssistantSession[]>([])
  const [expanded, setExpanded] = useState(readAssistantExpanded)
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [openingId, setOpeningId] = useState<string>()
  const [createOpen, setCreateOpen] = useState(false)
  const [listError, setListError] = useState<string>()
  const [error, setError] = useState<string>()

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

  async function openAssistant(instance: AssistantInstance): Promise<void> {
    if (openingId !== undefined) return
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

  const message = error ?? listError

  return (
    <section
      className={`${css.sidebarTeamSection} ${css.sidebarAssistantSection}`}
      aria-label="单聊"
      data-dsh-assistant-section
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
                const badge = assistantTaskBadge(tasks, instance)
                return (
                  <div key={instance.id} className={css.sidebarTeamGroup}>
                    <div className={css.sidebarTeamRowWrap}>
                      <button
                        type="button"
                        className={css.sidebarTeamRow}
                        onClick={() => { void openAssistant(instance) }}
                        disabled={opening}
                        aria-busy={opening}
                        title={`${name} · 单聊 · ${instance.assistantSnapshot.model}`}
                      >
                        <span className={css.sidebarAssistantAvatar} aria-hidden="true">
                          <MemberAvatar
                            name={name}
                            avatar={assistantAvatarSource(instance)}
                            size={18}
                          />
                        </span>
                        <span className={css.sidebarTeamCopy}>
                          <span className={css.sidebarTeamName}>{name}</span>
                        </span>
                        <span className={css.sidebarAssistantKind}>单聊</span>
                        <span className={css.sidebarAssistantMeta}>
                          {badge !== undefined && (
                            <span
                              className={`${css.sidebarAssistantTaskBadge} ${badge.needsInput ? css.sidebarAssistantTaskBadgeWaiting : ''}`}
                              title={badge.needsInput
                                ? `${badge.count} 个任务待确认`
                                : `${badge.count} 个任务进行中`}
                              data-dsh-assistant-task-badge
                            >
                              {badge.needsInput ? '待确认' : `${badge.count} 任务`}
                            </span>
                          )}
                          <span className={css.sidebarTeamTime}>
                            {opening ? '打开中' : relativeAssistantTime(instance.updatedAt)}
                          </span>
                        </span>
                      </button>
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
                    </div>
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
    </section>
  )
}
