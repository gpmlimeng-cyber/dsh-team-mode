import { useEffect } from 'react'
import { callAgentTeam } from './api.js'
import { teamIdentityColor } from './team-identity.js'

const TEAM_TITLE = /收到团队消息|Received team message|Team message/i
const HEADER_PATTERN = /\[Team message from (.+?); slotId=([^\]]+)\]/
const CLAMP_HEIGHT = 320

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
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
}

/** Small, dependency-free Markdown renderer for relayed team messages. */
function renderMarkdown(source: string): string {
  // The relay body repeats its own summary as the first line; the bubble shows
  // the actual message content, so drop that preview line.
  const lines = source.replace(/^Summary: [^\n]*\n?/, '').split('\n')
  const html: string[] = []
  let list: 'ul' | 'ol' | undefined
  let code: string[] | undefined
  const closeList = (): void => {
    if (list !== undefined) {
      html.push(`</${list}>`)
      list = undefined
    }
  }
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      if (code === undefined) {
        closeList()
        code = []
      } else {
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
        code = undefined
      }
      continue
    }
    if (code !== undefined) {
      code.push(rawLine)
      continue
    }
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
  if (code !== undefined) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
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

function timeOf(section: HTMLElement): string {
  return section.querySelector('time')?.textContent ?? ''
}

function ensureHeader(section: HTMLElement, sender: string, color: string): void {
  let header = section.querySelector<HTMLElement>(':scope > .dsh-team-trigger-header')
  if (header === null) {
    header = document.createElement('div')
    header.className = 'dsh-team-trigger-header'
    const avatar = document.createElement('span')
    avatar.className = 'dsh-team-trigger-avatar'
    avatar.setAttribute('aria-hidden', 'true')
    const name = document.createElement('strong')
    const clock = document.createElement('span')
    clock.className = 'dsh-team-trigger-time'
    header.append(avatar, name, clock)
    section.insertBefore(header, section.firstChild)
  }
  const avatar = header.querySelector<HTMLElement>('.dsh-team-trigger-avatar')
  const name = header.querySelector<HTMLElement>('strong')
  const clock = header.querySelector<HTMLElement>('.dsh-team-trigger-time')
  if (avatar !== null) avatar.textContent = sender.trim().slice(0, 1).toLocaleUpperCase()
  if (name !== null) name.textContent = sender
  if (clock !== null) clock.textContent = timeOf(section)
  section.style.setProperty('--team-message-color', color)
}

function ensureExpandControl(section: HTMLElement, content: HTMLElement): void {
  const buttons = section.querySelectorAll<HTMLElement>('.dsh-team-expand')
  const existing = buttons[0] ?? null
  const overflows = content.scrollHeight > CLAMP_HEIGHT + 8
  if (!overflows) {
    buttons.forEach(button => { button.remove() })
    content.removeAttribute('data-team-clamped')
    return
  }
  if (existing !== null) {
    for (let index = 1; index < buttons.length; index += 1) buttons[index]!.remove()
    return
  }
  content.setAttribute('data-team-clamped', 'true')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dsh-team-expand'
  button.textContent = '展开'
  button.setAttribute('aria-expanded', 'false')
  button.addEventListener('click', () => {
    const expanded = content.getAttribute('data-team-clamped') !== 'true'
    if (expanded) {
      content.setAttribute('data-team-clamped', 'true')
      button.textContent = '展开'
      button.setAttribute('aria-expanded', 'false')
    } else {
      content.removeAttribute('data-team-clamped')
      button.textContent = '收起'
      button.setAttribute('aria-expanded', 'true')
    }
  })
  content.insertAdjacentElement('afterend', button)
}

function markTeamBubble(
  section: HTMLElement,
  sender: string,
  slotId: string | undefined,
  color: string,
  raw: string,
): void {
  section.dataset.teamBubble = 'true'
  section.dataset.teamSender = sender
  section.dataset.teamInitial = sender.trim().slice(0, 1).toLocaleUpperCase()
  ensureHeader(section, sender, color)
  const content = section.querySelector<HTMLElement>('[class*="content"]')
  if (content === null) return
  section.dataset.teamContentClass = content.className
  content.innerHTML = renderMarkdown(raw)
  ensureExpandControl(section, content)
}

/** DOM enhancement for native turn-trigger notices that carry DSH team relays. */
export function TeamTriggerEnhancer(): null {
  useEffect(() => {
    let disposed = false
    let scheduled = false
    const colors = new Map<string, string>()
    const rawText = new WeakMap<HTMLElement, string>()

    const loadColors = async (): Promise<void> => {
      try {
        const value = await callAgentTeam('team.list')
        if (disposed) return
        for (const team of value.items) {
          const order = team.memberOrder ?? Object.keys(team.members)
          for (const [slotId] of Object.entries(team.members)) {
            const index = Math.max(order.indexOf(slotId), 0)
            colors.set(slotId, teamIdentityColor(index))
          }
        }
      } catch {
        // Keep name-hash fallback colours.
      }
    }

    const refresh = (section: HTMLElement): void => {
      const stored = rawText.get(section)
      let content = section.querySelector<HTMLElement>('[class*="content"]')
      if (content === null) {
        // Native React may replace the whole body node, not just its children.
        // Recreate the content container from the remembered native class.
        const className = section.dataset.teamContentClass
        if (stored === undefined || className === undefined) return
        const host = section.querySelector<HTMLElement>(':scope > div') ?? section
        content = document.createElement('div')
        content.className = className
        host.appendChild(content)
      }
      if (content.querySelector('.dsh-team-markdown') === null) {
        // Native re-render replaced our body: restore Markdown from the raw text.
        const raw = stored ?? content.innerText
        rawText.set(section, raw)
        markTeamBubble(
          section,
          section.dataset.teamSender ?? '团队消息',
          undefined,
          section.style.getPropertyValue('--team-message-color') || teamIdentityColor(0),
          raw,
        )
        return
      }
      if (section.querySelector(':scope > .dsh-team-trigger-header') === null) {
        ensureHeader(
          section,
          section.dataset.teamSender ?? '团队消息',
          section.style.getPropertyValue('--team-message-color') || teamIdentityColor(0),
        )
      }
      ensureExpandControl(section, content)
    }

    const decorate = (section: HTMLElement): void => {
      const button = section.querySelector<HTMLElement>(':scope > button')
      const title = button?.textContent ?? ''
      if (!TEAM_TITLE.test(title)) return
      if (section.dataset.teamBubble === 'true') {
        refresh(section)
        return
      }
      if (button?.getAttribute('aria-expanded') === 'false') button.click()
      window.setTimeout(() => {
        if (disposed || !section.isConnected || section.dataset.teamBubble === 'true') return
        const content = section.querySelector<HTMLElement>('[class*="content"]')
        if (content === null) return
        const text = content.innerText
        const match = HEADER_PATTERN.exec(text)
        // System events ("新成员加入" etc.) stay as the native notification row.
        if (match === null) return
        const sender = match[1]!.trim()
        const slotId = match[2]!.trim()
        const color = colors.get(slotId) ?? teamIdentityColor(hash(sender) % 8)
        const raw = text.replace(/\[Team message from .+?; slotId=[^\]]+\]\s*/s, '')
        removeRelayHeader(section)
        rawText.set(section, raw)
        markTeamBubble(section, sender, slotId, color, raw)
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
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    scan()
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [])
  return null
}
