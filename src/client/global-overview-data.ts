import type { AssistantSession } from '../domain/types.js'
import type { AssistantInstanceView, TeamView } from '../transport/contracts.js'
import { assistantInstanceName, assistantTasksFor } from './assistant-instances.js'
import { unresolvedDependency } from './team-sidebar-data.js'
import { isTeamExecuting } from './team-status.js'

/** Which subset of the overview rows a filter shows. */
export type GlobalFilter = 'all' | 'attention' | 'running' | 'idle'

export interface GlobalTeamItem {
  kind: 'team'
  id: string
  name: string
  leaderName: string
  members: number
  running: boolean
  /** Members waiting for user approval. */
  approval: number
  /** Open tasks waiting on an unfinished prerequisite; terminal tasks never block. */
  blocked: number
}

export interface GlobalAssistantItem {
  kind: 'assistant'
  id: string
  name: string
  model: string
  status: AssistantInstanceView['status']
  /** Live worker tasks: queued, running, or waiting for input. */
  tasks: number
  running: boolean
  needsInput: number
  /** Absent until the main Session exists; navigation needs it, nothing ensures it. */
  mainSessionId?: string
}

export type GlobalOverviewItem = GlobalTeamItem | GlobalAssistantItem

export interface GlobalCounts {
  teams: number
  assistants: number
  running: number
  attention: number
  blocked: number
  idle: number
}

export interface GlobalOverviewModel {
  teams: GlobalTeamItem[]
  assistants: GlobalAssistantItem[]
  counts: GlobalCounts
  /** Items needing the user, most pending work first. */
  attention: GlobalOverviewItem[]
}

/** Worker tasks that still count as live work on an assistant row. */
const LIVE_TASK_STATUSES: ReadonlySet<AssistantSession['status']> = new Set([
  'queued',
  'running',
  'needs_input',
])

/**
 * Task statuses that can still wait on a prerequisite. Terminal rows
 * (completed/failed/cancelled) must never hold a team in "blocked" forever just
 * because a failed prerequisite keeps its dependency id.
 */
const OPEN_TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'assigned',
  'running',
  'blocked',
])

function timeOf(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * One team row. `running` is the board's own execution rule; approvals are
 * members parked on `waiting_approval`. `blocked` counts open tasks waiting on
 * an unfinished prerequisite: dependency-derived, not a status check, so a
 * pending/assigned task with an unfinished prerequisite blocks the team while
 * a terminal task or a `status: 'blocked'` row with no unfinished dependency
 * (for example a Leader-epoch retire) does not.
 */
function teamItem(team: TeamView): GlobalTeamItem {
  const members = Object.values(team.members)
  return {
    kind: 'team',
    id: team.id,
    name: team.name,
    leaderName: team.members[team.leaderSlotId]?.displayName ?? '',
    members: members.length,
    running: isTeamExecuting(team),
    approval: members.filter(member => member.lastRuntimeState === 'waiting_approval').length,
    blocked: Object.values(team.tasks)
      .filter(task => OPEN_TASK_STATUSES.has(task.status)
        && unresolvedDependency(task, team.tasks) !== undefined).length,
  }
}

/**
 * One assistant row. Archived worker tasks are history and never contribute.
 * The status alone does not prove work: an instance left `idle` can still own a
 * running task, so both sources feed `running`.
 */
function assistantItem(
  instance: AssistantInstanceView,
  tasks: readonly AssistantSession[],
): GlobalAssistantItem {
  const live = assistantTasksFor(tasks, instance.id)
    .filter(task => task.archivedAt === undefined)
  const needsInput = live.filter(task => task.status === 'needs_input').length
  const mainSessionId = instance.mainSessionId
  return {
    kind: 'assistant',
    id: instance.id,
    name: assistantInstanceName(instance),
    model: instance.assistantSnapshot.model,
    status: instance.status,
    tasks: live.filter(task => LIVE_TASK_STATUSES.has(task.status)).length,
    running: instance.status === 'active' || live.some(task => task.status === 'running'),
    needsInput,
    ...(mainSessionId === undefined || mainSessionId === '' ? {} : { mainSessionId }),
  }
}

/** An item is attention only when the user must decide something. */
function isAttention(item: GlobalOverviewItem): boolean {
  return item.kind === 'team' ? item.approval > 0 : item.needsInput > 0
}

function isBlocked(item: GlobalOverviewItem): boolean {
  return item.kind === 'team' && item.blocked > 0
}

/** Idle is every item that is in none of the other three states. */
function isIdle(item: GlobalOverviewItem): boolean {
  return !item.running && !isAttention(item) && !isBlocked(item)
}

function attentionWeight(item: GlobalOverviewItem): number {
  return item.kind === 'team' ? item.approval : item.needsInput
}

/** Teams lead the attention list when pending work and recency are equal. */
function kindOrder(item: GlobalOverviewItem): number {
  return item.kind === 'team' ? 0 : 1
}

interface Ranked {
  item: GlobalOverviewItem
  updatedAt: number
}

/**
 * Read-only projection of every non-archived team and assistant. Counts are
 * unique items per state: an item can be running and need attention at once, so
 * the four numbers are not a partition. Blocked is a team-only state; a queued
 * assistant task is not blocked.
 */
export function globalOverviewModel(input: {
  teams: readonly TeamView[]
  instances: readonly AssistantInstanceView[]
  tasks: readonly AssistantSession[]
}): GlobalOverviewModel {
  const teamEntries = input.teams
    .filter(team => team.archivedAt === undefined)
    .map(team => ({ item: teamItem(team), updatedAt: timeOf(team.updatedAt) }))
  const assistantEntries = input.instances
    .filter(instance => instance.status !== 'archived' && instance.archivedAt === undefined)
    .map(instance => ({ item: assistantItem(instance, input.tasks), updatedAt: timeOf(instance.updatedAt) }))

  const items = [...teamEntries.map(entry => entry.item), ...assistantEntries.map(entry => entry.item)]
  const attention = [...teamEntries, ...assistantEntries]
    .filter(entry => isAttention(entry.item))
    .sort((left, right) => attentionWeight(right.item) - attentionWeight(left.item)
      || right.updatedAt - left.updatedAt
      || kindOrder(left.item) - kindOrder(right.item)
      || left.item.id.localeCompare(right.item.id))
    .map(entry => entry.item)

  return {
    teams: teamEntries.map(entry => entry.item),
    assistants: assistantEntries.map(entry => entry.item),
    counts: {
      teams: teamEntries.length,
      assistants: assistantEntries.length,
      running: items.filter(item => item.running).length,
      attention: items.filter(isAttention).length,
      blocked: items.filter(isBlocked).length,
      idle: items.filter(isIdle).length,
    },
    attention,
  }
}

/**
 * Narrow the rows shown. Counts and the attention list describe the whole
 * workspace and are returned untouched, so a filter can never invent or hide a
 * number in the summary.
 */
export function filterGlobalOverview(
  model: GlobalOverviewModel,
  filter: GlobalFilter,
): GlobalOverviewModel {
  const keep = (item: GlobalOverviewItem): boolean => {
    switch (filter) {
      case 'all': return true
      case 'attention': return isAttention(item)
      case 'running': return item.running
      case 'idle': return isIdle(item)
    }
  }
  return {
    teams: model.teams.filter(keep),
    assistants: model.assistants.filter(keep),
    counts: model.counts,
    attention: model.attention,
  }
}
