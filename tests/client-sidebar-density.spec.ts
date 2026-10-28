import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Sidebar vertical-density contract (audit 2026-10-28).
 *
 * These are source-level assertions on the injected sidebar's own CSS/DOM code:
 * the brand band stays at its 48px budget, rows keep the shipped ≥32px click
 * floors, row gaps stay on the 2px ceiling, and every native node the plugin
 * hides is hidden with a rule that actually removes it from layout.
 */

const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
  // Comments sit between rules; strip them so selector extraction is exact.
  .replace(/\/\*[\s\S]*?\*\//g, '')
const sidebar = readFileSync(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')

/** The declaration body of the first rule whose selector list contains the
 *  exact selector (compound selectors like `.x .y` never match `.y`). */
function rule(selector: string): string {
  let search = 0
  for (;;) {
    const open = css.indexOf('{', search)
    if (open < 0) return ''
    const selectors = css.slice(css.lastIndexOf('}', open) + 1, open)
    if (selectors.split(',').map(part => part.trim()).includes(selector)) {
      return css.slice(open + 1, css.indexOf('}', open))
    }
    search = open + 1
  }
}

/** A px value for `property` inside a rule body, or NaN when unset. */
function px(body: string, property: string): number {
  const match = new RegExp(`${property}:\\s*(-?\\d+)px`).exec(body)
  return match === null ? Number.NaN : Number(match[1])
}

describe('sidebar vertical density', () => {
  it('keeps the brand band at the 48px budget (box + margin)', () => {
    const host = rule('.sidebarModeRowHost')
    const height = px(host, 'height')
    const margin = px(host, 'margin-bottom')
    expect(height + margin).toBeLessThanOrEqual(48)
    // The row still borrows the shipped slot's inline padding.
    expect(host).toContain('padding: 8px 0 8px 4px')
  })

  it('takes the drag strip tuck the shipped logo row used to own', () => {
    // Mounting before `_logoRow` broke `.topStrip + .logoRow`'s -12px; the
    // injected row restores it so the strip edge is not a blank band.
    expect(css).toMatch(
      /\[data-dsh-team-root\] > \[class\*='_topStrip'\] \+ \.sidebarModeRowHost\s*\{[^}]*margin-top: -12px/,
    )
  })

  it('never shrinks a clickable row below the shipped 32px floor', () => {
    expect(px(rule('.sidebarRosterRow'), 'height')).toBeGreaterThanOrEqual(32)
    expect(px(rule('.sidebarTeamRowWrap'), 'height')).toBeGreaterThanOrEqual(32)
    expect(px(rule('.sidebarTeamRowWrapTwoLine'), 'min-height')).toBeGreaterThanOrEqual(32)
    expect(px(rule('.sidebarAssistantRowWrap'), 'min-height')).toBeGreaterThanOrEqual(32)
  })

  it('keeps every row-to-row gap at 2px or tighter', () => {
    for (const selector of [
      '.sidebarTeamList',
      '.sidebarTeamGroup',
      '.sidebarPartition',
      '.sidebarPartitionBody',
      '.sidebarRosterList',
    ]) {
      expect(px(rule(selector), 'gap'), selector).toBeLessThanOrEqual(2)
    }
  })

  it('adds no section-level margin between the stacked sections', () => {
    // Sections separate through their children's own gaps, never a stray band.
    expect(rule('.sidebarTeamSection')).not.toMatch(/margin/)
    expect(rule('.sidebarAssistantSection')).not.toMatch(/margin/)
  })
})

describe('hidden native nodes leave no placeholder', () => {
  it('hides the shipped brand row only while the column is wide', () => {
    const wide = rule("[data-dsh-team-root]:not([class*='_collapsed']) [class*='_logoRow']")
    expect(wide).toContain('display: none')
  })

  it('hides the mode row itself in the collapsed rail', () => {
    const rail = rule("[data-dsh-team-root][class*='_collapsed'] .sidebarModeRowHost")
    expect(rail).toContain('display: none')
  })

  it('hides the native workspace browser in team mode, siblings included', () => {
    const team = rule("html[data-dsh-surface-mode='team'] [data-dsh-team-mode='sidebar'] ~ *")
    expect(team).toContain('display: none')
  })

  it('hides the emptied panel list so its 8px native margin cannot band', () => {
    // The shipped nav keeps `margin-bottom: 8px` even with every row moved to
    // the footer; syncBotSidebar hides the nav itself when no row is left.
    expect(sidebar).toContain("document.querySelector<HTMLElement>('[class*=\"_panelList\"]')")
    expect(sidebar).toMatch(/if \(visiblePanel\) \{[\s\S]{0,160}removeAttribute\(BOT_HIDDEN_ATTR\)/)
    expect(sidebar).toMatch(/panelList\.style\.display = 'none'[\s\S]{0,80}setAttribute\(BOT_HIDDEN_ATTR/)
  })

  it('restores every node it hid when the surface leaves team mode', () => {
    expect(sidebar).toMatch(/querySelectorAll<HTMLElement>\(`\[\$\{BOT_HIDDEN_ATTR\}\]`\)/)
    expect(sidebar).toMatch(/restoreBotSidebar\(\)/)
  })
})
