/**
 * Client-only surface switch between DSH's native conversation UI (`native`)
 * and the team product surface (`team`). This flag gates plugin UI only: it
 * changes no Session, tool, request, or stored business data.
 */
export type SurfaceMode = 'native' | 'team'

export const SURFACE_MODE_KEY = 'dsh-team-mode:surface-mode'

const DEFAULT_SURFACE_MODE: SurfaceMode = 'team'

/** Only the exact `native`/`team` literals are accepted; anything else falls back. */
export function parseSurfaceMode(
  value: string | null | undefined,
  fallback: SurfaceMode = DEFAULT_SURFACE_MODE,
): SurfaceMode {
  return value === 'native' || value === 'team' ? value : fallback
}

/** Read the persisted mode; missing or restricted storage resolves to `team`. */
export function readSurfaceMode(
  storage: Pick<Storage, 'getItem'> | undefined,
  fallback: SurfaceMode = DEFAULT_SURFACE_MODE,
): SurfaceMode {
  try {
    return parseSurfaceMode(storage?.getItem(SURFACE_MODE_KEY), fallback)
  } catch {
    return fallback
  }
}

/** Persist the mode; restricted WebViews may reject storage and must not break the switch. */
export function writeSurfaceMode(
  storage: Pick<Storage, 'setItem'> | undefined,
  mode: SurfaceMode,
): void {
  try {
    storage?.setItem(SURFACE_MODE_KEY, mode)
  } catch {
    // The in-memory mode still switches; only persistence is unavailable.
  }
}

/** Stored value wins; otherwise use the configured default, then `team`. */
export function resolveSurfaceMode(input: {
  stored?: string | null
  configured?: SurfaceMode
}): SurfaceMode {
  return parseSurfaceMode(input.stored, parseSurfaceMode(input.configured))
}
