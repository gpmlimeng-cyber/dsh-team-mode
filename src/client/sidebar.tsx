import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  IconArchiveOutlineRegular,
  IconChecklistOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronsUpDownOutlineRegular,
  IconClockOutlineRegular,
  IconCloseFillRegular,
  IconEllipsisOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconProjectAddOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconWarningOutlineRegular,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { AssistantSidebarSection } from './assistant-sidebar.js'
import { MemberAvatar } from './member-avatar.js'
import {
  openCreateTeamDialog,
  openManageTeamDialog,
  reportNavigationError,
  selectTeam,
  useAgentTeamUi,
} from './store.js'
import {
  compareTeamSidebar,
  recentTeamTasks,
  rosterSubtitle,
  teamRosterRows,
  teamScopeCounts,
  teamSidebarStatusText,
  teamSidebarSummary,
  type TeamRosterRow,
} from './team-sidebar-data.js'
import { useTeamText } from './team-i18n.js'
import { TEAM_TASK_CREATE_HINT } from './labels.js'
import { TEAM_AVATAR_TILE_COUNT, teamAvatarColor, teamAvatarTiles } from './team-avatar.js'
import { AnimatedModal } from './shared.js'
import {
  SURFACE_MODE_KEY,
  parseSurfaceMode,
  readSurfaceMode,
  writeSurfaceMode,
  type SurfaceMode,
} from './surface-mode.js'
import css from './AgentTeam.module.css'
import type { TeamView } from '../transport/contracts.js'
import type { AssistantInstance } from '../domain/types.js'
import { LeaderMark } from './team-member-chrome.js'
import { assistantAvatarSource, assistantInstanceName, coordinatorAssistant } from './assistant-instances.js'
import { movedGroupOrder, sidebarPartitions, useSidebarGroups } from './sidebar-groups.js'
import {
  SidebarGroupCreateRow,
  SidebarGroupDialogs,
  SidebarGroupPartition,
  sidebarDragSwallowsClick,
  sidebarGroupMenuItems,
  useSidebarDrag,
  type SidebarGroupDialog,
} from './sidebar-group-ui.js'

const SIDEBAR_TEAM_EXPANDED_KEY = 'dsh-team-mode:sidebar-expanded'

const SURFACE_MODE_EVENT = 'dsh-team-mode:surface-mode-change'

/** localStorage read; a restricted WebView simply has no stored mode. */
function surfaceStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

let currentSurfaceMode: SurfaceMode | undefined
const surfaceModeListeners = new Set<() => void>()

function publishSurfaceMode(next: SurfaceMode): void {
  if (currentSurfaceMode === next) return
  currentSurfaceMode = next
  for (const listener of surfaceModeListeners) listener()
}

function getSurfaceMode(): SurfaceMode {
  currentSurfaceMode ??= readSurfaceMode(surfaceStorage())
  return currentSurfaceMode
}

function syncSurfaceModeFromStorage(): void {
  publishSurfaceMode(readSurfaceMode(surfaceStorage()))
}

function subscribeSurfaceMode(listener: () => void): () => void {
  surfaceModeListeners.add(listener)
  if (typeof window === 'undefined') return () => { surfaceModeListeners.delete(listener) }
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== SURFACE_MODE_KEY) return
    syncSurfaceModeFromStorage()
  }
  const onModeChange = (event: Event): void => {
    const detail = typeof CustomEvent !== 'undefined' && event instanceof CustomEvent
      ? event.detail
      : undefined
    publishSurfaceMode(typeof detail === 'string' ? parseSurfaceMode(detail) : readSurfaceMode(surfaceStorage()))
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(SURFACE_MODE_EVENT, onModeChange)
  return () => {
    surfaceModeListeners.delete(listener)
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(SURFACE_MODE_EVENT, onModeChange)
  }
}

/** Persist the mode and notify every mounted surface; never reloads the plugin. */
export function setSurfaceMode(mode: SurfaceMode): void {
  const next = parseSurfaceMode(mode)
  currentSurfaceMode = next
  writeSurfaceMode(surfaceStorage(), next)
  for (const listener of surfaceModeListeners) listener()
  try {
    window.dispatchEvent(new CustomEvent(SURFACE_MODE_EVENT, { detail: next }))
  } catch {
    // A blocked event dispatch never blocks the already-updated local state.
  }
}

/** Current surface mode; `team` is the product default when nothing is stored. */
export function useSurfaceMode(): SurfaceMode {
  return useSyncExternalStore(subscribeSurfaceMode, getSurfaceMode, () => 'team' as const)
}

/** Click the shipped control whose accessible name matches, so DeepSeek mode
 *  behaves exactly like the native UI instead of reimplementing it. */
function clickNativeAction(pattern: RegExp): boolean {
  const scope = document.querySelector<HTMLElement>('[class*="_regionArea"]')
    ?? document.querySelector<HTMLElement>('[class*="_root"]')
  if (scope === null) return false
  const target = Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"]'))
    .find((node) => {
      const name = `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''}`
      return pattern.test(name)
    })
  if (target === undefined) return false
  target.click()
  return true
}

/** DeepSeek mode: start a native 新会话. */
function startNativeSession(): void {
  document.querySelector<HTMLElement>('[class*="_newSession"]')?.click()
}

/** DeepBot mode: open the coordinator's session, else the first assistant's. */
async function startStewardSession(open: (sessionId: string) => void): Promise<void> {
  try {
    const value = await callAgentTeam('assistant.instance.list')
    const instances = value.items
    const steward = coordinatorAssistant(instances) ?? instances[0]
    if (steward === undefined) return
    const result = await callAgentTeam('assistant.instance.ensure', { id: steward.id })
    open(result.sessionId)
  } catch {
    // Opening a session is user-visible when it fails; a silent retry is worse
    // than leaving the sidebar untouched.
  }
}

/**
 * Brand-shaped mode control: the current surface is bold text with a caret, so
 * the row reads as the product mark. The popover is the shipped `Menu`
 * primitive, which keeps its colours and metrics identical to the rest of the
 * sidebar instead of introducing a second menu style.
 */
