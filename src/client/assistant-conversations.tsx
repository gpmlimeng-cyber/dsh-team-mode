import { useState } from 'react'
import {
  IconArchiveOutlineRegular,
  IconEllipsisOutlineRegular,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { readAssistantThreadExpanded } from './assistant-thread-state.js'
import css from './AgentTeam.module.css'
import type { AssistantInstance } from '../domain/types.js'

/**
 * One conversation of an Assistant instance, rendered with the team roster's
 * row structure. A thread is an extra conversation of the same Assistant, never
 * a team member: it carries no role mark, and its second line says what it is.
 */
export interface AssistantConversationRow {
  sessionId: string
  /** The instance's main Session; only the row above opens it by default. */
  main: boolean
  /** Roster name cell. The main Session leads, threads are numbered in order. */
  title: string
  /** Roster second line. Threads say 附加会话 so they never read as a role. */
  subtitle: string
  /** Roster role slot; only the main Session fills it. */
  role?: string
}

/**
 * Main Session first, then the instance's threads in their stored order. A
 * legacy instance with no bound main Session and no threads yields no rows, so
 * the assistant row renders exactly as before.
 */
export function assistantConversationRows(
  instance: Pick<AssistantInstance, 'mainSessionId' | 'threadSessionIds'>,
): AssistantConversationRow[] {
  const rows: AssistantConversationRow[] = []
  const main = instance.mainSessionId
  if (main !== undefined && main !== '') {
    rows.push({
      sessionId: main,
      main: true,
      title: '主会话',
      subtitle: '默认打开的会话',
      role: '主',
    })
  }
  const threads = instance.threadSessionIds ?? []
  threads.forEach((sessionId, index) => {
    rows.push({
      sessionId,
      main: false,
      title: `附加会话 ${index + 1}`,
      subtitle: '附加会话',
    })
  })
  return rows
}

/**
 * The assistant row's disclosure: an in-session toggle wins over the stored
 * per-assistant state. View state only — nothing here changes which Sessions
 * an instance owns.
 */
export function assistantConversationExpanded(
  instanceId: string,
  toggles: Readonly<Record<string, boolean>>,
): boolean {
  return toggles[instanceId] ?? readAssistantThreadExpanded(instanceId)
}

/** One conversation row: navigation on the row, the menu on the thread rows. */
function ConversationRow({
  row,
  onOpen,
  onArchive,
}: {
  row: AssistantConversationRow
  onOpen: (sessionId: string) => void
  onArchive: (sessionId: string) => void
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div
      className={css.assistantConversationRow}
      data-dsh-assistant-conversation={row.sessionId}
      {...(row.main ? { 'data-dsh-assistant-conversation-main': '' } : {})}
    >
      <button
        type="button"
        className={css.sidebarRosterRow}
        title={`${row.title} · ${row.subtitle}`}
        onClick={() => { onOpen(row.sessionId) }}
      >
        <span className={css.sidebarRosterCopy}>
          <span className={css.sidebarRosterTop}>
            <span className={css.sidebarRosterName}>{row.title}</span>
            {row.role !== undefined && (
              <span className={css.sidebarRosterRole}>{row.role}</span>
            )}
          </span>
          <span className={css.sidebarRosterSubtitle}>{row.subtitle}</span>
        </span>
      </button>
      {!row.main && (
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          align="end"
          side="bottom"
          dense
          portal
          className={css.sidebarTeamMore ?? ''}
          items={[
            { id: 'archive', label: '归档会话', icon: <IconArchiveOutlineRegular size={14} /> },
          ]}
          onSelect={id => {
            setMenuOpen(false)
            if (id === 'archive') onArchive(row.sessionId)
          }}
          anchor={(
            <Tooltip label="会话操作" delayMs={400}>
              <button
                type="button"
                className={css.sidebarTeamManage}
                aria-label={`会话操作 ${row.title}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-dsh-assistant-conversation-menu
                onClick={() => { setMenuOpen(current => !current) }}
              >
                <IconEllipsisOutlineRegular size={14} />
              </button>
            </Tooltip>
          )}
        />
      )}
    </div>
  )
}

/**
 * The conversation tree under one Assistant row. The main Session and every
 * thread are navigation rows; archiving is offered on thread rows only, because
 * the main Session is the instance itself and cannot be retired here.
 */
export function AssistantConversationList({
  name,
  rows,
  onOpen,
  onArchive,
}: {
  name: string
  rows: readonly AssistantConversationRow[]
  onOpen: (sessionId: string) => void
  onArchive: (sessionId: string) => void
}): JSX.Element {
  return (
    <div
      className={css.sidebarRosterList}
      role="group"
      aria-label={`${name} 的会话`}
      data-dsh-assistant-conversations
    >
      {rows.map(row => (
        <ConversationRow
          key={row.sessionId}
          row={row}
          onOpen={onOpen}
          onArchive={onArchive}
        />
      ))}
    </div>
  )
}
