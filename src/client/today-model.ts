import type { AssistantInstance, AssistantSession, Escalation } from '../domain/types.js'
import type { AssistantInstanceView, TeamView } from '../transport/contracts.js'
import { assistantInstanceName, assistantPendingDecisions } from './assistant-instances.js'
import { isAssistantUnread } from './assistant-read-state.js'

/**
 * 「今天」首页的数据层：纯派生，不发请求、不读时钟、不格式化时间。
 *
 * 输入全部是页面已经读到的只读投影（`team.list` 的 TeamView、侧栏的
 * `escalation.list` 行、`assistant.instance.list` / `assistant.task.list`、
 * 自动化面板的 schedule catalog），所以这个文件只做「把已有的东西排成几块」。
 * 所有时间是毫秒时间戳，相对时长由 UI 用自己的 now 格式化——纯函数里做相对
 * 时间就没法测了。
 */

/** 助手行要打开的目标；团队行没有这个字段。 */
export interface TodayWaitingAssistant {
  assistantId: string
  name: string
  /** 主会话或 worker 会话；行点击直接打开它。 */
  sessionId: string
  /** 待你处理的 worker 任务；未读行没有任务。 */
  taskId?: string
}

export interface TodayWaiting {
  /** 团队事项的团队；助手事项没有 teamId，改用 `assistant`。 */
  teamId?: string
  /** 行首展示的来源名：团队名或助手名。 */
  teamName: string
  kind:
    | 'approval'
    | 'question'
    | 'blocked_task'
    | 'stuck_member'
    | 'assistant_decision'
    | 'assistant_unread'
  subject: string
  /** 这条事项开始等你时的毫秒时间戳。 */
  since: number
  waitMs: number
  assistant?: TodayWaitingAssistant
}

export interface TodayRunning {
  teamId: string
  teamName: string
  /** 一句当前在做什么（进行中的任务标题，或成员名）。 */
  subject: string
  since: number
  runMs: number
}

export interface TodayUpcoming {
  id: string
  name: string
  /** 下一次触发的毫秒时间戳。 */
  nextAt: number
}

export interface TodayArchivedTeam {
  id: string
  name: string
}

export interface TodayArchivedAssistant {
  id: string
  name: string
  /** 主会话若还在，行点击可以打开；没有会话就只有名字。 */
  sessionId?: string
}

export interface TodayArchivedThread {
  sessionId: string
  title: string
  /** 这条线程原来属于哪个团队/助手。 */
  source: string
}

/** 已归档区：只读，不提供恢复动作（v1 没有恢复语义）。 */
export interface TodayArchive {
  teams: TodayArchivedTeam[]
  assistants: TodayArchivedAssistant[]
  threads: TodayArchivedThread[]
  total: number
}

export interface TodayModel {
  greeting: string
  waiting: TodayWaiting[]
  running: TodayRunning[]
  upcoming: TodayUpcoming[]
  archived: TodayArchive
  /**
   * 真正等你动手的条数：open 的 escalation、卡住的成员、待处理的助手任务。
   * 未读是被动信息，会计入 `waiting` 但不计入这个数（入口徽标用它）。
   */
  attentionCount: number
  /**
   * 空态标记：等待与接下来用空数组表示「整块不渲染」，在进行用这个布尔让
   * UI 显示一行灰字（两件事的差别在 UI，不在数据）。
   */
  runningEmpty: boolean
}

/** Host schedule catalog 的一行，和自动化面板读的是同一个形状。 */
export interface TodayAutomation {
  id: string
  title: string
  status: 'active' | 'inactive'
  /** 已提交的下一次触发（ISO）；已结束的任务是最后一次。 */
  scheduledAt: string
}

/** 助手侧的两个只读投影，由调用方读过；纯函数只做派生。 */
export interface TodayAssistantInput {
  instances: readonly AssistantInstanceView[]
  tasks: readonly AssistantSession[]
  readState: Readonly<Record<string, number>>
}

export interface TodayInput {
  teams: readonly TeamView[]
  /** 工作区级 escalation 行；调用方已经读过，这里不再请求。 */
  escalations?: readonly Escalation[]
  /** Host schedule catalog；调用方已经读过，这里不再请求。 */
  automations?: readonly TodayAutomation[]
  /** 助手实例与任务；调用方已经读过，这里不再请求。 */
  assistantInstances?: readonly AssistantInstanceView[]
  assistantTasks?: readonly AssistantSession[]
  /** 单聊 read-at 映射（localStorage），未读判定复用侧栏同一份。 */
  assistantReadState?: Readonly<Record<string, number>>
  /** 毫秒时钟，由调用方注入，纯函数不碰 `Date.now()`。 */
  now: number
}

