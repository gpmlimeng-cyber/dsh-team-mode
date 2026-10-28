import type { FormEvent, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconCloseOutlineRegular,
  IconEditOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantView,
  CatalogView,
  TeamView,
} from '../../transport/contracts.js'
import type { TeamCheckpoint, TeamTask } from '../../domain/types.js'
import { epochOf } from '../../domain/types.js'
import { callAgentTeam } from '../api.js'
import { workspaceSelectable } from '../assistant-form.js'
import { SelectControl } from '../select-control.js'
import { checkpointNoteError } from '../assistant-checkpoint.js'
import { AssistantPanel } from '../assistants/AssistantPanel.js'
import { MemoryEntryCard } from '../memory-entry-card.js'
import css from '../AgentTeam.module.css'
import {
  filterGoalGroups,
  GOAL_CARD_RENDER_LIMIT,
  GOAL_FILTER_ALL,
  GOAL_FILTER_UNGROUPED,
  GOAL_TASK_RENDER_LIMIT,
  goalModeLabel,
  goalStatusLabel,
  hasTeamGoals,
  memberStatusLabel,
  memoryJournalActionLabel,
  memorySourceLabel,
  TASK_STATE_LABELS,
  taskDependencyView,
  taskKindLabel,
  taskScheduleSummary,
  taskVerdictLabel,
  taskVerdictTone,
  TEAM_TASK_CREATE_HINT,
  teamCheckpointStatusLabel,
  teamCheckpointSummary,
  teamGoalGroups,
  teamMemoryView,
} from '../labels.js'
import type { GoalTaskGroup } from '../labels.js'
import { UsageSection, teamUsageScope } from '../usage.js'
import { AnimatedModal, Empty, Field } from '../shared.js'
import { isTeamExecuting } from '../team-status.js'
import type { WorkspaceChoice } from '../types.js'
import { useTeamText } from '../team-i18n.js'
import {
  TEAM_TEMPLATES,
  teamTemplateSlots,
  type TeamTemplate,
  type TeamTemplateId,
} from '../team-templates.js'

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

/**
 * The standing notice on the team detail. It renders only when the team has
 * one: an unused announcement must not occupy the card. The editor is the
 * user-only modal below; this section is read-only.
 */
export function TeamAnnouncementSection({
  announcement,
}: {
  announcement: string | undefined
}): JSX.Element | null {
  const text = teamAnnouncementText(announcement)
  if (text === '') return null
  return (
    <section className={css.teamAnnouncementSection} aria-label="团队公告" data-dsh-team-announcement>
      <div className={css.teamSectionHeader}>
        <strong>团队公告</strong>
        <span className={css.teamSectionActions}>
          <span>每位成员的下一轮对话都会读到</span>
        </span>
      </div>
      <p className={css.teamAnnouncementText}>{text}</p>
    </section>
  )
}

