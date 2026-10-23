import { describe, expect, it } from 'vitest'

import type { TeamAggregate, TeamMessage } from '../src/domain/types.js'
import { TeamTurnCoordinator, type TeamTurnDeps } from '../src/runtime/team-turn-coordinator.js'

interface FakeMember {
  id: string
  sessionId: string
  desiredState?: 'online' | 'offline' | 'removing'
}

interface FakeTeam {
  state?: 'active' | 'deleting'
  members: Record<string, FakeMember>
  messages: TeamMessage[]
}

interface FollowupCall {
  sessionId: string
  messageId: string
}

function createFake(initial: Record<string, FakeTeam>) {
  const followups: FollowupCall[] = []
  const states = new Map<string, 'online' | 'offline' | 'running'>()
  const seen = new Map<string, Set<string>>()
  const warnings: string[] = []
  let failNextFollowup = false
  let failFollowupCount = 0

  for (const team of Object.values(initial)) {
    for (const member of Object.values(team.members)) {
      states.set(member.sessionId, member.desiredState === 'offline' ? 'offline' : 'online')
    }
  }

  const deps: TeamTurnDeps = {
    getTeam(teamId) {
      const team = initial[teamId]
      if (team === undefined) throw new Error(`missing team ${teamId}`)
      return {
        id: teamId,
        state: team.state ?? 'active',
        members: Object.fromEntries(Object.entries(team.members).map(([slotId, member]) => [
          slotId,
          { id: slotId, sessionId: member.sessionId, desiredState: member.desiredState ?? 'online' },
        ])),
      } as unknown as TeamAggregate
    },
    listMessages(teamId) {
      return initial[teamId]?.messages ?? []
    },
    async putMessage(message) {
      const team = initial[message.teamId]
      if (team === undefined) return
      const index = team.messages.findIndex(candidate => candidate.id === message.id)
      if (index >= 0) team.messages[index] = message
    },
    followup(sessionId, message) {
      followups.push({ sessionId, messageId: message.id })
      let bucket = seen.get(sessionId)
      if (bucket === undefined) {
        bucket = new Set()
        seen.set(sessionId, bucket)
      }
      bucket.add(message.id)
      // Only the first attempt fails; hasMessage has not seen the throw path yet.
      if (failNextFollowup && failFollowupCount === 0) {
        failFollowupCount += 1
        bucket.delete(message.id)
        throw new Error('followup exploded')
      }
    },
    sessionState(sessionId) {
      return states.get(sessionId) ?? 'offline'
    },
    hasMessage(sessionId, messageId) {
      return seen.get(sessionId)?.has(messageId) ?? false
    },
    warn(message) {
      warnings.push(message)
    },
  }

  return {
    deps,
    followups,
    warnings,
    team(teamId: string) {
      const found = initial[teamId]
      if (found === undefined) throw new Error(`missing fake team ${teamId}`)
      return found
    },
    setSessionState(sessionId: string, state: 'online' | 'offline' | 'running') {
      states.set(sessionId, state)
    },
    failNextFollowup() {
      failNextFollowup = true
    },
  }
}

function message(input: {
  id: string
  teamId: string
  slotId: string
  createdAt: string
  deliveryState?: TeamMessage['deliveryState']
}): TeamMessage {
  return {
    schemaVersion: 1,
    id: input.id,
    teamId: input.teamId,
    sender: { kind: 'user', id: 'user' },
    recipient: { kind: 'member', slotId: input.slotId },
    type: 'instruction',
    content: `content of ${input.id}`,
    attachments: [],
    readBy: [],
    deliveryState: input.deliveryState ?? 'queued',
    idempotencyKey: input.id,
    createdAt: input.createdAt,
  }
}

function teamWith(leaderSession: string, coderSession: string): FakeTeam {
  return {
    members: {
      L: { id: 'L', sessionId: leaderSession },
      a: { id: 'a', sessionId: coderSession },
    },
    messages: [],
  }
}

