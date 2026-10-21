import { useEffect } from 'react'
import { callAgentTeam } from './api.js'
import { teamIdentityColor } from './team-identity.js'

const TEAM_TITLE = /收到团队消息|Received team message|Team message/i
const HEADER_PATTERN = /\[Team message from (.+?); slotId=([^\]]+)\]/

function hash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index += 1) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
}

/** Small, dependency-free Markdown renderer for relayed team messages. */
function renderMarkdown(source: string): string {
  const lines = source.split('\n')
  const html: string[] = []
  let list: 'ul' | 'ol' | undefined
  const closeList = (): void => {
    if (list !== undefined) {
      html.push(`</${list}>`)
      list = undefined
    }
  }
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()
    if (trimmed === '') {
      closeList()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      closeList()
      const level = Math.min(heading[1]!.length, 4)
      html.push(`<div class="dsh-team-h${level}">${renderInline(heading[2]!)}</div>`)
      continue
    }
    if (/^---+$/.test(trimmed)) {
      closeList()
      html.push('<hr>')
      continue
    }
    const quote = /^>\s?(.*)$/.exec(trimmed)
    if (quote !== null) {
      closeList()
      html.push(`<blockquote>${renderInline(quote[1]!)}</blockquote>`)
      continue
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed)
    if (bullet !== null) {
      if (list !== 'ul') {
        closeList()
        html.push('<ul>')
        list = 'ul'
      }
      html.push(`<li>${renderInline(bullet[1]!)}</li>`)
      continue
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed)
    if (ordered !== null) {
      if (list !== 'ol') {
        closeList()
        html.push('<ol>')
        list = 'ol'
      }
      html.push(`<li>${renderInline(ordered[1]!)}</li>`)
      continue
    }
    closeList()
    html.push(`<p>${renderInline(trimmed)}</p>`)
  }
  closeList()
  return `<div class="dsh-team-markdown">${html.join('')}</div>`
}

function removeRelayHeader(section: HTMLElement): void {
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    const text = node.textContent ?? ''
    if (text.includes('[Team message from') || text.includes('[Team event]')) {
      node.textContent = text.replace(/\[Team message from .+?; slotId=[^\]]+\]\s*/s, '').replace(/\[Team event\]\s*/s, '')
      return
    }
    node = walker.nextNode()
  }
}

/** DOM enhancement for native turn-trigger notices that carry DSH team relays. */
export function TeamTriggerEnhancer(): null {
  useEffect(() => {
    let disposed = false
    let scheduled = false
    const colors = new Map<string, string>()

    const loadColors = async (): Promise<void> => {
      try {
        const value = await callAgentTeam('team.list')
        if (disposed) return
        for (const team of value.items) {
          const order = team.memberOrder ?? Object.keys(team.members)
          for (const [slotId, member] of Object.entries(team.members)) {
            const index = Math.max(order.indexOf(slotId), 0)
            colors.set(slotId, teamIdentityColor(index))
          }
        }
      } catch {
        // Keep name-hash fallback colours.
      }
    }

    const decorate = (section: HTMLElement): void => {
      if (section.dataset.teamBubble === 'true') return
      const button = section.querySelector<HTMLElement>(':scope > button')
      const title = button?.textContent ?? ''
      if (!TEAM_TITLE.test(title)) return
      if (button?.getAttribute('aria-expanded') === 'false') button.click()
      window.setTimeout(() => {
        if (disposed || !section.isConnected || section.dataset.teamBubble === 'true') return
        const text = section.innerText ?? ''
        const match = HEADER_PATTERN.exec(text)
        const sender = match?.[1]?.trim() ?? '团队消息'
        const slotId = match?.[2]?.trim()
        const color = (slotId === undefined ? undefined : colors.get(slotId)) ?? teamIdentityColor(hash(sender) % 8)
        const time = section.querySelector('time')?.textContent ?? ''
        section.dataset.teamBubble = 'true'
        section.dataset.teamSender = sender
        section.dataset.teamInitial = sender.trim().slice(0, 1).toLocaleUpperCase()
        section.style.setProperty('--team-message-color', color)

        const header = document.createElement('div')
        header.className = 'dsh-team-trigger-header'
        const avatar = document.createElement('span')
        avatar.className = 'dsh-team-trigger-avatar'
        avatar.textContent = sender.trim().slice(0, 1).toLocaleUpperCase()
        avatar.setAttribute('aria-hidden', 'true')
        const name = document.createElement('strong')
        name.textContent = sender
        const clock = document.createElement('span')
        clock.className = 'dsh-team-trigger-time'
        clock.textContent = time
        header.append(avatar, name, clock)
        section.insertBefore(header, section.firstChild)
        removeRelayHeader(section)
        const content = section.querySelector<HTMLElement>('[class*="content"]')
        if (content !== null) {
          const raw = content.innerText
          if (raw.trim() !== '') content.innerHTML = renderMarkdown(raw)
        }
      }, 80)
    }

    const scan = (): void => {
      if (disposed) return
      document.querySelectorAll<HTMLElement>('[data-turn-trigger]').forEach(decorate)
    }

    const schedule = (): void => {
      if (disposed || scheduled) return
      scheduled = true
      window.requestAnimationFrame(() => {
        scheduled = false
        scan()
      })
    }

    void loadColors().then(schedule)
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    scan()
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [])
  return null
}
