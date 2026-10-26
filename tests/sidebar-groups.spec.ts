import { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import {
  SIDEBAR_GROUP_MAX_CHARS,
  assistantInstanceSchema,
  teamAggregateSchema,
} from '../src/domain/schemas.js'
import type { AssistantInstance, TeamAggregate } from '../src/domain/types.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import { dshTeamModeDomainSpec } from '../src/storage/domain.js'
import { DomainAgentTeamStore } from '../src/storage/store.js'

const NOW = '2026-10-26T00:00:00.000Z'

const config: Config = {
  maxRequestBytes: 128 * 1024,
  sseHeartbeatMs: 20_000,
  runtimeConcurrency: 4,
  directMemberChatDefault: true,
  assistantBuilderProvider: '',
  assistantBuilderModel: '',
  assistantBuilderAgentPresetId: '',
  assistantBuilderPermissionPresetId: '',
}

/**
 * A team stored before groups existed: no `group` key at all. Kept as a plain
 * record so the test can also assert the schema accepts it unchanged.
 */
function legacyTeam(): TeamAggregate {
  return {
    schemaVersion: 2,
    id: 'team-1',
    name: 'Research',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/dsh-sidebar-groups-workspace',
    leaderSlotId: 'slot-leader',
    state: 'draft',
    directMemberChat: true,
    members: {},
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    pinned: false,
    memberOrder: [],
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  } as TeamAggregate
}

function legacyInstance(): AssistantInstance {
  return {
    schemaVersion: 1,
    id: 'instance-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: 'Researcher',
      instructions: '',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/dsh-sidebar-groups-workspace',
    status: 'idle',
    pinned: false,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  } as AssistantInstance
}

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

function fakeDomain(): Domain<typeof dshTeamModeDomainSpec> {
  const tables = new Map<string, FakeTable>()
  return {
    name: 'dsh_team_mode',
    table(name: string) {
      let table = tables.get(name)
      if (table === undefined) {
        table = new FakeTable()
        tables.set(name, table)
      }
      return table
    },
  } as unknown as Domain<typeof dshTeamModeDomainSpec>
}

async function createHarness(): Promise<{
  service: AgentTeamService
  store: DomainAgentTeamStore
}> {
  const store = new DomainAgentTeamStore(fakeDomain())
  const service = new AgentTeamService(new Context(), config, store)
  await store.putTeam(legacyTeam())
  await store.putAssistantInstance(legacyInstance())
  return { service, store }
}

describe('Sidebar groups', () => {
  it('creates trimmed groups in order and rejects duplicates', async () => {
    const { service, store } = await createHarness()

    expect(await service.createGroup('  工作  ')).toEqual(['工作'])
    expect(await service.createGroup('科研')).toEqual(['工作', '科研'])
    expect(service.listGroups()).toEqual(['工作', '科研'])
    // The real store parses writes through the domain schema, so a stored list
    // proves the schema accepts it.
    expect(store.getSidebarGroups()).toMatchObject({ groups: ['工作', '科研'], revision: 2 })
    expect(store.getSidebarGroups()?.updatedAt).not.toBe(NOW)

    await expect(service.createGroup(' 工作 ')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(service.createGroup('   ')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(service.listGroups()).toEqual(['工作', '科研'])
  })

  it('refuses to move a member into a group that does not exist', async () => {
    const { service, store } = await createHarness()
    const ghost = '无此分组'

    await expect(service.setTeamGroup('team-1', ghost)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(service.updateAssistantInstance('instance-1', { group: ghost }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(store.getTeam('team-1')?.group).toBeUndefined()
    expect(store.getAssistantInstance('instance-1')?.group).toBeUndefined()

    await service.createGroup('工作')
    expect((await service.setTeamGroup('team-1', '  工作  ')).group).toBe('工作')
    expect((await service.updateAssistantInstance('instance-1', { group: '工作' })).group).toBe('工作')
    // Clearing never needs a group to exist.
    expect((await service.setTeamGroup('team-1', null)).group).toBeUndefined()
  })

  it('renames a group and cascades the rename to every member', async () => {
    const { service, store } = await createHarness()
    await service.createGroup('工作')
    await service.setTeamGroup('team-1', '工作')
    const member = await service.updateAssistantInstance('instance-1', { group: '工作' })

    expect(await service.renameGroup(' 工作 ', '上班')).toEqual(['上班'])
    expect(store.getTeam('team-1')?.group).toBe('上班')
    const renamed = store.getAssistantInstance('instance-1')
    expect(renamed?.group).toBe('上班')
    expect(renamed?.revision).toBe(member.revision + 1)
    expect(renamed?.updatedAt).not.toBe(NOW)

    await service.createGroup('科研')
    await expect(service.renameGroup('上班', '科研')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(service.renameGroup('无此分组', '别的')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    // A trim-only rename is a no-op, not a duplicate rejection.
    expect(await service.renameGroup(' 上班 ', '上班')).toEqual(['上班', '科研'])
  })

  it('deletes a group and returns its members to ungrouped', async () => {
    const { service, store } = await createHarness()
    await service.createGroup('工作')
    await service.setTeamGroup('team-1', '工作')
    await service.updateAssistantInstance('instance-1', { group: '工作' })

    expect(await service.deleteGroup(' 工作 ')).toEqual([])
    expect(store.getTeam('team-1')?.group).toBeUndefined()
    expect(store.getAssistantInstance('instance-1')?.group).toBeUndefined()
    expect(service.listGroups()).toEqual([])

    await expect(service.deleteGroup('工作')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('persists the group order and rejects a partial order', async () => {
    const { service, store } = await createHarness()
    for (const name of ['一', '二', '三']) await service.createGroup(name)

    expect(await service.setGroupOrder(['三', '一', '二'])).toEqual(['三', '一', '二'])
    // A fresh service on the same store reads the stored order, not a memory map.
    const reopened = new AgentTeamService(new Context(), config, store)
    expect(reopened.listGroups()).toEqual(['三', '一', '二'])

    await expect(service.setGroupOrder(['三', '一'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(service.setGroupOrder(['三', '一', '一', '二']))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(service.setGroupOrder(['三', '一', '四']))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(service.listGroups()).toEqual(['三', '一', '二'])
  })

  it('accepts a label of exactly the limit and rejects one character more', async () => {
    const { service } = await createHarness()
    const atLimit = 'g'.repeat(SIDEBAR_GROUP_MAX_CHARS)
    expect(await service.createGroup(atLimit)).toEqual([atLimit])

    const tooLong = `${atLimit}g`
    const error = await service.createGroup(tooLong).then(() => undefined, (value: unknown) => value)
    expect(error).toBeInstanceOf(AgentTeamError)
    expect((error as AgentTeamError).code).toBe('INVALID_REQUEST')
    // An over-long move is refused by name length before the group lookup, and
    // nothing is written or truncated.
    await expect(service.setTeamGroup('team-1', tooLong)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(service.listGroups()).toEqual([atLimit])
  })

  it('clears a group with a blank label or null', async () => {
    const { service, store } = await createHarness()
    await service.createGroup('工作')
    const grouped = await service.setTeamGroup('team-1', '工作')
    expect(grouped.revision).toBe(4)

    const blank = await service.setTeamGroup('team-1', '   ')
    expect(blank.group).toBeUndefined()
    expect('group' in blank).toBe(false)
    expect(store.getTeam('team-1')?.group).toBeUndefined()

    await service.setTeamGroup('team-1', '工作')
    const cleared = await service.setTeamGroup('team-1', null)
    expect(cleared.group).toBeUndefined()
    expect('group' in cleared).toBe(false)
  })

  it('sets and clears an assistant instance group without a needless revision bump', async () => {
    const { service, store } = await createHarness()
    await service.createGroup('工作')

    const grouped = await service.updateAssistantInstance('instance-1', { group: '  工作  ' })
    expect(grouped.group).toBe('工作')
    expect(grouped.revision).toBe(3)
    expect(store.getAssistantInstance('instance-1')?.group).toBe('工作')

    // A patch without `group` keeps it, and a no-op patch is not a revision bump.
    const pinned = await service.updateAssistantInstance('instance-1', { pinned: true })
    expect(pinned.group).toBe('工作')
    expect(await service.updateAssistantInstance('instance-1', { pinned: true })).toBe(pinned)

    const cleared = await service.updateAssistantInstance('instance-1', { group: '' })
    expect(cleared.group).toBeUndefined()
    expect('group' in cleared).toBe(false)
    expect(store.getAssistantInstance('instance-1')?.group).toBeUndefined()
  })

  it('reads legacy records without a group as ungrouped', async () => {
    const { service, store } = await createHarness()

    expect(teamAggregateSchema.parse(legacyTeam()).group).toBeUndefined()
    expect(assistantInstanceSchema.parse(legacyInstance()).group).toBeUndefined()
    expect(store.getTeam('team-1')?.group).toBeUndefined()
    expect(store.getAssistantInstance('instance-1')?.group).toBeUndefined()
    // No group list was ever written either: absent reads as empty.
    expect(service.listGroups()).toEqual([])
    expect(service.getTeam('team-1').group).toBeUndefined()
  })
})
