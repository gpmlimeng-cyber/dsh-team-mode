import type { CSSProperties } from 'react'
import css from './AgentTeam.module.css'
import {
  panelProgressText,
  teamPanelView,
  type PanelMember,
  type PanelView,
} from './team-main-agent-data.js'
import type { TeamView } from '../transport/contracts.js'

export interface TeamMainAgentPanelProps {
  team: TeamView
  open: boolean
  onClose: () => void
  onOpenMember: (slotId: string) => void
  onOpenTeam: () => void
}

const ROLE_LABELS: Record<PanelMember['role'], string> = {
  leader: 'Leader',
  member: '成员',
}

function initial(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase() || '?'
}

function blockerText(view: PanelView): string {
  if (view.firstBlocker !== undefined) {
    return view.firstBlocker.ownerName === undefined
      ? `阻塞：${view.firstBlocker.title}`
      : `阻塞：${view.firstBlocker.title} · 等待 ${view.firstBlocker.ownerName}`
  }
  // A blocked task whose dependency was deleted has no resolvable blocker.
  // Saying 暂无阻塞 next to a 阻塞 count would contradict the panel.
  if (view.blocked > 0) return `${view.blocked} 个阻塞任务等待重新派发`
  return '暂无阻塞'
}

function hasBlocker(view: PanelView): boolean {
  return view.firstBlocker !== undefined || view.blocked > 0
}

function summaryText(view: PanelView): string {
  return view.taskTotal === 0
    ? '还没有任务，Leader 派发后会出现在这里'
    : `已派发 ${view.taskTotal} 项任务给 ${view.memberCount} 名成员`
}

