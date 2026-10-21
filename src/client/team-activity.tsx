import { useCallback, useEffect, useMemo, useState } from 'react'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { TASK_STATE_LABELS } from './labels.js'
import css from './AgentTeam.module.css'
import type { TeamMessage } from '../domain/types.js'
import type { TeamView } from '../transport/contracts.js'

type ActivityFilter = 'all' | 'messages' | 'tasks'
type ActivitySort = 'newest' | 'oldest'

type ActivityItem =
  | { kind: 'message'; id: string; at: number; lane: string; message: TeamMessage }
  | { kind: 'task'; id: string; at: number; lane: string; task: TeamView['tasks'][string] }

const FALLBACK_LANE = '__unassigned__'

function laneName(team: TeamView, lane: string): string {
  if (lane === FALLBACK_LANE) return '未分配 / 外部'
  return team.members[lane]?.displayName ?? '已移除成员'
}

function messageLane(team: TeamView, message: TeamMessage): string {
  const target = message.recipient.kind === 'broadcast' ? message.sender.id : message.recipient.slotId
  if (target === undefined) return FALLBACK_LANE
  return team.members[target] === undefined ? FALLBACK_LANE : target
}

function taskLane(team: TeamView, task: TeamView['tasks'][string]): string {
  if (task.ownerSlotId === undefined) return FALLBACK_LANE
  return team.members[task.ownerSlotId] === undefined ? FALLBACK_LANE : task.ownerSlotId
}

