import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import {
  Button,
  Checkbox,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCheckOutlineRegular,
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconListPenOutlineRegular,
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
  Menu,
  Tooltip,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import { assistantAvatarSource, assistantInstanceName } from './assistant-instances.js'
import { MemberAvatar } from './member-avatar.js'
import { AnimatedModal } from './shared.js'
import {
  SIDEBAR_GROUP_BRIEF_MAX_CHARS,
  SIDEBAR_GROUP_MAX_CHARS,
  UNGROUPED_PARTITION_ID,
  groupCreateRows,
  groupCreateSelection,
  groupMembershipCandidates,
  groupMembershipChanges,
  insertGroupOrder,
  resolveDropTarget,
  sidebarGroupBriefError,
  sidebarGroupBriefUsage,
  sidebarGroupNameError,
  toggleGroupCreateSelection,
  type GroupCreateRow,
  type SidebarDropHalf,
  type SidebarDropOverKind,
  type SidebarGroupCandidate,
} from './sidebar-groups.js'
import css from './AgentTeam.module.css'
import type { AssistantInstanceView, TeamView } from '../transport/contracts.js'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Chromium does not deliver the click that follows a native drag, but a WebView
 * that cancels a drag differently can. One short window after a drag ends keeps
 * a finished drag from opening a Session or folding a section.
 */
let dragClickGuardUntil = 0

function armDragClickGuard(): void {
  dragClickGuardUntil = Date.now() + 200
}

/** Whether the click arriving now belongs to a drag that just ended. */
export function sidebarDragSwallowsClick(): boolean {
  return Date.now() < dragClickGuardUntil
}

/** One partition header as a drop target, plus its own drag source. */
export interface SidebarPartitionDrag {
  /** A drag is in flight; without one, no header listens to the pointer. */
  active: boolean
  /** This header is the group being dragged. */
  dragging: boolean
  /** A row hovers this header: highlight the whole header. */
  highlight: boolean
  /** A group header hovers this one: 1px insertion line on this side. */
  marker: SidebarDropHalf | null
  start?: () => void
  end: () => void
  /** Report the hovered half; returns whether this header accepts the drop. */
  hover: (half: SidebarDropHalf) => boolean
  drop: (half: SidebarDropHalf) => void
}

/** One sidebar row as a drag source. */
export interface SidebarRowDrag {
  draggable: boolean
  dragging: boolean
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}

interface DragSource {
  kind: 'row'
  id: string
  group?: string
}

interface GroupDragSource {
  kind: 'group'
  name: string
}

/**
 * The sidebar's drag state machine, shared by both sections.
 *
 * It owns only the browser-drag bookkeeping (what is dragged, which header is
 * under the pointer, which half) and hands every decision to `assign`/`reorder`;
 * the sections keep the transport calls. Native shape throughout: `draggable`
 * rows, `effectAllowed = 'move'` plus a `text/plain` payload on start,
 * `preventDefault()` and a before/after half from the rect midpoint on hover.
 */
export function useSidebarDrag({
  groups,
  assign,
  reorder,
  onError,
}: {
  groups: readonly string[]
  /** Move one row into a group; `undefined` means 未分组. */
  assign: (id: string, group: string | undefined) => Promise<void>
  /** Replace the order of the named groups. */
  reorder: (names: string[]) => Promise<void>
  onError: (cause: unknown) => void
}): {
  row: (id: string, group: string | undefined) => SidebarRowDrag
  partition: (target: { group?: string }) => SidebarPartitionDrag
} {
  const [source, setSource] = useState<DragSource | GroupDragSource>()
  const [over, setOver] = useState<{ key: string; half: SidebarDropHalf }>()

  const end = useCallback((): void => {
    setSource(undefined)
    setOver(undefined)
    armDragClickGuard()
  }, [])

  const row = (id: string, group: string | undefined): SidebarRowDrag => ({
    // Without a single group there is nowhere to drop, so rows stay undraggable
    // and an install that never used groups keeps its old pointer behaviour.
    draggable: groups.length > 0,
    dragging: source?.kind === 'row' && source.id === id,
    onDragStart: (event): void => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', id)
      setSource({ kind: 'row', id, ...(group === undefined ? {} : { group }) })
      setOver(undefined)
    },
    onDragEnd: end,
  })

  const partition = (target: { group?: string }): SidebarPartitionDrag => {
    const key = target.group ?? UNGROUPED_PARTITION_ID
    const overKind: SidebarDropOverKind = target.group === undefined ? 'ungrouped' : 'group'
    const settle = (half: SidebarDropHalf): { accepted: boolean } => {
      const intent = resolveDropTarget(source?.kind, overKind, half)
      return { accepted: intent.kind !== 'none' }
    }
    const runDrop = (half: SidebarDropHalf): void => {
      const intent = resolveDropTarget(source?.kind, overKind, half)
      setOver(undefined)
      if (intent.kind === 'none' || source === undefined) return
      if (intent.kind === 'assign') {
        if (source.kind !== 'row') return
        // Dropping a row back where it already sits is not a write.
        if ((source.group ?? undefined) === target.group) return
        void assign(source.id, target.group).catch(onError)
        return
      }
      if (source.kind !== 'group' || target.group === undefined) return
      const names = insertGroupOrder(groups, source.name, target.group, intent.half)
      if (names.length === groups.length && names.every((name, index) => name === groups[index])) return
      void reorder(names).catch(onError)
    }
    return {
      active: source !== undefined,
      dragging: source?.kind === 'group' && source.name === target.group,
      highlight: over?.key === key && source?.kind === 'row',
      marker: over?.key === key && source?.kind === 'group' ? over.half : null,
      ...(target.group === undefined
        ? {}
        : {
            start: (): void => {
              setSource({ kind: 'group', name: target.group as string })
              setOver(undefined)
            },
          }),
      end,
      hover: (half: SidebarDropHalf): boolean => {
        const accepted = settle(half).accepted
        if (!accepted) {
          setOver(current => (current?.key === key ? undefined : current))
          return false
        }
        setOver(current => (current !== undefined && current.key === key && current.half === half
          ? current
          : { key, half }))
        return true
      },
      drop: runDrop,
    }
  }

  return { row, partition }
}