function Progress({ view }: { view: PanelView }): JSX.Element {
  const segments = [
    { id: 'completed', label: '已完成', count: view.completed, tone: css.mainAgentProgressComplete },
    { id: 'running', label: '进行中', count: view.running, tone: css.mainAgentProgressRunning },
    { id: 'waiting', label: '等待前置', count: view.waiting, tone: css.mainAgentProgressWaiting },
    { id: 'error', label: '异常', count: view.error, tone: css.mainAgentProgressError },
  ]
  return (
    <section className={css.mainAgentProgress} aria-label="任务进度">
      <div
        className={css.mainAgentProgressBar}
        role="progressbar"
        aria-label={panelProgressText(view)}
        aria-valuemin={0}
        aria-valuemax={view.taskTotal}
        aria-valuenow={view.completed}
      >
        {segments.map(segment => (
          <span
            key={segment.id}
            className={`${css.mainAgentProgressSegment} ${segment.tone}`}
            style={{ flexGrow: segment.count } as CSSProperties}
            data-dsh-progress={segment.id}
            aria-hidden="true"
          />
        ))}
      </div>
      <p className={css.mainAgentProgressText}>{panelProgressText(view)}</p>
      <ul className={css.mainAgentProgressLegend}>
        {segments.map(segment => (
          <li key={segment.id}>
            <span className={`${css.mainAgentLegendDot} ${segment.tone}`} aria-hidden="true" />
            {segment.label} <span className={css.mainAgentLegendCount}>{segment.count}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function MemberRow({
  member,
  onOpenMember,
}: {
  member: PanelMember
  onOpenMember: (slotId: string) => void
}): JSX.Element {
  return (
    <li className={css.mainAgentMember}>
      <div className={css.mainAgentMemberHead}>
        <span className={css.mainAgentAvatar} aria-hidden="true">{initial(member.name)}</span>
        <button
          type="button"
          className={css.mainAgentMemberName}
          onClick={() => onOpenMember(member.id)}
          title={member.name}
        >
          {member.name}
        </button>
        <span className={css.mainAgentRole}>{ROLE_LABELS[member.role]}</span>
        <span
          className={css.mainAgentMemberStatus}
          data-dsh-member-state={member.state}
          data-state={member.state}
          title={member.statusLabel}
        >
          {member.statusLabel}
        </span>
        <span className={css.mainAgentModel} title={member.model}>{member.model}</span>
        <span className={css.mainAgentMemberProgress} aria-label={`已完成 ${member.completed} / 共 ${member.total}`}>
          {member.completed}/{member.total}
        </span>
      </div>
      <p className={css.mainAgentCurrentTask}>
        {member.currentTask === undefined ? '暂无当前任务' : `当前：${member.currentTask.title}`}
      </p>
      {member.chips.length === 0
        ? <p className={css.mainAgentMemberEmpty}>暂无任务</p>
        : (
            <ul className={css.mainAgentChips} aria-label={`${member.name} 的任务`}>
              {member.chips.map(chip => (
                <li
                  key={chip.id}
                  className={css.mainAgentChip}
                  data-dsh-panel-chip
                  data-status={chip.status}
                >
                  <span className={css.mainAgentChipTitle} title={chip.title}>{chip.title}</span>
                  <span className={css.mainAgentChipStatus}>{chip.statusLabel}</span>
                </li>
              ))}
            </ul>
          )}
    </li>
  )
}

/**
 * Collapsible right-side execution strip for the Leader main conversation.
 * It reads one `TeamView` and renders counts that already exist; it never
 * opens the board, a DAG, task detail, or the inbox in place of the chat.
 */
export function TeamMainAgentPanel({
  team,
  open,
  onClose,
  onOpenMember,
  onOpenTeam,
}: TeamMainAgentPanelProps): JSX.Element | null {
  if (!open) return null
  const view = teamPanelView(team)
  return (
    <aside
      className={css.mainAgentPanel}
      role="complementary"
      aria-label="团队运行面板"
      data-dsh-team-panel
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 'auto',
        width: 'min(360px, 100vw)',
        maxWidth: '100vw',
        height: '100dvh',
        zIndex: 60,
        backgroundColor: 'var(--dsw-alias-bg-layer-1)',
        backgroundImage: 'none',
        backdropFilter: 'none',
        borderInlineStart: '1px solid var(--dsw-alias-border-l1)',
        boxShadow: 'var(--dsw-alias-shadow-l1)',
      }}
    >
      <header className={css.mainAgentPanelHeader}>
        <div className={css.mainAgentPanelIdentity}>
          <h2 className={css.mainAgentPanelTitle}>{team.name} · 主 Agent</h2>
          <p className={css.mainAgentPanelLeader}>
            当前 Leader：{view.leaderName === '' ? '尚未设置' : view.leaderName}
          </p>
        </div>
        <button
          type="button"
          className={css.mainAgentPanelClose}
          onClick={onClose}
          aria-label="收起团队面板"
          title="收起团队面板"
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className={css.mainAgentPanelBody}>
        <p className={css.mainAgentPanelSummary}>{summaryText(view)}</p>
        <Progress view={view} />
        <p className={hasBlocker(view) ? css.mainAgentBlocker : css.mainAgentNoBlocker}>
          {blockerText(view)}
        </p>
        <section className={css.mainAgentMembers} aria-label="成员">
          <h3 className={css.mainAgentSectionTitle}>成员</h3>
          {view.memberCount === 0
            ? <p className={css.mainAgentEmpty}>还没有成员，邀请成员后会出现在这里</p>
            : (
                <ul className={css.mainAgentMemberList}>
                  {view.members.map(member => (
                    <MemberRow key={member.id} member={member} onOpenMember={onOpenMember} />
                  ))}
                </ul>
              )}
        </section>
      </div>

      <footer className={css.mainAgentPanelFooter}>
        {view.approval > 0
          ? (
              <button type="button" className={css.mainAgentPanelApproval} onClick={onOpenTeam}>
                {view.approval} 个待审批
              </button>
            )
          : <span className={css.mainAgentPanelMuted}>暂无待审批</span>}
      </footer>
    </aside>
  )
}
