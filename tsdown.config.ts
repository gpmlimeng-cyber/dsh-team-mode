import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@limeng/dsh-team-mode'
const CSS_PREFIX = '\0dsh-team-mode-css:'
const CSS_SUFFIX = '.mjs'
const PROJECT_ROOT = import.meta.dirname
const cssFileById = new Map<string, string>()

const cssModulesPlugin = {
  name: 'dsh-team-mode-css-modules',
  resolveId(source: string, importer?: string) {
    if (!source.endsWith('.module.css') || importer === undefined) return null
    const file = resolve(dirname(importer), source)
    // The virtual id ends up in rolldown's `//#region` comments, so keep it
    // relative/hashed: an absolute build path would leak into the tarball.
    const hash = createHash('sha1').update(relative(PROJECT_ROOT, file)).digest('hex').slice(0, 16)
    const id = `${CSS_PREFIX}${hash}${CSS_SUFFIX}`
    cssFileById.set(id, file)
    return id
  },
  async load(id: string) {
    if (!id.startsWith(CSS_PREFIX)) return null
    const file = cssFileById.get(id)
    if (file === undefined) throw new Error(`unknown CSS module id: ${id}`)
    const source = await readFile(file)
    const result = transform({
      filename: basename(file),
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classes = Object.fromEntries(
      Object.entries(result.exports ?? {}).map(([local, value]) => [local, value.name]),
    )
    const tagId = `${PACKAGE_NAME}/${basename(file)}`
    return [
      `const css = ${JSON.stringify(result.code.toString())};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
      '  const tag = document.createElement("style");',
      `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classes)};`,
    ].join('\n')
  },
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    platform: 'node',
    format: 'esm',
    fixedExtension: false,
    outDir: 'lib',
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    // DeepSeek Harness does not load Web plugins as native ESM. It fetches
    // client.js and expects the bundle to register a CommonJS-style factory
    // in the browser's frozen module table.
    entry: { client: 'src/client/index.tsx' },
    platform: 'browser',
    format: 'cjs',
    fixedExtension: false,
    outDir: 'lib',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
      // The mascot renders in the browser: a `require('@dicebear/core')` in the
      // factory would hit the host's frozen module table, which does not ship it.
      alwaysBundle: [/^@dicebear\//],
    },
    plugins: [cssModulesPlugin],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
  {
    // Keep the public ./client type entry as client.d.ts while the executable
    // browser artifact above remains a wrapped CommonJS factory.
    entry: { client: 'src/client/index.tsx' },
    platform: 'browser',
    format: 'esm',
    fixedExtension: false,
    outDir: 'lib',
    dts: { emitDtsOnly: true },
    clean: false,
    sourcemap: false,
  },
])
