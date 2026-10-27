import { Avatar, Style } from '@dicebear/core'
import gazeDefinition from '@dicebear/styles/gaze.json' with { type: 'json' }
import { TEAM_IDENTITY_COLORS } from './team-identity.js'
import { isAssistantAvatarDataUrl } from './assistant-instances.js'
import { MASCOT_SHAPE_FIT } from './mascot-shape-fit.js'
import type { AssistantInstance } from '../domain/types.js'

/** DiceBear `gaze` (CC0 1.0) — the only style we ship. */
export const MASCOT_SHAPES = [
  'circle',
  'square',
  'triangle',
  'pentagon',
  'hexagon',
  'octagon',
  'diamond',
  'pill',
  'column',
  'egg',
  'arch',
] as const
export const MASCOT_EYES = [
  'dots',
  'big',
  'small',
  'shine',
  'beans',
  'bars',
  'wide',
  'tall',
  'happy',
  'grin',
  'squint',
] as const
export const MASCOT_SPACINGS = ['close', 'snug', 'normal', 'wide', 'far'] as const
export const MASCOT_ANIMATIONS = ['none', 'fastest', 'fast', 'medium', 'slow', 'slowest'] as const

export type MascotShape = (typeof MASCOT_SHAPES)[number]
export type MascotEyes = (typeof MASCOT_EYES)[number]
export type MascotSpacing = (typeof MASCOT_SPACINGS)[number]
export type MascotAnimation = (typeof MASCOT_ANIMATIONS)[number]
export type MascotAvatarShape = 'circle' | 'rounded' | 'square'
/** `radial` paints the chrome ball: a light core fading to a darker rim. */
export type MascotBodyFill = 'solid' | 'radial'

/** The mascot options the UI actually exposes; everything else stays DiceBear's own. */
export interface MascotOptions {
  shapeVariant?: MascotShape
  eyesVariant?: MascotEyes
  spacingVariant?: MascotSpacing
  bodyColor?: string
  bodyColorFill?: MascotBodyFill
  /** DiceBear's number of gradient stops; defaults to its own `2`. */
  bodyColorFillStops?: number
  /** Container corner radius in percent, DiceBear's own 0–50 range. */
  borderRadius?: number
  animationVariant?: MascotAnimation
}

/** Motion states we really have; `none` means "draw nothing custom". */
export type MascotMotion = 'none' | 'idle' | 'thinking' | 'working' | 'success' | 'failure' | 'hover'

const style = new Style(gazeDefinition)

/**
 * `TEAM_IDENTITY_COLORS` entries are `light-dark(#light, #dark)` pairs. The
 * mascot renders inside an `<img>`, an isolated SVG document where the CSS
 * colour function cannot resolve, and DiceBear only accepts hex — so take the
 * light arm and keep the identity mapping.
 */
/**
 * One random mascot in one step: seed plus a fresh expression, body and colour.
 * The 随机 button used to reroll only the seed, so a reader who had already picked a
 * face and body saw the same silhouette with different eyes.
 */
export function randomMascotDraft(): {
  seed: string
  eyes: MascotEyes
  shape: MascotShape
  color: string
} {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T
  return {
    seed: nextMascotSeed(),
    eyes: pick(MASCOT_EYES),
    shape: pick(MASCOT_SHAPES),
    color: mascotPaletteColor(Math.floor(Math.random() * TEAM_IDENTITY_COLORS.length)),
  }
}

export function mascotPaletteColor(index: number): string {
  const entry = TEAM_IDENTITY_COLORS[index % TEAM_IDENTITY_COLORS.length] ?? ''
  return /#([0-9a-fA-F]{3,8})/.exec(entry)?.[0] ?? '#5F5E5A'
}

/** Stable palette pick: the same seed always lands on the same team identity colour. */
export function mascotColor(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return mascotPaletteColor(hash)
}

/** Stored colours are free-form strings; only a hex survives into the SVG. */
function sanitizeColor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return /^#?[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : undefined
}

