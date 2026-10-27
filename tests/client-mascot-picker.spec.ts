import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { assistantMascotSchema } from '../src/domain/schemas.js'
import { MASCOT_EYES, MASCOT_SHAPES, mascotPaletteColor, mascotSvg, type MascotOptions } from '../src/client/mascot.js'
import { MascotPicker, mascotPickerOptions } from '../src/client/mascot-picker.js'
import { TEAM_IDENTITY_COLORS } from '../src/client/team-identity.js'

function decodePreview(preview: string): string {
  expect(preview.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
  return decodeURIComponent(preview.slice('data:image/svg+xml;charset=utf-8,'.length))
}

describe('mascotPickerOptions', () => {
  it('lists every eyes and body variant with a rendered preview', () => {
    for (const [kind, variants] of [['eyes', MASCOT_EYES], ['body', MASCOT_SHAPES]] as const) {
      const options = mascotPickerOptions(kind, 'assistant-1')
      expect(options.map(option => option.value)).toEqual([...variants])
      expect(new Set(options.map(option => option.label)).size).toBe(variants.length)
      const previews = options.map(option => {
        expect(decodePreview(option.preview)).toContain('<svg')
        return option.preview
      })
      // Swapping one variant must produce a different real mascot drawing.
      expect(new Set(previews).size).toBe(variants.length)
    }
  })

  it('base the previews on the current mascot, not a fixed one', () => {
    const round = mascotPickerOptions('eyes', 'seed-x', { shapeVariant: 'hexagon', bodyColor: '#689BA3' })
    const square = mascotPickerOptions('eyes', 'seed-x', { shapeVariant: 'square', bodyColor: '#689BA3' })
    expect(round[0]!.preview).not.toBe(square[0]!.preview)
    // Same options twice is the same drawing (no per-call randomness).
    expect(mascotPickerOptions('body', 'seed-x', { eyesVariant: 'big' }))
      .toEqual(mascotPickerOptions('body', 'seed-x', { eyesVariant: 'big' }))
  })

  it('offers the identity palette plus MausBot’s neutral grey and chrome ball', () => {
    const colors = mascotPickerOptions('color')
    const values = colors.map(option => option.value)

    for (let index = 0; index < TEAM_IDENTITY_COLORS.length; index += 1) {
      expect(values).toContain(mascotPaletteColor(index))
    }
    expect(new Set(values).size).toBe(values.length)
    expect(values).toContain('#9E9E9E')
    expect(values).toContain('#C8CCD2')

    const grey = colors.find(option => option.value === '#9E9E9E')!
    const chrome = colors.find(option => option.value === '#C8CCD2')!
    expect(grey.fill).toBe('solid')
    expect(chrome.fill).toBe('radial')
    expect(chrome.label).not.toBe(grey.label)
    // Every swatch is a rendered image too, and the chrome one is a real gradient.
    for (const option of colors) expect(decodePreview(option.preview)).toContain('<circle')
    expect(decodePreview(chrome.preview)).toContain('radialGradient')
    expect(decodePreview(grey.preview)).not.toContain('radialGradient')
  })
})

describe('chrome body fill', () => {
  it('paints the mascot itself with a radial gradient', () => {
    const chrome = mascotPickerOptions('color').find(option => option.fill === 'radial')!
    const svg = mascotSvg('assistant-1', {
      bodyColor: chrome.value,
      bodyColorFill: 'radial',
    })
    expect(svg).toContain('radialGradient')
    expect(svg).toContain('url(#body-color-')

    const solid = mascotSvg('assistant-1', { bodyColor: chrome.value })
    expect(solid).not.toContain('radialGradient')
  })
})

describe('MascotPicker rendering contract', () => {
  function markup(value: MascotOptions): string {
    return renderToStaticMarkup(createElement(MascotPicker, { seed: 'assistant-1', value, onChange: () => {} }))
  }

  it('renders the three MausBot sections in order, each on a single row', () => {
    const html = markup({})
    expect(html).toContain('>表情<')
    expect(html).toContain('>颜色<')
    expect(html).toContain('>身体<')
    // Body first, then expression, colour last.
    expect(html.indexOf('>身体<')).toBeLessThan(html.indexOf('>表情<'))
    expect(html.indexOf('>表情<')).toBeLessThan(html.indexOf('>颜色<'))
    expect(html.match(/<legend /g)).toHaveLength(3)
    // One row per section: a no-wrap flex row of equal shares, not a grid that
    // wraps into a second line.
    const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
    const grid = css.slice(css.indexOf('.mascotPickerGrid {'))
    const rule = grid.slice(0, grid.indexOf('}'))
    expect(rule).toContain('flex-wrap: nowrap')
    expect(rule).not.toContain('repeat(')
    const swatches = css.slice(css.indexOf('.mascotPickerSwatchRow {'))
    expect(swatches.slice(0, swatches.indexOf('}'))).toContain('flex-wrap: nowrap')
  })

  it('renders every option as a real image inside a button', () => {
    const html = markup({})
    const buttons = html.match(/<button /g) ?? []
    const images = html.match(/<img /g) ?? []
    expect(buttons).toHaveLength(11 + mascotPickerOptions('color').length + 11)
    expect(images).toHaveLength(buttons.length)
    expect(html.match(/type="button"/g)).toHaveLength(buttons.length)
    expect(html).toContain('aria-pressed="false"')
  })

  it('marks exactly the chosen option pressed', () => {
    const html = markup({ eyesVariant: 'big' })
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="大眼"/)

    const colorHtml = markup({ bodyColor: '#C8CCD2', bodyColorFill: 'radial' })
    expect(colorHtml.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(colorHtml).toMatch(/aria-pressed="true"[^>]*aria-label="立体银"/)

    // The grey is a different option: a solid grey body must not light up chrome.
    const greyHtml = markup({ bodyColor: '#9E9E9E', bodyColorFill: 'solid' })
    expect(greyHtml).toMatch(/aria-pressed="true"[^>]*aria-label="中性灰"/)
    expect(greyHtml).not.toMatch(/aria-pressed="true"[^>]*aria-label="立体银"/)
  })
})

describe('stored fill', () => {
  it('persists the chrome fill without a schema-version bump', () => {
    expect(assistantMascotSchema.parse({ seed: 'a', fill: 'radial' })).toEqual({ seed: 'a', fill: 'radial' })
    expect(assistantMascotSchema.parse({ seed: 'a' })).toEqual({ seed: 'a' })
    expect(() => assistantMascotSchema.parse({ seed: 'a', fill: 'linear' })).toThrow()
  })
})

describe('assistant settings integration', () => {
  it('replaces the four dropdowns with the shared picker and keeps 随机', () => {
    const source = readFileSync(new URL('../src/client/assistant-settings-dialog.tsx', import.meta.url), 'utf8')
    expect(source).toContain("from './mascot-picker.js'")
    expect(source).toContain('<MascotPicker')
    for (const label of ['轮廓', '眼睛', '眼距', '配色']) {
      expect(source).not.toContain(`label="${label}"`)
    }
    expect(source).toContain('随机')
    expect(source).toContain("{ fill: 'radial' as const }")
  })
})
