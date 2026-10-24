import type {
  AssistantMemory,
  MemoryEntry,
  TeamAggregate,
  TeamGoal,
  TeamMemory,
  TeamTask,
} from '../domain/types.js'
import { summarizeTaskProgress } from './task-progress.js'

export const TASK_STATE_LABELS: Readonly<Record<string, string>> = {
  pending: '待处理',
  assigned: '已分配',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
}

export function memberStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    offline: '离线',
    starting: '启动中',
    idle: '空闲',
    running: '运行中',
    waiting_approval: '等待审批',
    error: '异常',
  }
  return labels[status] ?? status
}

export function taskStatusLabel(status: string): string {
  return TASK_STATE_LABELS[status] ?? status
}

export const MEMORY_VISIBILITY_LABELS: Readonly<Record<string, string>> = {
  private: '私有',
  'team-safe': '团队可见',
}

export const MEMORY_STATUS_LABELS: Readonly<Record<string, string>> = {
  active: '生效',
  proposed: '待确认',
  superseded: '已替代',
  archived: '已归档',
}

export const MEMORY_SOURCE_LABELS: Readonly<Record<string, string>> = {
  user: '用户',
  leader: 'Leader',
  member: '成员',
  assistant: '助手',
  auto: '自动',
}

export function memoryVisibilityLabel(visibility: string): string {
  return MEMORY_VISIBILITY_LABELS[visibility] ?? visibility
}

export function memoryStatusLabel(status: string): string {
  return MEMORY_STATUS_LABELS[status] ?? status
}

export function memorySourceLabel(source: string): string {
  return MEMORY_SOURCE_LABELS[source] ?? source
}

export const GOAL_MODE_LABELS: Readonly<Record<string, string>> = {
  direct: '直接',
  single: '单任务',
  orchestrated: '编排',
}

export const GOAL_STATUS_LABELS: Readonly<Record<string, string>> = {
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
}

export function goalModeLabel(mode: string): string {
  return GOAL_MODE_LABELS[mode] ?? mode
}

export function goalStatusLabel(status: string): string {
  return GOAL_STATUS_LABELS[status] ?? status
}

/** Archived/superseded history can grow without bound; render only the newest page. */
export const MEMORY_HISTORY_LIMIT = 20

const MEMORY_ACTION_LABELS: Record<string, string> = {
  create: '新建',
  update: '修改',
  archive: '归档',
  accept: '接受',
  reject: '驳回',
  supersede: '替代',
  undo: '撤销',
}

export function memoryJournalActionLabel(action: string): string {
  return MEMORY_ACTION_LABELS[action] ?? action
}

export interface MemoryPanelView {
  revision: number
  /** Legacy free-text note; team memory never has one. */
  content: string
  active: MemoryEntry[]
  proposed: MemoryEntry[]
  history: MemoryEntry[]
  historyTotal: number
  empty: boolean
}

/**
 * Normalize one assistant memory document for the panel. A legacy row has only
 * `content`, so it stays visible as its own block; no entry is synthesized from
 * it. All statuses are shown, with history capped.
 */
export function assistantMemoryView(memory: AssistantMemory | null | undefined): MemoryPanelView {
  return memoryPanelView(
    memory?.content ?? '',
    memory?.revision ?? 0,
    (memory?.entries ?? []).filter(entry => entry.scope === 'assistant'),
  )
}

/**
 * Normalize team memory for the team UI. Private entries and assistant-scoped
 * entries never reach this view even if they somehow appear in the aggregate;
 * only team-safe team entries are rendered.
 */
export function teamMemoryView(memory: TeamMemory | undefined): MemoryPanelView {
  return memoryPanelView(
    '',
    memory?.revision ?? 0,
    (memory?.entries ?? []).filter(entry => entry.scope === 'team' && entry.visibility === 'team-safe'),
  )
}

function memoryPanelView(content: string, revision: number, entries: MemoryEntry[]): MemoryPanelView {
  const sorted = sortMemoryEntries(entries)
  const history = sorted.filter(entry => entry.status === 'superseded' || entry.status === 'archived')
  return {
    revision,
    content,
    active: sorted.filter(entry => entry.status === 'active'),
    proposed: sorted.filter(entry => entry.status === 'proposed'),
    history: history.slice(0, MEMORY_HISTORY_LIMIT),
    historyTotal: history.length,
    empty: content.trim() === '' && entries.length === 0,
  }
}

/** Newest first, with stable id tie-breaking so renders do not shuffle. */
export function sortMemoryEntries(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
}

/** Goal cards and task rows are bounded so a large board never renders unbounded. */
export const GOAL_CARD_RENDER_LIMIT = 12
export const GOAL_TASK_RENDER_LIMIT = 40

