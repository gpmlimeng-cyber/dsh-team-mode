import type { TeamAggregate, TeamMessage } from '../domain/types.js'

export interface TeamTurnDeps {
  getTeam(teamId: string): TeamAggregate
  listMessages(teamId: string): TeamMessage[]
  putMessage(message: TeamMessage): Promise<void>
  followup(sessionId: string, message: TeamMessage): void
  sessionState(sessionId: string): 'online' | 'offline' | 'running'
  hasMessage(sessionId: string, messageId: string): boolean
  warn(message: string, error?: unknown): void
}

interface ActiveTurn {
  slotId: string
  sessionId: string
  messageId: string
}

export class TeamTurnCoordinator {
  private readonly active = new Map<string, ActiveTurn>()
  private readonly chains = new Map<string, Promise<void>>()
  /** Sessions this coordinator has ever addressed, so release works after the active turn is gone. */
  private readonly sessions = new Map<string, string>()

  constructor(private readonly deps: TeamTurnDeps) {}

  submit(teamId: string, messageId: string): Promise<'delivered' | 'queued'> {
    return this.enqueue(teamId, async () => {
      await this.drainOnce(teamId, messageId)
      return this.deps.listMessages(teamId).find(message => message.id === messageId)?.deliveryState === 'delivered'
        ? 'delivered'
        : 'queued'
    })
  }

  /**
   * Release one session's turn, then drain. When the session is no longer the
   * active turn (turn/end raced ahead of the idle transition and an earlier
   * release already cleared it), still drain the session's team: the target
   * may have been `running` at the first attempt, and the idle event must be
   * able to retry delivery instead of leaving the queue stuck.
   */
  releaseSession(sessionId: string): Promise<void> {
    const teamId = [...this.active.entries()]
      .find(([, turn]) => turn.sessionId === sessionId)?.[0]
      ?? this.sessions.get(sessionId)
    if (teamId === undefined) {
      return Promise.resolve()
    }
    return this.enqueue(teamId, async () => {
      this.active.delete(teamId)
      await this.drainOnce(teamId)
    })
  }

  drain(teamId: string): Promise<void> {
    return this.enqueue(teamId, async () => {
      this.active.delete(teamId)
      await this.drainOnce(teamId)
    })
  }

  drainAll(teamIds: readonly string[]): Promise<void> {
    return teamIds.reduce(
      (chain, teamId) => chain.then(() => this.drain(teamId)),
      Promise.resolve(),
    )
  }

  activeSlot(teamId: string): string | undefined {
    return this.active.get(teamId)?.slotId
  }

  private enqueue<T>(teamId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(teamId) ?? Promise.resolve()
    const next = previous.then(run, run)
    this.chains.set(teamId, next.then(() => undefined, () => undefined))
    return next
  }

  private async drainOnce(teamId: string, preferredMessageId?: string): Promise<void> {
    if (this.active.has(teamId)) {
      return
    }
    let team: TeamAggregate
    try {
      team = this.deps.getTeam(teamId)
    } catch (error) {
      this.deps.warn(`turn drain skipped: cannot load team ${teamId}`, error)
      return
    }
    if (team.state !== 'active') {
      return
    }
    const queued = this.deps.listMessages(teamId)
      .filter(message => message.deliveryState === 'queued')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    const message = preferredMessageId !== undefined
      ? queued.find(candidate => candidate.id === preferredMessageId)
      : queued[0]
    if (message === undefined) {
      return
    }
    const slotId = message.recipient.slotId
    if (slotId === undefined) {
      this.deps.warn(`turn drain skipped: message ${message.id} has no recipient slot`)
      return
    }
    const member = team.members[slotId]
    if (member === undefined || member.desiredState === 'removing') {
      this.deps.warn(`turn drain skipped: message ${message.id} targets missing or removing slot ${slotId}`)
      return
    }
    const sessionId = member.sessionId
    this.sessions.set(sessionId, teamId)
    if (this.deps.sessionState(sessionId) !== 'online') {
      return
    }
    this.active.set(teamId, { slotId, sessionId, messageId: message.id })
    try {
      if (this.deps.hasMessage(sessionId, message.id)) {
        // Restart duplicate: the transcript already holds it; just mark delivered.
        await this.deps.putMessage({ ...message, deliveryState: 'delivered' })
      } else {
        this.deps.followup(sessionId, message)
        await this.deps.putMessage({ ...message, deliveryState: 'delivered' })
      }
    } catch (error) {
      // A failed attempt ends the turn attempt; the message stays queued.
      if (this.active.get(teamId)?.messageId === message.id) {
        this.active.delete(teamId)
      }
      this.deps.warn(`turn delivery failed for message ${message.id}; keeping it queued`, error)
    }
  }
}
