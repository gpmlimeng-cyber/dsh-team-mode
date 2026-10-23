import type { TeamTask } from '../domain/types.js'
import type { TeamView } from '../transport/contracts.js'

export interface TeamSidebarSummary {
  members: number
  running: number
  waiting: number
  /** Blocked tasks that still wait on an unfinished prerequisite. */
  waitingDependency: number
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

type SummarySource = Pick<TeamView, 'members'> & Partial<Pick<TeamView, 'tasks'>>
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

const RECENT_TASK_LIMIT = 3
const UNTITLED_TASK = '未命名任务'

function taskTitle(title: string): string {
  return title.trim() === '' ? UNTITLED_TASK : title
}

/**
 * The task this one still waits for. Mirrors `clearDownstreamBlockers`: only a
 * completed prerequisite is removed from `dependencyIds`, so anything else
 * (missing, failed, cancelled) still holds the downstream task.
 */
function unresolvedDependency(
  task: Pick<TeamTask, 'dependencyIds'>,
  tasks: Readonly<Record<string, TeamTask>>,
): TeamTask | undefined {
  for (const id of task.dependencyIds) {
    const dependency = tasks[id]
    if (dependency === undefined || dependency.status !== 'completed') return dependency
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
  return { members: Object.keys(team.members).length, running, waiting, waitingDependency }
}

/** Approval is the only count that earns the badge; dependency waiting is text. */
export function teamSidebarStatusText(summary: TeamSidebarSummary): string {
  if (summary.waiting > 0) return `${summary.members} 人 · ${summary.running} 运行 · ${summary.waiting} 待审批`
  if (summary.waitingDependency > 0) {
    return `${summary.members} 人 · ${summary.running} 运行 · ${summary.waitingDependency} 等待前置`
  }
  if (summary.running > 0) return `${summary.members} 人 · ${summary.running} 运行`
  return `${summary.members} 人 · 空闲`
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
