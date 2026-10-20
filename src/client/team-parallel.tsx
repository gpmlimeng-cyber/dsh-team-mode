import { useEffect, useMemo, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { TeamView } from '../transport/contracts.js'
import { IconPlusOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useAgentTeamData } from './components.js'
import { AddTeamMemberDialog } from './teams/TeamPanel.js'
import css from './AgentTeam.module.css'

/** Placeholder rendered inside the native `conversation.view` tab. The overlay
 * host portals the real panes here so the native header/tabs stay intact. */
export function TeamParallelView({ sessionId }: { sessionId?: string }): JSX.Element {
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
  onFocusSession?: (sessionId: string) => void
}

const IDENTITY_COLORS = [
  'var(--dsw-static-blue-450)',
  'var(--dsw-static-green-500)',
  'var(--dsw-static-amber-500)',
  'var(--dsw-static-deepseek-450)',
  'var(--dsw-static-red-400)',
  'var(--dsw-static-blue-600)',
  'var(--dsw-static-green-400)',
  'var(--dsw-static-amber-400)',
] as const

function identityColor(index: number): string {
  return IDENTITY_COLORS[index % IDENTITY_COLORS.length] ?? 'var(--dsw-static-blue-450)'
}

function keepParallelView(sessionId: string): void {
  try {
    // Do not point a Session at a view that is not registered yet; the shell
    // would try to restore it before its Session binding exists.
    const hasParallelTab = Array.from(document.querySelectorAll('[data-conversation-tabs] button'))
      .some(button => button.textContent === '并行')
    if (!hasParallelTab) return
    const key = `dsh.conversation.${sessionId}`
    const raw = window.localStorage.getItem(key)
    const current = raw === null ? {} : JSON.parse(raw) as Record<string, unknown>
    if (current.view === 'team-parallel') return
    window.localStorage.setItem(key, JSON.stringify({ ...current, view: 'team-parallel' }))
  } catch { /* best effort */ }
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
  onFocusSession,
}: ParallelHostProps): JSX.Element | null {
  const { teams, catalog, assistants, load } = useAgentTeamData(true)
  const [anchor, setAnchor] = useState<HTMLElement>()
  const [addMemberOpen, setAddMemberOpen] = useState(false)

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
  const members = useMemo(() => {
    if (team === undefined) return []
    return Object.values(team.members).sort((left, right) => {
      if (left.role !== right.role) return left.role === 'leader' ? -1 : 1
      return left.joinedAt.localeCompare(right.joinedAt)
    })
  }, [team])
  if (anchor === undefined || team === undefined || members.length === 0) return null

  return createPortal(
    <div className={css.teamParallelRoot}>
      <div className={css.teamParallelMemberBar}>
        <div className={css.teamParallelMemberScroll}>
          {members.map((member, index) => {
            const status = memberStatus(member)
            return (
              <div
                key={member.id}
                className={`${css.teamParallelMemberChip} ${member.sessionId === activeSessionId ? css.teamParallelMemberChipActive : ''}`}
                style={{ '--team-pane-color': identityColor(index) } as CSSProperties}
              >
                <span className={`${css.teamParallelAvatar} ${css[`teamParallelAvatar_${status}`] ?? ''}`} aria-hidden="true">
                  {initial(member.displayName)}
                </span>
                <span className={css.teamParallelMemberName}>{member.displayName}</span>
                {member.role === 'leader' && (
                  <span className={css.teamParallelLeaderCrown} aria-label="Leader" title="Leader">
                    <LeaderMark size={12} />
                  </span>
                )}
                <span className={`${css.teamParallelStatusDot} ${css[`teamParallelStatus_${status}`] ?? ''}`} aria-label={status} />
              </div>
            )
          })}
        </div>
        <Tooltip label="添加成员" side="bottom" delayMs={400}>
          <button
            type="button"
            className={css.teamParallelAddMember}
            aria-label="添加成员"
            onClick={() => { setAddMemberOpen(true) }}
          >
            <IconPlusOutlineRegular size={16} />
          </button>
        </Tooltip>
      </div>
      <div
        className={css.teamParallelGrid}
        style={{ '--team-pane-count': members.length } as CSSProperties}
      >
        {members.map((member, index) => {
          const status = memberStatus(member)
          const active = member.sessionId === activeSessionId
          return (
            <section
              key={member.id}
              className={`${css.teamParallelPane} ${active ? css.teamParallelPaneActive : ''}`}
              style={{ '--team-pane-color': identityColor(index) } as CSSProperties}
              data-team-pane={member.id}
              onPointerDown={() => {
                if (active) return
                keepParallelView(member.sessionId)
                onFocusSession?.(member.sessionId)
              }}
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
                  {modelLabel(member) !== undefined && (
                    <span
                      className={css.teamParallelModelPill}
                      title={modelLabel(member)}
                    >
                      {modelLabel(member)}
                    </span>
                  )}
                  <span className={`${css.teamParallelStatusDot} ${css[`teamParallelStatus_${status}`] ?? ''}`} aria-label={status} />
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
      <AddTeamMemberDialog
        open={addMemberOpen}
        team={team}
        catalog={catalog}
        assistants={assistants}
        onClose={() => { setAddMemberOpen(false) }}
        onChanged={async () => { await load() }}
      />
    </div>,
    anchor,
  )
}