/** Header half from the pointer, the same rule the native list uses. */
function headerHalf(event: DragEvent<HTMLElement>): SidebarDropHalf {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/**
 * One group section of the sidebar: a header that collapses, plus the group's
 * own controls. The `+` and `⋯` buttons live in the header's trailing slot and
 * stay invisible (but focusable) until the header is hovered or holds focus, so
 * a sidebar with many groups is not a wall of icon buttons. `opacity` — not
 * `display` — keeps them in the tab order; the ungrouped header has neither
 * button at all, because that section cannot be renamed, deleted or filled.
 */
export function SidebarGroupPartition({
  label,
  count,
  collapsed,
  onToggle,
  onAddEntries,
  menuItems,
  onSelect,
  drag,
  children,
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  /** Opens the membership checklist; absent on the ungrouped section. */
  onAddEntries?: () => void
  menuItems?: MenuEntry[]
  onSelect?: (id: string) => void
  /** Drag source (named groups only) and drop target for this header. */
  drag?: SidebarPartitionDrag
  children: ReactNode
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const bodyId = `dsh-team-mode-partition-${label}`
  const hasMenu = menuItems !== undefined && menuItems.length > 0 && onSelect !== undefined
  const start = drag?.start
  const marker = drag?.marker ?? null
  return (
    <div
      className={css.sidebarPartition}
      data-dsh-sidebar-partition={label}
      {...(marker === null ? {} : { 'data-dsh-drop-marker': marker })}
      {...(drag?.dragging === true ? { 'data-dsh-drag-source': '' } : {})}
    >
      <div
        className={css.sidebarPartitionHeader}
        {...(drag?.highlight === true ? { 'data-dsh-drop-highlight': '' } : {})}
        draggable={start !== undefined}
        onDragStart={start === undefined
          ? undefined
          : (event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', label)
              start()
            }}
        onDragEnd={start === undefined || drag === undefined ? undefined : drag.end}
        onDragOver={drag?.active !== true
          ? undefined
          : (event) => {
              // Native shape: accept the pointer, then report the half.
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = drag.hover(headerHalf(event)) ? 'move' : 'none'
            }}
        onDrop={drag?.active !== true
          ? undefined
          : (event) => {
              event.preventDefault()
              event.stopPropagation()
              drag.drop(headerHalf(event))
            }}
      >
        <button
          type="button"
          className={css.sidebarPartitionToggle}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          onClick={() => {
            // A drag that ends over the header must not also fold the group.
            if (sidebarDragSwallowsClick()) return
            onToggle()
          }}
        >
          <span className={css.sidebarPartitionLabel} data-dsh-sidebar-title>{label}</span>
          <IconChevronRightOutlineRegular
            size={11}
            className={`${css.sidebarPartitionChevron} ${collapsed ? '' : css.sidebarPartitionChevronOpen}`}
          />
          <span className={css.sidebarPartitionCount}>{count}</span>
        </button>
        {(onAddEntries !== undefined || hasMenu) && (
          <span className={css.sidebarPartitionActions}>
            {onAddEntries !== undefined && (
              <Tooltip label="添加或移除条目" delayMs={400}>
                <button
                  type="button"
                  className={css.sidebarPartitionAction}
                  aria-label={`添加或移除「${label}」的条目`}
                  data-dsh-sidebar-group-add
                  onClick={onAddEntries}
                >
                  <IconPlusOutlineRegular size={13} />
                </button>
              </Tooltip>
            )}
            {hasMenu && (
              <Menu
                open={menuOpen}
                onClose={() => { setMenuOpen(false) }}
                align="end"
                side="bottom"
                dense
                portal
                items={menuItems}
                onSelect={id => {
                  setMenuOpen(false)
                  onSelect(id)
                }}
                anchor={(
                  <button
                    type="button"
                    className={css.sidebarPartitionAction}
                    aria-label={`「${label}」分组操作`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    data-dsh-sidebar-group-menu
                    onClick={() => { setMenuOpen(value => !value) }}
                  >
                    <IconEllipsisOutlineRegular size={13} />
                  </button>
                )}
              />
            )}
          </span>
        )}
      </div>
      {!collapsed && (
        <div id={bodyId} className={css.sidebarPartitionBody}>
          {/* An empty named group is a section with nothing in it yet; a faint
              line keeps it from reading as a broken header. The ungrouped
              section never renders empty, so the hint never shows there. */}
          {count === 0 && <div className={css.sidebarPartitionEmpty}>还没有条目</div>}
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * Header text for one partition. With groups defined, leftovers are 未分组;
 * with none, the single section is named after the list it holds, so the list
 * still starts with a normal collapsible group header.
 */
export function sidebarPartitionLabel(
  group: string | undefined,
  partitioned: boolean,
  fallback: string,
): string {
  if (group !== undefined) return group
  return partitioned ? '未分组' : fallback
}

/** Trailing list row that creates the first (or next) group. */
export function SidebarGroupCreateRow({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className={css.sidebarGroupCreateRow}
      data-dsh-sidebar-group-create
      onClick={onCreate}
    >
      <span className={css.sidebarGroupCreateSlot} aria-hidden="true">
        <IconPlusOutlineRegular size={13} />
      </span>
      <span>新建分组</span>
    </button>
  )
}

/**
 * The sidebar's one group dialog. Every entry point (a group header, a row menu,
 * the create row) opens the same modal with a different `kind`, so there is one
 * place that owns the transport calls and one place that shows their errors.
 */
export type SidebarGroupDialog =
  | { kind: 'create' }
  | { kind: 'brief'; name: string }
  | { kind: 'rename'; from: string }
  | { kind: 'delete'; name: string }
  | { kind: 'members'; group: string }
  | {
    kind: 'move'
    title: string
    current?: string
    /** Writes the new membership; `undefined` means 不分组. */
    apply: (group: string | undefined) => Promise<void>
  }

export function SidebarGroupDialogs({
  dialog,
  groups,
  onClose,
  onListChanged,
  onChanged,
}: {
  dialog: SidebarGroupDialog | undefined
  groups: string[]
  onClose: () => void
  /** Adopt the list a write returned; the Host owns order and membership. */
  onListChanged: (groups: string[]) => void
  /** Rows changed indirectly (a delete cascades); the section re-reads itself. */
  onChanged: () => void
}): JSX.Element | null {
  if (dialog === undefined) return null
  if (dialog.kind === 'create') {
    return (
      <GroupCreateDialog
        groups={groups}
        onClose={onClose}
        onListChanged={list => { onListChanged(list); onChanged() }}
        onChanged={onChanged}
      />
    )
  }
  if (dialog.kind === 'brief') {
    return <GroupBriefDialog name={dialog.name} onClose={onClose} />
  }
  if (dialog.kind === 'rename') {
    return (
      <GroupNameDialog
        initial={dialog.from}
        groups={groups}
        onClose={onClose}
        onListChanged={list => { onListChanged(list); onChanged() }}
      />
    )
  }
  if (dialog.kind === 'delete') {
    return (
      <GroupDeleteDialog
        name={dialog.name}
        onClose={onClose}
        onListChanged={list => { onListChanged(list); onChanged() }}
      />
    )
  }
  if (dialog.kind === 'members') {
    return (
      <GroupMembersDialog
        group={dialog.group}
        onClose={onClose}
        onChanged={onChanged}
      />
    )
  }
  return (
    <GroupMoveDialog
      title={dialog.title}
      {...(dialog.current === undefined ? {} : { current: dialog.current })}
      groups={groups}
      apply={dialog.apply}
      onClose={onClose}
    />
  )
}

/** Header menu of one group: its brief, rename, delete, and the two order moves. */
export function sidebarGroupMenuItems(
  groups: readonly string[],
  group: string,
): MenuEntry[] {
  const index = groups.indexOf(group)
  return [
    { id: 'brief', label: '编辑分组简报', icon: <IconListPenOutlineRegular size={14} /> },
    { id: 'rename', label: '重命名', icon: <IconEditOutlineRegular size={14} /> },
    { id: 'delete', label: '删除分组', icon: <IconTrashOutlineRegular size={14} />, danger: true },
    { type: 'separator', id: 'order-separator' },
    {
      id: 'move-up',
      label: '上移',
      icon: <IconChevronUpOutlineRegular size={14} />,
      disabled: index <= 0,
    },
    {
      id: 'move-down',
      label: '下移',
      icon: <IconChevronDownOutlineRegular size={14} />,
      disabled: index < 0 || index >= groups.length - 1,
    },
  ]
}

/**
 * The group's shared brief. It is loaded per open from the record list (the
 * sidebar's own list stays names-only), edited locally, and written only by the
 * explicit save. The dialog says who reads it and that only the user writes it;
 * its three states — empty, saved, and the Host's refusal — are inline.
 */
function GroupBriefDialog({
  name,
  onClose,
}: {
  name: string
  onClose: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [initial, setInitial] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const fieldId = 'dsh-team-mode-group-brief'
  const hintId = 'dsh-team-mode-group-brief-hint'
  const overLimit = sidebarGroupBriefError(value)
  // The Host answers an unchanged brief without a write; no need to offer one.
  const dirty = value !== initial

  useEffect(() => {
    let cancelled = false
    void callAgentTeam('sidebar.groups.briefs').then(records => {
      if (cancelled) return
      const record = records.find(item => item.name === name)
      if (record === undefined) {
        setError(`分组「${name}」已不存在，请关闭后重新打开侧栏。`)
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

  const save = async (): Promise<void> => {
    if (busy || !dirty || overLimit !== undefined) return
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      const record = await callAgentTeam('sidebar.groups.brief.set', { name, brief: value })
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
      title={`「${name}」的分组简报`}
      description="组内团队和助手的下一轮对话都会读到这段简报；它只由你编辑，Agent 没有写入入口。"
      closeLabel="关闭"
      className={css.sidebarGroupDialog ?? ''}
      contentClassName={css.sidebarGroupDialogContent ?? ''}
      footer={(
        <>
          <Button variant="outline" type="button" disabled={busy} onClick={onClose}>
            {saved ? '关闭' : '取消'}
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={!loaded || busy || !dirty || overLimit !== undefined}
            onClick={() => { void save() }}
          >
            {busy ? '保存中…' : '保存简报'}
          </Button>
        </>
      )}
    >
      {!loaded
        ? <div className={css.dialogEmpty}>正在读取分组简报…</div>
        : (
          <div className={css.sidebarGroupBriefForm}>
            <div className={css.sidebarGroupBriefHead}>
              <label className={css.sidebarGroupBriefLabel} htmlFor={fieldId}>共享简报</label>
              <span
                className={`${css.sidebarGroupBriefCount} ${overLimit === undefined ? '' : css.sidebarGroupBriefCountOver}`}
                data-dsh-group-brief-count
              >
                {sidebarGroupBriefUsage(value)}
              </span>
            </div>
            <textarea
              id={fieldId}
              className={`${css.input} ${css.sidebarGroupBriefInput}`}
              data-modal-autofocus
              data-dsh-group-brief
              rows={9}
              value={value}
              placeholder="写下这个分组共享的背景、约定或注意事项…"
              aria-label="分组简报"
              aria-describedby={hintId}
              aria-invalid={overLimit !== undefined}
              disabled={busy}
              onChange={event => {
                setValue(event.target.value)
                setSaved(false)
              }}
            />
            <p id={hintId} className={css.sidebarGroupBriefHint}>
              最多 {SIDEBAR_GROUP_BRIEF_MAX_CHARS} 个字符（24 KB）。超出时不会截断，而是拒绝保存。
            </p>
            {value === '' && (
              <p className={css.sidebarGroupBriefEmpty}>
                还没有简报。留空保存会清除这个分组的简报。
              </p>
            )}
            {overLimit !== undefined && <div className={css.inlineError} role="alert">{overLimit}</div>}
            {saved && (
              <div className={css.sidebarGroupBriefSaved} role="status">
                已保存。组内成员下一次组建提示词时就会读到这段简报。
              </div>
            )}
            {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
          </div>
        )}
    </AnimatedModal>
  )
}

/** Renaming keeps the one-field dialog: only creation also fills the group. */
function GroupNameDialog({
  initial,
  groups,
  onClose,
  onListChanged,
}: {
  initial: string
  groups: string[]
  onClose: () => void
  onListChanged: (groups: string[]) => void
}): JSX.Element {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // Renaming to the current name is a no-op, not a duplicate.
  const nameError = sidebarGroupNameError(value, groups.filter(group => group !== initial))
  const formId = 'dsh-team-mode-group-name-form'

  const save = async (): Promise<void> => {
    if (busy) return
    if (nameError !== undefined) {
      setError(nameError)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      // The Host trims; sending the typed value keeps one normalization point.
      onListChanged(await callAgentTeam('sidebar.groups.rename', { from: initial, to: value }))
      onClose()
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
      title="重命名分组"
      description="分组只影响侧栏的排列，不改变团队和助手本身。"
      closeLabel="关闭"
      className={css.sidebarGroupDialog ?? ''}
      footer={(
        <>
          <Button variant="outline" type="button" disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        className={css.sidebarGroupNameForm}
        onSubmit={event => {
          event.preventDefault()
          void save()
        }}
      >
        <input
          className={css.input}
          data-modal-autofocus
          value={value}
          maxLength={120}
          placeholder={`分组名，最多 ${SIDEBAR_GROUP_MAX_CHARS} 个字`}
          aria-label="分组名"
          aria-invalid={nameError !== undefined && value !== ''}
          onChange={event => { setValue(event.target.value) }}
        />
        {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
      </form>
    </AnimatedModal>
  )
}

interface GroupCreateFailure {
  name: string
  message: string
}

/**
 * Creating a group is also the moment to fill it: both checklists offer every
 * existing team and assistant, grouped or not, because the write is a move and
 * nothing else. The group is created first (the Host owns its name and order);
 * the moves follow one by one, so a failed row names itself and the moves that
 * already succeeded stay put.
 */
function GroupCreateDialog({
  groups,
  onClose,
  onListChanged,
  onChanged,
}: {
  groups: string[]
  onClose: () => void
  onListChanged: (groups: string[]) => void
  onChanged: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [teams, setTeams] = useState<TeamView[]>([])
  const [assistants, setAssistants] = useState<AssistantInstanceView[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [loaded, setLoaded] = useState(false)
  const [created, setCreated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [failures, setFailures] = useState<GroupCreateFailure[]>()
  const formId = 'dsh-team-mode-group-create-form'
  const nameError = sidebarGroupNameError(value, groups)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      callAgentTeam('team.list'),
      callAgentTeam('assistant.instance.list'),
    ]).then(([teamPage, assistantPage]) => {
      if (cancelled) return
      setTeams(teamPage.items.filter(team => team.archivedAt === undefined))
      setAssistants(assistantPage.items.filter(item => item.status !== 'archived'))
    }).catch(cause => {
      if (!cancelled) setError(messageOf(cause))
    }).finally(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  const rows = useMemo(() => groupCreateRows(
    teams,
    assistants,
    team => ({
      id: team.id,
      name: team.name,
      ...(team.group === undefined ? {} : { group: team.group }),
    }),
    item => {
      const avatar = assistantAvatarSource(item)
      return {
        id: item.id,
        name: assistantInstanceName(item),
        ...(item.group === undefined ? {} : { group: item.group }),
        ...(avatar === undefined || avatar === '' ? {} : { avatar }),
      }
    },
  ), [assistants, teams])

  const toggle = useCallback((id: string): void => {
    setSelected(current => toggleGroupCreateSelection(current, id))
  }, [])

  const save = async (): Promise<void> => {
    if (busy || created) return
    if (nameError !== undefined) {
      setError(nameError)
      return
    }
    setBusy(true)
    setError(undefined)
    setFailures(undefined)
    const group = value.trim()
    const plan = groupCreateSelection(rows, selected)
    const nameOf = new Map(
      [...rows.teams, ...rows.assistants].map(row => [row.id, row.name] as const),
    )
    try {
      onListChanged(await callAgentTeam('sidebar.groups.create', { name: value }))
      setCreated(true)
    } catch (cause) {
      // A refused name (already taken) is the Host's decision: show it as-is.
      setError(messageOf(cause))
      setBusy(false)
      return
    }
    const failed: GroupCreateFailure[] = []
    const move = async (id: string, write: () => Promise<unknown>): Promise<void> => {
      try {
        await write()
      } catch (cause) {
        failed.push({ name: nameOf.get(id) ?? id, message: messageOf(cause) })
      }
    }
    for (const teamId of plan.teamIds) {
      await move(teamId, () => callAgentTeam('team.group.set', { teamId, group }))
    }
    for (const assistantId of plan.assistantIds) {
      await move(assistantId, () => callAgentTeam('assistant.instance.update', {
        id: assistantId,
        value: { group },
      }))
    }
    onChanged()
    setBusy(false)
    if (failed.length === 0) {
      onClose()
      return
    }
    setFailures(failed)
  }

  /** One checklist row: avatar, name, and the shipped checkbox on the right. */
  const renderPicker = (list: readonly GroupCreateRow[], empty: string): JSX.Element => (
    list.length === 0
      ? <div className={css.sidebarPartitionEmpty}>{empty}</div>
      : (
        <div className={css.groupCreateList}>
          {list.map(row => (
            <div key={row.id} className={css.groupCreateRow} data-dsh-group-create-row={row.id}>
              <MemberAvatar name={row.name} avatar={row.avatar} size={22} />
              <span className={css.groupCreateCopy}>
                <Checkbox
                  checked={selected.has(row.id)}
                  onChange={() => { toggle(row.id) }}
                  label={row.name}
                  disabled={busy || created}
                  {...(row.group === undefined ? {} : { title: `当前分组：${row.group}` })}
                  className={css.groupCreateCheckbox ?? ''}
                />
                {row.group !== undefined && (
                  <span className={css.groupCreateNote}>当前分组：{row.group}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )
  )

  return (
    <AnimatedModal
      open
      onClose={() => { if (!busy) onClose() }}
      title="新建分组"
      closeLabel="关闭"
      className={css.sidebarGroupDialog ?? ''}
      contentClassName={css.sidebarGroupDialogContent ?? ''}
      footer={created
        ? <Button variant="primary" type="button" onClick={onClose}>关闭</Button>
        : (
          <>
            <Button variant="outline" type="button" disabled={busy} onClick={onClose}>取消</Button>
            <Button variant="primary" type="submit" form={formId} disabled={busy}>
              {busy ? '创建中…' : '创建分组'}
            </Button>
          </>
        )}
    >
      <form
        id={formId}
        className={css.sidebarGroupNameForm}
        onSubmit={event => {
          event.preventDefault()
          void save()
        }}
      >
        <input
          className={css.input}
          data-modal-autofocus
          value={value}
          maxLength={120}
          placeholder={`分组名，最多 ${SIDEBAR_GROUP_MAX_CHARS} 个字`}
          aria-label="分组名"
          aria-invalid={nameError !== undefined && value !== ''}
          disabled={busy || created}
          onChange={event => { setValue(event.target.value) }}
        />
        {/* The intro follows the name field, the order MausBot's create dialog
            reads: name, then what the dialog does, then the two pickers. */}
        <p className={css.groupCreateIntro}>
          创建空分组，或把现有的团队/助手移进来。移动只影响侧栏排列，不影响它们本身。
        </p>
        {!loaded
          ? <div className={css.dialogEmpty}>正在读取现有团队和助手…</div>
          : (
            <div className={css.sidebarGroupSegments}>
              <section className={css.sidebarGroupSegment}>
                <h4 className={css.sidebarGroupSegmentTitle}>现有团队</h4>
                {renderPicker(rows.teams, '还没有团队')}
              </section>
              <section className={css.sidebarGroupSegment}>
                <h4 className={css.sidebarGroupSegmentTitle}>现有助手</h4>
                {renderPicker(rows.assistants, '还没有助手')}
              </section>
            </div>
          )}
        {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
        {failures !== undefined && (
          <div className={css.inlineError} role="alert">
            <div>分组已创建，以下条目没有移动成功：</div>
            {failures.map(failure => (
              <div key={failure.name}>「{failure.name}」：{failure.message}</div>
            ))}
          </div>
        )}
      </form>
    </AnimatedModal>
  )
}

function GroupDeleteDialog({
  name,
  onClose,
  onListChanged,
}: {
  name: string
  onClose: () => void
  onListChanged: (groups: string[]) => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const remove = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      onListChanged(await callAgentTeam('sidebar.groups.delete', { name }))
      onClose()
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
      title="删除分组"
      closeLabel="关闭"
      className={css.sidebarGroupDialog ?? ''}
      footer={(
        <>
          <Button variant="outline" type="button" disabled={busy} onClick={onClose}>取消</Button>
          <button
            type="button"
            className={`${css.dangerButton} ${css.confirmDangerButton}`}
            disabled={busy}
            onClick={() => { void remove() }}
          >
            {busy ? '删除中…' : '删除分组'}
          </button>
        </>
      )}
    >
      <div className={css.sidebarGroupConfirm}>
        <span className={css.sidebarGroupConfirmIcon} aria-hidden="true">
          <IconTrashOutlineRegular size={16} />
        </span>
        <div>
          <strong>确定删除「{name}」？</strong>
          <p>组内的团队和助手会回到「未分组」，它们本身不受影响。</p>
        </div>
        {error !== undefined && <div className={`${css.inlineError} ${css.fullWidth}`} role="alert">{error}</div>}
      </div>
    </AnimatedModal>
  )
}

function GroupMoveDialog({
  title,
  current,
  groups,
  apply,
  onClose,
}: {
  title: string
  current?: string
  groups: string[]
  apply: (group: string | undefined) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // Only groups that already exist are offered: a dialog that could type a new
  // name would create labels nobody can see or delete from the header.
  const options: Array<{ id: string; label: string; group?: string }> = [
    // Prefixed ids: a group may be named anything, including "不分组".
    { id: 'option:none', label: '不分组' },
    ...groups.map(group => ({ id: `option:${group}`, label: group, group })),
  ]
  const pick = async (group: string | undefined): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await apply(group)
      onClose()
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
      title={title}
      description={groups.length === 0
        ? '还没有分组，先在侧栏底部新建一个分组。'
        : '选择一个已有分组，或用「不分组」移出当前分组。'}
      closeLabel="关闭"
      className={css.sidebarGroupDialog ?? ''}
      footer={<Button variant="outline" type="button" disabled={busy} onClick={onClose}>取消</Button>}
    >
      <div className={css.sidebarGroupChoices} role="group" aria-label="选择分组">
        {options.map(option => {
          const selected = option.group === undefined
            ? current === undefined
            : current === option.group
          return (
            <button
              key={option.id}
              type="button"
              className={`${css.sidebarGroupChoice} ${selected ? css.sidebarGroupChoiceActive : ''}`}
              aria-pressed={selected}
              disabled={busy}
              onClick={() => { void pick(option.group) }}
            >
              <span className={css.sidebarGroupChoiceLabel}>{option.label}</span>
              {selected && <IconCheckOutlineRegular size={14} />}
            </button>
          )
        })}
      </div>
      {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
    </AnimatedModal>
  )
}

/**
 * The header `+`: a checklist of who belongs to one group. It offers the group's
 * current members and everything still ungrouped — never a row of another group,
 * because this is a membership edit, not a bulk re-assignment. Saving submits the
 * difference only, so untouched rows are not rewritten.
 */
function GroupMembersDialog({
  group,
  onClose,
  onChanged,
}: {
  group: string
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  const [teams, setTeams] = useState<TeamView[]>([])
  const [assistants, setAssistants] = useState<AssistantInstanceView[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      callAgentTeam('team.list'),
      callAgentTeam('assistant.instance.list'),
    ]).then(([teamPage, assistantPage]) => {
      if (cancelled) return
      setTeams(teamPage.items)
      setAssistants(assistantPage.items)
      const members = [
        ...teamPage.items.filter(team => team.group === group).map(team => team.id),
        ...assistantPage.items.filter(item => item.group === group).map(item => item.id),
      ]
      setChecked(new Set(members))
    }).catch(cause => {
      if (!cancelled) setError(messageOf(cause))
    }).finally(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [group])

  const teamCandidates = useMemo(
    () => groupMembershipCandidates<TeamView>(group, teams, team => ({
      id: team.id,
      name: team.name,
      ...(team.group === undefined ? {} : { group: team.group }),
    })),
    [group, teams],
  )
  const assistantCandidates = useMemo(
    () => groupMembershipCandidates<AssistantInstanceView>(group, assistants, item => ({
      id: item.id,
      name: assistantInstanceName(item),
      ...(item.group === undefined ? {} : { group: item.group }),
    })),
    [assistants, group],
  )
  const teamIds = useMemo(() => new Set(teams.map(team => team.id)), [teams])
  const all = useMemo(
    () => [...teamCandidates, ...assistantCandidates],
    [assistantCandidates, teamCandidates],
  )
  const changes = useMemo(
    () => groupMembershipChanges(group, all, checked),
    [all, checked, group],
  )
  const dirty = changes.add.length > 0 || changes.remove.length > 0

  const toggle = useCallback((id: string): void => {
    setChecked(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const save = async (): Promise<void> => {
    if (busy || !dirty) return
    setBusy(true)
    setError(undefined)
    try {
      const write = async (rows: readonly SidebarGroupCandidate[], next: string | undefined): Promise<void> => {
        for (const row of rows) {
          if (teamIds.has(row.id)) {
            await callAgentTeam('team.group.set', { teamId: row.id, group: next ?? null })
          } else {
            await callAgentTeam('assistant.instance.update', {
              id: row.id,
              value: { group: next ?? '' },
            })
          }
        }
      }
      await write(changes.add, group)
      await write(changes.remove, undefined)
      onChanged()
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const renderRows = (
    rows: readonly SidebarGroupCandidate[],
    empty: string,
  ): JSX.Element => (
    rows.length === 0
      ? <div className={css.sidebarPartitionEmpty}>{empty}</div>
      : (
        <div className={css.sidebarGroupCheckList}>
          {rows.map(row => {
            const on = checked.has(row.id)
            return (
              <button
                key={row.id}
                type="button"
                className={`${css.sidebarGroupCheckRow} ${on ? css.sidebarGroupCheckRowOn : ''}`}
                role="checkbox"
                aria-checked={on}
                disabled={busy}
                onClick={() => { toggle(row.id) }}
              >
                <span className={`${css.sidebarGroupCheckBox} ${on ? css.sidebarGroupCheckBoxOn : ''}`} aria-hidden="true">
                  {on && <IconCheckOutlineRegular size={11} />}
                </span>
                <span className={css.sidebarGroupCheckLabel}>{row.name}</span>
              </button>
            )
          })}
        </div>
      )
  )

  return (
    <AnimatedModal
      open
      onClose={() => { if (!busy) onClose() }}
      title={`「${group}」的条目`}
      description="勾选要放进这个分组的团队和助手，取消勾选即移回未分组。"
      closeLabel="关闭"
      className={css.sidebarGroupDialog ?? ''}
      contentClassName={css.sidebarGroupDialogContent ?? ''}
      footer={(
        <>
          <Button variant="outline" type="button" disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" type="button" disabled={busy || !dirty} onClick={() => { void save() }}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      )}
    >
      {!loaded
        ? <div className={css.dialogEmpty}>正在读取…</div>
        : (
          <div className={css.sidebarGroupSegments}>
            <section className={css.sidebarGroupSegment}>
              <h4 className={css.sidebarGroupSegmentTitle}>团队</h4>
              {renderRows(teamCandidates, '没有可加入的团队')}
            </section>
            <section className={css.sidebarGroupSegment}>
              <h4 className={css.sidebarGroupSegmentTitle}>助手</h4>
              {renderRows(assistantCandidates, '没有可加入的助手')}
            </section>
          </div>
        )}
      {error !== undefined && (
        <div className={css.inlineError} role="alert">
          <IconWarningOutlineRegular size={12} /> {error}
        </div>
      )}
    </AnimatedModal>
  )
}
