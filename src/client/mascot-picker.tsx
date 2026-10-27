import { useMemo } from 'react'
import css from './AgentTeam.module.css'
import {
  MASCOT_EYES,
  MASCOT_SHAPES,
  mascotDataUri,
  mascotGradientStops,
  mascotPaletteColor,
  type MascotBodyFill,
  type MascotEyes,
  type MascotOptions,
  type MascotShape,
} from './mascot.js'
import { TEAM_IDENTITY_COLORS } from './team-identity.js'

/** Three sections, in MausBot's order: expression, colour, body. */
export type MascotPickerKind = 'eyes' | 'color' | 'body'

export interface MascotPickerOption {
  /** Stored value: a DiceBear variant name, or a body-colour hex. */
  value: string
  label: string
  /** Colour options only: how the body is painted. */
  fill?: MascotBodyFill
  /** 32px preview, always a data URI so no generated markup hits the DOM. */
  preview: string
}

/** Human labels for the DiceBear `gaze` variants we expose. */
const MASCOT_EYES_LABELS: Record<MascotEyes, string> = {
  dots: '点点',
  big: '大眼',
  small: '小眼',
  shine: '闪亮',
  beans: '豆豆',
  bars: '横条',
  wide: '宽眼',
  tall: '竖眼',
  happy: '开心',
  grin: '咧嘴',
  squint: '眯眼',
}

const MASCOT_SHAPE_LABELS: Record<MascotShape, string> = {
  circle: '圆形',
  square: '方形',
  triangle: '三角',
  pentagon: '五边形',
  hexagon: '六边形',
  octagon: '八边形',
  diamond: '菱形',
  pill: '胶囊',
  column: '柱状',
  egg: '蛋形',
  arch: '拱形',
}

/**
 * MausBot's two extra swatches, kept as data values rather than theme tokens:
 * a neutral grey and a silver radial ball. The identity palette below supplies
 * every other choice, so no second colour system is introduced.
 */
const MASCOT_NEUTRAL_GREY = '#9E9E9E'
const MASCOT_CHROME_GREY = '#C8CCD2'

function swatchDataUri(color: string, fill: MascotBodyFill): string {
  const paint = fill === 'radial'
    ? (() => {
        const [light, dark] = mascotGradientStops(color)
        return '<defs><radialGradient id="sw" cx="35%" cy="30%" r="75%">'
          + `<stop offset="0%" stop-color="${light}"/>`
          + `<stop offset="100%" stop-color="${dark}"/>`
          + '</radialGradient></defs><circle cx="16" cy="16" r="16" fill="url(#sw)"/>'
      })()
    : `<circle cx="16" cy="16" r="16" fill="${color}"/>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">${paint}</svg>`,
  )}`
}

function solidSwatch(color: string, label: string): MascotPickerOption {
  return { value: color, label, fill: 'solid', preview: swatchDataUri(color, 'solid') }
}

/** The light arm of each identity colour, deduped, plus MausBot's two swatches. */
const MASCOT_COLOR_OPTIONS: readonly MascotPickerOption[] = [
  ...[...new Set(TEAM_IDENTITY_COLORS.map((_, index) => mascotPaletteColor(index)))]
    .map((color, index) => solidSwatch(color, `配色 ${index + 1}`)),
  solidSwatch(MASCOT_NEUTRAL_GREY, '中性灰'),
  // A real blue: the identity palette above is intentionally muted, so the
  // vivid option readers asked for comes from a fixed swatch instead.
  solidSwatch('#2F6FEB', '宝蓝'),
  {
    value: MASCOT_CHROME_GREY,
    label: '立体银',
    fill: 'radial',
    preview: swatchDataUri(MASCOT_CHROME_GREY, 'radial'),
  },
]

/**
 * Options for one section. Pure: the seed and the current values only affect the
 * previews, and eyes/body previews are the real mascot with that one option
 * swapped in, so the grid shows exactly what picking it yields.
 */
export function mascotPickerOptions(
  kind: MascotPickerKind,
  seed = 'assistant',
  value: MascotOptions = {},
): readonly MascotPickerOption[] {
  if (kind === 'color') return MASCOT_COLOR_OPTIONS
  if (kind === 'eyes') {
    return MASCOT_EYES.map(eyes => ({
      value: eyes,
      label: MASCOT_EYES_LABELS[eyes],
      preview: mascotDataUri(seed, { ...value, eyesVariant: eyes, animationVariant: 'none' }),
    }))
  }
  return MASCOT_SHAPES.map(shape => ({
    value: shape,
    label: MASCOT_SHAPE_LABELS[shape],
    preview: mascotDataUri(seed, { ...value, shapeVariant: shape, animationVariant: 'none' }),
  }))
}

/** Whether one option is the chosen one for its section. */
export function mascotPickerSelected(
  kind: MascotPickerKind,
  option: MascotPickerOption,
  value: MascotOptions,
): boolean {
  if (kind === 'eyes') return value.eyesVariant === option.value
  if (kind === 'body') return value.shapeVariant === option.value
  return value.bodyColor === option.value
    && (value.bodyColorFill ?? 'solid') === (option.fill ?? 'solid')
}

/** The mascot-option change one option click means. */
export function mascotPickerPick(kind: MascotPickerKind, option: MascotPickerOption): MascotOptions {
  if (kind === 'eyes') return { eyesVariant: option.value as MascotEyes }
  if (kind === 'body') return { shapeVariant: option.value as MascotShape }
  return { bodyColor: option.value, bodyColorFill: option.fill ?? 'solid' }
}

const SECTIONS: readonly { kind: MascotPickerKind, title: string }[] = [
  { kind: 'body', title: '身体' },
  { kind: 'eyes', title: '表情' },
  { kind: 'color', title: '颜色' },
]

/**
 * The mascot picker: body, expression, then colour — each on one unwrapped row
 * of previews. Native `<button>`s give Tab order, Enter/Space activation and
 * `aria-pressed` for free.
 */
export function MascotPicker({
  seed,
  value = {},
  onChange,
  disabled = false,
}: {
  seed: string
  value?: MascotOptions
  onChange: (next: MascotOptions) => void
  disabled?: boolean
}): JSX.Element {
  // Previews are real SVG renders: skip them while unrelated fields re-render
  // the dialog (e.g. typing a name), regenerating only when the mascot changes.
  const sections = useMemo(
    () => SECTIONS.map(section => ({
      section,
      options: mascotPickerOptions(section.kind, seed, value),
    })),
    [seed, JSON.stringify(value)],
  )

  return (
    <div className={css.mascotPicker} data-dsh-mascot-picker>
      {sections.map(({ section, options }) => (
        <fieldset key={section.kind} className={css.mascotPickerSection} disabled={disabled}>
          <legend className={css.mascotPickerTitle}>{section.title}</legend>
          <div className={section.kind === 'color' ? css.mascotPickerSwatchRow : css.mascotPickerGrid}>
            {options.map(option => (
              <button
                key={`${option.value}-${option.fill ?? ''}`}
                type="button"
                className={section.kind === 'color'
                  ? `${css.mascotPickerOption} ${css.mascotPickerSwatch}`
                  : css.mascotPickerOption}
                aria-pressed={mascotPickerSelected(section.kind, option, value)}
                aria-label={option.label}
                title={option.label}
                onClick={() => { onChange({ ...value, ...mascotPickerPick(section.kind, option) }) }}
              >
                <img src={option.preview} alt="" draggable={false} />
              </button>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  )
}
