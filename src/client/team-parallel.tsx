import { useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { TeamView } from '../transport/contracts.js'
import { useAgentTeamData } from './components.js'
import { callAgentTeam } from './api.js'
import { assignTeamIdentityColors, teamIdentityColor } from './team-identity.js'
import { useTeamText } from './team-i18n.js'
import { setTeamConversationView } from './team-view-presence.js'
import css from './AgentTeam.module.css'

/** Placeholder rendered inside the native `conversation.view` tab. The overlay
 * host portals the real panes here so the native header/tabs stay intact. */
export function TeamParallelView({ sessionId }: { sessionId?: string }): JSX.Element {
  useEffect(() => {
    setTeamConversationView(sessionId, 'parallel')
    return () => { setTeamConversationView(sessionId, undefined) }
  }, [sessionId])
  return <div className={css.teamParallelAnchor} data-team-parallel-anchor data-session-id={sessionId ?? ''} />
}


interface ParallelHostProps {
  sessions: {
    retain: (sessionId: string, options: { source: string; signal: AbortSignal }) => {
      release: () => void
    }
  }
  SessionProvider?: ComponentType<{ session: unknown; children: ReactNode }>
  renderSlot?: (name: string, payload?: Record<string, unknown>) => ReactNode
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Restricted WebViews may reject storage; the current session still works.
  }
}

function useIdentityColors(
  teamId: string | undefined,
  members: readonly TeamView['members'][string][],
): (slotId: string) => string {
  const [colors, setColors] = useState<Record<string, number>>({})
  const memberKey = members.map(member => member.id).join('|')
  useEffect(() => {
    if (teamId === undefined) {
      setColors({})
      return
    }
    const stored = readStored<Record<string, number>>(`dsh-team-mode:colors:${teamId}`, {})
    const { colors: next, changed } = assignTeamIdentityColors(stored, members.map(member => member.id))
    setColors(next)
    if (changed) writeStored(`dsh-team-mode:colors:${teamId}`, next)
  }, [teamId, memberKey])
  return slotId => teamIdentityColor(colors[slotId] ?? 0)
}

function sortMembers(team: TeamView): TeamView['members'][string][] {
  const order = team.memberOrder ?? Object.keys(team.members)
  const rank = new Map(order.map((id, index) => [id, index]))
  return Object.values(team.members).sort((left, right) =>
    (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || left.joinedAt.localeCompare(right.joinedAt))
}

function memberStatus(member: TeamView['members'][string]): 'running' | 'waiting' | 'idle' | 'failed' {
  const state = member.lastRuntimeState
  if (state === 'running' || state === 'waiting_approval') return state === 'waiting_approval' ? 'waiting' : 'running'
  if (state === 'error') return 'failed'
  return 'idle'
}

function initial(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase() || '?'
}

function LeaderMark({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} role="presentation" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 7.4 8.2 11 12 4l3.8 7L21 7.4 19.1 18H4.9L3 7.4Zm1.1 12.4h15.8V22H4.1v-2.2Z" fill="currentColor" />
    </svg>
  )
}

function ModelSeat(): JSX.Element {
  const holder = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const host = holder.current
    const pane = host?.closest('[data-team-pane]')
    if (host === null || host === undefined || pane === undefined || pane === null) return
    let slot: HTMLElement | null = null
    let moveObserver: MutationObserver | undefined
    const move = (): void => {
      const node = slot?.firstElementChild
      if (node !== undefined && node !== null && node.parentElement !== host) host.appendChild(node)
    }
    const attach = (): void => {
      if (slot !== null && slot.isConnected) return
      slot = pane.querySelector<HTMLElement>('[data-slot="conversation.input.model"]')
      if (slot === null) return
      move()
      moveObserver?.disconnect()
      moveObserver = new MutationObserver(move)
      moveObserver.observe(slot, { childList: true })
    }
    const paneObserver = new MutationObserver(attach)
    paneObserver.observe(pane, { childList: true, subtree: true })
    attach()
    return () => {
      paneObserver.disconnect()
      moveObserver?.disconnect()
      const node = host.firstElementChild
      if (node !== null && slot !== null && node.parentElement === host) slot.appendChild(node)
    }
  }, [])
  return <span ref={holder} className={css.teamParallelModelSeat} data-team-model-seat="" />
}

function MaximizeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" role="presentation" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" />
    </svg>
  )
}

function RestoreIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" role="presentation" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4" />
    </svg>
  )
}

