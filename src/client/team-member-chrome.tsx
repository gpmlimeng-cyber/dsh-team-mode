import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArchiveOutlineRegular,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconPauseOutlineRegular,
  IconPlayOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconUnarchiveOutlineRegular,
  IconUsersOutlineRegular,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, subscribeAgentTeam, teamLeaderSessionId } from './api.js'
import { setTeamPanelOpen } from './store.js'
import { openAssistantDetail } from './assistant-settings-pane.js'
import { assistantLineageTitle } from './assistant-session-title.js'
import css from './AgentTeam.module.css'
import { MemberAvatar } from './member-avatar.js'
import {
  SessionPresetMeta,
  agentPresetLabel,
  hideNativePresetLabels,
  knownPresetNames,
  useAgentCatalog,
} from './agent-preset-label.js'
import type { AssistantInstanceView, TeamView } from '../transport/contracts.js'
import type { AssistantInstance } from '../domain/types.js'
import { Mascot } from './mascot-view.js'
import { teamAvatarStack } from './team-avatar.js'
import { assistantShowsMascot, mascotOptionsFor } from './mascot.js'
import { assistantInstanceForSession, assistantInstanceName } from './assistant-instances.js'

type TeamMember = TeamView['members'][string]
type TeamThread = NonNullable<TeamView['threads']>[string]

export function LeaderMark({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} role="presentation" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 7.4 8.2 11 12 4l3.8 7L21 7.4 19.1 18H4.9L3 7.4Zm1.1 12.4h15.8V22H4.1v-2.2Z" fill="currentColor" />
    </svg>
  )
}

/** The team whose conversation this Session is, if any. A Session outside every
 *  team (a plain assistant chat) resolves to undefined and gets no control. */
export function teamOwningSession(
  teams: readonly TeamView[],
  sessionId: string | undefined,
): TeamView | undefined {
  if (sessionId === undefined) return undefined
  return teams.find(candidate => (
    Object.values(candidate.members).some(member => member.sessionId === sessionId)
    || Object.values(candidate.threads ?? {}).some(thread => thread.sessionId === sessionId)
    || teamLeaderSessionId(candidate) === sessionId
  ))
}

/** Resolves the team owning this Session — a member Session, a thread Session,
 *  or the team main Session — so the header switcher can render on any of them. */
function useTeamForSession(sessionId?: string): TeamView | undefined {
  const [team, setTeam] = useState<TeamView>()
  useEffect(() => {
    // Never keep the previous Session's team while this one resolves.
    setTeam(undefined)
    if (sessionId === undefined) return
    let live = true
    const load = async (): Promise<void> => {
      try {
        const value = await callAgentTeam('team.list')
        if (!live) return
        setTeam(teamOwningSession(value.items, sessionId))
      } catch {
        if (live) setTeam(undefined)
      }
    }
    void load()
    return subscribeAgentTeam(() => { void load() }, () => {}, () => { void load() })
  }, [sessionId])
  return team
}

function sortedMembers(team: TeamView): TeamMember[] {
  return Object.values(team.members).sort((left, right) => {
    if (left.role !== right.role) return left.role === 'leader' ? -1 : 1
    return left.joinedAt.localeCompare(right.joinedAt)
  })
}

/**
 * A thread's owner as the UI shows it. The explicit `ownerSlotId` wins; a
 * thread stored before ownership existed (or one whose owner left the team)
 * falls back to the Leader, so the row is never blank.
 */
function threadOwnerOf(team: TeamView, thread: TeamThread): Pick<SwitcherThreadRow, 'ownerSlotId' | 'ownerName' | 'ownerLeader' | 'ownerAvatar'> {
  const explicit = thread.ownerSlotId === undefined ? undefined : team.members[thread.ownerSlotId]
  const member = explicit ?? team.members[team.leaderSlotId]
  const ownerSlotId = member?.id ?? thread.ownerSlotId ?? team.leaderSlotId
  return {
    ownerSlotId,
    ownerName: member?.displayName ?? ownerSlotId,
    ownerLeader: member === undefined ? true : member.role === 'leader',
    ...(member?.assistantSnapshot.avatar === undefined ? {} : { ownerAvatar: member.assistantSnapshot.avatar }),
  }
}

