import { describe, expect, it } from 'vitest'
import { escalationSchema } from '../src/domain/schemas.js'
import type { Escalation } from '../src/domain/types.js'
import {
  boundedSummary,
  escalationId,
  liftEscalations,
  recordEscalation,
  type EscalationGate,
} from '../src/service/escalations.js'
import type { AgentTeamEscalationStore } from '../src/storage/store.js'

const NOW = '2026-10-26T10:00:00.000Z'
const HOUR_MS = 60 * 60 * 1000

class FakeEscalationStore implements AgentTeamEscalationStore {
  readonly rows = new Map<string, Escalation>()
  puts = 0

  getEscalation(id: string): Escalation | undefined {
    return this.rows.get(id)
  }

  listEscalations(): Escalation[] {
    return [...this.rows.values()]
  }

  async putEscalation(value: Escalation): Promise<void> {
    this.puts += 1
    this.rows.set(value.id, value)
  }

  async deleteEscalation(id: string): Promise<boolean> {
    return this.rows.delete(id)
  }
}

function gate(overrides: Partial<EscalationGate> = {}): EscalationGate {
  return {
    teamId: 'team-1',
    teamName: 'Delivery',
    memberSlotId: 'slot-1',
    sessionId: 'session-1',
    kind: 'approval',
    gateId: 'gate-1',
    summary: 'Approve the workspace write',
    ...overrides,
  }
}

function at(offsetMs: number): string {
  return new Date(Date.parse(NOW) + offsetMs).toISOString()
}

describe('escalations', () => {
  it('records one open row under the natural dedupe id', async () => {
    const store = new FakeEscalationStore()

    const record = await recordEscalation(store, gate(), NOW)

    expect(record).toEqual({
      schemaVersion: 1,
      id: escalationId('team-1', 'slot-1', 'approval', 'gate-1'),
      teamId: 'team-1',
      teamName: 'Delivery',
      memberSlotId: 'slot-1',
      sessionId: 'session-1',
      kind: 'approval',
      gateId: 'gate-1',
      summary: 'Approve the workspace write',
      status: 'open',
      createdAt: NOW,
    })
    expect(escalationSchema.parse(record)).toEqual(record)
    expect(store.puts).toBe(1)
  })

  it('keeps the summary on one line and within 120 chars', async () => {
    const store = new FakeEscalationStore()

    const record = await recordEscalation(store, gate({
      gateId: 'gate-2',
      summary: `  Approve\n\n the   ${'very '.repeat(40)}long request  `,
    }), NOW)

    expect(record.summary).not.toContain('\n')
    expect(record.summary.length).toBe(120)
    expect(record.summary.startsWith('Approve the very')).toBe(true)
    expect(boundedSummary('short')).toBe('short')
  })

  it('does not write a second row for the same gate', async () => {
    const store = new FakeEscalationStore()

    const first = await recordEscalation(store, gate(), NOW)
    const second = await recordEscalation(store, gate({ summary: 'Same gate, later pass' }), at(30_000))

    expect(store.rows.size).toBe(1)
    expect(store.puts).toBe(1)
    expect(second).toBe(first)
    expect(first.summary).toBe('Approve the workspace write')
    expect(first.createdAt).toBe(NOW)
  })

  it('lifts open rows whose gate is gone from the newest batch', async () => {
    const store = new FakeEscalationStore()
    const a = await recordEscalation(store, gate({ gateId: 'a' }), NOW)
    const b = await recordEscalation(store, gate({ gateId: 'b' }), at(1000))

    const lifted = await liftEscalations(store, 'session-1', 'approval', ['a'], at(2000))

    expect(lifted.map(row => row.id)).toEqual([b.id])
    expect(store.getEscalation(a.id)).toMatchObject({ status: 'open' })
    expect(store.getEscalation(b.id)).toMatchObject({ status: 'lifted', liftedAt: at(2000) })
  })

  it('lifts only the given session and kind, and never re-lifts', async () => {
    const store = new FakeEscalationStore()
    const approval = await recordEscalation(store, gate({ gateId: 'a' }), NOW)
    const question = await recordEscalation(store, gate({ gateId: 'q', kind: 'question' }), NOW)
    const otherSession = await recordEscalation(store, gate({ gateId: 'o', sessionId: 'session-2' }), NOW)

    const lifted = await liftEscalations(store, 'session-1', 'approval', [], at(1000))

    expect(lifted.map(row => row.id)).toEqual([approval.id])
    expect(store.getEscalation(question.id)).toMatchObject({ status: 'open' })
    expect(store.getEscalation(otherSession.id)).toMatchObject({ status: 'open' })
    await expect(liftEscalations(store, 'session-1', 'approval', [], at(2000))).resolves.toEqual([])
  })

  it('mutes instead of writing a fourth row inside the hour', async () => {
    const store = new FakeEscalationStore()
    for (const gateId of ['g1', 'g2', 'g3']) {
      await recordEscalation(store, gate({ gateId }), at(Number(gateId.slice(1)) * 1000))
    }

    const muted = await recordEscalation(store, gate({ gateId: 'g4' }), at(4000))

    expect(store.rows.size).toBe(3)
    expect(store.puts).toBe(4)
    expect(store.rows.get(escalationId('team-1', 'slot-1', 'approval', 'g4'))).toBeUndefined()
    expect(muted).toMatchObject({
      id: escalationId('team-1', 'slot-1', 'approval', 'g3'),
      status: 'open',
      mutedAt: at(4000),
    })
    expect((await recordEscalation(store, gate({ gateId: 'g5' }), at(5000))).mutedAt).toBe(muted.mutedAt)
    expect(store.rows.size).toBe(3)
  })

  it('allows a new row once the hour has passed', async () => {
    const store = new FakeEscalationStore()
    for (const gateId of ['g1', 'g2', 'g3']) {
      await recordEscalation(store, gate({ gateId }), at(Number(gateId.slice(1)) * 1000))
    }

    const later = await recordEscalation(store, gate({ gateId: 'g4' }), at(HOUR_MS + 10_000))

    expect(store.rows.size).toBe(4)
    expect(later).toMatchObject({ status: 'open' })
    expect(later.mutedAt).toBeUndefined()
  })

  it('counts the quota per session and kind', async () => {
    const store = new FakeEscalationStore()
    for (const gateId of ['g1', 'g2', 'g3']) {
      await recordEscalation(store, gate({ gateId }), NOW)
    }

    const question = await recordEscalation(store, gate({ gateId: 'q1', kind: 'question' }), NOW)
    const otherSession = await recordEscalation(store, gate({ gateId: 'o1', sessionId: 'session-2' }), NOW)

    expect(question).toMatchObject({ status: 'open' })
    expect(otherSession).toMatchObject({ status: 'open' })
    expect(question.mutedAt).toBeUndefined()
    expect(otherSession.mutedAt).toBeUndefined()
    expect(store.rows.size).toBe(5)
  })
})
