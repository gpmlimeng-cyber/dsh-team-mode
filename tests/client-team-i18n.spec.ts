import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEAM_EN, TEAM_ZH, teamText } from '../src/client/team-i18n.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('team i18n dictionaries', () => {
  it('keeps the zh and en key sets identical', () => {
    expect(Object.keys(TEAM_ZH).sort()).toEqual(Object.keys(TEAM_EN).sort())
  })

  it('resolves the team namespace in Chinese for an English shell too', () => {
    // The team surface ships Chinese copy end to end; resolving a key from the
    // shell locale is what put `Manage team` beside 置顶 and 归档 (E2E F3).
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(teamText('view.parallel')).toBe('群聊')
    expect(teamText('warmup.preparing', { name: 'Lead' })).toBe('正在准备 Lead 与成员')
    expect(teamText('sidebar.manage')).toBe('团队管理')
    expect(teamText('member.reconnect')).toBe('重连')
  })

  it('falls back to Chinese for a zh browser', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(teamText('view.board')).toBe('看板')
    expect(teamText('context.confirmTitle', { name: 'Alice' })).toContain('Alice')
  })
})
