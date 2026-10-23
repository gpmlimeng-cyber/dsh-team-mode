import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconArchiveOutlineRegular,
  IconUsersOutlineRegular,
  IconChevronRightOutlineRegular,
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
import {
  openCreateTeamDialog,
  openManageTeamDialog,
  selectTeam,
  useAgentTeamUi,
} from './store.js'
import {
  compareTeamSidebar,
  teamScopeCounts,
  teamSidebarStatusText,
  teamSidebarSummary,
} from './team-sidebar-data.js'
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
  const { selectedTeamId } = useAgentTeamUi()
  const t = useTeamText()
  const [teams, setTeams] = useState<TeamView[]>([])
  const [expanded, setExpanded] = useState(readExpanded)
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [onlyPending, setOnlyPending] = useState(false)
  const [scope, setScope] = useState<'active' | 'archived'>('active')
  const [sortMode, setSortMode] = useState<'updated' | 'name'>('updated')
  const [menuTeamId, setMenuTeamId] = useState<string>()
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
                onClose={() => { setMenuOpen(false) }}
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
          {error !== undefined && <div className={css.sidebarTeamError} role="alert">{error}</div>}
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
              ? (
                  <div className={css.sidebarTeamEmpty}>
                    {query.trim() !== ''
                      ? t('sidebar.noMatches')
                      : scope === 'archived' ? '暂无历史团队' : '暂无进行中的团队'}
                  </div>
                )
              : visibleTeams.map(team => {
              const summary = teamSidebarSummary(team)
              const statusText = teamSidebarStatusText(summary)
              const active = selectedTeamId === team.id
              const archivable = team.archivedAt === undefined
                && team.state !== 'active'
                && team.state !== 'starting'
              const rowMenuOpen = menuTeamId === team.id
              return (
                <div key={team.id} className={css.sidebarTeamGroup}>
                  <div
                    className={`${css.sidebarTeamRowWrap} ${css.sidebarTeamRowWrapTwoLine} ${active ? css.sidebarTeamRowWrapActive : ''} ${rowMenuOpen ? css.sidebarTeamRowWrapMenuOpen : ''}`}
                  >
                    <button
                      type="button"
                      className={`${css.sidebarTeamRow} ${css.sidebarTeamRowTwoLine}`}
                      onClick={() => { openTeam(team) }}
                      aria-current={active ? 'page' : undefined}
                      title={`${team.name} · ${statusText}`}
                    >
                      <span className={css.sidebarTeamAvatar} aria-hidden="true">
                        <IconUsersOutlineRegular size={16} />
                      </span>
                      <span className={css.sidebarTeamCopy}>
                        <span className={css.sidebarTeamTop}>
                          <span className={css.sidebarTeamName}>{team.name}</span>
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
                    <Tooltip label={team.pinned === true ? t('sidebar.unpin') : t('sidebar.pin')} delayMs={400}>
                      <button
                        type="button"
                        className={`${css.sidebarTeamManage} ${team.pinned === true ? css.sidebarTeamManagePinned : ''}`}
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
                        {team.pinned === true
                          ? <IconPinFillRegular size={14} />
                          : <IconPinOutlineRegular size={14} />}
                      </button>
                    </Tooltip>
                    <Menu
                      open={rowMenuOpen}
                      onClose={() => { setMenuTeamId(undefined) }}
                      align="end"
                      side="bottom"
                      dense
                      portal
                      className={css.sidebarTeamMore ?? ''}
                      items={[
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
                        if (id === 'manage') openManageTeamDialog(team.id)
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
 * Additive mount for the “群聊” and “单聊” sections above the shipped Workspace
 * browser. The `sidebar.workspaces` slot is single and its occupant owns a
 * private store/hook contract, so we do not replace it: we insert one stable
 * host node before its DOM anchor and portal both sections into it, in order
 * 群聊 → 单聊 → native Workspaces.
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
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
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

  return host === undefined ? null : createPortal(
    <>
      <SidebarTeamSection openSession={openSession} openTeamPage={openTeamPage} />
      <AssistantSidebarSection openSession={openSession} />
    </>,
    host,
  )
}
