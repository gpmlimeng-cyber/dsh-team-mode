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

  it('always renders one compact native/team switch', () => {
    expect(sidebar).toContain('data-dsh-surface-switch')
    expect(sidebar).toContain('原生')
    expect(sidebar).toContain('团队')
    expect(sidebar).toContain("aria-pressed={mode === 'native'}")
    expect(sidebar).toContain("aria-pressed={mode === 'team'}")
    const switchAt = sidebar.indexOf('<SurfaceModeSwitch')
    const gateAt = sidebar.indexOf("{mode === 'team' && (")
    expect(switchAt).toBeGreaterThan(-1)
    expect(gateAt).toBeGreaterThan(switchAt)
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
    expect(styles).toContain('.surfaceModeSwitch')
    expect(styles).toContain('.surfaceModeButtonActive')
    expect(styles).toMatch(/\.surfaceModeButton:focus-visible/)
    expect(styles).toContain('var(--dsw-alias-border-l1)')
    expect(styles).toContain('var(--dsw-alias-label-primary)')
  })
})
