import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamClientContext } from './client-context.js'
import {
  AgentTeamSettingsSection,
  type WorkspaceChoice,
} from './components.js'
import { SidebarPortal, useSurfaceMode } from './sidebar.js'
import { SidebarLayoutSection } from './sidebar-layout-section.js'
import { TeamMainAgentPanel } from './team-main-agent.js'
import {
  closeTeamPanel,
  panelToggleAvailable,
  reportNavigationError,
  toggleTeamPanel,
  useTeamPanelOpen,
} from './store.js'
import { SessionRowHider } from './session-row-hider.js'
import { AssistantSessionTitle, AssistantSessionTitleHost } from './assistant-session-title.js'
import { TeamModeDialogs } from './team-dialogs.js'
import { TeamParallelHost, TeamMentionAction, TeamParallelView } from './team-parallel.js'
import { TeamTriggerEnhancer } from './team-trigger-enhancer.js'
import { TEAM_MANAGE_VIEW_ID, TEAM_MANAGE_VIEW_LABEL, TEAM_MANAGE_VIEW_ORDER, TeamManageView } from './team-manage.js'
import { TeamParallelPane } from './team-pane.js'
import { TeamMemberHeroHint, TeamMemberSwitcher } from './team-member-chrome.js'
import {
  TEAM_BOARD_VIEW_ID,
  TEAM_BOARD_VIEW_LABEL,
  TEAM_BOARD_VIEW_ORDER,
  TeamBoardView,
  keepNativeConversationTab,
} from './team-board.js'
import {
  callAgentTeam,
  navigationErrorMessage,
  openSessionInCatalog,
  subscribeAgentTeam,
  teamLeaderSessionId,
} from './api.js'
import { installTeamLocale, type TeamLocaleContext } from './team-i18n.js'
import type { TeamView } from '../transport/contracts.js'

export const name = 'dsh-team-mode-client'
export const inject = ['slots', 'workspaces', 'uiWorkspace', 'sessions', 'layout', 'locale']

type SettingsSectionOwnerProps = Parameters<typeof AgentTeamSettingsSection>[0]

/**
 * One `settings.section` occupant: the shipped 团队 section plus the 侧栏布局
 * editor below it, so the layout settings live under 设置 → 团队.
 */
function TeamSettingsSection(props: SettingsSectionOwnerProps): JSX.Element {
  return (
    <>
      <AgentTeamSettingsSection {...props} />
      <SidebarLayoutSection />
    </>
  )
}

/** The team whose member Session is currently open, from the existing team list. */
function useActiveTeam(sessionId: string | undefined): TeamView | undefined {
  const [team, setTeam] = useState<TeamView>()
  useEffect(() => {
    if (sessionId === undefined) {
      setTeam(undefined)
      return
    }
    let live = true
    const load = (): void => {
      void callAgentTeam('team.list')
        .then(value => {
          if (!live) return
          setTeam(value.items.find(candidate =>
            Object.values(candidate.members).some(member => member.sessionId === sessionId)))
        })
        .catch(() => { if (live) setTeam(undefined) })
    }
    load()
    const unsubscribe = subscribeAgentTeam(load, () => {}, load)
    return () => {
      live = false
      unsubscribe()
    }
  }, [sessionId])
  return team
}

