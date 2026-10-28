import { useEffect, useState } from 'react'
import {
  IconRefreshOutlineRegular,
  relativeTime,
  type RelativeTimeUnit,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { Escalation } from '../domain/types.js'
import type { TeamView } from '../transport/contracts.js'
import { callAgentTeam, teamLeaderSessionId } from './api.js'
import {
  openAssistantAutomations,
  readAssistantAutomations,
  type AssistantAutomationEntry,
} from './assistant-detail.js'
import { openAssistantSession } from './store.js'
import { todayModel, type TodayModel, type TodayWaiting } from './today-model.js'
import css from './Today.module.css'

/**
 * 「今天」页：抬头一句话回答「要不要动手」，下面三块。这一页只读，打开时拉一次
 * 数据，之后只有顶部的刷新按钮会再拉一次——没有轮询、没有后台任务、没有模型。
 *
 * 数据全部是宿主已有的投影：`team.list`、`escalation.list`、以及自动化面板
 * 已经读过的 schedule catalog。派生逻辑在 `today-model.ts`，这里只负责渲染和
 * 一次读取。
 */

/** The page type this plugin owns on the host's right Sidebar. */
export const TODAY_TAB_ID = 'dsh-team-mode-today'
export const TODAY_TAB_KIND = 'dsh-team-mode-today'
export const TODAY_TAB_TITLE = '今天'

/** Brand ＋ menu → host listener. The menu never calls `openTab` itself. */
export const OPEN_TODAY_EVENT = 'dsh-team-mode:open-today'

/** The services the host listener needs; the host's face, narrowed. */
export interface TodaySidebar {
  mounted: { getSnapshot(): string | undefined }
  openTab(kind: string): void
}

/**
 * Open the today tab. Every write throws while no Session surface is mounted, so
 * the mounted guard runs first and the caller can report the refusal.
 */
export function applyTodayTab(sidebar: TodaySidebar | undefined): boolean {
  if (sidebar === undefined || sidebar.mounted.getSnapshot() === undefined) return false
  try {
    sidebar.openTab(TODAY_TAB_KIND)
    return true
  } catch {
    return false
  }
}

/** The menu's half: no service handle travels through the component tree. */
export function requestToday(): void {
  window.dispatchEvent(new CustomEvent(OPEN_TODAY_EVENT))
}

/**
 * The host's relative-time buckets, in this page's words. Bucketing stays in
 * the primitives (`relativeTime`), so a host change to "how old is old" moves
 * this page with every other surface; only the wording is ours.
 */
const ELAPSED_WORDS: Readonly<Record<RelativeTimeUnit, string>> = {
  now: '刚刚',
  minutes: '分钟',
  hours: '小时',
  days: '天',
  months: '个月',
  years: '年',
}

/** A row's trailing duration; 等待 and 进行 rows share this one formatter. */
function elapsedLabel(at: number, now: number): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now' ? ELAPSED_WORDS.now : `${n} ${ELAPSED_WORDS[unit]}`
}

/** 下次触发：相对日子 + 绝对时刻，和 spec 的例子一致（`明天 09:00`）。 */
function nextRunLabel(nextAt: number, now: number): string {
  const at = new Date(nextAt)
  const hours = at.getHours().toString().padStart(2, '0')
  const minutes = at.getMinutes().toString().padStart(2, '0')
  const clock = `${hours}:${minutes}`
  // Calendar-day distance, not a duration bucket: one day is exactly 86400000 ms
  // once both sides are trimmed to local midnight.
  const days = Math.round((startOfDay(nextAt) - startOfDay(now)) / 86_400_000)
  if (days === 0) return `今天 ${clock}`
  if (days === 1) return `明天 ${clock}`
  return `${at.getMonth() + 1}月${at.getDate()}日 ${clock}`
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** One plain greeting by the clock; the user's own name is not ours to guess. */
function dayGreeting(now: number): string {
  const hour = new Date(now).getHours()
  if (hour < 5) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

const WAITING_KIND_LABELS: Readonly<Record<TodayWaiting['kind'], string>> = {
  approval: '待你确认',
  question: '等你回答',
  blocked_task: '任务被阻塞',
  stuck_member: '成员卡住',
}

interface TodayData {
  teams: readonly TeamView[]
  escalations: readonly Escalation[]
  automations: readonly AssistantAutomationEntry[]
}

/**
 * One read of everything the page needs. The schedule catalog is optional: a
 * deployment without the Schedule Remote has no automations, which is the same
 * shape as "none scheduled" for this page.
 */
async function readToday(): Promise<TodayData> {
  const catalog = readAssistantAutomations()
  const [teams, escalations, automations] = await Promise.all([
    callAgentTeam('team.list'),
    callAgentTeam('escalation.list'),
    catalog === undefined
      ? Promise.resolve<readonly AssistantAutomationEntry[]>([])
      : catalog.catch(() => [] as readonly AssistantAutomationEntry[]),
  ])
  return { teams: teams.items, escalations: escalations.items, automations }
}

/**
 * The pane body: one read on open (and again on 刷新), then the pure model.
 * Effects are keyed by `nonce` only, so switching tabs never re-fetches.
 */
export function TodaySurfaceBody(_props: PropsRuntime<'sidebar.right.pane.tab'>): JSX.Element {
  const [nonce, setNonce] = useState(0)
  const [loaded, setLoaded] = useState<LoadedToday>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    let live = true
    setError(undefined)
    void readToday().then(
      data => {
        if (!live) return
        const now = Date.now()
        setLoaded({
          model: todayModel({
            teams: data.teams,
            escalations: data.escalations,
            automations: data.automations,
            now,
          }),
          teams: new Map(data.teams.map(team => [team.id, team])),
          now,
          hello: dayGreeting(now),
        })
      },
      cause => {
        if (!live) return
        setError(`今天数据加载失败：${cause instanceof Error ? cause.message : String(cause)}`)
      },
    )
    return () => { live = false }
  }, [nonce])

  const openTeamRow = (teamId: string): void => {
    setNotice(undefined)
    const team = loaded?.teams.get(teamId)
    const sessionId = team === undefined ? undefined : teamLeaderSessionId(team)
    if (sessionId === undefined) {
      setNotice('该团队还没有可用的 Leader 会话')
      return
    }
    if (!openAssistantSession(sessionId)) setNotice('暂时打不开团队页：会话界面还没就绪')
  }

  const openUpcomingRow = (): void => {
    setNotice(undefined)
    if (!openAssistantAutomations()) setNotice('没有可用的自动化面板')
  }

  return (
    <TodaySurfacePanel
      {...(loaded === undefined ? {} : { model: loaded.model, hello: loaded.hello })}
      {...(error === undefined ? {} : { error })}
      {...(notice === undefined ? {} : { notice })}
      now={loaded?.now ?? Date.now()}
      loading={loaded === undefined && error === undefined}
      onRefresh={() => { setNonce(value => value + 1) }}
      onOpenTeam={openTeamRow}
      onOpenAutomation={openUpcomingRow}
    />
  )
}

