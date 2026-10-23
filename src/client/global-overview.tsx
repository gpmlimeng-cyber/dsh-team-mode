import { useCallback, useEffect, useState } from 'react'
import type { AssistantSession } from '../domain/types.js'
import type { AssistantInstanceView, TeamView } from '../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import css from './AgentTeam.module.css'
import {
  filterGlobalOverview,
  globalOverviewModel,
  type GlobalAssistantItem,
  type GlobalFilter,
  type GlobalOverviewModel,
  type GlobalTeamItem,
} from './global-overview-data.js'

const FILTERS: ReadonlyArray<{ value: GlobalFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'attention', label: '需要我' },
  { value: 'running', label: '运行中' },
  { value: 'idle', label: '空闲' },
]

const ASSISTANT_STATUS_LABELS: Record<AssistantInstanceView['status'], string> = {
  idle: '空闲',
  starting: '唤醒中',
  active: '运行中',
  error: '异常',
  archived: '已归档',
}

export interface GlobalOverviewProps {
  readonly teams: readonly TeamView[]
  readonly onOpenTeam: (teamId: string) => void
  /** Opens an Assistant main Session; absent when the host cannot navigate. */
  readonly onOpenAssistant?: ((sessionId: string) => void) | undefined
  /** Team list has not answered yet; unknown is not zero. */
  readonly teamsLoading?: boolean | undefined
  /** Team list failed; unknown is not zero. */
  readonly teamsError?: string | undefined
}

