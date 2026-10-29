import { useEffect, useMemo, useState } from 'react'
import { AnimatedModal } from './shared.js'
import { useAgentTeamData, type WorkspaceChoice } from './components.js'
import { TeamCard, TeamForm } from './teams/TeamPanel.js'
import { callAgentTeam } from './api.js'
import type { AssistantInstanceView } from '../transport/contracts.js'
import { closeTeamDialog, useAgentTeamUi } from './store.js'
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
  const active = dialog !== undefined
  const { catalog, assistants, teams, loading, error, catalogLoading, load } = useAgentTeamData(true, active)
  // Coworkers are a different collection from Assistant templates: the people
  // this workspace built are instances, and only an instance can be linked to a
  // team member slot. Read them alongside the templates the builder also offers.
  const [instances, setInstances] = useState<readonly AssistantInstanceView[]>([])
  useEffect(() => {
    if (!active) return
    let live = true
    void callAgentTeam('assistant.instance.list', undefined)
      .then(value => { if (live) setInstances(value.items) })
      .catch(() => { if (live) setInstances([]) })
    return () => { live = false }
  }, [active])
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
        <TeamCard
          team={team}
          catalog={catalog}
          assistants={assistants}
          pickWorkspace={pickWorkspace}
          onChanged={load}
          onCloned={async teamId => { await load(); await openTeam(teamId) }}
          onOpenSession={sessionId => { closeTeamDialog(); openSession(sessionId) }}
          compact
        />
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
        instances={instances}
        pickWorkspace={pickWorkspace}
        onAssistantsChanged={load}
        onCancel={closeTeamDialog}
        onCreated={async teamId => { await openTeam(teamId) }}
      />
    </AnimatedModal>
  )
}
