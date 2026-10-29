import { useEffect } from 'react'
import { navigationErrorMessage, openSessionInCatalog } from './api.js'
import { reportNavigationError } from './store.js'
import { TeamCard } from './teams/TeamPanel.js'
import { GlobalOverview } from './global-overview.js'
import { requestToday } from './today-surface.js'
import { useAgentTeamData, type WorkspaceChoice } from './components.js'
import css from './TeamManage.module.css'
import type { TeamView } from '../transport/contracts.js'

export const TEAM_MANAGE_VIEW_ID = 'team-manage'
export const TEAM_MANAGE_VIEW_LABEL = '详情'
export const TEAM_MANAGE_VIEW_ORDER = 8

function teamForSession(teams: readonly TeamView[], sessionId: string | undefined): TeamView | undefined {
  if (sessionId === undefined) return undefined
  return teams.find(team => Object.values(team.members).some(member => member.sessionId === sessionId))
}

/** Native conversation view that hosts the existing TeamCard management UI. */
export function TeamManageView({
  sessionId,
  uiWorkspace,
  workspaces,
}: {
  sessionId?: string
  uiWorkspace?: {
    openSession: (sessionId: string) => void
    pickDirectory: () => Promise<string | null>
  }
  workspaces?: {
    create: (input: { path: string }) => Promise<{ workspaceId: string, path: string, title: string }>
  }
}): JSX.Element | null {
  const { teams, catalog, assistants, teamsLoading, teamsError, load } = useAgentTeamData(true)
  useEffect(() => {
    document.body.dataset.teamManage = 'true'
    return () => { delete document.body.dataset.teamManage }
  }, [])
  const team = teamForSession(teams, sessionId)
  if (team === undefined) return null
  const pickWorkspace = async (): Promise<WorkspaceChoice | null> => {
    if (uiWorkspace === undefined || workspaces === undefined) return null
    const path = await uiWorkspace.pickDirectory()
    if (path === null) return null
    const workspace = await workspaces.create({ path })
    return { id: workspace.workspaceId, path: workspace.path, title: workspace.title }
  }
  // Every team entry here is a Session navigation: an unresolvable Leader or a
  // refused Session is reported, never a click that silently does nothing.
  const openSession = (sessionId: string): void => {
    if (uiWorkspace === undefined) {
      reportNavigationError('无法打开该会话：当前环境不提供会话导航')
      return
    }
    void openSessionInCatalog(sessionId, { open: id => { uiWorkspace.openSession(id) } }).then(
      () => { reportNavigationError(undefined) },
      cause => { reportNavigationError(navigationErrorMessage(cause)) },
    )
  }
  return (
    <div className={css.page}>
      <details className={css.overviewDisclosure}>
        <summary className={css.overviewSummary}>全局总览</summary>
        <div className={css.overviewBody}>
          <GlobalOverview
            teams={teams}
            teamsLoading={teamsLoading}
            {...(teamsError === undefined ? {} : { teamsError })}
            onOpenToday={requestToday}
          />
        </div>
      </details>
      <TeamCard
        team={team}
        catalog={catalog}
        assistants={assistants}
        pickWorkspace={pickWorkspace}
        onChanged={load}
        onCloned={async () => { await load() }}
        onOpenSession={openSession}
        compact
      />
    </div>
  )
}
