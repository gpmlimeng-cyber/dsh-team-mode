import type { AssistantSession } from '../domain/types.js'
import type { AssistantInstanceView, TeamView } from '../transport/contracts.js'
import { assistantInstanceName, assistantTasksFor } from './assistant-instances.js'
import { isAssistantUnread } from './assistant-read-state.js'
import { taskWaitsOnDependency } from './team-sidebar-data.js'
import { isTeamExecuting } from './team-status.js'

/**
 * One thing that can need the operator. A category is a fact about an entity,
 * not a row: an entity can hold several, and the overview lists it once.
 */
export type AttentionCategory = 'approval' | 'assistant_input' | 'blocked' | 'error' | 'unread'

export interface GlobalTeamItem {
  kind: 'team'
  id: string
  name: string
  leaderName: string
  members: number
  /** Has activity: a running member/task or a member parked on approval. */
  running: boolean
  /** Members waiting for user approval. */
  approval: number
  /** Open tasks waiting on an unfinished prerequisite; terminal tasks never block. */
  blocked: number
  /** Team, member, or warmup failure — a state, not a decision. */
  error: boolean
  /** Team or a member is still waking up: startup is activity, never 空闲. */
  starting: boolean
  /** Stable category order; each category appears at most once. */
  categories: AttentionCategory[]
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
  /** The instance itself failed; a stale task must not read this as activity. */
  error: boolean
  /** A newer preview than the read marker; never true for an unread-free row. */
  unread: boolean
  /** Stable category order; each category appears at most once. */
  categories: AttentionCategory[]
  /** Absent until the main Session exists; navigation needs it, nothing ensures it. */
  mainSessionId?: string
}

export type GlobalOverviewItem = GlobalTeamItem | GlobalAssistantItem

export interface GlobalCounts {
  teams: number
  assistants: number
  /** Entities with activity ("有活动"), approvals included. */
  running: number
  /** Entities that must be decided: approval or assistant input. */
  attention: number
  blocked: number
  error: number
  unread: number
  /** Neither active nor holding any category. */
  idle: number
}

export interface GlobalOverviewModel {
  /**
   * The projected entities the counts are derived from. The overview no longer
   * renders them — the sidebar and 今天 own the lists — so they stay here as
   * facts, not as a second surface.
   */
  teams: GlobalTeamItem[]
  assistants: GlobalAssistantItem[]
  counts: GlobalCounts
}

export interface GlobalOverviewInput {
  teams: readonly TeamView[]
  instances: readonly AssistantInstanceView[]
  tasks: readonly AssistantSession[]
  /** Assistant read-at map; a missing record is read-at-preview, never unread. */
  readState?: Readonly<Record<string, number>>
}

/** Worker tasks that still count as live work on an assistant row. */
const LIVE_TASK_STATUSES: ReadonlySet<AssistantSession['status']> = new Set([
  'queued',
  'running',
  'needs_input',
])

/** Team lifecycle states that are failures, not activity. */
const TEAM_ERROR_STATES: ReadonlySet<TeamView['state']> = new Set([
  'error',
  'ownership_conflict',
  'delete_blocked',
])

function timeOf(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? 0 : parsed
}

function teamFailed(team: TeamView): boolean {
  if (TEAM_ERROR_STATES.has(team.state)) return true
  if (team.warmup?.phase === 'error') return true
  return Object.values(team.members).some(member => member.lastRuntimeState === 'error')
}

/**
 * One team row. `running` is the board's own activity rule (approvals count as
 * activity there); approvals are members parked on `waiting_approval`. `blocked`
 * uses the shared dependency rule from the sidebar, so a queued task held by an
 * unfinished prerequisite counts while a terminal task never does.
 */