function SurfaceModeSwitch({
  mode,
  onChange,
}: {
  mode: SurfaceMode
  onChange: (mode: SurfaceMode) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const options = [
    { id: 'native' as const, label: 'DeepSeek', hint: '原生界面' },
    { id: 'team' as const, label: 'DeepBot', hint: '团队模式' },
  ]
  const current = options.find(option => option.id === mode) ?? options[0]!

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={options.map(option => ({
        id: option.id,
        label: (
          <span className={css.brandModeItem}>
            <span className={css.brandModeItemLabel}>{option.label}</span>
            <span className={css.brandModeItemHint}>{option.hint}</span>
          </span>
        ),
      }))}
      selectedId={mode}
      onSelect={(id) => {
        onChange(id as SurfaceMode)
        setOpen(false)
      }}
      align="start"
      side="bottom"
      anchor={(
        <button
          type="button"
          className={css.brandModeTrigger}
          aria-label={`界面模式：${current.label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          data-dsh-surface-switch
          data-dsh-surface-mode={mode}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className={css.brandModeLabel}>{current.label}</span>
          <IconChevronDownOutlineRegular className={css.brandModeCaret} />
        </button>
      )}
    />
  )
}


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

const SIDEBAR_ROSTER_KEY = 'dsh-team-mode:roster-expanded'

/** One stored roster disclosure per team; phones start collapsed. */
function rosterExpandedDefault(): boolean {
  try {
    return !window.matchMedia('(max-width: 420px)').matches
  } catch {
    return true
  }
}

function readRosterExpanded(teamId: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(`${SIDEBAR_ROSTER_KEY}:${teamId}`)
    return stored === null ? fallback : stored !== 'false'
  } catch {
    return fallback
  }
}

function writeRosterExpanded(teamId: string, expanded: boolean): void {
  try {
    window.localStorage.setItem(`${SIDEBAR_ROSTER_KEY}:${teamId}`, String(expanded))
  } catch {
    // Restricted WebViews may reject storage; the current session still works.
  }
}

function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''
  const diff = Math.max(0, Date.now() - timestamp)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/** The collapsible “群聊” section above the native Workspace/Session browser. */
export function SidebarTeamSection({
  openSession,
  openTeamPage,
}: {
  openSession: (sessionId: string) => void
  openTeamPage: (teamId: string) => void
}): JSX.Element {
  const { selectedTeamId, navigationError } = useAgentTeamUi()
  const t = useTeamText()
  const [teams, setTeams] = useState<TeamView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [expanded, setExpanded] = useState(readExpanded)
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [rosterDefault] = useState(rosterExpandedDefault)
  const [rosterExpanded, setRosterExpanded] = useState<Record<string, boolean>>({})
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  /** Set when the brand row opens this menu, so it drops from there. */
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement>()
  const [onlyPending, setOnlyPending] = useState(false)
  const [scope, setScope] = useState<'active' | 'archived'>('active')
  const [sortMode, setSortMode] = useState<'updated' | 'name'>('updated')
  const [menuTeamId, setMenuTeamId] = useState<string>()
  const [taskDialogTeamId, setTaskDialogTeamId] = useState<string>()
  const [error, setError] = useState<string>()
  const { groups, refresh: refreshGroups, adopt: adoptGroups } = useSidebarGroups()
  /** Collapsed named groups, in-memory only: a fold is a view, not a setting. */
  const [collapsedPartitions, setCollapsedPartitions] = useState<Record<string, boolean>>({})
  const [groupDialog, setGroupDialog] = useState<SidebarGroupDialog>()

  useEffect(() => {
    const onSearch = (event: Event): void => {
      setQuery((event as CustomEvent<string>).detail ?? '')
    }
    const onMenu = (event: Event): void => {
      const anchor = (event as CustomEvent<HTMLElement | undefined>).detail
      setMenuAnchorEl(anchor)
      setMenuOpen(true)
    }
    window.addEventListener(SIDEBAR_SEARCH_EVENT, onSearch)
    window.addEventListener(SIDEBAR_MENU_EVENT, onMenu)
    return () => {
      window.removeEventListener(SIDEBAR_SEARCH_EVENT, onSearch)
      window.removeEventListener(SIDEBAR_MENU_EVENT, onMenu)
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const [value] = await Promise.all([
        callAgentTeam('team.list'),
        // The group list is a view over these rows; an older Host answers
        // nothing and the list keeps rendering exactly as before.
        refreshGroups(),
      ])
      setTeams(value.items)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      // Only the first settled load decides between 正在加载… and the real state:
      // an empty team list must never be drawn before `team.list` answered.
      setLoaded(true)
    }
  }, [refreshGroups])

  useEffect(() => {
    void load()
    return subscribeAgentTeam(() => { void load() }, () => {
      setError('团队事件连接已断开，正在重连')
    }, () => { void load() })
  }, [load])

  // The current Session can change from the roster, the team page or the header
  // switcher, so follow the shell's own marker instead of guessing.
  useEffect(() => {
    const read = (): void => {
      const session = document.querySelector<HTMLElement>('[data-conversation-session]')
        ?.dataset.conversationSession
      setActiveSessionId(session === undefined || session === '' ? undefined : session)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-conversation-session'],
      subtree: true,
    })
    return () => { observer.disconnect() }
  }, [])

  const toggle = (): void => {
    setExpanded(current => {
      const next = !current
      writeExpanded(next)
      return next
    })
  }

  const scopeCounts = teamScopeCounts(teams)

  const visibleTeams = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const filtered = teams.filter(team => {
      if (scope === 'archived' ? team.archivedAt === undefined : team.archivedAt !== undefined) return false
      if (onlyPending && teamSidebarSummary(team).waiting === 0) return false
      if (normalized === '') return true
      return [team.name, ...Object.values(team.members).map(member => member.displayName)]
        .some(value => value.toLocaleLowerCase().includes(normalized))
    })
    return filtered.sort((a, b) => compareTeamSidebar(a, b, sortMode))
  }, [onlyPending, query, scope, sortMode, teams])

  const openTeam = (team: TeamView): void => {
    selectTeam(team.id)
    setActiveSessionId(undefined)
    openTeamPage(team.id)
  }

  const rosterIsOpen = (teamId: string): boolean =>
    rosterExpanded[teamId] ?? readRosterExpanded(teamId, rosterDefault)

  const toggleRoster = (teamId: string): void => {
    const next = !rosterIsOpen(teamId)
    setRosterExpanded(current => ({ ...current, [teamId]: next }))
    writeRosterExpanded(teamId, next)
  }

  /** A member row is navigation only: it opens that member's Session. */
  const openRosterMember = (team: TeamView, row: TeamRosterRow): void => {
    selectTeam(team.id)
    setActiveSessionId(row.sessionId)
    openSession(row.sessionId)
  }

  const taskDialogTeam = teams.find(team => team.id === taskDialogTeamId)
  const taskDialogTasks = taskDialogTeam === undefined
    ? []
    : recentTeamTasks(taskDialogTeam, 50)

  /** Named groups in the Host's order; one unlabelled partition when none exist. */
  const partitions = useMemo(
    () => sidebarPartitions(groups, visibleTeams, team => team.group),
    [groups, visibleTeams],
  )
  const partitioned = groups.length > 0

  /** Rows move between groups, headers reorder groups: one shared state machine. */
  const drag = useSidebarDrag({
    groups,
    assign: async (teamId, group) => {
      await callAgentTeam('team.group.set', { teamId, group: group ?? null })
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

  const openGroupDialog = (dialog: SidebarGroupDialog): void => { setGroupDialog(dialog) }

  /** One group header's `⋯`: rename, delete, or move the group itself. */
  const selectGroupMenu = async (group: string, id: string): Promise<void> => {
    if (id === 'rename') {
      openGroupDialog({ kind: 'rename', from: group })
      return
    }
    if (id === 'delete') {
      openGroupDialog({ kind: 'delete', name: group })
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

  /** One team row: identical inside a partition and in the flat list, so an
   *  install with no groups renders exactly what it rendered before. */
  const renderTeamRow = (team: TeamView): JSX.Element => {
    const summary = teamSidebarSummary(team)
    const statusText = teamSidebarStatusText(summary)
    const teamActive = selectedTeamId === team.id
    // A member Session is inside this team, but the roster row owns the
    // page marker; the team row keeps only its background highlight.
    const teamCurrent = teamActive
      && !Object.values(team.members).some(member => member.sessionId === activeSessionId)
    const archivable = team.archivedAt === undefined
      && team.state !== 'active'
      && team.state !== 'starting'
    const rowMenuOpen = menuTeamId === team.id
    const avatarTiles = teamAvatarTiles(team.name)
    const rosterOpen = rosterIsOpen(team.id)
    const rosterId = `dsh-team-mode-roster-${team.id}`
    const roster = rosterOpen ? teamRosterRows(team) : []
    const rowDrag = drag.row(team.id, team.group)
    return (
      <div key={team.id} className={css.sidebarTeamGroup}>
        <div
          className={`${css.sidebarTeamRowWrap} ${css.sidebarTeamRowWrapTwoLine} ${teamActive ? css.sidebarTeamRowWrapActive : ''} ${rowMenuOpen ? css.sidebarTeamRowWrapMenuOpen : ''}`}
          draggable={rowDrag.draggable}
          onDragStart={rowDrag.onDragStart}
          onDragEnd={rowDrag.onDragEnd}
          {...(rowDrag.dragging ? { 'data-dsh-drag-source': '' } : {})}
        >
          <button
            type="button"
            className={`${css.sidebarTeamRow} ${css.sidebarTeamRowTwoLine}`}
            onClick={() => {
              // A drag that ended on this row must not also open the team.
              if (sidebarDragSwallowsClick()) return
              openTeam(team)
            }}
            aria-current={teamCurrent ? 'page' : undefined}
            title={`${team.name} · ${statusText}`}
          >
            <span
              className={css.sidebarTeamAvatar}
              data-team-avatar={team.id}
              aria-hidden="true"
              style={{ '--team-avatar-ink': teamAvatarColor(team.id) } as CSSProperties}
            >
              {Array.from({ length: TEAM_AVATAR_TILE_COUNT }, (_, index) => (
                <span
                  key={index}
                  className={`${css.sidebarTeamAvatarTile} ${avatarTiles[index] === undefined ? css.sidebarTeamAvatarTileEmpty : ''}`}
                >
                  {avatarTiles[index] ?? ''}
                </span>
              ))}
            </span>
            <span className={css.sidebarTeamCopy}>
              <span className={css.sidebarAssistantTop}>
                <span className={css.sidebarTeamName}>{team.name}</span>
                {team.pinned === true && (
                  <span className={css.sidebarTeamPinned} title="已置顶" aria-label="已置顶" role="img">
                    <IconPinFillRegular size={11} />
                  </span>
                )}
                <span className={css.sidebarTeamTime}>{relativeTime(team.updatedAt)}</span>
              </span>
              <span className={css.sidebarTeamSubtitle} title={statusText}>{statusText}</span>
            </span>
            {summary.waiting > 0
              ? (
                  <span
                    className={css.sidebarTeamBadge}
                    title={`${summary.waiting} 个待确认`}
                    aria-label={`${summary.waiting} 个待确认`}
                  >
                    {summary.waiting > 99 ? '99+' : summary.waiting}
                  </span>
                )
              : summary.running > 0
                ? <span className={css.sidebarTeamStateDot} aria-hidden="true" />
                : null}
          </button>
          <button
            type="button"
            className={css.sidebarTeamExpand}
            aria-expanded={rosterOpen}
            aria-controls={rosterOpen ? rosterId : undefined}
            aria-label={`${rosterOpen ? '收起' : '展开'} ${team.name} 成员名册`}
            title={rosterOpen ? '收起成员' : '展开成员'}
            data-dsh-team-roster-toggle
            onClick={() => { toggleRoster(team.id) }}
          >
            <IconChevronRightOutlineRegular
              size={12}
              className={`${css.sidebarTeamExpandChevron} ${rosterOpen ? css.sidebarTeamExpandChevronOpen : ''}`}
            />
          </button>
          <Menu
            open={rowMenuOpen}
            onClose={() => { setMenuTeamId(undefined) }}
            align="end"
            side="bottom"
            dense
            portal
            className={css.sidebarTeamMore ?? ''}
            items={[
              { id: 'tasks', label: '查看任务', icon: <IconChecklistOutlineRegular size={14} /> },
              {
                id: 'pin',
                label: team.pinned === true ? '取消置顶' : '置顶',
                icon: team.pinned === true
                  ? <IconPinFillRegular size={14} />
                  : <IconPinOutlineRegular size={14} />,
              },
              // Between 置顶 and 管理, as designed: moving a team is a
              // classification change, not team administration.
              { id: 'group', label: '移动到分组…', icon: <IconProjectAddOutlineRegular size={14} /> },
              { id: 'manage', label: t('sidebar.manage'), icon: <IconSettingsOutlineRegular /> },
              {
                id: 'archive',
                label: archivable ? '归档团队' : '归档团队（先解散）',
                icon: <IconArchiveOutlineRegular />,
                disabled: !archivable,
              },
            ]}
            onSelect={id => {
              setMenuTeamId(undefined)
              if (id === 'tasks') setTaskDialogTeamId(team.id)
              else if (id === 'pin') {
                void callAgentTeam('team.pin', {
                  teamId: team.id,
                  pinned: team.pinned !== true,
                }, team.revision).then(() => { void load() }).catch(cause => {
                  setError(cause instanceof Error ? cause.message : String(cause))
                })
              } else if (id === 'group') {
                openGroupDialog({
                  kind: 'move',
                  title: `移动「${team.name}」到分组`,
                  ...(team.group === undefined ? {} : { current: team.group }),
                  apply: async group => {
                    await callAgentTeam('team.group.set', {
                      teamId: team.id,
                      group: group ?? null,
                    })
                    await load()
                  },
                })
              } else if (id === 'manage') openManageTeamDialog(team.id)
              else if (id === 'archive') {
                void callAgentTeam('team.archive', {
                  teamId: team.id,
                  archived: true,
                }, team.revision).then(() => { void load() }).catch(cause => {
                  setError(cause instanceof Error ? cause.message : String(cause))
                })
              }
            }}
            anchor={(
              <Tooltip label="更多操作" delayMs={400}>
                <button
                  type="button"
                  className={`${css.sidebarTeamManage} ${css.sidebarTeamMoreButton}`}
                  aria-label={`更多操作 ${team.name}`}
                  aria-haspopup="menu"
                  aria-expanded={rowMenuOpen}
                  onClick={() => {
                    setMenuTeamId(current => current === team.id ? undefined : team.id)
                  }}
                >
                  <IconEllipsisOutlineRegular size={14} />
                </button>
              </Tooltip>
            )}
          />
        </div>
        {rosterOpen && (
          <div
            id={rosterId}
            className={css.sidebarRosterList}
            role="group"
            aria-label={`${team.name} 成员`}
            data-dsh-team-roster
          >
            {roster.length === 0
              ? <div className={css.sidebarRosterEmpty}>还没有成员</div>
              : roster.map(row => (
                <button
                  key={row.slotId}
                  type="button"
                  className={css.sidebarRosterRow}
                  aria-current={activeSessionId === row.sessionId ? 'page' : undefined}
                  title={`${row.name} · ${rosterSubtitle(row)}`}
                  data-dsh-team-roster-row={row.slotId}
                  onClick={() => { openRosterMember(team, row) }}
                >
                  <MemberAvatar name={row.name} avatar={row.avatar} size={20} />
                  <span className={css.sidebarRosterCopy}>
                    <span className={css.sidebarRosterTop}>
                      <span className={css.sidebarRosterName}>{row.name}</span>
                      {row.role === 'leader' && (
                        <span className={css.sidebarRosterRole}>Leader</span>
                      )}
                      {row.tone === 'running' && (
                        <span className={css.sidebarTeamStateDot} aria-hidden="true" />
                      )}
                      {row.attention !== undefined && (
                        <span
                          className={`${css.sidebarRosterBadge} ${row.attention === 'error' ? css.sidebarRosterBadgeError : ''}`}
                          role="img"
                          title={row.attention === 'error' ? row.errorText ?? '异常' : '待审批'}
                          aria-label={row.attention === 'error' ? '异常' : '待审批'}
                        >
                          !
                        </span>
                      )}
                    </span>
                    <span className={css.sidebarRosterSubtitle}>{rosterSubtitle(row)}</span>
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <section className={css.sidebarTeamSection} aria-label="群聊" data-dsh-team-mode-section>
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
                onClose={() => {
                  setMenuOpen(false)
                  setMenuAnchorEl(undefined)
                }}
                {...(menuAnchorEl === undefined
                  ? {}
                  : { getAnchorRect: () => menuAnchorEl.getBoundingClientRect() })}
                align="end"
                dense
                portal
                items={[
                  { type: 'label', id: 'filter-label', text: t('sidebar.filter') },
                  { id: 'only-pending', label: t('sidebar.onlyPending'), icon: <IconWarningOutlineRegular /> },
                  { type: 'separator', id: 'sort-separator' },
                  { type: 'label', id: 'sort-label', text: t('sidebar.sort') },
                  { id: 'sort-updated', label: t('sidebar.sortUpdated'), icon: <IconClockOutlineRegular /> },
                  { id: 'sort-name', label: t('sidebar.sortName'), icon: <IconChevronsUpDownOutlineRegular /> },
                ]}
                selectedIds={[
                  onlyPending ? 'only-pending' : undefined,
                  sortMode === 'name' ? 'sort-name' : 'sort-updated',
                ].filter((id): id is string => id !== undefined)}
                onSelect={id => {
                  if (id === 'only-pending') setOnlyPending(value => !value)
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
                  <IconPlusOutlineRegular size={16} />
                </button>
              </Tooltip>
            </div>
          </>
        )}
      </div>
      {expanded && (
        <div id="dsh-team-mode-sidebar-list" className={css.sidebarTeamList}>
          {error !== undefined && (
            <div className={css.sidebarTeamError} role="alert">
              <span>{teams.length === 0 ? `团队数据加载失败：${error}` : error}</span>
              {teams.length === 0 && (
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
          {navigationError !== undefined && (
            <div className={css.sidebarTeamError} role="alert" data-dsh-team-navigation-error>
              <span>{navigationError}</span>
              <button
                type="button"
                className={css.sidebarTeamRetry}
                onClick={() => { reportNavigationError(undefined) }}
              >
                关闭
              </button>
            </div>
          )}
          {scopeCounts.archived > 0 && (
            <div className={css.sidebarTeamScope} role="group" aria-label="团队范围">
              <button
                type="button"
                className={`${css.sidebarTeamScopeButton} ${scope === 'active' ? css.sidebarTeamScopeButtonActive : ''}`}
                aria-pressed={scope === 'active'}
                onClick={() => { setScope('active') }}
              >
                团队<span className={css.sidebarTeamScopeCount}>{scopeCounts.active}</span>
              </button>
              <button
                type="button"
                className={`${css.sidebarTeamScopeButton} ${scope === 'archived' ? css.sidebarTeamScopeButtonActive : ''}`}
                aria-pressed={scope === 'archived'}
                onClick={() => { setScope('archived') }}
              >
                历史<span className={css.sidebarTeamScopeCount}>{scopeCounts.archived}</span>
              </button>
            </div>
          )}
          {teams.length === 0
            ? !loaded
              ? (
                  <div className={css.sidebarTeamEmpty} role="status" data-dsh-team-loading>
                    正在加载团队…
                  </div>
                )
              : error !== undefined
                ? null
                : (
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
              ? (
                  <div className={css.sidebarTeamEmpty}>
                    {query.trim() !== ''
                      ? t('sidebar.noMatches')
                      : scope === 'archived' ? '暂无历史团队' : '暂无进行中的团队'}
                  </div>
                )
              : (
                <>
                  {partitioned
                    ? partitions.map(partition => {
                        const group = partition.group
                        return (
                          <SidebarGroupPartition
                            key={partition.id}
                            label={group ?? '未分组'}
                            count={partition.items.length}
                            collapsed={collapsedPartitions[partition.id] === true}
                            onToggle={() => { togglePartition(partition.id) }}
                            drag={drag.partition({ ...(group === undefined ? {} : { group }) })}
                            {...(group === undefined
                              ? {}
                              : {
                                  onAddEntries: () => { openGroupDialog({ kind: 'members', group }) },
                                  menuItems: sidebarGroupMenuItems(groups, group),
                                  onSelect: (id: string) => { void selectGroupMenu(group, id) },
                                })}
                          >
                            {partition.items.map(renderTeamRow)}
                          </SidebarGroupPartition>
                        )
                      })
                    : visibleTeams.map(renderTeamRow)}
                  <SidebarGroupCreateRow onCreate={() => { openGroupDialog({ kind: 'create' }) }} />
                </>
              )}
        </div>
      )}
      <AnimatedModal
        open={taskDialogTeam !== undefined}
        onClose={() => { setTaskDialogTeamId(undefined) }}
        title={taskDialogTeam === undefined ? '团队任务' : `团队任务 · ${taskDialogTeam.name}`}
        closeLabel="关闭"
        className={css.teamTaskDialog ?? ''}
      >
        <div className={css.teamTaskDialogBody}>
          {taskDialogTasks.length === 0
            ? <p className={css.teamTaskDialogEmpty}>这个团队还没有任务。</p>
            : taskDialogTasks.map(task => {
              const waiting = task.blockedBy === undefined
                ? undefined
                : `等待 ${task.blockedBy.title}${task.blockedBy.ownerName === undefined ? '' : ` · ${task.blockedBy.ownerName}`}`
              return (
                <button
                  key={task.id}
                  type="button"
                  className={css.sidebarTeamTaskRow}
                  onClick={() => {
                    if (taskDialogTeam !== undefined) {
                      setTaskDialogTeamId(undefined)
                      openTeam(taskDialogTeam)
                    }
                  }}
                >
                  <span className={css.sidebarTeamTaskLine}>
                    <span className={css.sidebarTeamTaskTitle}>{task.title}</span>
                    <span className={css.sidebarTeamTaskStatus}>{task.statusLabel}</span>
                  </span>
                  {task.detail !== undefined && (
                    <span className={css.sidebarTeamTaskDetail}>{task.detail}</span>
                  )}
                  {waiting !== undefined && (
                    <span className={css.sidebarTeamTaskWaiting} title={waiting}>{waiting}</span>
                  )}
                </button>
              )
            })}
          <p className={css.sidebarTeamTaskHint}>{TEAM_TASK_CREATE_HINT}</p>
        </div>
      </AnimatedModal>
      <SidebarGroupDialogs
        dialog={groupDialog}
        groups={groups}
        onClose={() => { setGroupDialog(undefined) }}
        onListChanged={adoptGroups}
        onChanged={() => { void load() }}
      />
    </section>
  )
}


import { BRAND_HOST_ID, SIDEBAR_HOST_ID, STEWARD_HOST_ID } from './sidebar-hosts.js'

/** Brand-row search drives every plugin section through one window event. */
const SIDEBAR_SEARCH_EVENT = 'dsh-team-mode:sidebar-search'
/** Brand-row 筛选 button opens the section's own filter/sort menu. */
const SIDEBAR_MENU_EVENT = 'dsh-team-mode:sidebar-menu'
/** Measured indentation from the plugin host to its section titles. */
let brandColumnOffset = 4
/** Mount point for the BOT footer actions that replace native sidebar entries. */
const BOT_FOOTER_HOST_ID = 'dsh-team-mode-footer-host'
/** Marks a native node this plugin hid for the BOT surface. */
const BOT_HIDDEN_ATTR = 'data-dsh-bot-hidden'
/** Marks the account row this plugin stretched to fill the footer. */
const BOT_GROWN_ATTR = 'data-dsh-bot-grow'

/** One top-menu row of the shipped panel list, matched by its accessible name. */
function findPanelRow(label: string): HTMLElement | null {
  const list = document.querySelector<HTMLElement>('[class*="_panelList"]')
  if (list === null) return null
  return Array.from(list.querySelectorAll<HTMLElement>('button, [role="button"]'))
    .find(node => (node.getAttribute('aria-label') ?? node.textContent ?? '').trim() === label)
    ?? null
}

/** Sidebar entries that move into the BOT footer instead of staying in the list. */
const BOT_FOOTER_ENTRIES = [
  { key: 'plugins', title: '插件', find: (): HTMLElement | null => findPanelRow('插件') },
  { key: 'schedules', title: '自动化任务', find: (): HTMLElement | null => findPanelRow('自动化任务') },
] as const

/** Entries the BOT surface drops entirely (no footer replacement). */
const BOT_DROPPED_ENTRIES = [
  { key: 'new-session', find: (): HTMLElement | null => document.querySelector<HTMLElement>('[class*="_newSession"]') },
] as const

/** The shipped market entry that the BOT footer replaces. */
function findMarketEntry(foot: HTMLElement): HTMLElement | null {
  const nodes = Array.from(foot.querySelectorAll<HTMLElement>('button, [role="button"]'))
  return nodes.find((node) => {
    if (node.closest(`#${BOT_FOOTER_HOST_ID}`) !== null) return false
    const name = [
      node.getAttribute('aria-label') ?? '',
      node.getAttribute('title') ?? '',
      (node.textContent ?? '').trim(),
    ].join(' ')
    return /插件广场|市场|market/i.test(name)
  }) ?? null
}

function restoreBotSidebar(): void {
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(`[${BOT_HIDDEN_ATTR}]`))) {
    node.style.display = ''
    node.style.visibility = ''
    node.removeAttribute(BOT_HIDDEN_ATTR)
  }
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(`[${BOT_GROWN_ATTR}]`))) {
    node.style.flex = ''
    node.style.minWidth = ''
    node.removeAttribute(BOT_GROWN_ATTR)
  }
  document.getElementById(BOT_FOOTER_HOST_ID)?.remove()
}

