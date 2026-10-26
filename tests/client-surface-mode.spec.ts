import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  SURFACE_MODE_KEY,
  readSurfaceMode,
  resolveSurfaceMode,
  writeSurfaceMode,
} from '../src/client/surface-mode.js'

describe('surface mode constants', () => {
  it('uses the documented storage key', () => {
    expect(SURFACE_MODE_KEY).toBe('dsh-team-mode:surface-mode')
  })
})

describe('readSurfaceMode', () => {
  it('reads valid stored values', () => {
    const read = (value: string): ReturnType<typeof readSurfaceMode> => {
      const getItem = vi.fn(() => value)
      return readSurfaceMode({ getItem })
    }

    expect(read('team')).toBe('team')
    expect(read('native')).toBe('native')
  })

  it('reads the documented key from storage', () => {
    const getItem = vi.fn(() => 'native')
    expect(readSurfaceMode({ getItem })).toBe('native')
    expect(getItem).toHaveBeenCalledWith(SURFACE_MODE_KEY)
  })

  it('falls back to team when storage or the value is missing', () => {
    expect(readSurfaceMode(undefined)).toBe('team')
    expect(readSurfaceMode({ getItem: () => null })).toBe('team')
  })

  it('falls back to team for invalid stored values', () => {
    expect(readSurfaceMode({ getItem: () => '' })).toBe('team')
    expect(readSurfaceMode({ getItem: () => 'TEAM' })).toBe('team')
    expect(readSurfaceMode({ getItem: () => ' team ' })).toBe('team')
    expect(readSurfaceMode({ getItem: () => 'true' })).toBe('team')
  })

  it('honours the caller fallback and survives restricted storage', () => {
    expect(readSurfaceMode({ getItem: () => null }, 'native')).toBe('native')
    expect(readSurfaceMode({
      getItem: () => {
        throw new Error('storage denied')
      },
    })).toBe('team')
  })
})

describe('writeSurfaceMode', () => {
  it('writes the mode under the documented key', () => {
    const setItem = vi.fn()
    writeSurfaceMode({ setItem }, 'native')

    expect(setItem).toHaveBeenCalledWith(SURFACE_MODE_KEY, 'native')
  })

  it('does not throw when storage is missing or write fails', () => {
    expect(() => writeSurfaceMode(undefined, 'team')).not.toThrow()
    expect(() => writeSurfaceMode({
      setItem: () => {
        throw new Error('storage denied')
      },
    }, 'team')).not.toThrow()
  })
})

describe('resolveSurfaceMode', () => {
  it('prefers a valid stored mode', () => {
    expect(resolveSurfaceMode({ stored: 'native', configured: 'team' })).toBe('native')
    expect(resolveSurfaceMode({ stored: 'team', configured: 'native' })).toBe('team')
  })

  it('falls back to the configured mode, then team', () => {
    expect(resolveSurfaceMode({ stored: null, configured: 'native' })).toBe('native')
    expect(resolveSurfaceMode({ stored: 'unexpected', configured: 'native' })).toBe('native')
    expect(resolveSurfaceMode({ stored: null })).toBe('team')
    expect(resolveSurfaceMode({ stored: 'unexpected' })).toBe('team')
    expect(resolveSurfaceMode({})).toBe('team')
  })
})

const readClientSource = (name: string): string => readFileSync(
  new URL(`../src/client/${name}`, import.meta.url),
  'utf8',
)

