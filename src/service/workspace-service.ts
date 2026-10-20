import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { AgentTeamError } from '../domain/errors.js'
import type { TeamAggregate } from '../domain/types.js'
import type { AgentTeamStore } from '../storage/store.js'
import type {
  WorkspaceEntryView,
  WorkspaceGitDiffView,
  WorkspaceGitStatusView,
  WorkspaceUploadView,
} from '../transport/contracts.js'
import { renderWorkspaceGitDiff } from './workspace-diff-renderer.js'
import { readWorkspaceGitDiff, readWorkspaceGitStatus, WorkspaceTracker } from './workspace-tracker.js'

export class WorkspaceService {
  private readonly tracker: WorkspaceTracker

  constructor(
    private readonly ctx: Context,
    private readonly store: AgentTeamStore,
    onChange: (teamId: string) => void,
    onError: (teamId: string, error: unknown) => void,
  ) {
    this.tracker = new WorkspaceTracker(onChange, onError)
  }

  startTracking(): void {
    for (const team of this.store.listTeams()) this.watch(team.id, team.workspacePath)
  }

  dispose(): Promise<void> {
    return this.tracker.dispose()
  }

  watch(teamId: string, workspacePath: string): void {
    this.tracker.watch(teamId, workspacePath)
  }

  unwatch(teamId: string): Promise<void> {
    return this.tracker.unwatch(teamId)
  }