export function TeamActivityBoard({ team }: { team: TeamView }): JSX.Element {
  const [messages, setMessages] = useState<TeamMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [sort, setSort] = useState<ActivitySort>('newest')
  const [member, setMember] = useState<string>('all')
  const [showSystem, setShowSystem] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)

  const load = useCallback(async () => {
    try {
      const value = await callAgentTeam('team.message.list', { id: team.id })
      setMessages(value.items)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [team.id])

  useEffect(() => {
    setLoading(true)
    void load()
    return subscribeAgentTeam(() => { void load() }, () => {
      setError('团队事件连接已断开，正在重连')
    }, () => { void load() })
  }, [load, team.revision])

  const items = useMemo(() => {
    const list: ActivityItem[] = []
    if (filter !== 'tasks') {
      for (const message of messages) {
        if (!showSystem && message.type === 'system') continue
        list.push({
          kind: 'message',
          id: `m:${message.id}`,
          at: Date.parse(message.createdAt),
          lane: messageLane(team, message),
          message,
        })
      }
    }
    if (filter !== 'messages') {
      for (const task of Object.values(team.tasks)) {
        if (task.status === 'cancelled') continue
        if (!showCompleted && task.status === 'completed') continue
        list.push({
          kind: 'task',
          id: `t:${task.id}`,
          at: Date.parse(task.updatedAt ?? task.createdAt),
          lane: taskLane(team, task),
          task,
        })
      }
    }
    list.sort((a, b) => (sort === 'newest' ? b.at - a.at : a.at - b.at))
    return list.filter(item => member === 'all' || item.lane === member)
  }, [filter, member, messages, showCompleted, showSystem, sort, team])

  const lanes = useMemo(() => {
    const ids = new Set<string>(Object.keys(team.members))
    ids.add(FALLBACK_LANE)
    return [...ids]
      .map(id => ({ id, items: items.filter(item => item.lane === id) }))
      .filter(lane => lane.items.length > 0 || team.members[lane.id] !== undefined)
  }, [items, team.members])

  return (
    <section className={css.activityBoard} aria-label="团队动态（简版）">
      <div className={css.activityToolbar}>
        <div className={css.activityFilterGroup} role="group" aria-label="排序">
          <span className={css.activityFilterLabel}>排序</span>
          <button type="button" className={`${css.activityFilter} ${sort === 'newest' ? css.activityFilterActive : ''}`} onClick={() => { setSort('newest') }}>最新</button>
          <button type="button" className={`${css.activityFilter} ${sort === 'oldest' ? css.activityFilterActive : ''}`} onClick={() => { setSort('oldest') }}>最早</button>
        </div>
        <div className={css.activityFilterGroup} role="group" aria-label="类型">
          <span className={css.activityFilterLabel}>类型</span>
          <button type="button" className={`${css.activityFilter} ${filter === 'all' ? css.activityFilterActive : ''}`} onClick={() => { setFilter('all') }}>全部</button>
          <button type="button" className={`${css.activityFilter} ${filter === 'messages' ? css.activityFilterActive : ''}`} onClick={() => { setFilter('messages') }}>消息</button>
          <button type="button" className={`${css.activityFilter} ${filter === 'tasks' ? css.activityFilterActive : ''}`} onClick={() => { setFilter('tasks') }}>任务</button>
        </div>
        <label className={css.activityMemberFilter}>
          <span className={css.activityFilterLabel}>成员</span>
          <select value={member} onChange={event => { setMember(event.target.value) }}>
            <option value="all">全部成员</option>
            {Object.values(team.members).map(entry => (
              <option key={entry.id} value={entry.id}>{entry.displayName}</option>
            ))}
            <option value={FALLBACK_LANE}>未分配 / 外部</option>
          </select>
        </label>
        <label className={css.activityToggle}>
          <input type="checkbox" checked={showSystem} onChange={event => { setShowSystem(event.target.checked) }} />
          系统消息
        </label>
        <label className={css.activityToggle}>
          <input type="checkbox" checked={showCompleted} onChange={event => { setShowCompleted(event.target.checked) }} />
          已完成任务
        </label>
        <button type="button" className={css.activityRefresh} onClick={() => { void load() }} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>
      <p className={css.activityHint}>简版看板；完整看板（含任务状态分组）在会话顶部「看板」标签。</p>
      {error !== undefined && <div className={css.workbenchError} role="alert">{error}</div>}
      <div className={css.activityLanes}>
        {lanes.map(lane => (
          <section key={lane.id} className={css.activityLane} aria-label={`${laneName(team, lane.id)} 的活动`}>
            <header className={css.activityLaneHeader}>
              <span className={css.activityLaneName}>{laneName(team, lane.id)}</span>
              <span className={css.activityLaneCount}>{lane.items.length}</span>
            </header>
            <div className={css.activityLaneBody}>
              {lane.items.length === 0 && <div className={css.activityEmpty}>暂无动态</div>}
              {lane.items.map(item => item.kind === 'message'
                ? <MessageCard key={item.id} team={team} message={item.message} />
                : <TaskCard key={item.id} team={team} task={item.task} />)}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}

function MessageCard({ team, message }: { team: TeamView; message: TeamMessage }): JSX.Element {
  const from = team.members[message.sender.id]?.displayName ?? (message.sender.id === 'user' ? '你' : '外部')
  const to = message.recipient.kind === 'broadcast'
    ? '@全体'
    : team.members[message.recipient.slotId ?? '']?.displayName ?? '未分配'
  return (
    <article className={`${css.activityCard} ${css.activityMessageCard}`}>
      <header className={css.activityCardHeader}>
        <span className={css.activitySender}>{from}</span>
        <span className={css.activityArrow}>→</span>
        <span className={css.activityRecipient}>{to}</span>
        <span className={css.activityCardTime}>{formatTime(message.createdAt)}</span>
      </header>
      <p className={css.activityCardText}>{message.content}</p>
      <footer className={css.activityCardFooter}>
        <span className={css.activityTypeBadge}>{message.type === 'instruction' ? '指令' : message.type === 'result' ? '结果' : message.type === 'question' ? '问题' : message.type === 'warning' ? '警告' : '消息'}</span>
        {message.attachments.length > 0 && <span>{message.attachments.length} 个附件</span>}
        <span>{message.deliveryState === 'read' ? '已读' : '未读'}</span>
      </footer>
    </article>
  )
}

function TaskCard({ team, task }: { team: TeamView; task: TeamView['tasks'][string] }): JSX.Element {
  return (
    <article className={`${css.activityCard} ${css.activityTaskCard}`}>
      <header className={css.activityCardHeader}>
        <span className={`${css.activityStatus} ${task.status === 'completed' ? css.activityStatusDone : ''}`}>
          {TASK_STATE_LABELS[task.status] ?? task.status}
        </span>
        <span className={css.activityCardTime}>{formatTime(task.updatedAt ?? task.createdAt)}</span>
      </header>
      <strong className={css.activityTaskTitle}>{task.title}</strong>
      {task.description !== '' && <p className={css.activityCardText}>{task.description}</p>}
      <footer className={css.activityCardFooter}>
        <span>{task.ownerSlotId === undefined ? '未分配' : team.members[task.ownerSlotId]?.displayName ?? '已移除成员'}</span>
        {task.dependencyIds.length > 0 && <span>被 {task.dependencyIds.length} 个任务阻塞</span>}
      </footer>
    </article>
  )
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
