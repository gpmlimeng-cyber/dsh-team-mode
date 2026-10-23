import type { TeamTask } from '../domain/types.js'
import type { TeamView } from '../transport/contracts.js'

export interface TeamSidebarSummary {
  members: number
  running: number
  waiting: number
  /** Blocked tasks that still wait on an unfinished prerequisite. */
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
}

export interface TeamScopeCounts {
  active: number
  archived: number
}

type SummarySource = Pick<TeamView, 'members'> & Partial<Pick<TeamView, 'tasks' | 'state'>>
type TaskSource = Pick<TeamView, 'tasks'> & Partial<Pick<TeamView, 'members'>>

/** `in_progress` also reads through, so legacy board rows stay labeled. */
const TASK_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: '待处理',
  assigned: '已分配',
  running: '进行中',
  in_progress: '进行中',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

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

/**
 * The task this one still waits for. Mirrors `clearDownstreamBlockers`: only a
 * completed prerequisite leaves `dependencyIds`, so a failed or cancelled
 * prerequisite still holds the downstream task.
 *
 * An id with no task in this TeamView is not reachable: it was deleted or never
 * belonged here, so the sidebar cannot name it and does not count it as a wait.
 * Skipping it (rather than returning early) keeps a later reachable
 * prerequisite visible behind a stale id.
 *
 * Exported because the global overview's "blocked" count must use the same
 * dependency rule instead of trusting `status === 'blocked'`.
 */
export function unresolvedDependency(
  task: Pick<TeamTask, 'dependencyIds'>,
  tasks: Readonly<Record<string, TeamTask>>,
): TeamTask | undefined {
  for (const id of task.dependencyIds) {
    const dependency = tasks[id]
    if (dependency === undefined) continue
    if (dependency.status !== 'completed') return dependency
  }
  return undefined
}

export function teamSidebarSummary(team: SummarySource): TeamSidebarSummary {
  const tasks = team.tasks ?? {}
  let running = 0
  let waiting = 0
  for (const member of Object.values(team.members)) {
    if (member.lastRuntimeState === 'running') running += 1
    else if (member.lastRuntimeState === 'waiting_approval') waiting += 1
  }
  let waitingDependency = 0
  for (const task of Object.values(tasks)) {
    if (task.status !== 'blocked') continue
    if (unresolvedDependency(task, tasks) !== undefined) waitingDependency += 1
  }
  const taskRunning = Object.values(tasks).some(task => task.status === 'running')
  return {
    members: Object.keys(team.members).length,
    running,
    waiting,
    waitingDependency,
    ...(team.state === undefined ? {} : { state: team.state }),
    ...(taskRunning ? { taskRunning: true } : {}),
  }
}

/**
 * Approval is the only count that earns the badge; dependency waiting is text.
 * 空闲 is pushed only when nothing else describes the team: no running member,
 * no running task, no lifecycle label, and no pending approval or dependency.
 * A pending approval therefore always replaces 空闲 instead of sitting next to
 * it ("1 人 · 1 待审批", never "1 人 · 空闲 · 1 待审批").
 */
export function teamSidebarStatusText(summary: TeamSidebarSummary): string {
  const stateLabel = summary.state === undefined ? undefined : TEAM_STATE_LABELS[summary.state]
  const attention = summary.waiting > 0 || summary.waitingDependency > 0
  const parts = [`${summary.members} 人`]
  if (summary.running > 0) parts.push(`${summary.running} 运行`)
  else if (summary.taskRunning === true) parts.push('任务执行中')
  else if (stateLabel === undefined && !attention) parts.push('空闲')
  if (stateLabel !== undefined) parts.push(stateLabel)
  if (summary.waiting > 0) parts.push(`${summary.waiting} 待审批`)
  else if (summary.waitingDependency > 0) parts.push(`${summary.waitingDependency} 等待前置`)
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
      const dependency = task.status === 'blocked' ? unresolvedDependency(task, team.tasks) : undefined
      const ownerName = dependency?.ownerSlotId === undefined
        ? undefined
        : members[dependency.ownerSlotId]?.displayName
      return {
        id: task.id,
        title: taskTitle(task.title),
        status: task.status,
        statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status,
        updatedAt: task.updatedAt,
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
