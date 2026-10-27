import { useState } from 'react'
import {
  IconChevronDownOutlineRegular,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AgentTeam.module.css'

/** One row of a select: the stored value, its label, and an optional heading. */
export interface SelectControlOption {
  value: string
  label: string
  /** Rows sharing a heading are grouped under it (provider groups, presets). */
  group?: string
  disabled?: boolean
}

/**
 * The pill select the official settings dialog uses: the current value and a
 * chevron, opening the shipped `Menu` instead of the browser's own dropdown.
 * One control for every picker in the plugin — there is no second implementation.
 *
 * Keyboard: Enter/Space opens (it is a real button), ArrowUp/ArrowDown walk the
 * rows, Enter picks, Escape closes and returns focus to the trigger.
 */
export function SelectControl({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = '请选择',
  title,
  className,
  align = 'start',
  side = 'bottom',
}: {
  value: string
  options: readonly SelectControlOption[]
  onChange: (next: string) => void
  ariaLabel: string
  disabled?: boolean
  placeholder?: string
  title?: string | undefined
  className?: string | undefined
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const current = options.find(option => option.value === value)
  // A stored value the catalog no longer offers still shows its raw value
  // instead of a blank pill, so the dialog never hides what is saved.
  const label = current?.label ?? (value === '' ? placeholder : value)

  const entries: MenuEntry[] = []
  let group: string | undefined
  for (const option of options) {
    if (option.group !== undefined && option.group !== group) {
      entries.push({ type: 'label', id: `group:${option.group}`, text: option.group })
      group = option.group
    }
    entries.push({
      id: option.value,
      label: option.label,
      ...(option.disabled === true ? { disabled: true } : {}),
    })
  }

  return (
    <Menu
      open={open}
      // The list renders into document.body: an open select inside a dialog is
      // never clipped by the dialog's overflow.
      portal
      align={align}
      side={side}
      className={[css.selectControl, className ?? ''].filter(Boolean).join(' ')}
      items={entries}
      selectedId={value}
      onSelect={next => {
        setOpen(false)
        if (next !== value) onChange(next)
      }}
      onClose={() => { setOpen(false) }}
      anchor={(
        <button
          type="button"
          className={css.selectTrigger}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
          title={title ?? label}
          disabled={disabled}
          onClick={() => { setOpen(current => !current) }}
        >
          <span className={css.selectValue}>{label}</span>
          <IconChevronDownOutlineRegular size={12} className={css.selectChevron} />
        </button>
      )}
    />
  )
}