interface LoadedToday {
  model: TodayModel
  /** Every team by id, for the Leader Session a row opens. */
  teams: ReadonlyMap<string, TeamView>
  now: number
  hello: string
}

/**
 * The page itself, pure: given a model it draws the header and three blocks.
 * Empty 等你确认 / 接下来 draw nothing at all; an empty 在进行 draws one grey
 * line, because "nothing is running" is the answer to the page's question.
 */
export function TodaySurfacePanel({
  model,
  hello,
  now,
  loading,
  error,
  notice,
  onRefresh,
  onOpenTeam,
  onOpenAutomation,
}: {
  model?: TodayModel | undefined
  hello?: string | undefined
  /** Milliseconds clock the rows' durations are measured against. */
  now: number
  loading?: boolean | undefined
  error?: string | undefined
  notice?: string | undefined
  onRefresh: () => void
  onOpenTeam: (teamId: string) => void
  onOpenAutomation: () => void
}): JSX.Element {
  // A failed first read leaves the headline empty on purpose: the alert below
  // already says why, and "今天没有等你的事" would be a confident lie.
  const headline = model === undefined && error !== undefined
    ? undefined
    : model?.greeting ?? (loading === true ? '正在读取今天…' : '今天没有等你的事')
  return (
    <div className={css.surface} data-dsh-today>
      <header className={css.header}>
        <div className={css.headerCopy}>
          {hello !== undefined && <p className={css.hello}>{hello}</p>}
          {headline !== undefined && <p className={css.greeting} role="status">{headline}</p>}
        </div>
        <button
          type="button"
          className={css.refresh}
          aria-label="刷新"
          title="刷新"
          disabled={loading}
          onClick={onRefresh}
        >
          <IconRefreshOutlineRegular size={14} />
        </button>
      </header>

      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      {notice !== undefined && <p className={css.notice} role="status">{notice}</p>}

      {model !== undefined && (
        <>
          {model.waiting.length > 0 && (
            <section className={css.block} data-dsh-today-block="waiting">
              <h3 className={css.blockTitle}>
                等你确认
                <span className={css.count}>{model.waiting.length}</span>
              </h3>
              <ul className={css.rows}>
                {model.waiting.map(row => (
                  <li key={`${row.teamId}:${row.kind}:${row.subject}`}>
                    <button
                      type="button"
                      className={css.row}
                      data-dsh-today-row="waiting"
                      title={`${row.teamName} · ${row.subject}`}
                      onClick={() => { onOpenTeam(row.teamId) }}
                    >
                      <span className={css.rowMain}>
                        <span className={css.rowTeam}>{row.teamName}</span>
                        <span className={css.rowSubject}>{row.subject}</span>
                      </span>
                      <span className={css.rowMeta}>
                        {WAITING_KIND_LABELS[row.kind]} · 已等 {elapsedLabel(row.since, now)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={css.block} data-dsh-today-block="running">
            <h3 className={css.blockTitle}>
              在进行
              {model.running.length > 0 && <span className={css.count}>{model.running.length}</span>}
            </h3>
            {model.runningEmpty ? (
              <p className={css.quiet}>现在没有在跑的任务</p>
            ) : (
              <ul className={css.rows}>
                {model.running.map(row => (
                  <li key={`${row.teamId}:${row.subject}`}>
                    <button
                      type="button"
                      className={css.row}
                      data-dsh-today-row="running"
                      title={`${row.teamName} · ${row.subject}`}
                      onClick={() => { onOpenTeam(row.teamId) }}
                    >
                      <span className={css.rowMain}>
                        <span className={css.rowTeam}>{row.teamName}</span>
                        <span className={css.rowSubject}>{row.subject}</span>
                      </span>
                      <span className={css.rowMeta}>已跑 {elapsedLabel(row.since, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {model.upcoming.length > 0 && (
            <section className={css.block} data-dsh-today-block="upcoming">
              <h3 className={css.blockTitle}>
                接下来
                <span className={css.count}>{model.upcoming.length}</span>
              </h3>
              <ul className={css.rows}>
                {model.upcoming.map(row => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={css.row}
                      data-dsh-today-row="upcoming"
                      title={row.name}
                      onClick={onOpenAutomation}
                    >
                      <span className={css.rowMain}>
                        <span className={css.rowSubject}>{row.name}</span>
                      </span>
                      <span className={css.rowMeta}>{nextRunLabel(row.nextAt, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
