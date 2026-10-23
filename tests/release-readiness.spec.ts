import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEAM_TOOL_ALIAS_NAMES, TEAM_TOOL_NAMES } from '../src/runtime/team-tools.js'

const root = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const readIfExists = (path: string): string => {
  try {
    return read(path)
  } catch {
    return ''
  }
}

const pkg = JSON.parse(read('package.json')) as {
  version: string
  author?: string
  homepage?: string
  bugs?: { url?: string }
  keywords?: string[]
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

describe('release readiness', () => {
  it('declares complete package metadata', () => {
    expect(pkg.version).toBe('0.4.0')
    expect(pkg.author).toBeTruthy()
    expect(pkg.homepage).toContain('github.com/gpmlimeng-cyber/dsh-team-mode')
    expect(pkg.bugs?.url).toContain('/issues')
    expect(pkg.keywords).toEqual(expect.arrayContaining(['dsh', 'deepseek-harness']))
  })

  it('keeps zod as a peer/dev dependency instead of a duplicate runtime dependency', () => {
    expect(pkg.dependencies?.zod).toBeUndefined()
    expect(pkg.peerDependencies?.zod).toBeTruthy()
    expect(pkg.devDependencies?.zod).toBeTruthy()
  })

  it('packs every runtime asset and no dev/secret files', () => {
    const files = pkg.files ?? []
    for (const required of [
      'lib',
      '!lib/*.map',
      'lib/index.js',
      'locale/*.json',
      'icon.svg',
      'cordis.patch.yml',
      'LICENSE',
      'README.md',
      'README_CN.md',
      'CHANGELOG.md',
      'docs/*.md',
      'docs/assets/dsh-team-mode/*.png',
    ]) {
      expect(files, `files whitelist must include ${required}`).toContain(required)
    }

    const forbidden = [
      'src',
      'tests',
      'scripts',
      '.github',
      'node_modules',
      'docs/assets/ui-review',
      'docs/superpowers',
      'deepfork-out',
      '.agent-teams',
      '.env',
    ]
    for (const entry of files) {
      for (const pattern of forbidden) {
        expect(entry, `files whitelist must not include ${pattern}`).not.toContain(pattern)
      }
    }
    expect(files).toContain('!docs/UI-REVIEW.md')
    expect(new Set(files).size).toBe(files.length)
  })

  it('describes the registered team tool surface in both READMEs', () => {
    expect(TEAM_TOOL_NAMES).toHaveLength(24)
    expect(TEAM_TOOL_ALIAS_NAMES.size).toBe(3)

    for (const file of ['README.md', 'README_CN.md']) {
      const text = read(file)
      expect(text, file).toContain('24 个')
      expect(text, file).not.toContain('13 个')
      for (const tool of TEAM_TOOL_NAMES) expect(text, `${file} misses ${tool}`).toContain(tool)
      for (const stale of ['team_task_create', 'team_task_update', 'team_task_list']) {
        expect(text, `${file} still names ${stale}`).not.toContain(stale)
      }
    }
  })

  it('pins 0.4.0 and leads with local install in the docs', () => {
    const installation = read('docs/installation.md')
    expect(installation).toContain('0.4.0')
    expect(installation).toContain('limeng-dsh-team-mode-0.4.0.tgz')
    expect(installation).toContain('尚未发布')
    expect(installation.indexOf('从本地压缩包安装')).toBeLessThan(
      installation.indexOf('从 npm 安装'),
    )
    expect(installation).not.toContain('@limeng/dsh-team-mode@0.3.0')

    const migration = read('docs/migration-0.2.1.md')
    expect(migration).toContain('0.4.0')
    expect(migration).toContain('release:smoke')
    expect(migration).not.toContain('limeng-dsh-team-mode-0.2.0.tgz')

    const release = read('docs/RELEASE-2026-10-20.md')
    expect(release).toContain('0.4.0')
    expect(release).toContain('24 个')
    expect(release).not.toContain('13 个')
    expect(release).not.toContain('22 test files')

    const changelog = read('CHANGELOG.md')
    expect(changelog.startsWith('# Changelog')).toBe(true)
    expect(changelog).toContain('## 0.4.0')
  })

  it('runs checks and the pack smoke in CI without publishing or deploying', () => {
    const workflow = readIfExists('.github/workflows/ci.yml')
    expect(workflow).toContain('node: [22, 24]')
    expect(workflow).toContain('npm ci --ignore-scripts')
    expect(workflow).toContain('npm run check')
    expect(workflow).toContain('npm run release:smoke')

    const smoke = readIfExists('scripts/release-smoke.mjs')
    expect(smoke).toContain("'pack'")
    expect(smoke).toContain('DSH_HOME')
    expect(smoke).toContain('forbiddenPatterns')
    expect(pkg.scripts?.['release:smoke']).toContain('release-smoke.mjs')

    const executableText = [workflow, smoke, JSON.stringify(pkg.scripts)]
      .join('\n')
      .toLowerCase()
    for (const command of ['npm publish', 'pnpm publish', 'yarn publish', 'git push --tags', 'git tag']) {
      expect(executableText).not.toContain(command)
    }
  })

  it('keeps absolute build paths out of the CSS virtual module id', () => {
    const config = read('tsdown.config.ts')
    expect(config).toContain("createHash('sha1')")
    expect(config).toContain('relative(PROJECT_ROOT, file)')
    expect(config).toContain('const id = `${CSS_PREFIX}${hash}${CSS_SUFFIX}`')
    expect(config).not.toContain('${CSS_PREFIX}${resolve(')
  })
})
