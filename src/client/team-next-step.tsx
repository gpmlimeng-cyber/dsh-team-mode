import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, teamLeaderSessionId } from './api.js'
import css from './AgentTeam.module.css'

/**
 * The first task a brand-new team is offered.
 *
 * It is an ordinary instruction to the team's 领队 — the task record itself is
 * still created by the Leader through the existing team tools, so nothing here
 * invents a task type, a status, or a second write path. The copy names the
 * deliverable and asks for it directly; it never asks the reader to understand
 * the team protocol first.
 */
export const SAMPLE_TASK_INSTRUCTION =
  '请为这个团队建一条任务：梳理这个仓库的结构，给出 3 条改进建议。建好后就开始做，做完把结果写在任务里。'

/**
 * What the card says. User words only: 领队 / 会话 / 任务. The internal names
 * (Leader, 线程, 评审, 批量) stay out of the copy because a new user has to
 * understand none of them to finish this first task.
 */
export const NEXT_STEP_TITLE = '下一步'
export const NEXT_STEP_BODY = '这个团队可以一起完成一件交付：领队接活、成员分工，结果都留在团队里。'
export const NEXT_STEP_SAMPLE_LABEL = '创建样例任务'
export const NEXT_STEP_SAMPLE_DETAIL = '梳理这个仓库的结构，给出 3 条改进建议'
export const NEXT_STEP_TALK_LABEL = '和领队说话'

/**
 * The fields the entry reads, and nothing else: a `TeamView` satisfies it
 * structurally, and a test can build one without the whole aggregate.
 */
export interface NextStepTeam {
  readonly id: string
  readonly leaderSlotId: string
  readonly members: Readonly<Record<string, { readonly sessionId: string }>>
  readonly tasks: Readonly<Record<string, unknown>>
  /** Lifecycle state; only an active team can take an instruction. */
  readonly state?: string | undefined
  /** An archived team is not a new one: the entry never follows it there. */
  readonly archivedAt?: string | undefined
}

/**
 * Whether the entry belongs on screen.
 *
 * Derived from the team's own state (no task yet) instead of a stored "seen the
 * guide" flag: a flag would have to be written per team and per browser, and a
 * reload, a second device, or a cleared storage would show the entry again. A
 * team that already has a task has started working, which is exactly the state
 * the entry exists to leave. A team with no resolvable 领队 session cannot send
 * an instruction at all, so there the entry hides instead of offering a button
 * that would fail (`空团队` degrades to nothing rather than an error). The same
 * rule covers a team that is not active or is already archived.
 */
export function showTeamNextStep(team: NextStepTeam): boolean {
  if (team.archivedAt !== undefined || team.state !== 'active') return false
  return Object.keys(team.tasks).length === 0 && teamLeaderSessionId(team) !== undefined
}

/** The `team.message.send` payload the primary button posts; absent when no entry. */
export function sampleTaskRequest(
  team: NextStepTeam,
): { teamId: string; content: string; targetSlotId: string } | undefined {
  if (!showTeamNextStep(team)) return undefined
  return { teamId: team.id, content: SAMPLE_TASK_INSTRUCTION, targetSlotId: team.leaderSlotId }
}

/**
 * Send the sample instruction through the same call the team composer uses, so
 * the Lead receives a real user message and starts a real turn.
 */
export async function startSampleTask(team: NextStepTeam): Promise<void> {
  const request = sampleTaskRequest(team)
  if (request === undefined) return
  await callAgentTeam('team.message.send', request)
}

/**
 * The one first-use surface: a compact card at the top of a team row's expanded
 * area. Not a tutorial — no step ring, no overlay, no persisted progress: two
 * actions that both do something real right now.
 */
export function TeamNextStepCard({
  team,
  onOpenLeader,
}: {
  team: NextStepTeam
  /** Open the 领队 main session; provided by whichever host renders the card. */
  onOpenLeader: () => void
}): JSX.Element | null {
  const [sending, setSending] = useState(false)
  // Per-mount only: it stops a double click, not a deliberate second send after
  // a reload. Persisting it would be the "seen the guide" flag this entry
  // deliberately does not have; the task count is the real switch.
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string>()
  if (!showTeamNextStep(team)) return null
  const createSample = async (): Promise<void> => {
    if (sending || sent) return
    setSending(true)
    setError(undefined)
    try {
      await startSampleTask(team)
      setSent(true)
      // The instruction is in the Lead's session; open it so the user watches
      // the first task get created instead of waiting on a silent row.
      onOpenLeader()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSending(false)
    }
  }
  return (
    <section className={css.nextStepCard} aria-label={NEXT_STEP_TITLE} data-dsh-team-next-step>
      <strong className={css.nextStepTitle}>{NEXT_STEP_TITLE}</strong>
      <p className={css.nextStepBody}>{NEXT_STEP_BODY}</p>
      <p className={css.nextStepDetail}>{NEXT_STEP_SAMPLE_DETAIL}</p>
      <div className={css.nextStepActions}>
        <Button
          variant="primary"
          size="sm"
          disabled={sending || sent}
          onClick={() => { void createSample() }}
        >
          {sent ? '已交给领队…' : sending ? '正在创建…' : NEXT_STEP_SAMPLE_LABEL}
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenLeader}>
          {NEXT_STEP_TALK_LABEL}
        </Button>
      </div>
      {error !== undefined && <p className={css.nextStepError} role="alert">{error}</p>}
    </section>
  )
}
