import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { TeamAggregate } from '../domain/types.js'
import { dshTeamModeDomainSpec } from './domain.js'

export const TEAM_SCHEMA_VERSION = 2
export const TEAM_MIGRATION_ID = 'teams-v2'
/** One-shot: make the shipped Chief instance the workspace coordinator. */
export const CHIEF_COORDINATOR_MIGRATION_ID = 'chief-coordinator-v1'

/**
 * Fill the v2 presentation/warmup fields on a v1 team. Pure and idempotent so
 * it can run on every startup and in tests without touching the store.
 */
export function migrateTeamRecord(team: TeamAggregate): TeamAggregate {
  if (
    team.schemaVersion === TEAM_SCHEMA_VERSION
    && team.pinned !== undefined
    && team.memberOrder !== undefined
  ) return team
  return {
    ...team,
    schemaVersion: TEAM_SCHEMA_VERSION,
    pinned: team.pinned ?? false,
    memberOrder: team.memberOrder ?? Object.keys(team.members),
  }
}

/**
 * Upgrade stored teams to the v2 record shape before the service reads them.
 *
 * The domain format version stays 1 on purpose: record-level evolution avoids
 * a backend `version-mismatch` and lets older records open under the same
 * schemas. A ledger row makes the pass idempotent; every rewritten record is
 * copied to `migration_backups` first, so a failure midway leaves the original
 * bytes recoverable and the next startup resumes.
 */
export async function migrateDomain(
  domain: Domain<typeof dshTeamModeDomainSpec>,
): Promise<number> {
  const migrations = domain.table('migrations')
  if (migrations.get(TEAM_MIGRATION_ID) !== undefined) return 0

  const teams = domain.table('teams')
  const backups = domain.table('migration_backups')
  const capturedAt = new Date().toISOString()
  let migrated = 0

  for (const [id, team] of teams.entries()) {
    const next = migrateTeamRecord(team)
    if (next === team) continue
    await backups.put(`teams:${id}`, {
      schemaVersion: 1,
      table: 'teams',
      key: id,
      capturedAt,
      record: team,
    })
    await teams.put(id, next)
    migrated += 1
  }

  await migrations.put(TEAM_MIGRATION_ID, {
    schemaVersion: 1,
    id: TEAM_MIGRATION_ID,
    appliedAt: capturedAt,
    fromVersion: 1,
    toVersion: TEAM_SCHEMA_VERSION,
  })
  return migrated
}

/**
 * Adopt the shipped Chief instance as the workspace coordinator once.
 *
 * A ledger row makes this a single pass: cancelling the coordinator later is a
 * user decision, and a startup must not quietly undo it. Fresh installs are
 * covered separately, when the Chief instance is created.
 */
export async function adoptChiefCoordinator(
  domain: Domain<typeof dshTeamModeDomainSpec>,
): Promise<number> {
  const migrations = domain.table('migrations')
  if (migrations.get(CHIEF_COORDINATOR_MIGRATION_ID) !== undefined) return 0

  const instances = domain.table('assistant_instances')
  const rows = Array.from(instances.entries()).map(([, value]) => value)
  const now = new Date().toISOString()
  let adopted = 0

  const hasCoordinator = rows.some(row => row.coordinator === true && row.status !== 'archived')
  const chief = rows.find(row => row.templateId === 'builtin-chief' && row.status !== 'archived')
  if (!hasCoordinator && chief !== undefined) {
    await instances.put(chief.id, { ...chief, coordinator: true, revision: chief.revision + 1, updatedAt: now })
    adopted = 1
  }

  await migrations.put(CHIEF_COORDINATOR_MIGRATION_ID, {
    schemaVersion: 1,
    id: CHIEF_COORDINATOR_MIGRATION_ID,
    appliedAt: now,
    fromVersion: 1,
    toVersion: 1,
  })
  return adopted
}
