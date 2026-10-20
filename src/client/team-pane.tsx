import type { ReactNode } from 'react'
import css from './AgentTeam.module.css'

/**
 * Fixed Chat selection for an embedded Conversation occurrence, exactly like
 * the shipped subagent sidebar. Only the message-flow view is selected here:
 * the official composer is rendered by `conversation.content` itself
 * (`[data-composer-seat]` -> `conversation.composer` chain -> `InputBar`), and
 * its inputs resolve against this occurrence's SessionProvider binding.
 */
function FixedChatConversationView(props: { renderSlot: (name: string, payload?: Record<string, unknown>) => ReactNode }): JSX.Element {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/**
 * One official embedded conversation pane. Registered as `team.parallel.pane`
 * with `scope: 'session'`; SessionProvider supplies the session-scoped hooks.
 * The pane never renders a composer of its own: `conversation.content` owns the
 * official `conversation.composer` chain and the per-session input hub, so a
 * blank member still gets the official hero composer instead of a custom one.
 */
export function TeamParallelPane(props: any): JSX.Element {
  const session = props.useSession((value: any) => value)
  const conversation = props.useConversation((value: any) => value)
  const shellPhase = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
    ? 'active'
    : session.promptAttempted
      ? 'engaging'
      : 'blank'
  const summaryBlank = props.useSessions((state: any) => state.byId[props.sessionId]?.blank)
  const parentAvailabilityPending = session.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === void 0
  const settling = (shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true)
    || parentAvailabilityPending
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  if (typeof props.renderFactorySlot !== 'function') {
    return <div className={css.teamPaneError}>无法加载官方会话内容</div>
  }
  return (
    <div className={css.teamPaneConversation}>
      {props.renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero },
        { slots: { views: FixedChatConversationView } },
      )}
    </div>
  )
}