function teamItem(team: TeamView): GlobalTeamItem {
  const members = Object.values(team.members)
  const approval = members.filter(member => member.lastRuntimeState === 'waiting_approval').length
  const blocked = Object.values(team.tasks)
    .filter(task => taskWaitsOnDependency(task, team.tasks)).length
  const error = teamFailed(team)
  const starting = team.state === 'starting'
    || members.some(member => member.lastRuntimeState === 'starting')
  const categories: AttentionCategory[] = []
  if (approval > 0) categories.push('approval')
  if (blocked > 0) categories.push('blocked')
  if (error) categories.push('error')
  return {
    kind: 'team',
    id: team.id,
    name: team.name,
    leaderName: team.members[team.leaderSlotId]?.displayName ?? '',
    members: members.length,
    running: isTeamExecuting(team),
    approval,
    blocked,
    error,
    starting,
    categories,
  }
}

/**
 * One assistant row. Archived worker tasks are history and never contribute.
 * The status alone does not prove work: an instance left `idle` can still own a
 * running task, so both sources feed `running`. A failed instance is marked
 * `error` even when a stale task would otherwise suggest activity.
 */
function assistantItem(
  instance: AssistantInstanceView,
  tasks: readonly AssistantSession[],
  readState: Readonly<Record<string, number>>,
): GlobalAssistantItem {
  const live = assistantTasksFor(tasks, instance.id)
    .filter(task => task.archivedAt === undefined)
  const needsInput = live.filter(task => task.status === 'needs_input').length
  const error = instance.status === 'error'
  const unread = isAssistantUnread(instance, readState)
  const categories: AttentionCategory[] = []
  if (needsInput > 0) categories.push('assistant_input')
  if (error) categories.push('error')
  if (unread) categories.push('unread')
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
    error,
    unread,
    categories,
    ...(mainSessionId === undefined || mainSessionId === '' ? {} : { mainSessionId }),
  }
}

function hasCategory(item: GlobalOverviewItem, category: AttentionCategory): boolean {
  return item.categories.includes(category)
}

/** An item is attention only when the user must decide something. */
function isAttention(item: GlobalOverviewItem): boolean {
  return hasCategory(item, 'approval') || hasCategory(item, 'assistant_input')
}

/**
 * Idle is every item that is neither active, still waking up, nor holding any
 * category. Startup is activity: an agent that is starting is not leisure, so a
 * starting team is never counted (or filtered) as 空闲.
 */
function isIdle(item: GlobalOverviewItem): boolean {
  return !item.running && !(item.kind === 'team' && item.starting) && item.categories.length === 0
}

/**
 * Read-only projection of every non-archived team and assistant. Counts are
 * distinct entities per state, never interactions: an item can be active and
 * need attention at once, so the numbers are not a partition. Blocked is a
 * team-only state; a queued assistant task is not blocked.
 */
export function globalOverviewModel(input: GlobalOverviewInput): GlobalOverviewModel {
  const readState = input.readState ?? {}
  const teamEntries = input.teams
    .filter(team => team.archivedAt === undefined)
    .map(team => ({ item: teamItem(team), updatedAt: timeOf(team.updatedAt) }))
  const assistantEntries = input.instances
    .filter(instance => instance.status !== 'archived' && instance.archivedAt === undefined)
    .map(instance => ({
      item: assistantItem(instance, input.tasks, readState),
      updatedAt: timeOf(instance.updatedAt),
    }))

  const items = [...teamEntries.map(entry => entry.item), ...assistantEntries.map(entry => entry.item)]

  return {
    teams: teamEntries.map(entry => entry.item),
    assistants: assistantEntries.map(entry => entry.item),
    counts: {
      teams: teamEntries.length,
      assistants: assistantEntries.length,
      running: items.filter(item => item.running).length,
      attention: items.filter(isAttention).length,
      blocked: items.filter(item => hasCategory(item, 'blocked')).length,
      error: items.filter(item => hasCategory(item, 'error')).length,
      unread: items.filter(item => hasCategory(item, 'unread')).length,
      idle: items.filter(isIdle).length,
    },
  }
}
