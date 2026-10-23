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
  recipient?: TeamMessage['recipient']
  type?: TeamMessage['type']
  sender?: TeamMessage['sender']
}): TeamMessage {
  return {
    schemaVersion: 1,
    id: input.id,
    teamId: input.teamId,
    sender: input.sender ?? { kind: 'user', id: 'user' },
    recipient: input.recipient
      ?? (input.slotId === 'L'
        ? { kind: 'leader', slotId: input.slotId }
        : { kind: 'member', slotId: input.slotId }),
    type: input.type ?? 'instruction',
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

  it('ignores a late release from an old speaker while another member is active', async () => {
    // t4 blocker: a stale idle/turn/end from session B must not clear the
    // active turn that session A now owns, nor drain the next message.
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(
      message({ id: 'm1', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }),
      message({ id: 'm2', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:01.000Z' }),
      message({ id: 'm3', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:02.000Z' }),
    )
    // sa never addressed yet, so releaseSession('sa') has no team to drain.
    await coordinator.submit('t1', 'm1')
    await coordinator.releaseSession('sL')
    expect(fake.followups).toEqual([
      { sessionId: 'sL', messageId: 'm1' },
      { sessionId: 'sa', messageId: 'm2' },
    ])
    // m3 is queued behind m2; sa now owns the active turn.
    expect(team.messages.find(m => m.id === 'm3')?.deliveryState).toBe('queued')
    // A late release from the old leader session must be a no-op.
    await coordinator.releaseSession('sL')
    expect(coordinator.activeSlot('t1')).toBe('a')
    expect(team.messages.find(m => m.id === 'm3')?.deliveryState).toBe('queued')
    expect(fake.followups).toHaveLength(2)

    // Releasing the current owner still drains the queue.
    await coordinator.releaseSession('sa')
    expect(fake.followups[2]).toEqual({ sessionId: 'sL', messageId: 'm3' })
    expect(team.messages.every(m => m.deliveryState === 'delivered')).toBe(true)
  })

  it('keeps a non-head submit queued until the head is delivered', async () => {
    // F2: submit must never deliver a newer record ahead of an older queued one.
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(
      message({ id: 'm1', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:00.000Z' }),
      message({ id: 'm2', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:01.000Z' }),
    )
    fake.setSessionState('sa', 'offline')

    // Submitting the newer head-of-nothing record stays queued while the older
    // record's target is offline; neither jumps the other.
    expect(await coordinator.submit('t1', 'm2')).toBe('queued')
    expect(fake.followups).toEqual([])

    fake.setSessionState('sa', 'online')
    await coordinator.drain('t1')
    // The oldest record (m1) is delivered first, not m2.
    expect(fake.followups).toEqual([{ sessionId: 'sa', messageId: 'm1' }])
    expect(team.messages.find(m => m.id === 'm2')?.deliveryState).toBe('queued')
  })

  it('marks a restart duplicate delivered without holding the turn and keeps draining', async () => {
    // F1: a hasMessage=true record is already in the transcript; marking it
    // delivered must not take the active turn, or the next head never delivers.
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(
      // Already spliced into the leader transcript (restart duplicate).
      message({ id: 'dup', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }),
      message({ id: 'next', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:01.000Z' }),
    )
    // Pre-seen only for the duplicate id.
    const seen = new Map<string, Set<string>>([['sL', new Set(['dup'])]])
    const guarded = {
      ...fake.deps,
      hasMessage: (sessionId: string, messageId: string) => seen.get(sessionId)?.has(messageId) ?? false,
    }
    const guardedCoordinator = new TeamTurnCoordinator(guarded)

    expect(await guardedCoordinator.submit('t1', 'dup')).toBe('delivered')
    // No release event: the duplicate must not have held the turn, so the
    // real successor delivered in the same drain without any release.
    expect(fake.followups).toEqual([{ sessionId: 'sL', messageId: 'next' }])
    expect(team.messages.find(m => m.id === 'dup')?.deliveryState).toBe('delivered')
    expect(team.messages.find(m => m.id === 'next')?.deliveryState).toBe('delivered')
  })

  it('skips queued broadcast and system records and delivers the next turn message', async () => {
    // F2: broadcasts and system notices are not turn records; a queued one at
    // the head must be skipped, not returned on, so the next turn still runs.
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(
      message({
        id: 'b1',
        teamId: 't1',
        slotId: '',
        createdAt: '2026-10-23T10:00:00.000Z',
        recipient: { kind: 'broadcast' },
      }),
      message({
        id: 's1',
        teamId: 't1',
        slotId: 'L',
        createdAt: '2026-10-23T10:00:01.000Z',
        type: 'system',
        sender: { kind: 'system', id: 'dsh-team-mode' },
      }),
      message({ id: 'turn1', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:02.000Z' }),
    )

    await coordinator.drain('t1')

    expect(fake.followups).toEqual([{ sessionId: 'sa', messageId: 'turn1' }])
    expect(team.messages.find(m => m.id === 'turn1')?.deliveryState).toBe('delivered')
    // The non-turn records stay on their dispatcher path, untouched.
    expect(team.messages.find(m => m.id === 'b1')?.deliveryState).toBe('queued')
    expect(team.messages.find(m => m.id === 's1')?.deliveryState).toBe('queued')
  })

  it('drains the session team on release even after the active turn is gone', async () => {
    // turn/end can race ahead of the idle transition: the first release clears
    // the active turn while the target is still `running`, and the later idle
    // release must still find the team and retry delivery.
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(
      message({ id: 'm1', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }),
      message({ id: 'm2', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:01.000Z' }),
    )
    fake.setSessionState('sa', 'running')
    await coordinator.submit('t1', 'm1')
    await coordinator.releaseSession('sL')
    expect(fake.followups).toEqual([
      { sessionId: 'sL', messageId: 'm1' },
      // sa is running: m2 stays queued and no followup happened yet.
    ])
    expect(team.messages.find(m => m.id === 'm2')?.deliveryState).toBe('queued')

    fake.setSessionState('sa', 'online')
    // Second release for the same (now inactive) session still drains the team.
    await coordinator.releaseSession('sL')
    expect(fake.followups).toEqual([
      { sessionId: 'sL', messageId: 'm1' },
      { sessionId: 'sa', messageId: 'm2' },
    ])
    expect(team.messages.find(m => m.id === 'm2')?.deliveryState).toBe('delivered')
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

  it('fails a turn whose recipient is gone or removing and keeps draining', async () => {
    // A permanently undeliverable head used to stall every later turn. The
    // record must reach an explicit terminal state and the queue must advance.
    const fake = createFake({
      t1: {
        members: {
          L: { id: 'L', sessionId: 'sL' },
          a: { id: 'a', sessionId: 'sa' },
          gone: { id: 'gone', sessionId: 'sgone', desiredState: 'removing' },
        },
        messages: [],
      },
    })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(
      message({ id: 'missing', teamId: 't1', slotId: 'ghost', createdAt: '2026-10-23T10:00:00.000Z' }),
      message({ id: 'removing', teamId: 't1', slotId: 'gone', createdAt: '2026-10-23T10:00:01.000Z' }),
      message({ id: 'next', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:02.000Z' }),
    )

    await coordinator.drain('t1')

    expect(team.messages.find(m => m.id === 'missing')?.deliveryState).toBe('failed')
    expect(team.messages.find(m => m.id === 'removing')?.deliveryState).toBe('failed')
    expect(fake.followups).toEqual([{ sessionId: 'sL', messageId: 'next' }])
    expect(fake.warnings.filter(warning => warning.includes('missing or removing'))).toHaveLength(2)
  })

  it('parks a busy target once and resumes it once without replay', async () => {
    const fake = createFake({ t1: teamWith('sL', 'sa') })
    const team = fake.team('t1')
    const coordinator = new TeamTurnCoordinator(fake.deps)
    team.messages.push(
      message({ id: 'm1', teamId: 't1', slotId: 'L', createdAt: '2026-10-23T10:00:00.000Z' }),
      message({ id: 'm2', teamId: 't1', slotId: 'a', createdAt: '2026-10-23T10:00:01.000Z' }),
    )
    fake.setSessionState('sa', 'running')

    await coordinator.submit('t1', 'm1')
    expect(await coordinator.submit('t1', 'm2')).toBe('queued')
    // The busy target leaves exactly one queued record, never a duplicate.
    expect(team.messages.filter(m => m.id === 'm2')).toHaveLength(1)
    expect(team.messages.find(m => m.id === 'm2')?.deliveryState).toBe('queued')

    // Releasing the active speaker cannot deliver into a running target.
    await coordinator.releaseSession('sL')
    expect(fake.followups).toEqual([{ sessionId: 'sL', messageId: 'm1' }])
    expect(team.messages.find(m => m.id === 'm2')?.deliveryState).toBe('queued')

    // The idle release resumes it exactly once.
    fake.setSessionState('sa', 'online')
    await coordinator.releaseSession('sL')
    expect(fake.followups).toEqual([
      { sessionId: 'sL', messageId: 'm1' },
      { sessionId: 'sa', messageId: 'm2' },
    ])
    expect(team.messages.find(m => m.id === 'm2')?.deliveryState).toBe('delivered')

    // Repeated releases (turn/end then idle) must not replay the delivered turn.
    await coordinator.releaseSession('sa')
    await coordinator.releaseSession('sL')
    expect(fake.followups).toHaveLength(2)
  })
})
