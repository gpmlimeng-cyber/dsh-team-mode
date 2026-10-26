import type { TeamTask } from '../domain/types.js'
import type { TeamView } from '../transport/contracts.js'
import { isAssistantAvatarDataUrl } from './assistant-instances.js'
import {
  memberStatusLabel,
  taskCarriesVerdict,
  taskKindLabel,
  taskScheduleSummary,
  taskStatusLabel,
  taskVerdictLabel,
} from './labels.js'
import { taskWaitsOnDependency, teamPanelView, unresolvedDependency } from './team-main-agent-data.js'

/**
 * The dependency rule lives next to the member projection it feeds and is
 * re-exported here so the sidebar and the overview keep one import site.
 */
export { OPEN_TASK_STATUSES, taskWaitsOnDependency, unresolvedDependency } from './team-main-agent-data.js'

export interface TeamSidebarSummary {
  members: number
  running: number
  waiting: number
  /** Errored members; the row says 异常 instead of 空闲. Absent when zero. */
  error?: number
  /** Members still waking up; the row says 启动中 instead of 空闲. Absent when zero. */
  starting?: number
  /** Open tasks that still wait on an unfinished prerequisite. */
  waitingDependency: number
  /** Lifecycle state; absent when the caller only supplies member counts. */
  state?: TeamView['state']
  /** A task is running; member slots alone would read this team as idle. */
  taskRunning?: boolean
}

/** The prerequisite a blocked task is waiting for, as the sidebar shows it. */
export interface TeamSidebarBlockedBy {
  id: string
  title: string
  ownerName?: string
}

export interface TeamSidebarTask {
  id: string
  title: string
  status: string
  statusLabel: string
  updatedAt: string
  blockedBy?: TeamSidebarBlockedBy
  /**
   * One line of stored facts the board's detail panel also shows — owner, kind,
   * review verdict and due/reminder times. Absent when the task carries none,
   * so a legacy row renders exactly as before and nothing is invented.
   */
  detail?: string
}

export interface TeamScopeCounts {
  active: number
  archived: number
}

type SummarySource = Pick<TeamView, 'members'> & Partial<Pick<TeamView, 'tasks' | 'state'>>
type TaskSource = Pick<TeamView, 'tasks'> & Partial<Pick<TeamView, 'members'>>

/**
 * Mirrors `teamStateView` in team-board.tsx so a sidebar row never disagrees
 * with the team page. `active` is deliberately absent: an active team reads
 * from its member/task activity, not from its lifecycle state.
 */
const TEAM_STATE_LABELS: Readonly<Record<string, string>> = {
  draft: '草稿',
  starting: '启动中',
  ownership_conflict: '归属冲突',
  deleting: '删除中',
  delete_blocked: '删除受阻',
  error: '异常',
}

const RECENT_TASK_LIMIT = 3
const UNTITLED_TASK = '未命名任务'

function taskTitle(title: string): string {
  return title.trim() === '' ? UNTITLED_TASK : title
}

export function teamSidebarSummary(team: SummarySource): TeamSidebarSummary {
  const tasks = team.tasks ?? {}
  let running = 0
  let waiting = 0
  let error = 0
  let starting = 0
  for (const member of Object.values(team.members)) {
    if (member.lastRuntimeState === 'running') running += 1
    else if (member.lastRuntimeState === 'waiting_approval') waiting += 1
    else if (member.lastRuntimeState === 'error') error += 1
    else if (member.lastRuntimeState === 'starting') starting += 1
  }
  let waitingDependency = 0
  for (const task of Object.values(tasks)) {
    if (taskWaitsOnDependency(task, tasks)) waitingDependency += 1
  }
  const taskRunning = Object.values(tasks).some(task => task.status === 'running')
  return {
    members: Object.keys(team.members).length,
    running,
    waiting,
    waitingDependency,
    ...(error > 0 ? { error } : {}),
    ...(starting > 0 ? { starting } : {}),
    ...(team.state === undefined ? {} : { state: team.state }),
    ...(taskRunning ? { taskRunning: true } : {}),
  }
}