/**
 * BOT surface: the native "新会话" and "自动化任务" entries leave the list and
 * become footer actions next to the account row, and the shipped market entry is
 * dropped. DSH surface restores every node exactly as it was.
 *
 * Proxy buttons forward a real `.click()` to the native control, so no plugin
 * logic is duplicated and nothing here can break the native action itself.
 */
function syncBotSidebar(mode: SurfaceMode): void {
  if (mode !== 'team') {
    restoreBotSidebar()
    return
  }
  // Account row first, actions last: the account stays where the shipped UI puts
  // it (left) and the BOT actions take the free space on the right. Appending to
  // the account row makes the order deterministic instead of depending on where
  // the market entry happens to sit.
  const foot = document.querySelector<HTMLElement>('[class*="_footArea"]')
  const market = foot === null ? null : findMarketEntry(foot)
  const row = document.querySelector<HTMLElement>('[class*="_settingsArea"]')
    ?? market?.parentElement
    ?? document.querySelector<HTMLElement>('[class*="_footerActions"]')
  if (row === null) return

  let host = document.getElementById(BOT_FOOTER_HOST_ID)
  if (host === null || !host.isConnected) {
    host = document.createElement('div')
    host.id = BOT_FOOTER_HOST_ID
    host.className = css.botFooterHost ?? ''
    row.append(host)
  } else if (host.parentElement !== row) {
    row.append(host)
  }

  // The account center takes the row's remaining width; the actions keep their
  // intrinsic size at the right edge.
  const account = Array.from(row.children)
    .find(child => (child as HTMLElement).id !== BOT_FOOTER_HOST_ID) as HTMLElement | undefined
  if (account !== undefined) {
    account.style.flex = '1 1 auto'
    account.style.minWidth = '0'
    account.setAttribute(BOT_GROWN_ATTR, '')
  }

  for (const entry of BOT_FOOTER_ENTRIES) {
    const native = entry.find()
    if (native === null) continue
    if (host.querySelector(`[data-dsh-bot-action="${entry.key}"]`) === null) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = css.botFooterAction ?? ''
      button.setAttribute('data-dsh-bot-action', entry.key)
      button.title = entry.title
      button.setAttribute('aria-label', entry.title)
      const icon = native.querySelector('svg')
      if (icon !== null) {
        try {
          button.append(icon.cloneNode(true))
        } catch {
          // An unclonable icon degrades to a text button.
          button.textContent = entry.title
        }
      } else {
        button.textContent = entry.title
      }
      button.addEventListener('click', () => { native.click() })
      host.append(button)
    }
    native.style.display = 'none'
    native.setAttribute(BOT_HIDDEN_ATTR, '')
  }

  for (const entry of BOT_DROPPED_ENTRIES) {
    const native = entry.find()
    if (native === null) continue
    // Keep the box: the pinned BOT row is laid over it, so the two share one
    // geometry instead of the row guessing its own margins.
    native.style.visibility = 'hidden'
    native.setAttribute(BOT_HIDDEN_ATTR, '')
  }

  if (market !== null) {
    market.style.display = 'none'
    market.setAttribute(BOT_HIDDEN_ATTR, '')
  }

  // One bottom line: the shipped foot stacks `_footerActions` above the account
  // row, so an emptied actions row would leave a second, blank line behind.
  const actions = document.querySelector<HTMLElement>('[class*="_footerActions"]')
  if (actions !== null && actions.childElementCount > 0) {
    const visible = Array.from(actions.children).some((child) => {
      const element = child as HTMLElement
      return element.style.display !== 'none' && (element.textContent ?? '').trim() !== ''
    })
    if (!visible) {
      actions.style.display = 'none'
      actions.setAttribute(BOT_HIDDEN_ATTR, '')
    }
  }
}
/**
 * Additive mount for the “群聊” and “单聊” sections above the shipped Workspace
 * browser. The `sidebar.workspaces` slot is single and its occupant owns a
 * private store/hook contract, so we do not replace it: we insert one stable
 * host node before its DOM anchor and portal both sections into it, in order
 * 群聊 → 单聊 → native Workspaces.
 */
