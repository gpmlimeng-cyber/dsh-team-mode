import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChecklistOutlineRegular,
  IconClockOutlineRegular,
  IconCloseOutlineRegular,
  IconLoadingOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { isTeamExecuting } from './team-status.js'
import css from './TeamBoard.module.css'
import { setTeamConversationView } from './team-view-presence.js'
import type { TeamMessage, TeamTask } from '../domain/types.js'
import type { TeamView } from '../transport/contracts.js'

/** Registration identity for the `conversation.view` tab. */
export const TEAM_BOARD_VIEW_ID = 'team-board'
/** Tab label rendered by the native conversation header. */
export const TEAM_BOARD_VIEW_LABEL = '看板'
/** Tab order beside the shipped chat (0) and trajectory (10) views. */
export const TEAM_BOARD_VIEW_ORDER = 7

const UNASSIGNED = '__unassigned__'
const FILTER_STORAGE_KEY = 'dsh-team-mode:team-board:filters'
const KNOWN_SESSION_KEY_PREFIX = 'dsh-team-mode:team-board:session:'
/**
 * The shell persists a Session's active conversation view under this key
 * (`dsh.conversation.<sessionId>`, JSON `{ draft, view }`) and reads it when
 * it activates that Session. Selecting another member's Session otherwise
 * restores that Session's previous tab, so the board writes the target's
 * preference before navigating. This depends on the shell's persisted key
 * shape and degrades to the previous tab if that key changes.
 */
const CONVERSATION_STORE_KEY = 'dsh.conversation'

type TaskStatus = TeamTask['status']
type BoardGroupId = 'todo' | 'active' | 'done' | 'error'
type BoardStatusFilter = 'all' | BoardGroupId
type Tone = 'neutral' | 'business' | 'success' | 'warn' | 'danger'

interface BoardGroupDefinition {
  readonly id: BoardGroupId
  readonly label: string
  readonly hint: string
  readonly statuses: readonly TaskStatus[]
}

const BOARD_GROUPS: readonly BoardGroupDefinition[] = [
  { id: 'todo', label: '待处理', hint: '等待认领或开始', statuses: ['pending', 'assigned'] },
  { id: 'active', label: '进行中', hint: '成员正在执行', statuses: ['running'] },
  { id: 'done', label: '已完成', hint: '已交付结果', statuses: ['completed'] },
  { id: 'error', label: '异常', hint: '阻塞、失败或取消', statuses: ['blocked', 'failed', 'cancelled'] },
]

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待处理',
  assigned: '已分配',
  running: '进行中',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const MESSAGE_TYPE_LABELS: Record<TeamMessage['type'], string> = {
  instruction: '指令',
  progress: '进展',
  result: '结果',
  question: '提问',
  warning: '警告',
  system: '系统',
}

interface BoardFilters {
  readonly status: BoardStatusFilter
  readonly member: string
  readonly query: string
}

const DEFAULT_BOARD_FILTERS: BoardFilters = { status: 'all', member: 'all', query: '' }

interface KnownTeam {
  readonly id: string
  readonly name: string
}

interface TeamCache {
  teams: TeamView[]
  loaded: boolean
}

const teamCache: TeamCache = { teams: [], loaded: false }

type FeedItem =
  | { readonly kind: 'message'; readonly id: string; readonly at: number; readonly message: TeamMessage }
  | { readonly kind: 'task'; readonly id: string; readonly at: number; readonly task: TeamTask }

/**
 * Props accepted by the view.
 *
 * A `conversation.view` registration passes the standard Session props, which
 * include `sessionId`. A host may also inject `uiWorkspace` (or a ready
 * `openSession` callback); both shapes are accepted so the registration can
 * stay a one-liner. The parameter type is `never` because the Workspace
 * controller brands Session ids: every real `(id: SessionId) => void` remains
 * assignable, and the call site performs the same narrowing the sidebar does.
 */
export interface TeamBoardViewProps {
  readonly sessionId?: string
  readonly uiWorkspace?: { readonly openSession: (target: never) => void }
  readonly openSession?: (target: never) => void
}

