import { MenuItemButton, IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionRowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { UseMenuOpenState } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { useSessionTeamFacts } from './session-row-leading.js'

/** What a row-menu entry needs from the plugin. */
export interface TeamMenuInjected {
  /** Open the team page of the team this Session belongs to. */
  openTeamPage: (teamId: string) => void
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