export function AddTeamMemberDialog({
  open,
  team,
  catalog,
  assistants,
  onClose,
  onChanged,
}: {
  open: boolean
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  onClose: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const [addingAssistantId, setAddingAssistantId] = useState<string>()
  const [configuringAssistants, setConfiguringAssistants] = useState(false)
  const [error, setError] = useState<string>()
  const selectableAssistants = assistants.filter(assistant => assistant.enabled && assistant.teamSelectable)

  async function addMember(assistant: AssistantView): Promise<void> {
    setAddingAssistantId(assistant.id)
    try {
      await callAgentTeam('team.addMember', {
        teamId: team.id,
        value: { assistantId: assistant.id },
      }, team.revision)
      setError(undefined)
      onClose()
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAddingAssistantId(undefined)
    }
  }

  function close(): void {
    if (addingAssistantId !== undefined) return
    setConfiguringAssistants(false)
    setError(undefined)
    onClose()
  }

  return (
    <>
      <AnimatedModal
        open={open}
        onClose={close}
        title="添加助手"
        description={`选择一个助手加入团队“${team.name}”。同一个助手可以多次加入。`}
        closeLabel="关闭"
        className={css.addMemberDialog ?? ''}
        contentClassName={css.addMemberDialogContent ?? ''}
      >
        <div className={css.addMemberDialogHeader}>
          <strong>助手列表</strong>
          <div className={css.addMemberDialogHeaderActions}>
            <span>{selectableAssistants.length} 个可用助手</span>
            <Button
              variant="outline"
              size="sm"
              disabled={addingAssistantId !== undefined}
              onClick={() => { setConfiguringAssistants(true) }}
            >
              助手配置
            </Button>
          </div>
        </div>
        <div className={css.addMemberMenuList}>
          {selectableAssistants.map(assistant => (
            <button
              key={assistant.id}
              type="button"
              className={css.addMemberOption}
              disabled={addingAssistantId !== undefined}
              onClick={() => { void addMember(assistant) }}
            >
              <span className={css.addMemberAvatar}>{assistant.name.slice(0, 1).toUpperCase()}</span>
              <span className={css.addMemberCopy}>
                <strong>{assistant.name}</strong>
                <span>{assistant.provider} / {assistant.model}</span>
              </span>
              <span className={css.addMemberOptionAction}>
                {addingAssistantId === assistant.id ? '添加中…' : <IconPlusOutlineRegular size={14} />}
              </span>
            </button>
          ))}
          {selectableAssistants.length === 0 && (
            <span className={css.addMemberEmpty}>
              {assistants.length === 0
                ? '还没有可添加的助手模板'
                : '没有已启用且允许加入团队的助手，请到“助手配置”中开启'}
            </span>
          )}
        </div>
        {error && <div role="alert" className={css.inlineError}>{error}</div>}
      </AnimatedModal>
      <AnimatedModal
        open={configuringAssistants}
        onClose={() => { setConfiguringAssistants(false) }}
        title="助手配置"
        closeLabel="关闭"
        description="创建和维护可在不同团队间复用的助手模板。"
        className={css.assistantManagementDialog ?? ''}
        contentClassName={css.assistantManagementDialogContent ?? ''}
      >
        <div className={css.assistantManagementBody}>
          <AssistantPanel
            catalog={catalog}
            assistants={assistants}
            onChanged={onChanged}
          />
        </div>
      </AnimatedModal>
    </>
  )
}

function CloneTeamDialog({
  open,
  team,
  catalog,
  pickWorkspace,
  onClose,
  onCreated,
}: {
  open: boolean
  team: TeamView
  catalog: CatalogView | undefined
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onClose: () => void
  onCreated: (teamId: string) => Promise<void>
}): JSX.Element {
  const catalogWorkspaces = catalog?.workspaces.filter(workspace => workspaceSelectable(workspace)) ?? []
  const [name, setName] = useState(`${team.name} 副本`)
  const [workspaceId, setWorkspaceId] = useState(team.workspaceId)
  const [pickedWorkspace, setPickedWorkspace] = useState<WorkspaceChoice>()
  const [saving, setSaving] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [error, setError] = useState<string>()
  const members = Object.values(team.members)
  const workspaces = useMemo(() => {
    const items = [...catalogWorkspaces]
    const fallback: WorkspaceChoice = pickedWorkspace ?? {
      id: team.workspaceId,
      path: team.workspacePath,
      title: workspaceName(team.workspacePath),
    }
    if (!items.some(workspace => workspace.id === fallback.id)) {
      items.push({ ...fallback, status: 'ok' as const })
    }
    return items
  }, [catalogWorkspaces, pickedWorkspace, team.workspaceId, team.workspacePath])

  useEffect(() => {
    if (!open) return
    setName(`${team.name} 副本`)
    setWorkspaceId(team.workspaceId)
    setPickedWorkspace(undefined)
    setSaving(false)
    setPickingWorkspace(false)
    setError(undefined)
  }, [open, team.id, team.name, team.workspaceId])

  async function chooseWorkspace(): Promise<void> {
    setPickingWorkspace(true)
    try {
      const workspace = await pickWorkspace()
      if (workspace === null) return
      setPickedWorkspace(workspace)
      setWorkspaceId(workspace.id)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPickingWorkspace(false)
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!name.trim() || !workspaceId) return
    setSaving(true)
    try {
      const draft = await callAgentTeam('team.clone', {
        teamId: team.id,
        name,
        workspaceId,
      })
      await callAgentTeam('team.start', { id: draft.id }, draft.revision)
      setError(undefined)
      onClose()
      await onCreated(draft.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  function close(): void {
    if (saving || pickingWorkspace) return
    onClose()
  }

  return (
    <AnimatedModal
      open={open}
      onClose={close}
      title="复制团队"
      closeLabel="关闭"
      description="复用当前团队配置，并为每位成员创建全新 Session。"
      className={css.cloneTeamDialog ?? ''}
      contentClassName={css.cloneTeamDialogContent ?? ''}
    >
      <form className={css.cloneTeamForm} onSubmit={(event) => { void submit(event) }}>
        <div className={css.cloneTeamFields}>
          <Field label="团队名称">
            <input
              required
              value={name}
              onChange={event => { setName(event.target.value) }}
              placeholder="输入团队名称"
              className={css.input}
              autoFocus
            />
          </Field>
          <Field label="Workspace">
            <div className={css.workspacePickerRow}>
              <SelectControl
                ariaLabel="Workspace"
                value={workspaceId}
                placeholder={workspaces.length === 0 ? '暂无 Workspace' : '请选择 Workspace'}
                options={workspaces.map(item => ({
                  value: item.id,
                  label: `${item.title} — ${item.path}`,
                }))}
                onChange={setWorkspaceId}
              />
              <Button
                variant="outline"
                type="button"
                disabled={pickingWorkspace || saving}
                onClick={() => { void chooseWorkspace() }}
                className={css.workspacePickButton}
              >
                <IconFolderOpenOutlineRegular size={16} />
                {pickingWorkspace ? '选择中…' : '选择文件夹'}
              </Button>
            </div>
          </Field>
        </div>
        <section className={css.cloneTeamMembers} aria-label="复制的团队成员">
          <div className={css.cloneTeamSectionHeader}>
            <strong>团队成员</strong>
            <span>{members.length} 人</span>
          </div>
          <div className={css.cloneTeamMemberGrid}>
            {members.map(member => (
              <div key={member.id} className={`${css.cloneTeamMember} ${member.role === 'leader' ? css.cloneTeamLeader : ''}`}>
                <span className={css.cloneTeamAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
                <span className={css.cloneTeamMemberCopy}>
                  <strong title={member.displayName}>{member.displayName}</strong>
                  <span>{member.assistantSnapshot.provider} / {member.assistantSnapshot.model}</span>
                </span>
                <span className={css.cloneTeamRole}>{member.role === 'leader' ? 'Leader' : '成员'}</span>
              </div>
            ))}
          </div>
        </section>
        <p className={css.cloneTeamNotice}>不会复制任务、对话上下文、消息历史或运行状态。</p>
        {error && <div role="alert" className={css.inlineError}>{error}</div>}
        <div className={css.cloneTeamActions}>
          <Button variant="outline" type="button" disabled={saving || pickingWorkspace} onClick={close}>取消</Button>
          <Button variant="primary" type="submit" disabled={saving || pickingWorkspace || !name.trim() || !workspaceId}>
            {saving ? '复制并启动中…' : '复制并启动'}
          </Button>
        </div>
      </form>
    </AnimatedModal>
  )
}

export function TeamCard({
  team,
  catalog,
  assistants,
  pickWorkspace,
  onChanged,
  onCloned,
  compact = false,
  headerActions,
  onOpenSession,
}: {
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onChanged: () => Promise<void>
  onCloned: (teamId: string) => Promise<void>
  compact?: boolean
  headerActions?: ReactNode
  /**
   * Follow the new Leader after a change. Optional: a host that cannot navigate
   * keeps the reload-only behaviour; the Leader Session is always reachable from
   * the sidebar.
   */
  onOpenSession?: (sessionId: string) => void
}): JSX.Element {
  const t = useTeamText()
  const [busy, setBusy] = useState(false)
  const [addingMember, setAddingMember] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [dissolveOpen, setDissolveOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [teamRenameOpen, setTeamRenameOpen] = useState(false)
  const [teamNameDraft, setTeamNameDraft] = useState(team.name)
  const [teamRenameBusy, setTeamRenameBusy] = useState(false)
  const [teamRenameError, setTeamRenameError] = useState<string>()
  const [announcementOpen, setAnnouncementOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<{ slotId: string; displayName: string }>()
  const [leaderTarget, setLeaderTarget] = useState<{ slotId: string; displayName: string }>()
  const [contextTarget, setContextTarget] = useState<{ slotId: string; displayName: string }>()
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const [checkpointNote, setCheckpointNote] = useState('')
  const [checkpointBusy, setCheckpointBusy] = useState(false)
  const [checkpointError, setCheckpointError] = useState<string>()
  const [checkpoints, setCheckpoints] = useState<TeamCheckpoint[]>([])
  /** Checkpoint armed for the second click; a handoff never runs on one click. */
  const [checkpointArmed, setCheckpointArmed] = useState<string>()
  const [renaming, setRenaming] = useState<{ slotId: string; draft: string }>()
  const [renameBusy, setRenameBusy] = useState(false)
  const [goalFilter, setGoalFilter] = useState<string>(GOAL_FILTER_ALL)
  const [error, setError] = useState<string>()
  const members = useMemo(() => {
    const ordered = team.memberOrder ?? Object.keys(team.members)
    const rank = new Map(ordered.map((id, index) => [id, index]))
    return Object.values(team.members).sort((left, right) =>
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.joinedAt.localeCompare(right.joinedAt))
  }, [team])
  const tasks = Object.values(team.tasks)
  const executing = isTeamExecuting(team)
  const goalsPresent = hasTeamGoals(team)
  const announcement = teamAnnouncementText(team.announcement)

  useEffect(() => {
    if (!goalsPresent) {
      setGoalFilter(GOAL_FILTER_ALL)
      return
    }
    const goalIds = new Set(Object.keys(team.goals ?? {}))
    if (goalFilter !== GOAL_FILTER_ALL && goalFilter !== GOAL_FILTER_UNGROUPED && !goalIds.has(goalFilter)) {
      setGoalFilter(GOAL_FILTER_ALL)
    }
  }, [goalFilter, goalsPresent, team.goals])

  async function dissolve(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('team.dissolve', { teamId: team.id, confirmation: team.name })
      setDissolveOpen(false)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function resetTeam(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('team.reset', { teamId: team.id, confirmation: team.name }, team.revision)
      setResetOpen(false)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function renameTeam(): Promise<void> {
    const name = teamNameDraft.trim()
    if (name.length === 0) {
      setTeamRenameError('团队名不能为空')
      return
    }
    setTeamRenameBusy(true)
    try {
      await callAgentTeam('team.rename', { teamId: team.id, name }, team.revision)
      setTeamRenameOpen(false)
      setTeamRenameError(undefined)
      await onChanged()
    } catch (cause) {
      setTeamRenameError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTeamRenameBusy(false)
    }
  }

  async function removeMember(): Promise<void> {
    if (memberToRemove === undefined) return
    setBusy(true)
    try {
      await callAgentTeam('team.removeMember', {
        teamId: team.id,
        slotId: memberToRemove.slotId,
      }, team.revision)
      setMemberToRemove(undefined)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function resetMemberContext(): Promise<void> {
    if (contextTarget === undefined) return
    setBusy(true)
    try {
      await callAgentTeam('team.member.contextReset', {
        teamId: team.id,
        slotId: contextTarget.slotId,
      }, team.revision)
      setContextTarget(undefined)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function loadCheckpoints(): Promise<void> {
    try {
      setCheckpoints(await callAgentTeam('team.checkpoint.list', { teamId: team.id }))
    } catch (cause) {
      setCheckpointError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function createCheckpoint(): Promise<void> {
    const invalid = checkpointNoteError(checkpointNote)
    if (invalid !== undefined) {
      setCheckpointError(invalid)
      return
    }
    setCheckpointBusy(true)
    try {
      const created = await callAgentTeam(
        'team.checkpoint.create',
        { teamId: team.id, note: checkpointNote.trim() },
        team.revision,
      )
      setCheckpoints(previous => [created, ...previous.filter(item => item.id !== created.id)])
      setCheckpointNote('')
      setCheckpointError(undefined)
    } catch (cause) {
      setCheckpointError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCheckpointBusy(false)
    }
  }

  async function handoffLeader(checkpointId: string): Promise<void> {
    if (checkpointArmed !== checkpointId) {
      setCheckpointArmed(checkpointId)
      setCheckpointError(undefined)
      return
    }
    setCheckpointBusy(true)
    try {
      const view = await callAgentTeam(
        'team.checkpoint.handoff',
        { teamId: team.id, checkpointId },
        team.revision,
      )
      setCheckpointOpen(false)
      setCheckpointArmed(undefined)
      setCheckpointError(undefined)
      await onChanged()
      // The retired Session is history; land the human in the fresh Leader Session.
      onOpenSession?.(view.sessionId)
    } catch (cause) {
      setCheckpointError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCheckpointBusy(false)
    }
  }

  async function reconnectMember(memberId: string): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('team.member.reconnect', {
        teamId: team.id,
        slotId: memberId,
      }, team.revision)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function moveMember(memberId: string, delta: -1 | 1): Promise<void> {
    const order = members.map(member => member.id)
    const from = order.indexOf(memberId)
    const to = from + delta
    if (from < 0 || to < 1 || to >= order.length) return
    const next = [...order]
    const [moved] = next.splice(from, 1)
    if (moved === undefined) return
    next.splice(to, 0, moved)
    setBusy(true)
    try {
      await callAgentTeam('team.members.reorder', { teamId: team.id, order: next }, team.revision)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  function startRename(member: TeamView['members'][string]): void {
    setError(undefined)
    setRenaming({ slotId: member.id, draft: member.displayName })
  }

  async function commitRename(): Promise<void> {
    if (renaming === undefined) return
    const member = team.members[renaming.slotId]
    if (member === undefined) {
      setRenaming(undefined)
      return
    }
    const displayName = renaming.draft.trim()
    if (displayName === '') {
      setError('成员名称不能为空')
      return
    }
    if (displayName === member.displayName) {
      setRenaming(undefined)
      return
    }
    setRenameBusy(true)
    try {
      await callAgentTeam('team.renameMember', {
        teamId: team.id,
        slotId: member.id,
        displayName,
      }, team.revision)
      setRenaming(undefined)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRenameBusy(false)
    }
  }

  async function changeLeader(): Promise<void> {
    if (leaderTarget === undefined || leaderTarget.slotId === team.leaderSlotId) return
    setBusy(true)
    try {
      const view = await callAgentTeam('team.changeLeader', {
        teamId: team.id,
        successorSlotId: leaderTarget.slotId,
      }, team.revision)
      setLeaderTarget(undefined)
      setError(undefined)
      await onChanged()
      // The old Session is history now; the human should land in the new
      // Leader's Session instead of a tab whose team views disappeared.
      const sessionId = view.members[view.leaderSlotId]?.sessionId
      if (sessionId !== undefined) onOpenSession?.(sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <article className={`${css.card} ${compact ? css.managementCard : ''}`}>
      <header className={css.teamCardHeader}>
        <div className={css.teamCardIdentity}>
          <strong className={css.teamCardName}>{team.name}</strong>
          <span className={css.teamCardWorkspace}>{team.workspacePath}</span>
        </div>
        <div className={css.teamCardHeaderTrailing}>
          {epochOf(team) > 1 && (
            <span className={css.badge}>{t('epoch.tag', { epoch: epochOf(team) })}</span>
          )}
          {executing && <span className={`${css.badge} ${css.badgeSuccess ?? ''}`}>任务执行中</span>}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => { setAnnouncementOpen(true) }}
          >
            {announcement === '' ? '添加公告' : '编辑公告'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setTeamNameDraft(team.name)
              setTeamRenameError(undefined)
              setTeamRenameOpen(true)
            }}
          >
            重命名
          </Button>
          {headerActions}
        </div>
      </header>

      <TeamAnnouncementSection announcement={team.announcement} />

      <section className={css.teamMemberSection} aria-label="团队成员">
        <div className={css.teamSectionHeader}>
          <strong>团队成员</strong>
          <span className={css.teamSectionActions}>
            <span>{members.length} 人</span>
            <button
              type="button"
              className={css.addMemberButton}
              disabled={busy}
              onClick={() => { setAddingMember(true) }}
            >
              <IconPlusOutlineRegular size={14} />
              添加助手
            </button>
          </span>
        </div>
        <div className={css.memberGrid}>
          {members.map((member, index) => (
            <div key={member.id} className={`${css.memberTile} ${member.role === 'leader' ? css.memberTileLeader : ''}`}>
              <span className={css.memberTileAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
              <span className={css.memberTileCopy}>
                {renaming?.slotId === member.id
                  ? (
                      <form
                        className={css.memberRenameForm}
                        onSubmit={event => { event.preventDefault(); void commitRename() }}
                      >
                        <Input
                          autoFocus
                          value={renaming.draft}
                          disabled={renameBusy}
                          aria-label={`${t('member.rename')} ${member.displayName}`}
                          onChange={event => { setRenaming({ slotId: member.id, draft: event.target.value }) }}
                          onKeyDown={event => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              setRenaming(undefined)
                            }
                          }}
                          className={css.memberRenameInput ?? ''}
                        />
                      </form>
                    )
                  : (
                      <span
                        className={css.memberTileName}
                        title={`${member.displayName} · 双击重命名`}
                        onDoubleClick={() => { startRename(member) }}
                      >
                        {member.displayName}
                      </span>
                    )}
                <span className={css.memberRuntime}>
                  <span className={`${css.statusDot} ${member.lastRuntimeState === 'running' ? css.statusRunning : css.statusIdle}`} />
                  {memberStatusLabel(member.lastRuntimeState)}
                </span>
              </span>
              <span className={css.memberTileTools}>
                <button
                  type="button"
                  className={css.memberEditButton}
                  aria-label={`重命名 ${member.displayName}`}
                  title={t('member.rename')}
                  disabled={busy || renameBusy}
                  onClick={() => { startRename(member) }}
                >
                  <IconEditOutlineRegular size={13} />
                </button>
                {member.role !== 'leader' && (
                  <>
                    <button
                      type="button"
                      className={css.memberRoleAction}
                      disabled={busy || renameBusy || index <= 1}
                      aria-label={`${t('member.up')} ${member.displayName}`}
                      onClick={() => { void moveMember(member.id, -1) }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={css.memberRoleAction}
                      disabled={busy || renameBusy || index === members.length - 1}
                      aria-label={`${t('member.down')} ${member.displayName}`}
                      onClick={() => { void moveMember(member.id, 1) }}
                    >
                      ↓
                    </button>
                  </>
                )}
              </span>
              <span className={css.memberTileActions}>
                <button
                  type="button"
                  className={css.memberRoleAction}
                  disabled={busy || renameBusy}
                  title={t('member.reconnect')}
                  onClick={() => { void reconnectMember(member.id) }}
                >
                  {t('member.reconnect')}
                </button>
                {member.role !== 'leader' && (
                  <button
                    type="button"
                    className={css.memberRoleAction}
                    disabled={busy || renameBusy}
                    title={t('member.resetContext')}
                    onClick={() => { setContextTarget({ slotId: member.id, displayName: member.displayName }) }}
                  >
                    {t('member.resetContext')}
                  </button>
                )}
                {member.role === 'leader' && (
                  <button
                    type="button"
                    className={css.memberRoleAction}
                    disabled={busy || renameBusy || team.state === 'draft'}
                    title="为 Leader 换一段新会话，保留团队、任务、Goal 与团队记忆"
                    onClick={() => {
                      setError(undefined)
                      setCheckpointError(undefined)
                      setCheckpointArmed(undefined)
                      setCheckpointOpen(true)
                      void loadCheckpoints()
                    }}
                  >
                    交接新会话
                  </button>
                )}
                {member.role === 'leader'
                  ? <span className={`${css.memberRole} ${css.memberRoleLeader}`}>{t('member.leader')}</span>
                  : <button
                    type="button"
                    className={`${css.memberRole} ${css.memberRoleAction}`}
                    disabled={busy || renameBusy}
                    onClick={() => {
                      setError(undefined)
                      setLeaderTarget({ slotId: member.id, displayName: member.displayName })
                    }}
                  >
                    {t('member.setLeader')}
                  </button>}
                {member.id !== team.leaderSlotId && (
                  <button
                    type="button"
                    className={css.memberRemoveButton}
                    disabled={busy || renameBusy}
                    onClick={() => {
                      setError(undefined)
                      setMemberToRemove({ slotId: member.id, displayName: member.displayName })
                    }}
                  >
                    移出
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>
      {goalsPresent && (
        <GoalSummary team={team} selected={goalFilter} onSelect={setGoalFilter} />
      )}
      <section className={css.teamMemberSection} aria-label="用量" data-dsh-team-usage>
        <div className={css.teamSectionHeader}>
          <strong>用量</strong>
          <span className={css.teamSectionActions}>
            <span>只读 · 来自宿主会话投影</span>
          </span>
        </div>
        <UsageSection
          scope={teamUsageScope(team)}
          emptyHint="团队还没有会话用量"
          // The manager dialog must close before the Session opens; that
          // ordering belongs to the host that owns the modal.
          {...(onOpenSession === undefined ? {} : { onOpenSession })}
        />
      </section>
      <TeamMemorySection team={team} onChanged={onChanged} />
      <div className={`${css.contextResetPanel} ${css.cloneTeamPanel ?? ''}`}>
        <div className={css.contextResetCopy}>
          <strong>复制团队</strong>
          <span>复用当前成员和配置，为所有成员创建全新 Session。</span>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setError(undefined)
            setCloneOpen(true)
          }}
        >
          复制团队
        </Button>
      </div>
      {goalsPresent
        ? <GoalTaskBoard team={team} filter={goalFilter} onFilterChange={setGoalFilter} />
        : tasks.length > 0 && (
            <div className={css.taskList}>
              <strong className={css.taskTitle}>任务板</strong>
              {tasks.map(task => (
                <div key={task.id} className={css.memberRow}>
                  <span>{task.title}</span>
                  <span className={css.muted}>{TASK_STATE_LABELS[task.status] ?? task.status}{task.ownerSlotId ? ` · ${team.members[task.ownerSlotId]?.displayName ?? '已移除成员'}` : ''}</span>
                </div>
              ))}
            </div>
          )}
      {team.state !== 'deleting' && team.state !== 'delete_blocked' && (
        <div className={css.contextResetPanel}>
          <div className={css.contextResetCopy}>
            <strong>清空任务与上下文</strong>
            <span>停止所有成员并清空任务板，为每位成员换用全新 Session。Workspace 文件和团队配置不变。</span>
          </div>
          <button
            type="button"
            className={css.dangerButton}
            disabled={busy}
            onClick={() => {
              setError(undefined)
              setResetOpen(true)
            }}
          >
            {busy ? '处理中…' : '清空'}
          </button>
        </div>
      )}
      <div className={`${css.contextResetPanel} ${css.dissolvePanel}`}>
        <div className={css.contextResetCopy}>
          <strong>解散团队</strong>
          <span>永久删除团队、任务和团队消息；助手模板与 Workspace 文件保留，旧 Session 日志不再恢复。</span>
        </div>
        <button
          type="button"
          className={css.dangerButton}
          disabled={busy || team.state === 'deleting'}
          onClick={() => {
            setError(undefined)
            setDissolveOpen(true)
          }}
        >
          {team.state === 'deleting' ? '解散中…' : team.state === 'delete_blocked' ? '重试解散' : '解散团队'}
        </button>
      </div>
        {error && !dissolveOpen && !resetOpen && memberToRemove === undefined && <div role="alert" className={css.inlineError}>{error}</div>}
      </article>
      <AddTeamMemberDialog
        open={addingMember}
        team={team}
        catalog={catalog}
        assistants={assistants}
        onClose={() => { setAddingMember(false) }}
        onChanged={onChanged}
      />
      <CloneTeamDialog
        open={cloneOpen}
        team={team}
        catalog={catalog}
        pickWorkspace={pickWorkspace}
        onClose={() => { setCloneOpen(false) }}
        onCreated={onCloned}
      />
      <AnimatedModal
        open={memberToRemove !== undefined}
        onClose={() => {
          if (busy) return
          setMemberToRemove(undefined)
          setError(undefined)
        }}
        title="移出团队成员"
        closeLabel="关闭"
        description="该成员将停止参与当前团队。"
        className={css.memberRemoveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setMemberToRemove(undefined)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void removeMember() }}
            >
              {busy ? '移出中…' : '确认移出'}
            </button>
          </>
        )}
      >
        <div className={css.memberRemoveConfirm}>
          <div className={css.memberRemoveIcon} aria-hidden="true">−</div>
          <div>
            <strong>确定移出“{memberToRemove?.displayName}”？</strong>
            <p>该成员将停止参与团队；若仍有未完成任务，系统会阻止移出。助手模板和 Session 历史都会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={resetOpen}
        onClose={() => {
          if (busy) return
          setResetOpen(false)
          setError(undefined)
        }}
        title="清空任务与上下文"
        closeLabel="关闭"
        className={css.teamResetDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setResetOpen(false)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void resetTeam() }}
            >
              {busy ? t('context.busy') : t('context.confirm')}
            </button>
          </>
        )}
      >
        <div className={css.teamResetConfirm}>
          <div className={css.teamResetIcon} aria-hidden="true">↻</div>
          <div>
            <strong>确定清空“{team.name}”的任务与上下文？</strong>
            <p>所有成员会停止，任务板和待处理消息会被清空，并换用全新 Session。Workspace 文件、团队配置和旧 Session 日志会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={contextTarget !== undefined}
        onClose={() => {
          if (busy) return
          setContextTarget(undefined)
          setError(undefined)
        }}
        title={t('context.title')}
        closeLabel="关闭"
        description={t('context.description')}
        className={css.teamResetDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setContextTarget(undefined)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void resetMemberContext() }}
            >
              {busy ? '清空中…' : '确认清空'}
            </button>
          </>
        )}
      >
        <div className={css.teamResetConfirm}>
          <div className={css.teamResetIcon} aria-hidden="true">↻</div>
          <div>
            <strong>{t('context.confirmTitle', { name: contextTarget?.displayName ?? '' })}</strong>
            <p>{t('context.body')}</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={leaderTarget !== undefined}
        onClose={() => {
          if (busy) return
          setLeaderTarget(undefined)
          setError(undefined)
        }}
        title={t('leaderChange.title')}
        closeLabel="关闭"
        description={t('leaderChange.description')}
        className={css.teamResetDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setLeaderTarget(undefined)
                setError(undefined)
              }}
            >
              {t('common.cancel')}
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void changeLeader() }}
            >
              {busy ? t('leaderChange.busy') : t('leaderChange.confirm')}
            </button>
          </>
        )}
      >
        <div className={css.teamResetConfirm}>
          <div className={css.teamResetIcon} aria-hidden="true">⇄</div>
          <div>
            <strong>{t('leaderChange.confirmTitle', { name: leaderTarget?.displayName ?? '' })}</strong>
            <p>{t('leaderChange.body')}</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={checkpointOpen}
        onClose={() => {
          if (checkpointBusy) return
          setCheckpointOpen(false)
          setCheckpointArmed(undefined)
          setCheckpointError(undefined)
        }}
        title="交接 Leader 新会话"
        closeLabel="关闭"
        description="为当前 Leader 换一段全新的 Team Session：团队、成员、Leader、epoch、任务与 attempt、Goal、团队记忆和 Workspace 都保持不变，旧 Session 只退役不删除。"
        className={css.teamResetDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={checkpointBusy}
              onClick={() => {
                setCheckpointOpen(false)
                setCheckpointArmed(undefined)
                setCheckpointError(undefined)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={checkpointBusy || checkpointNoteError(checkpointNote) !== undefined}
              onClick={() => { void createCheckpoint() }}
            >
              {checkpointBusy ? '生成中…' : '生成检查点'}
            </Button>
          </>
        )}
      >
        <div className={css.teamResetConfirm}>
          <div>
            <strong>交接说明（可选，最多 4000 字）</strong>
            <textarea
              className={css.input}
              value={checkpointNote}
              maxLength={4000}
              rows={3}
              placeholder="告诉接手的新会话要接着做什么"
              onChange={event => { setCheckpointNote(event.target.value) }}
            />
            <p>检查点只包含确定性事实：近期可见消息、进行中的任务与 Goal、成员邮件。不会调用模型生成总结。</p>
            {checkpoints.length === 0
              ? <p className={css.muted}>还没有检查点。先生成一个，再确认交接。</p>
              : (
                <div className={css.taskList}>
                  <strong className={css.taskTitle}>可交接的检查点</strong>
                  {checkpoints.map(checkpoint => (
                    <div key={checkpoint.id} className={css.memberRow}>
                      <span>
                        {checkpoint.title} · {teamCheckpointStatusLabel(checkpoint.status)}
                        <span className={css.muted}> · {teamCheckpointSummary(checkpoint)}</span>
                      </span>
                      <button
                        type="button"
                        className={css.memberRoleAction}
                        disabled={checkpointBusy || checkpoint.status !== 'ready'}
                        onClick={() => { void handoffLeader(checkpoint.id) }}
                      >
                        {checkpoint.status !== 'ready'
                          ? teamCheckpointStatusLabel(checkpoint.status)
                          : checkpointArmed === checkpoint.id ? '确认交接' : '交接新会话'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
          </div>
          {checkpointError && <div role="alert" className={css.inlineError}>{checkpointError}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={dissolveOpen}
        onClose={() => {
          if (busy) return
          setDissolveOpen(false)
          setError(undefined)
        }}
        title="解散团队"
        closeLabel="关闭"
        description="此操作无法撤销。"
        className={css.teamDissolveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDissolveOpen(false)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void dissolve() }}
            >
              {busy ? '解散中…' : '确认解散'}
            </button>
          </>
        )}
      >
        <div className={css.teamDissolveConfirm}>
          <div className={css.teamDissolveIcon} aria-hidden="true">!</div>
          <div>
            <strong>确定解散“{team.name}”？</strong>
            <p>所有成员将停止，团队任务、消息和配置会被永久删除。助手模板与 Workspace 文件会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={teamRenameOpen}
        onClose={() => {
          if (teamRenameBusy) return
          setTeamRenameOpen(false)
          setTeamRenameError(undefined)
        }}
        title="重命名团队"
        closeLabel="关闭"
        description="只修改团队显示名，成员、会话、任务与 Workspace 都不变。"
        footer={(
          <>
            <Button
              variant="outline"
              disabled={teamRenameBusy}
              onClick={() => {
                setTeamRenameOpen(false)
                setTeamRenameError(undefined)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={`dsh-team-rename-${team.id}`}
              disabled={teamRenameBusy}
            >
              {teamRenameBusy ? '保存中…' : '保存'}
            </Button>
          </>
        )}
      >
        <form
          id={`dsh-team-rename-${team.id}`}
          onSubmit={event => { event.preventDefault(); void renameTeam() }}
        >
          <Field label="团队名">
            <Input
              autoFocus
              value={teamNameDraft}
              disabled={teamRenameBusy}
              maxLength={80}
              onChange={event => { setTeamNameDraft(event.target.value) }}
            />
          </Field>
        </form>
        {teamRenameError && <div role="alert" className={css.inlineError}>{teamRenameError}</div>}
      </AnimatedModal>
      {announcementOpen && (
        <TeamAnnouncementDialog
          team={team}
          onClose={() => { setAnnouncementOpen(false) }}
          onChanged={onChanged}
        />
      )}
    </>
  )
}

/**
 * The user-only announcement editor. It mounts per open, so the draft always
 * starts from the stored text; the explicit save is the only write, and the
 * aggregate reload is what gives the next member turn the new text (the prompt
 * layer reads the aggregate, not this component). There is deliberately no
 * revision fence: like the sidebar group brief, the last user save wins.
 */
export function TeamAnnouncementDialog({
  team,
  onClose,
  onChanged,
}: {
  team: TeamView
  onClose: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const initial = teamAnnouncementText(team.announcement)
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const fieldId = `dsh-team-announcement-${team.id}`
  const hintId = `${fieldId}-hint`
  const overLimit = teamAnnouncementError(value)
  const dirty = value.trim() !== initial
  const canSave = !busy && dirty && overLimit === undefined

  async function write(announcement: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await callAgentTeam('team.announcement.set', { teamId: team.id, announcement })
      // Reload before closing: the card, and the next member prompt, both read
      // this aggregate.
      await onChanged()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatedModal
      open
      onClose={() => { if (!busy) onClose() }}
      title="团队公告"
      description="写一段全队长期有效的约定。每位成员（含 Leader）的下一轮对话都会读到它；只有你能编辑，Agent 没有写入入口。"
      closeLabel="关闭"
      footer={(
        <>
          <Button variant="outline" type="button" disabled={busy} onClick={onClose}>
            取消
          </Button>
          {initial !== '' && (
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => { void write('') }}
            >
              {busy ? '处理中…' : '清除公告'}
            </Button>
          )}
          <Button
            variant="primary"
            type="button"
            disabled={!canSave}
            onClick={() => { void write(value) }}
          >
            {busy ? '保存中…' : '保存公告'}
          </Button>
        </>
      )}
    >
      <div className={css.memoryForm}>
        <div className={css.sidebarGroupBriefHead}>
          <label className={css.sidebarGroupBriefLabel} htmlFor={fieldId}>公告内容</label>
          <span
            className={`${css.sidebarGroupBriefCount} ${overLimit === undefined ? '' : css.sidebarGroupBriefCountOver}`}
            data-dsh-team-announcement-count
          >
            {teamAnnouncementUsage(value)}
          </span>
        </div>
        <textarea
          id={fieldId}
          className={`${css.input} ${css.memoryTextarea}`}
          data-modal-autofocus
          data-dsh-team-announcement-input
          rows={8}
          value={value}
          placeholder="写下全队都要遵守的长期约定，例如：冻结期只提交修复。"
          aria-label="团队公告"
          aria-describedby={hintId}
          aria-invalid={overLimit !== undefined}
          disabled={busy}
          onChange={event => { setValue(event.target.value) }}
        />
        <p id={hintId} className={css.sidebarGroupBriefHint}>
          留空保存会清除公告；最多 {TEAM_ANNOUNCEMENT_UI_LIMIT.toLocaleString('en-US')} 个字符，超出时不会截断，而是拒绝保存。
        </p>
        {overLimit !== undefined && <div role="alert" className={css.inlineError}>{overLimit}</div>}
        {error !== undefined && <div role="alert" className={css.inlineError}>{error}</div>}
      </div>
    </AnimatedModal>
  )
}

const DEPENDENCY_PREVIEW = 3

function progressPercent(group: GoalTaskGroup): number {
  return Math.round(group.completionRate * 100)
}

function taskCountLabel(group: GoalTaskGroup): string {
  const parts = [`${group.total} 项任务`, `完成 ${group.completed}`]
  if (group.running > 0) parts.push(`进行中 ${group.running}`)
  if (group.assigned > 0) parts.push(`待启动 ${group.assigned}`)
  if (group.blocked > 0) parts.push(`阻塞 ${group.blocked}`)
  if (group.failed > 0) parts.push(`失败 ${group.failed}`)
  return parts.join(' · ')
}

/**
 * Goal cards sit above the team card's task board. Clicking one sets the filter
 * shared with GoalTaskBoard, so the card and chips always select the same view.
 * Only real goals are counted: the synthetic ungrouped bucket belongs to the
 * task board, never to this header or its render limit.
 */
export function GoalSummary({
  team,
  selected,
  onSelect,
}: {
  team: TeamView
  selected: string
  onSelect: (filter: string) => void
}): JSX.Element | null {
  const groups = useMemo(
    () => teamGoalGroups(team).filter(group => group.goal !== undefined),
    [team],
  )
  const [limit, setLimit] = useState(GOAL_CARD_RENDER_LIMIT)
  if (groups.length === 0) return null
  const visible = groups.slice(0, limit)
  return (
    <section className={css.goalSummary} aria-label="团队目标">
      <div className={css.goalSummaryHeader}>
        <strong>目标</strong>
        <span>{groups.length} 个 · 点击目标筛选任务</span>
      </div>
      <div className={css.goalCardRow}>
        {visible.map(group => {
          const goal = group.goal!
          const percent = progressPercent(group)
          return (
            <button
              key={group.id}
              type="button"
              className={[
                css.goalCard,
                selected === group.id ? css.goalCardSelected : '',
                goal.status === 'cancelled' ? css.goalCardCancelled : '',
              ].filter(Boolean).join(' ')}
              aria-pressed={selected === group.id}
              title={goal.objective}
              onClick={() => { onSelect(group.id) }}
            >
              <span className={css.goalCardTop}>
                <strong>{goal.title}</strong>
                <span className={css.goalModeBadge}>{goalModeLabel(goal.mode)}</span>
              </span>
              <span className={css.goalCardObjective}>{goal.objective}</span>
              {goal.acceptance.trim() !== '' && (
                <span className={css.goalCardAcceptance}>验收：{goal.acceptance}</span>
              )}
              <span className={css.goalProgressRow}>
                <span>{taskCountLabel(group)}</span>
                <span>{percent}%</span>
              </span>
              <span className={css.goalProgressTrack} aria-hidden="true">
                <span className={css.goalProgressFill} style={{ width: `${percent}%` }} />
              </span>
              {goal.status !== 'active' && (
                <span className={`${css.goalStatusBadge} ${
                  goal.status === 'cancelled' || goal.status === 'paused' ? css.goalStatusBadgeMuted : ''
                }`}>
                  {goalStatusLabel(goal.status)}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {groups.length > visible.length && (
        <button
          type="button"
          className={css.goalMoreButton}
          onClick={() => { setLimit(current => current + GOAL_CARD_RENDER_LIMIT) }}
        >
          显示更多目标（还有 {groups.length - visible.length} 个）
        </button>
      )}
    </section>
  )
}

/**
 * Goal-grouped task board with dependency state. Filter state is owned by the
 * live team card so a Goal card click and the board chips select the same view.
 */
export function GoalTaskBoard({
  team,
  filter,
  onFilterChange,
}: {
  team: TeamView
  filter: string
  onFilterChange: (filter: string) => void
}): JSX.Element {
  const groups = useMemo(() => teamGoalGroups(team), [team])
  const visibleGroups = filterGoalGroups(groups, filter)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const filterable = groups.filter(group => group.goal !== undefined)
  const ungrouped = groups.find(group => group.goal === undefined)

  function toggleExpanded(groupId: string): void {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  return (
    <div className={css.goalTaskBoard}>
      <div className={css.goalFilterRow} role="group" aria-label="按目标筛选任务">
        <button
          type="button"
          className={`${css.goalFilterChip} ${filter === GOAL_FILTER_ALL ? css.goalFilterChipActive : ''}`}
          aria-pressed={filter === GOAL_FILTER_ALL}
          onClick={() => { onFilterChange(GOAL_FILTER_ALL) }}
        >
          全部任务
        </button>
        {filterable.map(group => (
          <button
            key={group.id}
            type="button"
            className={`${css.goalFilterChip} ${filter === group.id ? css.goalFilterChipActive : ''}`}
            aria-pressed={filter === group.id}
            onClick={() => { onFilterChange(group.id) }}
          >
            {group.goal?.title}
          </button>
        ))}
        {ungrouped !== undefined && (
          <button
            type="button"
            className={`${css.goalFilterChip} ${filter === ungrouped.id ? css.goalFilterChipActive : ''}`}
            aria-pressed={filter === ungrouped.id}
            onClick={() => { onFilterChange(ungrouped.id) }}
          >
            未归入目标 · {ungrouped.total}
          </button>
        )}
      </div>
      {visibleGroups.length === 0
        ? <p className={css.goalEmpty}>该目标下暂无任务。</p>
        : visibleGroups.map(group => {
            const expandedGroup = expanded.has(group.id)
            const tasks = expandedGroup ? group.tasks : group.tasks.slice(0, GOAL_TASK_RENDER_LIMIT)
            return (
              <section key={group.id} className={css.goalTaskGroup} aria-label={group.goal?.title ?? '未归入目标'}>
                <div className={css.goalTaskGroupHeader}>
                  <span className={css.goalTaskGroupTitle}>
                    <strong>{group.goal?.title ?? '未归入目标'}</strong>
                    {group.goal !== undefined && (
                      <span className={css.goalModeBadge}>{goalModeLabel(group.goal.mode)}</span>
                    )}
                    {group.goal !== undefined && group.goal.status !== 'active' && (
                      <span className={`${css.goalStatusBadge} ${
                        group.goal.status === 'cancelled' || group.goal.status === 'paused'
                          ? css.goalStatusBadgeMuted
                          : ''
                      }`}>
                        {goalStatusLabel(group.goal.status)}
                      </span>
                    )}
                  </span>
                  <span className={css.goalTaskGroupMeta}>{taskCountLabel(group)}</span>
                </div>
                {group.goal !== undefined && group.goal.acceptance.trim() !== '' && (
                  <p className={css.goalAcceptanceLine}>验收：{group.goal.acceptance}</p>
                )}
                {tasks.length === 0
                  ? <p className={css.goalEmpty}>还没有任务。</p>
                  : tasks.map(task => (
                      <GoalTaskRow key={task.id} team={team} task={task} />
                    ))}
                {group.tasks.length > tasks.length && (
                  <button
                    type="button"
                    className={css.goalMoreButton}
                    onClick={() => { toggleExpanded(group.id) }}
                  >
                    显示更多任务（还有 {group.tasks.length - tasks.length} 项）
                  </button>
                )}
                {expandedGroup && group.tasks.length > GOAL_TASK_RENDER_LIMIT && (
                  <button
                    type="button"
                    className={css.goalMoreButton}
                    onClick={() => { toggleExpanded(group.id) }}
                  >
                    收起任务
                  </button>
                )}
              </section>
            )
          })}
      <p className={css.overviewDetailHint}>{TEAM_TASK_CREATE_HINT}</p>
    </div>
  )
}

function GoalTaskRow({ team, task }: { team: TeamView; task: TeamTask }): JSX.Element {
  const dependencies = taskDependencyView(team, task)
  const waitingNames = dependencies.waitingOn
    .slice(0, DEPENDENCY_PREVIEW)
    .map(item => item.title)
    .join('、')
  const waitingLabel = dependencies.waitingOn.length > DEPENDENCY_PREVIEW
    ? `${waitingNames} 等 ${dependencies.waitingOn.length} 项`
    : waitingNames
  const verdictLabel = taskVerdictLabel(task)
  const schedule = taskScheduleSummary(task)
  return (
    <div className={css.taskBoardRow}>
      <div className={css.taskBoardRowMain}>
        <span className={css.goalTaskTitleLine}>
          <strong>{task.title}</strong>
          {task.kind !== undefined && <span className={css.muted}>{taskKindLabel(task.kind)}</span>}
          {verdictLabel !== undefined && (
            <span className={css.overviewVerdict} data-tone={taskVerdictTone(task)}>{verdictLabel}</span>
          )}
          {dependencies.isBlocked && <span className={css.goalBlockedBadge}>阻塞</span>}
        </span>
        {task.description !== '' && <span className={css.taskBoardDescription}>{task.description}</span>}
        {task.acceptance !== undefined && task.acceptance.trim() !== '' && (
          <span className={css.taskBoardDescription}>验收：{task.acceptance}</span>
        )}
        {schedule !== '' && <span className={css.taskScheduleLine} title={schedule}>{schedule}</span>}
        {(dependencies.waitingOn.length > 0 || dependencies.blocks.length > 0) && (
          <span className={css.goalDependencyRow}>
            {dependencies.waitingOn.length > 0 && (
              <span
                className={`${css.goalDependencyChip} ${css.goalDependencyChipWait}`}
                title={dependencies.waitingOn.map(item => `${item.title}${item.status === 'completed' ? '' : `（${TASK_STATE_LABELS[item.status] ?? item.status}）`}`).join('\n')}
              >
                等待依赖：{waitingLabel}
              </span>
            )}
            {dependencies.blocks.length > 0 && (
              <span
                className={css.goalDependencyChip}
                title={dependencies.blocks.map(item => item.title).join('\n')}
              >
                阻塞 {dependencies.blocks.length} 项后续任务
              </span>
            )}
          </span>
        )}
      </div>
      <div className={css.taskBoardRowMeta}>
        <span className={`${css.taskBoardStatus} ${task.status === 'completed' ? css.taskBoardStatusDone : ''}`}>
          {TASK_STATE_LABELS[task.status] ?? task.status}
        </span>
        <span className={css.muted}>
          {task.ownerSlotId ? team.members[task.ownerSlotId]?.displayName ?? '已移除成员' : '未分配'}
        </span>
      </div>
    </div>
  )
}

function memoryErrorMessage(cause: unknown): string {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause
    ? (cause as { code?: unknown }).code
    : undefined
  if (code === 'MEMORY_REVISION_CONFLICT') return '团队记忆已被其他操作更新，请刷新后重试。'
  if (code === 'MEMORY_UNDO_STALE') return '团队记忆已更新，请刷新后重试撤销。'
  if (code === 'MEMORY_UNDO_UNAVAILABLE') return '这条变更无法安全撤销（快照已脱敏、截断或会与现有键冲突）。'
  return cause instanceof Error ? cause.message : String(cause)
}

function memoryTime(value: string): string {
  return value.slice(0, 16).replace('T', ' ')
}

/**
 * One renderer for a structured memory entry lives in `memory-entry-card.tsx`
 * and is imported by both the team panel and the assistant memory panel. This
 * re-export keeps the existing team-panel import path working.
 */
export { MemoryEntryCard } from '../memory-entry-card.js'

/**
 * Team memory lives inside the team aggregate, so the panel renders straight
 * from `team.memory` and refetches through `onChanged` after every mutation.
 * Only team-safe team entries reach the view (see `teamMemoryView`); private
 * assistant memory has no path into this component.
 */
function TeamMemorySection({
  team,
  onChanged,
}: {
  team: TeamView
  onChanged: () => Promise<void>
}): JSX.Element {
  const memory = team.memory
  const view = useMemo(() => teamMemoryView(memory), [memory])
  const [draft, setDraft] = useState<{ id?: string; title: string; body: string; key: string }>()
  const [saving, setSaving] = useState(false)
  const [deciding, setDeciding] = useState<string>()
  const [undoing, setUndoing] = useState<string>()
  const [error, setError] = useState<string>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const journal = memory?.journal ?? []

  async function save(): Promise<void> {
    if (draft === undefined || saving) return
    const title = draft.title.trim()
    if (title === '') {
      setError('记忆标题不能为空。')
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await callAgentTeam('team.memory.write', {
        teamId: team.id,
        expectedMemoryRevision: view.revision,
        value: {
          ...(draft.id === undefined ? {} : { id: draft.id }),
          ...(draft.key.trim() === '' ? {} : { key: draft.key.trim() }),
          title,
          body: draft.body,
        },
      })
      setDraft(undefined)
      await onChanged()
    } catch (cause) {
      setError(memoryErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  async function decide(entryId: string, decision: 'accept' | 'reject'): Promise<void> {
    if (deciding !== undefined) return
    setDeciding(entryId)
    setError(undefined)
    try {
      await callAgentTeam('team.memory.decide', {
        teamId: team.id,
        entryId,
        expectedMemoryRevision: view.revision,
        decision,
      })
      await onChanged()
    } catch (cause) {
      setError(memoryErrorMessage(cause))
    } finally {
      setDeciding(undefined)
    }
  }

  async function undo(journalId: string): Promise<void> {
    if (undoing !== undefined || saving || deciding !== undefined) return
    setUndoing(journalId)
    setError(undefined)
    try {
      await callAgentTeam('team.memory.undo', {
        teamId: team.id,
        journalId,
        expectedMemoryRevision: view.revision,
      })
      await onChanged()
    } catch (cause) {
      setError(memoryErrorMessage(cause))
    } finally {
      setUndoing(undefined)
    }
  }

  return (
    <section className={css.teamMemorySection} aria-label="团队记忆">
      <div className={css.teamSectionHeader}>
        <strong>团队记忆</strong>
        <span className={css.teamSectionActions}>
          <span>版本 {view.revision}</span>
          <button
            type="button"
            className={css.addMemberButton}
            disabled={saving || draft !== undefined}
            onClick={() => {
              setError(undefined)
              setDraft({ title: '', body: '', key: '' })
            }}
          >
            <IconPlusOutlineRegular size={14} />
            添加记忆
          </button>
        </span>
      </div>
      {error !== undefined && <div role="alert" className={css.inlineError}>{error}</div>}
      {view.empty && draft === undefined && (
        <p className={css.memoryEmpty}>还没有团队记忆。成员可以提案，Leader 或你可以直接写入。</p>
      )}
      {view.proposed.length > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>待确认提案 · {view.proposed.length}</strong>
          {view.proposed.map(entry => (
            <MemoryEntryCard
              key={entry.id}
              entry={entry}
              actions={(
                <span className={css.memoryEntryActions}>
                  <button
                    type="button"
                    className={css.memoryAction}
                    disabled={deciding !== undefined}
                    onClick={() => { void decide(entry.id, 'accept') }}
                  >
                    {deciding === entry.id ? '处理中…' : '接受'}
                  </button>
                  <button
                    type="button"
                    className={css.memoryAction}
                    disabled={deciding !== undefined}
                    onClick={() => { void decide(entry.id, 'reject') }}
                  >
                    驳回
                  </button>
                </span>
              )}
            />
          ))}
        </div>
      )}
      {view.active.length > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>生效记忆 · {view.active.length}</strong>
          {view.active.map(entry => (
            <MemoryEntryCard
              key={entry.id}
              entry={entry}
              actions={(
                <button
                  type="button"
                  className={css.memoryAction}
                  disabled={saving || deciding !== undefined}
                  onClick={() => {
                    setError(undefined)
                    setDraft({
                      id: entry.id,
                      title: entry.title,
                      body: entry.body,
                      key: entry.key ?? '',
                    })
                  }}
                >
                  编辑
                </button>
              )}
            />
          ))}
        </div>
      )}
      {view.historyTotal > 0 && (
        <div className={css.memoryGroup}>
          <button
            type="button"
            className={css.memoryHistoryToggle}
            aria-expanded={historyOpen}
            onClick={() => { setHistoryOpen(open => !open) }}
          >
            <IconChevronDownOutlineRegular size={13} />
            历史记录 · {view.historyTotal}
          </button>
          {historyOpen && (
            <>
              {view.history.map(entry => <MemoryEntryCard key={entry.id} entry={entry} />)}
              {view.historyTotal > view.history.length && (
                <p className={css.memoryEmpty}>仅显示最近 {view.history.length} 条历史记录。</p>
              )}
            </>
          )}
        </div>
      )}
      {journal.length > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>变更日志 · {journal.length}</strong>
          {[...journal].reverse().map(record => {
            const blocked = record.redacted === true || record.trimmed === true
            return (
              <article key={record.id} className={css.memoryEntryCard}>
                <div className={css.memoryEntryHeader}>
                  <strong>{record.after?.title ?? record.before?.title ?? record.entryId}</strong>
                  <span className={css.memoryBadges}>
                    <span className={css.memoryBadge}>{memoryJournalActionLabel(record.action)}</span>
                    <span className={css.memoryBadge}>{memorySourceLabel(record.actor)}</span>
                    <span className={css.memoryBadge}>{memoryTime(record.at)}</span>
                  </span>
                </div>
                <div className={css.memoryEntryMeta}>
                  <span>{record.reason}</span>
                  <span className={css.memoryEntryActions}>
                    <button
                      type="button"
                      className={css.memoryAction}
                      disabled={blocked || saving || deciding !== undefined || undoing !== undefined}
                      title={blocked ? '快照已脱敏或截断，无法安全撤销' : undefined}
                      onClick={() => { void undo(record.id) }}
                    >
                      {undoing === record.id ? '撤销中…' : '撤销'}
                    </button>
                  </span>
                </div>
              </article>
            )
          })}
        </div>
      )}
      {draft !== undefined && (
        <form
          className={css.memoryForm}
          onSubmit={event => { event.preventDefault(); void save() }}
        >
          <Field label="标题">
            <Input
              value={draft.title}
              maxLength={200}
              disabled={saving}
              onChange={event => { setDraft({ ...draft, title: event.target.value }) }}
            />
          </Field>
          <Field label="内容">
            <textarea
              className={`${css.input} ${css.memoryTextarea}`}
              value={draft.body}
              rows={3}
              maxLength={4_000}
              disabled={saving}
              onChange={event => { setDraft({ ...draft, body: event.target.value }) }}
            />
          </Field>
          <Field label="键（可选，同键的旧条目会被替代）">
            <Input
              value={draft.key}
              maxLength={200}
              disabled={saving}
              onChange={event => { setDraft({ ...draft, key: event.target.value }) }}
            />
          </Field>
          <div className={css.memoryFormActions}>
            <Button variant="outline" type="button" disabled={saving} onClick={() => { setDraft(undefined) }}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={saving}>
              {saving ? '保存中…' : draft.id === undefined ? '添加' : '保存'}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

function LeaderMark({ size = 15, filled = false }: { size?: number; filled?: boolean }): JSX.Element {
  // Same geometry as AionUi's @icon-park/react Crown (48×48), currentColor.
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      role="presentation"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
    >
      <path
        d="M9 40L4 17L14 22L24 8L34 22L44 17L39 40H9Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M24 33C26.2091 33 28 31.2091 28 29C28 26.7909 26.2091 25 24 25C21.7909 25 20 26.7909 20 29C20 31.2091 21.7909 33 24 33Z"
        fill={filled ? 'var(--dsw-alias-bg-layer-1)' : 'none'}
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface DraftMember {
  key: string
  assistantId: string
}

function workspaceName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  return normalized.split(/[/\\]/).at(-1) || 'Workspace'
}

function assistantGlyph(assistant: AssistantView): string {
  return assistant.name.slice(0, 1).toLocaleUpperCase()
}

/** What selecting a built-in template writes into the form, before the user edits it. */
export interface TeamTemplatePrefill {
  readonly name: string
  readonly workspaceId: string
  readonly assistantIds: readonly string[]
  readonly brief: string
  readonly missingAssistants: boolean
}

/**
 * One textarea carries the template's tasks and acceptance criteria. The form
 * sends this after `team.start`; the created team has no task write API, so the
 * Leader materializes the board from this brief.
 */
export function teamTemplateBrief(template: TeamTemplate): string {
  return [
    '请把以下任务建到任务板并开始推进：',
    ...template.tasks.map((task, index) =>
      `${index + 1}. ${task.title}\n   验收：${task.acceptance.join('；')}`),
  ].join('\n')
}

/**
 * Default prefill for one template: its name, the first usable workspace, and
 * eligible assistants in form order (repeated only when the template asks for
 * more slots than there are assistants). Blank/empty inputs produce no
 * fabricated values.
 */
export function teamTemplatePrefill(
  template: TeamTemplate,
  assistants: readonly AssistantView[],
  workspaces: readonly CatalogView['workspaces'][number][],
): TeamTemplatePrefill {
  const pool = assistants.filter(assistant => assistant.enabled && assistant.teamSelectable)
  const slots = teamTemplateSlots(template)
  return {
    name: template.name,
    workspaceId: workspaces.find(workspace => workspaceSelectable(workspace))?.id ?? '',
    assistantIds: pool.length === 0
      ? []
      : slots.map((_, index) => pool[index % pool.length]!.id),
    brief: teamTemplateBrief(template),
    missingAssistants: pool.length === 0,
  }
}

/**
 * Role names come from the template, but only when the created slots still line
 * up with what the form submitted. A member the user removed (or replaced)
 * skips every rename rather than mislabelling someone else's slot.
 */
export function templateRoleRenames(
  team: Pick<TeamView, 'members' | 'memberOrder'>,
  template: TeamTemplate,
  submitted: readonly Pick<DraftMember, 'assistantId'>[],
): Array<{ slotId: string, displayName: string }> {
  const slots = teamTemplateSlots(template)
  const order = team.memberOrder ?? Object.keys(team.members)
  if (order.length !== slots.length || submitted.length !== slots.length) return []
  const renames: Array<{ slotId: string, displayName: string }> = []
  for (let index = 0; index < order.length; index += 1) {
    const member = team.members[order[index]!]
    if (member === undefined || member.assistantId !== submitted[index]?.assistantId) return []
    const displayName = slots[index]!.role
    if (member.displayName !== displayName) renames.push({ slotId: member.id, displayName })
  }
  return renames
}

export function TeamForm({
  catalog,
  catalogLoading,
  assistants,
  pickWorkspace,
  onAssistantsChanged,
  onCancel,
  onCreated,
}: {
  catalog: CatalogView | undefined
  /** The catalog is still in flight: never report a missing provider before it settles. */
  catalogLoading?: boolean | undefined
  assistants: AssistantView[]
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onAssistantsChanged: () => Promise<void>
  onCancel: () => void
  onCreated: (teamId: string) => Promise<void>
}): JSX.Element {
  const catalogWorkspaces = catalog?.workspaces.filter(workspace => workspaceSelectable(workspace)) ?? []
  const [name, setName] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [pickedWorkspace, setPickedWorkspace] = useState<WorkspaceChoice>()
  const [query, setQuery] = useState('')
  const [members, setMembers] = useState<DraftMember[]>([])
  const [leaderKey, setLeaderKey] = useState<string>()
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [creatingAssistant, setCreatingAssistant] = useState(false)
  const [error, setError] = useState<string>()
  const [templateId, setTemplateId] = useState<TeamTemplateId | 'blank'>('blank')
  const [brief, setBrief] = useState('')
  const t = useTeamText()
  const workspaces = useMemo(() => {
    if (pickedWorkspace === undefined || catalogWorkspaces.some(workspace => workspace.id === pickedWorkspace.id)) {
      return catalogWorkspaces
    }
    return [...catalogWorkspaces, { ...pickedWorkspace, status: 'ok' as const }]
  }, [catalogWorkspaces, pickedWorkspace])
  const byId = useMemo(() => new Map(assistants.map(assistant => [assistant.id, assistant])), [assistants])
  const selectedWorkspace = useMemo(
    () => workspaces.find(workspace => workspace.id === workspaceId),
    [workspaceId, workspaces],
  )
  const filteredAssistants = useMemo(() => {
    const pool = assistants.filter(assistant => assistant.enabled && assistant.teamSelectable)
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return pool
    return pool.filter(assistant => assistant.name.toLocaleLowerCase().includes(normalized))
  }, [assistants, query])

  async function createDefaultAssistant(): Promise<void> {
    // A click that lands before the catalog resolves is not an empty catalog.
    if (catalogLoading === true) return
    if (catalog === undefined) {
      setError('还没有读取到模型目录，请稍后重试。')
      return
    }
    const provider = catalog.providers.find(entry => (catalog.models[entry.id]?.length ?? 0) > 0)
    const model = provider === undefined ? undefined : catalog.models[provider.id]?.[0]
    const preset = catalog.agentPresets.find(entry => entry.id === 'standard' && entry.broken === undefined)
      ?? catalog.agentPresets.find(entry => entry.broken === undefined)
    const permission = catalog.permissionPresets.find(entry => entry.value === 'workspace-write')
      ?? catalog.permissionPresets[0]
    if (provider === undefined || model === undefined || preset === undefined || permission === undefined) {
      setError('当前没有可用的 Provider、模型、Agent Preset 或权限预设，无法创建默认成员。')
      return
    }
    setCreatingAssistant(true)
    setError(undefined)
    try {
      await callAgentTeam('assistant.create', {
        name: '通用成员',
        description: '使用当前默认模型创建的通用团队成员模板',
        instructions: 'You are a general-purpose member of a DeepSeek Harness team. Follow the Team Leader and use the shared task board.',
        provider: provider.id,
        model: model.id,
        agentPresetId: preset.id,
        permissionPresetId: permission.value,
        skillAllowlist: [],
        mcpServers: [],
      })
      await onAssistantsChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreatingAssistant(false)
    }
  }

  async function chooseWorkspace(): Promise<void> {
    setPickingWorkspace(true)
    try {
      const workspace = await pickWorkspace()
      if (workspace === null) return
      setPickedWorkspace(workspace)
      setWorkspaceId(workspace.id)
      setWorkspaceMenuOpen(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPickingWorkspace(false)
    }
  }

  function addAssistant(assistant: AssistantView): void {
    const member: DraftMember = {
      key: crypto.randomUUID(),
      assistantId: assistant.id,
    }
    setMembers(current => [...current, member])
    setLeaderKey(current => current ?? member.key)
  }

  function removeMember(key: string): void {
    const remaining = members.filter(member => member.key !== key)
    setMembers(remaining)
    if (leaderKey === key) setLeaderKey(remaining[0]?.key)
  }

  function selectTemplate(id: TeamTemplateId | 'blank'): void {
    setTemplateId(id)
    setError(undefined)
    if (id === 'blank') {
      setName('')
      setWorkspaceId('')
      setPickedWorkspace(undefined)
      setMembers([])
      setLeaderKey(undefined)
      setBrief('')
      return
    }
    const template = TEAM_TEMPLATES.find(entry => entry.id === id)
    if (template === undefined) return
    const prefill = teamTemplatePrefill(template, assistants, workspaces)
    const next = prefill.assistantIds.map(assistantId => ({
      key: crypto.randomUUID(),
      assistantId,
    }))
    setName(prefill.name)
    setWorkspaceId(prefill.workspaceId)
    setPickedWorkspace(undefined)
    setMembers(next)
    setLeaderKey(next[0]?.key)
    setBrief(prefill.brief)
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (leaderKey === undefined || members.length === 0) return
    setSaving(true)
    setError(undefined)
    try {
      const draft = await callAgentTeam('team.createDraft', {
        name,
        workspaceId,
        directMemberChat: true,
        members: members.map(member => ({
          assistantId: member.assistantId,
          role: member.key === leaderKey ? 'leader' : 'member',
        })),
      })
      const started = await callAgentTeam('team.start', { id: draft.id }, draft.revision)
      const template = templateId === 'blank'
        ? undefined
        : TEAM_TEMPLATES.find(entry => entry.id === templateId)
      if (template !== undefined) {
        // The team already exists: role names and the first brief are best-effort
        // extras and must never turn a created team into a form error.
        for (const rename of templateRoleRenames(started, template, members)) {
          try {
            await callAgentTeam('team.renameMember', { teamId: started.id, ...rename })
          } catch {
            // Best effort: a role label never blocks creation.
          }
        }
        if (brief.trim().length > 0) {
          try {
            await callAgentTeam('team.message.send', {
              teamId: started.id,
              content: brief.trim(),
              targetSlotId: started.leaderSlotId,
            })
          } catch {
            // Best effort: open the created team even when the brief cannot be sent.
          }
        }
      }
      await onCreated(draft.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = name.trim().length > 0
    && workspaceId.length > 0
    && leaderKey !== undefined
    && members.length > 0
  const activeTemplate = templateId === 'blank'
    ? undefined
    : TEAM_TEMPLATES.find(entry => entry.id === templateId)
  const templateHasNoAssistants = activeTemplate !== undefined
    && !assistants.some(assistant => assistant.enabled && assistant.teamSelectable)

  const workspaceMenuItems: MenuEntry[] = [
    ...workspaces.map(workspace => ({
      id: workspace.id,
      label: (
        <span className={css.workspaceMenuItem}>
          <span className={css.workspaceMenuItemTitle}>{workspace.title}</span>
          <span className={css.workspaceMenuItemPath}>{workspace.path}</span>
        </span>
      ),
      icon: <IconFolderOpenOutlineRegular size={16} />,
    })),
    ...(workspaces.length > 0 ? [{ type: 'separator' as const, id: 'workspace-separator' }] : []),
  ]
  const workspaceMenuFooter: MenuEntry[] = [
    {
      id: '__pick_workspace__',
      label: '选择其他目录',
      icon: <IconFolderOpenOutlineRegular size={16} />,
    },
  ]

  return (
    <form
      onSubmit={(event) => { void submit(event) }}
      className={`${css.teamBuilderForm} ${activeTemplate === undefined ? '' : css.teamBuilderFormTemplate}`}
    >
      <div className={css.teamTemplateBar}>
        <span className={css.teamTemplateLabel} id="dsh-team-template-label">团队模板</span>
        <div className={css.teamTemplateOptions} role="group" aria-labelledby="dsh-team-template-label">
          <Button
            variant="outline"
            size="sm"
            type="button"
            className={css.teamTemplateOption}
            aria-pressed={templateId === 'blank'}
            onClick={() => { selectTemplate('blank') }}
          >
            空白
          </Button>
          {TEAM_TEMPLATES.map(template => (
            <Button
              key={template.id}
              variant="outline"
              size="sm"
              type="button"
              className={css.teamTemplateOption}
              aria-pressed={templateId === template.id}
              onClick={() => { selectTemplate(template.id) }}
            >
              {template.label}
            </Button>
          ))}
        </div>
        {templateHasNoAssistants && (
          <span className={css.teamTemplateNote} role="status">
            没有可选的成员模板，已预填团队名与工作区；请先创建成员模板。
          </span>
        )}
      </div>
      {activeTemplate !== undefined && (
        <label className={css.teamTemplateBrief}>
          <span className={css.teamTemplateBriefLabel}>
            <span>首条任务简报</span>
            <span className={css.teamTemplateBriefHint}>
              {activeTemplate.tasks.length} 项任务与验收标准 · 创建后发送给 Leader，可修改
            </span>
          </span>
          <textarea
            className={css.teamTemplateBriefInput}
            rows={2}
            value={brief}
            aria-label="首条任务简报"
            onChange={event => { setBrief(event.target.value) }}
          />
        </label>
      )}
      <div className={css.teamBuilderGrid}>
        <section className={css.assistantPicker}>
          <div className={css.builderSectionHeading}>
            <strong>所有助手 ({assistants.length})</strong>
          </div>
          <Input
            icon={<IconSearchOutlineRegular size={14} />}
            type="search"
            value={query}
            onChange={event => { setQuery(event.target.value) }}
            placeholder="搜索"
            aria-label="搜索助手"
            className={css.teamSearch ?? ''}
          />
          <div className={css.assistantPickList}>
            {filteredAssistants.map(assistant => (
              <button
                key={assistant.id}
                type="button"
                className={css.assistantPickRow}
                onClick={() => { addAssistant(assistant) }}
                aria-label={`添加 ${assistant.name}`}
              >
                <span className={css.assistantPickAvatar} aria-hidden="true">
                  {assistantGlyph(assistant)}
                </span>
                <span className={css.assistantPickName}>{assistant.name}</span>
                <span className={css.assistantAddBox} aria-hidden="true">
                  <IconPlusOutlineRegular size={16} />
                </span>
              </button>
            ))}
            {filteredAssistants.length === 0 && (
              assistants.length === 0
                ? (
                    catalogLoading === true
                      ? (
                          <div className={css.assistantEmpty} role="status" data-dsh-team-catalog-loading>
                            <strong>正在读取模型与成员模板…</strong>
                            <span>模型、Agent Preset 与权限预设就绪后即可一键创建成员模板。</span>
                          </div>
                        )
                      : (
                          <div className={css.assistantEmpty}>
                            <strong>还没有成员模板。</strong>
                            <span>用当前默认模型创建一个通用成员，或到“设置 → 团队”管理模板。</span>
                            <Button
                              variant="outline"
                              size="sm"
                              type="button"
                              disabled={creatingAssistant}
                              onClick={() => { void createDefaultAssistant() }}
                            >
                              {creatingAssistant ? '创建中…' : '创建默认成员'}
                            </Button>
                          </div>
                        )
                  )
                : <Empty text="未找到结果" />
            )}
          </div>
        </section>

        <section className={css.selectedMembers}>
          <div className={css.builderSectionHeading}>
            <strong>已选成员 {members.length}</strong>
            <span className={css.leaderLegend}>
              <span className={css.leaderLegendMark} aria-hidden="true"><LeaderMark size={13} filled /></span>
              {' = Leader'}
            </span>
          </div>
          <p className={css.membersHint}>选择团队成员并指定一个 Leader。同一个助手可被多次选择。</p>
          <div className={css.selectedMemberPanel}>
            {members.length === 0
              ? (
                  <div className={css.memberPanelEmpty}>
                    <strong>请至少选择一个助手当团队 Leader。</strong>
                    <span>没有合适的助手当队员？创建后可让 Leader 在对话中创建临时队员。</span>
                  </div>
                )
              : members.map(member => {
                  const assistant = byId.get(member.assistantId)
                  const leader = member.key === leaderKey
                  return (
                    <div key={member.key} className={css.selectedMemberRow}>
                      <span className={css.selectedMemberAvatar} aria-hidden="true">
                        {assistant === undefined ? '?' : assistantGlyph(assistant)}
                      </span>
                      <span className={css.selectedMemberName}>{assistant?.name ?? '助手'}</span>
                      {/* Same pattern as the team card: a visible label is the
                          accessible name, so the control never reads differently
                          from what is on screen. */}
                      {leader
                        ? (
                            <span className={`${css.memberRole} ${css.memberRoleLeader}`}>
                              {t('member.setLeader')}
                            </span>
                          )
                        : (
                            <button
                              type="button"
                              className={`${css.memberRole} ${css.memberRoleAction}`}
                              onClick={() => { setLeaderKey(member.key) }}
                            >
                              {t('member.setLeader')}
                            </button>
                          )}
                      <Tooltip label="移除成员" side="top">
                        <button
                          type="button"
                          className={css.memberRemoveButton}
                          onClick={() => { removeMember(member.key) }}
                          aria-label={`移除 ${assistant?.name ?? '助手'}`}
                        >
                          <IconCloseOutlineRegular size={16} />
                        </button>
                      </Tooltip>
                    </div>
                  )
                })}
          </div>
          <div className={css.teamFields}>
            <label className={css.teamFieldLabel} htmlFor="dsh-team-mode-team-name">
              团队名 <span className={css.requiredMark} aria-hidden="true">*</span>
            </label>
            <Input
              id="dsh-team-mode-team-name"
              value={name}
              onChange={event => { setName(event.target.value) }}
              placeholder="团队名称"
              className={css.teamFieldInput ?? ''}
              required
            />
            <span className={css.teamFieldLabel}>工作空间</span>
            <Menu
              open={workspaceMenuOpen}
              onClose={() => { setWorkspaceMenuOpen(false) }}
              items={workspaceMenuItems}
              footer={workspaceMenuFooter}
              selectedId={workspaceId === '' ? undefined : workspaceId}
              onSelect={id => {
                setWorkspaceMenuOpen(false)
                if (id === '__pick_workspace__') {
                  void chooseWorkspace()
                  return
                }
                setWorkspaceId(id)
                setPickedWorkspace(undefined)
              }}
              align="start"
              side="top"
              portal
              className={css.workspaceMenuAnchor}
              listClassName={css.workspaceMenuList ?? ''}
              anchor={(
                <button
                  type="button"
                  className={css.workspaceSelect}
                  aria-haspopup="menu"
                  aria-expanded={workspaceMenuOpen}
                  disabled={pickingWorkspace || saving}
                  onClick={() => { setWorkspaceMenuOpen(value => !value) }}
                >
                  <IconFolderOpenOutlineRegular size={16} />
                  <span className={css.workspaceSelectCopy}>
                    <span className={css.workspaceSelectTitle}>
                      {pickingWorkspace
                        ? '选择中…'
                        : selectedWorkspace === undefined
                          ? '选择文件夹'
                          : selectedWorkspace.title}
                    </span>
                  </span>
                  <IconChevronDownOutlineRegular size={14} />
                </button>
              )}
            />
          </div>
          {error !== undefined && <div role="alert" className={css.teamBuilderError}>{error}</div>}
        </section>
      </div>
      <div className={css.teamBuilderFooter}>
        <Button
          variant="outline"
          type="button"
          className={css.teamFooterButton}
          disabled={saving}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button
          variant="primary"
          type="submit"
          className={`${css.teamFooterButton} ${css.teamFooterConfirm}`}
          disabled={saving || !canSubmit}
        >
          {saving ? '创建中…' : '确认创建'}
        </Button>
      </div>
    </form>
  )
}
