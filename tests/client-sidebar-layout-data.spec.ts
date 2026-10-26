import { describe, expect, it } from 'vitest'
import {
  EMPTY_LAYOUT, SLOT_LABELS, deriveKey, hidesAfterRender, isToolLabel,
  parseLayoutConfig, planLayout, resolveSlot, serializeLayoutConfig, slugLabel,
  type LayoutEntry,
} from '../src/client/sidebar-layout-data.js'

const entries: LayoutEntry[] = [
  { key: 'panels:插件', label: '插件', originSlot: 'panels', order: 0, movable: true },
  { key: 'panels:自动化任务', label: '自动化任务', originSlot: 'panels', order: 1, movable: true },
  { key: 'footer:插件市场', label: '插件市场', originSlot: 'footer', order: 0, movable: true },
]

describe('sidebar layout data', () => {
  it('derives a stable key from slot and accessible label', () => {
    expect(slugLabel('  Plugins  ')).toBe('plugins')
    expect(deriveKey('panels', '插件')).toBe('panels:插件')
  })

  it('keeps the current layout when nothing is configured', () => {
    expect(parseLayoutConfig(null)).toEqual(EMPTY_LAYOUT)
    expect(resolveSlot(entries[0]!, EMPTY_LAYOUT)).toBe('panels')
  })

  it('falls back to empty config on invalid or foreign json', () => {
    expect(parseLayoutConfig('{oops')).toEqual(EMPTY_LAYOUT)
    expect(parseLayoutConfig(JSON.stringify({ version: 2, assignment: {} }))).toEqual(EMPTY_LAYOUT)
  })

  it('round-trips a config', () => {
    const config = { version: 1 as const, assignment: { 'panels:插件': 'footer' as const } }
    expect(parseLayoutConfig(serializeLayoutConfig(config))).toEqual(config)
  })

  it('ignores assignments that point at unknown entries', () => {
    const config = parseLayoutConfig(JSON.stringify({ version: 1, assignment: { 'panels:gone': 'footer' } }))
    const plan = planLayout(entries, config)
    expect(plan.hide).toEqual([])
    expect(plan.mirrors).toEqual([])
  })

  it('plans a mirror and a hide for a moved entry', () => {
    const plan = planLayout(entries, { version: 1, assignment: { 'panels:插件': 'footer' } })
    expect(plan.hide).toEqual(['panels:插件'])
    expect(plan.mirrors).toEqual([{ key: 'panels:插件', slot: 'footer', order: 0, label: '插件' }])
  })

  it('hides an entry without a mirror when it is assigned to hidden', () => {
    const plan = planLayout(entries, { version: 1, assignment: { 'panels:自动化任务': 'hidden' } })
    expect(plan.hide).toEqual(['panels:自动化任务'])
    expect(plan.mirrors).toEqual([])
  })

  it('marks the submenu invisible when it holds no mirror', () => {
    expect(planLayout(entries, EMPTY_LAYOUT).submenuVisible).toBe(false)
    expect(planLayout(entries, { version: 1, assignment: { 'panels:插件': 'submenu' } }).submenuVisible).toBe(true)
  })

  it('hides nothing when the mirror did not render', () => {
    const plan = planLayout(entries, { version: 1, assignment: { 'panels:插件': 'footer' } })
    expect(hidesAfterRender(plan, new Set())).toEqual([])
    expect(hidesAfterRender(plan, new Set(['panels:插件']))).toEqual(['panels:插件'])
  })

  it('keeps an unconfigured entry at its origin when other keys are configured', () => {
    const config = parseLayoutConfig(JSON.stringify({ version: 1, assignment: { 'panels:自动化任务': 'footer' } }))
    expect(resolveSlot(entries[0]!, config)).toBe('panels')
  })

  it('keeps relative order inside one target slot', () => {
    const plan = planLayout(entries, { version: 1, assignment: { 'panels:插件': 'footer', 'panels:自动化任务': 'footer' } })
    expect(plan.mirrors.map(m => m.key)).toEqual(['panels:插件', 'panels:自动化任务'])
  })

  it('recognizes tool buttons as not movable', () => {
    expect(isToolLabel('搜索')).toBe(true)
    expect(isToolLabel('筛选')).toBe(true)
    expect(isToolLabel('新建团队')).toBe(true)
    expect(isToolLabel('插件')).toBe(false)
    expect(SLOT_LABELS.submenu).toBe('下菜单')
  })
})
