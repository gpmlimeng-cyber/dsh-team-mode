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
