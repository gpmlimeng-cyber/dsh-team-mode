import type { FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconCloseOutlineRegular,
  IconEditOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  Menu,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantView,
  CatalogView,
  TeamView,
  TeamWorkbenchView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeamConversation } from '../api.js'
import { AssistantPanel } from '../assistants/AssistantPanel.js'
import css from '../AgentTeam.module.css'
import { CrownIcon } from '../icons/CrownIcon.js'
import { memberStatusLabel, TASK_STATE_LABELS } from '../labels.js'
import {
  initialVisibleMemberSlots,
  reconcileVisibleMemberSlots,
  toggleVisibleMemberSlot,
} from '../member-visibility.js'
import { AnimatedModal, Empty, Field } from '../shared.js'
import { openTeam } from '../store.js'
import { isTeamExecuting } from '../team-status.js'
import type { WorkspaceChoice } from '../types.js'
import { ConversationColumn } from '../workbench/ConversationColumn.js'
import { WorkspacePanel } from '../workspace/WorkspacePanel.js'
import { TeamActivityBoard } from '../team-activity.js'
import { useTeamText } from '../team-i18n.js'

export function TeamPanel({
  catalog,
  assistants,
  teams,
  createRequest,
  selectedTeamId,
  pickWorkspace,
  onChanged,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  teams: TeamView[]
  createRequest: number
  selectedTeamId: string | undefined
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onChanged: () => Promise<void>
}): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [managingAssistants, setManagingAssistants] = useState(false)
  const selectedTeam = teams.find(team => team.id === selectedTeamId)
  const visibleTeams = selectedTeamId === undefined
    ? teams
    : teams.filter(team => team.id === selectedTeamId)

  useEffect(() => {
    if (createRequest > 0) {
      setManagingAssistants(false)
      setCreating(true)
    }
  }, [createRequest])

  useEffect(() => {
    if (selectedTeamId !== undefined) setManagingAssistants(false)
  }, [selectedTeamId])

  return (
    <section className={css.section}>
      {selectedTeam === undefined && <div className={css.sectionHeader}>
        <div>
          <h2 className={css.sectionHeading}>团队 <span className={css.count}>{teams.length}</span></h2>
          <p className={css.sectionDescription}>选择 Leader 和成员，共享同一个 Workspace 协作。</p>
        </div>
        <div className={css.sectionHeaderActions}>
          <Button variant="outline" onClick={() => { setManagingAssistants(true) }}>
            成员模板
          </Button>
          <Button variant="primary" disabled={assistants.length === 0} onClick={() => { setCreating(true) }}>
            新建团队
          </Button>
        </div>
      </div>}
      {selectedTeam === undefined
        ? visibleTeams.length === 0
          ? <Empty text="还没有团队" hint="先通过“成员模板”创建助手，再选择 Leader 和团队成员。" />
          : <div className={css.cardList}>{visibleTeams.map(team => (
              <TeamCard
                key={team.id}
                team={team}
                catalog={catalog}
                assistants={assistants}
                pickWorkspace={pickWorkspace}
                onChanged={onChanged}
                onCloned={async teamId => {
                  openTeam(teamId)
                  await onChanged()
                }}
              />
            ))}</div>
        : <TeamWorkbench
          team={selectedTeam}
          catalog={catalog}
          assistants={assistants}
          permissionPresets={catalog?.permissionPresets ?? []}
          pickWorkspace={pickWorkspace}
          onChanged={onChanged}
        />}
      <AnimatedModal
        open={managingAssistants}
        onClose={() => { setManagingAssistants(false) }}
        title="成员模板"
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
      <AnimatedModal
        open={creating}
        onClose={() => { setCreating(false) }}
        title="新建团队"
        closeLabel="关闭"
        description="让多个 Agent 组队协作。一个团队必须有且只有一个 Leader。"
        className={css.teamCreateDialog ?? ''}
        contentClassName={css.teamCreateContent ?? ''}
      >
        <TeamForm
          catalog={catalog}
          assistants={assistants}
          pickWorkspace={pickWorkspace}
          onAssistantsChanged={onChanged}
          onCancel={() => { setCreating(false) }}
          onCreated={async teamId => {
            setCreating(false)
            openTeam(teamId)
            await onChanged()
          }}
        />
      </AnimatedModal>
    </section>
  )
}

