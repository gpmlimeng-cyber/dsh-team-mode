import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconUsersOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconChevronsUpDownOutlineRegular,
  IconClockOutlineRegular,
  IconCloseFillRegular,
  IconEllipsisOutlineRegular,
  IconProjectAddOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconWarningOutlineRegular,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import {
  openCreateTeamDialog,
  openManageTeamDialog,
  selectTeam,
  useAgentTeamUi,
} from './store.js'
import { isTeamExecuting } from './team-status.js'
import { useTeamText } from './team-i18n.js'
import css from './AgentTeam.module.css'
import type { TeamView } from '../transport/contracts.js'

const SIDEBAR_TEAM_EXPANDED_KEY = 'dsh-team-mode:sidebar-expanded'


function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_TEAM_EXPANDED_KEY) !== 'false'
  } catch {
    return true
  }
}

function writeExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_TEAM_EXPANDED_KEY, String(expanded))
  } catch {
    // Restricted WebViews may reject storage; the current session still works.
  }
}

function teamStateLabel(team: TeamView): string {
  if (team.state === 'error') return '异常'
  if (team.state === 'starting') return '启动中'
  if (isTeamExecuting(team)) return '运行中'
  return '空闲'
}

function waitingCount(team: TeamView): number {
  return Object.values(team.members).filter(member => member.lastRuntimeState === 'waiting_approval').length
}