export function SidebarPortal({
  openSession,
  openTeamPage,
  onOpenNativeLanding,
}: {
  openSession: (sessionId: string) => void
  openTeamPage: (teamId: string) => void
  onOpenNativeLanding?: () => void
}): JSX.Element | null {
  const [host, setHost] = useState<HTMLElement>()
  const [brandHost, setBrandHost] = useState<HTMLElement>()
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const mode = useSurfaceMode()

  // Expose the mode on <html> so CSS and DOM-level helpers can follow it
  // without remounting the plugin or touching Team data.
  useEffect(() => {
    document.documentElement.dataset.dshSurfaceMode = mode
    // BOT mode moves two native entries into the footer and drops the shipped
    // market entry; DSH mode restores them. Runs on every switch, and again from
    // the sidebar observer in case a React render rewrites the footer.
    syncBotSidebar(mode)
    return () => {
      if (document.documentElement.dataset.dshSurfaceMode === mode) {
        delete document.documentElement.dataset.dshSurfaceMode
      }
    }
  }, [mode])

  /**
   * Native mode must not keep showing a team member Session. Read-only
   * navigation: prefer an existing visible native row; fall back to the shell's
   * own new-Session landing when every Session belongs to the plugin.
   */
  const leaveTeamSession = useCallback(async (): Promise<void> => {
    const active = document.querySelector<HTMLElement>('[data-conversation-session]')
      ?.dataset.conversationSession
    if (active === undefined || active === '') return
    let teamSessionIds: Set<string>
    try {
      const value = await callAgentTeam('team.list')
      teamSessionIds = new Set(value.items.flatMap(team =>
        Object.values(team.members).map(member => member.sessionId)))
    } catch {
      return
    }
    if (!teamSessionIds.has(active)) return
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]'))
    const nativeId = rows
      .filter(row => row.style.display !== 'none')
      .map(row => row.dataset.rowKey?.slice('session:'.length))
      .find(id => id !== undefined && id !== '' && !teamSessionIds.has(id))
    if (nativeId !== undefined) openSession(nativeId)
    else onOpenNativeLanding?.()
  }, [onOpenNativeLanding, openSession])

  const switchMode = (next: SurfaceMode): void => {
    if (next === mode) return
    setSurfaceMode(next)
    if (next === 'native') void leaveTeamSession()
  }

  useEffect(() => {
    let current: HTMLElement | undefined
    let scrollRoot: HTMLElement | undefined
    let nativeList: HTMLElement | undefined
    let nativeListStyle: { flex: string; height: string; maxHeight: string; overflow: string } | undefined
    let scheduled = false
    let observer: MutationObserver | undefined
    let resize: ResizeObserver | undefined
    let observedContainer: HTMLElement | undefined

    const anchorElement = (): HTMLElement | null => (
      document.querySelector('[data-slot="sidebar.workspaces"]') as HTMLElement | null
    )

    /**
     * Replace the shipped brand row content with the DSH/BOT switch.
     *
     * The row itself stays — it carries the fixed-header spacing above the
     * scrolling region. Only the original brand button is hidden, and our host
     * is mounting point for the switch.
     */
    const ensureBrand = (): void => {
      const logoRow = document.querySelector<HTMLElement>('[class*="_logoRow"]')
      if (logoRow === null) return
      const brand = logoRow.querySelector<HTMLElement>('[class*="_brand"]')
      if (brand !== null) brand.style.display = 'none'
      // The shipped brand row is React-owned: a node inserted into it is removed
      // on its next render, taking the portalled control with it. The host lives
      // on <body> instead and is positioned over the empty row.
      let element = document.getElementById(BRAND_HOST_ID)
      if (element === null || !element.isConnected) {
        element = document.createElement('div')
        element.id = BRAND_HOST_ID
        element.className = css.sidebarBrandHost ?? ''
        element.style.position = 'fixed'
        element.style.zIndex = '50'
        element.style.transform = 'translateY(-50%)'
        document.body.append(element)
        setBrandHost(element)
      }
      const rect = logoRow.getBoundingClientRect()
      // One column for both modes: the plugin host exists in DeepSeek and DeepBot
      // alike, while the section titles only exist in DeepBot. The offset from
      // host to title is measured where a title is present and then reused, so
      // the control does not jump sideways when the mode changes.
      const teamHost = document.getElementById(SIDEBAR_HOST_ID)
      const teamRect = teamHost?.getBoundingClientRect()
      let columnLeft: number | undefined
      let columnWidth: number | undefined
      if (teamHost !== null && teamRect !== undefined) {
        const hostLeft = teamRect.left
        const titleLeft = document
          .querySelector<HTMLElement>('[data-dsh-team-mode-title]')
          ?.getBoundingClientRect().left
        if (titleLeft !== undefined && titleLeft > 0 && hostLeft > 0) {
          brandColumnOffset = Math.round(titleLeft - hostLeft)
        }
        if (hostLeft > 0 && teamRect.width > 0) {
          // Same column as the sections below: start where their titles start and
          // end where their own action buttons end, so the two button groups line
          // up on both edges.
          columnLeft = hostLeft + brandColumnOffset
          columnWidth = Math.max(0, teamRect.width - brandColumnOffset)
        }
      }
      element.style.left = `${Math.round(columnLeft ?? rect.left + 16)}px`
      element.style.top = `${Math.round(rect.top + rect.height / 2)}px`
      element.style.width = `${Math.round(columnWidth ?? Math.max(0, rect.width - 32))}px`
      element.style.visibility = rect.width > 0 && rect.height > 0 ? 'visible' : 'hidden'
    }

    /** Lay the pinned BOT row exactly over the shipped 新会话 button box. */
    const ensureSteward = (): void => {
      const newSession = document.querySelector<HTMLElement>('[class*="_newSession"]')
      let element = document.getElementById(STEWARD_HOST_ID)
      if (getSurfaceMode() !== 'team' || newSession === null) {
        element?.remove()
        return
      }
      if (element === null || !element.isConnected) {
        element = document.createElement('div')
        element.id = STEWARD_HOST_ID
        element.className = css.stewardHost ?? ''
        element.style.position = 'fixed'
        element.style.zIndex = '5'
        document.body.append(element)
      }
      const rect = newSession.getBoundingClientRect()
      element.style.left = `${Math.round(rect.left)}px`
      element.style.top = `${Math.round(rect.top)}px`
      element.style.width = `${Math.round(rect.width)}px`
      // Height is the row's own: it has to read like a 单聊 assistant row, not
      // like the 新会话 button it is pinned over.
      element.style.height = ''
    }

    const ensure = (): void => {
      ensureBrand()
      ensureSteward()
      syncBotSidebar(getSurfaceMode())
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
      // The shipped WorkspaceBrowser scrolls only its own session list. This
      // host sits above that list, so collapse the inner scroll and let the
      // whole middle region scroll as one, keeping the brand header and the
      // account footer fixed.
      const root = element.parentElement
      if (root !== null && root !== scrollRoot) {
        scrollRoot?.removeAttribute('data-dsh-team-scroll')
        scrollRoot = root
        root.setAttribute('data-dsh-team-scroll', 'sidebar')
      }
      if (root !== null) {
        const candidate = Array.from(root.children).find(child => (
          child !== element
          && (getComputedStyle(child).overflowY === 'auto' || getComputedStyle(child).overflowY === 'scroll')
        )) as HTMLElement | undefined
        if (candidate !== undefined) {
          if (candidate !== nativeList) {
            if (nativeList !== undefined && nativeListStyle !== undefined) {
              nativeList.style.flex = nativeListStyle.flex
              nativeList.style.height = nativeListStyle.height
              nativeList.style.maxHeight = nativeListStyle.maxHeight
              nativeList.style.overflow = nativeListStyle.overflow
            }
            nativeList = candidate
            nativeListStyle = {
              flex: candidate.style.flex,
              height: candidate.style.height,
              maxHeight: candidate.style.maxHeight,
              overflow: candidate.style.overflow,
            }
          }
          // React can re-apply the shipped inline/class styles on rerender;
          // keep the inner list expanded on every pass so only the outer
          // sidebar column scrolls.
          candidate.style.flex = '0 0 auto'
          candidate.style.height = 'auto'
          candidate.style.maxHeight = 'none'
          candidate.style.overflow = 'visible'
        }
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
      scrollRoot?.removeAttribute('data-dsh-team-scroll')
      if (nativeList !== undefined && nativeListStyle !== undefined) {
        nativeList.style.flex = nativeListStyle.flex
        nativeList.style.height = nativeListStyle.height
        nativeList.style.maxHeight = nativeListStyle.maxHeight
        nativeList.style.overflow = nativeListStyle.overflow
      }
      current?.remove()
    }
  }, [])


  // The native Workspace header is not collapsible. Reuse the exact 群聊
  // disclosure control — same button, title and chevron classes — so hover,
  // size and keyboard behavior stay identical.
  useEffect(() => {
    const STORAGE_KEY = 'dsh-team-mode:workspace-collapsed'
    let collapsed = false
    try { collapsed = window.localStorage.getItem(STORAGE_KEY) === 'true' } catch { /* storage may be unavailable */ }
    let label: HTMLElement | undefined
    let toggle: HTMLButtonElement | undefined
    let chevron: SVGElement | null = null
    let listArea: HTMLElement | undefined
    let originalDisplay = ''
    let scheduled = false

    const apply = (): void => {
      if (toggle === undefined) return
      toggle.setAttribute('aria-expanded', String(!collapsed))
      toggle.title = collapsed ? '展开工作区' : '收起工作区'
      chevron?.classList.toggle(css.sidebarTeamChevronOpen ?? '', !collapsed)
      if (listArea !== undefined) listArea.style.display = collapsed ? 'none' : originalDisplay
    }

    const onToggle = (): void => {
      collapsed = !collapsed
      try { window.localStorage.setItem(STORAGE_KEY, String(collapsed)) } catch { /* ignore */ }
      apply()
    }

    const ensure = (): void => {
      const nextLabel = Array.from(document.querySelectorAll<HTMLElement>('span'))
        .find(element => (element.textContent ?? '').trim() === '工作区'
          && element.closest('button') === null
          && element.closest('[class*="_sectionHeader"]') !== null)
      if (nextLabel === undefined) return
      label = nextLabel
      const section = label.closest<HTMLElement>('[class*="_sectionHeader"]')
      const nextList = section?.parentElement?.querySelector<HTMLElement>('[class*="_listArea"]')
      if (nextList === null || nextList === undefined) return
      if (listArea !== nextList) {
        if (listArea !== undefined) listArea.style.display = originalDisplay
        listArea = nextList
        originalDisplay = listArea.style.display
      }
      if (toggle === undefined || !toggle.isConnected) {
        const nextToggle = document.createElement('button')
        nextToggle.type = 'button'
        nextToggle.dataset.dshWorkspaceToggle = 'true'
        nextToggle.className = css.sidebarTeamToggle ?? ''
        nextToggle.style.flex = '1 1 auto'
        nextToggle.style.minWidth = 'max-content'
        nextToggle.style.maxWidth = 'none'
        nextToggle.innerHTML = `<span class="${css.sidebarTeamTitle ?? ''}" style="position: relative; flex: none; overflow: visible;">工作区<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke-width="1" aria-hidden="true" class="${css.sidebarTeamChevron ?? ''}"><path d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4" stroke="currentColor"></path></svg></span>`
        nextToggle.addEventListener('click', onToggle)
        label.before(nextToggle)
        toggle = nextToggle
      }
      chevron = toggle.querySelector('svg')
      label.style.display = 'none'
      if (listArea.id !== '') toggle.setAttribute('aria-controls', listArea.id)
      apply()
    }

    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      window.requestAnimationFrame(() => { scheduled = false; ensure() })
    }

    ensure()
    window.addEventListener('resize', schedule)
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.removeEventListener('resize', schedule)
      observer.disconnect()
      toggle?.removeEventListener('click', onToggle)
      toggle?.remove()
      if (label !== undefined) label.style.display = ''
      if (listArea !== undefined) listArea.style.display = originalDisplay
    }
  }, [])


  // The shipped footer keeps Session log and Plugin Plaza in a block above the
  // account row. That block is not part of the sidebar scroll region and costs
  // scarce vertical space on phones. Session log is already available from the
  // account menu, so collapse the native action block and expose Plugin Plaza
  // as a single icon button on the right of the account control bar.
  useEffect(() => {
    let actions: HTMLElement | undefined
    let actionsDisplay = ''
    let area: HTMLElement | undefined
    let button: HTMLButtonElement | undefined
    let scheduled = false

    const openPluginPlaza = (): void => {
      const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      const trigger = candidates.find(candidate => (
        candidate.className.includes('sh-plaza-trigger')
        || (candidate.textContent ?? '').trim() === 'Plugin Plaza'
        || (candidate.textContent ?? '').trim() === '插件广场'
      ))
      trigger?.click()
      // On phones the sidebar is a drawer with its own backdrop above the
      // Plaza. Leave that backdrop open and the next tap closes the whole
      // drawer instead of only the Plaza. Collapse the drawer once Plaza has
      // opened; desktop keeps its sidebar because it has no mobile backdrop.
      if (document.querySelector('[data-mobile-nav="backdrop"]') !== null) {
        const collapse = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Collapse sidebar"], button[aria-label="Close sidebar"], '
          + 'button[aria-label="收起侧栏"], button[aria-label="关闭侧栏"]',
        )
        collapse?.click()
      }
    }

    const ensure = (): void => {
      const nextActions = document.querySelector<HTMLElement>('[class*="_footerActions"]')
      if (nextActions !== actions) {
        if (actions !== undefined) actions.style.display = actionsDisplay
        actions = nextActions ?? undefined
        if (actions !== undefined) {
          actionsDisplay = actions.style.display
          actions.style.display = 'none'
        }
      }
      const nextArea = document.querySelector<HTMLElement>('[class*="_settingsArea"]')
      if (nextArea === null) return
      if (area !== nextArea) {
        area?.classList.remove(css.sidebarSettingsWithPlugin ?? '')
        area = nextArea
        area.classList.add(css.sidebarSettingsWithPlugin ?? '')
      }
      if (button === undefined || !button.isConnected) {
        button = document.createElement('button')
        button.type = 'button'
        button.className = css.sidebarPluginPlazaButton ?? ''
        button.setAttribute('aria-label', '插件广场')
        button.title = '插件广场'
        button.dataset.dshPluginPlaza = 'true'
        button.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2.25" y="2.25" width="4.5" height="4.5" rx="1.1" stroke="currentColor" stroke-width="1.1"/><rect x="9.25" y="2.25" width="4.5" height="4.5" rx="1.1" stroke="currentColor" stroke-width="1.1"/><rect x="2.25" y="9.25" width="4.5" height="4.5" rx="1.1" stroke="currentColor" stroke-width="1.1"/><rect x="9.25" y="9.25" width="4.5" height="4.5" rx="1.1" stroke="currentColor" stroke-width="1.1"/></svg>'
        button.addEventListener('click', openPluginPlaza)
      }
      if (button.parentElement !== area) area.append(button)
    }

    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      window.requestAnimationFrame(() => { scheduled = false; ensure() })
    }

    ensure()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (actions !== undefined) actions.style.display = actionsDisplay
      area?.classList.remove(css.sidebarSettingsWithPlugin ?? '')
      button?.remove()
    }
  }, [])


  // Add “导出会话日志” to every native Session row's actions menu. The row menu
  // is a React portal, so this effect only observes it and injects one DOM item;
  // the export itself uses the same document-relative route as the shipped
  // session-log-export package.
  useEffect(() => {
    let pendingSessionId: string | undefined
    let scheduled = false
    let errorTimer: number | undefined

    const sessionOf = (target: EventTarget | null): string | undefined => {
      if (!(target instanceof Element)) return undefined
      const trigger = target.closest<HTMLElement>('button[aria-label^="Session actions for "]')
      const row = trigger?.closest<HTMLElement>('[data-row-key^="session:"]')
      const key = row?.dataset.rowKey
      return key?.slice('session:'.length) || undefined
    }

    const rememberSession = (event: Event): void => {
      const sessionId = sessionOf(event.target)
      if (sessionId !== undefined) pendingSessionId = sessionId
    }

    const downloadSession = async (sessionId: string, button: HTMLButtonElement): Promise<void> => {
      const route = `api/session.export?${new URLSearchParams({
        sessionId,
        includeDescendants: 'true',
      }).toString()}`
      try {
        const response = await fetch(route, { method: 'HEAD' })
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error(detail === '' ? `HTTP ${response.status}` : detail)
        }
        const anchor = document.createElement('a')
        anchor.href = route
        anchor.download = `dsh-session-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
      } catch (cause) {
        button.title = cause instanceof Error ? cause.message : String(cause)
        const label = button.querySelector<HTMLElement>('[class*="itemLabel"]')
        if (label !== null) {
          label.textContent = '导出失败，请重试'
          if (errorTimer !== undefined) window.clearTimeout(errorTimer)
          errorTimer = window.setTimeout(() => { label.textContent = '导出会话日志' }, 2400)
        }
      }
    }

    const ensure = (): void => {
      if (pendingSessionId === undefined) return
      const menu = document.querySelector<HTMLElement>('[role="menu"]')
      if (menu === null || menu.querySelector('[data-dsh-session-export]') !== null) return
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      const labels = items.map(item => (item.textContent ?? '').trim())
      if (!labels.includes('Delete session') && !labels.includes('Copy Session ID')) return
      const deleteItem = items.find(item => (item.textContent ?? '').trim() === 'Delete session')
      const reference = deleteItem ?? items[items.length - 1]
      if (reference === undefined) return
      const wrapper = reference.parentElement?.cloneNode(true) as HTMLElement | undefined
      if (wrapper === undefined) return
      const button = wrapper.querySelector<HTMLButtonElement>('button')
      if (button === null) return
      const iconClass = button.querySelector<HTMLElement>('[class*="itemIcon"]')?.className
      const labelClass = button.querySelector<HTMLElement>('[class*="itemLabel"]')?.className
      button.setAttribute('role', 'menuitem')
      button.dataset.dshSessionExport = 'true'
      button.innerHTML = `${iconClass === undefined ? '' : `<span class="${iconClass}">`}<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 2.75V10.25" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M4.75 7.25L8 10.5L11.25 7.25" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 13.25H13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>${iconClass === undefined ? '' : '</span>'}<span class="${labelClass ?? ''}">导出会话日志</span>`
      button.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        void downloadSession(pendingSessionId ?? '', button)
      })
      reference.parentElement?.before(wrapper)
    }

    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      window.requestAnimationFrame(() => { scheduled = false; ensure() })
    }

    document.addEventListener('click', rememberSession, true)
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      document.removeEventListener('click', rememberSession, true)
      observer.disconnect()
      if (errorTimer !== undefined) window.clearTimeout(errorTimer)
    }
  }, [])


  // Put 新会话, the top navigation and the workspace region inside one real
  // scroll wrapper between the fixed brand rows and the fixed account footer.
  // A sticky overlay would let content pass underneath; this keeps the scroll
  // viewport strictly between the two fixed ends.
  useEffect(() => {
    let wrapper: HTMLDivElement | undefined
    let root: HTMLElement | undefined
    let scheduled = false
    let scrollTimer: number | undefined
    let scrollBound: HTMLDivElement | undefined

    const showScrollbar = (): void => {
      if (wrapper === undefined) return
      wrapper.classList.add(css.sidebarScrolling ?? '')
      if (scrollTimer !== undefined) window.clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => {
        wrapper?.classList.remove(css.sidebarScrolling ?? '')
        scrollTimer = undefined
      }, 700)
    }

    const ensure = (): void => {
      // DSH has changed this component's class names over time. The account
      // footer is the stable direct child that stays outside the scroll region,
      // so discover the root from it instead of requiring a particular
      // `_topStrip` class. Fall back to the old marker only for compatibility.
      const foot = document.querySelector<HTMLElement>('[class*="_footArea"]')
      const topStrip = document.querySelector<HTMLElement>('[class*="_topStrip"]')
      const nextRoot = foot?.parentElement ?? topStrip?.parentElement
      if (nextRoot === null || nextRoot === undefined) return
      root = nextRoot
      const existingWrapper = nextRoot.querySelector<HTMLDivElement>(':scope > [data-dsh-sidebar-scroll="true"]')
      const newSession = nextRoot.querySelector<HTMLElement>(':scope > [class*="_newSession"]')
        ?? existingWrapper?.querySelector<HTMLElement>(':scope > [class*="_newSession"]')
        ?? null
      const nav = nextRoot.querySelector<HTMLElement>(':scope > [class*="_panelList"]')
        ?? existingWrapper?.querySelector<HTMLElement>(':scope > [class*="_panelList"]')
        ?? null
      const region = nextRoot.querySelector<HTMLElement>(':scope > [class*="_regionArea"]')
        ?? existingWrapper?.querySelector<HTMLElement>(':scope > [class*="_regionArea"]')
        ?? null
      if (newSession === null || nav === null || region === null || foot === null) return
      const scrollWrapper: HTMLDivElement = wrapper?.isConnected === true
        ? wrapper
        : (existingWrapper ?? document.createElement('div'))
      wrapper = scrollWrapper
      scrollWrapper.className = css.sidebarScrollArea ?? ''
      scrollWrapper.dataset.dshSidebarScroll = 'true'
      if (scrollWrapper.parentElement !== nextRoot) nextRoot.insertBefore(scrollWrapper, newSession)
      if (scrollBound !== scrollWrapper) {
        scrollBound?.removeEventListener('scroll', showScrollbar)
        scrollBound?.removeEventListener('wheel', showScrollbar)
        scrollBound?.removeEventListener('pointermove', showScrollbar)
        scrollWrapper.addEventListener('scroll', showScrollbar, { passive: true })
        scrollWrapper.addEventListener('wheel', showScrollbar, { passive: true })
        scrollWrapper.addEventListener('pointermove', showScrollbar, { passive: true })
        scrollBound = scrollWrapper
      }
      for (const child of [newSession, nav, region]) {
        if (child.parentElement !== scrollWrapper) scrollWrapper.append(child)
      }
    }

    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      window.requestAnimationFrame(() => { scheduled = false; ensure() })
    }

    ensure()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (scrollTimer !== undefined) window.clearTimeout(scrollTimer)
      scrollBound?.removeEventListener('scroll', showScrollbar)
      scrollBound?.removeEventListener('wheel', showScrollbar)
      scrollBound?.removeEventListener('pointermove', showScrollbar)
      wrapper?.classList.remove(css.sidebarScrolling ?? '')
      if (wrapper !== undefined && wrapper.isConnected) {
        const foot = root?.querySelector<HTMLElement>(':scope > [class*="_footArea"]')
        for (const child of Array.from(wrapper.children)) {
          if (foot !== null && foot !== undefined) root?.insertBefore(child, foot)
          else root?.append(child)
        }
        wrapper.remove()
      }
    }
  }, [])

  return (
    <>
      {brandHost !== undefined && createPortal(
        <>
          <SurfaceModeSwitch mode={mode} onChange={switchMode} />
          {searchOpen ? (
            <div className={css.sidebarTeamSearch}>
              <IconSearchOutlineRegular size={14} />
              <input
                autoFocus
                type="search"
                value={search}
                placeholder="搜索"
                aria-label="搜索侧栏"
                onChange={(event) => {
                  const value = event.target.value
                  setSearch(value)
                  window.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_EVENT, { detail: value }))
                }}
                onBlur={() => {
                  if (search !== '') return
                  setSearchOpen(false)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  setSearch('')
                  setSearchOpen(false)
                  window.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_EVENT, { detail: '' }))
                }}
              />
              <button
                type="button"
                className={css.sidebarTeamSearchClear}
                aria-label="清除搜索"
                onClick={() => {
                  setSearch('')
                  setSearchOpen(false)
                  window.dispatchEvent(new CustomEvent(SIDEBAR_SEARCH_EVENT, { detail: '' }))
                }}
              >
                <IconCloseFillRegular size={14} />
              </button>
            </div>
          ) : (
            <div className={css.brandActions}>
              <button
                type="button"
                className={css.brandAction}
                aria-label="搜索"
                title="搜索"
                onClick={() => {
                  // DeepSeek mode forwards to the shipped search; DeepBot expands ours.
                  if (mode === 'native' && clickNativeAction(/搜索|search/i)) return
                  setSearchOpen(true)
                }}
              >
                <IconSearchOutlineRegular />
              </button>
              <button
                type="button"
                className={css.brandAction}
                aria-label="筛选"
                title="筛选"
                onClick={(event) => {
                  // DeepSeek mode opens the shipped grouping/sort/filter menu.
                  if (mode === 'native' && clickNativeAction(/筛选|排序|分组|filter|sort/i)) return
                  // Hand the brand button over so the menu drops from this row,
                  // not from the section header far below.
                  window.dispatchEvent(
                    new CustomEvent(SIDEBAR_MENU_EVENT, { detail: event.currentTarget }),
                  )
                }}
              >
                <IconSlidersTwoOutlineRegular />
              </button>
              <button
                type="button"
                className={css.brandAction}
                aria-label="新建"
                title="新建"
                onClick={() => {
                  if (mode === 'native') {
                    startNativeSession()
                    return
                  }
                  void startStewardSession(openSession)
                }}
              >
                <IconPlusOutlineRegular />
              </button>
            </div>
          )}
        </>,
        brandHost,
      )}
      {host !== undefined && createPortal(
        <>
          {mode === 'team' && (
            <>
              <SidebarTeamSection openSession={openSession} openTeamPage={openTeamPage} />
              <AssistantSidebarSection openSession={openSession} />
            </>
          )}
        </>,
        host,
      )}
    </>
  )
}
