import type { TeamMessage, TeamTask } from '../domain/types.js'

/** Which half of the team board is showing. */
export type BoardMode = 'overview' | 'tasks'

/** Tasks that sit the same distance from their prerequisites. */
export interface DependencyLayer {
  depth: number
  tasks: TeamTask[]
}

/**
 * A layered view of the board. `unlayered` holds tasks whose prerequisites
 * cannot be ordered (a cycle, a missing dependency, or a task waiting behind
 * either); they are kept rather than dropped so the graph never loses work.
 */
export interface DependencyGraph {
  layers: DependencyLayer[]
  unlayered: TeamTask[]
}

/** A team with one of these tasks still needs the overview first. */
const LIVE_TASK_STATUSES: ReadonlySet<TeamTask['status']> = new Set([
  'running',
  'blocked',
  'failed',
])

const INBOX_LIMIT = 5

function updatedAtOf(task: TeamTask): number {
  const parsed = Date.parse(task.updatedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

function byUpdatedDesc(left: TeamTask, right: TeamTask): number {
  return updatedAtOf(right) - updatedAtOf(left) || left.id.localeCompare(right.id)
}

function createdAtOf(message: TeamMessage): number {
  const parsed = Date.parse(message.createdAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

function byCreatedDesc(left: TeamMessage, right: TeamMessage): number {
  return createdAtOf(right) - createdAtOf(left) || left.id.localeCompare(right.id)
}

/**
 * A stored choice always wins; otherwise live work opens the overview and a
 * quiet board stays on tasks. Unknown stored values are treated as absent.
 */
export function defaultBoardMode(
  tasks: readonly TeamTask[],
  stored?: string,
): BoardMode {
  if (stored === 'overview' || stored === 'tasks') return stored
  return tasks.some(task => LIVE_TASK_STATUSES.has(task.status)) ? 'overview' : 'tasks'
}

/**
 * Layers tasks by their `dependencyIds`: roots are depth 0 and each dependent
 * sits one past its deepest prerequisite. A dependency id with no task on this
 * board cannot be resolved, so its dependent (and everything behind it) cannot
 * be ordered and lands in `unlayered`; nothing is silently treated as ready.
 * Cycles behave the same way and are kept instead of dropped.
 */
export function dependencyGraph(tasks: readonly TeamTask[]): DependencyGraph {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const dependencies = new Map<string, TeamTask[]>()
  const dependencyCount = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const task of tasks) {
    const uniqueIds = [...new Set(task.dependencyIds)]
    const unique = uniqueIds
      .map(id => byId.get(id))
      .filter((entry): entry is TeamTask => entry !== undefined)
    dependencies.set(task.id, unique)
    dependencyCount.set(task.id, uniqueIds.length)
    for (const dependency of unique) {
      const list = dependents.get(dependency.id)
      if (list === undefined) dependents.set(dependency.id, [task.id])
      else list.push(task.id)
    }
  }

  const waitingOn = new Map<string, number>()
  const ready: TeamTask[] = []
  for (const task of tasks) {
    const count = dependencyCount.get(task.id) ?? 0
    waitingOn.set(task.id, count)
    if (count === 0) ready.push(task)
  }

  const depthOf = new Map<string, number>()
  const byDepth = new Map<number, TeamTask[]>()

  while (ready.length > 0) {
    const task = ready.shift()
    if (task === undefined) break
    const prerequisites = dependencies.get(task.id) ?? []
    const depth = prerequisites.reduce((deepest, dependency) => {
      return Math.max(deepest, (depthOf.get(dependency.id) ?? -1) + 1)
    }, 0)
    depthOf.set(task.id, depth)
    const layer = byDepth.get(depth)
    if (layer === undefined) byDepth.set(depth, [task])
    else layer.push(task)

    for (const dependentId of dependents.get(task.id) ?? []) {
      const remaining = (waitingOn.get(dependentId) ?? 0) - 1
      waitingOn.set(dependentId, remaining)
      const dependent = byId.get(dependentId)
      if (remaining === 0 && dependent !== undefined) ready.push(dependent)
    }
  }

  const layers: DependencyLayer[] = [...byDepth.entries()]
    .sort(([left], [right]) => left - right)
    .map(([depth, layer]) => ({ depth, tasks: layer.sort(byUpdatedDesc) }))

  return {
    layers,
    unlayered: tasks.filter(task => !depthOf.has(task.id)).sort(byUpdatedDesc),
  }
}

/**
 * Leader-addressed mail, newest first. A message addressed to `leader` with no
 * slot targets the current leader, matching how the board names a recipient.
 * System notices are never actionable and are excluded; the default window is
 * the latest five.
 */
export function leaderInbox(
  messages: readonly TeamMessage[],
  leaderSlotId: string,
  limit = INBOX_LIMIT,
): TeamMessage[] {
  const cap = Math.floor(limit)
  if (!(cap > 0)) return []
  return messages
    .filter(message => message.type !== 'system')
    .filter(message => message.recipient.kind === 'leader'
      && (message.recipient.slotId === undefined || message.recipient.slotId === leaderSlotId))
    .sort(byCreatedDesc)
    .slice(0, cap)
}

/**
 * The task the overview should open: an existing selection, then the newest
 * running task, then the most recently updated task. Empty boards select
 * nothing rather than inventing a placeholder.
 */
export function pickOverviewTask(
  tasks: readonly TeamTask[],
  selectedId?: string,
): TeamTask | undefined {
  if (selectedId !== undefined) {
    const selected = tasks.find(task => task.id === selectedId)
    if (selected !== undefined) return selected
  }
  const ordered = [...tasks].sort(byUpdatedDesc)
  return ordered.find(task => task.status === 'running') ?? ordered[0]
}