describe('TeamTurnCoordinator', () => {
  it('delivers the first submit and keeps the second queued with no second followup', async () => {
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(
      message({ id: 'm1', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }),
      message({ id: 'm2', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:01.000Z' }),
    )

    expect(await coordinator.submit('t1', 'm1')).toBe('delivered')
    expect(coordinator.activeSlot('t1')).toBe('L')
    expect(await coordinator.submit('t1', 'm2')).toBe('queued')
    expect(fake.followups).toEqual([{ sessionId: 'sL', messageId: 'm1' }])
    expect(team.messages.find(m => m.id === 'm2')?.deliveryState).toBe('queued')
  })

  it('releaseSession delivers exactly the next queued message in createdAt/id order', async () => {
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(
      message({ id: 'm1', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }),
      // Insertion order is reversed on purpose; createdAt then id decides.
      message({ id: 'm11', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:02.000Z' }),
      message({ id: 'm2', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:01.000Z' }),
    )

    await coordinator.submit('t1', 'm1')
    await coordinator.releaseSession('sL')
    expect(fake.followups).toEqual([
      { sessionId: 'sL', messageId: 'm1' },
      { sessionId: 'sa', messageId: 'm2' },
    ])
    expect(coordinator.activeSlot('t1')).toBe('a')
    await coordinator.releaseSession('sa')
    expect(fake.followups[2]).toEqual({ sessionId: 'sa', messageId: 'm11' })
    expect(team.messages.every(m => m.deliveryState === 'delivered')).toBe(true)
  })

  it('keeps messages queued while the target is offline and delivers after drain', async () => {
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    fake.setSessionState('sa', 'offline')
    team.messages.push(message({ id: 'm1', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:00.000Z' }))

    expect(await coordinator.submit('t1', 'm1')).toBe('queued')
    expect(fake.followups).toEqual([])
    fake.setSessionState('sa', 'online')
    await coordinator.drain('t1')
    expect(fake.followups).toEqual([{ sessionId: 'sa', messageId: 'm1' }])
  })

  it('keeps a failed followup queued, clears active, and does not skip it', async () => {
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(
      message({ id: 'm1', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }),
      message({ id: 'm2', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:01.000Z' }),
    )
    fake.failNextFollowup()

    expect(await coordinator.submit('t1', 'm1')).toBe('queued')
    expect(coordinator.activeSlot('t1')).toBeUndefined()
    expect(team.messages.find(m => m.id === 'm1')?.deliveryState).toBe('queued')
    expect(fake.warnings).toHaveLength(1)

    await coordinator.drain('t1')
    expect(fake.followups.map(call => call.messageId)).toEqual(['m1', 'm1'])
    expect(team.messages.find(m => m.id === 'm1')?.deliveryState).toBe('delivered')
    expect(team.messages.find(m => m.id === 'm2')?.deliveryState).toBe('queued')
  })

  it('skips followup when the session already has the message and marks it delivered', async () => {
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(message({ id: 'm1', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }))
    // Pre-seen message models a restart duplicate: session transcript already holds it.
    const seen = new Map<string, Set<string>>([['sL', new Set(['m1'])]])
    const guarded = { ...fake.deps, hasMessage: (sessionId: string, messageId: string) => seen.get(sessionId)?.has(messageId) ?? false }
    const guardedCoordinator = new TeamTurnCoordinator(guarded)

    expect(await guardedCoordinator.submit('t1', 'm1')).toBe('delivered')
    expect(fake.followups).toEqual([])
    expect(team.messages.find(m => m.id === 'm1')?.deliveryState).toBe('delivered')
  })

  it('drains multiple teams sequentially in drainAll', async () => {
    const fake = createFake({ t1: teamWith('sL', 'sa'), t2: teamWith('sL2', 'sb') })
    const first = fake.team('t1')
    const second = fake.team('t2')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    first.messages.push(message({ id: 'm1', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }))
    second.messages.push(message({ id: 'n1', teamId: 't2', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }))

    await coordinator.drainAll(['t1', 't2'])
    expect(fake.followups).toEqual([
      { sessionId: 'sL', messageId: 'm1' },
      { sessionId: 'sL2', messageId: 'n1' },
    ])
    expect(first.messages[0]?.deliveryState).toBe('delivered')
    expect(second.messages[0]?.deliveryState).toBe('delivered')
  })

  it('supports one independent active speaker per team', async () => {
    const fake = createFake({ t1: teamWith('sL', 'sa'), t2: teamWith('sL2', 'sb') })
    const first = fake.team('t1')
    const second = fake.team('t2')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    first.messages.push(
      message({ id: 'm1', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }),
      message({ id: 'm2', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:01.000Z' }),
    )
    second.messages.push(message({ id: 'n1', teamId: 't2', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }))

    await coordinator.submit('t1', 'm1')
    await coordinator.submit('t2', 'n1')
    expect(coordinator.activeSlot('t1')).toBe('L')
    expect(coordinator.activeSlot('t2')).toBe('L')
    await coordinator.submit('t1', 'm2')
    expect(coordinator.activeSlot('t1')).toBe('L')
    expect(second.messages[0]?.deliveryState).toBe('delivered')
  })

  it('leaves messages queued for archived or inactive teams without followup', async () => {
    const fake = createFake({ t1: { ...teamWith('sL', 'sa'), state: 'deleting' } })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(message({ id: 'm1', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }))

    expect(await coordinator.submit('t1', 'm1')).toBe('queued')
    expect(fake.followups).toEqual([])
    expect(team.messages[0]?.deliveryState).toBe('queued')
  })
})
