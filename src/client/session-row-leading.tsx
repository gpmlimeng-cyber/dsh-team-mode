import { useSyncExternalStore } from 'react'
import type { SessionRowScheduleOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { sessionTeamLookup, type SessionTeamFacts } from './team-badge-data.js'
import { teamAvatarIndex } from './team-avatar.js'
import { teamIdentityColor } from './team-identity.js'
import css from './session-row.module.css'

type SessionId = SessionRowScheduleOwnerProps['sessionId']

/**
 * One projection per `team.list` read, shared by every mounted row seat. The
 * seat owners hand a row its Session id and nothing else, so this is the one
 * place a row learns its team facts — `sessionTeamLookup` stays the only
 * derivation, and a row can never invent a second count vocabulary.
 */
let lookup: ReadonlyMap<string, SessionTeamFacts> = new Map()
const listeners = new Set<() => void>()
let stop: (() => void) | undefined

function publish(next: ReadonlyMap<string, SessionTeamFacts>): void {
  lookup = next
  for (const listener of listeners) listener()
}

function readSnapshot(): ReadonlyMap<string, SessionTeamFacts> {
  return lookup
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (stop === undefined) {
    const load = (): void => {
      void callAgentTeam('team.list').then(
        value => { publish(sessionTeamLookup(value.items)) },
        // A failed read keeps the last good projection; the next change event
        // or the next mount reads again.
        () => {},
      )
    }
    load()
    stop = subscribeAgentTeam(load, () => {}, load)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    stop?.()
    stop = undefined
  }
}

/** The team facts for one member Session row, or undefined for an ordinary Session. */
export function useSessionTeamFacts(sessionId: SessionId): SessionTeamFacts | undefined {
  const facts = useSyncExternalStore(subscribe, readSnapshot, readSnapshot)
  return facts.get(sessionId)
}

/** Member identity colour from the shipped palette; name-derived, so reordering never repaints a member. */
function memberColor(facts: SessionTeamFacts): string {
  return teamIdentityColor(teamAvatarIndex(`${facts.teamId}/${facts.memberName}`))
}

/**
 * Leading seat of one Session row: the member's identity dot. The host mounts
 * this seat only while the row's primary state is idle and leaves it blank for
 * archived rows, so the seat itself never judges status. Content only — no
 * click, no Session activation.
 */
export function LineLeading({ sessionId }: SessionRowScheduleOwnerProps): JSX.Element | null {
  const facts = useSessionTeamFacts(sessionId)
  if (facts === undefined) return null
  // The member colour is mixed with a semantic token here rather than written
  // into the stylesheet, so one seat carries one identity and the dot still
  // follows the active theme.
  const background = `color-mix(in oklab, ${memberColor(facts)} 72%, var(--dsw-alias-brand-primary))`
  return <span className={css.leadingDot} style={{ backgroundColor: background }} aria-hidden="true" />
}
