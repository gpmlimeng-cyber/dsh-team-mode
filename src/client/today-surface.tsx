import { useEffect, useState } from 'react'
import {
  IconRefreshOutlineRegular,
  relativeTime,
  type RelativeTimeUnit,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { AssistantSession, Escalation } from '../domain/types.js'
import type { AssistantInstanceView, TeamView } from '../transport/contracts.js'
import { callAgentTeam, teamLeaderSessionId } from './api.js'
import {
  openAssistantAutomations,
  readAssistantAutomations,
  type AssistantAutomationEntry,
} from './assistant-detail.js'
import { assistantReadState, markAssistantRead } from './assistant-read-state.js'
import { OPEN_ASSISTANT_SETTINGS_EVENT } from './assistant-settings-pane.js'
import { openAssistantMainSession, openAssistantSession, openManageTeamDialog } from './store.js'
import { readSurfaceMode, type SurfaceMode } from './surface-mode.js'
import {
  todayActionableCount,
  todayModel,
  todayWaiting,
  type TodayArchivedAssistant,
  type TodayModel,
  type TodayRunning,
  type TodayWaiting,
} from './today-model.js'
import css from './Today.module.css'

/**
 * 「今天」页：抬头一句话回答「要不要动手」，下面几块，末尾一个默认折叠的
 * 「已归档」。这一页只读，打开时拉一次数据，之后只有顶部的刷新按钮会再拉一次
 * ——没有轮询、没有后台任务、没有模型。
 *
 * 数据全部是宿主已有的投影：`team.list`、`escalation.list`、
 * `assistant.instance.list`、`assistant.task.list`，加上自动化面板已经读过的
 * schedule catalog 和侧栏共用的一份 read-at。派生逻辑在 `today-model.ts`，
 * 这里只负责渲染和一次读取。
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

/** The archived-team row's answer outside team mode: a visible line, not silence. */
export const ARCHIVED_TEAM_MODE_NOTICE = '已归档团队需在团队模式打开管理'

export interface ArchivedTeamNavigation {
  mode: SurfaceMode
  openManageTeam: (teamId: string) => void
  notice: (message: string) => void
}

/**
 * The manage dialog is mounted by the team-mode host only, so a native-mode
 * click must say why nothing opened instead of calling a writer whose UI is
 * absent. Team mode keeps the original one-click path.
 */
export function openArchivedTeam(
  teamId: string,
  navigation: ArchivedTeamNavigation,
): boolean {
  if (navigation.mode !== 'team') {
    navigation.notice(ARCHIVED_TEAM_MODE_NOTICE)
    return false
  }
  navigation.openManageTeam(teamId)
  return true
}

export interface WaitingRowNavigation {
  /** 未读助手行先记已读，侧栏的点随后消失。 */
  markRead: (assistantId: string) => void
  openAssistant: (sessionId: string, assistantId?: string) => void
  openTeam: (teamId: string) => void
}

/** One 等你确认 row: mark an unread assistant read first, then navigate by target. */
export function openWaitingRow(row: TodayWaiting, navigation: WaitingRowNavigation): void {
  if (row.assistant !== undefined) {
    if (row.kind === 'assistant_unread') navigation.markRead(row.assistant.assistantId)
    navigation.openAssistant(row.assistant.sessionId, row.assistant.assistantId)
    return
  }
  if (row.teamId !== undefined) navigation.openTeam(row.teamId)
}

export interface RunningRowNavigation {
  openAssistant: (sessionId: string, assistantId?: string) => void
  openTeam: (teamId: string) => void
}

export interface UnreadAssistantNavigation {
  markRead: (assistantId: string) => void
  /**
   * Ensure→open the canonical main Session. It receives the pre-ensure bound
   * fact from the row, never the row's stored session id: a raw mainSessionId
   * can resume the Agent outside the assistant lifecycle.
   */
  openCanonical: (assistantId: string, wasBound: boolean) => void
}

/**
 * The unread row is a door to the coworker relationship, so it ensures the main
 * Session instead of opening the stored id. Decision rows keep opening their
 * task Session raw — that is the worker conversation, not the main chat.
 */
export function openUnreadAssistantRow(
  row: TodayWaiting,
  navigation: UnreadAssistantNavigation,
): boolean {
  if (row.kind !== 'assistant_unread' || row.assistant === undefined) return false
  navigation.markRead(row.assistant.assistantId)
  navigation.openCanonical(row.assistant.assistantId, row.assistant.sessionId !== '')
  return true
}

/**
 * One 在进行 row: a team row opens its Leader Session, a coworker row opens the
 * task Session it is running (or the first queued one). Nothing writes.
 */
export function openRunningRow(row: TodayRunning, navigation: RunningRowNavigation): void {
  if (row.assistant !== undefined) {
    navigation.openAssistant(row.assistant.sessionId, row.assistant.assistantId)
    return
  }
  if (row.teamId !== undefined) navigation.openTeam(row.teamId)
}

/**
 * One waiting row's React key. Assistant rows key by taskId (unread rows have
 * none), so two same-titled tasks of one assistant never collapse into a
 * duplicate key; team rows keep their existing team/kind/subject identity.
 */
export function todayRowKey(row: TodayWaiting): string {
  const source = row.teamId ?? row.assistant?.assistantId ?? ''
  const identity = row.assistant?.taskId ?? row.subject
  return `${source}:${row.kind}:${identity}`
}

/**
 * The host's relative-time buckets, in this page's words. Bucketing stays in
 * the primitives (`relativeTime`), so a host change to "how old is old" moves
 * this page with every other surface; only the wording is ours.
 */
const ELAPSED_WORDS: Readonly<Record<RelativeTimeUnit, string>> = {
  // Read after 已等 / 已跑, so it cannot be the adverb 刚刚 ("已等 刚刚");
  // it names the span instead.
  now: '不到 1 分钟',
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
  assistant_decision: '助手待你处理',
  assistant_unread: '未读',
}

interface TodayAttentionReads {
  teams: readonly TeamView[]
  escalations: readonly Escalation[]
  instances: readonly AssistantInstanceView[]
  tasks: readonly AssistantSession[]
  readState: Readonly<Record<string, number>>
}

interface TodayData extends TodayAttentionReads {
  automations: readonly AssistantAutomationEntry[]
}

/** 入口计数只读这四份投影；页面再加 automation catalog 与 read-at。 */
async function readAttention(): Promise<TodayAttentionReads> {
  const [teams, escalations, instances, tasks] = await Promise.all([
    callAgentTeam('team.list'),
    callAgentTeam('escalation.list'),
    callAgentTeam('assistant.instance.list'),
    callAgentTeam('assistant.task.list', undefined),
  ])
  return {
    teams: teams.items,
    escalations: escalations.items,
    instances: instances.items,
    tasks: tasks.items,
    readState: assistantReadState(),
  }
}

/**
 * One read of everything the page needs. The schedule catalog is optional: a
 * deployment without the Schedule Remote has no automations, which is the same
 * shape as "none scheduled" for this page.
 */
async function readToday(): Promise<TodayData> {
  const catalog = readAssistantAutomations()
  const [attention, automations] = await Promise.all([
    readAttention(),
    catalog === undefined
      ? Promise.resolve<readonly AssistantAutomationEntry[]>([])
      : catalog.catch(() => [] as readonly AssistantAutomationEntry[]),
  ])
  return { ...attention, automations }
}

/**
 * The footer entry's count: the same truthful waiting rows the page draws,
 * reduced to the ones that actually want an action. Unread assistants are
 * passive and never inflate it; archived things never count.
 */
export async function readTodayAttentionCount(): Promise<number> {
  const data = await readAttention()
  return todayActionableCount(todayWaiting(data.teams, data.escalations, Date.now(), {
    instances: data.instances,
    tasks: data.tasks,
    readState: data.readState,
  }))
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
            assistantInstances: data.instances,
            assistantTasks: data.tasks,
            assistantReadState: data.readState,
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

  /** Open a retained Session; a nameless target falls back to 助手设置. */
  const openSessionOrAssistant = (sessionId: string | undefined, assistantId?: string): void => {
    setNotice(undefined)
    if (sessionId !== undefined && sessionId !== '' && openAssistantSession(sessionId)) return
    if (assistantId !== undefined) {
      window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_SETTINGS_EVENT, {
        detail: { assistantId },
      }))
      return
    }
    setNotice('暂时打不开这个会话：会话界面还没就绪')
  }

  /** One canonical coworker-chat open: ensure first, then navigate. */
  const openAssistantCanonical = (assistantId: string, wasBound: boolean): void => {
    setNotice(undefined)
    void openAssistantMainSession(assistantId, sessionId => {
      openSessionOrAssistant(sessionId, assistantId)
    }, { bound: wasBound }).then(
      outcome => { if (outcome.notice !== undefined) setNotice(outcome.notice) },
      cause => {
        setNotice(`打开助手失败：${cause instanceof Error ? cause.message : String(cause)}`)
      },
    )
  }

  const openWaitingRowAction = (row: TodayWaiting): void => {
    setNotice(undefined)
    if (openUnreadAssistantRow(row, {
      markRead: assistantId => { markAssistantRead(assistantId) },
      openCanonical: openAssistantCanonical,
    })) return
    openWaitingRow(row, {
      markRead: assistantId => { markAssistantRead(assistantId) },
      openAssistant: (sessionId, assistantId) => { openSessionOrAssistant(sessionId, assistantId) },
      openTeam: openTeamRow,
    })
  }

  const openRunningRowAction = (row: TodayRunning): void => {
    setNotice(undefined)
    openRunningRow(row, {
      openAssistant: (sessionId, assistantId) => { openSessionOrAssistant(sessionId, assistantId) },
      openTeam: openTeamRow,
    })
  }

  const openArchivedTeamRow = (teamId: string): void => {
    setNotice(undefined)
    openArchivedTeam(teamId, {
      mode: readSurfaceMode(window.localStorage),
      openManageTeam: openManageTeamDialog,
      notice: setNotice,
    })
  }

  const openArchivedAssistant = (assistant: TodayArchivedAssistant): void => {
    openSessionOrAssistant(assistant.sessionId, assistant.id)
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
      onOpenWaiting={openWaitingRowAction}
      onOpenRunning={openRunningRowAction}
      onOpenAutomation={openUpcomingRow}
      onOpenArchivedTeam={openArchivedTeamRow}
      onOpenArchivedAssistant={openArchivedAssistant}
      onOpenThread={sessionId => { openSessionOrAssistant(sessionId) }}
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
 * The page itself, pure: given a model it draws the header, the waiting/
 * running/upcoming blocks, then the folded 已归档 block. Empty 等你确认 /
 * 接下来 / 已归档 draw nothing at all; an empty 在进行 draws one grey line,
 * because "nothing is running" is the answer to the page's question.
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
  onOpenWaiting,
  onOpenRunning,
  onOpenAutomation,
  onOpenArchivedTeam,
  onOpenArchivedAssistant,
  onOpenThread,
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
  onOpenWaiting: (row: TodayWaiting) => void
  /** Optional so a caller without the navigation still renders every row. */
  onOpenRunning?: ((row: TodayRunning) => void) | undefined
  onOpenAutomation: () => void
  onOpenArchivedTeam: (teamId: string) => void
  onOpenArchivedAssistant: (assistant: TodayArchivedAssistant) => void
  onOpenThread: (sessionId: string) => void
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
                {/* Actionable only: unread rows are passive and never inflate it. */}
                {model.attentionCount > 0 && (
                  <span className={css.count}>{model.attentionCount}</span>
                )}
              </h3>
              {/* Grouped per coworker/team. The group header reuses the page's
                  existing nested-list primitives (the same ones 已归档 uses), so
                  this stays inside Today.module.css's one type scale. */}
              {model.waitingGroups.map(group => (
                <div
                  key={`${group.kind}:${group.key}`}
                  className={css.archiveGroup}
                  data-dsh-today-group={group.kind}
                >
                  <h4 className={css.archiveGroupTitle}>
                    <span title={group.name}>{group.name}</span>
                    {/* The pill counts only what wants an action; unread is passive. */}
                    {group.actionable > 0 && (
                      <span className={css.count}>{group.actionable}</span>
                    )}
                    {group.unread > 0 && (
                      <span className={css.archiveHint}>未读 {group.unread}</span>
                    )}
                  </h4>
                  <ul className={css.rows}>
                    {group.rows.map(row => (
                      <li key={todayRowKey(row)}>
                        <button
                          type="button"
                          className={css.row}
                          data-dsh-today-row="waiting"
                          title={`${row.teamName} · ${row.subject}`}
                          onClick={() => { onOpenWaiting(row) }}
                        >
                          <span className={css.rowMain}>
                            <span className={css.rowSubject}>{row.subject}</span>
                          </span>
                          <span className={css.rowMeta}>
                            {row.kind === 'assistant_unread'
                              ? `未读 · ${elapsedLabel(row.since, now)}前`
                              : `${WAITING_KIND_LABELS[row.kind]} · 已等 ${elapsedLabel(row.since, now)}`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
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
                {model.running.map(row => {
                  const source = row.teamId ?? row.assistant?.assistantId ?? ''
                  return (
                    <li key={`${source}:${row.subject}`}>
                      <button
                        type="button"
                        className={css.row}
                        data-dsh-today-row="running"
                        data-dsh-today-running={row.assistant === undefined ? 'team' : 'assistant'}
                        title={`${row.teamName} · ${row.subject}`}
                        onClick={() => {
                          if (row.assistant === undefined) onOpenTeam(row.teamId ?? '')
                          else if (onOpenRunning !== undefined) onOpenRunning(row)
                          else onOpenTeam(row.teamId ?? '')
                        }}
                      >
                        <span className={css.rowMain}>
                          <span className={css.rowTeam}>{row.teamName}</span>
                          <span className={css.rowSubject}>{row.subject}</span>
                        </span>
                        <span className={css.rowMeta}>已跑 {elapsedLabel(row.since, now)}</span>
                      </button>
                    </li>
                  )
                })}
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

          {model.archived.total > 0 && (
            <details className={css.archive} data-dsh-today-block="archived">
              <summary className={css.archiveSummary}>
                <span>已归档</span>
                <span className={css.count}>{model.archived.total}</span>
                <span className={css.archiveHint}>只读</span>
              </summary>
              <p className={css.archiveNote}>仅查看，暂不支持恢复</p>
              {model.archived.teams.length > 0 && (
                <div className={css.archiveGroup}>
                  <h4 className={css.archiveGroupTitle}>团队</h4>
                  <ul className={css.rows}>
                    {model.archived.teams.map(team => (
                      <li key={team.id}>
                        <button
                          type="button"
                          className={css.row}
                          data-dsh-today-row="archived-team"
                          title={`${team.name} · 打开团队管理`}
                          onClick={() => { onOpenArchivedTeam(team.id) }}
                        >
                          <span className={css.rowMain}>
                            <span className={css.rowSubject}>{team.name}</span>
                          </span>
                          <span className={css.rowMeta}>草稿团队 · 打开管理</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {model.archived.assistants.length > 0 && (
                <div className={css.archiveGroup}>
                  <h4 className={css.archiveGroupTitle}>助手</h4>
                  <ul className={css.rows}>
                    {model.archived.assistants.map(assistant => (
                      <li key={assistant.id}>
                        <button
                          type="button"
                          className={css.row}
                          data-dsh-today-row="archived-assistant"
                          title={assistant.name}
                          onClick={() => { onOpenArchivedAssistant(assistant) }}
                        >
                          <span className={css.rowMain}>
                            <span className={css.rowSubject}>{assistant.name}</span>
                          </span>
                          <span className={css.rowMeta}>
                            {assistant.sessionId === undefined ? '已归档' : '已归档 · 打开会话'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {model.archived.threads.length > 0 && (
                <div className={css.archiveGroup}>
                  <h4 className={css.archiveGroupTitle}>线程</h4>
                  <ul className={css.rows}>
                    {model.archived.threads.map(thread => (
                      <li key={`${thread.source}:${thread.sessionId}`}>
                        <button
                          type="button"
                          className={css.row}
                          data-dsh-today-row="archived-thread"
                          title={`${thread.source} · ${thread.title}`}
                          onClick={() => { onOpenThread(thread.sessionId) }}
                        >
                          <span className={css.rowMain}>
                            <span className={css.rowTeam}>{thread.source}</span>
                            <span className={css.rowSubject}>{thread.title}</span>
                          </span>
                          <span className={css.rowMeta}>已归档</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </details>
          )}
        </>
      )}
    </div>
  )
}
