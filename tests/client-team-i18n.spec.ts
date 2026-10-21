import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEAM_EN, TEAM_ZH, teamText } from '../src/client/team-i18n.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('team i18n dictionaries', () => {
  it('keeps the zh and en key sets identical', () => {
    expect(Object.keys(TEAM_ZH).sort()).toEqual(Object.keys(TEAM_EN).sort())
  })

  it('falls back to English without a mounted locale service', () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(teamText('view.parallel')).toBe('Parallel')
    expect(teamText('warmup.preparing', { name: 'Lead' })).toBe('Preparing Lead and the members')
  })

  it('falls back to Chinese for a zh browser', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(teamText('view.board')).toBe('看板')
    expect(teamText('context.confirmTitle', { name: 'Alice' })).toContain('Alice')
  })
})