/** Nudge one hex channel set towards white (`amount` > 0) or black (< 0). */
function shadeHex(color: string, amount: number): string {
  const raw = color.replace('#', '')
  const full = raw.length === 3 ? raw.split('').map(char => char + char).join('') : raw.slice(0, 6)
  const channels = [0, 2, 4].map(index => {
    const value = Number.parseInt(full.slice(index, index + 2), 16)
    if (Number.isNaN(value)) return 0x80
    return Math.max(0, Math.min(255, Math.round(value + amount * 255)))
  })
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Two stops for a `radial` body fill: a light core and a darker rim. The
 * picker's chrome swatch reuses this so the dot and the mascot agree.
 */
export function mascotGradientStops(color: string): readonly [string, string] {
  const light = sanitizeColor(color) ?? '#9E9E9E'
  return [shadeHex(light, 0.35), shadeHex(light, -0.28)]
}

/** Render one mascot as SVG markup. Same seed + same options ⇒ byte-identical output. */
export function mascotSvg(seed: string, options: MascotOptions = {}): string {
  const normalizedSeed = seed.trim() === '' ? 'assistant' : seed.trim()
  const bodyColor = sanitizeColor(options.bodyColor) ?? mascotColor(normalizedSeed)
  const radial = options.bodyColorFill === 'radial'
  const avatar = new Avatar(style, {
    seed: normalizedSeed,
    animationVariant: options.animationVariant ?? 'medium',
    ...(options.shapeVariant === undefined ? {} : { shapeVariant: options.shapeVariant }),
    ...(options.eyesVariant === undefined ? {} : { eyesVariant: options.eyesVariant }),
    ...(options.spacingVariant === undefined ? {} : { spacingVariant: options.spacingVariant }),
    ...(options.borderRadius === undefined ? {} : { borderRadius: options.borderRadius }),
    bodyColor: radial ? mascotGradientStops(bodyColor) : bodyColor,
    ...(radial
      ? {
          bodyColorFill: 'radial' as const,
          // Keep the light core first; the default order would shuffle per seed.
          bodyColorOrder: 'fixed',
          ...(options.bodyColorFillStops === undefined
            ? {}
            : { bodyColorFillStops: options.bodyColorFillStops }),
        }
      : {}),
  })
  // DiceBear picks a random shape when none is passed, so read the shape back
  // from its resolved options instead of guessing it from the seed.
  const { svg, options: resolved } = avatar.toJSON()
  const resolvedShape = typeof resolved.shapeVariant === 'string' ? resolved.shapeVariant : undefined
  return fitMascotSvg(svg, mascotShapeFit(resolvedShape))
}

/**
 * How much to zoom one body so its ink fills the tile.
 *
 * `shape` is the shape DiceBear actually drew (see `toJSON().options`); an
 * unknown or empty name is a no-op rather than a NaN-producing lookup.
 */
export function mascotShapeFit(shape: string | undefined): number {
  if (shape === undefined || !Object.hasOwn(MASCOT_SHAPE_FIT, shape)) return 1
  return MASCOT_SHAPE_FIT[shape as MascotShape]
}

/**
 * Scale the drawing around the canvas centre (all measured ink is centred on
 * 50, so centring on the canvas is within a pixel of centring on the ink).
 *
 * Doing it inside the SVG rather than on the `<img>` keeps the tile's CSS
 * `transform` free for the hover zoom. The factor already normalises the
 * unrotated body to 98% of the viewBox; DiceBear's per-seed rotate/scale jitter
 * can still push a corner past it, which `.mascotTile`'s `overflow: hidden`
 * trims instead of showing outside the tile.
 */
function fitMascotSvg(svg: string, fit: number): string {
  const open = svg.indexOf('>')
  const close = svg.lastIndexOf('</svg>')
  if (fit === 1 || open < 0 || close < 0) return svg
  const transform = `translate(50 50) scale(${fit}) translate(-50 -50)`
  return `${svg.slice(0, open + 1)}<g transform="${transform}">${svg.slice(open + 1, close)}</g>${svg.slice(close)}`
}

/**
 * A `data:` URI rather than `dangerouslySetInnerHTML`.
 *
 * The SVG is generated, not authored, but it still carries a free-form seed and
 * a user-chosen colour. Rendering it as an `<img>` keeps it out of the host DOM
 * and CSS cascade: no injected `<style>`/`<script>` can run against the app, and
 * the same string renders identically in Electron and a plain browser.
 */
export function mascotDataUri(seed: string, options: MascotOptions = {}): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mascotSvg(seed, options))}`
}

/** The tile shape travels with the avatar treatment: circle / rounded / square. */
export function mascotAvatarShape(shape: string | undefined): MascotAvatarShape {
  if (shape === 'circle') return 'circle'
  if (shape === 'square') return 'square'
  return 'rounded'
}

/** Resolve one requested state into the SVG animation and the CSS motion class. */
export function mascotMotion(
  state: MascotMotion,
  options: { reducedMotion: boolean, animated?: boolean },
): { motion: MascotMotion, animation: MascotAnimation } {
  // Reduced motion is the hard stop: no CSS keyframes and no SVG animation.
  if (options.reducedMotion) return { motion: 'none', animation: 'none' }
  const animation: MascotAnimation = options.animated === false
    ? 'none'
    : state === 'thinking' || state === 'working'
      ? 'fast'
      : state === 'idle'
        ? 'medium'
        : 'none'
  return { motion: state, animation }
}

/** Sidebar rows only know their instance status: starting/active means working. */
export function mascotMotionForStatus(status: AssistantInstance['status']): MascotMotion {
  return status === 'starting' || status === 'active' ? 'working' : 'idle'
}

/** The mascot is the fallback identity: it only shows when no avatar can render. */
export function assistantShowsMascot(instance: AssistantInstance): boolean {
  const avatar = instance.assistantSnapshot.avatar
  return avatar === undefined || !isAssistantAvatarDataUrl(avatar)
}

/** Mascot options for one instance; an untouched assistant gets a stable identity. */
export function mascotOptionsFor(instance: AssistantInstance): { seed: string, options: MascotOptions } {
  const mascot = instance.mascot
  return {
    seed: mascot?.seed ?? instance.id,
    options: {
      ...(mascot?.shape === undefined ? {} : { shapeVariant: mascot.shape as MascotShape }),
      ...(mascot?.eyes === undefined ? {} : { eyesVariant: mascot.eyes as MascotEyes }),
      ...(mascot?.spacing === undefined ? {} : { spacingVariant: mascot.spacing as MascotSpacing }),
      ...(mascot?.color === undefined ? {} : { bodyColor: mascot.color }),
      ...(mascot?.fill === undefined ? {} : { bodyColorFill: mascot.fill }),
    },
  }
}

/** "换一只": a fresh seed, so DiceBear draws a different animal. */
export function nextMascotSeed(): string {
  const crypto = globalThis.crypto
  return crypto?.randomUUID !== undefined
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
}
