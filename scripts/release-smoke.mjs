#!/usr/bin/env node
/**
 * Release smoke: pack the plugin, verify the tarball contents, then install it
 * into a throwaway DSH_HOME. Never publishes, deploys, or tags.
 *
 * Usage:
 *   node scripts/release-smoke.mjs            # static checks + install if `dsh` exists
 *   node scripts/release-smoke.mjs --no-install
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const tarballName = `limeng-dsh-team-mode-${pkg.version}.tgz`
const install = !process.argv.includes('--no-install')

const requiredFiles = [
  'package.json',
  'lib/index.js',
  'lib/index.d.ts',
  'lib/client.js',
  'lib/client.d.ts',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
  'README_CN.md',
  'CHANGELOG.md',
  'docs/installation.md',
  'docs/tools.md',
  'docs/assets/dsh-team-mode/native-conversation.png',
]

const forbiddenPatterns = [
  /^src\//,
  /^tests\//,
  /^scripts\//,
  /^\.github\//,
  /^node_modules\//,
  /^\.agent-teams\//,
  /^deepfork-out\//,
  /^docs\/assets\/ui-review\//,
  /^docs\/(?:superpowers|research)\//,
  /\.map$/,
  /(^|\/)\.env(?:\.|$)/,
  /^tsdown\.config\.ts$/,
  /^package-lock\.json$/,
  /^docs\/UI-REVIEW\.md$/,
]

const unsafeText = [
  [/\/root\/[^\s'")]+/, 'absolute /root path'],
  [/\/home\/[^\s'")]+/, 'absolute /home path'],
  [/\/Users\/[^\s'")]+/, 'absolute /Users path'],
  [/[A-Za-z]:\\\\Users\\\\/, 'absolute Windows user path'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/\b(?:npm_[A-Za-z0-9]{36}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,})\b/, 'credential token'],
  [/(?:NPM_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*\S+/, 'credential assignment'],
]

const packDir = await mkdtemp(join(tmpdir(), 'dsh-team-mode-pack-'))
const installHome = await mkdtemp(join(tmpdir(), 'dsh-team-mode-home-'))

try {
  step('Pack', `npm pack --ignore-scripts --pack-destination ${packDir}`)
  const packed = run('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir, '--json'], {
    cwd: root,
    json: true,
  })[0]
  const tarball = join(packDir, packed.filename)
  assert(packed.filename === tarballName, `expected ${tarballName}, got ${packed.filename}`)
  const paths = packed.files.map(file => file.path)
  console.log(`  ${packed.entryCount} files, ${kb(packed.size)} packed, ${kb(packed.unpackedSize)} unpacked`)

  step('Required runtime assets')
  for (const path of requiredFiles) assert(paths.includes(path), `missing ${path}`)

  step('Forbidden dev/secret paths')
  for (const path of paths) {
    for (const pattern of forbiddenPatterns) {
      assert(!pattern.test(path), `unexpected packed path ${path}`)
    }
  }

  step('Extract and scan')
  const extractDir = join(packDir, 'extracted')
  await mkdir(extractDir)
  run('tar', ['-xzf', tarball, '-C', extractDir])
  const files = await walk(extractDir)
  const binary = /\.(?:png|jpe?g|gif|webp|ico)$/
  for (const file of files) {
    if (binary.test(file)) continue
    const rel = relative(extractDir, file)
    const text = await readFile(file, 'utf8')
    for (const [pattern, label] of unsafeText) {
      assert(!pattern.test(text), `${label} in ${rel}`)
    }
  }
  const manifest = JSON.parse(await readFile(join(extractDir, 'package', 'package.json'), 'utf8'))
  assert(manifest.version === pkg.version, `tarball version is ${manifest.version}`)
  assert(manifest.dependencies?.zod === undefined, 'zod must stay a peer/dev dependency')

  if (install) {
    step('Install into throwaway DSH_HOME')
    const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) {
      run('dsh', ['plugin', '--profile', 'smoke', 'add', tarball], {
        cwd: root,
        env: { ...process.env, DSH_HOME: installHome },
        timeout: 240000,
      })
      const profile = JSON.parse(
        await readFile(join(installHome, 'profiles', 'smoke', 'package.json'), 'utf8'),
      )
      assert(
        profile.dependencies?.['@limeng/dsh-team-mode'] !== undefined,
        'profile does not depend on the plugin',
      )
      assert(
        (await stat(join(installHome, 'profiles', 'smoke', 'node_modules', '@limeng', 'dsh-team-mode', 'lib', 'client.js'))).isFile(),
        'installed client bundle missing',
      )
      console.log('  installed and resolved from tarball')
    } else {
      console.log('  skipped: `dsh` is not on PATH (set up dsh to run the install smoke)')
    }
  }

  step('Result')
  console.log(`OK — ${packed.entryCount} files, ${kb(packed.size)} tarball, no publish/deploy`)
} catch (error) {
  console.error(`\nFAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await rm(packDir, { recursive: true, force: true })
  await rm(installHome, { recursive: true, force: true })
}

function step(title) {
  console.log(`\n[${title}]`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status})\n${detail}`)
  }
  return options.json === true ? JSON.parse(result.stdout) : result.stdout
}

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

function kb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
