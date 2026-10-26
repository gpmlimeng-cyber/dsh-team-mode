import {
  MenuItemButton,
  IconRefreshOutlineRegular,
  IconUsersOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionRowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { UseMenuOpenState } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { useSessionTeamFacts } from './session-row-leading.js'
import type { ResetMemberContextTarget } from './store.js'

/** What a row-menu entry needs from the plugin. */
export interface TeamMenuInjected {
  /** Open the team page of the team this Session belongs to. */
  openTeamPage: (teamId: string) => void
  /** Open the clear-context gate for this member Session. */
  openResetMemberContext: (target: ResetMemberContextTarget) => void
}

/** Props every row-menu entry receives: row identity, its inject, and the menu's open state. */
export type RowMenuEntryProps = SessionRowOwnerProps & TeamMenuInjected & {
  useMenuOpenState: UseMenuOpenState
}

/**
 * Row-menu entry: open the owning team's page. Only team Sessions get the row —
 * an ordinary Session renders nothing and the shipped menu is untouched.
 */
export function TeamDetailMenuItem(
  { sessionId, openTeamPage, useMenuOpenState }: RowMenuEntryProps,
): JSX.Element | null {
  const facts = useSessionTeamFacts(sessionId)
  const [, setMenuOpen] = useMenuOpenState()
  if (facts === undefined) return null
  return (
    <MenuItemButton
      icon={<IconUsersOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        openTeamPage(facts.teamId)
      }}
    >
      打开团队详情
    </MenuItemButton>
  )
}

/**
 * Row-menu entry: clear this member's context. Destructive, so the row is
 * grouped and danger-coloured and the confirmation is the primitive
 * `RiskConfirmation` gate hosted by `TeamModeDialogs` — the menu itself only
 * names the target and closes.
 */
export function TeamResetContextMenuItem(
  { sessionId, openResetMemberContext, useMenuOpenState }: RowMenuEntryProps,
): JSX.Element | null {
  const facts = useSessionTeamFacts(sessionId)
  const [, setMenuOpen] = useMenuOpenState()
  if (facts === undefined) return null
  return (
    <MenuItemButton
      danger
      separatorBefore
      icon={<IconRefreshOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        openResetMemberContext({
          teamId: facts.teamId,
          teamName: facts.teamName,
          sessionId,
          memberName: facts.memberName,
        })
      }}
    >
      清空该成员上下文
    </MenuItemButton>
  )
}
