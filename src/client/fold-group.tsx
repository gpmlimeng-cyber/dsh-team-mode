import type { ReactNode, SyntheticEvent } from 'react'
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AgentTeam.module.css'

/**
 * The one fold shape of this plugin: a native `<details>` whose summary is
 * icon + title (+ hint) on the left, optional meta/action on the right and a
 * chevron that turns down when open.
 *
 * It replaces the two earlier one-off folds — the create dialog's 描述 fold and
 * the capability picker's group — and is what the assistant settings pane
 * stacks. Native `<details>` keeps keyboard/focus behaviour without a second
 * disclosure implementation.
 *
 * The fold is controlled: `open` decides, `onToggle` reports the user's click.
 */
export function FoldGroup({
  icon,
  title,
  hint,
  meta,
  action,
  open,
  onToggle,
  children,
  dataKind,
}: {
  icon?: ReactNode | undefined
  title: string
  hint?: string | undefined
  meta?: ReactNode | undefined
  action?: ReactNode | undefined
  /** Omit both `open` and `onToggle` for a fold the browser owns. */
  open?: boolean | undefined
  onToggle?: ((open: boolean) => void) | undefined
  children: ReactNode
  dataKind?: string | undefined
}): JSX.Element {
  return (
    <details
      className={css.foldGroup}
      {...(open === undefined ? {} : { open })}
      data-dsh-fold={dataKind}
      {...(onToggle === undefined
        ? {}
        : { onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => { onToggle(event.currentTarget.open) } })}
    >
      <summary className={css.foldGroupSummary}>
        {icon !== undefined && <span className={css.foldGroupIcon} aria-hidden="true">{icon}</span>}
        <span className={css.foldGroupCopy}>
          <span className={css.foldGroupTitle}>{title}</span>
          {hint !== undefined && hint !== '' && (
            <span className={css.foldGroupHint}>{hint}</span>
          )}
        </span>
        {meta !== undefined && <span className={css.foldGroupMeta}>{meta}</span>}
        {action}
        <IconChevronRightOutlineRegular size={12} className={css.foldGroupChevron} />
      </summary>
      {/* A closed controlled fold does not mount its body: closed memory/history
          groups must not read anything until they are opened. */}
      {(open === undefined || open) && <div className={css.foldGroupBody}>{children}</div>}
    </details>
  )
}
