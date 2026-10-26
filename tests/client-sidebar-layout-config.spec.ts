import { describe, expect, it } from 'vitest'
import { entryOptions, withAssignment } from '../src/client/sidebar-layout-section.js'
import { EMPTY_LAYOUT } from '../src/client/sidebar-layout-data.js'

describe('sidebar layout config ui', () => {
  it('offers origin, four slots and hidden', () => {
    const options = entryOptions({ key: 'panels:插件', label: '插件', originSlot: 'panels', order: 0, movable: true })
    expect(options.map(o => o.value)).toEqual(['origin', 'top', 'panels', 'submenu', 'footer', 'hidden'])
  })

  it('offers only the current slot for a non-movable entry', () => {
    const options = entryOptions({ key: 'panels:搜索', label: '搜索', originSlot: 'panels', order: 0, movable: false })
    expect(options.map(o => o.value)).toEqual(['origin'])
  })

  it('drops the assignment when the value is origin', () => {
    const config = withAssignment({ version: 1, assignment: { 'panels:插件': 'footer' } }, 'panels:插件', 'origin')
    expect(config).toEqual(EMPTY_LAYOUT)
  })

  it('records an assignment otherwise', () => {
    expect(withAssignment(EMPTY_LAYOUT, 'panels:插件', 'submenu'))
      .toEqual({ version: 1, assignment: { 'panels:插件': 'submenu' } })
  })

  it('never mutates the config it was given', () => {
    const config = { version: 1 as const, assignment: { 'panels:插件': 'footer' as const } }
    const next = withAssignment(config, 'panels:插件', 'hidden')
    expect(config.assignment).toEqual({ 'panels:插件': 'footer' })
    expect(next).not.toBe(config)
  })
})
