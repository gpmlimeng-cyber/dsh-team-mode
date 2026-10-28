import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MASCOT_DICEBEAR_ROTATE_DEG,
  MASCOT_DICEBEAR_SCALE_MAX,
  MASCOT_HOVER_ZOOM,
  MASCOT_SHAPE_FIT,
  mascotPeakEnvelope,
  mascotRotationEnvelope,
} from '../src/client/mascot-shape-fit.js'

const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')

/** One selector's declaration block; comments inside it are kept. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, `missing CSS rule ${selector}`).toBeGreaterThan(-1)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

/** The comment block directly above a selector: where the derivation lives. */
function commentBefore(selector: string): string {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, `missing CSS rule ${selector}`).toBeGreaterThan(-1)
  return css.slice(css.lastIndexOf('/*', at), at)
}

/**
 * Any way of cutting the mascot: `overflow: hidden|clip`, a mask, or
 * `contain: paint`. The user-facing rule is that overflow may happen but must
 * stay visible, so none of these belongs on a mascot container.
 */
function cuts(body: string): boolean {
  return /overflow\s*:\s*(hidden|clip)/.test(body)
    || /overflow\s*:\s*auto\s+hidden/.test(body)
    || /(^|[\s;])(?:-webkit-)?mask(?:-image)?\s*:/.test(body)
    || /contain\s*:\s*[^;]*paint/.test(body)
}

describe('mascot peak envelope', () => {
  it('is the rotated box times the jitter scale times the hover zoom', () => {
    // 11°: a unit box rotated by θ covers cos θ + sin θ of its own side.
    expect(mascotRotationEnvelope()).toBeCloseTo(1.172, 3)
    expect(mascotRotationEnvelope(0)).toBe(1)
    expect(mascotRotationEnvelope(45)).toBeCloseTo(Math.SQRT2, 12)
    // 1.172 x 1.06 = 1.243; x 1.04 = 1.292.
    expect(mascotPeakEnvelope()).toBeCloseTo(1.292, 3)
  })

  it('takes its three factors from the constants, so moving one turns this red', () => {
    expect(MASCOT_DICEBEAR_ROTATE_DEG).toBe(11)
    expect(MASCOT_DICEBEAR_SCALE_MAX).toBe(1.06)
    expect(MASCOT_HOVER_ZOOM).toBe(1.04)
    expect(mascotPeakEnvelope()).toBeCloseTo(
      mascotRotationEnvelope(MASCOT_DICEBEAR_ROTATE_DEG) * MASCOT_DICEBEAR_SCALE_MAX * MASCOT_HOVER_ZOOM,
      12,
    )
  })

  it('is not folded into the fit table: the tile keeps its 98% fill', () => {
    // Shrinking by 0.98 / 1.292 ≈ 0.76 was the rejected direction: it trades a
    // real, visible fill for a spill that stays inside the image box.
    expect(MASCOT_SHAPE_FIT.circle).toBe(1.441)
    expect(MASCOT_SHAPE_FIT.pill).toBe(1.256)
    expect(MASCOT_SHAPE_FIT.triangle).toBe(1.455)
    const source = readFileSync(new URL('../src/client/mascot-shape-fit.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/scale = 0\.98 \/ fillRatio/)
    expect(source).toContain('mascotPeakEnvelope')
  })
})

describe('mascot containers never cut the drawing', () => {
  it.each([
    'mascotTile',
    'sidebarAssistantAvatar',
    'sidebarTeamAvatarSeat',
    'assistantAvatarTrigger',
    'mascotPickerOption',
    'mascotPreview',
    'sidebarTeamRowWrap',
    'sidebarAssistantRow',
  ].map(selector => [`.${selector}`]))('%s has no overflow clip, mask or paint containment', selector => {
    expect(cuts(rule(selector))).toBe(false)
  })
})

describe('a moving mascot is painted above its neighbours', () => {
  it('raises the sidebar row that owns it, so the spill is not covered', () => {
    const layering = css.match(/\.sidebarTeamGroup:has\(\.mascotTile[^{]*\{[^}]*\}/)
    expect(layering, 'missing the :has() layering rule for a moving mascot').not.toBeNull()
    // Motion states raise their row; idle/none are excluded because they never
    // leave the tile.
    expect(layering![0]).toContain("data-dsh-mascot-motion='idle'")
    expect(layering![0]).toContain("data-dsh-mascot-motion='none'")
    expect(layering![0]).toMatch(/position:\s*relative/)
    expect(layering![0]).toMatch(/z-index:\s*[1-9]/)
    // The hover zoom stays inside the row's own padding (0.72px at 36px), so it
    // is not what the raise exists for.
    expect(layering![0]).not.toContain(':hover')
  })

  it('documents the derivation next to the tile it applies to', () => {
    const comment = commentBefore('.mascotTile')
    // The arithmetic, not just the result: rotate 11° (1.172), jitter (1.242),
    // hover (1.292). Someone editing a factor finds the sentence it belongs to.
    expect(comment).toContain('cos 11° + sin 11° = 1.172')
    expect(comment).toContain('1.242')
    expect(comment).toContain('1.292')
    expect(comment).toContain('mascotPeakEnvelope')
  })
})