/**
 * Approval is the only count that earns the badge; dependency waiting is text.
 * 空闲 is pushed only when nothing else describes the team: no running member,
 * no running task, no lifecycle label, no waking member, and no pending
 * approval, dependency or error. A pending fact therefore always replaces 空闲
 * instead of sitting next to it ("1 人 · 1 待审批", never "1 人 · 空闲 · 1 待审批").
 *
 * 异常 is one word: a member error appends it only when the lifecycle label has
 * not already said it, so an error team never reads "异常 · 异常".
 */
export function teamSidebarStatusText(summary: TeamSidebarSummary): string {
  const stateLabel = summary.state === undefined ? undefined : TEAM_STATE_LABELS[summary.state]
  const errorMembers = summary.error ?? 0
  const startingMembers = summary.starting ?? 0
  const attention = summary.waiting > 0 || summary.waitingDependency > 0 || errorMembers > 0
  const parts = [`${summary.members} 人`]
  if (summary.running > 0) parts.push(`${summary.running} 运行`)
  else if (summary.taskRunning === true) parts.push('任务执行中')
  // The lifecycle label already says 启动中 for state='starting'; the member
  // word is only the stand-in when no label speaks, so the row never reads
  // "启动中 · 启动中".
  else if (startingMembers > 0 && stateLabel === undefined) parts.push('启动中')
  else if (stateLabel === undefined && !attention) parts.push('空闲')
  if (stateLabel !== undefined) parts.push(stateLabel)
  if (summary.waiting > 0) parts.push(`${summary.waiting} 待审批`)
  else if (summary.waitingDependency > 0) parts.push(`${summary.waitingDependency} 等待前置`)
  if (errorMembers > 0 && summary.state !== 'error') parts.push('异常')
  return parts.join(' · ')
}

type SortableTeam = Pick<TeamView, 'pinned' | 'members' | 'updatedAt' | 'id' | 'name'>
  & Partial<Pick<TeamView, 'tasks'>>

export function compareTeamSidebar(left: SortableTeam, right: SortableTeam, sort: 'updated' | 'name'): number {
  const pinned = Number(right.pinned === true) - Number(left.pinned === true)
  if (pinned !== 0) return pinned
  if (sort === 'name') return left.name.localeCompare(right.name, 'zh-CN')
  const attention = teamSidebarSummary(right).waiting - teamSidebarSummary(left).waiting
  if (attention !== 0) return attention
  const busy = teamSidebarSummary(right).running - teamSidebarSummary(left).running
  if (busy !== 0) return busy
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
}

export function teamScopeCounts(teams: readonly Pick<TeamView, 'archivedAt'>[]): TeamScopeCounts {
  let archived = 0
  for (const team of teams) {
    if (team.archivedAt !== undefined) archived += 1
  }
  return { active: teams.length - archived, archived }
}

export function recentTeamTasks(team: TaskSource, limit = RECENT_TASK_LIMIT): TeamSidebarTask[] {
  if (limit <= 0) return []
  const members = team.members ?? {}
  return Object.values(team.tasks)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map(task => {
      const dependency = taskWaitsOnDependency(task, team.tasks)
        ? unresolvedDependency(task, team.tasks)
        : undefined
      const ownerName = dependency?.ownerSlotId === undefined
        ? undefined
        : members[dependency.ownerSlotId]?.displayName
      const detail = taskDetailLine(task, members)
      return {
        id: task.id,
        title: taskTitle(task.title),
        status: task.status,
        statusLabel: taskStatusLabel(task.status),
        updatedAt: task.updatedAt,
        ...(detail === undefined ? {} : { detail }),
        ...(dependency === undefined
          ? {}
          : {
              blockedBy: {
                id: dependency.id,
                title: taskTitle(dependency.title),
                ...(ownerName === undefined ? {} : { ownerName }),
              },
            }),
      }
    })
}