function dataStore(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function readStorageJson(key: string): unknown {
  const store = dataStore()
  if (store === undefined) return undefined
  try {
    const raw = store.getItem(key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

function writeStorageJson(key: string, value: unknown): void {
  const store = dataStore()
  if (store === undefined) return
  try {
    store.setItem(key, JSON.stringify(value))
  } catch {
    // Restricted WebViews can reject storage; the board still works for this render.
  }
}

function removeStorage(key: string): void {
  const store = dataStore()
  if (store === undefined) return
  try {
    store.removeItem(key)
  } catch {
    // Storage is optional.
  }
}

/**
 * Key-first persisted state over `localStorage`.
 *
 * The plugin's browser half is bundled by tsdown and cannot resolve the
 * generated-UI `$dsh/state` helper; this mirrors its contract (key first,
 * lazy read, write on change) without adding a dependency.
 */
function usePersistedState<T>(
  key: string,
  initial: T,
  revive: (raw: unknown) => T,
): readonly [T, (next: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = readStorageJson(key)
    return raw === undefined ? initial : revive(raw)
  })
  useEffect(() => {
    writeStorageJson(key, value)
  }, [key, value])
  const set = useCallback((next: T | ((previous: T) => T)): void => {
    setValue(previous => (typeof next === 'function' ? (next as (current: T) => T)(previous) : next))
  }, [])
  return [value, set] as const
}

function isBoardStatusFilter(value: unknown): value is BoardStatusFilter {
  if (value === 'all') return true
  return BOARD_GROUPS.some(group => group.id === value)
}

function reviveBoardFilters(raw: unknown): BoardFilters {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_BOARD_FILTERS
  const value = raw as { status?: unknown; member?: unknown; query?: unknown }
  return {
    status: isBoardStatusFilter(value.status) ? value.status : 'all',
    member: typeof value.member === 'string' && value.member !== '' ? value.member : 'all',
    query: typeof value.query === 'string' ? value.query : '',
  }
}

function reviveKnownTeam(raw: unknown): KnownTeam | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as { id?: unknown; name?: unknown }
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.name !== 'string' || value.name === '') return undefined
  return { id: value.id, name: value.name }
}

function readKnownTeam(sessionId: string): KnownTeam | undefined {
  return reviveKnownTeam(readStorageJson(`${KNOWN_SESSION_KEY_PREFIX}${sessionId}`))
}

function writeKnownTeam(sessionId: string, team: KnownTeam): void {
  writeStorageJson(`${KNOWN_SESSION_KEY_PREFIX}${sessionId}`, { id: team.id, name: team.name })
}

function clearKnownTeam(sessionId: string): void {
  removeStorage(`${KNOWN_SESSION_KEY_PREFIX}${sessionId}`)
}

function keepTeamBoardTab(sessionId: string): void {
  const key = `${CONVERSATION_STORE_KEY}.${sessionId}`
  const raw = readStorageJson(key)
  const current = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  if (current.view === TEAM_BOARD_VIEW_ID) return
  writeStorageJson(key, { ...current, view: TEAM_BOARD_VIEW_ID })
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { window.clearInterval(timer) }
  }, [])
  return now
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function taskGroup(status: TaskStatus): BoardGroupId {
  switch (status) {
    case 'pending':
    case 'assigned':
      return 'todo'
    case 'running':
      return 'active'
    case 'completed':
      return 'done'
    case 'blocked':
    case 'failed':
    case 'cancelled':
      return 'error'
  }
}

function taskTone(status: TaskStatus): Tone {
  switch (status) {
    case 'running':
      return 'business'
    case 'completed':
      return 'success'
    case 'blocked':
      return 'warn'
    case 'failed':
    case 'cancelled':
      return 'danger'
    default:
      return 'neutral'
  }
}

function messageTone(type: TeamMessage['type']): Tone {
  switch (type) {
    case 'warning':
      return 'warn'
    case 'question':
      return 'business'
    case 'result':
      return 'success'
    default:
      return 'neutral'
  }
}

function teamStateView(team: TeamView): { readonly label: string; readonly tone: Tone } {
  switch (team.state) {
    case 'starting':
      return { label: '启动中', tone: 'business' }
    case 'active':
      return isTeamExecuting(team)
        ? { label: '运行中', tone: 'success' }
        : { label: '空闲', tone: 'neutral' }
    case 'ownership_conflict':
      return { label: '归属冲突', tone: 'warn' }
    case 'deleting':
      return { label: '删除中', tone: 'warn' }
    case 'delete_blocked':
      return { label: '删除受阻', tone: 'danger' }
    case 'error':
      return { label: '异常', tone: 'danger' }
    case 'draft':
      return { label: '草稿', tone: 'neutral' }
  }
}

function initialOf(name: string | undefined): string {
  const trimmed = name?.trim() ?? ''
  if (trimmed === '') return '团'
  return [...trimmed][0] ?? '团'
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}