function modelLabel(member: TeamView['members'][string]): string | undefined {
  const model = member.assistantSnapshot?.model
  return typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined
}

function RetainedPane({
  member,
  sessions,
  SessionProvider,
  renderSlot,
}: {
  member: TeamView['members'][string]
  sessions: ParallelHostProps['sessions']
  SessionProvider?: ParallelHostProps['SessionProvider']
  renderSlot?: ParallelHostProps['renderSlot']
}): JSX.Element {
  const [reference, setReference] = useState<{ release: () => void }>()
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    try {
      const next = sessions.retain(member.sessionId, { source: 'teamParallel', signal: controller.signal })
      setReference(next)
      return () => {
        controller.abort()
        next.release()
        setReference(undefined)
      }
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    }
    return () => { controller.abort() }
  }, [member.sessionId, sessions])

  if (failure !== undefined) return <div className={css.teamPaneError}>{failure}</div>
  if (reference === undefined) return <div className={css.teamPaneLoading}>正在加载会话…</div>
  if (SessionProvider === undefined || renderSlot === undefined) {
    return <div className={css.teamPaneError}>官方会话上下文不可用</div>
  }
  return (
    <SessionProvider session={reference}>
      {renderSlot('team.parallel.pane', {
        memberName: member.displayName,
        memberRole: member.role,
      })}
    </SessionProvider>
  )
}

/** Session-scoped shell-overlay host: portals a grid of official embedded
 * conversations into the active `team-parallel` view anchor. */

