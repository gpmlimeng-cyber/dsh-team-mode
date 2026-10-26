import { useState, type CSSProperties } from 'react'
import css from './AgentTeam.module.css'
import {
  TEAM_TASK_CREATE_HINT,
  taskCarriesVerdict,
  taskKindLabel,
  taskScheduleEntries,
  taskVerdictLabel,
  taskVerdictTone,
} from './labels.js'
import { dependencyGraph, leaderInbox, pickOverviewTask } from './team-overview-data.js'
import type { TeamMemberSlot, TeamMessage, TeamTask } from '../domain/types.js'
import type { TeamView } from '../transport/contracts.js'

type Tone = 'neutral' | 'business' | 'success' | 'warn' | 'danger'

const INBOX_LIMIT = 5
const PREVIEW_CHARS = 120

const TASK_STATUS_LABELS: Record<TeamTask['status'], string> = {
  pending: '待处理',
  assigned: '已分配',
  running: '进行中',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const MEMBER_STATE_LABELS: Record<TeamMemberSlot['lastRuntimeState'], string> = {
  offline: '离线',
  starting: '唤醒中',
  idle: '空闲',
  running: '执行中',
  waiting_approval: '待审批',
  error: '异常',
}

const MESSAGE_TYPE_LABELS: Record<TeamMessage['type'], string> = {
  instruction: '指令',
  progress: '进展',
  result: '结果',
  question: '提问',
  warning: '警告',
  system: '系统',
}

const UNTITLED_TASK = '未命名任务'

export interface TeamOverviewProps {
  readonly team: TeamView
  /** Every task in the team; totals and member progress always use this list. */
  readonly tasks: readonly TeamTask[]
  /** Filtered subset for graph/detail visibility; defaults to `tasks`. */
  readonly visibleTasks?: readonly TeamTask[] | undefined
  readonly messages: readonly TeamMessage[]
  readonly selectedTaskId?: string | undefined
  readonly messagesLoading?: boolean | undefined
  readonly messagesError?: string | undefined
  readonly onClearFilters?: (() => void) | undefined
  readonly onSelectTask: (taskId: string) => void
  readonly onOpenSession: (sessionId: string) => void
}

interface ProgressCounts {
  total: number
  completed: number
  running: number
  waiting: number
  error: number
}

function taskTitle(title: string): string {
  return title.trim() === '' ? UNTITLED_TASK : title
}

function initial(name: string | undefined): string {
  const trimmed = name?.trim() ?? ''
  return [...trimmed][0]?.toLocaleUpperCase() ?? '?'
}

function statusTone(status: TeamTask['status']): Tone {
  switch (status) {
    case 'running':
      return 'business'
    case 'completed':
      return 'success'
    case 'blocked':
      return 'warn'
    case 'failed':
    case 'cancelled':
      return 'danger'
    default:
      return 'neutral'
  }
}

function messageTone(type: TeamMessage['type']): Tone {
  switch (type) {
    case 'warning':
      return 'warn'
    case 'question':
      return 'business'
    case 'result':
      return 'success'
    default:
      return 'neutral'
  }
}

function ownerName(team: TeamView, task: TeamTask): string {
  if (task.ownerSlotId === undefined) return '未分配'
  return team.members[task.ownerSlotId]?.displayName ?? '已移除成员'
}

function ownerOf(team: TeamView, task: TeamTask): TeamMemberSlot | undefined {
  if (task.ownerSlotId === undefined) return undefined
  return team.members[task.ownerSlotId]
}

/** The Session that owns a task, used by the detail panel's open action. */
export function sessionForTask(team: TeamView, task: TeamTask): string | undefined {
  return ownerOf(team, task)?.sessionId
}

function formatTime(value: string): string {
  const at = Date.parse(value)
  if (Number.isNaN(at)) return value
  return new Date(at).toLocaleString('zh-CN')
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}

function progressOf(tasks: readonly TeamTask[]): ProgressCounts {
  const counts: ProgressCounts = {
    total: tasks.length,
    completed: 0,
    running: 0,
    waiting: 0,
    error: 0,
  }
  for (const task of tasks) {
    switch (task.status) {
      case 'completed':
        counts.completed += 1
        break
      case 'running':
        counts.running += 1
        break
      case 'pending':
      case 'assigned':
        counts.waiting += 1
        break
      case 'blocked':
      case 'failed':
      case 'cancelled':
        counts.error += 1
        break
    }
  }
  return counts
}

function progressText(progress: ProgressCounts): string {
  return `共 ${progress.total} 个任务，已完成 ${progress.completed}，进行中 ${progress.running}，等待 ${progress.waiting}，异常 ${progress.error}`
}

function orderedMembers(team: TeamView): TeamMemberSlot[] {
  const order = team.memberOrder ?? Object.keys(team.members)
  const rank = new Map(order.map((id, index) => [id, index]))
  return Object.values(team.members).sort((left, right) => {
    if (left.role !== right.role) return left.role === 'leader' ? -1 : 1
    const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER
    const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER
    return leftRank - rightRank
      || left.displayName.localeCompare(right.displayName, 'zh-CN')
      || left.id.localeCompare(right.id)
  })
}

function byUpdatedDesc(left: TeamTask, right: TeamTask): number {
  const leftAt = Date.parse(left.updatedAt)
  const rightAt = Date.parse(right.updatedAt)
  return (Number.isNaN(rightAt) ? 0 : rightAt) - (Number.isNaN(leftAt) ? 0 : leftAt)
    || left.id.localeCompare(right.id)
}

function senderName(team: TeamView, message: TeamMessage): string {
  if (message.sender.kind === 'user') return '你'
  if (message.sender.kind === 'system') return '系统'
  return team.members[message.sender.id]?.displayName ?? '已移除成员'
}

function messagePreview(message: TeamMessage): string {
  const summary = message.summary?.trim() ?? ''
  const raw = summary === '' ? message.content : summary
  const firstLine = raw.split(/\r?\n/).find(line => line.trim() !== '') ?? ''
  const normalized = firstLine.trim()
  return normalized.length > PREVIEW_CHARS
    ? `${normalized.slice(0, PREVIEW_CHARS)}…`
    : normalized
}

function Progress({ progress }: { progress: ProgressCounts }): JSX.Element {
  const segments = [
    { id: 'completed', label: '已完成', count: progress.completed, tone: css.overviewProgressComplete },
    { id: 'running', label: '进行中', count: progress.running, tone: css.overviewProgressRunning },
    { id: 'waiting', label: '等待', count: progress.waiting, tone: css.overviewProgressWaiting },
    { id: 'error', label: '异常', count: progress.error, tone: css.overviewProgressError },
  ]
  const label = progressText(progress)
  const track = segments.map(segment => (
    <span
      key={segment.id}
      className={`${css.overviewProgressSegment} ${segment.tone}`}
      style={{ flexGrow: segment.count } as CSSProperties}
      data-dsh-progress={segment.id}
      aria-hidden="true"
    />
  ))
  return (
    <div className={css.overviewProgress} data-overview-progress="true">
      {progress.total > 0
        ? (
          <div
            className={css.overviewProgressBar}
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.completed}
            aria-valuetext={label}
          >
            {track}
          </div>
        )
        : (
          <div className={css.overviewProgressBar} aria-hidden="true">
            {track}
          </div>
        )}
      <p className={css.overviewProgressText}>{label}</p>
      <ul className={css.overviewProgressLegend}>
        {segments.map(segment => (
          <li key={segment.id}>
            <span className={`${css.overviewLegendDot} ${segment.tone}`} aria-hidden="true" />
            {segment.label} <span className={css.overviewLegendCount}>{segment.count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function GraphNode({ team, task, dependencies, unlocks, selected, onSelect }: {
  readonly team: TeamView
  readonly task: TeamTask
  readonly dependencies: readonly string[]
  readonly unlocks: readonly string[]
  readonly selected: boolean
  readonly onSelect: (taskId: string) => void
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={css.overviewNode}
        data-task-id={task.id}
        data-tone={statusTone(task.status)}
        aria-pressed={selected}
        aria-label={`查看任务「${taskTitle(task.title)}」，${TASK_STATUS_LABELS[task.status]}，${ownerName(team, task)}`}
        onClick={() => { onSelect(task.id) }}
      >
        <span className={css.overviewNodeTitle} title={taskTitle(task.title)}>{taskTitle(task.title)}</span>
        <span className={css.overviewNodeMeta}>
          <span className={css.overviewNodeStatus} data-tone={statusTone(task.status)}>
            {TASK_STATUS_LABELS[task.status]}
          </span>
          <span className={css.overviewNodeOwner}>{ownerName(team, task)}</span>
        </span>
        {(dependencies.length > 0 || unlocks.length > 0) && (
          <span className={css.overviewNodeEdges}>
            {dependencies.length > 0 && (
              <span className={css.overviewNodeEdge} title={`依赖：${dependencies.join('、')}`}>
                依赖 · {dependencies.join('、')}
              </span>
            )}
            {unlocks.length > 0 && (
              <span className={css.overviewNodeEdge} title={`解锁：${unlocks.join('、')}`}>
                解锁 · {unlocks.join('、')}
              </span>
            )}
          </span>
        )}
      </button>
    </li>
  )
}

function MemberRow({ team, member, tasks, selectedId, onSelectTask, onOpenSession }: {
  readonly team: TeamView
  readonly member: TeamMemberSlot
  readonly tasks: readonly TeamTask[]
  readonly selectedId: string | undefined
  readonly onSelectTask: (taskId: string) => void
  readonly onOpenSession: (sessionId: string) => void
}): JSX.Element {
  const owned = tasks.filter(task => task.ownerSlotId === member.id).sort(byUpdatedDesc)
  return (
    <li className={css.overviewMember}>
      <div className={css.overviewMemberHead}>
        <span className={css.overviewMemberAvatar} aria-hidden="true">{initial(member.displayName)}</span>
        <div className={css.overviewMemberIdentity}>
          <button
            type="button"
            className={css.overviewMemberName}
            title={`打开 ${member.displayName} 的会话`}
            onClick={() => { onOpenSession(member.sessionId) }}
          >
            {member.displayName}
          </button>
          <span className={css.overviewMemberMeta}>
            {member.role === 'leader' ? 'Leader' : '成员'} · {MEMBER_STATE_LABELS[member.lastRuntimeState]}
            <span className={css.overviewModelBadge} title={member.assistantSnapshot.model}>
              {member.assistantSnapshot.model}
            </span>
          </span>
        </div>
        <span className={css.overviewMemberCount}>{owned.length}</span>
      </div>
      {owned.length === 0
        ? <span className={css.overviewMemberEmpty}>暂无任务</span>
        : (
          <div className={css.overviewChips}>
            {owned.map(task => (
              <button
                key={task.id}
                type="button"
                className={css.overviewChip}
                data-tone={statusTone(task.status)}
                aria-pressed={selectedId === task.id}
                title={`${taskTitle(task.title)} · ${TASK_STATUS_LABELS[task.status]}`}
                onClick={() => { onSelectTask(task.id) }}
              >
                <span className={css.overviewChipTitle}>{taskTitle(task.title)}</span>
                <span className={css.overviewChipStatus}>{TASK_STATUS_LABELS[task.status]}</span>
              </button>
            ))}
          </div>
        )}
    </li>
  )
}

function TaskDetail({ team, tasks, selectedId, selectedTaskId, visibleTaskIds, onSelectTask, onOpenSession }: {
  readonly team: TeamView
  readonly tasks: readonly TeamTask[]
  readonly selectedId: string | undefined
  readonly selectedTaskId: string | undefined
  readonly visibleTaskIds: ReadonlySet<string>
  readonly onSelectTask: (taskId: string) => void
  readonly onOpenSession: (sessionId: string) => void
}): JSX.Element {
  const selected = pickOverviewTask(tasks, selectedId)
  if (selected === undefined) {
    return (
      <section className={css.overviewPanel} aria-label="任务详情" data-overview-region="task-detail">
        <header className={css.overviewPanelHeader}>
          <h3 className={css.overviewPanelTitle}>任务详情</h3>
        </header>
        <p className={css.overviewEmpty}>
          {tasks.length === 0 ? '暂无任务可查看' : '选择任务后查看详情'}
        </p>
        {tasks.length === 0 && (
          <p className={css.overviewDetailHint}>{TEAM_TASK_CREATE_HINT}</p>
        )}
      </section>
    )
  }

  const byId = new Map(tasks.map(task => [task.id, task]))
  const dependencies = selected.dependencyIds.map(id => ({ id, title: byId.get(id)?.title }))
  const unlocks = tasks.filter(task => task.dependencyIds.includes(selected.id))
  const owner = ownerOf(team, selected)
  const selectedExists = selectedTaskId !== undefined
    && tasks.some(task => task.id === selectedTaskId)
  const removed = selectedTaskId !== undefined && !selectedExists
  const hidden = !removed && !visibleTaskIds.has(selected.id)
  const title = taskTitle(selected.title)
  const carriesVerdict = taskCarriesVerdict(selected)
  const verdictLabel = taskVerdictLabel(selected)
  const verdictTone = taskVerdictTone(selected)
  const reviewed = selected.reviewedTaskId === undefined
    ? undefined
    : byId.get(selected.reviewedTaskId)
  // Findings for a failing verdict live in `error`; a review/verification row
  // shows them under 审核结论 so they are never lost or printed twice.
  const findings = carriesVerdict && selected.error !== undefined && selected.error !== ''
    ? selected.error
    : undefined
  const goal = selected.goalId === undefined ? undefined : team.goals?.[selected.goalId]
  const goalLabel = selected.goalId === undefined
    ? '未归入目标'
    : goal?.title ?? `未知目标（${shortId(selected.goalId)}）`
  const schedule = taskScheduleEntries(selected)

  return (
    <section className={css.overviewPanel} aria-label="任务详情" data-overview-region="task-detail">
      <header className={css.overviewPanelHeader}>
        <h3 className={css.overviewPanelTitle}>任务详情</h3>
        <span className={css.overviewPanelCount}>{TASK_STATUS_LABELS[selected.status]}</span>
      </header>
      {removed && <p className={css.overviewHint}>原选中任务已移除，已自动切换。</p>}
      {hidden && <p className={css.overviewHint}>当前筛选已隐藏该任务，详情仍显示。</p>}
      <div className={css.overviewDetail} data-task-id={selected.id}>
        <div className={css.overviewDetailHead}>
          <h4 className={css.overviewDetailTitle} title={title}>{title}</h4>
          <span className={css.overviewStatus} data-tone={statusTone(selected.status)}>
            {TASK_STATUS_LABELS[selected.status]}
          </span>
        </div>
        <dl className={css.overviewDetailGrid}>
          <div>
            <dt>所有者</dt>
            <dd>{ownerName(team, selected)}</dd>
          </div>
          <div>
            <dt>任务类型</dt>
            <dd>{taskKindLabel(selected.kind)}</dd>
          </div>
          <div>
            <dt>尝试 ID</dt>
            <dd title={selected.attemptId}>
              {selected.attemptId === undefined ? '未分配' : shortId(selected.attemptId)}
            </dd>
          </div>
          <div>
            <dt>所属目标</dt>
            <dd>{goalLabel}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{formatTime(selected.updatedAt)}</dd>
          </div>
          {schedule.map(entry => (
            <div key={entry.label}>
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
        {selected.description !== '' && (
          <p className={css.overviewDetailText}>{selected.description}</p>
        )}
        {selected.acceptance !== undefined && selected.acceptance.trim() !== '' && (
          <p className={css.overviewDetailText}>
            <strong className={css.overviewDetailGroupTitle}>验收：</strong>
            {selected.acceptance}
          </p>
        )}
        {carriesVerdict && (
          <div className={css.overviewDetailGroup} data-overview-region="task-verdict">
            <h5 className={css.overviewDetailGroupTitle}>审核结论</h5>
            <div className={css.overviewDetailRow}>
              <span className={css.overviewVerdict} data-tone={verdictTone}>{verdictLabel}</span>
              {selected.reviewedTaskId !== undefined && (
                reviewed === undefined
                  ? <span className={css.overviewDetailMuted}>
                      审核对象：未知任务（{shortId(selected.reviewedTaskId)}）
                    </span>
                  : (
                    <button
                      type="button"
                      className={css.overviewRefButton}
                      onClick={() => { onSelectTask(reviewed.id) }}
                    >
                      审核对象：{taskTitle(reviewed.title)}
                    </button>
                  )
              )}
            </div>
            {findings !== undefined
              ? <p className={css.overviewErrorText}><strong>问题：</strong>{findings}</p>
              : selected.verdict === 'pass'
                ? <span className={css.overviewDetailMuted}>审核已通过。</span>
                : undefined}
          </div>
        )}
        <div className={css.overviewDetailGroup}>
          <h5 className={css.overviewDetailGroupTitle}>依赖</h5>
          {dependencies.length === 0
            ? <span className={css.overviewDetailMuted}>无依赖</span>
            : (
              <ul className={css.overviewRefList}>
                {dependencies.map(dependency => (
                  <li key={dependency.id} className={css.overviewRef}>
                    {dependency.title === undefined
                      ? `未知依赖（${shortId(dependency.id)}）`
                      : dependency.title}
                  </li>
                ))}
              </ul>
            )}
        </div>
        <div className={css.overviewDetailGroup}>
          <h5 className={css.overviewDetailGroupTitle}>被依赖</h5>
          {unlocks.length === 0
            ? <span className={css.overviewDetailMuted}>没有下游任务</span>
            : (
              <ul className={css.overviewRefList}>
                {unlocks.map(task => (
                  <li key={task.id} className={css.overviewRef}>
                    <button
                      type="button"
                      className={css.overviewRefButton}
                      onClick={() => { onSelectTask(task.id) }}
                    >
                      {taskTitle(task.title)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
        {selected.result !== undefined && selected.result !== '' && (
          <p className={css.overviewResult}><strong>结果</strong>{selected.result}</p>
        )}
        {findings === undefined && selected.error !== undefined && selected.error !== '' && (
          <p className={css.overviewErrorText}><strong>异常</strong>{selected.error}</p>
        )}
        {owner !== undefined && (
          <button
            type="button"
            className={css.overviewOpenButton}
            onClick={() => { onOpenSession(owner.sessionId) }}
          >
            打开成员会话
          </button>
        )}
        <p className={css.overviewDetailHint}>{TEAM_TASK_CREATE_HINT}</p>
      </div>
    </section>
  )
}

function Inbox({ team, messages, loading, error }: {
  readonly team: TeamView
  readonly messages: readonly TeamMessage[]
  readonly loading: boolean
  readonly error: string | undefined
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const allInbox = leaderInbox(messages, team.leaderSlotId, Number.MAX_SAFE_INTEGER)
  const inbox = expanded ? allInbox : allInbox.slice(0, INBOX_LIMIT)
  const showList = error === undefined && !(loading && allInbox.length === 0) && allInbox.length > 0
  return (
    <section className={`${css.overviewPanel} ${css.overviewInbox}`} aria-label="Leader 收件箱" data-overview-region="leader-inbox">
      <header className={css.overviewPanelHeader}>
        <h3 className={css.overviewPanelTitle}>Leader 收件箱</h3>
        <span className={css.overviewPanelCount}>
          {expanded ? `全部 ${allInbox.length} 条` : `最近 ${inbox.length} 条`}
        </span>
      </header>
      {error !== undefined
        ? <p className={css.overviewErrorText} role="status">收件箱加载失败：{error}</p>
        : loading && allInbox.length === 0
          ? <p className={css.overviewEmpty}>正在加载收件箱…</p>
          : allInbox.length === 0
            ? <p className={css.overviewEmpty}>暂无待处理消息</p>
            : (
              <>
                <ul className={css.overviewInboxList}>
                  {inbox.map(item => {
                    const unread = !item.readBy.includes(team.leaderSlotId)
                    return (
                      <li key={item.id} className={css.overviewInboxItem}>
                        <span className={css.overviewInboxAvatar} data-kind={item.sender.kind} aria-hidden="true">
                          {initial(senderName(team, item))}
                        </span>
                        <div className={css.overviewInboxBody}>
                          <div className={css.overviewInboxTop}>
                            <strong className={css.overviewInboxSender}>{senderName(team, item)}</strong>
                            <span className={css.overviewType} data-tone={messageTone(item.type)}>
                              {MESSAGE_TYPE_LABELS[item.type]}
                            </span>
                            {unread && <span className={css.overviewUnread}>未读</span>}
                            <span className={css.overviewInboxTime} title={formatTime(item.createdAt)}>
                              {formatTime(item.createdAt)}
                            </span>
                          </div>
                          <p className={css.overviewInboxText}>{messagePreview(item)}</p>
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {showList && allInbox.length > INBOX_LIMIT && (
                  <button
                    type="button"
                    className={css.overviewInboxMore}
                    aria-expanded={expanded}
                    onClick={() => { setExpanded(value => !value) }}
                  >
                    {expanded ? '收起' : `查看全部（${allInbox.length}）`}
                  </button>
                )}
              </>
            )}
    </section>
  )
}

/**
 * Read-only collaboration view derived from the same `TeamView`/tasks/messages
 * as the task board. Team totals, progress and member chips always use the full
 * task list; search/member/status filters only narrow graph and detail
 * visibility, which is labelled explicitly. It never edits a task or fetches.
 */
export function TeamOverview(props: TeamOverviewProps): JSX.Element {
  const {
    team,
    tasks,
    messages,
    visibleTasks,
    selectedTaskId,
    messagesLoading = false,
    messagesError,
    onClearFilters,
  } = props
  const visible = visibleTasks ?? tasks
  const visibleTaskIds = new Set(visible.map(task => task.id))
  const filtered = visible.length !== tasks.length
  const leader = team.members[team.leaderSlotId]
  const leaderName = leader?.displayName ?? 'Leader'
  const memberCount = Object.values(team.members).filter(member => member.role !== 'leader').length
  const progress = progressOf(tasks)
  const graph = dependencyGraph(tasks)
  const members = orderedMembers(team)
  const selected = pickOverviewTask(tasks, selectedTaskId)
  const selectedId = selected?.id
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const unlocksByTask = new Map<string, string[]>()
  for (const task of tasks) {
    for (const dependencyId of new Set(task.dependencyIds)) {
      const list = unlocksByTask.get(dependencyId)
      if (list === undefined) unlocksByTask.set(dependencyId, [taskTitle(task.title)])
      else list.push(taskTitle(task.title))
    }
  }
  const dependenciesOf = (task: TeamTask): string[] => [...new Set(task.dependencyIds)]
    .map(id => taskById.get(id)?.title ?? `缺失 ${shortId(id)}`)
  const unlocksOf = (task: TeamTask): string[] => unlocksByTask.get(task.id) ?? []
  const hasDependencies = tasks.some(task => task.dependencyIds.length > 0)
  const summary = tasks.length === 0
    ? '还没有任务，Leader 派发后会出现在这里'
    : `已派发 ${tasks.length} 项任务给 ${memberCount} 名成员`
  const visibleLayers = graph.layers
    .map(layer => ({
      depth: layer.depth,
      tasks: layer.tasks.filter(task => visibleTaskIds.has(task.id)),
    }))
    .filter(layer => layer.tasks.length > 0)
  const visibleUnlayered = graph.unlayered.filter(task => visibleTaskIds.has(task.id))
  const graphHint = filtered
    ? `筛选后显示 ${visible.length} 个任务（团队共 ${tasks.length} 个）`
    : hasDependencies
      ? `按依赖分为 ${graph.layers.length} 层，节点标注依赖与解锁`
      : '任务暂无依赖'

  return (
    <div className={css.overviewRoot} data-view="overview">
      <div className={css.overviewMain}>
        <div className={css.overviewColumn}>
          <section className={css.overviewPanel} aria-label="Leader 摘要">
            <header className={css.overviewPanelHeader}>
              <h3 className={css.overviewPanelTitle}>Leader 摘要</h3>
              <span className={css.overviewPanelCount}>任务进度</span>
            </header>
            <div className={css.overviewLeaderHead}>
              <span className={css.overviewLeaderAvatar} aria-hidden="true">{initial(leaderName)}</span>
              <div className={css.overviewLeaderIdentity}>
                <strong className={css.overviewLeaderName}>{leaderName}</strong>
                <span className={css.overviewLeaderMeta}>
                  Leader · {leader === undefined ? '未就绪' : MEMBER_STATE_LABELS[leader.lastRuntimeState]}
                </span>
              </div>
              <span className={css.overviewLeaderTotal}>{progress.total}<small>任务</small></span>
            </div>
            <p className={css.overviewSummary}>{summary}</p>
            <Progress progress={progress} />
          </section>

          <section className={css.overviewPanel} aria-label="成员与任务">
            <header className={css.overviewPanelHeader}>
              <h3 className={css.overviewPanelTitle}>成员与任务</h3>
              <span className={css.overviewPanelCount}>
                {filtered ? `${members.length} 名成员 · 团队全量` : `${members.length} 名成员`}
              </span>
            </header>
            <ul className={css.overviewMembers}>
              {members.map(member => (
                <MemberRow
                  key={member.id}
                  team={team}
                  member={member}
                  tasks={tasks}
                  selectedId={selectedId}
                  onSelectTask={props.onSelectTask}
                  onOpenSession={props.onOpenSession}
                />
              ))}
            </ul>
            {members.length === 0 && <p className={css.overviewEmpty}>暂无成员</p>}
          </section>
        </div>

        <div className={css.overviewColumn}>
          <section className={css.overviewPanel} aria-label="任务依赖图" data-overview-region="dependency-graph">
            <header className={css.overviewPanelHeader}>
              <h3 className={css.overviewPanelTitle}>任务依赖图</h3>
              <span className={css.overviewPanelCount}>
                {filtered
                  ? `筛选后 ${visible.length} / 共 ${tasks.length} 个`
                  : `${tasks.length} 个任务`}
              </span>
            </header>
            {tasks.length === 0
              ? <p className={css.overviewEmpty}>还没有任务，Leader 派发后会出现在这里</p>
              : visible.length === 0
                ? (
                  <div className={css.overviewFilterEmpty} data-overview-region="filter-empty">
                    <p className={css.overviewEmpty}>当前筛选下没有任务</p>
                    {onClearFilters !== undefined && (
                      <button type="button" className={css.overviewClearButton} onClick={onClearFilters}>
                        清除筛选
                      </button>
                    )}
                  </div>
                )
                : (
                  <>
                    <p className={css.overviewHint}>{graphHint}</p>
                    <div className={css.overviewGraphViewport}>
                      <div className={css.overviewLayers}>
                        {visibleLayers.map(layer => (
                          <div
                            key={layer.depth}
                            className={css.overviewLayer}
                            data-depth={layer.depth}
                            role="group"
                            aria-label={`第 ${layer.depth + 1} 层，${layer.tasks.length} 个任务`}
                          >
                            <span className={css.overviewLayerLabel}>
                              第 {layer.depth + 1} 层
                              <span className={css.overviewLayerCount}>{layer.tasks.length}</span>
                            </span>
                            <ul className={css.overviewLayerList}>
                              {layer.tasks.map(task => (
                                <GraphNode
                                  key={task.id}
                                  team={team}
                                  task={task}
                                  dependencies={dependenciesOf(task)}
                                  unlocks={unlocksOf(task)}
                                  selected={task.id === selectedId}
                                  onSelect={props.onSelectTask}
                                />
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </div>
                    {visibleUnlayered.length > 0 && (
                      <div className={css.overviewUnlayered}>
                        <p className={css.overviewWarning} role="status">
                          <span className={css.overviewWarningMark} aria-hidden="true">!</span>
                          存在循环或缺失依赖，{visibleUnlayered.length} 个任务进入未分层区，仍保留在下方
                        </p>
                        <ul className={css.overviewLayerList}>
                          {visibleUnlayered.map(task => (
                            <GraphNode
                              key={task.id}
                              team={team}
                              task={task}
                              dependencies={dependenciesOf(task)}
                              unlocks={unlocksOf(task)}
                              selected={task.id === selectedId}
                              onSelect={props.onSelectTask}
                            />
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
          </section>

          <TaskDetail
            team={team}
            tasks={tasks}
            selectedId={selectedId}
            selectedTaskId={selectedTaskId}
            visibleTaskIds={visibleTaskIds}
            onSelectTask={props.onSelectTask}
            onOpenSession={props.onOpenSession}
          />
        </div>
      </div>

      <Inbox
        team={team}
        messages={messages}
        loading={messagesLoading}
        error={messagesError}
      />
    </div>
  )
}