function relativeTime(value: string | undefined, now: number): string {
  if (value === undefined) return ''
  const at = Date.parse(value)
  if (Number.isNaN(at)) return ''
  const delta = now - at
  if (delta < 45_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  return new Date(at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function absoluteTime(value: string | undefined): string {
  if (value === undefined) return ''
  const at = Date.parse(value)
  if (Number.isNaN(at)) return value
  return new Date(at).toLocaleString('zh-CN')
}

function clockTime(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function matchesQuery(haystack: string, query: string): boolean {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const normalized = haystack.toLocaleLowerCase()
  return tokens.every(token => normalized.includes(token))
}

function memberName(team: TeamView, slotId: string | undefined): string {
  if (slotId === undefined) return '未分配'
  return team.members[slotId]?.displayName ?? '已移除成员'
}

function messageSenderName(team: TeamView, message: TeamMessage): string {
  if (message.sender.kind === 'user') return '你'
  if (message.sender.kind === 'system') return '系统'
  return memberName(team, message.sender.id)
}

function messageRecipientName(team: TeamView, message: TeamMessage): string {
  if (message.recipient.kind === 'broadcast') return '@全体'
  if (message.recipient.kind === 'leader') {
    return memberName(team, message.recipient.slotId ?? team.leaderSlotId)
  }
  return memberName(team, message.recipient.slotId)
}

function taskSessionId(team: TeamView, task: TeamTask): string | undefined {
  if (task.ownerSlotId !== undefined) {
    const owner = team.members[task.ownerSlotId]
    if (owner !== undefined) return owner.sessionId
  }
  return team.members[team.leaderSlotId]?.sessionId
}

function messageSearchText(team: TeamView, message: TeamMessage): string {
  return [
    message.content,
    message.summary ?? '',
    messageSenderName(team, message),
    messageRecipientName(team, message),
    MESSAGE_TYPE_LABELS[message.type],
  ].join(' ')
}

function taskSearchText(team: TeamView, task: TeamTask, taskById: ReadonlyMap<string, TeamTask>): string {
  const dependencies = task.dependencyIds
    .map(id => taskById.get(id)?.title ?? '')
    .join(' ')
  return [
    task.title,
    task.description,
    TASK_STATUS_LABELS[task.status],
    memberName(team, task.ownerSlotId),
    task.id,
    dependencies,
  ].join(' ')
}

function messageMatchesMember(team: TeamView, message: TeamMessage, member: string): boolean {
  if (member === 'all') return true
  if (member === UNASSIGNED) return false
  if (message.sender.id === member) return true
  if (message.recipient.kind === 'broadcast') return false
  const recipient = message.recipient.kind === 'leader'
    ? message.recipient.slotId ?? team.leaderSlotId
    : message.recipient.slotId
  return recipient === member
}

function taskMatchesMember(task: TeamTask, member: string): boolean {
  if (member === 'all') return true
  if (member === UNASSIGNED) return task.ownerSlotId === undefined
  return task.ownerSlotId === member
}

function findTeamForSession(teams: readonly TeamView[], sessionId: string | undefined): TeamView | undefined {
  if (sessionId === undefined) return undefined
  const matches = teams.filter(team => (
    Object.values(team.members).some(member => member.sessionId === sessionId)
  ))
  if (matches.length <= 1) return matches[0]
  return [...matches].sort((left, right) => (
    (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)
  ))[0]
}

function teamCounts(team: TeamView): { members: number; online: number; unassigned: number } {
  const members = Object.values(team.members)
  return {
    members: members.length,
    online: members.filter(member => member.lastRuntimeState !== 'offline').length,
    unassigned: Object.values(team.tasks).filter(task => task.ownerSlotId === undefined).length,
  }
}

/**
 * 看板 conversation view: the active team's tasks grouped by status, with the
 * team activity feed beside (desktop) or below (narrow) the board.
 *
 * Renders nothing unless the active Session belongs to a team member. The
 * native header, tabs, transcript, and composer remain owned by the shell.
 */
export function TeamBoardView(props: TeamBoardViewProps): JSX.Element | null {
  const sessionId = props.sessionId
  useEffect(() => {
    setTeamConversationView(sessionId, 'board')
    return () => { setTeamConversationView(sessionId, undefined) }
  }, [sessionId])
  const [teams, setTeams] = useState<TeamView[]>(teamCache.teams)
  const [teamsLoaded, setTeamsLoaded] = useState(teamCache.loaded)
  const [teamsError, setTeamsError] = useState<string>()
  const [liveError, setLiveError] = useState<string>()
  const [syncing, setSyncing] = useState(false)
  const [syncAt, setSyncAt] = useState<number>()
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [knownTeam, setKnownTeam] = useState<KnownTeam | undefined>(() => (
    sessionId === undefined ? undefined : readKnownTeam(sessionId)
  ))
  const [messages, setMessages] = useState<TeamMessage[]>([])
  const [messagesTeamId, setMessagesTeamId] = useState<string>()
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState<string>()
  const [actionNotice, setActionNotice] = useState<string>()
  const [filters, setFilters] = usePersistedState<BoardFilters>(
    FILTER_STORAGE_KEY,
    DEFAULT_BOARD_FILTERS,
    reviveBoardFilters,
  )
  const now = useNow()
  const messagesGeneration = useRef(0)

  const team = useMemo(() => findTeamForSession(teams, sessionId), [sessionId, teams])

  useEffect(() => {
    setMessages([])
    setMessagesTeamId(undefined)
    setMessagesError(undefined)
    setActionNotice(undefined)
    setKnownTeam(sessionId === undefined ? undefined : readKnownTeam(sessionId))
  }, [sessionId])

  useEffect(() => {
    if (sessionId === undefined) return
    if (team !== undefined) {
      const known = { id: team.id, name: team.name }
      setKnownTeam(known)
      writeKnownTeam(sessionId, known)
      return
    }
    if (!teamsLoaded) return
    setKnownTeam(undefined)
    clearKnownTeam(sessionId)
  }, [sessionId, team?.id, team?.name, teamsLoaded])

  useEffect(() => {
    if (sessionId === undefined) return
    let active = true
    setSyncing(true)
    void (async () => {
      try {
        const value = await callAgentTeam('team.list')
        if (!active) return
        teamCache.teams = value.items
        teamCache.loaded = true
        setTeams(value.items)
        setTeamsLoaded(true)
        setTeamsError(undefined)
        setSyncAt(Date.now())
      } catch (cause) {
        if (!active) return
        setTeamsError(errorMessage(cause))
      } finally {
        if (active) setSyncing(false)
      }
    })()
    return () => { active = false }
  }, [refreshVersion, sessionId])

  useEffect(() => {
    if (sessionId === undefined) return
    let timer: number | undefined
    const dispose = subscribeAgentTeam(() => {
      setLiveError(undefined)
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => { setRefreshVersion(value => value + 1) }, 220)
    }, () => {
      setLiveError('团队事件连接已中断，正在等待重连')
    }, () => { setLiveError(undefined); setRefreshVersion(value => value + 1) })
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      dispose()
    }
  }, [sessionId])

  useEffect(() => {
    if (team === undefined) {
      setMessages([])
      setMessagesTeamId(undefined)
      setMessagesLoading(false)
      setMessagesError(undefined)
      return
    }
    const teamId = team.id
    const generation = messagesGeneration.current + 1
    messagesGeneration.current = generation
    let active = true
    setMessagesTeamId(teamId)
    setMessagesLoading(true)
    setMessagesError(undefined)
    void (async () => {
      try {
        const value = await callAgentTeam('team.message.list', { id: teamId })
        if (!active || generation !== messagesGeneration.current) return
        setMessages(value.items)
      } catch (cause) {
        if (!active || generation !== messagesGeneration.current) return
        setMessagesError(errorMessage(cause))
      } finally {
        if (active && generation === messagesGeneration.current) setMessagesLoading(false)
      }
    })()
    return () => { active = false }
  }, [refreshVersion, team?.id])

  useEffect(() => {
    if (actionNotice === undefined) return
    const timer = window.setTimeout(() => { setActionNotice(undefined) }, 4_000)
    return () => { window.clearTimeout(timer) }
  }, [actionNotice])

  const retry = useCallback((): void => {
    setRefreshVersion(value => value + 1)
  }, [])

  const openTaskSession = useCallback((task: TeamTask): void => {
    if (team === undefined) return
    setActionNotice(undefined)
    const target = taskSessionId(team, task)
    if (target === undefined) {
      setActionNotice('无法定位该任务所有者的会话')
      return
    }
    const workspace = props.uiWorkspace
    if (workspace === undefined && props.openSession === undefined) {
      setActionNotice('无法打开会话：uiWorkspace 未注入')
      return
    }
    if (target !== sessionId) keepTeamBoardTab(target)
    try {
      // Call through the service object: `openSession` uses `this`.
      if (workspace !== undefined) workspace.openSession(target as never)
      else props.openSession?.(target as never)
    } catch (cause) {
      setActionNotice(`打开会话失败：${errorMessage(cause)}`)
    }
  }, [props.openSession, props.uiWorkspace, sessionId, team])

  const memberEntries = useMemo(() => (
    team === undefined
      ? []
      : Object.values(team.members).sort((left, right) => {
        if (left.role !== right.role) return left.role === 'leader' ? -1 : 1
        return left.displayName.localeCompare(right.displayName, 'zh-CN')
      })
  ), [team])

  const tasks = useMemo(() => (
    team === undefined
      ? []
      : Object.values(team.tasks).sort((left, right) => (
        (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)
      ))
  ), [team])

  const taskById = useMemo<ReadonlyMap<string, TeamTask>>(() => (
    new Map(tasks.map(task => [task.id, task]))
  ), [tasks])

  const stats = useMemo(() => {
    const result = { total: tasks.length, active: 0, done: 0, error: 0 }
    for (const task of tasks) {
      const group = taskGroup(task.status)
      if (group === 'active') result.active += 1
      else if (group === 'done') result.done += 1
      else if (group === 'error') result.error += 1
    }
    return result
  }, [tasks])

  const activeMember = useMemo(() => {
    if (team === undefined) return 'all'
    if (filters.member === 'all') return 'all'
    if (filters.member === UNASSIGNED) {
      const hasUnassigned = Object.values(team.tasks).some(task => task.ownerSlotId === undefined)
      return hasUnassigned ? UNASSIGNED : 'all'
    }
    return team.members[filters.member] === undefined ? 'all' : filters.member
  }, [filters.member, team])

  const baseTasks = useMemo(() => {
    if (team === undefined) return []
    return tasks.filter(task => (
      taskMatchesMember(task, activeMember)
      && matchesQuery(taskSearchText(team, task, taskById), filters.query)
    ))
  }, [activeMember, filters.query, taskById, tasks, team])

  const statusCounts = useMemo(() => {
    const counts: Record<BoardGroupId, number> = { todo: 0, active: 0, done: 0, error: 0 }
    for (const task of baseTasks) counts[taskGroup(task.status)] += 1
    return counts
  }, [baseTasks])

  const visibleTasks = useMemo(() => (
    filters.status === 'all'
      ? baseTasks
      : baseTasks.filter(task => taskGroup(task.status) === filters.status)
  ), [baseTasks, filters.status])

  const groupsToRender = useMemo(() => {
    const groups = BOARD_GROUPS.map(group => ({
      definition: group,
      tasks: visibleTasks.filter(task => group.statuses.includes(task.status)),
    }))
    return filters.status === 'all'
      ? groups
      : groups.filter(group => group.definition.id === filters.status)
  }, [filters.status, visibleTasks])

  const scopedMessages = useMemo(() => (
    team !== undefined && messagesTeamId === team.id ? messages : []
  ), [messages, messagesTeamId, team])

  const feedResult = useMemo(() => {
    if (team === undefined) return { items: [] as FeedItem[], truncated: false }
    const messageItems: FeedItem[] = scopedMessages
      .filter(message => (
        messageMatchesMember(team, message, activeMember)
        && matchesQuery(messageSearchText(team, message), filters.query)
      ))
      .map(message => ({
        kind: 'message' as const,
        id: `m:${message.id}`,
        at: Date.parse(message.createdAt) || 0,
        message,
      }))
      .sort((left, right) => right.at - left.at)
    const taskItems: FeedItem[] = baseTasks
      .map(task => ({
        kind: 'task' as const,
        id: `t:${task.id}`,
        at: Date.parse(task.updatedAt) || 0,
        task,
      }))
      .sort((left, right) => right.at - left.at)
    const items = [
      ...messageItems.slice(0, 18),
      ...taskItems.slice(0, 8),
    ].sort((left, right) => right.at - left.at).slice(0, 26)
    return {
      items,
      truncated: messageItems.length > 18
        || taskItems.length > 8
        || messageItems.length + taskItems.length > 26,
    }
  }, [activeMember, baseTasks, filters.query, scopedMessages, team])

  const clearFilters = useCallback((): void => {
    setFilters({ status: 'all', member: 'all', query: '' })
  }, [setFilters])

  if (sessionId === undefined) return null

  if (team === undefined) {
    const loading = !teamsLoaded || syncing
    if (teamsLoaded && teamsError === undefined && !syncing) return null
    return (
      <TeamBoardPlaceholder
        known={knownTeam}
        loading={loading}
        error={teamsError}
        onRetry={retry}
      />
    )
  }

  const counts = teamCounts(team)
  const state = teamStateView(team)
  const filtersActive = filters.status !== 'all'
    || activeMember !== 'all'
    || filters.query.trim() !== ''
  const lastUpdated = tasks[0]?.updatedAt
  const feedLoading = messagesLoading && scopedMessages.length === 0 && feedResult.items.length === 0

  return (
    <section className={css.board} aria-label={`${team.name} 团队看板`}>
      <header className={css.boardHeader}>
        <div className={css.teamIdentity}>
          <span className={css.teamAvatar} aria-hidden="true">{initialOf(team.name)}</span>
          <div className={css.identityText}>
            <div className={css.teamNameRow}>
              <h2 className={css.teamName} title={team.name}>{team.name}</h2>
              <span className={css.teamState} data-tone={state.tone}>
                <span className={css.teamStateDot} aria-hidden="true" />
                {state.label}
              </span>
            </div>
            <p className={css.teamMeta}>
              <span>{counts.members} 名成员</span>
              <span className={css.metaDivider} aria-hidden="true">·</span>
              <span>{counts.online} 在线</span>
              <span className={css.metaDivider} aria-hidden="true">·</span>
              <span className={css.workspacePath} title={team.workspacePath}>{team.workspacePath}</span>
            </p>
          </div>
        </div>
        <div className={css.headerSide}>
          <div className={css.stats} aria-label="任务统计">
            <span className={css.stat}><span className={css.statValue}>{stats.total}</span><span className={css.statLabel}>任务</span></span>
            <span className={css.stat}><span className={css.statValue}>{stats.active}</span><span className={css.statLabel}>进行中</span></span>
            <span className={css.stat}><span className={css.statValue}>{stats.done}</span><span className={css.statLabel}>已完成</span></span>
            <span className={css.stat}><span className={css.statValue}>{stats.error}</span><span className={css.statLabel}>异常</span></span>
          </div>
          <span className={css.syncStatus}>
            {syncing
              ? <><IconLoadingOutlineRegular size={13} className={css.spinner} />同步中</>
              : <><IconClockOutlineRegular size={13} />{syncAt === undefined ? '待同步' : `同步于 ${clockTime(syncAt)}`}</>}
          </span>
        </div>
      </header>

      {liveError !== undefined && (
        <div className={css.notice} data-tone="warn" role="status">
          <IconWarningTriangleOutlineRegular size={14} />
          <div className={css.noticeBody}>
            <strong>实时更新已暂停</strong>
            <span>{liveError}</span>
          </div>
          <button type="button" className={css.noticeButton} onClick={retry}>重试</button>
        </div>
      )}
      {teamsError !== undefined && (
        <div className={css.notice} data-tone="danger" role="alert">
          <IconWarningTriangleOutlineRegular size={14} />
          <div className={css.noticeBody}>
            <strong>团队数据刷新失败</strong>
            <span>{teamsError}</span>
          </div>
          <button type="button" className={css.noticeButton} onClick={retry}>重试</button>
        </div>
      )}
      {actionNotice !== undefined && (
        <div className={css.notice} data-tone="warn" role="status">
          <IconWarningTriangleOutlineRegular size={14} />
          <div className={css.noticeBody}><span>{actionNotice}</span></div>
        </div>
      )}

      <div className={css.toolbar}>
        <div className={css.searchField}>
          <IconSearchOutlineRegular size={14} className={css.searchIcon} />
          <input
            type="search"
            className={css.searchInput}
            value={filters.query}
            placeholder="搜索任务或动态"
            aria-label="搜索任务或动态"
            onChange={event => { setFilters(current => ({ ...current, query: event.target.value })) }}
          />
          {filters.query !== '' && (
            <button
              type="button"
              className={css.searchClear}
              aria-label="清除搜索"
              onClick={() => { setFilters(current => ({ ...current, query: '' })) }}
            >
              <IconCloseOutlineRegular size={12} />
            </button>
          )}
        </div>
        <div className={css.statusFilterGroup} role="group" aria-label="按状态筛选">
          <button
            type="button"
            className={css.filterChip}
            aria-pressed={filters.status === 'all'}
            onClick={() => { setFilters(current => ({ ...current, status: 'all' })) }}
          >
            全部<span className={css.filterCount}>{baseTasks.length}</span>
          </button>
          {BOARD_GROUPS.map(group => (
            <button
              key={group.id}
              type="button"
              className={css.filterChip}
              aria-pressed={filters.status === group.id}
              title={group.hint}
              onClick={() => {
                setFilters(current => ({
                  ...current,
                  status: current.status === group.id ? 'all' : group.id,
                }))
              }}
            >
              {group.label}<span className={css.filterCount}>{statusCounts[group.id]}</span>
            </button>
          ))}
        </div>
        <label className={css.memberFilter}>
          <span className={css.memberFilterLabel}>成员</span>
          <select
            className={css.memberSelect}
            value={activeMember}
            onChange={event => { setFilters(current => ({ ...current, member: event.target.value })) }}
          >
            <option value="all">全部成员</option>
            {memberEntries.map(member => (
              <option key={member.id} value={member.id}>
                {member.displayName}{member.role === 'leader' ? '（Leader）' : ''}
              </option>
            ))}
            {counts.unassigned > 0 && <option value={UNASSIGNED}>未分配</option>}
          </select>
        </label>
        <button
          type="button"
          className={css.refreshButton}
          onClick={retry}
          disabled={syncing}
          aria-label="刷新团队看板"
        >
          <IconRefreshOutlineRegular size={13} className={syncing ? css.spinner : undefined} />
          <span className={css.refreshLabel}>刷新</span>
        </button>
      </div>

      <div className={css.boardScroll}>
      <div className={css.layout}>
        <div className={css.tasksPanel}>
          <div className={css.panelHeading}>
            <h3 className={css.panelTitle}>任务</h3>
            <span className={css.panelCount}>
              {visibleTasks.length} 项{filtersActive ? ` / 共 ${tasks.length} 项` : ''}
            </span>
          </div>

          {tasks.length === 0
            ? (
              <div className={css.panelEmpty}>
                <span className={css.panelEmptyIcon} aria-hidden="true">
                  <IconChecklistOutlineRegular size={22} />
                </span>
                <strong className={css.panelEmptyTitle}>任务板还是空的</strong>
                <p className={css.panelEmptyHint}>向 Leader 描述目标，团队会拆解任务并分派给成员。</p>
              </div>
            )
            : baseTasks.length === 0
              ? (
                <div className={css.panelEmpty}>
                  <span className={css.panelEmptyIcon} aria-hidden="true">
                    <IconSearchOutlineRegular size={22} />
                  </span>
                  <strong className={css.panelEmptyTitle}>没有匹配的任务</strong>
                  <p className={css.panelEmptyHint}>换一个关键词，或清除当前筛选。</p>
                  <button type="button" className={css.panelEmptyButton} onClick={clearFilters}>
                    清除筛选
                  </button>
                </div>
              )
              : visibleTasks.length === 0
                ? (
                  <div className={css.panelEmpty}>
                    <span className={css.panelEmptyIcon} aria-hidden="true">
                      <IconSearchOutlineRegular size={22} />
                    </span>
                    <strong className={css.panelEmptyTitle}>该状态下没有任务</strong>
                    <p className={css.panelEmptyHint}>切换到“全部”查看其他状态的任务。</p>
                    <button type="button" className={css.panelEmptyButton} onClick={clearFilters}>
                      清除筛选
                    </button>
                  </div>
                )
                : (
                  <div className={css.groupsShell}>
                  <div className={css.groups} data-single={groupsToRender.length === 1 ? 'true' : undefined}>
                    {groupsToRender.map(group => (
                      <section
                        key={group.definition.id}
                        className={css.group}
                        aria-label={`${group.definition.label}任务，${group.tasks.length} 项`}
                      >
                        <header className={css.groupHeader}>
                          <span className={css.groupDot} data-group={group.definition.id} aria-hidden="true" />
                          <h4 className={css.groupTitle} title={group.definition.hint}>{group.definition.label}</h4>
                          <span className={css.groupCount}>{group.tasks.length}</span>
                        </header>
                        <ul className={css.groupBody}>
                          {group.tasks.length === 0 && (
                            <li className={css.groupEmpty}>暂无{group.definition.label}任务</li>
                          )}
                          {group.tasks.map(task => (
                            <TaskCard
                              key={task.id}
                              team={team}
                              task={task}
                              taskById={taskById}
                              now={now}
                              onOpen={openTaskSession}
                            />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                  </div>
                )}
          {lastUpdated !== undefined && (
            <p className={css.tasksFootnote}>
              最近更新 {relativeTime(lastUpdated, now)}
              <span className={css.metaDivider} aria-hidden="true">·</span>
              {absoluteTime(lastUpdated)}
            </p>
          )}
        </div>

        <aside className={css.activityPanel} aria-label="团队动态">
          <header className={css.activityHeader}>
            <h3 className={css.panelTitle}>动态</h3>
            <span className={css.activityCount}>
              {feedResult.items.length}{feedResult.truncated ? '+' : ''}
            </span>
            {messagesLoading && scopedMessages.length > 0 && (
              <IconLoadingOutlineRegular size={12} className={css.spinner} />
            )}
          </header>

          {messagesError !== undefined && (
            <div className={css.activityNotice} role="alert">
              <IconWarningTriangleOutlineRegular size={14} />
              <div>
                <strong>消息加载失败</strong>
                <span>{messagesError}</span>
              </div>
              <button type="button" className={css.noticeButton} onClick={retry}>重试</button>
            </div>
          )}

          {feedResult.items.length > 0
            ? (
              <ul className={css.activityList}>
                {feedResult.items.map(item => (
                  <ActivityRow
                    key={item.id}
                    item={item}
                    team={team}
                    now={now}
                    onOpenTask={openTaskSession}
                  />
                ))}
              </ul>
            )
            : feedLoading
              ? (
                <ul className={css.activityList} aria-busy="true">
                  {[0, 1, 2].map(index => (
                    <li key={index} className={css.activitySkeleton} aria-hidden="true">
                      <span className={css.skeletonAvatar} />
                      <span className={css.skeletonBody}>
                        <span className={`${css.skeletonLine} ${css.skeletonLineShort}`} />
                        <span className={css.skeletonLine} />
                        <span className={`${css.skeletonLine} ${css.skeletonLineMedium}`} />
                      </span>
                    </li>
                  ))}
                </ul>
              )
              : messagesError === undefined
                ? (
                  <div className={css.activityEmpty}>
                    <strong>{filtersActive ? '没有匹配的动态' : '暂无动态'}</strong>
                    <span>
                      {filtersActive
                        ? '调整成员、状态或搜索词后再看。'
                        : '成员之间的消息和任务更新会出现在这里。'}
                    </span>
                  </div>
                )
                : null}

          {feedResult.truncated && (
            <footer className={css.activityFooter}>仅显示最近 {feedResult.items.length} 条动态</footer>
          )}
        </aside>
      </div>
      </div>
    </section>
  )
}

function TeamBoardPlaceholder({ known, loading, error, onRetry }: {
  readonly known: KnownTeam | undefined
  readonly loading: boolean
  readonly error: string | undefined
  readonly onRetry: () => void
}): JSX.Element {
  const name = known?.name ?? '团队看板'
  return (
    <section className={css.board} aria-label={`${name} 团队看板`} aria-busy={loading}>
      <header className={css.boardHeader}>
        <div className={css.teamIdentity}>
          <span className={css.teamAvatar} aria-hidden="true">{initialOf(name)}</span>
          <div className={css.identityText}>
            <div className={css.teamNameRow}>
              <h2 className={css.teamName} title={name}>{name}</h2>
            </div>
            <p className={css.teamMeta}>
              {loading ? '正在加载团队任务…' : '团队数据当前不可用'}
            </p>
          </div>
        </div>
        <div className={css.headerSide}>
          <span className={css.syncStatus}>
            <IconLoadingOutlineRegular size={13} className={css.spinner} />
            {loading ? '加载中' : '等待重试'}
          </span>
        </div>
      </header>

      {error !== undefined && (
        <div className={css.notice} data-tone="danger" role="alert">
          <IconWarningTriangleOutlineRegular size={14} />
          <div className={css.noticeBody}>
            <strong>无法加载团队数据</strong>
            <span>{error}</span>
          </div>
          <button type="button" className={css.noticeButton} onClick={onRetry}>重试</button>
        </div>
      )}

      <div className={css.toolbar} aria-hidden="true">
        <span className={css.skeletonSearch} />
        <span className={css.skeletonChip} />
        <span className={css.skeletonChip} />
        <span className={css.skeletonChip} />
      </div>

      <div className={css.boardScroll}>
      <div className={css.layout}>
        <div className={css.tasksPanel}>
          <div className={css.groupsShell}>
            <div className={css.groups}>
              {BOARD_GROUPS.map(group => (
                <section key={group.id} className={css.group} aria-hidden="true">
                  <header className={css.groupHeader}>
                    <span className={css.groupDot} data-group={group.id} />
                    <h4 className={css.groupTitle}>{group.label}</h4>
                  </header>
                  <div className={css.groupBody}>
                    <span className={css.skeletonCard} />
                    <span className={css.skeletonCard} />
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
        <aside className={css.activityPanel} aria-hidden="true">
          <header className={css.activityHeader}>
            <h3 className={css.panelTitle}>动态</h3>
          </header>
          <div className={css.activityList}>
            {[0, 1, 2].map(index => (
              <div key={index} className={css.activitySkeleton}>
                <span className={css.skeletonAvatar} />
                <span className={css.skeletonBody}>
                  <span className={`${css.skeletonLine} ${css.skeletonLineShort}`} />
                  <span className={css.skeletonLine} />
                </span>
              </div>
            ))}
          </div>
        </aside>
      </div>
      </div>
    </section>
  )
}

function TaskCard({ team, task, taskById, now, onOpen }: {
  readonly team: TeamView
  readonly task: TeamTask
  readonly taskById: ReadonlyMap<string, TeamTask>
  readonly now: number
  readonly onOpen: (task: TeamTask) => void
}): JSX.Element {
  const owner = task.ownerSlotId === undefined ? undefined : team.members[task.ownerSlotId]
  const dependencies = task.dependencyIds.map(id => ({
    id,
    title: taskById.get(id)?.title,
  }))
  const target = taskSessionId(team, task)
  const actionTarget = owner?.displayName ?? (task.ownerSlotId === undefined ? 'Leader' : '成员')
  const updated = task.updatedAt
  const label = [
    `打开任务「${task.title}」`,
    `状态：${TASK_STATUS_LABELS[task.status]}`,
    `所有者：${owner?.displayName ?? '未分配'}`,
    target === undefined ? '无法定位成员会话' : `将打开 ${actionTarget} 的会话`,
  ].join('，')

  return (
    <li className={css.taskItem}>
      <button
        type="button"
        className={css.taskCard}
        onClick={() => { onOpen(task) }}
        aria-label={label}
      >
        <span className={css.taskCardTop}>
          <span className={css.taskTitle}>{task.title}</span>
          <span className={css.taskStatus} data-tone={taskTone(task.status)}>
            {TASK_STATUS_LABELS[task.status]}
          </span>
        </span>
        {task.description !== '' && (
          <span className={css.taskDescription}>{task.description}</span>
        )}
        {task.error !== undefined && task.error !== '' && (
          <span className={css.taskError}>
            <IconWarningTriangleOutlineRegular size={12} />
            {task.error}
          </span>
        )}
        {task.status === 'completed' && task.result !== undefined && task.result !== '' && (
          <span className={css.taskResult}>{task.result}</span>
        )}
        <span className={css.taskMeta}>
          <span className={css.ownerChip}>
            <span className={css.ownerDot} data-leader={owner?.role === 'leader' ? 'true' : undefined} aria-hidden="true" />
            <span className={css.ownerName}>{owner?.displayName ?? '未分配'}</span>
            {owner?.role === 'leader' && <span className={css.leaderMark}>Leader</span>}
          </span>
          {dependencies.length > 0 && (
            <span className={css.dependencyChips}>
              {dependencies.slice(0, 2).map(dependency => (
                <span
                  key={dependency.id}
                  className={css.dependencyChip}
                  title={`依赖：${dependency.title ?? dependency.id}`}
                >
                  依赖 · {dependency.title === undefined ? shortId(dependency.id) : dependency.title}
                </span>
              ))}
              {dependencies.length > 2 && (
                <span className={css.dependencyMore}>+{dependencies.length - 2}</span>
              )}
            </span>
          )}
        </span>
        <span className={css.taskFoot}>
          <span className={css.taskTime} title={absoluteTime(updated)}>
            <IconClockOutlineRegular size={12} />
            {relativeTime(updated, now)}
          </span>
          <span className={css.taskOpenHint} aria-hidden="true">打开会话 →</span>
        </span>
      </button>
    </li>
  )
}

function ActivityRow({ item, team, now, onOpenTask }: {
  readonly item: FeedItem
  readonly team: TeamView
  readonly now: number
  readonly onOpenTask: (task: TeamTask) => void
}): JSX.Element {
  if (item.kind === 'task') {
    const owner = item.task.ownerSlotId === undefined ? undefined : team.members[item.task.ownerSlotId]
    const created = item.task.createdAt === item.task.updatedAt
    return (
      <li>
        <button
          type="button"
          className={`${css.activityItem} ${css.activityButton}`}
          onClick={() => { onOpenTask(item.task) }}
          aria-label={`打开任务「${item.task.title}」的成员会话`}
        >
          <span className={css.activityAvatar} data-kind="task" aria-hidden="true">
            {initialOf(owner?.displayName)}
          </span>
          <span className={css.activityBody}>
            <span className={css.activityTop}>
              <span className={css.activityActor}>{owner?.displayName ?? '未分配'}</span>
              <span className={css.activityVerb}>{created ? '创建了任务' : '更新了任务'}</span>
              <span className={css.activityTime} title={absoluteTime(item.task.updatedAt)}>
                {relativeTime(item.task.updatedAt, now)}
              </span>
            </span>
            <span className={css.activityTaskTitle}>{item.task.title}</span>
            <span className={css.activityMeta}>
              <span className={css.typeBadge} data-tone={taskTone(item.task.status)}>
                {TASK_STATUS_LABELS[item.task.status]}
              </span>
              {item.task.dependencyIds.length > 0 && (
                <span className={css.relatedBadge}>依赖 {item.task.dependencyIds.length}</span>
              )}
            </span>
          </span>
        </button>
      </li>
    )
  }

  const sender = messageSenderName(team, item.message)
  const recipient = messageRecipientName(team, item.message)
  const content = item.message.summary !== undefined && item.message.summary.trim() !== ''
    ? item.message.summary
    : item.message.content
  return (
    <li>
      <article className={css.activityItem} aria-label={`${sender} 发给 ${recipient} 的消息`}>
        <span className={css.activityAvatar} data-kind={item.message.sender.kind} aria-hidden="true">
          {initialOf(sender)}
        </span>
        <div className={css.activityBody}>
          <div className={css.activityTop}>
            <span className={css.activityActor}>{sender}</span>
            <span className={css.activityArrow} aria-hidden="true">→</span>
            <span className={css.activityTarget}>{recipient}</span>
            <span className={css.activityTime} title={absoluteTime(item.message.createdAt)}>
              {relativeTime(item.message.createdAt, now)}
            </span>
          </div>
          <p className={css.activityText}>{content}</p>
          <div className={css.activityMeta}>
            <span className={css.typeBadge} data-tone={messageTone(item.message.type)}>
              {MESSAGE_TYPE_LABELS[item.message.type]}
            </span>
            {item.message.relatedTaskId !== undefined && (
              <span className={css.relatedBadge}>关联任务</span>
            )}
            {item.message.attachments.length > 0 && (
              <span className={css.relatedBadge}>{item.message.attachments.length} 个附件</span>
            )}
            {item.message.deliveryState === 'failed' && (
              <span className={css.relatedBadge} data-tone="danger">投递失败</span>
            )}
          </div>
        </div>
      </article>
    </li>
  )
}
