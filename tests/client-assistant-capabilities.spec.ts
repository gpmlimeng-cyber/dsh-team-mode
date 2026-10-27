import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The primitives package needs browser peers this node test does not install.
// The stub keeps the native input so checked/disabled state stays readable.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Checkbox: (props: {
    checked: boolean
    label: string
    disabled?: boolean
    title?: string
    onChange: (next: boolean) => void
  }): unknown => createElement(
    'label',
    { title: props.title },
    createElement('input', {
      type: 'checkbox',
      checked: props.checked,
      disabled: props.disabled,
      readOnly: true,
    }),
    createElement('span', undefined, props.label),
  ),
}))

const { CapabilityPicker, capabilityRows, savableNames } = await import(
  '../src/client/assistant-capabilities.js'
)

const OPTIONS = [
  { name: 'research', detail: '查资料' },
  { name: 'review', detail: '评审' },
]

function renderPicker(overrides: Partial<Parameters<typeof CapabilityPicker>[0]> = {}): string {
  return renderToStaticMarkup(createElement(CapabilityPicker, {
    label: '技能（已选 0 个）',
    ariaLabel: '选择助手可使用的 Skills',
    hint: '运行时会按任务需要加载具体 Skill 指令。',
    emptyText: '该 Agent Preset 没有可用的 Skill。',
    missingDetail: '该 Agent Preset 不再提供这个 Skill，保存时不会带上',
    selected: [],
    options: OPTIONS,
    loading: false,
    error: undefined,
    disabled: false,
    onChange: () => undefined,
    ...overrides,
  }))
}

describe('capabilityRows', () => {
  it('keeps a selected name the catalog lost, in front, checked and explained', () => {
    const rows = capabilityRows(['review', 'retired-skill'], OPTIONS, '不再提供')
    expect(rows).toEqual([
      { name: 'retired-skill', detail: '不再提供', checked: true, unavailable: true },
      { name: 'research', detail: '查资料', checked: false, unavailable: false },
      { name: 'review', detail: '评审', checked: true, unavailable: false },
    ])
  })

  it('lists every catalog option when nothing is selected', () => {
    expect(capabilityRows([], OPTIONS, '不再提供').map(row => row.name))
      .toEqual(['research', 'review'])
    expect(capabilityRows([], OPTIONS, '不再提供').every(row => !row.checked)).toBe(true)
  })
})

describe('savableNames', () => {
  it('drops the names the current catalog does not offer and keeps the rest in order', () => {
    expect(savableNames(['github', 'research', 'retired'], OPTIONS)).toEqual(['research'])
    expect(savableNames([], OPTIONS)).toEqual([])
  })
})

describe('CapabilityPicker', () => {
  it('renders the shipped Checkbox grid with the catalog details', () => {
    const html = renderPicker({ selected: ['research'] })
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="选择助手可使用的 Skills"')
    expect(html).toContain('查资料')
    expect(html).toContain('运行时会按任务需要加载具体 Skill 指令。')
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/)
  })

  it('shows a lost entry as unavailable instead of dropping it', () => {
    const html = renderPicker({ selected: ['retired-skill'] })
    expect(html).toContain('retired-skill（不可用）')
    expect(html).toContain('该 Agent Preset 不再提供这个 Skill，保存时不会带上')
    expect(html).toContain('data-capability-unavailable="true"')
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/)
    // The lost row is the first one: an existing problem is not buried below the fold.
    expect(html.indexOf('retired-skill')).toBeLessThan(html.indexOf('research'))
  })

  it('reports loading, failure and an empty catalog as three different states', () => {
    expect(renderPicker({ loading: true })).toContain('正在读取该 Agent Preset 的目录…')
    expect(renderPicker({ error: '离线' })).toContain('读取失败：离线')
    expect(renderPicker({ options: [] })).toContain('该 Agent Preset 没有可用的 Skill。')
  })

  it('refuses interaction while the dialog is saving', () => {
    const html = renderPicker({ disabled: true })
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(OPTIONS.length)
  })
})

describe('the template editor reuses the shared picker', () => {
  const source = readFileSync(
    new URL('../src/client/assistants/AssistantPanel.tsx', import.meta.url),
    'utf8',
  )

  it('renders the one CapabilityPicker for Skills and MCP', () => {
    expect((source.match(/<CapabilityPicker/g) ?? [])).toHaveLength(2)
    expect(source).toContain('assistant-capabilities.js')
    // The old hand-rolled grid and its per-list fetch states are gone.
    expect(source).not.toContain('css.skillPicker')
    expect(source).not.toContain('available-skills')
    expect(source).not.toContain('setSkillsLoading')
    expect(source).not.toContain('setMcpLoading')
  })

  it('keeps the entries the preset lost visible instead of filtering them out', () => {
    // The old effects silently pruned a selection the catalog stopped offering.
    expect(source).not.toContain('availableNames')
    expect(source).not.toContain('current.filter(name => availableNames.has(name))')
    expect(source).toContain('useCapabilityCatalog(agentPresetId)')
    expect(source).toContain('missingDetail=')
    // ...and the pruned list is what gets saved, exactly like the dialogs.
    expect(source).toContain('savableNames(selectedSkills, capabilities.skills)')
    expect(source).toContain('savableNames(selectedMcpServers, capabilities.mcpServers)')
  })
})