/**
 * The read-only facts the board's detail panel also prints. Only stored fields
 * appear: an unassigned task adds no owner word, a work task adds no verdict,
 * and a task with no times adds no schedule.
 */
function taskDetailLine(
  task: TeamTask,
  members: Partial<TeamView['members']>,
): string | undefined {
  const parts: string[] = []
  const ownerName = task.ownerSlotId === undefined
    ? undefined
    : members[task.ownerSlotId]?.displayName
  if (ownerName !== undefined) parts.push(ownerName)
  // A review/verification row prints its kind together with the decision
  // (审核：待结论); every other row prints the bare kind (实现).
  if (taskCarriesVerdict(task)) {
    const verdict = taskVerdictLabel(task)
    if (verdict !== undefined) parts.push(`${taskKindLabel(task.kind)}：${verdict}`)
  } else if (task.kind !== undefined) {
    parts.push(taskKindLabel(task.kind))
  }
  const schedule = taskScheduleSummary(task)
  if (schedule !== '') parts.push(schedule)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

export type TeamRosterTone = 'running' | 'waiting' | 'error' | 'starting' | 'idle' | 'offline'

/**
 * One bot row in the sidebar roster. Every field is read from the member
 * projection the Leader panel already uses, so the sidebar cannot invent a
 * second status vocabulary or a second member order.
 */
export interface TeamRosterRow {
  teamId: string
  slotId: string
  sessionId: string
  name: string
  role: 'leader' | 'member'
  /** Bounded inline avatar only; anything else falls back to the initial. */
  avatar?: string
  runtimeState: string
  statusLabel: string
  tone: TeamRosterTone
  /** Running task first, then the newest assigned one; never a placeholder. */
  currentTask?: { id: string; title: string }
  /** At most one mark; an approval wait outranks a runtime error. */
  attention?: 'approval' | 'error'
  /** The member's last startup failure, shown only while the row reads 异常. */
  errorText?: string
}

function rosterTone(state: string): TeamRosterTone {
  switch (state) {
    case 'running': return 'running'
    case 'waiting_approval': return 'waiting'
    case 'error': return 'error'
    case 'starting': return 'starting'
    case 'offline': return 'offline'
    default: return 'idle'
  }
}

function rosterAttention(state: string): 'approval' | 'error' | undefined {
  if (state === 'waiting_approval') return 'approval'
  if (state === 'error') return 'error'
  return undefined
}

/**
 * The sidebar roster: one row per member, read from `team.list` alone — no
 * extra request, no `team.workbench.get`, no fake counts. The approval mark is
 * a fact about this member ("parked on a decision"), so it carries no number.
 */
export function teamRosterRows(team: TeamView): TeamRosterRow[] {
  const rows: TeamRosterRow[] = []
  for (const member of teamPanelView(team).members) {
    const slot = team.members[member.id]
    if (slot === undefined) continue
    const avatar = slot.assistantSnapshot.avatar
    const attention = rosterAttention(member.state)
    rows.push({
      teamId: team.id,
      slotId: member.id,
      sessionId: slot.sessionId,
      name: member.name,
      role: member.role,
      ...(avatar !== undefined && isAssistantAvatarDataUrl(avatar) ? { avatar } : {}),
      runtimeState: member.state,
      statusLabel: memberStatusLabel(member.state),
      tone: rosterTone(member.state),
      ...(member.currentTask === undefined ? {} : { currentTask: member.currentTask }),
      ...(attention === undefined ? {} : { attention }),
      ...(member.state === 'error' && slot.lastError !== undefined ? { errorText: slot.lastError } : {}),
    })
  }
  return rows
}

/** Second line of a roster row: the status word, plus what the bot holds now. */
export function rosterSubtitle(row: Pick<TeamRosterRow, 'statusLabel' | 'currentTask'>): string {
  return row.currentTask === undefined
    ? row.statusLabel
    : `${row.statusLabel} · ${row.currentTask.title}`
}
