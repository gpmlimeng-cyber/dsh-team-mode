import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { useEffect, useState } from 'react'
import type { AgentTeamClientContext } from './client-context.js'
import {
  AgentTeamSettingsSection,
  type WorkspaceChoice,
} from './components.js'
import { SidebarPortal } from './sidebar.js'
import { TeamModeDialogs } from './team-dialogs.js'
import { TeamParallelHost, TeamParallelView } from './team-parallel.js'
import { TEAM_MANAGE_VIEW_ID, TEAM_MANAGE_VIEW_LABEL, TEAM_MANAGE_VIEW_ORDER, TeamManageView } from './team-manage.js'
import { TeamSessionHider } from './team-session-hider.js'
import { TeamParallelPane } from './team-pane.js'
import { TeamMemberHeroHint, TeamMemberSwitcher } from './team-member-chrome.js'
import {
  TEAM_BOARD_VIEW_ID,
  TEAM_BOARD_VIEW_LABEL,
  TEAM_BOARD_VIEW_ORDER,
  TeamBoardView,
} from './team-board.js'
import { callAgentTeam } from './api.js'
import { installTeamLocale, type TeamLocaleContext } from './team-i18n.js'

export const name = 'dsh-team-mode-client'
export const inject = ['slots', 'workspaces', 'uiWorkspace', 'sessions', 'layout', 'locale']

export function apply(ctx: AgentTeamClientContext): void {
  installTeamLocale(ctx as unknown as TeamLocaleContext)
  // Slot names for the conversation package are shipped without .d.ts in this
  // installation; the runtime catalog still validates them. Keep the loose
  // face local to the two conversation-view registrations.
  const slotApi = ctx.slots as unknown as {
    inject: (name: string, register: () => unknown) => (() => void) | void
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dsh-team-mode', order: 40, label: '团队' },
    AgentTeamSettingsSection,
  ))
  const openSession = (sessionId: string): void => {
    // Navigation only. The right sidebar follows the shell's remembered user
    // state; Team Mode must not force it open or select a tab.
    ctx.uiWorkspace.openSession(sessionId as never)
  }
  const pickWorkspace = async (): Promise<WorkspaceChoice | null> => {
    const path = await ctx.uiWorkspace.pickDirectory()
    if (path === null) return null
    const workspace = await ctx.workspaces.create({ path })
    return {
      id: workspace.workspaceId,
      path: workspace.path,
      title: workspace.title,
    }
  }
  const TeamModeDialogsHost = (): JSX.Element => (
    <TeamModeDialogs pickWorkspace={pickWorkspace} openSession={openSession} />
  )
  const openTeamPage = (teamId: string): void => {
    void callAgentTeam('team.list')
      .then(value => {
        const team = value.items.find(candidate => candidate.id === teamId)
        const leader = team === undefined ? undefined : team.members[team.leaderSlotId]
        if (leader === undefined) return
        openSession(leader.sessionId)
      })
      .catch(() => undefined)
  }
  const SidebarTeamHost = (): JSX.Element => (
    <>
      <TeamSessionHider />
      <SidebarPortal openSession={openSession} openTeamPage={openTeamPage} />
    </>
  )

  // Only expose the two team views while a team member Session is active.
  // Registration is dynamic because `conversation.view` is a global list and
  // ordinary Sessions must not grow Team Mode tabs.
  const TeamViewTabs = ({ sessionId }: { sessionId?: string }): null => {
    const [teamSession, setTeamSession] = useState(false)
    useEffect(() => {
      if (sessionId === undefined) {
        setTeamSession(false)
        return
      }
      let live = true
      void callAgentTeam('team.list')
        .then(value => {
          if (!live) return
          setTeamSession(value.items.some(team =>
            Object.values(team.members).some(member => member.sessionId === sessionId),
          ))
        })
        .catch(() => { if (live) setTeamSession(false) })
      return () => { live = false }
    }, [sessionId])

    useEffect(() => {
      if (!teamSession) return
      const disposers: Array<() => void> = []
      const register = (id: string, label: string, order: number, component: never): void => {
        const dispose = slotApi.inject('conversation.view', () => slotApi.register({
          name: 'conversation.view',
          id,
          order,
          label,
          inject: () => ({
            uiWorkspace: ctx.uiWorkspace,
            workspaces: ctx.workspaces,
          }),
        }, component))
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      register('team-parallel', '并行', 6, TeamParallelView as never)
      register(TEAM_BOARD_VIEW_ID, TEAM_BOARD_VIEW_LABEL, TEAM_BOARD_VIEW_ORDER, TeamBoardView as never)
      register(TEAM_MANAGE_VIEW_ID, TEAM_MANAGE_VIEW_LABEL, TEAM_MANAGE_VIEW_ORDER, TeamManageView as never)
      return () => { for (const dispose of disposers) dispose() }
    }, [teamSession])
    return null
  }

  slotApi.inject('shell.overlay', () => slotApi.register({
    name: 'shell.overlay',
    id: 'dsh-team-mode-parallel-host',
    order: 30,
    label: '团队并行',
    children: {
      'team.parallel.pane': { kind: 'single', scope: 'session' },
    },
  }, (props: Record<string, unknown>) => (
    <TeamParallelHost
      {...props}
      sessions={(ctx as unknown as { sessions: never }).sessions}
    />
  )))

  slotApi.inject('team.parallel.pane', () => slotApi.register({
    name: 'team.parallel.pane',
  }, TeamParallelPane))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-team-mode-dialogs',
    order: 20,
    label: '团队',
  }, TeamModeDialogsHost))

  // Additive sidebar group: keep the shipped WorkspaceBrowser untouched and
  // mount the “团队” section above its slot DOM anchor. This avoids replacing
  // the single `sidebar.workspaces` occupant (which owns its own store/hooks).
  slotApi.inject('conversation.session.header.utilities', () => slotApi.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-team-mode-view-tabs',
    order: 90,
    label: '团队视图',
  }, TeamViewTabs))

  slotApi.inject('conversation.session.header.actions', () => slotApi.register({
    name: 'conversation.session.header.actions',
    id: 'dsh-team-mode-member-switcher',
    order: 20,
    label: '团队成员',
    inject: () => ({
      openSession: (sessionId: string) => { ctx.uiWorkspace.openSession(sessionId as never) },
    }),
  }, TeamMemberSwitcher as never))

  slotApi.inject('conversation.hero.options', () => slotApi.register({
    name: 'conversation.hero.options',
    id: 'dsh-team-mode-member-hint',
    order: 80,
    label: '团队提示',
  }, TeamMemberHeroHint as never))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-team-mode-sidebar',
    order: 10,
    label: '团队',
  }, SidebarTeamHost))
}
