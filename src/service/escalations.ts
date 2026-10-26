import type { Escalation, EscalationKind } from '../domain/types.js'
import type { AgentTeamEscalationStore } from '../storage/store.js'

/**
 * The hourly ceiling for one Session + kind: the fourth stall inside the window
 * does not add a row, it stamps `mutedAt` on the newest one. Reason (same as
 * OpenMausBot): a member stuck in a retry loop must not flood the coordinator.
 */
export const ESCALATION_HOURLY_LIMIT = 3
export const ESCALATION_WINDOW_MS = 60 * 60 * 1000
export const ESCALATION_SUMMARY_MAX = 120

/** The one thing a gate needs to say; the gate's body stays where it lives. */
export interface EscalationGate {
  teamId: string
  teamName: string
  memberSlotId: string
  sessionId: string
  kind: EscalationKind
  gateId: string
  summary: string
}

/**
 * Natural dedupe key: one gate in one Session is one row, however many
 * aggregation passes see it.
 */
export function escalationId(
  teamId: string,
  memberSlotId: string,
  kind: EscalationKind,
  gateId: string,
): string {
  return `${teamId}:${memberSlotId}:${kind}:${gateId}`
}

/** One bounded line: whitespace collapsed, at most 120 chars, never the gate body. */
export function boundedSummary(summary: string): string {
  const line = summary.replace(/\s+/g, ' ').trim()
  return line.length <= ESCALATION_SUMMARY_MAX ? line : line.slice(0, ESCALATION_SUMMARY_MAX)
}

/**
 * Record one stalled gate. An already-recorded gate is returned untouched (the
 * id is the dedupe key), and the hourly ceiling suppresses only new rows.
 */
export async function recordEscalation(
  store: AgentTeamEscalationStore,
  gate: EscalationGate,
  now = new Date().toISOString(),
): Promise<Escalation> {
  const id = escalationId(gate.teamId, gate.memberSlotId, gate.kind, gate.gateId)
  const existing = store.getEscalation(id)
  if (existing !== undefined) return existing

  const nowMs = Date.parse(now)
  const recent = store.listEscalations().filter(row => row.sessionId === gate.sessionId
    && row.kind === gate.kind
    && nowMs - Date.parse(row.createdAt) < ESCALATION_WINDOW_MS)
  const newest = recent.reduce<Escalation | undefined>(
    (latest, row) => latest === undefined || row.createdAt > latest.createdAt ? row : latest,
    undefined,
  )

  if (recent.length >= ESCALATION_HOURLY_LIMIT && newest !== undefined) {
    if (newest.mutedAt !== undefined) return newest
    const muted: Escalation = { ...newest, mutedAt: now }
    await store.putEscalation(muted)
    return muted
  }

  const record: Escalation = {
    schemaVersion: 1,
    id,
    teamId: gate.teamId,
    teamName: gate.teamName,
    memberSlotId: gate.memberSlotId,
    sessionId: gate.sessionId,
    kind: gate.kind,
    gateId: gate.gateId,
    summary: boundedSummary(gate.summary),
    status: 'open',
    createdAt: now,
  }
  await store.putEscalation(record)
  return record
}

/**
 * Lazy convergence for one Session + kind: every open row whose gate is absent
 * from the newest aggregation becomes `lifted`. No timer, no scan of other
 * Sessions — the next pass is what closes a gate.
 */
export async function liftEscalations(
  store: AgentTeamEscalationStore,
  sessionId: string,
  kind: EscalationKind,
  activeGateIds: Iterable<string>,
  now = new Date().toISOString(),
): Promise<Escalation[]> {
  const active = new Set(activeGateIds)
  const lifted: Escalation[] = []
  for (const row of store.listEscalations()) {
    if (row.sessionId !== sessionId || row.kind !== kind || row.status !== 'open') continue
    if (active.has(row.gateId)) continue
    const next: Escalation = { ...row, status: 'lifted', liftedAt: now }
    await store.putEscalation(next)
    lifted.push(next)
  }
  return lifted
}
