import { useEffect, useMemo, useState } from 'react'
import { RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import { AnimatedModal } from './shared.js'
import { useAgentTeamData, type WorkspaceChoice } from './components.js'
import { TeamCard, TeamForm } from './teams/TeamPanel.js'
import { TeamActivityBoard } from './team-activity.js'
import { callAgentTeam } from './api.js'
import { closeTeamDialog, useAgentTeamUi, type ResetMemberContextTarget } from './store.js'
import css from './AgentTeam.module.css'

/**
 * Modal-only Team Mode surface. The conversation itself stays in the shipped
 * DSH Session view; this host never replaces the main panel.
 */
export function TeamModeDialogs({
  pickWorkspace,
  openSession,
}: {
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  openSession: (sessionId: string) => void
}): JSX.Element | null {
  const { dialog } = useAgentTeamUi()
  const [manageTab, setManageTab] = useState<'members' | 'activity'>('members')
  useEffect(() => { setManageTab('members') }, [dialog])
  const active = dialog !== undefined
  const { catalog, assistants, teams, loading, error, catalogLoading, load } = useAgentTeamData(true, active)
  const team = useMemo(
    () => (dialog?.kind === 'manage' ? teams.find(entry => entry.id === dialog.teamId) : undefined),
    [dialog, teams],
  )

  async function openTeam(teamId: string): Promise<void> {
    try {
      const value = await callAgentTeam('team.get', { id: teamId })
      const leader = value.members[value.leaderSlotId]
      if (leader !== undefined) openSession(leader.sessionId)
    } finally {
      closeTeamDialog()
    }
  }

  if (dialog === undefined) return null

  if (dialog.kind === 'reset-member') {
    return <ResetMemberContextDialog target={dialog} />
  }

  if (dialog.kind === 'manage') {
    if (team === undefined) {
      return (
        <AnimatedModal
          open
          onClose={closeTeamDialog}
          title="团队管理"
          closeLabel="关闭"
          className={css.teamDialog ?? ''}
          contentClassName={css.teamDialogContent ?? ''}
        >
          <div className={css.dialogEmpty}>{loading ? '正在读取团队…' : '该团队已不存在。'}</div>
        </AnimatedModal>
      )
    }
    return (
      <AnimatedModal
        open
        onClose={closeTeamDialog}
        title="团队管理"
        description="成员、模型、上下文与团队生命周期。"
        closeLabel="关闭"
        className={css.teamManageDialog ?? ''}
        contentClassName={css.teamManageDialogContent ?? ''}
      >
        <div className={css.teamManageTabs} role="tablist" aria-label="团队管理视图">
          <button
            type="button"
            role="tab"
            aria-selected={manageTab === 'members'}
            className={`${css.teamManageTab} ${manageTab === 'members' ? css.teamManageTabActive : ''}`}
            onClick={() => { setManageTab('members') }}
          >
            成员
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={manageTab === 'activity'}
            className={`${css.teamManageTab} ${manageTab === 'activity' ? css.teamManageTabActive : ''}`}
            onClick={() => { setManageTab('activity') }}
          >
            活动
          </button>
        </div>
        {manageTab === 'members'
          ? <TeamCard
              team={team}
              catalog={catalog}
              assistants={assistants}
              pickWorkspace={pickWorkspace}
              onChanged={load}
              onCloned={async teamId => { await load(); await openTeam(teamId) }}
              onOpenSession={sessionId => { closeTeamDialog(); openSession(sessionId) }}
              compact
            />
          : <div className={css.teamManageActivity}>
              <TeamActivityBoard team={team} />
            </div>}
      </AnimatedModal>
    )
  }

  return (
    <AnimatedModal
      open
      onClose={closeTeamDialog}
      title="新建团队"
      description="让多个 AI 助手组队协作。建议一个团队只专注一个目标，不同任务分开建。"
      closeLabel="关闭"
      className={css.teamDialog ?? ''}
      contentClassName={css.teamDialogContent ?? ''}
    >
      {error !== undefined && <div className={css.teamDialogError} role="alert">{error}</div>}
      <TeamForm
        catalog={catalog}
        catalogLoading={catalogLoading}
        assistants={assistants}
        pickWorkspace={pickWorkspace}
        onAssistantsChanged={load}
        onCancel={closeTeamDialog}
        onCreated={async teamId => { await openTeam(teamId) }}
      />
    </AnimatedModal>
  )
}

/**
 * Clear-context gate for one member Session, opened from the native row menu.
 * The write is the same `team.member.contextReset` the management dialog
 * already calls; only the entry point differs. A rejected write stays in this
 * dialog as its description, so the failure is visible without a second surface.
 */
function ResetMemberContextDialog({ target }: { target: ResetMemberContextTarget }): JSX.Element {
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()

  const clearContext = async (): Promise<void> => {
    setBusy(true)
    try {
      const team = await callAgentTeam('team.get', { id: target.teamId })
      // The row knows a Session, not a slot: resolve the slot from the live team
      // so a member replaced since the menu opened cannot be cleared by mistake.
      const member = Object.values(team.members)
        .find(entry => entry.sessionId === target.sessionId)
      if (member === undefined) throw new Error('该成员已不在团队中，无法清空上下文')
      await callAgentTeam(
        'team.member.contextReset',
        { teamId: target.teamId, slotId: member.id },
        team.revision,
      )
      closeTeamDialog()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <RiskConfirmation
      open
      title="清空该成员上下文"
      description={failure
        ?? `把「${target.memberName}」的 Session 换成全新的一份，${target.teamName} 的任务板、成员配置和工作区文件不变。`}
      acknowledgeLabel="我已了解该成员当前的上下文会被丢弃"
      cancelLabel="取消"
      closeLabel="关闭"
      confirmLabel={busy ? '清空中…' : '清空上下文'}
      acknowledged={acknowledged}
      disabled={busy}
      onAcknowledgedChange={setAcknowledged}
      onCancel={() => { if (!busy) closeTeamDialog() }}
      onConfirm={() => { void clearContext() }}
    />
  )
}
