import { Avatar, Style } from '@dicebear/core'
import gazeDefinition from '@dicebear/styles/gaze.json' with { type: 'json' }
import { TEAM_IDENTITY_COLORS } from './team-identity.js'
import { isAssistantAvatarDataUrl } from './assistant-instances.js'
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

/** The mascot options the UI actually exposes; everything else stays DiceBear's own. */
export interface MascotOptions {
  shapeVariant?: MascotShape
  eyesVariant?: MascotEyes
  spacingVariant?: MascotSpacing
  bodyColor?: string
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

/** Render one mascot as SVG markup. Same seed + same options ⇒ byte-identical output. */
export function mascotSvg(seed: string, options: MascotOptions = {}): string {
  const normalizedSeed = seed.trim() === '' ? 'assistant' : seed.trim()
  return new Avatar(style, {
    seed: normalizedSeed,
    animationVariant: options.animationVariant ?? 'medium',
    ...(options.shapeVariant === undefined ? {} : { shapeVariant: options.shapeVariant }),
    ...(options.eyesVariant === undefined ? {} : { eyesVariant: options.eyesVariant }),
    ...(options.spacingVariant === undefined ? {} : { spacingVariant: options.spacingVariant }),
    ...(options.borderRadius === undefined ? {} : { borderRadius: options.borderRadius }),
    bodyColor: sanitizeColor(options.bodyColor) ?? mascotColor(normalizedSeed),
  }).toString()
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
