import { describe, expect, it } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { TeamAggregate } from '../src/domain/types.js'
import { dshTeamModeDomainSpec } from '../src/storage/domain.js'
import { migrateDomain, migrateTeamRecord } from '../src/storage/migration.js'

const NOW = '2026-01-01T00:00:00.000Z'

class FakeTable {
  readonly values = new Map<string, unknown>()

  get(key: string): unknown {
    return this.values.get(key)
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.values.entries()
  }

  keys(): IterableIterator<string> {
    return this.values.keys()
  }

  get size(): number {
    return this.values.size
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
  }

  async update(key: string, update: (value: unknown) => unknown): Promise<unknown> {
    const next = update(this.values.get(key))
    this.values.set(key, next)
    return next
  }
}

function fakeDomain(options: { failBackup?: boolean } = {}): {
  domain: Domain<typeof dshTeamModeDomainSpec>
  tables: Map<string, FakeTable>
} {
  const tables = new Map<string, FakeTable>()
  const domain = {
    name: 'dsh_team_mode',
    table(name: string) {
      let table = tables.get(name)
      if (table === undefined) {
        table = new FakeTable()
        tables.set(name, table)
      }
      if (options.failBackup === true && name === 'migration_backups') {
        return {
          ...table,
          put: async () => { throw new Error('backup write failed') },
        }
      }
      return table
    },
  } as unknown as Domain<typeof dshTeamModeDomainSpec>
  return { domain, tables }
}

function legacyTeam(): TeamAggregate {
  return {
    schemaVersion: 1,
    id: 'team-1',
    name: 'Legacy',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/legacy',
    leaderSlotId: 'leader',
    state: 'active',
    directMemberChat: true,
    members: {
      leader: { id: 'leader' },
      a: { id: 'a' },
    },
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as TeamAggregate
}

describe('storage migration', () => {
  it('upgrades v1 teams, keeps a backup, and is idempotent', async () => {
    const { domain, tables } = fakeDomain()
    const teams = tables.get('teams') ?? new FakeTable()
    tables.set('teams', teams)
    await teams.put('team-1', legacyTeam())

    await expect(migrateDomain(domain)).resolves.toBe(1)

    const upgraded = teams.get('team-1') as TeamAggregate
    expect(upgraded).toMatchObject({
      schemaVersion: 2,
      pinned: false,
      memberOrder: ['leader', 'a'],
    })
    const backup = tables.get('migration_backups')?.get('teams:team-1') as {
      record: TeamAggregate
    }
    expect(backup.record.schemaVersion).toBe(1)
    expect(tables.get('migrations')?.get('teams-v2')).toBeDefined()

    await expect(migrateDomain(domain)).resolves.toBe(0)
    expect(tables.get('migration_backups')?.size).toBe(1)
  })

  it('leaves the team and ledger untouched when the backup fails', async () => {
    const { domain, tables } = fakeDomain({ failBackup: true })
    const teams = tables.get('teams') ?? new FakeTable()
    tables.set('teams', teams)
    await teams.put('team-1', legacyTeam())

    await expect(migrateDomain(domain)).rejects.toThrow('backup write failed')

    expect((teams.get('team-1') as TeamAggregate).schemaVersion).toBe(1)
    expect(tables.get('migrations')?.get('teams-v2')).toBeUndefined()
  })

  it('is a no-op for a record that is already v2', () => {
    const team = {
      ...legacyTeam(),
      schemaVersion: 2,
      pinned: true,
      memberOrder: ['a', 'leader'],
    } as TeamAggregate
    expect(migrateTeamRecord(team)).toBe(team)
  })
})
