import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import {
  Button,
  Checkbox,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  IconDownloadOutlineRegular,
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconListPenOutlineRegular,
  IconPlusOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconTrashOutlineRegular,
  IconUsersOutlineRegular,
  IconWarningOutlineRegular,
  Menu,
  writeClipboard,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import { assistantAvatarSource, assistantInstanceName } from './assistant-instances.js'
import { PERMISSION_LABELS } from './labels.js'
import { MemberAvatar } from './member-avatar.js'
import {
  modelControlEffortRow,
  modelControlOptions,
  modelControlPick,
  type ModelControlModel,
} from './model-control.js'
import { SelectControl } from './select-control.js'
import type { SelectControlOption } from './select-control.js'
import { AnimatedModal } from './shared.js'
import {
  SIDEBAR_GROUP_BRIEF_MAX_CHARS,
  SIDEBAR_GROUP_MAX_CHARS,
  UNGROUPED_PARTITION_ID,
  GROUP_SHARE_MAX_DOCUMENT_BYTES,
  applyGroupBatch,
  groupBatchLevelNeedsDefault,
  groupBatchLevels,
  groupBatchMembers,
  groupBatchModelKey,
  groupBatchModelRefs,
  groupBatchPatch,
  groupBatchPendingMembers,
  groupBatchRoundResults,
  groupCreateRows,
  groupCreateSelection,
  groupExportFileName,
  groupImportPlanLines,
  groupMembershipCandidates,
  groupMembershipChanges,
  insertGroupOrder,
  parseGroupExportText,
  resolveDropTarget,
  revokeDownloadUrlLater,
  sidebarGroupBriefError,
  sidebarGroupBriefUsage,
  sidebarGroupNameError,
  toggleGroupCreateSelection,
  type GroupBatchLevel,
  type GroupBatchMember,
  type GroupBatchResult,
  type GroupCreateRow,
  type GroupImportPlanLine,
  type SidebarDropHalf,
  type SidebarDropOverKind,
  type SidebarGroupCandidate,
} from './sidebar-groups.js'
import css from './AgentTeam.module.css'
import type {
  AssistantInstanceView,
  CatalogView,
  TeamView,
} from '../transport/contracts.js'
import type {
  GroupImportPreview,
  GroupImportResult,
  GroupImportRowStatus,
} from '../domain/group-share.js'

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
 * One group section of the sidebar: a collapsible header whose trailing `⋯`
 * menu holds every group operation (create/import everywhere; membership,
 * rename, delete and ordering on a named group). The button stays invisible
 * (but focusable) until the header is hovered or holds focus on the wide
 * sidebar, and is always on in the touch drawer. `opacity` — not `display` —
 * keeps it in the tab order.
 */
export function SidebarGroupPartition({
  label,
  count,
  collapsed,
  onToggle,
  menuItems,
  onSelect,
  drag,
  children,
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
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
        {hasMenu && (
          <span className={css.sidebarPartitionActions}>
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

/**
 * The group header's one `⋯` menu. 新建分组 / 导入分组 live here for every
 * section — including 未分组, which has no rename/delete of its own — so no
 * separate list-level rows are needed anywhere. A named group reuses the shared
 * item list verbatim (brief, batch, export/import, rename, delete, ordering).
 */
export function sidebarGroupActionItems(
  groups: readonly string[],
  group: string | undefined,
): MenuEntry[] {
  if (group === undefined) {
    return [
      { id: 'create', label: '新建分组', icon: <IconPlusOutlineRegular size={14} /> },
      { id: 'import', label: '导入分组', icon: <IconFolderOpenOutlineRegular size={14} /> },
    ]
  }
  return [
    { id: 'create', label: '新建分组', icon: <IconPlusOutlineRegular size={14} /> },
    { id: 'members', label: '添加成员', icon: <IconUsersOutlineRegular size={14} /> },
    ...sidebarGroupMenuItems(groups, group),
  ]
}

/**
 * The sidebar's one group dialog. Every entry point (a group header, a row menu,
 * the create row) opens the same modal with a different `kind`, so there is one
 * place that owns the transport calls and one place that shows their errors.
 */
export type SidebarGroupDialog =
  | { kind: 'create' }
  | { kind: 'brief'; name: string }
  | { kind: 'batch'; group: string }
  | { kind: 'export'; name: string }
  | { kind: 'import' }
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
  if (dialog.kind === 'batch') {
    return (
      <GroupBatchDialog
        group={dialog.group}
        onClose={onClose}
        onChanged={onChanged}
      />
    )
  }
  if (dialog.kind === 'export') {
    return <GroupExportDialog name={dialog.name} onClose={onClose} />
  }
  if (dialog.kind === 'import') {
    return (
      <GroupImportDialog
        onClose={onClose}
        onListChanged={onListChanged}
        onChanged={onChanged}
      />
    )
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

/** Header menu of one group: its brief, the batch settings, export/import, rename, delete, and the two order moves. */
export function sidebarGroupMenuItems(
  groups: readonly string[],
  group: string,
): MenuEntry[] {
  const index = groups.indexOf(group)
  return [
    { id: 'brief', label: '编辑分组简报', icon: <IconListPenOutlineRegular size={14} /> },
    { id: 'batch', label: '批量设置…', icon: <IconSlidersTwoOutlineRegular size={14} /> },
    { id: 'export', label: '导出分组', icon: <IconDownloadOutlineRegular size={14} /> },
    { id: 'import', label: '导入分组', icon: <IconFolderOpenOutlineRegular size={14} /> },
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
              最多 {SIDEBAR_GROUP_BRIEF_MAX_CHARS.toLocaleString('en-US')} 个字符（约 24 KB）。超出时不会截断，而是拒绝保存。
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

/** A picker row: one label over the shared control, with an optional hint. */
function GroupBatchField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <div className={css.groupBatchField}>
      <span className={css.groupBatchLabel}>{label}</span>
      {children}
      {hint !== undefined && hint !== '' && <span className={css.groupBatchHint}>{hint}</span>}
    </div>
  )
}

/**
 * 批量设置: the group's assistants, three pickers, and one row per assistant
 * saying what happened. Membership comes from a fresh `assistant.instance.list`,
 * never from the rendered section — a typed sidebar search hides rows, and a
 * hidden row must not silently drop out of the batch. Every assistant is written
 * on its own, so a refusal keeps its reason and the writes that already landed
 * stay landed: there is no rollback.
 */
function GroupBatchDialog({
  group,
  onClose,
  onChanged,
}: {
  group: string
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  const [catalog, setCatalog] = useState<CatalogView>()
  const [members, setMembers] = useState<GroupBatchMember[]>([])
  const [groupTeams, setGroupTeams] = useState<number>()
  const [loaded, setLoaded] = useState(false)
  const [modelRow, setModelRow] = useState('')
  const [thinkingRow, setThinkingRow] = useState('')
  const [permission, setPermission] = useState('')
  const [levels, setLevels] = useState<GroupBatchLevel[]>([])
  // The levels each read model serves. The union feeds the menu; this map is
  // what lets a model change drop a level the new model cannot serve.
  const [effortsByModel, setEffortsByModel] = useState<
    ReadonlyMap<string, readonly GroupBatchLevel[]>
  >(() => new Map())
  const [levelsLoading, setLevelsLoading] = useState(false)
  const [levelsError, setLevelsError] = useState<string>()
  const [membersError, setMembersError] = useState<string>()
  const [catalogError, setCatalogError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<GroupBatchResult[]>()
  const [reloadToken, setReloadToken] = useState(0)

  // Three independent reads, settled separately on purpose: a failed catalog
  // must not empty the roster (that reads as "this group has no assistants"),
  // and a failed roster must not leave the dialog claiming both.
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setMembersError(undefined)
    setCatalogError(undefined)
    void Promise.allSettled([
      callAgentTeam('catalog.get'),
      callAgentTeam('assistant.instance.list'),
      callAgentTeam('team.list'),
    ]).then(([catalogResult, memberResult, teamResult]) => {
      if (cancelled) return
      if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value)
      else setCatalogError(messageOf(catalogResult.reason))
      if (memberResult.status === 'fulfilled') {
        setMembers(groupBatchMembers(group, memberResult.value.items, item => ({
          id: item.id,
          name: assistantInstanceName(item),
          ...(item.group === undefined ? {} : { group: item.group }),
          status: item.status,
          provider: item.assistantSnapshot.provider,
          model: item.assistantSnapshot.model,
        })))
      } else {
        setMembersError(messageOf(memberResult.reason))
      }
      // Teams are only counted, never written: the empty-state copy says so.
      setGroupTeams(teamResult.status === 'fulfilled'
        ? teamResult.value.items.filter(team => team.group === group).length
        : undefined)
    }).finally(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [group, reloadToken])

  const modelPick = modelRow === '' ? undefined : modelControlPick(modelRow)
  const pickedProvider = modelPick?.provider ?? ''
  const pickedModel = modelPick?.model ?? ''
  // A thinking level is a property of the assistants' models, not of the batch:
  // the menu is the union over every model the group uses (plus a model picked
  // here), so a mixed-model group can still get one level in one apply.
  const modelRefs = useMemo(() => groupBatchModelRefs(
    members,
    pickedProvider === '' || pickedModel === ''
      ? undefined
      : { provider: pickedProvider, model: pickedModel },
  ), [members, pickedModel, pickedProvider])

  useEffect(() => {
    let cancelled = false
    if (modelRefs.length === 0) {
      setLevels([])
      setEffortsByModel(new Map())
      setLevelsError(undefined)
      setLevelsLoading(false)
      return () => { cancelled = true }
    }
    setLevelsLoading(true)
    setLevelsError(undefined)
    void Promise.allSettled(modelRefs.map(ref => (
      callAgentTeam('catalog.model.get', { provider: ref.provider, model: ref.model })
    ))).then(settled => {
      if (cancelled) return
      const byModel = new Map<string, readonly GroupBatchLevel[]>()
      modelRefs.forEach((ref, index) => {
        const result = settled[index]
        // A rejected read stays out of the map: unknown is not "no levels",
        // and the narrowing rule below must not act on it.
        if (result?.status !== 'fulfilled') return
        byModel.set(groupBatchModelKey(ref), result.value.reasoning?.efforts ?? [])
      })
      setEffortsByModel(byModel)
      setLevels(groupBatchLevels(settled.map(result => (
        result.status === 'fulfilled' ? result.value.reasoning?.efforts ?? [] : []
      ))))
      const missing = settled.filter(result => result.status === 'rejected').length
      setLevelsError(missing === 0
        ? undefined
        : `有 ${missing} 个模型的思考档位没读出来，列表可能不完整。`)
    }).finally(() => {
      if (!cancelled) setLevelsLoading(false)
    })
    return () => { cancelled = true }
  }, [modelRefs])

  const modelOptions: SelectControlOption[] = useMemo(() => {
    const rows: ModelControlModel[] = (catalog?.providers ?? []).flatMap(provider => (
      (catalog?.models[provider.id] ?? []).map(model => ({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        label: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      }))
    ))
    return [{ value: '', label: '保持不变' }, ...modelControlOptions(rows, undefined)]
  }, [catalog])

  // The union is offered whatever model is picked, so a thinking-only batch on
  // a mixed-model group is a normal case instead of a disabled control. The
  // clearing row says "模型默认" without naming one: each assistant falls back
  // to its own model's default.
  const thinkingOptions: SelectControlOption[] = useMemo(() => [
    { value: '', label: '保持不变' },
    { value: modelControlEffortRow(''), label: '模型默认' },
    ...levels.map(level => ({
      value: modelControlEffortRow(level.id),
      label: level.name,
    })),
  ], [levels])

  const permissionOptions: SelectControlOption[] = useMemo(() => [
    { value: '', label: '保持不变' },
    ...(catalog?.permissionPresets ?? []).map(option => ({
      value: option.value,
      label: PERMISSION_LABELS[option.value] ?? option.name,
    })),
  ], [catalog])

  const thinkingPick = thinkingRow === '' ? undefined : modelControlPick(thinkingRow)
  const thinkingEffort = thinkingPick?.reasoningEffort
  // Every assistant receives the same model+level pair, so an unsupported level
  // left over from the previous model would be refused on every row at once.
  // Narrow it to 模型默认 as soon as the newly picked model's levels are known.
  useEffect(() => {
    if (pickedProvider === '' || pickedModel === '') return
    const efforts = effortsByModel.get(groupBatchModelKey({
      provider: pickedProvider,
      model: pickedModel,
    }))
    if (groupBatchLevelNeedsDefault(thinkingEffort, efforts)) {
      setThinkingRow(modelControlEffortRow(''))
    }
  }, [effortsByModel, pickedModel, pickedProvider, thinkingEffort])
  const patch = groupBatchPatch({
    ...(pickedProvider === '' || pickedModel === ''
      ? {}
      : { model: { provider: pickedProvider, model: pickedModel } }),
    ...(thinkingEffort === undefined ? {} : { reasoningEffort: thinkingEffort }),
    ...(permission === '' ? {} : { permissionPresetId: permission }),
  })
  // The narrowing above runs on the picked model's levels, which arrive async:
  // until the read settles an early click could still send a pair that model
  // cannot serve. The level '' (模型默认) needs no such wait.
  const levelsPending = levelsLoading
    && pickedProvider !== ''
    && pickedModel !== ''
    && thinkingEffort !== undefined
    && thinkingEffort !== ''
  const done = results !== undefined
  const pending = groupBatchPendingMembers(members, results)
  const failures = results?.filter(result => result.error !== undefined) ?? []
  const failureOf = new Map(failures.map(failure => [failure.id, failure.error ?? '']))
  const resultOf = new Map((results ?? []).map(result => [result.id, result]))
  const unchanged = results?.filter(result => result.unchanged === true).length ?? 0
  const updated = (results?.length ?? 0) - failures.length - unchanged

  const apply = async (): Promise<void> => {
    if (busy || patch === undefined || pending.length === 0) return
    setBusy(true)
    // applyGroupBatch never throws for a refused row, so there is no catch here:
    // every outcome — including the Host's reason — comes back as a result row.
    const written = await applyGroupBatch(pending, patch, (id, value) => (
      callAgentTeam('assistant.instance.update', { id, value })
    ))
    // A retry writes only the rows still pending; the rows an earlier apply
    // landed read 未变化, so they are never counted as changed a second time.
    setResults(groupBatchRoundResults(members, written))
    setBusy(false)
    onChanged()
  }

  return (
    <AnimatedModal
      open
      onClose={() => { if (!busy) onClose() }}
      title={`批量设置「${group}」`}
      description="只改这个分组里的助手。模型、思考模式和权限逐台写入；被拒绝的那台保持原样，已经写入的不会回滚。"
      closeLabel="关闭"
      className={css.sidebarGroupDialog ?? ''}
      contentClassName={css.sidebarGroupDialogContent ?? ''}
      footer={loaded && (members.length === 0 || membersError !== undefined)
        ? (
          <Button variant="primary" type="button" onClick={onClose}>
            {done ? '完成' : '关闭'}
          </Button>
        )
        : (
          <>
            <Button variant="outline" type="button" disabled={busy} onClick={onClose}>
              {done ? '完成' : '取消'}
            </Button>
            {(!done || pending.length > 0) && (
              <Button
                variant="primary"
                type="button"
                disabled={busy || patch === undefined || pending.length === 0 || levelsPending}
                onClick={() => { void apply() }}
              >
                {busy
                  ? '应用中…'
                  : done ? `重试 ${pending.length} 个被拒绝的助手` : `应用到 ${members.length} 个助手`}
              </Button>
            )}
          </>
        )}
    >
      {!loaded
        ? <div className={css.dialogEmpty}>正在读取分组里的助手…</div>
        : membersError !== undefined
          ? (
            // A failed roster read is not an empty group: saying "no assistants"
            // here would be a lie the user cannot tell apart from the truth.
            <div className={css.groupBatchNotice} role="alert" data-dsh-group-batch-failed-load>
              <span>读取助手列表失败：{membersError}</span>
              <Button
                variant="outline"
                type="button"
                onClick={() => { setReloadToken(current => current + 1) }}
              >
                重试
              </Button>
            </div>
          )
          : members.length === 0
            ? (
              <div className={css.dialogEmpty} data-dsh-group-batch-empty>
                {groupTeams === undefined || groupTeams === 0
                  ? `「${group}」里还没有助手。用分组标题旁的 + 添加助手；批量设置只改助手，团队不受影响。`
                  : `「${group}」里有 ${groupTeams} 个团队，没有助手。批量设置只改助手，团队不受影响。`}
              </div>
            )
            : (
              <div className={css.groupBatchForm} data-dsh-group-batch>
                <div className={css.groupBatchFields}>
                  <GroupBatchField
                    label="模型"
                    hint="模型和它的提供方一起写入，避免出现只有一半的模型引用。"
                  >
                    <SelectControl
                      ariaLabel="模型"
                      value={modelRow}
                      options={modelOptions}
                      disabled={busy}
                      onChange={setModelRow}
                    />
                  </GroupBatchField>
                  {/* 思考模式 is its own axis: the menu is the union over the
                      group's models, so a mixed-model group can pick one level
                      without touching any model. */}
                  <GroupBatchField
                    label="思考模式"
                    hint={levelsLoading
                      ? '正在读取组内模型的思考档位…'
                      : levelsError !== undefined
                        ? levelsError
                        : levels.length === 0
                          ? '组内助手用的模型都没有可选的思考档位。'
                          : '档位来自组内各模型的并集；不支持所选档位的助手会被单独拒绝。'}
                  >
                    <SelectControl
                      ariaLabel="思考模式"
                      value={thinkingRow}
                      options={thinkingOptions}
                      disabled={busy}
                      onChange={setThinkingRow}
                    />
                  </GroupBatchField>
                  <GroupBatchField
                    label="权限"
                    hint="权限预设必须存在于当前目录；不存在的会被 Host 拒绝。"
                  >
                    <SelectControl
                      ariaLabel="权限"
                      value={permission}
                      options={permissionOptions}
                      disabled={busy}
                      onChange={setPermission}
                    />
                  </GroupBatchField>
                  {catalogError !== undefined && (
                    <p className={css.groupBatchHint} data-dsh-group-batch-catalog-error>
                      读取模型/权限目录失败：{catalogError}。现在只能改思考模式；重试后可以选模型和权限。
                    </p>
                  )}
                  {patch === undefined && (
                    <p className={css.groupBatchHint}>至少选择一项要修改的设置。</p>
                  )}
                </div>
                <section className={css.sidebarGroupSegment}>
                  <h4 className={css.sidebarGroupSegmentTitle}>
                    组内助手（{members.length}）
                    {done && (
                      <span className={css.groupBatchSummary} role="status">
                        已更新 {updated} 个，{unchanged > 0 && `未变化 ${unchanged} 个，`}{failures.length} 个被拒绝
                      </span>
                    )}
                  </h4>
                  <div className={css.groupBatchList}>
                    {members.map(member => {
                      const failure = failureOf.get(member.id)
                      const result = resultOf.get(member.id)
                      return (
                        <div
                          key={member.id}
                          className={css.groupBatchRow}
                          data-dsh-group-batch-row={member.id}
                        >
                          <span className={css.groupBatchName}>{member.name}</span>
                          {done && (failure !== undefined
                            ? (
                              <span
                                className={css.groupBatchFailed}
                                title={failure}
                                data-dsh-group-batch-failed
                              >
                                {failure}
                              </span>
                            )
                            : result?.unchanged === true
                              // A retry skipped this row because it already landed;
                              // calling that 已更新 again would count it twice.
                              ? <span className={css.groupBatchHint}>未变化</span>
                              : <span className={css.groupBatchOk}>已更新</span>)}
                        </div>
                      )
                    })}
                  </div>
                  {failures.length > 0 && (
                    <p className={css.groupBatchHint}>
                      被拒绝的助手保持原来的设置；它们各自的拒绝原因就在上面那一行。
                    </p>
                  )}
                </section>
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

const GROUP_IMPORT_FIELD_ID = 'dsh-team-mode-group-import-source'

const GROUP_SHARE_KIND_LABELS: Record<GroupImportPlanLine['kind'], string> = {
  group: '分组',
  assistant: '助手',
  template: '模板',
  team: '团队',
}

const GROUP_SHARE_ACTION_LABELS: Record<GroupImportPlanLine['action'], string> = {
  create: '新建',
  reuse: '复用',
  skip: '跳过',
}

const GROUP_SHARE_STATUS_LABELS: Record<GroupImportRowStatus, string> = {
  created: '已创建',
  reused: '已复用',
  skipped: '已跳过',
  rejected: '已拒绝',
}

const GROUP_SHARE_ACTION_CLASS: Record<GroupImportPlanLine['action'], string> = {
  create: css.groupShareStateCreated ?? '',
  reuse: css.groupShareStateReused ?? '',
  skip: css.groupShareStateSkipped ?? '',
}

const GROUP_SHARE_STATUS_CLASS: Record<GroupImportRowStatus, string> = {
  created: css.groupShareStateCreated ?? '',
  reused: css.groupShareStateReused ?? '',
  skipped: css.groupShareStateSkipped ?? '',
  rejected: css.groupShareStateRejected ?? '',
}

/**
 * 导出分组: one read-only transport call and the portable JSON itself, with copy
 * and download. The notes above the document say what the format leaves out
 * (avatar photos, prompts) before the user wonders why the file is smaller than
 * the group looks; nothing here writes anything.
 */
function GroupExportDialog({
  name,
  onClose,
}: {
  name: string
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setText('')
    setLoaded(false)
    setCopied(false)
    setError(undefined)
    void callAgentTeam('sidebar.groups.export', { name }).then(value => {
      if (cancelled) return
      setText(JSON.stringify(value, null, 2))
    }).catch(cause => {
      if (!cancelled) setError(messageOf(cause))
    }).finally(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [name])

  const copy = async (): Promise<void> => {
    try {
      // The shipped helper falls back to the legacy path and reports whether the
      // text landed, so the button can say so instead of pretending.
      setCopied(await writeClipboard(text))
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = groupExportFileName(name)
    anchor.click()
    // Kept alive past the click: revoking in this task can cancel the download.
    revokeDownloadUrlLater(url)
  }

  const ready = loaded && text !== ''
  return (
    <AnimatedModal
      open
      onClose={onClose}
      title={`导出分组「${name}」`}
      description="导出可移植的分组 JSON：分组名称、简报和助手的可移植设定，不含任何会话、记忆或密钥。"
      closeLabel="关闭"
      className={css.sidebarGroupDialog ?? ''}
      contentClassName={css.sidebarGroupDialogContent ?? ''}
      footer={(
        <>
          <Button
            variant="outline"
            type="button"
            icon={<IconDownloadOutlineRegular size={14} />}
            disabled={!ready}
            onClick={download}
          >
            下载文件
          </Button>
          <Button
            variant="primary"
            type="button"
            icon={<IconCopyOutlineRegular size={14} />}
            disabled={!ready}
            onClick={() => { void copy() }}
          >
            {copied ? '已复制' : '复制 JSON'}
          </Button>
        </>
      )}
    >
      <div className={css.groupShareForm}>
        <p className={css.groupShareIntro}>
          这段 JSON 可以粘贴给别人，也可以保存成文件；导入时会在写入前先预览。
        </p>
        {!loaded
          ? <div className={css.dialogEmpty}>正在导出分组…</div>
          : text === ''
            ? (error === undefined
              ? <div className={css.dialogEmpty}>这个分组导出为空。</div>
              : null)
            : (
              <textarea
                className={`${css.input} ${css.groupShareJson}`}
                data-dsh-group-export-json
                readOnly
                rows={14}
                value={text}
                aria-label="分组导出 JSON"
                spellCheck={false}
                onFocus={event => { event.currentTarget.select() }}
              />
            )}
        <div className={css.groupShareNotes} data-dsh-group-export-omitted>
          <p>头像照片不会导出：导入的助手会回退到它的吉祥物或首字母。</p>
          <p>助手提示词（prompts）是本机记录，不随分组导出。</p>
          <p>会话、记忆、工作区路径和密钥从不写入这份文档。</p>
        </div>
        {copied && <div className={css.groupShareStatus} role="status">已复制到剪贴板。</div>}
        {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
      </div>
    </AnimatedModal>
  )
}

/**
 * 导入分组: paste a portable document or read one from a file, review the plan
 * (conflict suffixes, skipped rows and their reasons), then apply it.
 *
 * The preview and the apply send the exact same parsed object, and the apply
 * carries the previewed `planHash`: editing the text or switching the target
 * workspace drops the preview, so a write can never run against a plan the user
 * did not see.
 */
function GroupImportDialog({
  onClose,
  onListChanged,
  onChanged,
}: {
  onClose: () => void
  onListChanged: (groups: string[]) => void
  onChanged: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string>()
  const [workspaces, setWorkspaces] = useState<Array<{ id: string, title: string, path: string }>>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [workspaceError, setWorkspaceError] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const [preview, setPreview] = useState<{
    value: GroupImportPreview
    document: Record<string, unknown>
    workspaceId: string
  }>()
  const [result, setResult] = useState<GroupImportResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void callAgentTeam('catalog.get').then(catalog => {
      if (cancelled) return
      const usable = catalog.workspaces
        .filter(workspace => workspace.status === 'ok')
        .map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path }))
      setWorkspaces(usable)
      setWorkspaceId(current => (current === '' ? usable[0]?.id ?? '' : current))
    }).catch(cause => {
      if (!cancelled) setWorkspaceError(messageOf(cause))
    }).finally(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  const workspaceOptions: SelectControlOption[] = useMemo(
    () => workspaces.map(workspace => ({
      value: workspace.id,
      label: workspace.title === '' ? workspace.path : workspace.title,
      description: workspace.path,
    })),
    [workspaces],
  )

  // Any edit invalidates the reviewed plan: the fence only covers a document
  // and workspace the user actually looked at.
  const edit = (next: string, source?: string): void => {
    setText(next)
    setPreview(undefined)
    setError(undefined)
    if (source !== undefined) setFileName(source)
  }

  const readFile = async (file: File): Promise<void> => {
    setError(undefined)
    if (file.size > GROUP_SHARE_MAX_DOCUMENT_BYTES) {
      setError(`「${file.name}」有 ${file.size} 字节，超过 ${GROUP_SHARE_MAX_DOCUMENT_BYTES} 字节的导入上限`)
      return
    }
    try {
      edit(await file.text(), file.name)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const runPreview = async (): Promise<void> => {
    if (busy) return
    const parsed = parseGroupExportText(text)
    if (!parsed.ok) {
      setPreview(undefined)
      setError(parsed.error)
      return
    }
    if (workspaceId === '') {
      setError('请选择一个可用的 Workspace 作为导入目标')
      return
    }
    setBusy(true)
    setError(undefined)
    setPreview(undefined)
    try {
      const value = await callAgentTeam('sidebar.groups.import.preview', {
        document: parsed.document,
        workspaceId,
      })
      setPreview({ value, document: parsed.document, workspaceId })
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const runImport = async (): Promise<void> => {
    if (busy || preview === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const value = await callAgentTeam('sidebar.groups.import', {
        document: preview.document,
        workspaceId: preview.workspaceId,
        expectedPlanHash: preview.value.planHash,
      })
      setResult(value)
      // The import created a group, teams and Assistants: re-read the sections,
      // and adopt the Host's new group list instead of guessing where it went.
      onChanged()
      try {
        onListChanged(await callAgentTeam('sidebar.groups.list'))
      } catch {
        // The import already landed; the group shows up on the next read.
      }
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const sourceReady = text.trim() !== '' && workspaceId !== ''
  const planned = preview?.value

  const planRow = (line: GroupImportPlanLine): JSX.Element => (
    <div
      key={line.key}
      className={css.groupShareRow}
      data-dsh-group-import-row={line.key}
    >
      <span className={css.groupShareKind}>{GROUP_SHARE_KIND_LABELS[line.kind]}</span>
      <span className={css.groupShareName}>{line.name}</span>
      {line.plannedName !== line.name && (
        <span className={css.groupSharePlanned}>→ {line.plannedName}</span>
      )}
      <span className={GROUP_SHARE_ACTION_CLASS[line.action]}>
        {GROUP_SHARE_ACTION_LABELS[line.action]}
      </span>
      {line.detail !== undefined && <span className={css.groupShareDetail}>{line.detail}</span>}
      {line.note !== undefined && <span className={css.groupShareNote}>{line.note}</span>}
    </div>
  )

  return (
    <AnimatedModal
      open
      onClose={() => { if (!busy) onClose() }}
      title="导入分组"
      description="粘贴分组导出的 JSON，或选择一个文件。写入前先预览：同名分组会自动改用带后缀的新名字，这台机器上没有的设定会跳过并说明原因。"
      closeLabel="关闭"
      className={css.sidebarGroupDialog ?? ''}
      contentClassName={css.sidebarGroupDialogContent ?? ''}
      footer={result !== undefined
        ? <Button variant="primary" type="button" onClick={onClose}>关闭</Button>
        : (
          <>
            <Button variant="outline" type="button" disabled={busy} onClick={onClose}>取消</Button>
            {planned !== undefined && (
              <Button variant="outline" type="button" disabled={busy} onClick={() => { void runPreview() }}>
                重新预览
              </Button>
            )}
            <Button
              variant="primary"
              type="button"
              disabled={busy || !sourceReady || (!loaded && workspaceError === undefined)}
              onClick={() => { void (planned === undefined ? runPreview() : runImport()) }}
            >
              {busy
                ? (planned === undefined ? '预览中…' : '导入中…')
                : planned === undefined ? '预览导入' : '开始导入'}
            </Button>
          </>
        )}
    >
      <div className={css.groupShareForm}>
        {result === undefined
          ? (
            <>
              <div className={css.groupShareField}>
                <label className={css.groupShareLabel} htmlFor={GROUP_IMPORT_FIELD_ID}>
                  分组导出 JSON
                </label>
                <textarea
                  id={GROUP_IMPORT_FIELD_ID}
                  className={`${css.input} ${css.groupShareJson}`}
                  data-dsh-group-import-source
                  data-modal-autofocus
                  rows={8}
                  value={text}
                  placeholder="把导出的 JSON 粘贴到这里…"
                  aria-label="分组导出 JSON"
                  spellCheck={false}
                  disabled={busy}
                  onChange={event => { edit(event.target.value) }}
                />
              </div>
              <div className={css.groupShareActions}>
                <input
                  className={css.groupShareFile}
                  data-dsh-group-import-file
                  type="file"
                  accept=".json,application/json"
                  aria-label="选择分组导出文件"
                  disabled={busy}
                  onChange={event => {
                    const file = event.currentTarget.files?.[0]
                    // Reset first, so choosing the same file twice still fires.
                    event.currentTarget.value = ''
                    if (file !== undefined) void readFile(file)
                  }}
                />
                {fileName !== undefined && (
                  <span className={css.groupShareHint}>已读入「{fileName}」</span>
                )}
              </div>
              <p className={css.groupShareNote}>
                提示词（prompts）、会话、记忆和头像照片都不在导入范围内；导入只读取你提供的这份 JSON。
              </p>
              {!loaded
                ? <div className={css.dialogEmpty}>正在读取可用的 Workspace…</div>
                : workspaceError !== undefined
                  ? <div className={css.inlineError} role="alert">{workspaceError}</div>
                  : workspaces.length === 0
                    ? (
                      <div className={css.groupShareHint} data-dsh-group-import-no-workspace>
                        没有可用的 Workspace：导入需要先打开或新建一个工作区。
                      </div>
                    )
                    : (
                      <div className={css.groupShareField}>
                        <span className={css.groupShareLabel}>导入到 Workspace</span>
                        <SelectControl
                          value={workspaceId}
                          options={workspaceOptions}
                          ariaLabel="导入到 Workspace"
                          disabled={busy}
                          onChange={next => {
                            setWorkspaceId(next)
                            setPreview(undefined)
                          }}
                        />
                      </div>
                    )}
              {planned !== undefined && (
                <section className={css.groupShareSection} data-dsh-group-import-preview>
                  <h4 className={css.groupShareTitle}>导入预览</h4>
                  <p className={css.groupShareMeta}>
                    分组「{planned.group.requested}」→「<span data-dsh-group-import-planned>{planned.group.plannedName}</span>」
                    {planned.group.renamed && (
                      <span className={css.groupShareSuffix} data-dsh-group-import-renamed>
                        同名冲突，改用后缀名
                      </span>
                    )}
                  </p>
                  <p className={css.groupShareMeta} data-dsh-group-import-counts>
                    助手 {planned.counts.assistants} · 模板 {planned.counts.templates}
                    {' · '}团队 {planned.counts.teams}（成员 {planned.counts.members}）
                    {' · '}跳过 {planned.counts.skipped}
                  </p>
                  <div className={css.groupShareRows}>
                    {groupImportPlanLines(planned).map(planRow)}
                  </div>
                  {planned.warnings.length > 0 && (
                    <ul className={css.groupShareWarnings} data-dsh-group-import-warnings>
                      {planned.warnings.map(warning => <li key={warning}>{warning}</li>)}
                    </ul>
                  )}
                  {[...planned.skills, ...planned.mcpServers]
                    .filter(reference => !reference.available).length > 0 && (
                    <p className={css.groupShareUnavailable} data-dsh-group-import-unavailable>
                      这台机器上没有
                      {' '}
                      {[...planned.skills, ...planned.mcpServers]
                        .filter(reference => !reference.available)
                        .map(reference => reference.name)
                        .join('、')}
                      ，导入时会从相应助手上去掉。
                    </p>
                  )}
                  <p className={css.groupShareHint}>
                    点「开始导入」才会写入；取消不会改动任何分组、助手或团队。
                  </p>
                </section>
              )}
            </>
          )
          : (
            <section className={css.groupShareSection} data-dsh-group-import-result>
              <h4 className={css.groupShareTitle}>导入结果</h4>
              <p className={css.groupShareMeta}>
                分组「<span data-dsh-group-import-result-name>{result.groupName}</span>」
              </p>
              <p className={css.groupShareMeta} data-dsh-group-import-outcome>
                已创建 {result.counts.created} · 已复用 {result.counts.reused}
                {' · '}已跳过 {result.counts.skipped} · 已拒绝 {result.counts.rejected}
              </p>
              <div className={css.groupShareRows}>
                {result.rows.map((row, index) => (
                  <div
                    key={`${row.kind}:${row.name}:${index}`}
                    className={css.groupShareRow}
                    data-dsh-group-import-result-row={`${row.kind}:${row.name}`}
                  >
                    <span className={css.groupShareKind}>{GROUP_SHARE_KIND_LABELS[row.kind]}</span>
                    <span className={css.groupShareName}>{row.name}</span>
                    {row.plannedName !== undefined && row.plannedName !== row.name && (
                      <span className={css.groupSharePlanned}>→ {row.plannedName}</span>
                    )}
                    <span className={GROUP_SHARE_STATUS_CLASS[row.status]}>
                      {GROUP_SHARE_STATUS_LABELS[row.status]}
                    </span>
                    {row.reason !== undefined && (
                      <span className={css.groupShareNote}>{row.reason}</span>
                    )}
                  </div>
                ))}
              </div>
              {result.warnings.length > 0 && (
                <ul className={css.groupShareWarnings} data-dsh-group-import-result-warnings>
                  {result.warnings.map(warning => <li key={warning}>{warning}</li>)}
                </ul>
              )}
            </section>
          )}
        {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
      </div>
    </AnimatedModal>
  )
}

