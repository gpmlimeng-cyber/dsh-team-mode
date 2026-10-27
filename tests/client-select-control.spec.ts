import { readFileSync, readdirSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The pill select is the shipped `Menu` around our trigger. The stub keeps the
 * anchor (what a closed dialog renders) and exposes the rows it was handed, so
 * the option/group mapping is assertable without a browser.
 */
const menuCalls: Array<{ items: unknown; selectedId: string | undefined }> = []
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Menu: (props: { anchor: unknown; items: unknown; selectedId?: string }): unknown => {
    menuCalls.push({ items: props.items, selectedId: props.selectedId })
    return createElement('span', { 'data-menu': '' }, props.anchor as never)
  },
  IconChevronDownOutlineRegular: (): unknown => createElement('span', { 'data-chevron': '' }),
}))

const { SelectControl } = await import('../src/client/select-control.js')
const { SettingsRow, SettingsRows } = await import('../src/client/settings-row.js')

const OPTIONS = [
  { value: 'standard', label: 'Standard', group: '常用' },
  { value: 'review', label: '评审', group: '常用' },
  { value: 'danger', label: '全权', group: '其他' },
]

function renderSelect(overrides: Partial<Parameters<typeof SelectControl>[0]> = {}): string {
  menuCalls.length = 0
  return renderToStaticMarkup(createElement(SelectControl, {
    value: 'standard',
    options: OPTIONS,
    onChange: () => undefined,
    ariaLabel: 'Agent Preset',
    ...overrides,
  }))
}

describe('SelectControl', () => {
  it('renders the current value and a chevron as a closed pill', () => {
    const html = renderSelect()
    expect(html).toContain('data-menu')
    expect(html).toContain('>Standard<')
    expect(html).toContain('data-chevron')
    expect(html).not.toContain('<select')
  })

  it('is a button with the listbox contract, closed until asked', () => {
    const html = renderSelect()
    expect(html).toMatch(/<button[^>]*type="button"/)
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Agent Preset"')
  })

  it('hands the menu grouped rows, one heading per group, and the current selection', () => {
    renderSelect()
    expect(menuCalls).toHaveLength(1)
    expect(menuCalls[0]?.selectedId).toBe('standard')
    expect(menuCalls[0]?.items).toEqual([
      { type: 'label', id: 'group:常用', text: '常用' },
      { id: 'standard', label: 'Standard' },
      { id: 'review', label: '评审' },
      { type: 'label', id: 'group:其他', text: '其他' },
      { id: 'danger', label: '全权' },
    ])
  })

  it('marks a disabled option disabled instead of hiding it', () => {
    renderSelect({ options: [{ value: 'a', label: 'A', disabled: true }] })
    expect(menuCalls[0]?.items).toEqual([{ id: 'a', label: 'A', disabled: true }])
  })

  it('shows a stored value the options lost instead of a blank pill', () => {
    expect(renderSelect({ value: 'retired-preset' })).toContain('>retired-preset<')
    expect(renderSelect({ value: '' })).toContain('>请选择<')
    expect(renderSelect({ value: '', placeholder: '没有可用模型' })).toContain('>没有可用模型<')
  })

  it('refuses input while disabled', () => {
    expect(renderSelect({ disabled: true })).toMatch(/<button[^>]*disabled=""/)
  })

  it('portals its list so a dialog never clips it', () => {
    const source = readFileSync(new URL('../src/client/select-control.tsx', import.meta.url), 'utf8')
    expect(source).toContain('portal')
  })
})

describe('SettingsRow', () => {
  it('puts the label and grey hint on the left and the control on the right', () => {
    const html = renderToStaticMarkup(createElement(SettingsRow, {
      label: '模型',
      hint: '保存时同时写入 Provider 与模型。',
      control: createElement('span', undefined, 'FAST'),
    }))
    expect(html).toContain('模型')
    expect(html).toContain('保存时同时写入 Provider 与模型。')
    expect(html).toContain('FAST')
    expect(html.indexOf('模型')).toBeLessThan(html.indexOf('FAST'))
  })

  it('skips an empty hint instead of rendering an empty line', () => {
    const html = renderToStaticMarkup(createElement(SettingsRow, {
      label: '名称',
      hint: '',
      control: createElement('span', undefined, 'x'),
    }))
    expect(html).not.toContain('<span></span>')
  })

  it('stacks rows and draws the hairline between them, never after the last', () => {
    const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
    const row = css.slice(css.indexOf('.settingsRow {'), css.indexOf('}', css.indexOf('.settingsRow {')))
    expect(row).toContain('border-bottom: 1px solid var(--dsw-alias-border-l1)')
    expect(css).toContain('.settingsRow:last-child {')
    const html = renderToStaticMarkup(createElement(SettingsRows, {
      children: createElement('span', undefined, 'row'),
    }))
    expect(html).toContain('row')
  })

  it('sticks to the design tokens (no custom colors)', () => {
    const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
    for (const block of ['.settingsRow {', '.settingsRowLabel {', '.settingsRowHint {']) {
      const start = css.indexOf(block)
      const body = css.slice(start, css.indexOf('}', start))
      expect(body).toContain('var(--dsw-')
      expect(body).not.toMatch(/#[0-9a-f]{3,6}/i)
    }
  })
})

describe('one select implementation', () => {
  function clientSources(): Array<{ path: string; source: string }> {
    const root = new URL('../src/client/', import.meta.url)
    const out: Array<{ path: string; source: string }> = []
    const walk = (dir: URL): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(entry.name, dir)
        if (entry.isDirectory()) {
          walk(new URL(`${entry.name}/`, dir))
        } else if (/\.tsx?$/.test(entry.name)) {
          out.push({ path: child.pathname, source: readFileSync(child, 'utf8') })
        }
      }
    }
    walk(root)
    return out
  }

  it('leaves no browser <select> anywhere in the client', () => {
    const offenders = clientSources()
      .filter(file => /<select[\s>]/.test(file.source))
      .map(file => file.path.split('/src/client/')[1])
    expect(offenders).toEqual([])
  })

  it('keeps every dropdown on the one control', () => {
    const importers = clientSources()
      .filter(file => file.source.includes("from './select-control.js'")
        || file.source.includes("from '../select-control.js'"))
      .map(file => file.path.split('/src/client/')[1] ?? '')
      .sort()
    expect(importers).toEqual([
      'assistant-dialogs.tsx',
      'assistant-memory-panel.tsx',
      'assistant-settings-pane.tsx',
      'assistants/AssistantPanel.tsx',
      // The merged model control composes the one control; it is not a second
      // dropdown implementation.
      'model-control.tsx',
      'team-activity.tsx',
      'team-board.tsx',
      'teams/TeamPanel.tsx',
      'workbench/ConversationColumn.tsx',
    ])
  })
})
