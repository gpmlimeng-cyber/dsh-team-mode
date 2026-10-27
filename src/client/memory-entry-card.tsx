import type { ReactNode } from 'react'
import css from './AgentTeam.module.css'
import { memorySourceLabel, memoryStatusLabel, memoryVisibilityLabel } from './labels.js'
import type { MemoryEntry } from '../domain/types.js'

function memoryTime(value: string): string {
  return value.slice(0, 16).replace('T', ' ')
}

/**
 * The one renderer for a structured memory entry. It reads only the entry and
 * caller-provided actions, so the assistant panel and the team panel show the
 * same card instead of drifting apart. Team-scoped rows are always `team-safe`
 * (their container has no private meaning), history rows render the same way
 * with no actions, and a pending revision proposal is marked as revising the
 * entry it names so 采纳 is understood before it is clicked.
 */
export function MemoryEntryCard({
  entry,
  actions,
}: {
  entry: MemoryEntry
  actions?: ReactNode
}): JSX.Element {
  return (
    <article className={css.memoryEntryCard}>
      <div className={css.memoryEntryHeader}>
        <strong>{entry.title}</strong>
        <span className={css.memoryBadges}>
          <span className={`${css.memoryBadge} ${entry.visibility === 'private' ? css.memoryBadgePrivate : ''}`}>
            {memoryVisibilityLabel(entry.visibility)}
          </span>
          <span className={`${css.memoryBadge} ${entry.status === 'proposed' ? css.memoryBadgeProposed : ''}`}>
            {memoryStatusLabel(entry.status)}
          </span>
          {entry.supersedes !== undefined && (
            <span className={css.memoryBadge}>修订</span>
          )}
          <span className={css.memoryBadge}>v{entry.revision}</span>
        </span>
      </div>
      {entry.body !== '' && <p className={css.memoryEntryBody}>{entry.body}</p>}
      <div className={css.memoryEntryMeta}>
        <span>
          {memorySourceLabel(entry.source)}
          {entry.key === undefined ? '' : ` · ${entry.key}`}
          {` · ${memoryTime(entry.updatedAt)}`}
        </span>
        {actions}
      </div>
    </article>
  )
}