function TeamWorkbench({
  team,
  catalog,
  assistants,
  permissionPresets,
  pickWorkspace,
  onChanged,
}: {
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  permissionPresets: CatalogView['permissionPresets']
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onChanged: () => Promise<void>
}): JSX.Element {
  const members = Object.values(team.members)
  const memberIds = members.map(member => member.id)
  const [snapshot, setSnapshot] = useState<TeamWorkbenchView>()
  const [visibleSlots, setVisibleSlots] = useState(() => initialVisibleMemberSlots(memberIds))
  const [error, setError] = useState<string>()
  const [memberActionError, setMemberActionError] = useState<string>()
  const [memberActionBusy, setMemberActionBusy] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<TeamView['members'][string]>()
  const [managementOpen, setManagementOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [expandedSlotId, setExpandedSlotId] = useState<string>()
  const [workspaceVisible, setWorkspaceVisible] = useState(true)
  const [taskBoardOpen, setTaskBoardOpen] = useState(false)
  const [view, setView] = useState<'parallel' | 'board'>('parallel')
  const [workspaceRefreshSignal, setWorkspaceRefreshSignal] = useState(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>()
  const loadGeneration = useRef(0)
  const previousMemberIds = useRef(memberIds)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    try {
      const next = await callAgentTeam('team.workbench.get', { id: team.id })
      if (generation !== loadGeneration.current) return
      setSnapshot(next)
      setError(undefined)
    } catch (cause) {
      if (generation !== loadGeneration.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [team.id])

  useEffect(() => { void load() }, [load, team.revision])
  useEffect(() => subscribeAgentTeamConversation(team.id, conversation => {
    if (conversation !== undefined) {
      loadGeneration.current += 1
      setWorkspaceRefreshSignal(current => current + 1)
      setSnapshot(current => {
        if (current === undefined) return current
        const conversations = current.conversations.filter(item => item.slotId !== conversation.slotId)
        return { ...current, conversations: [...conversations, conversation] }
      })
      setError(undefined)
      return
    }
    if (refreshTimer.current !== undefined) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined
      void load()
    }, 50)
  }, () => { setError('实时连接已断开，正在等待重连') }, () => {
    setError(undefined)
    void load()
  }), [load, team.id])
  useEffect(() => () => {
    if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current)
  }, [])
  useEffect(() => {
    setVisibleSlots(current => reconcileVisibleMemberSlots(current, previousMemberIds.current, memberIds))
    previousMemberIds.current = memberIds
  }, [team.members])
  useEffect(() => {
    if (expandedSlotId !== undefined && team.members[expandedSlotId] === undefined) setExpandedSlotId(undefined)
  }, [expandedSlotId, team.members])
  useEffect(() => {
    if (expandedSlotId === undefined) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpandedSlotId(undefined)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [expandedSlotId])

  function toggleMember(slotId: string): void {
    setVisibleSlots(current => toggleVisibleMemberSlot(current, slotId))
  }

  async function removeMember(): Promise<void> {
    if (memberToRemove === undefined) return
    setMemberActionBusy(true)
    try {
      await callAgentTeam('team.removeMember', {
        teamId: team.id,
        slotId: memberToRemove.id,
      }, team.revision)
      setMemberToRemove(undefined)
      setMemberActionError(undefined)
      await onChanged()
      await load()
    } catch (cause) {
      setMemberActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMemberActionBusy(false)
    }
  }

  const conversations = new Map(snapshot?.conversations.map(item => [item.slotId, item]) ?? [])
  const wakingCount = members.filter(member => member.lastRuntimeState === 'starting' || member.lastRuntimeState === 'offline').length
  const visibleMembers = visibleSlots.map(slotId => team.members[slotId]).filter((value): value is TeamView['members'][string] => value !== undefined)

  return (
    <div className={css.workbench}>
      <div className={css.workbenchMainPane}>
        <div className={css.memberTabs} aria-label="团队成员">
        {members.map(member => {
          const conversation = conversations.get(member.id)
          const selected = visibleSlots.includes(member.id)
          return (
            <span key={member.id} className={css.memberTabWrap}>
              <button
                type="button"
                className={`${css.memberTab} ${member.role === 'leader' ? '' : css.memberTabWithActions} ${selected ? css.memberTabActive : ''}`}
                onClick={() => { toggleMember(member.id) }}
                aria-pressed={selected}
              >
                <span className={css.memberAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
                <span className={css.memberTabName}>{member.displayName}</span>
                {member.role === 'leader' && <CrownIcon size={15} className={css.leaderCrown} title="Leader" />}
                <span className={`${css.statusDot} ${conversation?.status === 'running' ? css.statusRunning : css.statusIdle}`} />
                {(conversation?.pendingInteractions.length ?? 0) > 0 && (
                  <span
                    className={css.teamParallelPendingBadge}
                    aria-label={`${conversation?.pendingInteractions.length} 个待确认`}
                  >
                    {conversation?.pendingInteractions.length}
                  </span>
                )}
              </button>
              {member.role !== 'leader' && (
                <span className={css.memberTabActions}>
                  <button
                    type="button"
                    className={css.memberTabRemoveAction}
                    title={`移出成员 ${member.displayName}`}
                    aria-label={`移出成员 ${member.displayName}`}
                    onClick={() => {
                      setMemberActionError(undefined)
                      setMemberToRemove(member)
                    }}
                  >
                    <IconCloseOutlineRegular size={12} />
                  </button>
                </span>
              )}
            </span>
          )
        })}
        <span className={css.manageButtonWrap}>
          {!workspaceVisible && (
            <Button
              variant="ghost"
              size="sm"
              className={css.manageButton}
              onClick={() => { setWorkspaceVisible(true) }}
            >
              <IconChevronLeftOutlineRegular size={14} />
              Workspace
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={css.manageButton}
            onClick={() => {
              setAddMemberOpen(true)
            }}
          >
            <IconPlusOutlineRegular size={14} />
            添加助手
          </Button>
          <Button variant="ghost" size="sm" className={css.manageButton} onClick={() => { setTaskBoardOpen(true) }}>
            任务{Object.values(team.tasks).filter(task => task.status !== 'cancelled').length > 0
              ? ` (${Object.values(team.tasks).filter(task => task.status !== 'cancelled').length})`
              : ''}
          </Button>
          <Button variant="ghost" size="sm" className={css.manageButton} onClick={() => { setView(value => value === 'parallel' ? 'board' : 'parallel') }}>
            {view === 'parallel' ? '看板' : '会话'}
          </Button>
          <Button variant="ghost" size="sm" className={css.manageButton} onClick={() => { setManagementOpen(value => !value) }}>
            {managementOpen ? '收起管理' : '团队管理'}
          </Button>
        </span>
        </div>
        {error && <div role="alert" className={css.workbenchError}>{error}</div>}
        {wakingCount > 0 && (
          <div className={css.workbenchNotice} role="status">
            正在唤醒团队…（{members.length - wakingCount}/{members.length} 名成员就绪）
          </div>
        )}
        {memberActionError && memberToRemove === undefined && (
          <div role="alert" className={css.workbenchError}>{memberActionError}</div>
        )}
        {expandedSlotId !== undefined && (
          <button
            type="button"
            className={css.conversationFocusBackdrop}
            aria-label="关闭放大对话"
            onClick={() => { setExpandedSlotId(undefined) }}
          />
        )}
        <div className={css.workbenchBody}>
          {view === 'board'
            ? <TeamActivityBoard team={team} />
            : <div className={css.conversationGrid} style={{ '--member-columns': visibleMembers.length } as React.CSSProperties}>
                {visibleMembers.map(member => (
                  <ConversationColumn
                    key={member.id}
                    team={team}
                    member={member}
                    conversation={conversations.get(member.id)}
                    permissionPresets={permissionPresets}
                    onSent={load}
                    onTeamChanged={onChanged}
                    expanded={expandedSlotId === member.id}
                    onExpandedChange={expanded => { setExpandedSlotId(expanded ? member.id : undefined) }}
                  />
                ))}
              </div>}
        </div>
      </div>
      {workspaceVisible && (
        <WorkspacePanel
          team={team}
          refreshSignal={workspaceRefreshSignal}
          onCollapse={() => { setWorkspaceVisible(false) }}
        />
      )}
      <AnimatedModal
        open={managementOpen}
        onClose={() => { setManagementOpen(false) }}
        title="团队管理"
        description="管理成员、Leader、上下文和团队生命周期。"
        closeLabel="关闭"
        className={css.managementDialog ?? ''}
        contentClassName={css.managementDialogContent ?? ''}
      >
        <div className={css.managementDialogBody}>
          <TeamCard
            team={team}
            catalog={catalog}
            assistants={assistants}
            pickWorkspace={pickWorkspace}
            onChanged={async () => { await onChanged(); await load() }}
            onCloned={async teamId => {
              setManagementOpen(false)
              openTeam(teamId)
              await onChanged()
            }}
            compact
          />
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={taskBoardOpen}
        onClose={() => { setTaskBoardOpen(false) }}
        title="任务板"
        description="Leader 拆解目标并分派任务；成员在各自会话中更新状态和结果。"
        closeLabel="关闭"
        className={css.taskBoardDialog ?? ''}
        contentClassName={css.taskBoardDialogContent ?? ''}
      >
        <div className={css.taskBoardModal}>
          {Object.values(team.tasks).filter(task => task.status !== 'cancelled').length === 0
            ? <Empty text="任务板还是空的" hint="向 Leader 描述目标，Leader 会拆解任务并分派给成员。" />
            : Object.values(team.tasks)
                .filter(task => task.status !== 'cancelled')
                .map(task => (
                  <div key={task.id} className={css.taskBoardRow}>
                    <div className={css.taskBoardRowMain}>
                      <strong>{task.title}</strong>
                      {task.description && <span className={css.taskBoardDescription}>{task.description}</span>}
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
                ))}
        </div>
      </AnimatedModal>
      <AddTeamMemberDialog
        open={addMemberOpen}
        team={team}
        catalog={catalog}
        assistants={assistants}
        onClose={() => { setAddMemberOpen(false) }}
        onChanged={async () => { await onChanged(); await load() }}
      />
      <AnimatedModal
        open={memberToRemove !== undefined}
        onClose={() => {
          if (memberActionBusy) return
          setMemberToRemove(undefined)
          setMemberActionError(undefined)
        }}
        title="移出团队成员"
        closeLabel="关闭"
        description="该成员将停止参与当前团队。"
        className={css.memberRemoveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={memberActionBusy}
              onClick={() => {
                setMemberToRemove(undefined)
                setMemberActionError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={memberActionBusy}
              onClick={() => { void removeMember() }}
            >
              {memberActionBusy ? '移出中…' : '确认移出'}
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
          {memberActionError && <div role="alert" className={css.inlineError}>{memberActionError}</div>}
        </div>
      </AnimatedModal>
    </div>
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
  const catalogWorkspaces = catalog?.workspaces.filter(workspace => workspace.status === 'ok') ?? []
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
              <select
                required
                value={workspaceId}
                onChange={event => { setWorkspaceId(event.target.value) }}
                className={css.input}
              >
                <option value="">{workspaces.length === 0 ? '暂无 Workspace' : '请选择 Workspace'}</option>
                {workspaces.map(item => <option key={item.id} value={item.id}>{item.title} — {item.path}</option>)}
              </select>
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
}: {
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onChanged: () => Promise<void>
  onCloned: (teamId: string) => Promise<void>
  compact?: boolean
  headerActions?: ReactNode
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
  const [memberToRemove, setMemberToRemove] = useState<{ slotId: string; displayName: string }>()
  const [contextTarget, setContextTarget] = useState<{ slotId: string; displayName: string }>()
  const [renaming, setRenaming] = useState<{ slotId: string; draft: string }>()
  const [renameBusy, setRenameBusy] = useState(false)
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

  async function changeLeader(successorSlotId: string): Promise<void> {
    if (successorSlotId === team.leaderSlotId) return
    setBusy(true)
    try {
      await callAgentTeam('team.changeLeader', {
        teamId: team.id,
        successorSlotId,
      }, team.revision)
      setError(undefined)
      await onChanged()
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
          {executing && <span className={`${css.badge} ${css.badgeSuccess ?? ''}`}>任务执行中</span>}
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
                {member.role === 'leader'
                  ? <span className={`${css.memberRole} ${css.memberRoleLeader}`}>{t('member.leader')}</span>
                  : <button
                    type="button"
                    className={`${css.memberRole} ${css.memberRoleAction}`}
                    disabled={busy || renameBusy}
                    onClick={() => { void changeLeader(member.id) }}
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
      {tasks.length > 0 && (
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
    </>
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
  const icon = assistant.icon?.trim()
  if (icon !== undefined && icon !== '' && icon.length <= 4) return icon
  return assistant.name.slice(0, 1).toLocaleUpperCase()
}

export function TeamForm({
  catalog,
  assistants,
  pickWorkspace,
  onAssistantsChanged,
  onCancel,
  onCreated,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onAssistantsChanged: () => Promise<void>
  onCancel: () => void
  onCreated: (teamId: string) => Promise<void>
}): JSX.Element {
  const catalogWorkspaces = catalog?.workspaces.filter(workspace => workspace.status === 'ok') ?? []
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
    const provider = catalog?.providers.find(entry => (catalog.models[entry.id]?.length ?? 0) > 0)
    const model = provider === undefined ? undefined : catalog?.models[provider.id]?.[0]
    const preset = catalog?.agentPresets.find(entry => entry.id === 'standard' && entry.broken === undefined)
      ?? catalog?.agentPresets.find(entry => entry.broken === undefined)
    const permission = catalog?.permissionPresets.find(entry => entry.value === 'workspace-write')
      ?? catalog?.permissionPresets[0]
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

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (leaderKey === undefined || members.length === 0) return
    setSaving(true)
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
      await callAgentTeam('team.start', { id: draft.id }, draft.revision)
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
    <form onSubmit={(event) => { void submit(event) }} className={css.teamBuilderForm}>
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
                ? <div className={css.assistantEmpty}>
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
                      <Tooltip label={leader ? '当前 Leader' : '设为 Leader'} side="top">
                        <button
                          type="button"
                          className={`${css.leaderButton} ${leader ? css.leaderButtonActive : ''}`}
                          aria-pressed={leader}
                          aria-label={leader ? '当前 Leader' : '设为 Leader'}
                          onClick={() => { setLeaderKey(member.key) }}
                        >
                          <LeaderMark size={15} filled={leader} />
                        </button>
                      </Tooltip>
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
