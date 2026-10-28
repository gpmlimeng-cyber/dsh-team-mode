import type { MascotShape } from './mascot.js'

/**
 * Per-shape zoom that makes the DiceBear `gaze` body fill its tile.
 *
 * Every body is drawn on a 100×100 canvas but with different ink margins: a
 * circle covers 68 units, a pill 78×50, a triangle 67.3×60.4. Rendered inside
 * the same 36px avatar they therefore read at different sizes. Multiplying the
 * rendered canvas by these factors puts each body's longest side at 98% of the
 * tile (1% breathing room per edge), so side-by-side mascots look equally big.
 *
 * The numbers are measured, not estimated. `node scripts/measure-mascot-shapes.mjs`
 * reads `node_modules/@dicebear/styles/dist/gaze.min.json`, parses each shape's
 * path (sampling cubic/quadratic Béziers and elliptical arcs, not just the raw
 * coordinates) and prints the ink bounding box. `scale = 0.98 / fillRatio`,
 * where `fillRatio = max(width, height) / 100`. The script output and caveats
 * are in `docs/superpowers/notes/2026-10-27-mascot-shape-fit.md`.
 *
 * Re-run the script after a `@dicebear/styles` upgrade and update this table if
 * the printed values moved.
 */
/**
 * Global optical shrink applied on top of the per-shape fit.
 *
 * The table above targets a 0.98 fill of the tile. DiceBear tilts every drawing
 * by a random -11..11° inside its own viewBox and clips the corner there, which
 * reads as a chipped mascot; the worst case needs `cos11° + sin11° ≈ 1.172` of
 * headroom, i.e. a 0.84 target fill. 0.84 / 0.98 ≈ 0.857.
 */
export const MASCOT_FIT_SHRINK = 0.857

export const MASCOT_SHAPE_FIT: Readonly<Record<MascotShape, number>> = {
  circle: 1.441,
  square: 1.441,
  triangle: 1.455,
  pentagon: 1.475,
  hexagon: 1.441,
  octagon: 1.438,
  diamond: 1.454,
  pill: 1.256,
  column: 1.256,
  egg: 1.342,
  arch: 1.324,
}

/**
 * DiceBear's `gaze` style jitters every body per seed, and the tile zooms while
 * hovered. These three numbers are the whole peak envelope; the style's own
 * `shape.rotate` / `shape.scale` ranges are the source of the first two.
 */
export const MASCOT_DICEBEAR_ROTATE_DEG = 11
export const MASCOT_DICEBEAR_SCALE_MAX = 1.06
export const MASCOT_HOVER_ZOOM = 1.04

/**
 * A box of side 1 rotated by θ covers `cos θ + sin θ` of its side (the rotated
 * square's axis-aligned bounding box); at the style's 11° maximum that is
 * `0.9816 + 0.1908 = 1.172`.
 */
export function mascotRotationEnvelope(degrees: number = MASCOT_DICEBEAR_ROTATE_DEG): number {
  const radians = degrees * Math.PI / 180
  return Math.cos(radians) + Math.sin(radians)
}

/**
 * Worst-case ink envelope of one mascot, as a multiple of its own tile:
 *
 *   rotate 11°  -> cos 11° + sin 11° = 1.172
 *   jitter scale -> MASCOT_DICEBEAR_SCALE_MAX 1.06  => 1.242
 *   hover zoom   -> MASCOT_HOVER_ZOOM 1.04          => 1.292
 *
 * `MASCOT_SHAPE_FIT` is deliberately NOT divided by this: the user-facing rule
 * is "overflow is allowed, being clipped is not", so the body keeps its 98%
 * fill (0.98 / 1.292 would be ≈ 0.76 and would shrink every mascot for a spill
 * that, as it happens, stays inside the `<img>` box — an SVG viewport clips its
 * own content, so only the hover zoom can visibly leave the tile). The number
 * is kept here as the documented ceiling: `.mascotTile` in
 * `AgentTeam.module.css` carries no `overflow` and the row is raised while a
 * mascot moves, so nothing we own trims the spill. What still bounds the
 * drawing to the image box is the SVG viewport (DiceBear's own clip), not a
 * container rule — see the `.mascotTile` comment.
 * `tests/client-mascot-overflow.spec.ts` pins the arithmetic and the CSS.
 */
export function mascotPeakEnvelope(): number {
  return mascotRotationEnvelope() * MASCOT_DICEBEAR_SCALE_MAX * MASCOT_HOVER_ZOOM
}
