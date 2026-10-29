import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamView } from '../transport/contracts.js'
import { callAgentTeam } from './api.js'
import {
  SIDEBAR_GROUP_BRIEF_MAX_CHARS,
  sidebarGroupBriefError,
  sidebarGroupBriefUsage,
} from './sidebar-groups.js'
import { AnimatedModal } from './shared.js'
import css from './AgentTeam.module.css'

/**
 * The two 公告 scopes. They are one editor but not one data model: the team
 * announcement is trimmed and cleared by deleting the field, while a group
 * brief keeps its whitespace and stores an empty string. The caps live next to
 * the Host constants they mirror, so a scope can never borrow the other cap.
 */
export type AnnouncementScope = 'team' | 'group'

/**
 * The Host's announcement cap (`TEAM_ANNOUNCEMENT_MAX_CHARS` in the domain
 * schemas). The client bundle stays Zod-free, so the number is repeated here —
 * the same split the sidebar group brief already uses.
 * `tests/client-team-sidebar-data.spec.ts` pins the two numbers together.
 */
export const TEAM_ANNOUNCEMENT_UI_LIMIT = 2_000

/** The announcement as the detail surface renders it; blank is no announcement. */
export function teamAnnouncementText(value: string | undefined): string {
  return value?.trim() ?? ''
}

/** `已用 / 上限`, native counter text for the editor. */
export function teamAnnouncementUsage(value: string): string {
  return `${value.length} / ${TEAM_ANNOUNCEMENT_UI_LIMIT}`
}

/**
 * The local mirror of the Host's refusal. The editor keeps the text instead of
 * truncating it, and the save button stays disabled until it fits.
 */
export function teamAnnouncementError(value: string): string | undefined {
  if (value.length <= TEAM_ANNOUNCEMENT_UI_LIMIT) return undefined
  return `公告最多 ${TEAM_ANNOUNCEMENT_UI_LIMIT} 个字符，请删减 ${value.length - TEAM_ANNOUNCEMENT_UI_LIMIT} 个字符`
}

/** The counter a scope shows; each scope counts against its own Host cap. */
export function announcementUsage(scope: AnnouncementScope, value: string): string {
  return scope === 'team' ? teamAnnouncementUsage(value) : sidebarGroupBriefUsage(value)
}

/** The refusal a scope shows; over-long text is rejected, never truncated. */
export function announcementError(scope: AnnouncementScope, value: string): string | undefined {
  return scope === 'team' ? teamAnnouncementError(value) : sidebarGroupBriefError(value)
}

/**
 * Whether a scope has unsaved text. The team announcement is trimmed on every
 * write, so whitespace-only edits are not dirty and blank text deletes it; a
 * group brief is stored verbatim, so even whitespace is a real change.
 */
export function announcementDirty(
  scope: AnnouncementScope,
  draft: string,
  initial: string,
): boolean {
  return scope === 'team' ? draft.trim() !== initial : draft !== initial
}

export type AnnouncementDialogProps =
  | {
    scope: 'team'
    team: TeamView
    onClose: () => void
    onChanged: () => Promise<void>
  }
  | { scope: 'group'; name: string; onClose: () => void }

/**
 * The one user-only 公告 editor. `scope` switches the stored field, the cap and
 * the blank semantics without touching either transport: TeamCard opens the
 * team scope, the group ⋯ menu opens the 分区 scope, and a group with no team
 * still edits its own brief. The team write reloads the aggregate before
 * closing, because the next member turn reads that aggregate.
 */
