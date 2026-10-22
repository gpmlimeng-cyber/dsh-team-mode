import {
  assistantAvatarDataUrlError,
  assistantAvatarFileError,
} from './assistant-instances.js'

/**
 * DiceBear styles already used by the assistant builder. The picker shows one
 * flat grid over these styles: there are no categories or group headings.
 */
export const AVATAR_DICEBEAR_STYLES = [
  'bottts',
  'cameo',
  'clay',
  'critters',
  'gaze',
  'moods',
  'thumbs',
] as const

export type AvatarDicebearStyle = typeof AVATAR_DICEBEAR_STYLES[number]

/** One flat picker candidate; the URL is a deterministic DiceBear endpoint. */
export interface AvatarCandidate {
  id: string
  style: AvatarDicebearStyle
  seed: string
  url: string
  label: string
}

/** Default number of built-in avatars in the ungrouped grid. */
export const AVATAR_CANDIDATE_COUNT = 24

const AVATAR_SEED_PREFIX = 'team-mode-assistant'

/** Deterministic DiceBear 10.x SVG endpoint used by the built-in candidates. */
export function dicebearAvatarUrl(style: string, seed: string): string {
  return `https://api.dicebear.com/10.x/${style}/svg?seed=${encodeURIComponent(seed)}&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`
}

/**
 * Build the flat built-in avatar list. Style and seed are derived from the
 * candidate index, so the same 24 avatars appear on every run and every
 * assistant; `count` only exists to keep the helper testable.
 */
export function assistantAvatarCandidates(count = AVATAR_CANDIDATE_COUNT): AvatarCandidate[] {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : AVATAR_CANDIDATE_COUNT
  return Array.from({ length: total }, (_, index) => {
    const style = AVATAR_DICEBEAR_STYLES[index % AVATAR_DICEBEAR_STYLES.length]!
    const seed = `${AVATAR_SEED_PREFIX}-${String(index + 1).padStart(2, '0')}`
    return {
      id: `${style}-${seed}`,
      style,
      seed,
      url: dicebearAvatarUrl(style, seed),
      label: `内置头像 ${index + 1}`,
    }
  })
}

/** The exact flat list rendered by the embedded AvatarGrid and the editor picker. */
export const AVATAR_CANDIDATES: readonly AvatarCandidate[] = assistantAvatarCandidates()

/**
 * Build a fresh batch from the preset styles. The seeds are random, so each
 * call produces new DiceBear API URLs instead of reusing one fixed sheet.
 * `random` is injectable for deterministic tests.
 */
export function randomAvatarCandidates(
  count = AVATAR_CANDIDATE_COUNT,
  random: () => number = Math.random,
): AvatarCandidate[] {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : AVATAR_CANDIDATE_COUNT
  return Array.from({ length: total }, (_, index) => {
    const style = AVATAR_DICEBEAR_STYLES[index % AVATAR_DICEBEAR_STYLES.length]!
    const roll = random()
    const token = Number.isFinite(roll) ? Math.floor(Math.abs(roll) * 0x7fffffff).toString(36) : index.toString(36)
    const seed = `${AVATAR_SEED_PREFIX}-${token}-${index}`
    return {
      id: `${style}-${seed}`,
      style,
      seed,
      url: dicebearAvatarUrl(style, seed),
      label: `随机头像 ${index + 1}`,
    }
  })
}

/** Pick one candidate with an injectable random source for deterministic tests. */
export function pickRandomAvatarCandidate(
  candidates: readonly AvatarCandidate[] = AVATAR_CANDIDATES,
  random: () => number = Math.random,
): AvatarCandidate | undefined {
  if (candidates.length === 0) return undefined
  const roll = random()
  const bounded = Number.isFinite(roll)
    ? Math.min(candidates.length - 1, Math.max(0, Math.floor(roll * candidates.length)))
    : 0
  return candidates[bounded]
}

/** Validate one local upload before the picker reads it into a data URL. */
export function avatarPickerUploadError(file: { type: string; size: number }): string | undefined {
  return assistantAvatarFileError(file)
}

/** Validate a draft/stored avatar value before applying it. */
export function avatarPickerValueError(value: string): string | undefined {
  return assistantAvatarDataUrlError(value)
}