describe('sidebar surface switch', () => {
  const sidebar = readClientSource('sidebar.tsx')
  const index = readClientSource('index.tsx')

  it('always renders one DeepSeek/DeepBot control as a brand-shaped dropdown', () => {
    expect(sidebar).toContain('data-dsh-surface-switch')
    expect(sidebar).toContain("label: 'DeepSeek'")
    expect(sidebar).toContain("label: 'DeepBot'")
    // The popover is the shipped Menu primitive, not a hand-built list.
    expect(sidebar).toContain('<Menu')
    expect(sidebar).toContain('aria-haspopup="menu"')
    expect(sidebar).toContain('selectedId={mode}')
    const switchAt = sidebar.indexOf('<SurfaceModeSwitch')
    const gateAt = sidebar.indexOf("{mode === 'team' && (")
    expect(switchAt).toBeGreaterThan(-1)
    expect(gateAt).toBeGreaterThan(switchAt)
  })

  it('mounts the switch where the shipped brand row was', () => {
    // Host ids live in one module so the shell and the assistant section agree.
    expect(sidebar).toContain('BRAND_HOST_ID')
    expect(sidebar).toContain("from './sidebar-hosts.js'")
    expect(sidebar).toContain('[class*="_logoRow"]')
    expect(sidebar).toContain('ensureBrand')
    // The row itself survives; only the original brand button is hidden.
    expect(sidebar).toContain('brand.style.display')
    // The rail is narrow on mobile and widens into the drawer without a
    // window resize; the brand row itself must be observed.
    expect(sidebar).toContain('brandResize.observe(logoRow)')
  })

  it('renders the pinned coordinator with the real assistant row', () => {
    const assistant = readClientSource('assistant-sidebar.tsx')
    expect(assistant).toContain('renderAssistantRow')
    expect(assistant).toContain('createPortal(renderAssistantRow(coordinator)')
    expect(assistant).toContain('coordinatorAssistant')
    // The row is removed from the list, not duplicated.
    expect(assistant).toMatch(/filter\(instance => instance\.id !== coordinatorId\)/)
  })

  it('drives the pinned row and the DeepBot entry from the coordinator field only', () => {
    const assistant = readClientSource('assistant-sidebar.tsx')
    // No name/template guessing survives: an empty field means no pinned row.
    // 管家 is only the brand menu's label, never a name to match an instance on.
    expect(assistant).not.toContain('管家')
    expect(assistant).not.toContain('builtin-chief')
    expect(sidebar).toContain("label: '打开管家会话'")
    expect(sidebar).not.toContain("=== '管家'")
    expect(sidebar).not.toContain('builtin-chief')
    // The brand row resolves the coordinator Session from the same field.
    expect(sidebar).toContain('coordinatorAssistant(instances)')
    // 设为/取消总协调 goes through the one host write.
    expect(assistant).toContain("callAgentTeam('assistant.coordinator.set'")
    expect(assistant).toContain('assistantId: isCoordinatorInstance(instance) ? null : instance.id')
  })

  it('puts a right-aligned 搜索 / 筛选 / 新建 group on the brand row', () => {
    expect(sidebar).toContain('brandActions')
    expect(sidebar).toContain('aria-label="搜索"')
    expect(sidebar).toContain('aria-label="筛选"')
    expect(sidebar).toContain('aria-label="新建"')
    // DeepSeek mode forwards to the shipped controls; DeepBot uses our own.
    expect(sidebar).toContain('clickNativeAction')
    expect(sidebar).toContain('startNativeSession')
    // 筛选 opens the section's own filter/sort menu instead of a second menu.
    expect(sidebar).toContain('dsh-team-mode:sidebar-menu')
    // 搜索 expands in place with the section's own search shell, filling the row.
    expect(sidebar).toContain('css.sidebarTeamSearch')
    expect(sidebar).toContain('SIDEBAR_SEARCH_EVENT')
    // 新建 is a menu, because which list to create in cannot be guessed.
    expect(sidebar).toContain("label: '新建团队'")
    expect(sidebar).toContain("label: '新建助手'")
    expect(sidebar).toContain('openCreateTeamDialog()')
    expect(sidebar).toContain('SIDEBAR_ASSISTANT_CREATE_EVENT')
    const assistant = readClientSource('assistant-sidebar.tsx')
    // Both lists answer the one brand search, and the assistant owns 新建助手.
    expect(assistant).toContain('SIDEBAR_SEARCH_EVENT')
    expect(assistant).toContain('window.addEventListener(SIDEBAR_ASSISTANT_CREATE_EVENT, onCreate)')
  })

  it('persists the switch through the surface-mode helper', () => {
    expect(sidebar).toContain('readSurfaceMode(surfaceStorage())')
    expect(sidebar).toContain('writeSurfaceMode(surfaceStorage(), next)')
    expect(sidebar).toContain('useSyncExternalStore(subscribeSurfaceMode, getSurfaceMode')
  })

  it('hides team and assistant sections in native mode', () => {
    expect(sidebar).toContain("{mode === 'team' && (")
    expect(sidebar).toContain('<SidebarTeamSection')
    expect(sidebar).toContain('<AssistantSidebarSection')
  })

  it('keeps the native Session row hider mounted in both modes', () => {
    expect(index).toContain('<SessionRowHider />')
    expect(index).not.toContain("{mode === 'team' && <SessionRowHider")
  })

  it('moves 插件 and 自动化任务 into the BOT footer and drops the market entry', () => {
    expect(sidebar).toContain('BOT_FOOTER_ENTRIES')
    expect(sidebar).toContain('dsh-team-mode-footer-host')
    expect(sidebar).toContain("title: '插件'")
    expect(sidebar).toContain("title: '自动化任务'")
    // The market entry is what the footer actions replace.
    expect(sidebar).toMatch(/插件广场\|市场\|market/)
    // Proxy clicks go to the real control instead of reimplementing it.
    expect(sidebar).toContain('native.click()')
    expect(sidebar).toContain('data-dsh-bot-hidden')
  })

  it('drops 新会话 instead of moving it, and keeps the footer on one line', () => {
    expect(sidebar).toContain('BOT_DROPPED_ENTRIES')
    expect(sidebar).toContain("key: 'new-session'")
    expect(sidebar).not.toContain("title: '新会话'")
    expect(sidebar).toContain('_footerActions')
  })

  it('restores every native node in DSH mode', () => {
    const restoreAt = sidebar.indexOf('function restoreBotSidebar')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(sidebar).toContain('restoreBotSidebar()')
    expect(sidebar).toContain("if (mode !== 'team')")
  })

  it('registers team conversation views and overlays only in team mode', () => {
    expect(index).toContain("mode !== 'team'")
    expect(index).toContain('useSurfaceMode')
    expect(index).toContain('TeamParallelOverlay')
    expect(index).toContain('TeamModeDialogsHost')
  })
})