  async list(teamId: string, rawPath = ''): Promise<WorkspaceEntryView[]> {
    const team = await this.requireWorkspace(teamId)
    if (isAbsolute(rawPath)) throw new AgentTeamError('INVALID_REQUEST', 'Workspace path must be relative')
    const root = await realpath(team.workspacePath)
    const requested = resolve(root, rawPath)
    if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
      throw new AgentTeamError('INVALID_REQUEST', 'Workspace path escapes the team Workspace')
    }
    const target = await realpath(requested)
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new AgentTeamError('INVALID_REQUEST', 'Workspace path resolves outside the team Workspace')
    }
    const entries = await readdir(target, { withFileTypes: true })
    return entries
      .filter(entry => entry.name !== '.git' && entry.name !== 'node_modules')
      .map(entry => {
        const path = relative(root, resolve(target, entry.name)).split(sep).join('/')
        return {
          name: entry.name,
          path,
          kind: entry.isSymbolicLink() ? 'symlink' as const
            : entry.isDirectory() ? 'directory' as const
              : 'file' as const,
        }
      })
      .sort((left, right) => {
        if (left.kind === 'directory' && right.kind !== 'directory') return -1
        if (left.kind !== 'directory' && right.kind === 'directory') return 1
        return left.name.localeCompare(right.name)
      })
      .slice(0, 500)
  }

  async search(teamId: string, rawQuery = '', limit = 40): Promise<WorkspaceEntryView[]> {
    const team = await this.requireWorkspace(teamId)
    const root = await realpath(team.workspacePath)
    const query = rawQuery.trim().replaceAll('\\', '/').toLocaleLowerCase()
    const boundedLimit = Math.max(1, Math.min(limit, 100))
    const pendingDirectories = ['']
    const matches: WorkspaceEntryView[] = []
    let inspectedEntries = 0

    while (pendingDirectories.length > 0 && inspectedEntries < 20_000) {
      const directory = pendingDirectories.shift()!
      const requested = resolve(root, directory)
      let target: string
      try {
        target = await realpath(requested)
      } catch {
        continue
      }
      if (target !== root && !target.startsWith(`${root}${sep}`)) continue

      let entries: Array<Dirent<string>>
      try {
        entries = await readdir(target, { withFileTypes: true })
      } catch {
        continue
      }
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        inspectedEntries += 1
        if (inspectedEntries > 20_000) break
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        if (entry.isSymbolicLink()) continue
        const path = relative(root, resolve(target, entry.name)).split(sep).join('/')
        if (entry.isDirectory()) {
          pendingDirectories.push(path)
          continue
        }
        if (!entry.isFile() || (query.length > 0 && !path.toLocaleLowerCase().includes(query))) continue
        matches.push({ name: entry.name, path, kind: 'file' })
        if (query.length === 0 && matches.length >= boundedLimit) return matches
      }
    }

    return matches
      .sort((left, right) => workspaceSearchRank(left.path, query) - workspaceSearchRank(right.path, query)
        || left.path.length - right.path.length
        || left.path.localeCompare(right.path))
      .slice(0, boundedLimit)
  }

  async changes(teamId: string): Promise<WorkspaceGitStatusView> {
    const team = await this.requireWorkspace(teamId)
    try {
      return await readWorkspaceGitStatus(team.workspacePath)
    } catch (error) {
      throw new AgentTeamError(
        'WORKSPACE_GIT_UNAVAILABLE',
        'Unable to read Git changes for this Workspace',
        undefined,
        { cause: error },
      )
    }
  }

  async diff(
    teamId: string,
    path: string,
    scope: 'staged' | 'unstaged',
    layout: 'unified' | 'split',
    theme: 'light' | 'dark',
  ): Promise<WorkspaceGitDiffView> {
    const team = await this.requireWorkspace(teamId)
    try {
      const diff = await readWorkspaceGitDiff(team.workspacePath, path, scope)
      return {
        path: diff.path,
        scope: diff.scope,
        layout,
        theme,
        binary: diff.binary,
        html: diff.binary || !diff.patch.includes('@@')
          ? ''
          : await renderWorkspaceGitDiff(diff.patch, layout, theme),
      }
    } catch (error) {
      throw new AgentTeamError(
        'WORKSPACE_GIT_UNAVAILABLE',
        error instanceof Error ? error.message : 'Unable to read the Git diff for this Workspace',
        undefined,
        { cause: error },
      )
    }
  }

  async upload(teamId: string, rawName: string, data: Uint8Array): Promise<WorkspaceUploadView> {
    const team = await this.requireWorkspace(teamId)
    const root = await realpath(team.workspacePath)
    const uploadDirectory = resolve(root, '.dsh-team-mode', 'uploads')
    await mkdir(uploadDirectory, { recursive: true })
    const resolvedUploadDirectory = await realpath(uploadDirectory)
    if (!resolvedUploadDirectory.startsWith(`${root}${sep}`)) {
      throw new AgentTeamError('INVALID_REQUEST', 'Workspace upload directory resolves outside the team Workspace')
    }
    const name = safeUploadName(rawName)
    for (let index = 0; index < 1_000; index += 1) {
      const candidate = uploadCandidateName(name, index)
      const target = resolve(resolvedUploadDirectory, candidate)
      try {
        await writeFile(target, data, { flag: 'wx' })
        return {
          name: candidate,
          path: relative(root, target).split(sep).join('/'),
          bytes: data.byteLength,
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const existing = await readFile(target)
          if (existing.equals(data)) {
            return {
              name: candidate,
              path: relative(root, target).split(sep).join('/'),
              bytes: existing.byteLength,
            }
          }
          continue
        }
        throw error
      }
    }
    throw new AgentTeamError('INVALID_REQUEST', `Unable to allocate a unique upload name for '${name}'`)
  }

  private async requireWorkspace(teamId: string): Promise<TeamAggregate> {
    const team = this.store.getTeam(teamId)
    if (team === undefined) throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${teamId}'`)
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok' || workspace.path !== team.workspacePath) {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${team.workspaceId}' is unavailable or changed`)
    }
    this.watch(team.id, team.workspacePath)
    return team
  }
}

function workspaceSearchRank(path: string, query: string): number {
  if (query.length === 0) return 0
  const normalized = path.toLocaleLowerCase()
  const name = basename(path).toLocaleLowerCase()
  if (name.startsWith(query)) return 0
  if (normalized.startsWith(query)) return 1
  if (name.includes(query)) return 2
  return 3
}

function safeUploadName(rawName: string): string {
  const name = basename(rawName)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .trim()
  if (name.length === 0 || name === '.' || name === '..') {
    throw new AgentTeamError('INVALID_REQUEST', 'Uploaded file name is invalid')
  }
  const extension = extname(name).slice(0, 40)
  const stem = name.slice(0, name.length - extension.length).slice(0, 180) || 'file'
  return `${stem}${extension}`
}

function uploadCandidateName(name: string, index: number): string {
  if (index === 0) return name
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  return `${stem} (${index})${extension}`
}
