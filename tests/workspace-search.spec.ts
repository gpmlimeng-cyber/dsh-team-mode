import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { TeamAggregate } from '../src/domain/types.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import { WorkspaceService } from '../src/service/workspace-service.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WorkspaceService search', () => {
  it('finds ranked files recursively and skips dependency directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-team-mode-workspace-search-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'src', 'components'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'hidden'), { recursive: true })
    await writeFile(join(root, 'src', 'main.ts'), '')
    await writeFile(join(root, 'src', 'components', 'main-button.tsx'), '')
    await writeFile(join(root, 'node_modules', 'hidden', 'main.ts'), '')

    const team = { id: 'team-1', workspaceId: 'workspace-1', workspacePath: root } as TeamAggregate
    const store = { getTeam: () => team, listTeams: () => [] } as unknown as AgentTeamStore
    const ctx = {
      workspaceRegistry: {
        get: () => ({ path: root, status: async () => 'ok' }),
      },
    } as unknown as Context
    const service = new WorkspaceService(ctx, store, () => {}, () => {})

    try {
      await expect(service.search(team.id, 'MAIN', 10)).resolves.toEqual([
        { name: 'main.ts', path: 'src/main.ts', kind: 'file' },
        { name: 'main-button.tsx', path: 'src/components/main-button.tsx', kind: 'file' },
      ])
    } finally {
      await service.dispose()
    }
  })
})