describe('surface switch styling', () => {
  const styles = readFileSync(
    new URL('../src/client/AgentTeam.module.css', import.meta.url),
    'utf8',
  )

  it('uses semantic DSH tokens and a visible focus ring', () => {
    expect(styles).toContain('.brandModeTrigger')
    expect(styles).toMatch(/\.brandModeTrigger:focus-visible/)
    // No second popover style of our own: the menu is the primitive's.
    expect(styles).not.toContain('.brandModeMenu')
    // The trigger carries no background or border of its own.
    expect(styles).toContain('background: transparent;')
    expect(styles).toContain('var(--dsw-alias-border-l1)')
    expect(styles).toContain('var(--dsw-alias-label-primary)')
  })

  it('hides the shipped workspace rows in BOT mode only', () => {
    // The team host stays; only the native siblings after it are hidden.
    expect(styles).toContain("[data-dsh-team-mode='sidebar'] ~ *")
    expect(styles).toContain("html[data-dsh-surface-mode='team']")
    expect(styles).toContain('.sidebarBrandHost')
  })

  it('styles the BOT footer actions as icon buttons on semantic tokens', () => {
    expect(styles).toContain('.botFooterHost')
    expect(styles).toContain('.botFooterAction')
    expect(styles).toMatch(/\.botFooterAction > svg/)
    expect(styles).toContain('var(--dsw-alias-interactive-bg-hover)')
  })
})
