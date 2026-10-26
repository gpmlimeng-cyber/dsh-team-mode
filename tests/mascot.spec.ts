import { describe, expect, it } from 'vitest'
import { TEAM_IDENTITY_COLORS } from '../src/client/team-identity.js'
import {
  MASCOT_ANIMATIONS,
  MASCOT_EYES,
  MASCOT_SHAPES,
  MASCOT_SPACINGS,
  assistantShowsMascot,
  mascotAvatarShape,
  mascotColor,
  mascotDataUri,
  mascotMotion,
  mascotMotionForStatus,
  mascotOptionsFor,
  mascotPaletteColor,
  mascotSvg,
  type MascotMotion,
} from '../src/client/mascot.js'
import { assistantInstanceSchema, updateAssistantInstanceInputSchema } from '../src/domain/schemas.js'
import type { AssistantInstance } from '../src/domain/types.js'

const NOW = '2026-10-26T00:00:00.000Z'

function instance(overrides: Partial<AssistantInstance> = {}): AssistantInstance {
  return {
    schemaVersion: 1,
    id: 'assistant-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: '小助手',
      instructions: '',
      provider: 'deepseek',
      model: 'deepseek-chat',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/workspace-1',
    status: 'idle',
    pinned: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('mascot generation', () => {
  it('renders the same SVG for the same seed and options', () => {
    expect(mascotSvg('alpha')).toBe(mascotSvg('alpha'))
    expect(mascotSvg('alpha', { eyesVariant: 'big' })).toBe(mascotSvg('alpha', { eyesVariant: 'big' }))
  })

  it('renders a different SVG for another seed', () => {
    expect(mascotSvg('alpha')).not.toBe(mascotSvg('beta'))
  })

  it('changes the SVG when one exposed option changes', () => {
    const base = mascotSvg('alpha')
    expect(mascotSvg('alpha', { shapeVariant: 'square' })).not.toBe(base)
    expect(mascotSvg('alpha', { eyesVariant: 'happy' })).not.toBe(base)
    expect(mascotSvg('alpha', { spacingVariant: 'far' })).not.toBe(base)
    expect(mascotSvg('alpha', { bodyColor: '#A06A6A' })).not.toBe(base)
    expect(mascotSvg('alpha', { borderRadius: 50 })).not.toBe(base)
    expect(mascotSvg('alpha', { animationVariant: 'none' })).not.toBe(base)
  })

  it('exposes only real gaze variants', () => {
    expect(MASCOT_SHAPES).toContain('circle')
    expect(MASCOT_EYES).toContain('happy')
    expect(MASCOT_SPACINGS).toEqual(['close', 'snug', 'normal', 'wide', 'far'])
    expect(MASCOT_ANIMATIONS).toContain('none')
  })

  it('picks a stable palette colour per seed, taken from the identity palette', () => {
    const palette = TEAM_IDENTITY_COLORS.map((_, index) => mascotPaletteColor(index))
    expect(mascotColor('alpha')).toBe(mascotColor('alpha'))
    expect(palette).toContain(mascotColor('alpha'))
    expect(mascotColor('alpha')).toMatch(/^#[0-9a-fA-F]{6}$/)
    // DiceBear lower-cases colour literals in the markup.
    expect(mascotSvg('alpha').toLowerCase()).toContain(mascotColor('alpha').toLowerCase())
  })

  it('falls back to the seed colour for a stored non-hex colour', () => {
    expect(mascotSvg('alpha', { bodyColor: 'light-dark(#5F5E5A, #B9B7B0)' }))
      .toBe(mascotSvg('alpha'))
  })

  it('encodes the SVG into a data URI, not HTML', () => {
    const uri = mascotDataUri('alpha')
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(uri).not.toContain('<svg')
  })
})

describe('mascot tile shape', () => {
  it('follows the avatar treatment', () => {
    expect(mascotAvatarShape('circle')).toBe('circle')
    expect(mascotAvatarShape('square')).toBe('square')
    expect(mascotAvatarShape(undefined)).toBe('rounded')
    expect(mascotAvatarShape('triangle')).toBe('rounded')
  })
})

describe('mascot motion', () => {
  const states: MascotMotion[] = ['idle', 'thinking', 'working', 'success', 'failure', 'hover', 'none']

  it('maps status-driven states to gaze animation speeds', () => {
    expect(mascotMotion('idle', { reducedMotion: false })).toEqual({ motion: 'idle', animation: 'medium' })
    expect(mascotMotion('thinking', { reducedMotion: false })).toEqual({ motion: 'thinking', animation: 'fast' })
    expect(mascotMotion('working', { reducedMotion: false })).toEqual({ motion: 'working', animation: 'fast' })
    expect(mascotMotion('success', { reducedMotion: false })).toEqual({ motion: 'success', animation: 'none' })
  })

  it('turns every animation off under prefers-reduced-motion', () => {
    for (const state of states) {
      expect(mascotMotion(state, { reducedMotion: true })).toEqual({ motion: 'none', animation: 'none' })
    }
  })

  it('keeps the CSS state while the animation toggle disables the SVG animation', () => {
    expect(mascotMotion('idle', { reducedMotion: false, animated: false }))
      .toEqual({ motion: 'idle', animation: 'none' })
  })

  it('maps only starting/active instances to working', () => {
    expect(mascotMotionForStatus('starting')).toBe('working')
    expect(mascotMotionForStatus('active')).toBe('working')
    expect(mascotMotionForStatus('idle')).toBe('idle')
    expect(mascotMotionForStatus('error')).toBe('idle')
  })
})

describe('mascot fallback', () => {
  it('shows the mascot only when no avatar can render', () => {
    expect(assistantShowsMascot(instance())).toBe(true)
    expect(assistantShowsMascot(instance({
      assistantSnapshot: { ...instance().assistantSnapshot, avatar: 'not-a-data-url' },
    }))).toBe(true)
    expect(assistantShowsMascot(instance({
      assistantSnapshot: { ...instance().assistantSnapshot, avatar: 'data:image/png;base64,iVBORw0KGgo=' },
    }))).toBe(false)
  })

  it('derives a stable seed and options from the instance', () => {
    expect(mascotOptionsFor(instance())).toEqual({ seed: 'assistant-1', options: {} })
    expect(mascotOptionsFor(instance({
      mascot: { seed: 'seed-1', shape: 'circle', eyes: 'big', spacing: 'wide', color: '#A06A6A' },
    }))).toEqual({
      seed: 'seed-1',
      options: {
        shapeVariant: 'circle',
        eyesVariant: 'big',
        spacingVariant: 'wide',
        bodyColor: '#A06A6A',
      },
    })
  })
})

describe('mascot schema', () => {
  const mascot = { seed: 'seed-1', shape: 'circle', eyes: 'big', spacing: 'wide', color: '#A06A6A' }

  it('parses an instance with a mascot and one without it', () => {
    expect(assistantInstanceSchema.parse(instance()).mascot).toBeUndefined()
    expect(assistantInstanceSchema.parse(instance({ mascot })).mascot).toEqual(mascot)
  })

  it('requires a seed and rejects unknown fields', () => {
    const missingSeed = { ...instance(), mascot: { shape: 'circle' } } as unknown as AssistantInstance
    const unknownField = { ...instance(), mascot: { ...mascot, animated: true } } as unknown as AssistantInstance
    expect(() => assistantInstanceSchema.parse(missingSeed)).toThrow()
    expect(() => assistantInstanceSchema.parse(unknownField)).toThrow()
  })

  it('accepts the same shape on the update input', () => {
    expect(updateAssistantInstanceInputSchema.parse({ mascot })).toEqual({ mascot })
    expect(updateAssistantInstanceInputSchema.parse({ name: 'x' })).toEqual({ name: 'x' })
    expect(() => updateAssistantInstanceInputSchema.parse({ mascot: { seed: '' } })).toThrow()
  })
})
