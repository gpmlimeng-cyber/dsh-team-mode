import type { TeamTask } from '../domain/types.js'
import type { TeamView } from '../transport/contracts.js'
import { memberStatusLabel, taskStatusLabel } from './labels.js'

/** One task chip in a member row: short title plus a Chinese status label. */
export interface PanelTaskChip {
  id: string
  title: string
  status: string
  statusLabel: string
}

export interface PanelMember {
  id: string
  name: string
  role: 'leader' | 'member'
  model: string
  state: string
  /** Same word the sidebar roster shows for this member state. */
  statusLabel: string
  currentTask?: { id: string; title: string }
  completed: number
  total: number
  chips: PanelTaskChip[]
}

export interface PanelBlocker {
  title: string
  ownerName?: string
}

/**
 * Read-only projection of one `TeamView` for the Leader's side panel. Every
 * count is a real task/member count: an empty team reports zeros, never an
 * invented placeholder.
 */
export interface PanelView {
  leaderName: string
  memberCount: number
  taskTotal: number
  completed: number
  running: number
  /** Open tasks held by an unfinished prerequisite (same rule as the sidebar). */
  waiting: number
  error: number
  approval: number
  /**
   * Tasks parked on `status: 'blocked'`, whatever holds them. Kept only so
   * `blockerText` can explain a wait whose dependency is unreachable; it is not
   * a second wait count and no progress line presents it.
   */
  blocked: number
  firstBlocker?: PanelBlocker
  members: PanelMember[]
}

const CHIP_LIMIT = 3
const UNTITLED_TASK = '未命名任务'

type TasksById = Readonly<Record<string, TeamTask>>

/**
 * Task statuses that can still wait on a prerequisite. Terminal rows
 * (completed/failed/cancelled) never hold a team in "waiting": a failed
 * prerequisite keeps its dependency id, and the downstream task was abandoned.
 *
 * One definition for the panel, the sidebar and the overview; `team-sidebar-data`
 * re-exports it so both the sidebar and the overview keep importing one symbol.
 */
export const OPEN_TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'assigned',
  'running',
  'blocked',
])

function taskTitle(title: string): string {
  return title.trim() === '' ? UNTITLED_TASK : title
}

function byUpdatedDesc(left: TeamTask, right: TeamTask): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
}

/** Running chips lead; within a group the newest task wins. */
function byChipOrder(left: TeamTask, right: TeamTask): number {
  const running = Number(right.status === 'running') - Number(left.status === 'running')
  return running !== 0 ? running : byUpdatedDesc(left, right)
}

/**
 * The prerequisite still holding a task. Missing ids are skipped (the task was
 * deleted or belongs to another team), so a stale id cannot hide a later real
 * dependency. Only `completed` releases a task.
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

/**
 * One rule for "waiting on a prerequisite", shared by the count and the task
 * rows: an unfinished task whose first reachable prerequisite is not completed.
 * A pending/assigned task qualifies too — otherwise a team that only queued
 * work reads as 空闲.
 */
export function taskWaitsOnDependency(
  task: Pick<TeamTask, 'status' | 'dependencyIds'>,
  tasks: Readonly<Record<string, TeamTask>>,
): boolean {
  return OPEN_TASK_STATUSES.has(task.status) && unresolvedDependency(task, tasks) !== undefined
}

