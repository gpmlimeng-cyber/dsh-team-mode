import { useEffect, useMemo, useState } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconPlusOutlineRegular,
  IconUsersOutlineRegular,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { AddTeamMemberDialog } from './teams/TeamPanel.js'
import { useAgentTeamData } from './components.js'
import css from './AgentTeam.module.css'
import type { TeamView } from '../transport/contracts.js'

type TeamMember = TeamView['members'][string]
type Membership = { team: TeamView; member: TeamMember }

function initial(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase() || '?'
}

function LeaderMark({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} role="presentation" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 7.4 8.2 11 12 4l3.8 7L21 7.4 19.1 18H4.9L3 7.4Zm1.1 12.4h15.8V22H4.1v-2.2Z" fill="currentColor" />
    </svg>
  )
}

function useMembership(sessionId?: string): Membership | undefined {
  const [membership, setMembership] = useState<Membership>()
  useEffect(() => {
    if (sessionId === undefined) {
      setMembership(undefined)
      return
    }
    let live = true
    const load = async (): Promise<void> => {
      try {
        const value = await callAgentTeam('team.list')
        if (!live) return
        for (const team of value.items) {
          const member = Object.values(team.members).find(candidate => candidate.sessionId === sessionId)
          if (member !== undefined) {
            setMembership({ team, member })
            return
          }
        }
        setMembership(undefined)
      } catch {
        if (live) setMembership(undefined)
      }
    }
    void load()
    return subscribeAgentTeam(() => { void load() }, () => {}, () => { void load() })
  }, [sessionId])
  return membership
}

function sortedMembers(team: TeamView): TeamMember[] {
  return Object.values(team.members).sort((left, right) => {
    if (left.role !== right.role) return left.role === 'leader' ? -1 : 1
    return left.joinedAt.localeCompare(right.joinedAt)
  })
}

function keepChatView(sessionId: string): void {
  try {
    const key = `dsh.conversation.${sessionId}`
    const raw = window.localStorage.getItem(key)
    const current = raw === null ? {} : JSON.parse(raw) as Record<string, unknown>
    if (current.view === 'chat') return
    window.localStorage.setItem(key, JSON.stringify({ ...current, view: 'chat' }))
  } catch { /* best effort */ }
}

/** Single-chat header switch between team member Sessions. */
export function TeamMemberSwitcher({
  sessionId,
  openSession,
}: {
  sessionId?: string
  openSession?: (sessionId: string) => void
}): JSX.Element | null {
  const membership = useMembership(sessionId)
  const { catalog, assistants, load } = useAgentTeamData(true)
  const [open, setOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const members = useMemo(() => (membership === undefined ? [] : sortedMembers(membership.team)), [membership])
  if (membership === undefined || sessionId === undefined || openSession === undefined) return null
  const current = membership.member
  const items: MenuEntry[] = members.map(member => ({
    id: member.sessionId,
    label: (
      <span className={css.teamSwitcherItem}>
        <span
          className={css.teamSwitcherAvatar}
          style={{ width: 20, height: 20, minWidth: 20, maxWidth: 20, flex: '0 0 20px', aspectRatio: '1 / 1' }}
          aria-hidden="true"
        >{initial(member.displayName)}</span>
        <span className={css.teamSwitcherItemCopy}>
          <span className={css.teamSwitcherItemName}>{member.displayName}</span>
          {member.role === 'leader' && (
            <span className={css.teamSwitcherLeader}>
              <LeaderMark size={11} />
              Leader
            </span>
          )}
        </span>
      </span>
    ),
  }))
  return (
    <>
    <div className={css.teamSwitcherGroup}>
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={items}
      footer={[{ id: '__manage__', label: '管理团队', icon: <IconUsersOutlineRegular size={16} /> }]}
      selectedId={sessionId}
      onSelect={id => {
        setOpen(false)
        if (id === '__manage__') {
          const deadline = Date.now() + 5_000
          const settle = (): void => {
            const tab = Array.from(document.querySelectorAll('[data-conversation-tabs] button'))
              .find(button => button.textContent?.trim() === '团队管理')
            if (tab !== undefined) {
              ;(tab as HTMLElement).click()
              return
            }
            if (Date.now() < deadline) setTimeout(settle, 100)
          }
          setTimeout(settle, 100)
          return
        }
        if (id === sessionId) return
        keepChatView(id)
        openSession(id)
      }}
      align="end"
      side="bottom"
      className={css.teamSwitcherAnchor}
      anchor={(
        <button
          type="button"
          className={`${css.teamSwitcherButton} ${css.teamSwitcherButtonGrouped}`}
          aria-label={`切换团队成员，当前 ${current.displayName}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <span
            className={css.teamSwitcherAvatar}
            style={{ width: 20, height: 20, minWidth: 20, maxWidth: 20, flex: '0 0 20px', aspectRatio: '1 / 1' }}
            aria-hidden="true"
          >{initial(current.displayName)}</span>
          <span className={css.teamSwitcherName}>{current.displayName}</span>
          {current.role === 'leader' && <span className={css.teamSwitcherLeader} aria-label="Leader"><LeaderMark size={12} /></span>}
          <IconChevronDownOutlineRegular size={12} />
        </button>
      )}
    />
    <button
      type="button"
      className={css.teamSwitcherAdd}
      aria-label="添加成员"
      title="添加成员"
      onClick={() => { setAddMemberOpen(true) }}
    >
      <IconPlusOutlineRegular size={14} />
    </button>
    </div>
    {addMemberOpen && (
      <AddTeamMemberDialog
        open={addMemberOpen}
        team={membership.team}
        catalog={catalog}
        assistants={assistants}
        onClose={() => { setAddMemberOpen(false) }}
        onChanged={async () => { await load() }}
      />
    )}
    </>
  )
}

/** Additive AionUi-style guidance under the shipped hero; never replaces hero or composer. */
export function TeamMemberHeroHint({ sessionId }: { sessionId?: string }): JSX.Element | null {
  const membership = useMembership(sessionId)
  if (membership === undefined) return null
  const leader = membership.member.role === 'leader'
  const configuredPrompts = membership.member.assistantSnapshot.prompts ?? []
  const suggestions = configuredPrompts.length > 0
    ? configuredPrompts.slice(0, 3)
    : leader
      ? ['组织一场辩论赛，让不同助手各持立场', '帮我在团队里加一个擅长 ___ 的成员', '多位专家会诊同一个问题']
      : []
  return (
    <div className={css.teamMemberHeroHint} role="note">
      <span className={css.teamMemberHeroAvatar} aria-hidden="true">
        {membership.member.displayName.trim().slice(0, 1).toLocaleUpperCase() || '?'}
      </span>
      <span className={css.teamMemberHeroCopy}>
        <span className={css.teamMemberHeroName}>
          {membership.member.displayName}
          <span className={css.teamMemberHeroRole}>{leader ? 'Leader' : '成员'}</span>
        </span>
        <span className={css.teamMemberHeroLine}>
          {leader
            ? '你好，我是 Leader，负责理解你的目标并协调团队。描述你想做的事，我来安排。'
            : '你好，我是团队成员，我听 Leader 和你的指挥。等待 Leader 分配任务。'}
        </span>
      </span>
      {suggestions.length > 0 && (
        <div className={css.teamMemberHeroSuggestions}>
          {suggestions.map(suggestion => (
            <div key={suggestion} className={css.teamMemberHeroSuggestion}>{suggestion}</div>
          ))}
        </div>
      )}
    </div>
  )
}
