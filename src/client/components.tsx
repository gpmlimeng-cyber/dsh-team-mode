import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import {
  Button, IconAgentPresetOutlineRegular, IconCloseOutlineRegular, IconPlusOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { AssistantPanel } from './assistants/AssistantPanel.js'
import {
  callAgentTeam,
  subscribeAgentTeam,
} from './api.js'
import { closeAgentTeam, openTeam, openTeamCreator, openTeams, useAgentTeamUi } from './store.js'
import { isTeamExecuting } from './team-status.js'
import { TeamPanel } from './teams/TeamPanel.js'
import type { WorkspaceChoice } from './types.js'
import css from './AgentTeam.module.css'
import type {
  AssistantView,
  CatalogView,
  TeamView,
} from '../transport/contracts.js'

export type { WorkspaceChoice } from './types.js'

/** Trailing window that folds a change-event burst into one reload. */
const TEAM_RELOAD_DEBOUNCE_MS = 120
/** A connection open this soon after a load is the first one, not a recovery. */
const TEAM_RESYNC_SETTLE_MS = 1_500
const floatingLauncherStorageKey = 'dsh-team-mode:floating-launcher-position'
const floatingLauncherMargin = 8
const floatingLauncherWidth = 42
const floatingLauncherExpandedWidth = 90
const floatingLauncherHeight = 42
const floatingLauncherDockThreshold = 8

type FloatingLauncherSide = 'left' | 'right'

interface FloatingLauncherPosition {
  x: number
  y: number
}

interface FloatingLauncherPlacement {
  position: FloatingLauncherPosition
  side: FloatingLauncherSide
}

function defaultFloatingLauncherPlacement(): FloatingLauncherPlacement {
  return {
    position: {
      x: 16,
      y: Math.round(window.innerHeight * 0.62),
    },
    side: 'left',
  }
}

function clampFloatingLauncherPosition(position: FloatingLauncherPosition): FloatingLauncherPosition {
  return {
    x: Math.min(
      Math.max(floatingLauncherMargin, position.x),
      Math.max(floatingLauncherMargin, window.innerWidth - floatingLauncherWidth - floatingLauncherMargin),
    ),
    y: Math.min(
      Math.max(floatingLauncherMargin, position.y),
      Math.max(floatingLauncherMargin, window.innerHeight - floatingLauncherHeight - floatingLauncherMargin),
    ),
  }
}

function clampFloatingLauncherDragPosition(position: FloatingLauncherPosition): FloatingLauncherPosition {
  return {
    x: Math.min(
      Math.max(floatingLauncherMargin, position.x),
      Math.max(floatingLauncherMargin, window.innerWidth - floatingLauncherExpandedWidth - floatingLauncherMargin),
    ),
    y: Math.min(
      Math.max(floatingLauncherMargin, position.y),
      Math.max(floatingLauncherMargin, window.innerHeight - floatingLauncherHeight - floatingLauncherMargin),
    ),
  }
}

function floatingLauncherSide(position: FloatingLauncherPosition): FloatingLauncherSide {
  return position.x + floatingLauncherWidth / 2 > window.innerWidth / 2 ? 'right' : 'left'
}

function isFloatingLauncherDocked(position: FloatingLauncherPosition): boolean {
  const maxX = Math.max(
    floatingLauncherMargin,
    window.innerWidth - floatingLauncherWidth - floatingLauncherMargin,
  )
  return position.x <= floatingLauncherMargin + floatingLauncherDockThreshold
    || position.x >= maxX - floatingLauncherDockThreshold
}

function readFloatingLauncherPlacement(): FloatingLauncherPlacement | undefined {
  try {
    const stored = window.localStorage.getItem(floatingLauncherStorageKey)
    if (stored === null) return undefined
    const parsed = JSON.parse(stored) as Partial<FloatingLauncherPosition> & { side?: unknown }
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return undefined
    const position = { x: parsed.x as number, y: parsed.y as number }
    return {
      position,
      side: parsed.side === 'left' || parsed.side === 'right'
        ? parsed.side
        : floatingLauncherSide(position),
    }
  } catch {
    return undefined
  }
}

function storeFloatingLauncherPlacement(placement: FloatingLauncherPlacement): void {
  try {
    window.localStorage.setItem(floatingLauncherStorageKey, JSON.stringify({
      ...placement.position,
      side: placement.side,
    }))
  } catch {
    // Storage can be unavailable in restricted WebViews; dragging still works for the current session.
  }
}

function FloatingTeamLauncher({ hasExecutingTeam }: { hasExecutingTeam: boolean }): JSX.Element {
  const [placement, setPlacement] = useState<FloatingLauncherPlacement>()
  const [dragPosition, setDragPosition] = useState<FloatingLauncherPosition>()
  const [dragging, setDragging] = useState(false)
  const [dockSettled, setDockSettled] = useState(false)
  const [tooltipSuppressed, setTooltipSuppressed] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    pointerX: number
    pointerY: number
    startX: number
    startY: number
    position: FloatingLauncherPosition
    moved: boolean
  }>()
  const suppressClickRef = useRef(false)

  useEffect(() => {
    const stored = readFloatingLauncherPlacement() ?? defaultFloatingLauncherPlacement()
    const initialPosition = clampFloatingLauncherPosition(stored.position)
    setPlacement({
      position: initialPosition,
      side: isFloatingLauncherDocked(initialPosition)
        ? floatingLauncherSide(initialPosition)
        : stored.side,
    })
    const handleResize = (): void => {
      setPlacement(current => {
        const fallback = current ?? defaultFloatingLauncherPlacement()
        const position = clampFloatingLauncherPosition(fallback.position)
        return {
          position,
          side: isFloatingLauncherDocked(position)
            ? floatingLauncherSide(position)
            : fallback.side,
        }
      })
    }
    window.addEventListener('resize', handleResize)
    return () => { window.removeEventListener('resize', handleResize) }
  }, [])

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.moved) {
      const maxDragX = Math.max(
        floatingLauncherMargin,
        window.innerWidth - floatingLauncherExpandedWidth - floatingLauncherMargin,
      )
      const dockedLeft = drag.position.x <= floatingLauncherMargin + floatingLauncherDockThreshold
      const dockedRight = drag.position.x >= maxDragX - floatingLauncherDockThreshold
      const docked = dockedLeft || dockedRight
      const side: FloatingLauncherSide = dockedLeft
        ? 'left'
        : dockedRight
          ? 'right'
          : drag.position.x + floatingLauncherExpandedWidth / 2 > window.innerWidth / 2
            ? 'right'
            : 'left'
      const collapsedX = dockedLeft
        ? floatingLauncherMargin
        : dockedRight
          ? Math.max(
              floatingLauncherMargin,
              window.innerWidth - floatingLauncherWidth - floatingLauncherMargin,
            )
          : side === 'right'
            ? drag.position.x + floatingLauncherExpandedWidth - floatingLauncherWidth
            : drag.position.x
      const nextPlacement: FloatingLauncherPlacement = {
        position: clampFloatingLauncherPosition({ x: collapsedX, y: drag.position.y }),
        side,
      }
      setPlacement(nextPlacement)
      storeFloatingLauncherPlacement(nextPlacement)
      setDockSettled(docked)
    }
    suppressClickRef.current = drag.moved
    dragRef.current = undefined
    setDragPosition(undefined)
    setDragging(false)
  }

  const style: CSSProperties | undefined = dragPosition !== undefined
    ? { left: dragPosition.x, right: 'auto', top: dragPosition.y }
    : placement === undefined
    ? undefined
    : placement.side === 'right'
      ? {
          left: 'auto',
          right: Math.max(floatingLauncherMargin, window.innerWidth - placement.position.x - floatingLauncherWidth),
          top: placement.position.y,
        }
      : { left: placement.position.x, top: placement.position.y }

  return (
    <Tooltip
      label="打开团队工作台"
      delayMs={400}
      disabled={dragging || tooltipSuppressed}
    >
      <button
        type="button"
        className={`${css.floatingTeamLauncher} ${dragging ? css.floatingTeamLauncherDragging : ''} ${dockSettled ? css.floatingTeamLauncherSettled : ''}`}
        style={style}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false
            return
          }
          openTeams()
        }}
        onPointerDown={event => {
          if (event.button !== 0) return
          setTooltipSuppressed(true)
          const currentPlacement = placement ?? defaultFloatingLauncherPlacement()
          const current = clampFloatingLauncherPosition(currentPlacement.position)
          const currentDragPosition = clampFloatingLauncherDragPosition({
            x: currentPlacement.side === 'right'
              ? current.x - (floatingLauncherExpandedWidth - floatingLauncherWidth)
              : current.x,
            y: current.y,
          })
          dragRef.current = {
            pointerId: event.pointerId,
            pointerX: event.clientX,
            pointerY: event.clientY,
            startX: currentDragPosition.x,
            startY: currentDragPosition.y,
            position: currentDragPosition,
            moved: false,
          }
          suppressClickRef.current = false
          setDockSettled(false)
          setDragPosition(currentDragPosition)
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={event => {
          const drag = dragRef.current
          if (drag === undefined || drag.pointerId !== event.pointerId) return
          const deltaX = event.clientX - drag.pointerX
          const deltaY = event.clientY - drag.pointerY
          if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return
          drag.moved = true
          drag.position = clampFloatingLauncherDragPosition({
            x: drag.startX + deltaX,
            y: drag.startY + deltaY,
          })
          setDragPosition(drag.position)
        }}
        onPointerUp={finishDrag}
        onPointerCancel={event => {
          finishDrag(event)
          suppressClickRef.current = false
          setDockSettled(false)
          setDragPosition(undefined)
        }}
        onPointerLeave={() => {
          if (!dragging) setDockSettled(false)
        }}
        onMouseLeave={() => {
          setTooltipSuppressed(false)
        }}
        aria-label={hasExecutingTeam ? '打开团队工作台，有团队正在执行任务' : '打开团队工作台'}
      >
        <span className={css.floatingTeamLauncherIcon}>
          <IconAgentPresetOutlineRegular size={18} />
          {hasExecutingTeam && <span className={css.floatingTeamLauncherState} aria-hidden="true" />}
        </span>
        <span className={css.floatingTeamLauncherLabel}>团队</span>
      </button>
    </Tooltip>
  )
}

