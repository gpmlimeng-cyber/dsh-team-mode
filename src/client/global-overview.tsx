import { useCallback, useEffect, useState } from 'react'
import type { AssistantSession } from '../domain/types.js'
import type { AssistantInstanceView, TeamView } from '../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import css from './AgentTeam.module.css'
import { globalOverviewModel, type GlobalOverviewModel } from './global-overview-data.js'
import { assistantReadState } from './assistant-read-state.js'

/** One short explanation per count, so a number never reads as another number. */
const STAT_TITLES: Readonly<Record<keyof GlobalOverviewModel['counts'], string>> = {
  teams: '非归档团队数',
  assistants: '非归档助手数',
  running: '有活动：运行中的成员或任务，含停在审批的成员',
  attention: '需要你：待审批的成员 + 待输入的助手任务',
  blocked: '等待前置：未结束、仍被前置任务挡住的任务所在实体',
  error: '异常：团队、成员、启动或助手实例',
  unread: '未读：有未读消息的助手',
  idle: '空闲：既没有活动也没有待处理',
}

export interface GlobalOverviewProps {
  readonly teams: readonly TeamView[]
  /** Team list has not answered yet; unknown is not zero. */
  readonly teamsLoading?: boolean | undefined
  /** Team list failed; unknown is not zero. */
  readonly teamsError?: string | undefined
  /** Opens the 今天 page, where the waiting lists live. */
  readonly onOpenToday: () => void
}

export interface GlobalOverviewPanelProps {
  readonly teams: readonly TeamView[]
  readonly instances: readonly AssistantInstanceView[]
  readonly tasks: readonly AssistantSession[]
  readonly loading?: boolean | undefined
  readonly error?: string | undefined
  /** Assistant read-at snapshot; absent means nothing is known to be read. */
  readonly readState?: Readonly<Record<string, number>> | undefined
  readonly teamsLoading?: boolean | undefined
  readonly teamsError?: string | undefined
  readonly onOpenToday: () => void
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function Summary({ model }: { model: GlobalOverviewModel }): JSX.Element {
  const stats: ReadonlyArray<{ key: 'running' | 'attention' | 'blocked' | 'error' | 'unread' | 'idle'; label: string }> = [
    { key: 'running', label: '有活动' },
    { key: 'attention', label: '需要你' },
    { key: 'blocked', label: '等待前置' },
    { key: 'error', label: '异常' },
    { key: 'unread', label: '未读' },
    { key: 'idle', label: '空闲' },
  ]
  return (
    <div className={css.globalOverviewStats} data-overview-region="summary">
      {stats.map(stat => (
        <span
          key={stat.key}
          className={css.globalOverviewStat}
          data-count={stat.key}
          title={STAT_TITLES[stat.key]}
        >
          <strong>{model.counts[stat.key]}</strong> {stat.label}
        </span>
      ))}
    </div>
  )
}

/** One panel shell for a state where the numbers are not known yet. */
function StatusCard({ tone, message }: { tone: 'loading' | 'error', message: string }): JSX.Element {
  return (
    <section className={css.globalOverview} aria-label="全局总览" data-overview-region="global-overview">
      <header className={css.globalOverviewHeader}>
        <h2 className={css.globalOverviewTitle}>全局总览</h2>
      </header>
      <p
        className={tone === 'loading' ? css.globalOverviewLoading : css.globalOverviewError}
        role={tone === 'loading' ? 'status' : 'alert'}
      >
        {message}
      </p>
    </section>
  )
}

/**
 * The facts-only overview: the header counts, the six summary numbers and one
 * line pointing at 今天. The per-entity lists live in the sidebar and 今天, so
 * this surface never repeats them — and never invents a zero for an unanswered
 * request.
 */
export function GlobalOverviewPanel({
  teams,
  instances,
  tasks,
  loading = false,
  error,
  readState,
  teamsLoading,
  teamsError,
  onOpenToday,
}: GlobalOverviewPanelProps): JSX.Element {
  if (teamsLoading === true) return <StatusCard tone="loading" message="正在加载团队和助手…" />
  if (teamsError !== undefined) return <StatusCard tone="error" message={`团队数据加载失败：${teamsError}`} />
  if (loading) return <StatusCard tone="loading" message="正在加载助手和任务…" />
  if (error !== undefined && instances.length === 0 && tasks.length === 0) {
    return <StatusCard tone="error" message={error} />
  }

  const model = globalOverviewModel({ teams, instances, tasks, ...(readState === undefined ? {} : { readState }) })

  return (
    <section className={css.globalOverview} aria-label="全局总览" data-overview-region="global-overview">
      <header className={css.globalOverviewHeader}>
        <h2 className={css.globalOverviewTitle}>全局总览</h2>
        <span className={css.globalOverviewCount} data-overview-count>
          {model.counts.teams} 个团队 · {model.counts.assistants} 个助手
        </span>
      </header>

      {error !== undefined && <p className={css.globalOverviewError} role="alert">{error}</p>}

      <Summary model={model} />

      <p className={css.globalOverviewNeeds} data-overview-region="needs-you">
        <strong className={css.globalOverviewNeedsCount}>{model.counts.attention}</strong> 项需要你
        <button
          type="button"
          className={css.globalOverviewNeedsAction}
          onClick={onOpenToday}
        >
          打开今天
        </button>
      </p>
    </section>
  )
}

/**
 * Read-only container: the only network calls are the two existing list calls.
 * A failed refresh keeps the last good numbers and says so; unknown never
 * renders as zero.
 */
export function GlobalOverview({
  teams,
  teamsLoading,
  teamsError,
  onOpenToday,
}: GlobalOverviewProps): JSX.Element {
  const [instances, setInstances] = useState<AssistantInstanceView[]>()
  const [tasks, setTasks] = useState<AssistantSession[]>()
  const [error, setError] = useState<string>()
  // Presentation state, read on each render: the overview never owns a second
  // copy of the read markers and never asks the host for them.
  const readSnapshot = assistantReadState()

  const load = useCallback(async (): Promise<void> => {
    try {
      const [instancePage, taskPage] = await Promise.all([
        callAgentTeam('assistant.instance.list'),
        callAgentTeam('assistant.task.list', undefined),
      ])
      setInstances(instancePage.items)
      setTasks(taskPage.items)
      setError(undefined)
    } catch (cause) {
      setError(`助手数据加载失败：${messageOf(cause)}`)
    }
  }, [])

  useEffect(() => {
    void load()
    return subscribeAgentTeam(
      () => { void load() },
      () => { setError('助手数据连接已断开，正在重连') },
      () => { void load() },
    )
  }, [load])

  return (
    <GlobalOverviewPanel
      teams={teams}
      instances={instances ?? []}
      tasks={tasks ?? []}
      readState={readSnapshot}
      {...(teamsLoading === undefined ? {} : { teamsLoading })}
      {...(teamsError === undefined ? {} : { teamsError })}
      loading={error === undefined && (instances === undefined || tasks === undefined)}
      {...(error === undefined ? {} : { error })}
      onOpenToday={onOpenToday}
    />
  )
}
