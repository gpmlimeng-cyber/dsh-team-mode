import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { MemberAvatar } from './member-avatar.js'
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamView } from '../transport/contracts.js'
import { useAgentTeamData } from './components.js'
import { callAgentTeam } from './api.js'
import { assignTeamIdentityColors, teamIdentityColor } from './team-identity.js'
import { useTeamText } from './team-i18n.js'
import { setTeamConversationView } from './team-view-presence.js'
import {
  TEAM_MENTION_BUSY,
  TEAM_MENTION_HINT,
  TEAM_MENTION_LABEL,
  teamMentionInsertion,
  teamMentionText,
} from './labels.js'
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
    refresh?: () => Promise<void>
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

// Near-white tints sampled from AionUI's parallel panes; the member identity
// color stays on the name/avatar only, never on the canvas.
const PANE_TINTS = ['#F9F9F8', '#F9FBFB', '#FCFAF9', '#FAF9FC']

/** What the official composer inside a 群聊 pane needs to offer mentions. */
export interface TeamMentionScope {
  readonly team: TeamView
  /** The pane's own member: they are already the addressee, so not offered. */
  readonly selfSlotId: string
}

/**
 * Provided around each 群聊 pane and nowhere else. The mention entry renders
 * only where this context exists, so no other conversation grows the action and
 * no extra team read is issued to decide that.
 */
export const TeamMentionContext = createContext<TeamMentionScope | undefined>(undefined)

/** The host composer verbs this entry uses; all writes go through the editor. */
interface ComposerInsertionSpan {
  start: number
  end: number
  draftRev: number
}

interface ComposerInputActions {
  captureInsertion: () => ComposerInsertionSpan
  insertText: (text: string, span: ComposerInsertionSpan) => boolean
  setDraft: (text: string) => void
}

interface ComposerInputState {
  draft?: string
  phase?: string
  occurrences?: readonly unknown[]
}

interface MentionCandidate {
  id: string
  name: string
  avatar?: string
  role: 'leader' | 'member'
  mention: string
}

/**
 * The members a pane can address, in roster order. The pane's own member is
 * skipped (already the addressee) and a blank display name yields no token, so
 * no option can insert a mention the runtime would never route.
 */
export function teamMentionCandidates(team: TeamView, selfSlotId: string): MentionCandidate[] {
  const rows: MentionCandidate[] = []
  for (const member of sortMembers(team)) {
    if (member.id === selfSlotId) continue
    const mention = teamMentionText(member.displayName)
    if (mention === undefined) continue
    const avatar = member.assistantSnapshot?.avatar
    rows.push({
      id: member.id,
      name: member.displayName,
      ...(typeof avatar === 'string' && avatar !== '' ? { avatar } : {}),
      role: member.role,
      mention,
    })
  }
  return rows
}

/**
 * `conversation.input.left` entry: one `@` button beside the official composer
 * of a 群聊 pane. It never sends, submits or replaces the composer — it writes
 * the mention token into the host editor through `inputActions`, leaving the
 * native draft, chips, attachments and send path untouched.
 *
 * A native pane turn still goes to that pane's member: mention routing only
 * happens when text travels through the team message pipeline, and this entry
 * must not be read as re-routing a native turn.
 */