export function TeamParallelHost({
  sessions,
  SessionProvider,
  renderSlot,
}: ParallelHostProps): JSX.Element | null {
  const { teams, load } = useAgentTeamData(true)
  const t = useTeamText()
  const [anchor, setAnchor] = useState<HTMLElement>()

  useEffect(() => {
    const locate = (): void => {
      const next = document.querySelector<HTMLElement>('[data-team-parallel-anchor]') ?? undefined
      setAnchor(current => current === next ? current : next)
    }
    locate()
    const observer = new MutationObserver(locate)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  const activeSessionId = anchor?.dataset.sessionId
  const team = useMemo(() => teams.find(candidate =>
    Object.values(candidate.members).some(member => member.sessionId === activeSessionId),
  ), [teams, activeSessionId])
  const members = useMemo(() => team === undefined ? [] : sortMembers(team), [team])
  const [maximizedSlotId, setMaximizedSlotId] = useState<string>()
  useEffect(() => { setMaximizedSlotId(undefined) }, [activeSessionId])
  useEffect(() => {
    if (maximizedSlotId === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMaximizedSlotId(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [maximizedSlotId])
  const maximizedSlot = maximizedSlotId !== undefined && team?.members[maximizedSlotId] !== undefined
    ? maximizedSlotId
    : undefined
  const renderedMembers = maximizedSlot === undefined
    ? members
    : members.filter(member => member.id === maximizedSlot)
  const [pendingBySlot, setPendingBySlot] = useState<Record<string, number>>({})
  useEffect(() => {
    if (team === undefined) {
      setPendingBySlot({})
      return
    }
    let live = true
    void callAgentTeam('team.workbench.get', { id: team.id }).then(view => {
      if (!live) return
      const next: Record<string, number> = {}
      for (const conversation of view.conversations) {
        const count = conversation.pendingInteractions.length
        if (count > 0) next[conversation.slotId] = count
      }
      setPendingBySlot(next)
    }).catch(() => {
      if (live) setPendingBySlot({})
    })
    return () => { live = false }
  }, [team])
  const colorOf = useIdentityColors(team?.id, members)
  const [warmupTimedOut, setWarmupTimedOut] = useState(false)
  useEffect(() => {
    if (team?.warmup?.phase !== 'starting') {
      setWarmupTimedOut(false)
      return
    }
    const timer = setTimeout(() => { setWarmupTimedOut(true) }, 60_000)
    return () => { clearTimeout(timer) }
  }, [team?.warmup?.phase])
  const retryWarmup = async (slotId?: string): Promise<void> => {
    if (team === undefined) return
    try {
      await callAgentTeam(
        'team.warmup.retry',
        slotId === undefined ? { teamId: team.id } : { teamId: team.id, slotId },
        team.revision,
      )
    } catch {
      // A revision conflict or an unavailable member: reload and let the
      // overlay show the current state instead of an unhandled rejection.
    } finally {
      await load()
    }
  }
  if (anchor === undefined || team === undefined || members.length === 0) return null
  const warmup = team.warmup
  const leader = team.members[team.leaderSlotId]
  return createPortal(
    <div className={css.teamParallelRoot}>
      <div
        className={css.teamParallelGrid}
        style={{ '--team-pane-count': renderedMembers.length } as CSSProperties}
      >
        {renderedMembers.map(member => {
          const status = memberStatus(member)
          const active = member.sessionId === activeSessionId
          return (
            <section
              key={member.id}
              className={`${css.teamParallelPane} ${active ? css.teamParallelPaneActive : ''}`}
              style={{ '--team-pane-color': colorOf(member.id) } as CSSProperties}
              data-team-pane={member.id}
            >
              <header className={css.teamParallelPaneHeader}>
                <span className={css.teamParallelPaneIdentity}>
                  <span className={`${css.teamParallelAvatar} ${css[`teamParallelAvatar_${status}`] ?? ''}`} aria-hidden="true">
                    {initial(member.displayName)}
                  </span>
                  <strong className={css.teamParallelPaneName}>{member.displayName}</strong>
                  {member.role === 'leader' && (
                    <span className={css.teamParallelLeaderCrown} aria-label="Leader" title="Leader">
                      <LeaderMark size={12} />
                    </span>
                  )}
                  <span className={`${css.teamParallelStatusDot} ${css[`teamParallelStatus_${status}`] ?? ''}`} aria-label={status} />
                  {(pendingBySlot[member.id] ?? 0) > 0 && (
                    <span
                      className={css.teamParallelPendingBadge}
                      title={`${pendingBySlot[member.id]} 个待确认`}
                      aria-label={`${pendingBySlot[member.id]} 个待确认`}
                    >
                      {pendingBySlot[member.id]}
                    </span>
                  )}
                  {member.lastRuntimeState === 'error' && (
                    <button
                      type="button"
                      className={css.teamPaneRetry}
                      title={member.lastError ?? '重试启动'}
                      onClick={() => { void retryWarmup(member.id) }}
                    >
                      {t('member.retry')}
                    </button>
                  )}
                </span>
                <span className={css.teamParallelPaneActions}>
                  <ModelSeat />
                  <button
                    type="button"
                    className={css.teamParallelMaximize}
                    aria-label={maximizedSlot === member.id ? `还原 ${member.displayName}` : `最大化 ${member.displayName}`}
                    aria-pressed={maximizedSlot === member.id}
                    title={maximizedSlot === member.id ? '还原' : '最大化'}
                    onClick={() => {
                      setMaximizedSlotId(current => current === member.id ? undefined : member.id)
                    }}
                  >
                    {maximizedSlot === member.id ? <RestoreIcon /> : <MaximizeIcon />}
                  </button>
                </span>
              </header>
              <div className={css.teamParallelPaneBody}>
                <RetainedPane
                  member={member}
                  sessions={sessions}
                  SessionProvider={SessionProvider}
                  renderSlot={renderSlot}
                />
              </div>
            </section>
          )
        })}
      </div>
      {(warmup?.phase === 'starting' || warmup?.phase === 'error') && (
        <div className={css.teamWarmupOverlay} role="status" aria-live="polite">
          <div className={css.teamWarmupCard}>
            <div className={css.teamWarmupTitle}>
              {warmup.phase === 'error'
                ? t('warmup.errorTitle')
                : (warmupTimedOut ? t('warmup.timeoutTitle') : t('warmup.title'))}
            </div>
            <p className={css.teamWarmupText}>
              {warmup.phase === 'error'
                ? (leader?.lastError ?? t('warmup.leaderFailed'))
                : (warmupTimedOut
                    ? t('warmup.timeoutText')
                    : t('warmup.preparing', { name: leader?.displayName ?? 'Leader' }))}
            </p>
            {(warmup.failedSlotIds ?? []).length > 0 && (
              <p className={css.teamWarmupText}>
                {t('warmup.failed', {
                  names: warmup.failedSlotIds?.map(id => team.members[id]?.displayName ?? id).join(', ') ?? '',
                })}
              </p>
            )}
            <button
              type="button"
              className={css.teamWarmupRetry}
              onClick={() => { void retryWarmup() }}
            >
              {t('warmup.retry')}
            </button>
          </div>
        </div>
      )}
    </div>,
    anchor,
  )
}