function keepChatView(sessionId: string): void {
  try {
    const key = `dsh.conversation.${sessionId}`
    const raw = window.localStorage.getItem(key)
    const current = raw === null ? {} : JSON.parse(raw) as Record<string, unknown>
    if (current.view === 'chat') return
    window.localStorage.setItem(key, JSON.stringify({ ...current, view: 'chat' }))
  } catch { /* best effort */ }
}

/** Relative time for a thread row; mirrors the sidebar's phrasing. */
function relativeTime(iso: string | number): string {
  const timestamp = typeof iso === 'number' ? iso : Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''
  const diff = Math.max(0, Date.now() - timestamp)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export interface SwitcherMemberRow {
  sessionId: string
  name: string
  avatar?: string
  leader: boolean
  current: boolean
}

export interface SwitcherThreadRow {
  id: string
  sessionId: string
  title: string
  updatedAt: number
  current: boolean
  /**
   * The thread's resolved owner: an explicit `ownerSlotId`, else the team
   * Leader. Reads fall back here because threads stored before ownership
   * existed carry no field; a row never shows a blank owner.
   */
  ownerSlotId: string
  ownerName: string
  ownerLeader: boolean
  /** The owner's avatar, when that member carries one. */
  ownerAvatar?: string
  /** Present when paused; presence is the state (there is no separate boolean). */
  pausedAt?: number
  /** True only for a retired thread; the panel lists active threads today. */
  archived?: boolean
}

/** One member offered by the thread's second-level 设置负责人 menu. */
export interface ThreadOwnerOption {
  slotId: string
  name: string
  leader: boolean
  /** The person currently responsible for the thread. */
  current: boolean
  avatar?: string
}

/** The thread controls, in menu order. `restore` acts on a retired thread. */
export type ThreadControlId = 'rename' | 'assign' | 'stop' | 'resume' | 'archive' | 'restore'

export interface ThreadMenuItem {
  id: ThreadControlId
  label: string
  /** Unavailable rows stay listed but disabled — hiding them reads as "no such feature". */
  disabled: boolean
  /** Set on `assign`: the second-level member list. */
  submenu?: ThreadOwnerOption[]
}

export interface ThreadMenuModel {
  /** The resolved owner, so the second-level list can check exactly one row. */
  currentOwnerSlotId: string
  items: ThreadMenuItem[]
}

export interface SessionSwitcherModel {
  /** The object this Session shows: its member name, else the thread title. */
  currentName: string
  /** Members first; the current one is pinned to the top of its group. */
  members: SwitcherMemberRow[]
  /** Real threads only, newest first; the current one is pinned to the top. */
  threads: SwitcherThreadRow[]
  /** False when no row targets a different Session: no point rendering a switcher. */
  switchable: boolean
  /** Preset recorded for the Session's composition; absent when no team row names it. */
  agentPresetId?: string
}

/**
 * What the header switcher would show for one Session, as plain data so the
 * grouping, ordering and filtering are testable without a browser. Members and
 * threads are two groups; `query` filters both by display name / thread title.
 */
export function sessionSwitcherModel(
  team: TeamView,
  sessionId: string,
  query = '',
): SessionSwitcherModel {
  const normalized = query.trim().toLocaleLowerCase()
  const matches = (value: string): boolean =>
    normalized === '' || value.toLocaleLowerCase().includes(normalized)

  const currentMember = Object.values(team.members).find(member => member.sessionId === sessionId)
  const currentThread = Object.values(team.threads ?? {}).find(thread => thread.sessionId === sessionId)
  const currentName = currentMember?.displayName ?? currentThread?.title ?? team.name
  // A member Session runs its member's preset; a thread runs its speaker's
  // (the Leader by default); anything else falls back to the Leader's.
  const speakerSlotId = currentThread?.speakerSlotId ?? team.leaderSlotId
  const agentPresetId = currentMember?.assistantSnapshot.agentPresetId
    ?? team.members[speakerSlotId]?.assistantSnapshot.agentPresetId

  const members = sortedMembers(team)
    .map(member => ({
      sessionId: member.sessionId,
      name: member.displayName,
      ...(member.assistantSnapshot.avatar === undefined ? {} : { avatar: member.assistantSnapshot.avatar }),
      leader: member.role === 'leader',
      current: member.sessionId === sessionId,
    }))
    .filter(member => matches(member.name))
    .sort((left, right) => Number(right.current) - Number(left.current))

  const threads: SwitcherThreadRow[] = Object.values(team.threads ?? {})
    .sort((left: TeamThread, right: TeamThread) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .map(thread => ({
      id: thread.id,
      sessionId: thread.sessionId,
      title: thread.title,
      updatedAt: thread.updatedAt,
      current: thread.sessionId === sessionId,
      ...threadOwnerOf(team, thread),
      ...(thread.pausedAt === undefined ? {} : { pausedAt: thread.pausedAt }),
    }))
    .filter(thread => matches(thread.title))
    .sort((left, right) => Number(right.current) - Number(left.current))

  const targets = [
    ...Object.values(team.members).map(member => member.sessionId),
    ...Object.values(team.threads ?? {}).map(thread => thread.sessionId),
  ]
  return {
    currentName,
    members,
    threads,
    switchable: targets.some(target => target !== sessionId),
    ...(agentPresetId === undefined ? {} : { agentPresetId }),
  }
}

/**
 * The ⋯ menu for one thread row, as plain data so the six controls and their
 * disabled states are testable without a browser. Every control is always
 * listed; the ones that cannot act on this thread are disabled, because a
 * hidden row reads as "this feature does not exist".
 */
export function threadMenuModel(team: TeamView, thread: SwitcherThreadRow): ThreadMenuModel {
  const paused = thread.pausedAt !== undefined
  const owners: ThreadOwnerOption[] = sortedMembers(team).map(member => ({
    slotId: member.id,
    name: member.displayName,
    leader: member.role === 'leader',
    current: member.id === thread.ownerSlotId,
    ...(member.assistantSnapshot.avatar === undefined ? {} : { avatar: member.assistantSnapshot.avatar }),
  }))
  const items: ThreadMenuItem[] = [
    { id: 'rename', label: '重命名', disabled: false },
    { id: 'assign', label: '设置负责人', disabled: owners.length === 0, submenu: owners },
    { id: 'stop', label: '暂停', disabled: paused || thread.archived === true },
    { id: 'resume', label: '恢复', disabled: !paused || thread.archived === true },
    { id: 'archive', label: '归档', disabled: thread.archived === true },
    // Restore acts on a retired thread, and this panel lists active threads
    // only — so the row stays visible-but-disabled instead of quietly
    // disappearing. The archived-thread view that enables it ships with the
    // visibility batch (批四).
    { id: 'restore', label: '恢复归档', disabled: thread.archived !== true },
  ]
  return { currentOwnerSlotId: thread.ownerSlotId, items }
}

/**
 * One leading icon per thread control. Built at render (not module scope) so a
 * test that stubs the primitive set never constructs an unstubbed icon.
 */
function threadControlIcon(id: ThreadControlId): JSX.Element {
  switch (id) {
    case 'rename': return <IconEditOutlineRegular size={14} />
    case 'assign': return <IconUsersOutlineRegular size={14} />
    case 'stop': return <IconPauseOutlineRegular size={14} />
    case 'resume': return <IconPlayOutlineRegular size={14} />
    case 'archive': return <IconArchiveOutlineRegular size={14} />
    case 'restore': return <IconUnarchiveOutlineRegular size={14} />
  }
}

/** Session-header switch: jump between a team's members and its threads.
 *  Renders only on a Session owned by a team; a bare Session shows nothing. */
/** At most three topics fit beside the title; the rest live in the panel. */
export interface SessionTabRow {
  sessionId: string
  title: string
  current: boolean
}

export function sessionTabRows(
  team: TeamView,
  sessionId: string,
  limit = 3,
): SessionTabRow[] {
  const rows = Object.values(team.threads ?? {})
    .sort((left: TeamThread, right: TeamThread) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .map(thread => ({
      sessionId: thread.sessionId,
      title: thread.title,
      current: thread.sessionId === sessionId,
    }))
    .sort((left, right) => Number(right.current) - Number(left.current))
  const current = rows.find(row => row.current)
  const rest = rows.filter(row => !row.current)
  const picked = current === undefined ? rest : [current, ...rest]
  return picked.slice(0, limit)
}



/**
 * Replaces the crumb: an assistant's Session names that assistant, a team's own
 * Session stacks its members' faces and then the team name.
 */
/** Shared read of every instance, refreshed by the plugin's change stream. */
function useAssistantInstances(): AssistantInstance[] {
  const [instances, setInstances] = useState<AssistantInstance[]>([])
  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      try {
        const value = await callAgentTeam('assistant.instance.list')
        if (live) setInstances(value.items)
      } catch {
        // Keep the previous set; the stream retries on the next snapshot.
      }
    }
    void load()
    const unsubscribe = subscribeAgentTeam(() => { void load() }, () => {}, () => { void load() })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  return instances
}

/** The single-assistant title: the same face-and-name button as a team's. */
export function AssistantSessionTitle({
  lineageSessionId,
  displayTitle,
}: {
  lineageSessionId?: string
  displayTitle?: string
}): JSX.Element | null {
  const instances = useAssistantInstances()
  const instance = assistantInstanceForSession(instances, lineageSessionId)
  const label = assistantLineageTitle(instance, displayTitle)
  if (label === undefined || instance === undefined) return null
  return (
    <button
      type="button"
      className={`${css.teamSessionTitle} ${css.teamSessionTitleButton}`}
      data-dsh-assistant-session-title
      title={`${label} · 查看详情`}
      aria-label={`查看 ${label} 的详情`}
      onClick={() => { openAssistantDetail(instance.id) }}
    >
      <span className={css.teamSessionTitleFace}>
        {assistantShowsMascot(instance)
          ? <Mascot {...mascotOptionsFor(instance)} size={16} avatarShape="rounded" animated={false} />
          : <MemberAvatar name={label} avatar={instance.assistantSnapshot.avatar} size={16} />}
      </span>
      <span className={css.teamSessionTitleName}>{label}</span>
    </button>
  )
}

export function TeamSessionTitle({ lineageSessionId }: { lineageSessionId?: string }): JSX.Element | null {
  const team = useTeamForSession(lineageSessionId)
  if (team === undefined || lineageSessionId === undefined) return null

  // The header answers "which team am I in", not "which thread": every Session
  // of a team names the team, so switching members never changes the title.
  // The same stack the sidebar's team row draws: mascot per member, uploaded
  // image when there is one, so the header cannot drift from the list.
  const faces = teamAvatarStack(team.members).faces.slice(0, 3)
  return (
    <button
      type="button"
      className={`${css.teamSessionTitle} ${css.teamSessionTitleButton}`}
      data-dsh-team-session-title
      title={`${team.name} · 查看详情`}
      aria-label={`查看 ${team.name} 的详情`}
      onClick={() => { setTeamPanelOpen(true) }}
    >
      {faces.length > 0 && (
        <span className={css.teamSessionTitleFaces} aria-hidden="true">
          {faces.map(face => (
            <span key={face.id} className={css.teamSessionTitleFace}>
              {face.avatar === undefined
                ? <Mascot seed={face.mascotSeed} options={{ bodyColor: face.mascotColor }} size={16} avatarShape="rounded" animated={false} />
                : <MemberAvatar name={face.name} avatar={face.avatar} size={16} />}
            </span>
          ))}
        </span>
      )}
      <span className={css.teamSessionTitleName}>{team.name}</span>
    </button>
  )
}

/** Mounted for every Session; registers the lineage title only for a team one. */
export function TeamSessionTitleHost({
  sessionId,
  registerTitle,
}: {
  sessionId?: string
  registerTitle: () => (() => void) | void
}): null {
  const team = useTeamForSession(sessionId)
  const active = team !== undefined && sessionId !== undefined
  const registerRef = useRef(registerTitle)
  registerRef.current = registerTitle
  useEffect(() => {
    if (!active) return
    const dispose = registerRef.current()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, [active])
  return null
}



export function TeamSessionSwitcher({
  sessionId,
  openSession,
}: {
  sessionId?: string
  openSession?: (sessionId: string) => void
}): JSX.Element | null {
  const team = useTeamForSession(sessionId)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; title: string }>()
  const [threadMenu, setThreadMenu] = useState<string>()
  const searchRef = useRef<HTMLInputElement>(null)
  /** Set while closing, so the host Menu's focus return cannot reopen us. */
  const skipFocusOpen = useRef(false)
  /** A pointer press focuses the trigger too; opening is the click's job then. */
  const pointerFocus = useRef(false)
  const hoverClose = useRef<ReturnType<typeof setTimeout>>()

  const model = useMemo(
    () => (team === undefined || sessionId === undefined
      ? undefined
      : sessionSwitcherModel(team, sessionId, query)),
    [team, sessionId, query],
  )

  // Neither surface changes until the catalog read settles: an unread catalog
  // would otherwise print a raw id and hide nothing.
  const catalog = useAgentCatalog()
  const presetLabel = catalog === undefined
    ? undefined
    : agentPresetLabel(catalog, model?.agentPresetId)
  const presetNames = useMemo(
    () => knownPresetNames(catalog, presetLabel),
    [catalog, presetLabel],
  )
  /** The panel (and the preset line inside it) exists only on a switchable team Session. */
  const panelVisible = model !== undefined && model.switchable

  // The host locks a Session's preset once its conversation starts, so the
  // native header label is read-only chrome. While BOT shows the same name in
  // our panel, hide that span by its exact text inside the Session-header slot
  // (never a hashed class); no match means nothing happens.
  useEffect(() => {
    if (!panelVisible || presetLabel === undefined || presetNames.length === 0) return
    return hideNativePresetLabels(presetNames)
  }, [panelVisible, presetLabel, presetNames])

  useEffect(() => {
    if (!open) return
    // The host Menu mounts its list hidden for one measuring pass, so focusing
    // during mount silently fails; wait for the placement frame.
    const frame = requestAnimationFrame(() => { searchRef.current?.focus() })
    return () => { cancelAnimationFrame(frame) }
  }, [open])

  // Switching away from this Session must leave no panel behind.
  useEffect(() => {
    setOpen(false)
    setQuery('')
  }, [sessionId])

  useEffect(() => () => {
    if (hoverClose.current !== undefined) clearTimeout(hoverClose.current)
  }, [])

  if (team === undefined || sessionId === undefined || openSession === undefined || model === undefined) return null
  if (!model.switchable) return null

  const close = (): void => {
    skipFocusOpen.current = true
    setOpen(false)
    setQuery('')
  }

  const cancelHoverClose = (): void => {
    if (hoverClose.current === undefined) return
    clearTimeout(hoverClose.current)
    hoverClose.current = undefined
  }

  const scheduleHoverClose = (): void => {
    cancelHoverClose()
    hoverClose.current = setTimeout(() => { close() }, 160)
  }

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      setQuery('')
      return
    }
    setOpen(true)
  }

  const goTo = (target: string): void => {
    close()
    if (target === sessionId) return
    keepChatView(target)
    openSession(target)
  }

  const renameThread = async (threadId: string, title: string): Promise<void> => {
    const next = title.trim()
    setRenaming(undefined)
    if (next === '' ) return
    try {
      await callAgentTeam('team.thread.rename', { id: team.id, threadId, title: next })
    } catch {
      // A refused rename keeps the stored title; the row reappears unchanged.
    }
  }

  const archiveThread = async (threadId: string): Promise<void> => {
    setThreadMenu(undefined)
    try {
      await callAgentTeam('team.thread.archive', { id: team.id, threadId })
    } catch {
      // A refused archive leaves the thread in place.
    }
  }

  const assignThread = async (threadId: string, slotId: string): Promise<void> => {
    setThreadMenu(undefined)
    try {
      await callAgentTeam('team.thread.assign', { id: team.id, threadId, slotId })
    } catch {
      // A refused owner (THREAD_OWNER_UNKNOWN) leaves the stored owner in place.
    }
  }

  /** Pause/resume only move the marker; the row keeps opening its history. */
  const stopThread = async (threadId: string): Promise<void> => {
    setThreadMenu(undefined)
    try {
      await callAgentTeam('team.thread.stop', { id: team.id, threadId })
    } catch {
      // A refused stop leaves the thread running.
    }
  }

  const resumeThread = async (threadId: string): Promise<void> => {
    setThreadMenu(undefined)
    try {
      await callAgentTeam('team.thread.resume', { id: team.id, threadId })
    } catch {
      // A refused resume leaves the pause marker in place.
    }
  }

  const restoreThread = async (threadId: string): Promise<void> => {
    setThreadMenu(undefined)
    try {
      await callAgentTeam('team.thread.restore', { id: team.id, threadId })
    } catch {
      // A refused restore leaves the thread retired.
    }
  }

  /**
   * Menu rows for one thread: availability comes from `threadMenuModel`, so the
   * tested data model owns the six controls and only icons/labels live here.
   */
  const threadMenuEntries = (thread: SwitcherThreadRow): MenuEntry[] =>
    threadMenuModel(team, thread).items.map(item => ({
      id: item.id,
      label: item.label,
      disabled: item.disabled,
      icon: threadControlIcon(item.id),
      ...(item.submenu === undefined
        ? {}
        : {
          submenu: item.submenu.map(owner => ({
            id: `owner:${owner.slotId}`,
            icon: <MemberAvatar name={owner.name} avatar={owner.avatar} size={16} />,
            label: (
              <span className={css.teamSessionOwnerOption}>
                <span className={css.teamSessionOwnerOptionName}>{owner.name}</span>
                {owner.leader && (
                  <span className={css.teamSessionOwnerCrown} title="队长" aria-label="队长">
                    <LeaderMark size={10} />
                  </span>
                )}
                {owner.current && (
                  <IconCheckOutlineRegular
                    size={12}
                    className={css.teamSessionOwnerOptionCheck}
                    aria-label="当前负责人"
                  />
                )}
              </span>
            ),
          })),
        }),
    }))

  const createThread = async (teamView: TeamView): Promise<void> => {
    close()
    const known = new Set(Object.keys(teamView.threads ?? {}))
    try {
      const next = await callAgentTeam('team.thread.create', { id: teamView.id })
      const created = Object.values(next.threads ?? {})
        .find(thread => !known.has(thread.id))
        ?? Object.values(next.threads ?? {}).sort((left, right) => right.updatedAt - left.updatedAt)[0]
      if (created !== undefined) goTo(created.sessionId)
    } catch {
      // A refused create leaves the reader where they were, panel closed.
    }
  }

  return (
    <span
      className={css.teamSessionHover}
      onMouseEnter={cancelHoverClose}
      onMouseLeave={scheduleHoverClose}
    >
      <span className={css.teamSessionTabs} data-dsh-team-session-tabs>
        {sessionTabRows(team, sessionId).map(tab => (
          <button
            key={tab.sessionId}
            type="button"
            className={`${css.teamSessionTab} ${tab.current ? css.teamSessionTabCurrent : ''}`}
            aria-current={tab.current ? 'page' : undefined}
            title={tab.title}
            data-dsh-team-session-tab={tab.sessionId}
            onClick={() => { goTo(tab.sessionId) }}
          >
            {tab.title}
          </button>
        ))}
        <button
          type="button"
          className={css.teamSessionTabAdd}
          aria-label="新建话题"
          title="新建话题"
          data-dsh-team-session-add
          onClick={() => { void createThread(team) }}
        >
          <IconPlusOutlineRegular size={12} />
        </button>
      </span>
      <Menu
        open={open}
        onClose={close}
        portal
        align="start"
        side="bottom"
        className={css.teamSessionAnchor}
        listClassName={css.teamSessionMenu}
        anchor={(
          <button
            type="button"
            className={css.teamSessionTrigger}
            data-dsh-team-session-switcher
            aria-label={`切换团队会话：${model.currentName}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onMouseEnter={() => { cancelHoverClose(); setOpen(true) }}
            onPointerDown={() => { pointerFocus.current = true }}
            onFocus={() => {
              if (pointerFocus.current) {
                pointerFocus.current = false
                skipFocusOpen.current = false
                return
              }
              if (skipFocusOpen.current) {
                skipFocusOpen.current = false
                return
              }
              setOpen(true)
            }}
            onBlur={() => { skipFocusOpen.current = false; pointerFocus.current = false }}
            onClick={() => { pointerFocus.current = false; toggle() }}
          >
            <IconChevronDownOutlineRegular size={12} className={css.teamSessionTriggerChevron} />
          </button>
        )}
      >
        <div
          className={css.teamSessionBody}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        >
          <div className={css.teamSessionSearch}>
            <IconSearchOutlineRegular size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={event => { setQuery(event.target.value) }}
              placeholder="搜索成员或会话"
              aria-label="搜索成员或会话"
            />
          </div>
          <div className={css.teamSessionList}>
            {model.members.length > 0 && (
              <div className={css.teamSessionGroup} role="group" aria-label="成员">
                <div className={css.teamSessionGroupLabel}>成员</div>
                {model.members.map(member => (
                  <button
                    key={member.sessionId}
                    type="button"
                    role="menuitem"
                    className={css.teamSessionRow}
                    onClick={() => { goTo(member.sessionId) }}
                  >
                    <span className={css.teamSessionAvatar} aria-hidden="true">
                      <MemberAvatar name={member.name} avatar={member.avatar} size={20} />
                    </span>
                    <span className={css.teamSessionRowName}>{member.name}</span>
                    {member.leader && (
                      <span className={css.teamSessionLeader} title="队长" aria-label="队长">
                        <LeaderMark size={11} />
                      </span>
                    )}
                    {member.current && (
                      <IconCheckOutlineRegular size={14} className={css.teamSessionCheck} aria-label="当前会话" />
                    )}
                  </button>
                ))}
              </div>
            )}
            {model.threads.length > 0 && (
              <div className={css.teamSessionGroup} role="group" aria-label="团队会话">
                <div className={css.teamSessionGroupLabel}>团队会话</div>
                {model.threads.map(thread => renaming?.id === thread.id
                  ? (
                    <input
                      key={`${thread.id}-rename`}
                      className={css.teamSessionRename}
                      value={renaming.title}
                      autoFocus
                      aria-label="会话名称"
                      onChange={event => { setRenaming({ id: thread.id, title: event.target.value }) }}
                      onBlur={() => { void renameThread(thread.id, renaming.title) }}
                      onKeyDown={event => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void renameThread(thread.id, renaming.title)
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          setRenaming(undefined)
                        }
                      }}
                    />
                  )
                  : (
                    <div key={thread.id} className={css.teamSessionRowWrap}>
                      <button
                        type="button"
                        role="menuitem"
                        className={css.teamSessionRow}
                        onClick={() => { goTo(thread.sessionId) }}
                      >
                        {thread.pausedAt !== undefined && (
                          <span
                            className={css.teamSessionPausedDot}
                            title="已暂停"
                            aria-label="已暂停"
                          />
                        )}
                        <span className={css.teamSessionRowName}>{thread.title}</span>
                        <span
                          className={css.teamSessionOwner}
                          title={`负责人：${thread.ownerName}`}
                          aria-label={`负责人：${thread.ownerName}`}
                        >
                          <span className={css.teamSessionOwnerName}>{thread.ownerName}</span>
                        </span>
                        <span className={css.teamSessionTime}>{relativeTime(thread.updatedAt)}</span>
                        {thread.current && (
                          <IconCheckOutlineRegular size={14} className={css.teamSessionCheck} aria-label="当前会话" />
                        )}
                      </button>
                      <span className={css.teamSessionRowActions}>
                        <Menu
                          open={threadMenu === thread.id}
                          portal
                          align="end"
                          dense
                          items={threadMenuEntries(thread)}
                          onSelect={id => {
                            if (id === 'rename') {
                              setThreadMenu(undefined)
                              setRenaming({ id: thread.id, title: thread.title })
                            } else if (id === 'archive') {
                              void archiveThread(thread.id)
                            } else if (id === 'stop') {
                              void stopThread(thread.id)
                            } else if (id === 'resume') {
                              void resumeThread(thread.id)
                            } else if (id === 'restore') {
                              void restoreThread(thread.id)
                            } else if (id.startsWith('owner:')) {
                              void assignThread(thread.id, id.slice('owner:'.length))
                            }
                          }}
                          onClose={() => { setThreadMenu(undefined) }}
                          anchor={(
                            <button
                              type="button"
                              className={css.teamSessionRowAction}
                              aria-label={`${thread.title} 的更多操作`}
                              aria-haspopup="menu"
                              aria-expanded={threadMenu === thread.id}
                              onClick={event => {
                                event.stopPropagation()
                                setThreadMenu(current => (current === thread.id ? undefined : thread.id))
                              }}
                            >
                              <IconEllipsisOutlineRegular size={14} />
                            </button>
                          )}
                        />
                      </span>
                    </div>
                  ))}
              </div>
            )}
            {model.members.length === 0 && model.threads.length === 0 && (
              <div className={css.teamSessionEmpty}>没有匹配的成员或会话</div>
            )}
            <button
              type="button"
              role="menuitem"
              className={css.teamSessionCreate}
              onClick={() => { void createThread(team) }}
            >
              <IconPlusOutlineRegular size={14} />
              <span>新建会话</span>
            </button>
          </div>
          <SessionPresetMeta name={presetLabel} />
        </div>
      </Menu>
    </span>
  )
}

/** Additive AionUi-style guidance under the shipped hero; never replaces hero or composer. */
export function TeamMemberHeroHint({ sessionId }: { sessionId?: string }): JSX.Element | null {
  const team = useTeamForSession(sessionId)
  const member = team === undefined || sessionId === undefined
    ? undefined
    : Object.values(team.members).find(candidate => candidate.sessionId === sessionId)
  if (member === undefined) return null
  const leader = member.role === 'leader'
  const configuredPrompts = member.assistantSnapshot.prompts ?? []
  const suggestions = configuredPrompts.length > 0
    ? configuredPrompts.slice(0, 3)
    : leader
      ? ['组织一场辩论赛，让不同助手各持立场', '帮我在团队里加一个擅长 ___ 的成员', '多位专家会诊同一个问题']
      : []
  const avatar = member.assistantSnapshot.avatar
  return (
    <div className={css.teamMemberHeroHint} role="note">
      <span className={css.teamMemberHeroHeader}>
        <MemberAvatar name={member.displayName} avatar={avatar} size={44} />
        <span className={css.teamMemberHeroTitleGroup}>
          <span className={css.teamMemberHeroName}>{member.displayName}</span>
          <span className={css.teamMemberHeroRole}>{leader ? 'Leader' : '成员'}</span>
        </span>
      </span>
      <span className={css.teamMemberHeroLine}>
        {leader
          ? '你好，我是 Leader，负责理解你的目标并协调团队。描述你想做的事，我来安排。'
          : '你好，我是团队成员，我听 Leader 和你的指挥。'}
      </span>
      {suggestions.length > 0 && (
        <div className={css.teamMemberHeroSuggestions}>
          {suggestions.map(suggestion => (
            <div key={suggestion} className={css.teamMemberHeroSuggestion}>{suggestion}</div>
          ))}
        </div>
      )}
    </div>
  )
}
