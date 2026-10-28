import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CatalogView } from '../src/transport/contracts.js'

// The switcher imports the whole primitive set; these node tests only exercise
// the plugin's own lookup/hide logic and the meta row, so primitives are stubs.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (props: { children?: unknown }): unknown => createElement('span', null, props?.children as never)
  const api: Record<string, unknown> = {
    Menu: (props: { anchor?: unknown; open?: boolean; children?: unknown }) => createElement(
      'div',
      { role: 'menu' },
      props.anchor as never,
      props.open === true ? props.children as never : null,
    ),
  }
  for (const name of [
    'IconCheckOutlineRegular', 'IconChevronDownOutlineRegular', 'IconPlusOutlineRegular', 'IconSearchOutlineRegular',
    'IconArchiveOutlineRegular', 'IconEditOutlineRegular', 'IconEllipsisOutlineRegular',
  ]) api[name] = Stub
  return api
})

const {
  SessionPresetMeta,
  agentPresetLabel,
  isPresetLabelText,
  knownPresetNames,
} = await import('../src/client/agent-preset-label.js')

function catalog(overrides: Partial<CatalogView> = {}): CatalogView {
  return {
    providers: [],
    models: {},
    agentPresets: [
      { id: 'standard', name: '标准模式' },
      { id: 'cordis', name: '创造模式' },
    ],
    permissionPresets: [],
    workspaces: [],
    ...overrides,
  }
}

describe('agentPresetLabel', () => {
  it('maps a catalog preset id to its display name', () => {
    expect(agentPresetLabel(catalog(), 'standard')).toBe('标准模式')
    expect(agentPresetLabel(catalog(), 'cordis')).toBe('创造模式')
  })

  it('falls back to the raw id when the catalog lacks it', () => {
    expect(agentPresetLabel(catalog(), 'custom-123')).toBe('custom-123')
    expect(agentPresetLabel(undefined, 'standard')).toBe('standard')
  })

  it('renders nothing without an id or with an empty name', () => {
    expect(agentPresetLabel(catalog(), undefined)).toBeUndefined()
    expect(agentPresetLabel(catalog(), '  ')).toBeUndefined()
    expect(agentPresetLabel(catalog({ agentPresets: [{ id: 'blank', name: '  ' }] }), 'blank')).toBe('blank')
  })
})

describe('knownPresetNames', () => {
  it('collects every catalog name plus the current label, deduped and trimmed', () => {
    expect(knownPresetNames(catalog(), '标准模式')).toEqual(['标准模式', '创造模式'])
    expect(knownPresetNames(catalog(), 'custom-123')).toEqual(['标准模式', '创造模式', 'custom-123'])
    expect(knownPresetNames(catalog({ agentPresets: [{ id: 'a', name: ' 标准模式 ' }] }), undefined)).toEqual(['标准模式'])
  })

  it('is empty when neither the catalog nor a label is available', () => {
    expect(knownPresetNames(undefined, undefined)).toEqual([])
    expect(knownPresetNames(catalog({ agentPresets: [] }), '')).toEqual([])
  })
})

describe('isPresetLabelText', () => {
  const names = ['标准模式', '创造模式']

  it('matches a known display name exactly, after trimming', () => {
    expect(isPresetLabelText('标准模式', names)).toBe(true)
    expect(isPresetLabelText(' 标准模式 ', names)).toBe(true)
  })

  it('never matches unknown text, empty text, or a partial name', () => {
    expect(isPresetLabelText('某个会话', names)).toBe(false)
    expect(isPresetLabelText('标准', names)).toBe(false)
    expect(isPresetLabelText('标准模式 2', names)).toBe(false)
    expect(isPresetLabelText('', names)).toBe(false)
    expect(isPresetLabelText(undefined, names)).toBe(false)
    expect(isPresetLabelText('标准模式', [])).toBe(false)
  })
})

describe('the read-only preset meta row', () => {
  it('renders the preset name as non-interactive text', () => {
    const markup = renderToStaticMarkup(createElement(SessionPresetMeta, { name: '标准模式' }))
    expect(markup).toContain('Agent 预设：标准模式')
    // A span, never a button: it must not be clickable nor enter the tab order.
    expect(markup.startsWith('<span')).toBe(true)
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('tabindex')
    expect(markup).not.toContain('role="menuitem"')
  })

  it('renders nothing without a preset', () => {
    expect(renderToStaticMarkup(createElement(SessionPresetMeta, {}))).toBe('')
    expect(renderToStaticMarkup(createElement(SessionPresetMeta, { name: '' }))).toBe('')
  })
})

describe('the native label hide: text match only, header scope only', () => {
  const label = readFileSync(new URL('../src/client/agent-preset-label.ts', import.meta.url), 'utf8')
  const chrome = readFileSync(new URL('../src/client/team-member-chrome.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')

  function block(selector: string): string {
    const start = css.indexOf(`${selector} {`)
    expect(start).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start) + 1)
  }

  it('scopes matching to the Session header slot and never guesses a hashed class', () => {
    expect(label).toContain('export const HEADER_SCOPE_SELECTOR = \'[data-slot="conversation.session.header"]\'')
    expect(label).toContain('document.querySelector<HTMLElement>(HEADER_SCOPE_SELECTOR)')
    expect(label).not.toContain('class*=')
    expect(label).not.toContain('f8BMvq')
    // Matching spans are found inside the header scope, not the whole document.
    expect(label).toContain('findPresetLabelNodes(scope, names)')
    expect(label).toContain('scope.querySelectorAll<HTMLElement>(\'span\')')
  })

  it('restores the original display when the surface leaves BOT or the control unmounts', () => {
    expect(label).toContain("dataset.dshSurfaceMode ?? 'team'")
    expect(label).toContain("surface !== 'team'")
    expect(label).toContain('node.style.display = node.getAttribute(DISPLAY_ATTR) ?? \'\'')
    expect(label).toContain('restore()')
    // The returned disposer is the cleanup path the component uses.
    expect(label).toContain('return () => {')
    expect(label).toContain('pageObserver.disconnect()')
    expect(label).toContain('modeObserver.disconnect()')
  })

  it('is fail-open: no names means the effect installs nothing', () => {
    expect(label).toContain('names.length === 0)')
    expect(chrome).toContain('presetLabel === undefined || presetNames.length === 0')
    expect(chrome).toContain('return hideNativePresetLabels(presetNames)')
  })

  it('puts the meta row under the create row in the same panel', () => {
    expect(chrome).toContain('<SessionPresetMeta name={presetLabel} />')
    const create = chrome.indexOf('void createThread(team)')
    const meta = chrome.indexOf('<SessionPresetMeta name={presetLabel} />')
    expect(create).toBeGreaterThan(-1)
    expect(meta).toBeGreaterThan(create)
    // The panel is only mounted on a team conversation (component bails out otherwise).
    expect(chrome).toContain('if (!model.switchable) return null')
  })

  it('styles the meta as a 12px tertiary single line with no hover affordance', () => {
    const metaStyle = block('.teamSessionPreset')
    expect(metaStyle).toContain('font-size: 12px')
    expect(metaStyle).toContain('color: var(--dsw-alias-label-tertiary)')
    expect(metaStyle).toContain('white-space: nowrap')
    expect(metaStyle).toContain('overflow: hidden')
    expect(metaStyle).toContain('text-overflow: ellipsis')
    expect(metaStyle).not.toContain('cursor')
    expect(css).not.toContain('.teamSessionPreset:hover')
  })
})