/** 抬头那句话只分三态；0 条走另外两态，绝不拼出「0 件事等你」。 */
export function todayGreeting(waitingCount: number, runningCount: number): string {
  if (waitingCount > 0) return `${waitingCount} 件事等你，其余在按计划跑`
  if (runningCount > 0) return '都在按计划跑'
  return '今天没有等你的事'
}

/** 契约里的另一个名字（greetingLine），同一个实现。 */
export const greetingLine = todayGreeting

const ESCALATION_SUBJECT: Readonly<Record<Escalation['kind'], string>> = {
  approval: '待你确认',
  question: '等你回答',
  blocked_task: '任务被阻塞',
}

/** 未读行不是「等你动手」，徽标与抬头都不数它。 */
export function todayActionableCount(waiting: readonly TodayWaiting[]): number {
  return waiting.reduce((count, row) => (row.kind === 'assistant_unread' ? count : count + 1), 0)
}

function at(iso: string): number | undefined {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** 未来时间（时钟回拨）不产生负时长。 */
function elapsed(now: number, since: number): number {
  return Math.max(0, now - since)
}

function liveTeams(teams: readonly TeamView[]): TeamView[] {
  return teams.filter(team => team.archivedAt === undefined)
}

function isArchivedAssistant(instance: AssistantInstance): boolean {
  return instance.status === 'archived' || instance.archivedAt !== undefined
}

function waitingKey(row: TodayWaiting): string {
  // 团队行按「同一团队 + 同一事项」去重；助手行按实例 + 任务去重，两个同名
  // 任务不会互相吞行。未读行没有任务，用实例 id 即可。
  if (row.assistant !== undefined) {
    return `assistant\u0000${row.assistant.assistantId}\u0000${row.kind}\u0000${row.assistant.taskId ?? ''}`
  }
  return `team\u0000${row.teamId ?? ''}\u0000${row.kind}\u0000${row.subject}`
}

function waitingSource(row: TodayWaiting): string {
  return row.teamId ?? row.assistant?.assistantId ?? ''
}

/**
 * 等你确认：open 的 escalation、成员卡在 `error` 的团队、助手待处理的决定，
 * 以及未读的助手会话（被动信息，只进这一块，不进徽标）。同一来源的同一事项
 * 只留一条（等待久的赢），所以同一行被读两遍或两种来源撞在一起时不会出现两条。
 */
export function todayWaiting(
  teams: readonly TeamView[],
  escalations: readonly Escalation[],
  now: number,
  assistants: TodayAssistantInput = { instances: [], tasks: [], readState: {} },
): TodayWaiting[] {
  const rows = new Map<string, TodayWaiting>()
  const add = (row: TodayWaiting): void => {
    const key = waitingKey(row)
    const prior = rows.get(key)
    if (prior === undefined || row.since < prior.since) rows.set(key, row)
  }

  for (const escalation of escalations) {
    if (escalation.status !== 'open') continue
    add({
      teamId: escalation.teamId,
      teamName: escalation.teamName,
      kind: escalation.kind,
      subject: escalation.summary.trim() || ESCALATION_SUBJECT[escalation.kind],
      since: at(escalation.createdAt) ?? now,
      waitMs: 0,
    })
  }

  for (const team of liveTeams(teams)) {
    // 成员状态没有自己的时间戳，团队的最后更新时间是最近的存证。
    const since = at(team.updatedAt) ?? now
    for (const member of Object.values(team.members)) {
      if (member.lastRuntimeState !== 'error') continue
      add({
        teamId: team.id,
        teamName: team.name,
        kind: 'stuck_member',
        subject: member.lastError?.trim() || member.displayName,
        since,
        waitMs: 0,
      })
    }
  }

  // 助手待处理：needs_input 的 worker 任务（S2 之后才真实可见）。
  const decisions = assistantPendingDecisions(assistants.instances, assistants.tasks)
  const decided = new Set<string>()
  for (const { instance, task } of decisions) {
    decided.add(instance.id)
    const name = assistantInstanceName(instance)
    add({
      teamName: name,
      kind: 'assistant_decision',
      subject: task.title,
      since: at(task.updatedAt) ?? now,
      waitMs: 0,
      assistant: { assistantId: instance.id, name, sessionId: task.sessionId, taskId: task.id },
    })
  }

  // 未读：已读到的时间和侧栏共用一份 localStorage 记录；已有待处理的助手
  // 不再重复显示未读，避免同一个助手上两行。
  for (const instance of assistants.instances) {
    if (isArchivedAssistant(instance) || decided.has(instance.id)) continue
    if (!isAssistantUnread(instance, assistants.readState)) continue
    const preview = instance.preview
    if (preview === undefined) continue
    const name = assistantInstanceName(instance)
    const sessionId = instance.mainSessionId ?? ''
    add({
      teamName: name,
      kind: 'assistant_unread',
      subject: preview.text.trim() || name,
      since: preview.time,
      waitMs: 0,
      // 没有主会话时 sessionId 为空串：行仍然可点（回落到助手设置），
      // 也让去重键能分清两个不同的未读助手。
      assistant: { assistantId: instance.id, name, sessionId },
    })
  }

  return [...rows.values()]
    .map(row => ({ ...row, waitMs: elapsed(now, row.since) }))
    .sort((left, right) => right.waitMs - left.waitMs
      || left.since - right.since
      || waitingSource(left).localeCompare(waitingSource(right))
      || left.kind.localeCompare(right.kind)
      || left.subject.localeCompare(right.subject))
}

/**
 * 在进行：有 `running` 任务或 `running` 成员的团队，一队一行。
 * `waiting_approval` 不算在跑——那是「等你确认」那一块的事。
 */
export function todayRunning(teams: readonly TeamView[], now: number): TodayRunning[] {
  const rows: TodayRunning[] = []
  for (const team of liveTeams(teams)) {
    const task = Object.values(team.tasks)
      .filter(candidate => candidate.status === 'running')
      .sort((left, right) => (at(left.createdAt) ?? 0) - (at(right.createdAt) ?? 0)
        || left.id.localeCompare(right.id))[0]
    const workers = Object.values(team.members)
      .filter(member => member.lastRuntimeState === 'running')
      .sort((left, right) => left.id.localeCompare(right.id))
    if (task === undefined && workers.length === 0) continue
    const since = task === undefined
      ? at(team.updatedAt) ?? now
      : at(task.createdAt) ?? now
    rows.push({
      teamId: team.id,
      teamName: team.name,
      subject: task?.title ?? `${workers[0]?.displayName ?? team.name} 正在执行`,
      since,
      runMs: elapsed(now, since),
    })
  }
  return rows.sort((left, right) => right.runMs - left.runMs
    || left.teamId.localeCompare(right.teamId)
    || left.subject.localeCompare(right.subject))
}

/** 接下来：catalog 里还 active、有可解析的下次触发时间的行，按时间升序。 */
export function todayUpcoming(automations: readonly TodayAutomation[]): TodayUpcoming[] {
  const rows = new Map<string, TodayUpcoming>()
  for (const entry of automations) {
    if (entry.status !== 'active') continue
    const nextAt = at(entry.scheduledAt)
    if (nextAt === undefined) continue
    const prior = rows.get(entry.id)
    if (prior !== undefined && prior.nextAt <= nextAt) continue
    rows.set(entry.id, { id: entry.id, name: entry.title, nextAt })
  }
  return [...rows.values()].sort((left, right) => left.nextAt - right.nextAt
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id))
}

