import type { ReactNode } from 'react'
import css from './AgentTeam.module.css'

/**
 * The official settings-dialog row: the label and its grey explanation on the
 * left, the control on the right, one hairline between rows. A row is the unit
 * every dialog setting is written in — no free-floating labelled fields.
 */
export function SettingsRow({
  label,
  hint,
  control,
}: {
  label: string
  hint?: string | undefined
  control: ReactNode
}): JSX.Element {
  return (
    <div className={css.settingsRow}>
      <div className={css.settingsRowCopy}>
        <span className={css.settingsRowLabel}>{label}</span>
        {hint !== undefined && hint !== '' && (
          <span className={css.settingsRowHint}>{hint}</span>
        )}
      </div>
      <div className={css.settingsRowControl}>{control}</div>
    </div>
  )
}

/** The row list: one stack, hairlines between rows, none after the last. */
export function SettingsRows({ children }: { children: ReactNode }): JSX.Element {
  return <div className={css.settingsRows}>{children}</div>
}
