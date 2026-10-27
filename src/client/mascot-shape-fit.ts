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