/**
 * 已归档：只有服务端已经归档的东西才出现——draft 团队（只有它们能被归档）、
 * archived 助手、以及两边保留下来但列表不再展示的线程。全部只读。
 */
export function todayArchive(
  teams: readonly TeamView[],
  instances: readonly AssistantInstanceView[] = [],
): TodayArchive {
  const archivedTeams = teams
    .filter(team => team.archivedAt !== undefined)
    .map(team => ({ id: team.id, name: team.name }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))

  const archivedAssistants = instances
    .filter(isArchivedAssistant)
    .map(instance => ({
      id: instance.id,
      name: assistantInstanceName(instance),
      ...(instance.mainSessionId === undefined ? {} : { sessionId: instance.mainSessionId }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))

  const threads: TodayArchivedThread[] = []
  for (const team of teams) {
    for (const thread of Object.values(team.retiredThreads ?? {})) {
      threads.push({ sessionId: thread.sessionId, title: thread.title, source: team.name })
    }
  }
  for (const instance of instances) {
    for (const sessionId of instance.retiredThreadSessionIds ?? []) {
      threads.push({ sessionId, title: '附加会话（已归档）', source: assistantInstanceName(instance) })
    }
  }
  threads.sort((left, right) => left.source.localeCompare(right.source)
    || left.title.localeCompare(right.title)
    || left.sessionId.localeCompare(right.sessionId))

  return {
    teams: archivedTeams,
    assistants: archivedAssistants,
    threads,
    total: archivedTeams.length + archivedAssistants.length + threads.length,
  }
}

export function todayModel(input: TodayInput): TodayModel {
  const waiting = todayWaiting(
    input.teams,
    input.escalations ?? [],
    input.now,
    {
      instances: input.assistantInstances ?? [],
      tasks: input.assistantTasks ?? [],
      readState: input.assistantReadState ?? {},
    },
  )
  const running = todayRunning(input.teams, input.now)
  const upcoming = todayUpcoming(input.automations ?? [])
  return {
    greeting: todayGreeting(todayActionableCount(waiting), running.length),
    waiting,
    running,
    upcoming,
    archived: todayArchive(input.teams, input.assistantInstances ?? []),
    attentionCount: todayActionableCount(waiting),
    runningEmpty: running.length === 0,
  }
}