function orderedMembers(team: TeamView): TeamView['members'][string][] {
  const order = team.memberOrder ?? Object.keys(team.members)
  const rank = new Map(order.map((id, index) => [id, index]))
  return Object.values(team.members).sort((left, right) =>
    (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || left.joinedAt.localeCompare(right.joinedAt)
    || left.id.localeCompare(right.id))
}

function panelMember(member: TeamView['members'][string], tasks: readonly TeamTask[]): PanelMember {
  const owned = tasks.filter(task => task.ownerSlotId === member.id)
  const completed = owned.filter(task => task.status === 'completed').length
  const running = owned.filter(task => task.status === 'running').sort(byUpdatedDesc)[0]
  const assigned = owned.filter(task => task.status === 'assigned').sort(byUpdatedDesc)[0]
  const current = running ?? assigned
  const chips = [...owned].sort(byChipOrder).slice(0, CHIP_LIMIT).map(task => ({
    id: task.id,
    title: taskTitle(task.title),
    status: task.status,
    statusLabel: taskStatusLabel(task.status),
  }))

  return {
    id: member.id,
    name: member.displayName,
    role: member.role,
    model: member.assistantSnapshot.model,
    state: member.lastRuntimeState,
    statusLabel: memberStatusLabel(member.lastRuntimeState),
    completed,
    // Cancelled tasks stay in the denominator: the member was assigned the work
    // and only `completed` counts toward progress.
    total: owned.length,
    chips,
    ...(current === undefined
      ? {}
      : { currentTask: { id: current.id, title: taskTitle(current.title) } }),
  }
}

export function teamPanelView(team: TeamView): PanelView {
  const tasksById = team.tasks ?? {}
  const tasks = Object.values(tasksById)
  const members = orderedMembers(team)

  let completed = 0
  let error = 0
  let blocked = 0
  const runningTasks: TeamTask[] = []
  const waiting = tasks.filter(task => taskWaitsOnDependency(task, tasksById)).length
  for (const task of tasks) {
    switch (task.status) {
      case 'completed':
        completed += 1
        break
      case 'failed':
      case 'cancelled':
        error += 1
        break
      case 'blocked':
        blocked += 1
        break
      case 'running':
        runningTasks.push(task)
        break
      default:
        break
    }
  }

  // Task progress is authoritative; a member still working on an assigned task
  // (or without a task) is counted once as execution, never twice for the same
  // running task.
  const runningOwners = new Set(runningTasks.map(task => task.ownerSlotId))
  const extraRunningMembers = members.filter(member =>
    member.lastRuntimeState === 'running' && !runningOwners.has(member.id)).length
  const running = runningTasks.length + extraRunningMembers

  const approval = members.filter(member => member.lastRuntimeState === 'waiting_approval').length

  const blocker = tasks
    .filter(task => task.status === 'blocked')
    .sort(byUpdatedDesc)
    .map(task => ({ task, dependency: unresolvedDependency(task, tasksById) }))
    .find(entry => entry.dependency !== undefined)
  const dependency = blocker?.dependency
  const dependencyOwner = dependency?.ownerSlotId === undefined
    ? undefined
    : team.members[dependency.ownerSlotId]?.displayName
  const firstBlocker: PanelBlocker | undefined = dependency === undefined
    ? undefined
    : {
        title: taskTitle(dependency.title),
        ...(dependencyOwner === undefined ? {} : { ownerName: dependencyOwner }),
      }

  return {
    leaderName: team.members[team.leaderSlotId]?.displayName ?? '',
    memberCount: members.length,
    taskTotal: tasks.length,
    completed,
    running,
    waiting,
    error,
    approval,
    blocked,
    ...(firstBlocker === undefined ? {} : { firstBlocker }),
    members: members.map(member => panelMember(member, tasks)),
  }
}

/**
 * One text line for the panel progress region; zero counts stay explicit. The
 * blocked-by-a-prerequisite word is 等待前置 here exactly as in the sidebar and
 * the overview, and the status-blocked set is explained by `blockerText`, never
 * as a second count on this line.
 */
export function panelProgressText(view: PanelView): string {
  const parts = [`已完成 ${view.completed}/${view.taskTotal}`]
  if (view.running > 0) parts.push(`进行中 ${view.running}`)
  if (view.waiting > 0) parts.push(`等待前置 ${view.waiting}`)
  if (view.error > 0) parts.push(`异常 ${view.error}`)
  return parts.join(' · ')
}