export function AnnouncementDialog(props: AnnouncementDialogProps): JSX.Element {
  const group = props.scope === 'group'
  const team = props.scope === 'team' ? props.team : undefined
  const teamId = team?.id
  const onClose = props.onClose
  const onTeamChanged = props.scope === 'team' ? props.onChanged : undefined
  const name = props.scope === 'group' ? props.name : ''
  const [value, setValue] = useState(() => team === undefined ? '' : teamAnnouncementText(team.announcement))
  const [initial, setInitial] = useState(() => team === undefined ? '' : teamAnnouncementText(team.announcement))
  const [loaded, setLoaded] = useState(team !== undefined)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const fieldId = group ? 'dsh-team-mode-group-brief' : `dsh-team-announcement-${team?.id ?? ''}`
  const hintId = `${fieldId}-hint`
  const overLimit = announcementError(props.scope, value)
  const usage = announcementUsage(props.scope, value)
  const dirty = announcementDirty(props.scope, value, initial)
  const canSave = loaded && !busy && dirty && overLimit === undefined

  // The group brief is read per open: the sidebar's own list stays names-only,
  // and this dialog is the only surface that loads the text.
  useEffect(() => {
    if (name === '') return
    let cancelled = false
    void callAgentTeam('sidebar.groups.briefs').then(records => {
      if (cancelled) return
      const record = records.find(item => item.name === name)
      if (record === undefined) {
        setError(`分区「${name}」已不存在，请关闭后重新打开侧栏。`)
        return
      }
      setValue(record.brief)
      setInitial(record.brief)
    }).catch(cause => {
      if (!cancelled) setError(messageOf(cause))
    }).finally(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [name])

  async function writeTeamAnnouncement(announcement: string): Promise<void> {
    if (teamId === undefined || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await callAgentTeam('team.announcement.set', { teamId, announcement })
      // Reload before closing: the card, and the next member prompt, both read
      // this aggregate.
      await onTeamChanged?.()
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  async function save(): Promise<void> {
    if (!canSave) return
    if (props.scope === 'team') {
      await writeTeamAnnouncement(value)
      return
    }
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      const record = await callAgentTeam('sidebar.groups.brief.set', {
        name: props.name,
        brief: value,
      })
      // Adopt the Host's copy so the counter and the dirty flag follow it.
      setValue(record.brief)
      setInitial(record.brief)
      setSaved(true)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatedModal
      open
      onClose={() => { if (!busy) onClose() }}
      title={group ? `「${name}」的公告` : '团队公告'}
      description={group
        ? '组内团队和助手的下一轮对话都会读到这段公告；它只由你编辑，Agent 没有写入入口。'
        : '写一段全队长期有效的约定。每位成员（含 Leader）的下一轮对话都会读到它；只有你能编辑，Agent 没有写入入口。'}
      closeLabel="关闭"
      {...(group
        ? {
            className: css.sidebarGroupDialog ?? '',
            contentClassName: css.sidebarGroupDialogContent ?? '',
          }
        : {})}
      footer={(
        <>
          <Button variant="outline" type="button" disabled={busy} onClick={onClose}>
            {saved ? '关闭' : '取消'}
          </Button>
          {!group && initial !== '' && (
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => { void writeTeamAnnouncement('') }}
            >
              {busy ? '处理中…' : '清除公告'}
            </Button>
          )}
          <Button
            variant="primary"
            type="button"
            disabled={!canSave}
            onClick={() => { void save() }}
          >
            {busy ? '保存中…' : '保存公告'}
          </Button>
        </>
      )}
    >
      {!loaded
        ? <div className={css.dialogEmpty}>正在读取公告…</div>
        : (
          <div className={css.sidebarGroupBriefForm}>
            <div className={css.sidebarGroupBriefHead}>
              <label className={css.sidebarGroupBriefLabel} htmlFor={fieldId}>公告内容</label>
              <span
                className={`${css.sidebarGroupBriefCount} ${overLimit === undefined ? '' : css.sidebarGroupBriefCountOver}`}
                {...(group ? { 'data-dsh-group-brief-count': true } : { 'data-dsh-team-announcement-count': true })}
              >
                {usage}
              </span>
            </div>
            <textarea
              id={fieldId}
              className={`${css.input} ${css.sidebarGroupBriefInput}`}
              data-modal-autofocus
              {...(group ? { 'data-dsh-group-brief': true } : { 'data-dsh-team-announcement-input': true })}
              rows={group ? 9 : 8}
              value={value}
              placeholder={group
                ? '写下这个分区共享的背景、约定或注意事项…'
                : '写下全队都要遵守的长期约定，例如：冻结期只提交修复。'}
              aria-label={group ? '分组公告' : '团队公告'}
              aria-describedby={hintId}
              aria-invalid={overLimit !== undefined}
              disabled={busy}
              onChange={event => {
                setValue(event.target.value)
                setSaved(false)
              }}
            />
            <p id={hintId} className={css.sidebarGroupBriefHint}>
              {group
                ? `最多 ${SIDEBAR_GROUP_BRIEF_MAX_CHARS.toLocaleString('en-US')} 个字符（约 24 KB）。超出时不会截断，而是拒绝保存。`
                : `留空保存会清除公告；最多 ${TEAM_ANNOUNCEMENT_UI_LIMIT.toLocaleString('en-US')} 个字符，超出时不会截断，而是拒绝保存。`}
            </p>
            {group && value === '' && (
              <p className={css.sidebarGroupBriefEmpty}>
                还没有公告。留空保存会清除这个分区的公告。
              </p>
            )}
            {overLimit !== undefined && <div role="alert" className={css.inlineError}>{overLimit}</div>}
            {saved && (
              <div className={css.sidebarGroupBriefSaved} role="status">
                已保存。组内成员下一次组建提示词时就会读到这段公告。
              </div>
            )}
            {error !== undefined && <div role="alert" className={css.inlineError}>{error}</div>}
          </div>
        )}
    </AnimatedModal>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
