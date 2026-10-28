import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { callAgentTeam } from './api.js'
import css from './AgentTeam.module.css'
import type { CatalogView } from '../transport/contracts.js'

/**
 * The native Agent-preset label is a read-only `span` in the Session header
 * (the host locks the preset once a conversation starts). This module owns the
 * two client-side pieces of moving that information into our own switcher:
 * a pure name lookup and a text-matched, header-scoped hide that never guesses
 * a hashed CSS-module class.
 */

/** The header slot the native label lives in; matching never leaves this scope. */
export const HEADER_SCOPE_SELECTOR = '[data-slot="conversation.session.header"]'

/** Marker set on a node this module hid, so a later pass can restore it. */
const HIDDEN_ATTR = 'data-dsh-team-preset-hidden'
/** The inline display the node had before we hid it. */
const DISPLAY_ATTR = 'data-dsh-team-preset-display'

/**
 * Name the switcher should show for one preset id.
 * A missing id (no preset recorded) yields nothing; a catalog miss falls back to
 * the raw id, matching what the native label shows in that case.
 */
export function agentPresetLabel(
  catalog: CatalogView | undefined,
  id: string | undefined,
): string | undefined {
  const presetId = id?.trim() ?? ''
  if (presetId === '') return undefined
  const name = catalog?.agentPresets.find(preset => preset.id === presetId)?.name.trim() ?? ''
  return name === '' ? presetId : name
}

/**
 * Every display name the native label could show, plus the current Session's
 * own label (which may itself be a raw id when the catalog lacks it).
 */
export function knownPresetNames(
  catalog: CatalogView | undefined,
  currentLabel: string | undefined,
): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (value: string | undefined): void => {
    const name = value?.trim() ?? ''
    if (name === '' || seen.has(name)) return
    seen.add(name)
    names.push(name)
  }
  for (const preset of catalog?.agentPresets ?? []) add(preset.name)
  add(currentLabel)
  return names
}

/** Strict, trimmed text equality: an unknown label is never hidden. */
export function isPresetLabelText(
  text: string | null | undefined,
  names: readonly string[],
): boolean {
  const value = (text ?? '').trim()
  if (value === '') return false
  return names.includes(value)
}

/**
 * The span that actually carries the preset name inside the header scope.
 * `nav` (breadcrumbs), `button` (tabs) and our own switcher are excluded, and an
 * outer span whose child already carries the same text is not a label.
 */
export function findPresetLabelNodes(
  scope: ParentNode,
  names: readonly string[],
): HTMLElement[] {
  if (names.length === 0) return []
  const matches: HTMLElement[] = []
  for (const element of scope.querySelectorAll<HTMLElement>('span')) {
    if (!isPresetLabelText(element.textContent, names)) continue
    if (element.closest('[data-dsh-team-session-switcher]') !== null) continue
    if (element.closest('nav, button, a') !== null) continue
    let nested = false
    for (const child of element.children) {
      if (!isPresetLabelText(child.textContent, names)) continue
      nested = true
      break
    }
    if (nested) continue
    matches.push(element)
  }
  return matches
}

/**
 * Hide the native preset label while the BOT surface shows its own dropdown,
 * and restore it when the surface returns to DeepSeek or this control unmounts.
 *
 * Styling is set on the matched node (not a class), matching is scoped to the
 * Session-header slot, and a missing node simply means nothing happens.
 */
export function hideNativePresetLabels(names: readonly string[]): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || names.length === 0) {
    return () => {}
  }
  const hidden = new Set<HTMLElement>()
  let frame: number | undefined
  let disposed = false

  const restoreNode = (node: HTMLElement): void => {
    if (node.hasAttribute(HIDDEN_ATTR)) {
      node.style.display = node.getAttribute(DISPLAY_ATTR) ?? ''
      node.removeAttribute(DISPLAY_ATTR)
      node.removeAttribute(HIDDEN_ATTR)
    }
    hidden.delete(node)
  }

  const restore = (): void => {
    for (const node of [...hidden]) restoreNode(node)
  }

  const hideNode = (node: HTMLElement): void => {
    if (!node.hasAttribute(HIDDEN_ATTR)) {
      node.setAttribute(DISPLAY_ATTR, node.style.display)
      node.setAttribute(HIDDEN_ATTR, '')
      hidden.add(node)
    }
    if (node.style.display !== 'none') node.style.display = 'none'
  }

  const apply = (): void => {
    frame = undefined
    if (disposed) return
    const scope = document.querySelector<HTMLElement>(HEADER_SCOPE_SELECTOR)
    const surface = document.documentElement.dataset.dshSurfaceMode ?? 'team'
    if (scope === null || surface !== 'team') {
      restore()
      return
    }
    for (const node of [...hidden]) {
      if (!node.isConnected || !scope.contains(node) || !isPresetLabelText(node.textContent, names)) {
        restoreNode(node)
      }
    }
    for (const node of findPresetLabelNodes(scope, names)) hideNode(node)
  }

  const schedule = (): void => {
    if (frame !== undefined || disposed) return
    frame = window.requestAnimationFrame(apply)
  }

  apply()
  const pageObserver = new MutationObserver(schedule)
  pageObserver.observe(document.body, { childList: true, subtree: true })
  const modeObserver = new MutationObserver(schedule)
  modeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-dsh-surface-mode'],
  })
  return () => {
    disposed = true
    pageObserver.disconnect()
    modeObserver.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    restore()
  }
}

/** The team catalog's Agent presets, or undefined until the read settles. */
export function useAgentCatalog(): CatalogView | undefined {
  const [catalog, setCatalog] = useState<CatalogView>()
  useEffect(() => {
    let live = true
    void callAgentTeam('catalog.get').then(
      value => { if (live) setCatalog(value) },
      () => { /* an unread catalog keeps both surfaces untouched */ },
    )
    return () => { live = false }
  }, [])
  return catalog
}

/**
 * Read-only preset line at the bottom of the switcher panel. It is a plain
 * `span`: no click target, no hover background and no tab stop, because the
 * host locks the preset once the conversation starts.
 */
export function SessionPresetMeta({ name }: { name?: string | undefined }): ReactElement | null {
  const label = name?.trim() ?? ''
  if (label === '') return null
  return createElement(
    'span',
    {
      className: css.teamSessionPreset,
      'data-dsh-team-agent-preset': '',
      title: `Agent 预设：${label}`,
    },
    `Agent 预设：${label}`,
  )
}
