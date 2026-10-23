import type { TeamView } from '../transport/contracts.js'

export interface TeamSidebarSummary {
  members: number
  running: number
  waiting: number
}

export interface TeamSidebarTask {
  id: string
  title: string
  status: string
  statusLabel: string
  updatedAt: string
}

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

export function teamSidebarSummary(team: Pick<TeamView, 'members'>): TeamSidebarSummary {
  let running = 0
  let waiting = 0
  for (const member of Object.values(team.members)) {
    if (member.lastRuntimeState === 'running') running += 1
    else if (member.lastRuntimeState === 'waiting_approval') waiting += 1
  }
  return { members: Object.keys(team.members).length, running, waiting }
}

export function teamSidebarStatusText(summary: TeamSidebarSummary): string {
  if (summary.waiting > 0) return `${summary.members} 人 · ${summary.running} 运行 · ${summary.waiting} 待审批`
  if (summary.running > 0) return `${summary.members} 人 · ${summary.running} 运行`
  return `${summary.members} 人 · 空闲`
}

export function compareTeamSidebar(
  left: Pick<TeamView, 'pinned' | 'members' | 'updatedAt' | 'id' | 'name'>,
  right: Pick<TeamView, 'pinned' | 'members' | 'updatedAt' | 'id' | 'name'>,
  sort: 'updated' | 'name',
): number {
  const pinned = Number(right.pinned === true) - Number(left.pinned === true)
  if (pinned !== 0) return pinned
  if (sort === 'name') return left.name.localeCompare(right.name, 'zh-CN')
  const attention = teamSidebarSummary(right).waiting - teamSidebarSummary(left).waiting
  if (attention !== 0) return attention
  const busy = teamSidebarSummary(right).running - teamSidebarSummary(left).running
  if (busy !== 0) return busy
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
}

export function recentTeamTasks(team: Pick<TeamView, 'tasks'>, limit = RECENT_TASK_LIMIT): TeamSidebarTask[] {
  if (limit <= 0) return []
  return Object.values(team.tasks)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map(task => ({
      id: task.id,
      title: task.title.trim() === '' ? '未命名任务' : task.title,
      status: task.status,
      statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status,
      updatedAt: task.updatedAt,
    }))
}