export function useAgentTeamData(includeTeams: boolean, active = true): {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  teams: TeamView[]
  loading: boolean
  error: string | undefined
  catalogLoading: boolean
  teamsLoading: boolean
  teamsError: string | undefined
  load: () => Promise<void>
} {
  const [catalog, setCatalog] = useState<CatalogView>()
  const [assistants, setAssistants] = useState<AssistantView[]>([])
  const [teams, setTeams] = useState<TeamView[]>([])
  const [teamsLoaded, setTeamsLoaded] = useState(false)
  const [teamsError, setTeamsError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [error, setError] = useState<string>()
  const inFlight = useRef<Promise<void>>()
  const lastLoadAt = useRef(0)

  const load = useCallback((): Promise<void> => {
    // One load per hook at a time: a change-event burst must not multiply reads.
    const running = inFlight.current
    if (running !== undefined) return running
    lastLoadAt.current = Date.now()
    const request = (async (): Promise<void> => {
      setLoading(true)
      setError(undefined)
      try {
        // The catalog stays fire-and-forget for the batch (its own resolution
        // publishes `catalogLoading`), so a slow catalog never delays the Team
        // list the sidebar draws from.
        setCatalogLoading(true)
        void callAgentTeam('catalog.get')
          .then(value => { setCatalog(value) })
          .catch((cause: unknown) => {
            const message = cause instanceof Error ? cause.message : String(cause)
            setError(current => current === undefined ? message : `${current}；${message}`)
          })
          .finally(() => { setCatalogLoading(false) })
        const coreRequests = [
          callAgentTeam('assistant.list').then(value => { setAssistants(value.items) }),
          includeTeams
            ? callAgentTeam('team.list')
                .then(value => {
                  setTeams(value.items)
                  setTeamsError(undefined)
                })
                .catch((cause: unknown) => {
                  const message = cause instanceof Error ? cause.message : String(cause)
                  setTeamsError(message)
                  throw cause
                })
                .finally(() => { setTeamsLoaded(true) })
            : Promise.resolve().then(() => {
              setTeams([])
              setTeamsLoaded(true)
            }),
        ]
        const results = await Promise.allSettled(coreRequests)
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason))
        if (failures.length > 0) setError(failures.join('；'))
      } finally {
        setLoading(false)
      }
    })()
    inFlight.current = request
    void request.finally(() => {
      if (inFlight.current === request) inFlight.current = undefined
    })
    return request
  }, [includeTeams])

  useEffect(() => {
    if (!active) return
    void load()
    // Trailing debounce: the startup change/resync burst collapses into one reload.
    // The first connection open is not a recovery — the load above already covers
    // it, so a resync inside that window must not double the read.
    // Coalescing throttle, not a trailing debounce: a steady stream of change
    // events must never starve the reload that a just-settled mutation awaits.
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (resync = false): void => {
      if (resync && Date.now() - lastLoadAt.current < TEAM_RESYNC_SETTLE_MS) return
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; void load() }, TEAM_RELOAD_DEBOUNCE_MS)
    }
    const unsubscribe = subscribeAgentTeam(
      () => { schedule() },
      () => { setError('事件连接已断开，正在等待重连') },
      () => { schedule(true) },
    )
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }, [active, load])

  return {
    catalog,
    assistants,
    teams,
    loading,
    error,
    catalogLoading,
    teamsLoading: !teamsLoaded,
    teamsError,
    load,
  }
}

