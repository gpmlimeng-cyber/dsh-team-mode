import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronRightOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconSearchOutlineRegular,
  IconUserOutlineRegular,
  IconUsersOutlineRegular,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AgentTeam.module.css'

/** One assistant the picker can start a chat with. */
export interface NewChatEntry {
  id: string
  name: string
  /**
   * The assistant's own picture, rendered by the caller with the same branch the
   * sidebar row uses (uploaded avatar or mascot) so the two never diverge.
   */
  portrait: ReactNode
  /** Shown under the name when the assistant has something to say about itself. */
  hint?: string
}

/**
 * The "start a chat with…" picker: search on top, then the create actions, then
 * every assistant. The native Menu owns placement (portalled, tracking the
 * shipped ＋ button) and the keyboard (Escape closes and returns focus, outside
 * clicks close); the panel keeps the search field, its ↑/↓/Enter walk and every
 * row exactly as before.
 */
export function NewChatPanel({
  anchor,
  entries,
  onClose,
  onNewAssistant,
  onNewTeam,
  onPick,
}: {
  anchor: HTMLElement | null
  entries: readonly NewChatEntry[]
  onClose: () => void
  onNewAssistant: () => void
  onNewTeam: () => void
  onPick: (id: string) => void
}): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const rows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const matched = normalized === ''
      ? entries
      : entries.filter(entry => entry.name.toLocaleLowerCase().includes(normalized))
    return matched
  }, [entries, query])

  /** Create actions first, then the assistants: one flat list for the keyboard. */
  const actions = useMemo(() => ([
    { id: 'new-assistant', label: '新建助手', icon: <IconUserOutlineRegular size={16} /> },
    { id: 'new-team', label: '新建团队', icon: <IconUsersOutlineRegular size={16} /> },
    { id: 'create-group', label: '创建分组', icon: <IconFolderOpenOutlineRegular size={16} /> },
  ]), [])

  const rowCount = actions.length + rows.length

  useEffect(() => {
    // The host Menu mounts its list hidden for one measuring pass
    // (MEASURE_STYLE) and only then places it, so focusing on mount silently
    // fails. Wait for the placement frame; it also lands after the create
    // menu's own post-selection focus return.
    const frame = requestAnimationFrame(() => { inputRef.current?.focus() })
    return () => { cancelAnimationFrame(frame) }
  }, [])

  // The native Menu cannot name an external trigger, so the shipped ＋ button
  // gets the keyboard back when this panel unmounts (Escape and picks alike).
  useEffect(() => {
    const trigger = anchor
    return () => { trigger?.focus() }
  }, [anchor])

  if (anchor === null || !anchor.isConnected) return null

  const run = (id: string): void => {
    if (id === 'new-assistant') { onClose(); onNewAssistant(); return }
    if (id === 'new-team') { onClose(); onNewTeam(); return }
    if (id === 'create-group') { onClose(); return }
    onClose()
    onPick(id)
  }

  return (
    <Menu
      open
      portal
      onClose={onClose}
      getAnchorRect={() => (anchor.isConnected ? anchor.getBoundingClientRect() : null)}
      anchor={<span />}
      listClassName={css.newChatPicker}
    >
      <div className={css.newChatBody} role="group" aria-label="新对话：选择助手">
        <div className={css.newChatSearch}>
          <IconSearchOutlineRegular size={14} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder="跟谁聊？搜索助手"
            aria-label="搜索助手"
            onChange={(event) => { setQuery(event.target.value); setCursor(0) }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor(current => (current + 1) % Math.max(rowCount, 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor(current => (current - 1 + Math.max(rowCount, 1)) % Math.max(rowCount, 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                if (cursor < actions.length) {
                  const action = actions[cursor]
                  if (action !== undefined) run(action.id)
                  return
                }
                const picked = rows[cursor - actions.length]
                if (picked !== undefined) run(picked.id)
              }
            }}
          />
        </div>
        <div className={css.newChatList} role="listbox" aria-label="助手">
          {actions.map((action, index) => (
            <button
              key={action.id}
              type="button"
              role="option"
              aria-selected={cursor === index}
              className={`${css.newChatRow} ${cursor === index ? css.newChatRowActive : ''}`}
              onPointerEnter={() => { setCursor(index) }}
              onClick={() => { run(action.id) }}
            >
              <span className={css.newChatIcon}>{action.icon}</span>
              <span className={css.newChatRowText}>{action.label}</span>
              <IconChevronRightOutlineRegular size={12} className={css.newChatRowCaret} />
            </button>
          ))}
          {rows.length > 0 && <div className={css.newChatSeparator} role="presentation" />}
          {rows.map((entry, index) => {
            const rowIndex = actions.length + index
            return (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={cursor === rowIndex}
                className={`${css.newChatRow} ${cursor === rowIndex ? css.newChatRowActive : ''}`}
                onPointerEnter={() => { setCursor(rowIndex) }}
                onClick={() => { run(entry.id) }}
              >
                <span className={css.newChatRowAvatar}>{entry.portrait}</span>
                <span className={css.newChatRowText}>
                  <span className={css.newChatRowName}>{entry.name}</span>
                  {entry.hint !== undefined && entry.hint !== ''
                    ? <span className={css.newChatRowHint}>{entry.hint}</span>
                    : null}
                </span>
              </button>
            )
          })}
          {rows.length === 0 && query.trim() !== '' && (
            <div className={css.newChatEmpty}>没有匹配的助手</div>
          )}
        </div>
      </div>
    </Menu>
  )
}