export interface GlobalOverviewPanelProps {
  readonly teams: readonly TeamView[]
  readonly instances: readonly AssistantInstanceView[]
  readonly tasks: readonly AssistantSession[]
  readonly filter: GlobalFilter
  readonly loading?: boolean | undefined
  readonly error?: string | undefined
  readonly teamsLoading?: boolean | undefined
  readonly teamsError?: string | undefined
  readonly onFilterChange?: ((filter: GlobalFilter) => void) | undefined
  readonly onOpenTeam: (teamId: string) => void
  readonly onOpenAssistant?: ((sessionId: string) => void) | undefined
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Host navigation for an Assistant row. The workbench is a full-screen shell
 * overlay, so it must close before the main panel swaps to the target Session;
 * otherwise the Session opens behind the still-visible workbench.
 */
export function openAssistantSession(
  sessionId: string,
  closeWorkbench: () => void,
  openSession: (sessionId: string) => void,
): void {
  closeWorkbench()
  openSession(sessionId)
}

function attentionMeta(item: GlobalTeamItem | GlobalAssistantItem): string {
  if (item.kind === 'team') return `${item.approval} 个待审批`
  const base = `${item.needsInput} 个待输入`
  return item.mainSessionId === undefined ? `${base} · 未创建主会话` : base
}

/** A row is inert when there is no target Session or no host navigation face. */
function assistantDisabled(
  item: GlobalAssistantItem,
  onOpenAssistant: ((sessionId: string) => void) | undefined,
): boolean {
  return item.mainSessionId === undefined || onOpenAssistant === undefined
}

function assistantUnavailableTitle(
  item: GlobalAssistantItem,
  onOpenAssistant: ((sessionId: string) => void) | undefined,
): string | undefined {
  if (item.mainSessionId === undefined) return '未创建主会话'
  if (onOpenAssistant === undefined) return '当前工作台无法跳转'
  return undefined
}

function teamState(item: GlobalTeamItem): string {
  const parts: string[] = []
  if (item.running) parts.push('运行中')
  if (item.approval > 0) parts.push(`${item.approval} 个待审批`)
  if (item.blocked > 0) parts.push(`${item.blocked} 个阻塞`)
  return parts.length === 0 ? '空闲' : parts.join(' · ')
}

function assistantState(item: GlobalAssistantItem): string {
  const status = item.running ? '运行中' : ASSISTANT_STATUS_LABELS[item.status]
  return item.needsInput > 0 ? `${status} · ${item.needsInput} 个待输入` : status
}

function Summary({ model }: { model: GlobalOverviewModel }): JSX.Element {
  return (
    <div className={css.globalOverviewStats} data-overview-region="summary">
      <span className={css.globalOverviewStat} data-count="running">
        <strong>{model.counts.running}</strong> 运行中
      </span>
      <span className={css.globalOverviewStat} data-count="attention">
        <strong>{model.counts.attention}</strong> 需要你
      </span>
      <span className={css.globalOverviewStat} data-count="blocked">
        <strong>{model.counts.blocked}</strong> 阻塞
      </span>
      <span className={css.globalOverviewStat} data-count="idle">
        <strong>{model.counts.idle}</strong> 空闲
      </span>
    </div>
  )
}

function Attention({
  model,
  onOpenTeam,
  onOpenAssistant,
}: {
  model: GlobalOverviewModel
  onOpenTeam: (teamId: string) => void
  onOpenAssistant: ((sessionId: string) => void) | undefined
}): JSX.Element {
  return (
    <section className={css.globalOverviewAttention} aria-label="需要你" data-overview-region="attention">
      <h3 className={css.globalOverviewSectionTitle}>
        需要你
        <span className={css.globalOverviewSectionMeta}>{model.attention.length} 项</span>
      </h3>
      {model.attention.length === 0
        ? <p className={css.globalOverviewEmpty}>当前没有需要你处理的事项</p>
        : <ul className={css.globalOverviewAttentionList}>
            {model.attention.map(item => item.kind === 'team'
              ? (
                <li key={`team:${item.id}`}>
                  <button
                    type="button"
                    className={css.globalOverviewAttentionRow}
                    data-attention-team-id={item.id}
                    onClick={() => { onOpenTeam(item.id) }}
                  >
                    <span className={css.globalOverviewAttentionName}>{item.name}</span>
                    <span className={css.globalOverviewAttentionMeta}>{attentionMeta(item)}</span>
                  </button>
                </li>
                )
              : (
                <li key={`assistant:${item.id}`}>
                  <button
                    type="button"
                    className={css.globalOverviewAttentionRow}
                    data-attention-assistant-id={item.id}
                    disabled={assistantDisabled(item, onOpenAssistant)}
                    title={assistantUnavailableTitle(item, onOpenAssistant)}
                    onClick={() => {
                      const sessionId = item.mainSessionId
                      if (sessionId !== undefined && onOpenAssistant !== undefined) onOpenAssistant(sessionId)
                    }}
                  >
                    <span className={css.globalOverviewAttentionName}>{item.name}</span>
                    <span className={css.globalOverviewAttentionMeta}>{attentionMeta(item)}</span>
                  </button>
                </li>
                ))}
          </ul>}
    </section>
  )
}

function TeamRow({
  item,
  onOpenTeam,
}: {
  item: GlobalTeamItem
  onOpenTeam: (teamId: string) => void
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={css.globalOverviewRow}
        data-team-id={item.id}
        onClick={() => { onOpenTeam(item.id) }}
      >
        <span className={css.globalOverviewRowMain}>
          <strong className={css.globalOverviewRowName}>{item.name}</strong>
          <span className={css.globalOverviewRowMeta}>
            Leader {item.leaderName === '' ? '未设置' : item.leaderName} · {item.members} 名成员
          </span>
        </span>
        <span className={css.globalOverviewRowState}>{teamState(item)}</span>
      </button>
    </li>
  )
}

function AssistantRow({
  item,
  onOpenAssistant,
}: {
  item: GlobalAssistantItem
  onOpenAssistant: ((sessionId: string) => void) | undefined
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={css.globalOverviewRow}
        data-assistant-id={item.id}
        disabled={assistantDisabled(item, onOpenAssistant)}
        title={assistantUnavailableTitle(item, onOpenAssistant)}
        onClick={() => {
          const sessionId = item.mainSessionId
          if (sessionId !== undefined && onOpenAssistant !== undefined) onOpenAssistant(sessionId)
        }}
      >
        <span className={css.globalOverviewRowMain}>
          <strong className={css.globalOverviewRowName}>{item.name}</strong>
          <span className={css.globalOverviewRowMeta}>
            {item.model} · {item.tasks} 个任务{item.mainSessionId === undefined ? ' · 未创建主会话' : ''}
          </span>
        </span>
        <span className={css.globalOverviewRowState}>{assistantState(item)}</span>
      </button>
    </li>
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
 * Presentational overview: every number comes from the pure model built over the
 * props, and the filter only narrows rows. Loading never renders zeros, because
 * an unanswered request is not the same fact as an empty workspace.
 */
export function GlobalOverviewPanel({
  teams,
  instances,
  tasks,
  filter,
  loading = false,
  error,
  teamsLoading,
  teamsError,
  onFilterChange,
  onOpenTeam,
  onOpenAssistant,
}: GlobalOverviewPanelProps): JSX.Element {
  if (teamsLoading === true) return <StatusCard tone="loading" message="正在加载团队和助手…" />
  if (teamsError !== undefined) return <StatusCard tone="error" message={`团队数据加载失败：${teamsError}`} />
  if (loading) return <StatusCard tone="loading" message="正在加载助手和任务…" />
  if (error !== undefined && instances.length === 0 && tasks.length === 0) {
    return <StatusCard tone="error" message={error} />
  }

  const model = globalOverviewModel({ teams, instances, tasks })
  const visible = filterGlobalOverview(model, filter)
  const nothingAtAll = model.teams.length === 0 && model.assistants.length === 0
  const nothingVisible = visible.teams.length === 0 && visible.assistants.length === 0

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
      <Attention model={model} onOpenTeam={onOpenTeam} onOpenAssistant={onOpenAssistant} />

      <div className={css.globalOverviewFilters} role="group" aria-label="筛选" data-overview-region="filters">
        {FILTERS.map(entry => (
          <button
            key={entry.value}
            type="button"
            className={css.globalOverviewFilter}
            aria-pressed={filter === entry.value}
            onClick={() => { onFilterChange?.(entry.value) }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {nothingAtAll
        ? <p className={css.globalOverviewEmpty}>还没有团队或助手，先创建成员模板或团队。</p>
        : nothingVisible
          ? (
            <div className={css.globalOverviewFilterEmpty} data-overview-region="filter-empty">
              <p className={css.globalOverviewEmpty}>当前筛选下没有团队或助手</p>
              {filter !== 'all' && (
                <button
                  type="button"
                  className={css.globalOverviewClearButton}
                  onClick={() => { onFilterChange?.('all') }}
                >
                  查看全部
                </button>
              )}
            </div>
            )
          : (
            <div className={css.globalOverviewColumns}>
              <section className={css.globalOverviewColumn} aria-label="团队" data-overview-region="teams">
                <h3 className={css.globalOverviewSectionTitle}>
                  团队
                  <span className={css.globalOverviewSectionMeta}>{visible.teams.length}</span>
                </h3>
                {visible.teams.length === 0
                  ? <p className={css.globalOverviewEmpty}>{filter === 'all' ? '还没有团队' : '当前筛选下没有团队'}</p>
                  : <ul className={css.globalOverviewRows}>
                      {visible.teams.map(item => (
                        <TeamRow key={item.id} item={item} onOpenTeam={onOpenTeam} />
                      ))}
                    </ul>}
              </section>

              <section className={css.globalOverviewColumn} aria-label="助手" data-overview-region="assistants">
                <h3 className={css.globalOverviewSectionTitle}>
                  助手
                  <span className={css.globalOverviewSectionMeta}>{visible.assistants.length}</span>
                </h3>
                {visible.assistants.length === 0
                  ? <p className={css.globalOverviewEmpty}>{filter === 'all' ? '还没有助手' : '当前筛选下没有助手'}</p>
                  : <ul className={css.globalOverviewRows}>
                      {visible.assistants.map(item => (
                        <AssistantRow key={item.id} item={item} onOpenAssistant={onOpenAssistant} />
                      ))}
                    </ul>}
              </section>
            </div>
            )}
    </section>
  )
}

/**
 * Read-only container: the only network calls are the two existing list calls.
 * It owns the filter state; a failed refresh keeps the last good rows and says so.
 */
export function GlobalOverview({
  teams,
  onOpenTeam,
  onOpenAssistant,
  teamsLoading,
  teamsError,
}: GlobalOverviewProps): JSX.Element {
  const [instances, setInstances] = useState<AssistantInstanceView[]>()
  const [tasks, setTasks] = useState<AssistantSession[]>()
  const [error, setError] = useState<string>()
  const [filter, setFilter] = useState<GlobalFilter>('all')

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
      filter={filter}
      {...(teamsLoading === undefined ? {} : { teamsLoading })}
      {...(teamsError === undefined ? {} : { teamsError })}
      loading={error === undefined && (instances === undefined || tasks === undefined)}
      {...(error === undefined ? {} : { error })}
      onFilterChange={setFilter}
      onOpenTeam={onOpenTeam}
      {...(onOpenAssistant === undefined ? {} : { onOpenAssistant })}
    />
  )
}