export const GOAL_FILTER_ALL = 'all'
export const GOAL_FILTER_UNGROUPED = 'ungrouped'

export interface GoalTaskGroup {
  /** Goal id, or `ungrouped` for the trailing bucket. */
  id: string
  goal?: TeamGoal
  tasks: TeamTask[]
  total: number
  completed: number
  running: number
  assigned: number
  blocked: number
  failed: number
  cancelled: number
  completionRate: number
}

export interface TaskDependencyItem {
  id: string
  title: string
  status: string
}

export interface TaskDependencyView {
  /** Dependencies that are not done yet; the task cannot proceed past them. */
  waitingOn: TaskDependencyItem[]
  /** Tasks waiting on this one, excluding completed/cancelled dependents. */
  blocks: TaskDependencyItem[]
  isBlocked: boolean
}

const GOAL_STATUS_RANK: Readonly<Record<TeamGoal['status'], number>> = {
  active: 0,
  paused: 1,
  completed: 2,
  cancelled: 3,
}

/** A legacy team has no `goals` record at all and must render unchanged. */
export function hasTeamGoals(team: Pick<TeamAggregate, 'goals'>): boolean {
  return Object.keys(team.goals ?? {}).length > 0
}

/**
 * Group the board under its Goals, with one trailing bucket for tasks that are
 * ungrouped or point at a Goal that no longer exists. Sorting is deterministic:
 * active Goals first, then creation time, then id.
 */
export function teamGoalGroups(team: Pick<TeamAggregate, 'goals' | 'tasks'>): GoalTaskGroup[] {
  const goals = Object.values(team.goals ?? {})
  if (goals.length === 0) return []
  const tasks = Object.values(team.tasks)
  const groups = [...goals]
    .sort(compareGoals)
    .map(goal => makeGoalGroup(goal.id, goal, tasks.filter(task => task.goalId === goal.id)))
  const ungrouped = tasks.filter(task => task.goalId === undefined || team.goals?.[task.goalId] === undefined)
  if (ungrouped.length > 0) groups.push(makeGoalGroup(GOAL_FILTER_UNGROUPED, undefined, ungrouped))
  return groups
}

export function filterGoalGroups(groups: readonly GoalTaskGroup[], filter: string): GoalTaskGroup[] {
  if (filter === GOAL_FILTER_ALL) return [...groups]
  if (filter === GOAL_FILTER_UNGROUPED) return groups.filter(group => group.goal === undefined)
  return groups.filter(group => group.goal !== undefined && group.id === filter)
}

/** Resolve dependency edges against the live board for one task. */
export function taskDependencyView(
  team: Pick<TeamAggregate, 'tasks'>,
  task: TeamTask,
): TaskDependencyView {
  const waitingOn = task.dependencyIds
    .filter(dependencyId => dependencyId !== task.id)
    .map(dependencyId => {
      const dependency = team.tasks[dependencyId]
      if (dependency === undefined) {
        return { id: dependencyId, title: '未知任务', status: 'unknown' }
      }
      if (dependency.status === 'completed' || dependency.status === 'cancelled') return undefined
      return toDependencyItem(dependency)
    })
    .filter((dependency): dependency is TaskDependencyItem => dependency !== undefined)
  const blocks = Object.values(team.tasks)
    .filter(other => other.id !== task.id)
    .filter(other => other.dependencyIds.includes(task.id))
    .filter(other => other.status !== 'completed' && other.status !== 'cancelled')
    .map(toDependencyItem)
  return {
    waitingOn,
    blocks,
    isBlocked: task.status === 'blocked' || waitingOn.length > 0,
  }
}

function makeGoalGroup(id: string, goal: TeamGoal | undefined, tasks: TeamTask[]): GoalTaskGroup {
  const sortedTasks = [...tasks].sort(compareGoalTasks)
  const summary = summarizeTaskProgress(
    Object.fromEntries(sortedTasks.map(task => [task.id, { status: task.status }])),
  )
  return {
    ...(goal === undefined ? {} : { goal }),
    id,
    tasks: sortedTasks,
    total: sortedTasks.length,
    completed: summary.completed,
    running: sortedTasks.filter(task => task.status === 'running').length,
    assigned: sortedTasks.filter(task => task.status === 'assigned').length,
    blocked: sortedTasks.filter(task => task.status === 'blocked').length,
    failed: summary.failed,
    cancelled: summary.cancelled,
    completionRate: summary.completionRate,
  }
}

function compareGoals(left: TeamGoal, right: TeamGoal): number {
  return GOAL_STATUS_RANK[left.status] - GOAL_STATUS_RANK[right.status]
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
}

function compareGoalTasks(left: TeamTask, right: TeamTask): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

function toDependencyItem(task: TeamTask): TaskDependencyItem {
  return { id: task.id, title: task.title, status: task.status }
}