/** The collapsible “团队” section above the native Workspace/Session browser. */
export function SidebarTeamSection({
  openSession,
  openTeamPage,
}: {
  openSession: (sessionId: string) => void
  openTeamPage: (teamId: string) => void
}): JSX.Element {
  const { selectedTeamId } = useAgentTeamUi()
  const t = useTeamText()
  const [teams, setTeams] = useState<TeamView[]>([])
  const [expanded, setExpanded] = useState(readExpanded)
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(() => new Set())
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [activeTaskId, setActiveTaskId] = useState<string>()
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [onlyPending, setOnlyPending] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [sortMode, setSortMode] = useState<'updated' | 'name'>('updated')
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    try {
      const value = await callAgentTeam('team.list')
      setTeams(value.items)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    return subscribeAgentTeam(() => { void load() }, () => {
      setError('团队事件连接已断开，正在重连')
    }, () => { void load() })
  }, [load])

  useEffect(() => {
    if (teams.length === 0) return
    setExpandedTeams(current => current.size > 0 ? current : new Set(teams.map(team => team.id)))
  }, [teams])

  const toggle = (): void => {
    setExpanded(current => {
      const next = !current
      writeExpanded(next)
      return next
    })
  }

  const toggleTeam = (teamId: string): void => {
    setExpandedTeams(current => {
      const next = new Set(current)
      if (next.has(teamId)) next.delete(teamId)
      else next.add(teamId)
      return next
    })
  }

  const visibleTeams = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const filtered = teams.filter(team => {
      if (!showArchived && team.archivedAt !== undefined) return false
      if (onlyPending && waitingCount(team) === 0) return false
      if (normalized === '') return true
      return [team.name, ...Object.values(team.members).map(member => member.displayName)]
        .some(value => value.toLocaleLowerCase().includes(normalized))
    })
    return filtered.sort((a, b) => {
      const pinned = Number(b.pinned === true) - Number(a.pinned === true)
      if (pinned !== 0) return pinned
      return sortMode === 'name'
        ? a.name.localeCompare(b.name, 'zh-CN')
        : Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    })
  }, [onlyPending, query, showArchived, sortMode, teams])

  const openTeam = (team: TeamView): void => {
    selectTeam(team.id)
    setActiveTaskId(undefined)
    setExpandedTeams(current => new Set(current).add(team.id))
    openTeamPage(team.id)
  }

  const openTask = (team: TeamView, task: TeamView['tasks'][string]): void => {
    const owner = task.ownerSlotId === undefined ? undefined : team.members[task.ownerSlotId]
    const sessionId = owner?.sessionId ?? team.members[team.leaderSlotId]?.sessionId
    if (sessionId === undefined) return
    selectTeam(team.id)
    setActiveTaskId(task.id)
    setActiveSessionId(sessionId)
    setExpandedTeams(current => new Set(current).add(team.id))
    openSession(sessionId)
  }

  return (
    <section className={css.sidebarTeamSection} aria-label="团队" data-dsh-team-mode-section>
      <div className={css.sidebarTeamHeader} data-dsh-team-mode-header>
        {searchExpanded ? (
          <div className={css.sidebarTeamSearch}>
            <IconSearchOutlineRegular size={14} />
            <input
              autoFocus
              type="search"
              value={query}
              placeholder="搜索团队或成员"
              aria-label="搜索团队或成员"
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
        ) : (
          <>
            <button
              type="button"
              className={css.sidebarTeamToggle}
              onClick={toggle}
              aria-expanded={expanded}
              aria-controls="dsh-team-mode-sidebar-list"
            >
              <span className={css.sidebarTeamTitle} data-dsh-team-mode-title>{t('sidebar.title')}</span>
              <IconChevronRightOutlineRegular
                size={12}
                className={`${css.sidebarTeamChevron} ${expanded ? css.sidebarTeamChevronOpen : ''}`}
              />
            </button>
            <div className={css.sidebarTeamSearchSlot}>
              <Tooltip label={t('sidebar.search')} delayMs={400}>
                <button
                  type="button"
                  className={`${css.sidebarTeamIconButton} ${css.sidebarTeamSearchButton}`}
                  onClick={() => { setSearchExpanded(true) }}
                  aria-label={t('sidebar.search')}
                >
                  <IconSearchOutlineRegular size={14} />
                </button>
              </Tooltip>
            </div>
            <div className={css.sidebarTeamHeaderActions}>
              <Menu
                open={menuOpen}
                onClose={() => { setMenuOpen(false) }}
                align="end"
                dense
                portal
                items={[
                  { type: 'label', id: 'members-label', text: t('sidebar.members') },
                  { id: 'expand-all', label: t('sidebar.expandAll'), icon: <IconChevronsUpDownOutlineRegular /> },
                  { id: 'collapse-all', label: t('sidebar.collapseAll'), icon: <IconChevronUpOutlineRegular /> },
                  { type: 'separator', id: 'members-separator' },
                  { type: 'label', id: 'filter-label', text: t('sidebar.filter') },
                  { id: 'only-pending', label: t('sidebar.onlyPending'), icon: <IconWarningOutlineRegular /> },
                  { id: 'show-archived', label: t('sidebar.showArchived'), icon: <IconClockOutlineRegular /> },
                  { type: 'separator', id: 'sort-separator' },
                  { type: 'label', id: 'sort-label', text: t('sidebar.sort') },
                  { id: 'sort-updated', label: t('sidebar.sortUpdated'), icon: <IconClockOutlineRegular /> },
                  { id: 'sort-name', label: t('sidebar.sortName'), icon: <IconChevronsUpDownOutlineRegular /> },
                ]}
                selectedIds={[
                  onlyPending ? 'only-pending' : undefined,
                  showArchived ? 'show-archived' : undefined,
                  sortMode === 'name' ? 'sort-name' : 'sort-updated',
                ].filter((id): id is string => id !== undefined)}
                onSelect={id => {
                  if (id === 'expand-all') setExpandedTeams(new Set(teams.map(team => team.id)))
                  else if (id === 'collapse-all') setExpandedTeams(new Set())
                  else if (id === 'only-pending') setOnlyPending(value => !value)
                  else if (id === 'show-archived') setShowArchived(value => !value)
                  else if (id === 'sort-updated' || id === 'sort-name') setSortMode(id === 'sort-name' ? 'name' : 'updated')
                  setMenuOpen(false)
                }}
                anchor={(
                  <Tooltip label={t('sidebar.viewOptions')} delayMs={400}>
                    <button
                      type="button"
                      className={css.sidebarTeamIconButton}
                      aria-label={t('sidebar.viewOptions')}
                      onClick={() => { setMenuOpen(value => !value) }}
                    >
                      <IconSlidersTwoOutlineRegular />
                    </button>
                  </Tooltip>
                )}
              />
              <Tooltip label={t('sidebar.add')} delayMs={400}>
                <button
                  type="button"
                  className={css.sidebarTeamIconButton}
                  onClick={openCreateTeamDialog}
                  aria-label={t('sidebar.add')}
                  data-dsh-team-mode-add
                >
                  <IconProjectAddOutlineRegular size={16} />
                </button>
              </Tooltip>
            </div>
          </>
        )}
      </div>
      {expanded && (
        <div id="dsh-team-mode-sidebar-list" className={css.sidebarTeamList}>
          {error !== undefined && <div className={css.sidebarTeamError} role="alert">{error}</div>}
          {teams.length === 0
            ? (
                <button
                  type="button"
                  className={`${css.sidebarTeamRowWrap} ${css.sidebarTeamEmptyRow}`}
                  onClick={openCreateTeamDialog}
                  aria-label="新建团队"
                >
                  <span className={css.sidebarTeamSlot} aria-hidden="true">
                    <IconPlusOutlineRegular size={16} />
                  </span>
                  <span className={css.sidebarTeamEmptyTitle}>{t('sidebar.add')}</span>
                </button>
              )
            : visibleTeams.length === 0
              ? <div className={css.sidebarTeamEmpty}>{t('sidebar.noMatches')}</div>
              : visibleTeams.map(team => {
              const members = Object.values(team.members)
              const waiting = waitingCount(team)
              const active = selectedTeamId === team.id
              const teamExpanded = expandedTeams.has(team.id)
              return (
                <div key={team.id} className={css.sidebarTeamGroup}>
                  <div className={`${css.sidebarTeamRowWrap} ${active ? css.sidebarTeamRowWrapActive : ''}`}>
                    <button
                      type="button"
                      className={css.sidebarTeamSlot}
                      onClick={() => { toggleTeam(team.id) }}
                      aria-label={teamExpanded ? `收起 ${team.name} 的成员` : `展开 ${team.name} 的成员`}
                      aria-expanded={teamExpanded}
                    >
                      <span className={css.sidebarTeamSlotUsers} aria-hidden="true">
                        <IconUsersOutlineRegular size={16} />
                      </span>
                      <span className={css.sidebarTeamSlotChevron} aria-hidden="true">
                        <IconChevronRightOutlineRegular
                          size={11}
                          className={teamExpanded ? css.sidebarTeamSlotChevronOpen : undefined}
                        />
                      </span>
                    </button>
                    <button
                      type="button"
                      className={css.sidebarTeamRow}
                      onClick={() => { openTeam(team) }}
                      aria-current={active ? 'page' : undefined}
                      title={`${team.name} · ${members.length} 名成员 · ${teamStateLabel(team)}`}
                    >
                      <span className={css.sidebarTeamCopy}>
                        <span className={css.sidebarTeamName}>{team.name}</span>
                      </span>
                      {waiting > 0
                        ? <span className={css.sidebarTeamBadge} title={`${waiting} 个待确认`}>{waiting > 99 ? '99+' : waiting}</span>
                        : isTeamExecuting(team)
                          ? <span className={css.sidebarTeamStateDot} aria-hidden="true" />
                          : null}
                    </button>
                    <Tooltip label={team.pinned === true ? t('sidebar.unpin') : t('sidebar.pin')} delayMs={400}>
                      <button
                        type="button"
                        className={css.sidebarTeamManage}
                        onClick={() => {
                          void callAgentTeam('team.pin', {
                            teamId: team.id,
                            pinned: team.pinned !== true,
                          }, team.revision).catch(cause => {
                            setError(cause instanceof Error ? cause.message : String(cause))
                          })
                        }}
                        aria-label={team.pinned === true ? `取消置顶 ${team.name}` : `置顶 ${team.name}`}
                      >
                        {team.pinned === true ? '★' : '☆'}
                      </button>
                    </Tooltip>
                    <Tooltip label={team.archivedAt === undefined ? t('sidebar.archive') : t('sidebar.restore')} delayMs={400}>
                      <button
                        type="button"
                        className={css.sidebarTeamManage}
                        disabled={team.archivedAt === undefined && team.state !== 'draft'}
                        title={team.archivedAt === undefined && team.state !== 'draft'
                          ? '运行中的团队需先解散，才能归档'
                          : undefined}
                        onClick={() => {
                          void callAgentTeam('team.archive', {
                            teamId: team.id,
                            archived: team.archivedAt === undefined,
                          }, team.revision).catch(cause => {
                            setError(cause instanceof Error ? cause.message : String(cause))
                          })
                        }}
                        aria-label={team.archivedAt === undefined ? `归档 ${team.name}` : `恢复 ${team.name}`}
                      >
                        {team.archivedAt === undefined ? '⌄' : '↺'}
                      </button>
                    </Tooltip>
                    <Tooltip label={t('sidebar.manage')} delayMs={400}>
                      <button
                        type="button"
                        className={css.sidebarTeamManage}
                        onClick={() => { openManageTeamDialog(team.id) }}
                        aria-label={`管理 ${team.name}`}
                      >
                        <IconEllipsisOutlineRegular size={13} />
                      </button>
                    </Tooltip>
                  </div>
                  {teamExpanded && (
                    <div className={css.sidebarTaskList}>
                      {Object.values(team.tasks)
                        .filter(task => task.status !== 'cancelled')
                        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
                        .map(task => {
                          const owner = task.ownerSlotId === undefined ? undefined : team.members[task.ownerSlotId]
                          const taskActive = activeTaskId === task.id
                          const pending = task.status === 'pending' || task.status === 'assigned'
                          const running = task.status === 'running'
                          const done = task.status === 'completed'
                          return (
                            <button
                              key={task.id}
                              type="button"
                              className={`${css.sidebarTaskRow} ${taskActive ? css.sidebarTaskRowActive : ''}`}
                              onClick={() => { openTask(team, task) }}
                              aria-current={taskActive ? 'page' : undefined}
                              title={`${task.title} · ${task.status}${owner === undefined ? '' : ` · ${owner.displayName}`}`}
                            >
                              <span
                                className={`${css.sidebarTaskDot} ${running ? css.sidebarTaskDotRunning : ''} ${pending ? css.sidebarTaskDotPending : ''} ${done ? css.sidebarTaskDotDone : ''}`}
                                aria-hidden="true"
                              />
                              <span className={css.sidebarTaskTitle}>{task.title}</span>
                              {owner !== undefined && <span className={css.sidebarTaskOwner}>{owner.displayName}</span>}
                            </button>
                          )
                        })}
                      {Object.values(team.tasks).filter(task => task.status !== 'cancelled').length === 0 && (
                        <div className={css.sidebarTaskEmpty}>暂无任务</div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
        </div>
      )}
    </section>
  )
}


const SIDEBAR_HOST_ID = 'dsh-team-mode-sidebar-host'

/**
 * Additive mount for the “团队” section above the shipped Workspace browser.
 * The `sidebar.workspaces` slot is single and its occupant owns a private
 * store/hook contract, so we do not replace it: we insert one stable host node
 * before its DOM anchor and portal the section into it.
 */
export function SidebarPortal({
  openSession,
  openTeamPage,
}: {
  openSession: (sessionId: string) => void
  openTeamPage: (teamId: string) => void
}): JSX.Element | null {
  const [host, setHost] = useState<HTMLElement>()

  useEffect(() => {
    let current: HTMLElement | undefined
    let scheduled = false
    let observer: MutationObserver | undefined
    let resize: ResizeObserver | undefined
    let observedContainer: HTMLElement | undefined

    const anchorElement = (): HTMLElement | null => (
      document.querySelector('[data-slot="sidebar.workspaces"]') as HTMLElement | null
    )

    const ensure = (): void => {
      const anchor = anchorElement()
      if (anchor === null) return
      // The team section belongs inside the shipped WorkspaceBrowser root,
      // not beside the `sidebar.workspaces` anchor: that anchor is a
      // `display:contents` slot, so a sibling would sit outside the browser's
      // right padding and never line up with its “工作区” header.
      const container = (anchor.firstElementChild as HTMLElement | null)
        ?? (anchor.querySelector('[class*="_root"]') as HTMLElement | null)
      if (container === null) return
      let element = document.getElementById(SIDEBAR_HOST_ID) as HTMLElement | null
      if (element === null || !element.isConnected) {
        element = document.createElement('div')
        element.id = SIDEBAR_HOST_ID
        element.className = css.sidebarTeamHost ?? ''
        element.setAttribute('data-dsh-team-mode', 'sidebar')
        container.insertBefore(element, container.firstChild)
      } else {
        element.className = css.sidebarTeamHost ?? ''
        if (element.parentElement !== container || container.firstChild !== element) {
          container.insertBefore(element, container.firstChild)
        }
      }
      const width = container.getBoundingClientRect().width
      element.style.display = width > 0 && width < 80 ? 'none' : ''
      if (current !== element) {
        current = element
        setHost(element)
      }
      if (resize === undefined || observedContainer !== container) {
        resize?.disconnect()
        resize = new ResizeObserver(() => { schedule() })
        resize.observe(container)
        observedContainer = container
      }
    }

    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      window.requestAnimationFrame(() => {
        scheduled = false
        ensure()
      })
    }

    ensure()
    observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', schedule)
    return () => {
      observer?.disconnect()
      resize?.disconnect()
      window.removeEventListener('resize', schedule)
      current?.remove()
    }
  }, [])

  return host === undefined ? null : createPortal(<SidebarTeamSection openSession={openSession} openTeamPage={openTeamPage} />, host)
}