export function AgentTeamSettingsSection(_props: SettingsSectionOwnerProps): JSX.Element {
  const { catalog, assistants, loading, error, load } = useAgentTeamData(false)
  return (
    <section className={css.settingsSection}>
      <div className={css.settingsHeading}>
        <div>
          <h1 className={css.settingsTitle}>团队</h1>
          <p className={css.settingsDescription}>管理可在不同团队间复用的成员模板、模型和权限配置。</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { void load() }} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>
      {error && <div role="alert" className={css.error}>{error}</div>}
      <AssistantPanel catalog={catalog} assistants={assistants} onChanged={load} />
    </section>
  )
}

export function AgentTeamOverlay({
  pickWorkspace,
  openSession,
}: {
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  openSession: (sessionId: string) => void
}): JSX.Element {
  const { visible, createTeamRequest, selectedTeamId } = useAgentTeamUi()
  const { catalog, assistants, teams, error, teamsLoading, teamsError, load } = useAgentTeamData(true)
  const selectedTeam = teams.find(team => team.id === selectedTeamId)
  const hasExecutingTeam = teams.some(isTeamExecuting)
  const headerTitle = selectedTeam?.name ?? '团队'
  const headerSubtitle = selectedTeam === undefined
    ? 'Leader 与成员共享一个 Workspace'
    : `${Object.keys(selectedTeam.members).length} 名成员 · ${selectedTeam.workspacePath}`

  if (!visible) return <FloatingTeamLauncher hasExecutingTeam={hasExecutingTeam} />

  return (
    <section className={css.fullscreenWorkbench} aria-label="团队工作台">
      <aside className={css.teamNavigator} aria-label="团队列表">
        <div className={css.teamNavigatorHeader}>
          <button
            type="button"
            className={css.teamNavigatorTitle}
            onClick={openTeams}
            aria-label="查看全部团队"
            aria-current={selectedTeamId === undefined ? 'page' : undefined}
          >
            <IconAgentPresetOutlineRegular size={18} />
            <span>团队</span>
          </button>
          <Tooltip label="新建团队" delayMs={400}>
            <button type="button" className={css.teamNavigatorAdd} onClick={openTeamCreator} aria-label="新建团队">
              <IconPlusOutlineRegular size={16} />
            </button>
          </Tooltip>
        </div>
        <div className={css.teamNavigatorList}>
          {teamsLoading
            ? <div className={css.teamNavigatorEmpty} role="status">正在读取团队…</div>
            : teams.length === 0
              ? (
                <div className={css.teamNavigatorEmpty}>
                  {teamsError === undefined ? '还没有团队，点击 + 新建。' : '团队读取失败，请稍后重试。'}
                </div>
                )
              : teams.map(team => {
              const isSelected = team.id === selectedTeamId
              const executing = isTeamExecuting(team)
              return (
                <button
                  key={team.id}
                  type="button"
                  className={`${css.teamNavigatorItem} ${isSelected ? css.teamNavigatorItemActive : ''}`}
                  onClick={() => { openTeam(team.id) }}
                  aria-current={isSelected ? 'page' : undefined}
                >
                  <span className={css.teamNavigatorItemTop}>
                    <strong>{team.name}</strong>
                    {executing && <span className={`${css.badge} ${css.badgeSuccess}`}>任务执行中</span>}
                  </span>
                </button>
              )
            })}
        </div>
        <div className={css.teamNavigatorFooter}>
          <span>
            {teamsLoading
              ? '正在读取团队…'
              : teamsError !== undefined ? '团队读取失败' : `${teams.length} 个团队`}
          </span>
        </div>
      </aside>

      <div className={css.fullscreenWorkbenchMain}>
        <header className={css.shellHeader}>
          <div className={css.headerCopy}>
            <div className={css.shellTitleRow}>
              <h1 className={css.title} title={headerTitle}>{headerTitle}</h1>
              {selectedTeam !== undefined && isTeamExecuting(selectedTeam) && (
                <span className={`${css.badge} ${css.badgeSuccess ?? ''}`}>
                  任务执行中
                </span>
              )}
            </div>
            <p className={css.subtitle} title={headerSubtitle}>{headerSubtitle}</p>
          </div>
          <button type="button" className={css.iconButton} onClick={closeAgentTeam} aria-label="关闭工作台">
            <IconCloseOutlineRegular size={16} />
          </button>
        </header>
        {error && <div role="alert" className={css.error}>{error}</div>}
        <main className={`${css.content} ${selectedTeam === undefined ? '' : css.workbenchContent ?? ''}`}>
          <TeamPanel
            catalog={catalog}
            assistants={assistants}
            teams={teams}
            createRequest={createTeamRequest}
            selectedTeamId={selectedTeamId}
            pickWorkspace={pickWorkspace}
            onChanged={load}
            openSession={openSession}
            teamsLoading={teamsLoading}
            {...(teamsError === undefined ? {} : { teamsError })}
          />
        </main>
      </div>
    </section>
  )
}