export function TeamMentionAction(props: any): JSX.Element | null {
  const scope = useContext(TeamMentionContext) as TeamMentionScope | undefined
  const inputActions = props.inputActions as ComposerInputActions | undefined
  // The session-scoped `input` hook is provided by the host; without it the
  // insertion still works from the captured caret alone.
  const input = (typeof props.useInput === 'function'
    ? props.useInput((state: ComposerInputState) => state)
    : undefined) as ComposerInputState | undefined
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [placement, setPlacement] = useState<{ left: number; bottom: number; width: number }>()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  /**
   * The pane clips its own conversation box, so the picker is portaled to the
   * body and measured from the `@` button: it stays visible on a 320px phone
   * pane instead of being cut off by the pane overflow.
   */
  const place = useCallback((): void => {
    const trigger = triggerRef.current
    if (trigger === null || typeof window === 'undefined') return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(288, Math.max(160, window.innerWidth - 32))
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    setPlacement({ left, bottom: window.innerHeight - rect.top + 8, width })
  }, [])
  const candidates = useMemo<MentionCandidate[]>(
    () => (scope === undefined ? [] : teamMentionCandidates(scope.team, scope.selfSlotId)),
    [scope],
  )

  useEffect(() => {
    if (!open) {
      setPlacement(undefined)
      return
    }
    place()
    // A scrolled or resized composer would leave a fixed popover behind: close
    // instead of tracking, which also keeps the picker off a moving send button.
    const close = (): void => { setOpen(false) }
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open, place])

  useEffect(() => {
    if (!open || placement === undefined) return
    listRef.current?.querySelector<HTMLButtonElement>('button[role="option"]')?.focus()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target) === true) return
      if (popoverRef.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [open, placement])

  const choose = useCallback((mention: string): void => {
    if (inputActions === undefined) return
    const draft = typeof input?.draft === 'string' ? input.draft : ''
    if (input?.phase !== undefined && input.phase !== 'plain') {
      setNotice(TEAM_MENTION_BUSY)
      return
    }
    const insert = (): boolean => {
      const span = inputActions.captureInsertion()
      // `start` is a detect-projection offset: when the draft holds chips it can
      // sit a few characters off the clipboard text, which at worst picks the
      // separator. The token itself stays exactly what the router parses.
      return inputActions.insertText(teamMentionInsertion(mention, draft.slice(0, span.start)), span)
    }
    // A draft edit between capture and insert only invalidates the captured
    // revision, so one retry with a fresh capture is enough.
    if (!insert() && !insert()) {
      // A plain draft can be rewritten wholesale; a draft holding chips cannot,
      // because `setDraft` would drop its references.
      if ((input?.occurrences?.length ?? 0) > 0) {
        setNotice(TEAM_MENTION_BUSY)
        return
      }
      inputActions.setDraft(`${draft}${teamMentionInsertion(mention, draft)}`)
    }
    setNotice(undefined)
    setOpen(false)
    triggerRef.current?.focus()
  }, [input, inputActions])

  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? [],
    )
    if (options.length === 0) return
    const current = document.activeElement
    const index = current instanceof HTMLButtonElement ? options.indexOf(current) : -1
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step !== 0) {
      event.preventDefault()
      options[(index + step + options.length) % options.length]?.focus()
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const target = event.key === 'Home' ? options[0] : options[options.length - 1]
      target?.focus()
    }
  }

  // Outside a 群聊 pane, or with nothing to mention, the entry stays absent.
  if (scope === undefined || inputActions === undefined || candidates.length === 0) return null

  return (
    <div className={css.teamMentionRoot} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={css.teamMentionTrigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={TEAM_MENTION_LABEL}
        title={TEAM_MENTION_HINT}
        onClick={() => { setOpen(value => !value) }}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setOpen(true)
        }}
      >
        @
      </button>
      {open && placement !== undefined && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className={css.teamMentionPopover}
          style={{ left: placement.left, bottom: placement.bottom, width: placement.width }}
          role="presentation"
          onKeyDown={onListKeyDown}
        >
          <p className={css.teamMentionTitle}>{TEAM_MENTION_LABEL}</p>
          <ul className={css.teamMentionList} role="listbox" aria-label={TEAM_MENTION_LABEL} ref={listRef}>
            {candidates.map(candidate => (
              <li key={candidate.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className={css.teamMentionOption}
                  onClick={() => { choose(candidate.mention) }}
                >
                  <MemberAvatar
                    name={candidate.name}
                    avatar={candidate.avatar}
                    size={18}
                  />
                  <span className={css.teamMentionName}>{candidate.name}</span>
                  {candidate.role === 'leader' && (
                    <span className={css.teamMentionLeader}>Leader</span>
                  )}
                  <span className={css.teamMentionToken}>{candidate.mention.trim()}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className={css.teamMentionHint}>{TEAM_MENTION_HINT}</p>
          {notice !== undefined && (
            <p className={css.teamMentionNotice} role="status">{notice}</p>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
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
  return (
    <span ref={holder} className={css.teamParallelModelSeat} data-team-model-seat="">
      <span className={css.teamParallelModelGlyph} aria-hidden="true">
        <IconAgentPresetOutlineRegular size={14} />
      </span>
    </span>
  )
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
    let active = true
    let reference: { release: () => void } | undefined

    const acquire = (retried: boolean): void => {
      try {
        const next = sessions.retain(member.sessionId, { source: 'teamParallel', signal: controller.signal })
        reference = next
        setReference(next)
        setFailure(undefined)
      } catch (cause) {
        // A member added while the workbench is already open has a brand-new
        // Session that the client catalog has not listed yet. Refresh the
        // catalog once and retry before surfacing the retain failure.
        if (!retried && sessions.refresh !== undefined) {
          void sessions.refresh().then(() => {
            if (active && !controller.signal.aborted) acquire(true)
          }).catch(() => {
            if (active) setFailure(cause instanceof Error ? cause.message : String(cause))
          })
          return
        }
        if (active) setFailure(cause instanceof Error ? cause.message : String(cause))
      }
    }

    acquire(false)
    return () => {
      active = false
      controller.abort()
      reference?.release()
      setReference(undefined)
    }
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
        {renderedMembers.map((member, index) => {
          const status = memberStatus(member)
          const active = member.sessionId === activeSessionId
          return (
            <section
              key={member.id}
              className={`${css.teamParallelPane} ${active ? css.teamParallelPaneActive : ''}`}
              style={{ '--team-pane-color': colorOf(member.id), '--team-pane-tint': PANE_TINTS[index % PANE_TINTS.length] } as CSSProperties}
              data-team-pane={member.id}
            >
              <header className={css.teamParallelPaneHeader}>
                <span className={css.teamParallelPaneIdentity}>
                  <MemberAvatar
                    name={member.displayName}
                    avatar={member.assistantSnapshot?.avatar}
                    size={24}
                  />
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
                <TeamMentionContext.Provider value={{ team, selfSlotId: member.id }}>
                  <RetainedPane
                    member={member}
                    sessions={sessions}
                    SessionProvider={SessionProvider}
                    renderSlot={renderSlot}
                  />
                </TeamMentionContext.Provider>
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
