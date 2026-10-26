import { Button, IconCompareSplitOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionRowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { useSessionTeamFacts } from './session-row-leading.js'

/** What the row action needs from the plugin: navigation only, no team mutation. */
export interface RowActionInjected {
  /** Land the row's Session on the team 群聊 (parallel) tab, then open it. */
  openParallel: (sessionId: string) => void
}

/**
 * Hover button at the end of a member Session row: opens that Session on the
 * team's 群聊 tab. Ordinary Sessions get no button at all, so the native strip
 * stays exactly as shipped for everything outside a team.
 */
export function RowOpenParallel(
  { sessionId, openParallel }: SessionRowOwnerProps & RowActionInjected,
): JSX.Element | null {
  const facts = useSessionTeamFacts(sessionId)
  if (facts === undefined) return null
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<IconCompareSplitOutlineRegular size={14} />}
      title={`打开「${facts.teamName}」群聊`}
      aria-label={`打开「${facts.teamName}」群聊`}
      onClick={() => { openParallel(sessionId) }}
    />
  )
}
