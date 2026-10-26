import type { SessionRowScheduleOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { useSessionTeamFacts } from './session-row-leading.js'
import css from './session-row.module.css'

/**
 * Hover-card section of one Session row between the relative time and the
 * trailing status line: role, team, and the approvals the team is waiting on.
 * Text only — the card, its open state and every interaction stay the host's.
 */
export function RowHover({ sessionId }: SessionRowScheduleOwnerProps): JSX.Element | null {
  const facts = useSessionTeamFacts(sessionId)
  if (facts === undefined) return null
  return (
    <div className={css.hoverRow}>
      <span className={css.hoverRole}>{facts.role === 'leader' ? 'Leader' : '成员'}</span>
      <span className={css.hoverTeam}>{facts.teamName}</span>
      {facts.pending > 0 && <span className={css.hoverPending}>{facts.pending} 待确认</span>}
    </div>
  )
}
