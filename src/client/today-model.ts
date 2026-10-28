import type { Escalation } from '../domain/types.js'
import type { TeamView } from '../transport/contracts.js'

/**
 * 「今天」首页的数据层：纯派生，不发请求、不读时钟、不格式化时间。
 *
 * 输入全部是页面已经读到的只读投影（`team.list` 的 TeamView、侧栏的
 * `escalation.list` 行、自动化面板的 schedule catalog），所以这个文件只做
 * 「把已有的东西排成三块」。所有时间是毫秒时间戳，相对时长由 UI 用自己
 * 的 now 格式化——纯函数里做相对时间就没法测了。
 */

export interface TodayWaiting {
  teamId: string
  teamName: string
  kind: 'approval' | 'question' | 'blocked_task' | 'stuck_member'
  subject: string
  /** 这条事项开始等你时的毫秒时间戳。 */
  since: number
  waitMs: number
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

export interface TodayModel {
  greeting: string
  waiting: TodayWaiting[]
  running: TodayRunning[]
  upcoming: TodayUpcoming[]
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

export interface TodayInput {
  teams: readonly TeamView[]
  /** 工作区级 escalation 行；调用方已经读过，这里不再请求。 */
  escalations?: readonly Escalation[]
  /** Host schedule catalog；调用方已经读过，这里不再请求。 */
  automations?: readonly TodayAutomation[]
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

/**
 * 等你确认：open 的 escalation，加上成员卡在 `error` 的团队。
 * 同一团队的同一事项只留一条（等待久的赢），所以同一行被读两遍或两种来源
 * 撞在一起时不会出现两条。
 */
export function todayWaiting(
  teams: readonly TeamView[],
  escalations: readonly Escalation[],
  now: number,
): TodayWaiting[] {
  const rows = new Map<string, TodayWaiting>()
  const add = (row: TodayWaiting): void => {
    const key = `${row.teamId}\u0000${row.kind}\u0000${row.subject}`
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

  return [...rows.values()]
    .map(row => ({ ...row, waitMs: elapsed(now, row.since) }))
    .sort((left, right) => right.waitMs - left.waitMs
      || left.since - right.since
      || left.teamId.localeCompare(right.teamId)
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

export function todayModel(input: TodayInput): TodayModel {
  const waiting = todayWaiting(input.teams, input.escalations ?? [], input.now)
  const running = todayRunning(input.teams, input.now)
  const upcoming = todayUpcoming(input.automations ?? [])
  return {
    greeting: todayGreeting(waiting.length, running.length),
    waiting,
    running,
    upcoming,
    runningEmpty: running.length === 0,
  }
}