/** The conversation currently on screen; the panel follows it without navigation. */
function useConversationSessionId(): string | undefined {
  const [sessionId, setSessionId] = useState<string>()
  useEffect(() => {
    const read = (): void => {
      const element = document.querySelector<HTMLElement>('[data-conversation-session]')
      setSessionId(element?.dataset.conversationSession)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-conversation-session'],
    })
    return () => { observer.disconnect() }
  }, [])
  return sessionId
}

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
    TeamSettingsSection,
  ))
  // The shell's Session controller only opens Sessions its client catalog has
  // pulled. Team and Assistant Sessions are created on the Host, so a page that
  // was already open does not know the id yet and `openSession` throws
  // `sessions.retain: unknown session`. Pull the catalog once and retry; any
  // remaining failure is shown instead of swallowed.
  const sessions = (ctx as unknown as {
    sessions?: { refresh?: () => Promise<unknown> }
  }).sessions
  const openSession = (sessionId: string): void => {
    // Navigation only. The right sidebar follows the shell's remembered user
    // state; Team Mode must not force it open or select a tab.
    void openSessionInCatalog(sessionId, {
      open: id => { ctx.uiWorkspace.openSession(id as never) },
      ...(typeof sessions?.refresh === 'function'
        ? { refresh: () => sessions.refresh!() }
        : {}),
    }).then(
      () => { reportNavigationError(undefined) },
      cause => { reportNavigationError(navigationErrorMessage(cause)) },
    )
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
  const TeamModeDialogsHost = (): JSX.Element | null => {
    const mode = useSurfaceMode()
    if (mode !== 'team') return null
    return <TeamModeDialogs pickWorkspace={pickWorkspace} openSession={openSession} />
  }
  // A team's default entry is the Leader's main Session on the shipped chat
  // tab. The 群聊/看板 views stay registered and remain an explicit tab choice.
  // `team.get` is the authoritative Leader: the row's cached aggregate can be a
  // revision behind a Leader change, and an unresolvable Leader is an error the
  // user must see rather than a click that does nothing.
  const openTeamPage = (teamId: string): void => {
    void callAgentTeam('team.get', { id: teamId }).then(
      value => {
        const sessionId = teamLeaderSessionId(value)
        if (sessionId === undefined) {
          reportNavigationError('无法打开该团队：还没有可用的 Leader 会话')
          return
        }
        keepNativeConversationTab(sessionId)
        openSession(sessionId)
      },
      cause => { reportNavigationError(navigationErrorMessage(cause)) },
    )
  }
  const openNativeLanding = (): void => { ctx.uiWorkspace.startSession() }
  const SidebarTeamHost = (): JSX.Element => (
    <>
      <TeamTriggerEnhancer />
      {/* Row hiding is mode-independent: native mode must never surface a team
          member Session row. */}
      <SessionRowHider />
      <SidebarPortal
        openSession={openSession}
        openTeamPage={openTeamPage}
        onOpenNativeLanding={openNativeLanding}
      />
    </>
  )

  const TeamPanelToggle = (): JSX.Element => {
    const open = useTeamPanelOpen()
    return (
      <Button
        type="button"
        size="sm"
        variant={open ? 'outline' : 'ghost'}
        aria-pressed={open}
        onClick={toggleTeamPanel}
        title={open ? '收起团队面板' : '打开团队面板'}
      >
        团队面板
      </Button>
    )
  }

  const TeamPanelSessionHost = (): JSX.Element | null => {
    const sessionId = useConversationSessionId()
    const team = useActiveTeam(sessionId)
    if (sessionId === undefined || team === undefined) return null
    if (!Object.values(team.members).some(member => member.sessionId === sessionId)) return null
    const openMember = (slotId: string): void => {
      const member = team.members[slotId]
      if (member !== undefined) openSession(member.sessionId)
    }
    return (
      <TeamMainAgentPanel
        team={team}
        open
        onClose={closeTeamPanel}
        onOpenMember={openMember}
        onOpenTeam={() => { openTeamPage(team.id) }}
      />
    )
  }

  const TeamPanelHost = (): JSX.Element | null => {
    const mode = useSurfaceMode()
    const open = useTeamPanelOpen()
    if (mode !== 'team' || !open) return null
    return <TeamPanelSessionHost />
  }

  // Only expose the two team views while a team member Session is active.
  // Registration is dynamic because `conversation.view` is a global list and
  // ordinary Sessions must not grow Team Mode tabs.
  const TeamViewTabs = ({ sessionId }: { sessionId?: string }): JSX.Element | null => {
    const [teamSession, setTeamSession] = useState(false)
    const mode = useSurfaceMode()
    useEffect(() => {
      if (sessionId === undefined || mode !== 'team') {
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
    }, [mode, sessionId])

    useEffect(() => {
      if (!teamSession || mode !== 'team') return
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
      register('team-parallel', '群聊', 6, TeamParallelView as never)
      register(TEAM_BOARD_VIEW_ID, TEAM_BOARD_VIEW_LABEL, TEAM_BOARD_VIEW_ORDER, TeamBoardView as never)
      register(TEAM_MANAGE_VIEW_ID, TEAM_MANAGE_VIEW_LABEL, TEAM_MANAGE_VIEW_ORDER, TeamManageView as never)
      return () => { for (const dispose of disposers) dispose() }
    }, [mode, teamSession])
    return panelToggleAvailable(teamSession, mode) ? <TeamPanelToggle /> : null
  }

  const TeamParallelOverlay = (props: Record<string, unknown>): JSX.Element | null => {
    const mode = useSurfaceMode()
    if (mode !== 'team') return null
    return (
      <TeamParallelHost
        {...props}
        sessions={(ctx as unknown as { sessions: never }).sessions}
      />
    )
  }

  slotApi.inject('shell.overlay', () => slotApi.register({
    name: 'shell.overlay',
    id: 'dsh-team-mode-parallel-host',
    order: 30,
    label: '团队并行',
    children: {
      'team.parallel.pane': { kind: 'single', scope: 'session' },
    },
  }, TeamParallelOverlay))

  slotApi.inject('team.parallel.pane', () => slotApi.register({
    name: 'team.parallel.pane',
  }, TeamParallelPane))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-team-mode-dialogs',
    order: 20,
    label: '团队',
  }, TeamModeDialogsHost))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-team-mode-panel',
    order: 25,
    label: '团队面板',
  }, TeamPanelHost))

  // Additive sidebar group: keep the shipped WorkspaceBrowser untouched and
  // mount the “团队” section above its slot DOM anchor. This avoids replacing
  // the single `sidebar.workspaces` occupant (which owns its own store/hooks).
  slotApi.inject('conversation.session.header.utilities', () => slotApi.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-team-mode-view-tabs',
    order: 90,
    label: '团队视图',
  }, TeamViewTabs))

  // `conversation.input.left` is a list slot inside the official composer bar.
  // This entry renders only where the 群聊 pane provides its mention scope, so
  // the native composer is reused in place — never replaced, re-mounted or
  // submitted from here.
  slotApi.inject('conversation.input.left', () => slotApi.register({
    name: 'conversation.input.left',
    id: 'dsh-team-mode-mention',
    order: 60,
    label: '提及成员',
  }, TeamMentionAction))

  // Register the lineage title only while the active Session is an Assistant
  // main Session. The host below is always mounted in the utilities list slot;
  // outside that condition nothing occupies the single lineage slot, so the
  // shipped subagent header stays untouched.
  const registerAssistantTitle = (): (() => void) | void => slotApi.inject(
    'conversation.session.header.lineage',
    () => slotApi.register({
      name: 'conversation.session.header.lineage',
      // The shipped subagent header holds the default priority and a higher
      // number would be shadowed; this entry exists only for assistant Sessions.
      priority: -10,
      label: '助手会话标题',
    }, AssistantSessionTitle as never),
  )
  slotApi.inject('conversation.session.header.utilities', () => slotApi.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-team-mode-assistant-title',
    order: 95,
    label: '助手会话标题',
    inject: () => ({ registerTitle: registerAssistantTitle }),
  }, AssistantSessionTitleHost as never))

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
