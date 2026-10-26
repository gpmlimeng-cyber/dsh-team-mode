import { useEffect, useMemo, useState } from 'react'
import css from './AgentTeam.module.css'
import {
  mascotDataUri,
  mascotMotion,
  type MascotAvatarShape,
  type MascotMotion,
  type MascotOptions,
} from './mascot.js'

const SHAPE_CLASS: Record<MascotAvatarShape, string | undefined> = {
  circle: css.mascotCircle,
  rounded: css.mascotRounded,
  square: css.mascotSquare,
}

const ONE_SHOT: ReadonlySet<MascotMotion> = new Set(['success', 'failure'])

/** `prefers-reduced-motion`, subscribed without a timer. */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia?.(query).matches === true
  ))
  useEffect(() => {
    const media = window.matchMedia?.(query)
    if (media === undefined) return
    const update = (): void => { setReduced(media.matches) }
    update()
    media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update) }
  }, [])
  return reduced
}

/**
 * One Assistant mascot: a DiceBear `gaze` SVG rendered as an `<img>` data URI
 * (never HTML injection) inside a token-styled tile.
 *
 * Motion is state-driven CSS, not a JS frame loop: `data-dsh-mascot-motion`
 * picks the class, one-shot states (`success`/`failure`) play once and are
 * cleared on `animationend`, and `motionKey` lets a caller replay the same
 * one-shot state. Transform-only animation keeps the sidebar row height fixed.
 */
export function Mascot({
  seed,
  options,
  size = 32,
  avatarShape = 'rounded',
  motion = 'idle',
  motionKey = 0,
  animated = true,
  onMotionEnd,
}: {
  seed: string
  options?: MascotOptions
  size?: number
  avatarShape?: MascotAvatarShape
  motion?: MascotMotion
  motionKey?: number
  animated?: boolean
  /** Called once a one-shot motion finished, so a caller can act on it (no timers). */
  onMotionEnd?: () => void
}): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const resolved = mascotMotion(motion, { reducedMotion, animated })
  const [playedKey, setPlayedKey] = useState(-1)
  const oneShot = !reducedMotion && ONE_SHOT.has(motion) && playedKey !== motionKey
  const playing: MascotMotion = oneShot ? motion : ONE_SHOT.has(resolved.motion) ? 'none' : resolved.motion

  const source = useMemo(
    () => mascotDataUri(seed, { ...options, animationVariant: resolved.animation }),
    // Options are a small, flat object: compare by value so re-renders reuse the URI.
    [seed, resolved.animation, JSON.stringify(options ?? {})],
  )

  return (
    <span
      className={`${css.mascotTile} ${SHAPE_CLASS[avatarShape] ?? css.mascotRounded}`}
      style={{ width: size, height: size }}
      data-dsh-mascot=""
      data-dsh-mascot-motion={playing}
      onAnimationEnd={oneShot
        ? () => {
            setPlayedKey(motionKey)
            onMotionEnd?.()
          }
        : undefined}
      aria-hidden="true"
    >
      <img className={css.mascotImage} src={source} alt="" draggable={false} />
    </span>
  )
}
