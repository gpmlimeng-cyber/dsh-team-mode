import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, teamLeaderSessionId } from './api.js'
import css from './AgentTeam.module.css'

/**
 * The first task a brand-new team is offered.
 *
 * It is an ordinary instruction to the team's Leader — the task record itself is
 * still created by the Leader through the existing team tools, so nothing here
 * invents a task type, a status, or a second write path. The copy names the
 * deliverable and asks for it directly; it never asks the reader to understand
 * the team protocol first.
 *
 * The last clause makes the instruction safe to send twice (a second window, a
 * reload, a queued retry): the Leader resumes the task it already made instead
 * of opening a duplicate one, so the button never turns into a task factory.
 */
export const SAMPLE_TASK_INSTRUCTION =
  '请为这个团队建一条任务：梳理这个仓库的结构，给出 3 条改进建议。建好后就开始做，做完把结果写在任务里；如果这条任务已经存在，就接着做，不要重复建。'

/**
 * What the card says. User words only: 工作区 / Leader / 任务. The internal names
 * (线程, 评审, 批量) stay out of the copy because a new user has to understand
 * none of them to finish this first task.
 */
export const NEXT_STEP_TITLE = '下一步'
export const NEXT_STEP_BODY = '这个团队可以在工作区里一起完成一件交付：Leader 接活、成员分工，结果都留在团队里。'
export const NEXT_STEP_SAMPLE_LABEL = '建第一条任务'
export const NEXT_STEP_SAMPLE_DETAIL = '梳理这个仓库的结构，给出 3 条改进建议'
export const NEXT_STEP_TALK_LABEL = '和 Leader 说话'

/**
 * The fields the entry reads, and nothing else: a `TeamView` satisfies it
 * structurally, and a test can build one without the whole aggregate.
 */
export interface NextStepTeam {
  readonly id: string
  readonly leaderSlotId: string
  readonly members: Readonly<Record<string, {
    readonly sessionId: string
    /** Last observed runtime state; a Leader already working needs no nudge. */
    readonly lastRuntimeState?: string | undefined
  }>>
  readonly tasks: Readonly<Record<string, unknown>>
  /** Optional Goal layer; a team that set an objective has already started. */
  readonly goals?: Readonly<Record<string, unknown>> | undefined
  /** Optional thread layer; a team that opened a conversation has started too. */
  readonly threads?: Readonly<Record<string, unknown>> | undefined
  /** Lifecycle state; only an active team can take an instruction. */
  readonly state?: string | undefined
  /** An archived team is not a new one: the entry never follows it there. */
  readonly archivedAt?: string | undefined
}

/**
 * Whether the entry belongs on screen.
 *
 * Derived from the team's own state (nothing started yet) instead of a stored
 * "seen the guide" flag: a flag would have to be written per team and per
 * browser, and a reload, a second device, or a cleared storage would show the
 * entry again. "Started" is wider than a task row: a Goal, a team thread, or a
 * Leader that is already running (or parked on an approval) all mean the team is
 * under way, so a template-created team — Goal and thread included — never gets
 * a second, duplicate instruction on its own row. A team with no resolvable
 * Leader session cannot send an instruction at all, so there the entry hides
 * instead of offering a button that would fail (`空团队` degrades to nothing
 * rather than an error). The same rule covers a team that is not active or is
 * already archived.
 */
export function showTeamNextStep(team: NextStepTeam): boolean {
  if (team.archivedAt !== undefined || team.state !== 'active') return false
  const started = Object.keys(team.tasks).length > 0
    || Object.keys(team.goals ?? {}).length > 0
    || Object.keys(team.threads ?? {}).length > 0
  if (started) return false
  const leaderState = team.members[team.leaderSlotId]?.lastRuntimeState
  if (leaderState === 'running' || leaderState === 'waiting_approval') return false
  return teamLeaderSessionId(team) !== undefined
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
  /** Open the Leader main session; provided by whichever host renders the card. */
  onOpenLeader: () => void
}): JSX.Element | null {
  const [sending, setSending] = useState(false)
  // Per-mount only: it stops a double click, not a deliberate second send after
  // a reload. Persisting it would be the "seen the guide" flag this entry
  // deliberately does not have; the team's own started state is the real switch.
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
          {sent ? '已交给 Leader…' : sending ? '正在创建…' : NEXT_STEP_SAMPLE_LABEL}
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenLeader}>
          {NEXT_STEP_TALK_LABEL}
        </Button>
      </div>
      {error !== undefined && <p className={css.nextStepError} role="alert">{error}</p>}
    </section>
  )
}
