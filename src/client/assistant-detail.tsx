import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  DisclosureRow,
  IconDatabaseOutlineRegular,
  IconEditOutlineRegular,
  IconFlatListOutlineRegular,
  IconInfoOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconShieldOutlineRegular,
  IconSlidersTwoOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import {
  assistantAvatarSource,
  assistantInstanceName,
} from './assistant-instances.js'
import { AssistantSettingsDialog } from './assistant-settings-dialog.js'
import {
  assistantInstanceStatusLabel,
  assistantMemoryView,
  PERMISSION_LABELS,
  type MemoryPanelView,
} from './labels.js'
import { MemberAvatar } from './member-avatar.js'
import { openAssistantSession, selectAssistant, useAgentTeamUi } from './store.js'
import css from './AgentTeam.module.css'
import type { AssistantInstanceView } from '../transport/contracts.js'

/**
 * The page type this plugin owns on the host's right Sidebar.
 *
 * Both constants are chosen against the contract note
 * `docs/superpowers/notes/2026-10-26-sidebar-right.md`: `kind` is an open string
 * that no shipped type uses, and `id` is a package name because it is also the
 * key the body registers under in `sidebar.right.pane.tab`.
 */
export const DETAIL_TAB_KIND = 'team-mode'
export const DETAIL_TAB_ID = '@limeng/dsh-team-mode/detail'
export const DETAIL_TAB_TITLE = '助手详情'

/** The one instruction the pane shows before a helper is chosen on the left. */
export const DETAIL_EMPTY_TEXT = '从左侧选择一个助手'

export type AssistantDetailSectionId =
  | 'overview'
  | 'identity'
  | 'model'
  | 'permission'
  | 'persona'
  | 'memory'
  | 'history'

/** The four read-only blocks, all read from one `assistant.instance.list` row. */
export type AssistantDetailFactSectionId = 'overview' | 'identity' | 'model' | 'permission'

export interface AssistantDetailFact {
  label: string
  value: string
}

export interface AssistantDetailSection {
  id: AssistantDetailFactSectionId
  title: string
  facts: AssistantDetailFact[]
}

/**
 * Sessions the row can open: the main Session plus every visible thread. Retired
 * ids are history, so they are deliberately not counted.
 */
export function assistantBoundSessionCount(
  instance: Pick<AssistantInstanceView, 'mainSessionId' | 'threadSessionIds'>,
): number {
  return (instance.mainSessionId === undefined ? 0 : 1) + (instance.threadSessionIds?.length ?? 0)
}

/**
 * The four read-only blocks of the panel, as plain data.
 *
 * Everything here is a field of one `assistant.instance.list` row — no second
 * read, no model-catalog lookup, no inferred copy. Keeping it pure is what lets
 * a test pin the panel's content without a DOM or a fetch.
 */
export function assistantDetailSections(instance: AssistantInstanceView): AssistantDetailSection[] {
  const snapshot = instance.assistantSnapshot
  return [
    {
      id: 'overview',
      title: '概览',
      facts: [
        { label: '名称', value: assistantInstanceName(instance) },
        { label: '状态', value: assistantInstanceStatusLabel(instance.status) },
        { label: '所属分组', value: instance.group ?? '未分组' },
        { label: '绑定会话数', value: String(assistantBoundSessionCount(instance)) },
      ],
    },
    {
      id: 'identity',
      title: '身份',
      facts: [
        { label: '名称', value: assistantInstanceName(instance) },
        {
          label: '头像',
          value: assistantAvatarSource(instance) === undefined ? '首字头像' : '自定义头像',
        },
      ],
    },
    {
      id: 'model',
      title: '模型',
      facts: [
        { label: 'Provider', value: snapshot.provider },
        { label: 'Model', value: snapshot.model },
        { label: '推理强度', value: snapshot.reasoningEffort ?? '模型默认' },
      ],
    },
    {
      id: 'permission',
      title: '权限',
      facts: [
        {
          label: '权限预设',
          value: PERMISSION_LABELS[snapshot.permissionPresetId] ?? snapshot.permissionPresetId,
        },
      ],
    },
  ]
}

export type AssistantHistoryKind = 'main' | 'thread'

export interface AssistantHistoryRow {
  sessionId: string
  kind: AssistantHistoryKind
  /** Chip text: the main Session is the assistant itself, threads are extra. */
  badge: string
  /**
   * Only additional Sessions are archivable. The main Session is what the row
   * *is*, so the archive affordance never appears for it — the Host refuses that
   * write anyway (`assistant.thread.archive`).
   */
  archivable: boolean
}

/** Main Session first, then the visible thread Sessions in their stored order. */
export function assistantHistoryRows(
  instance: Pick<AssistantInstanceView, 'mainSessionId' | 'threadSessionIds'>,
): AssistantHistoryRow[] {
  const rows: AssistantHistoryRow[] = []
  if (instance.mainSessionId !== undefined) {
    rows.push({ sessionId: instance.mainSessionId, kind: 'main', badge: '主', archivable: false })
  }
  for (const sessionId of instance.threadSessionIds ?? []) {
    rows.push({ sessionId, kind: 'thread', badge: '附加', archivable: true })
  }
  return rows
}

const SECTION_ICONS: Record<AssistantDetailSectionId, JSX.Element> = {
  overview: <IconInfoOutlineRegular size={14} />,
  identity: <IconPersonalizationOutlineRegular size={14} />,
  model: <IconSlidersTwoOutlineRegular size={14} />,
  permission: <IconShieldOutlineRegular size={14} />,
  persona: <IconEditOutlineRegular size={14} />,
  memory: <IconDatabaseOutlineRegular size={14} />,
  history: <IconFlatListOutlineRegular size={14} />,
}

function DetailSection({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: AssistantDetailSectionId
  title: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <DisclosureRow
      icon={SECTION_ICONS[id]}
      title={title}
      open={open}
      expandable
      expandOnRowClick
      onToggle={onToggle}
    >
      {children}
    </DisclosureRow>
  )
}

function AssistantDetailFacts({
  section,
}: {
  section: AssistantDetailSection
}): JSX.Element {
  return (
    <dl className={css.assistantDetailFacts} data-dsh-assistant-detail-section={section.id}>
      {section.facts.map(fact => (
        <div key={fact.label} className={css.assistantDetailFact}>
          <dt className={css.assistantDetailFactLabel}>{fact.label}</dt>
          <dd className={css.assistantDetailFactValue}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function DetailError({ message }: { message: string }): JSX.Element {
  return <p className={css.assistantDetailError} role="alert">{message}</p>
}

function detailErrorMessage(prefix: string, cause: unknown): string {
  return `${prefix}：${cause instanceof Error ? cause.message : String(cause)}`
}

/**
 * 人设: the stored instructions with a draft that only leaves the panel on an
 * explicit save. Read from and written to the same snapshot field the create
 * dialog fills, so the two never disagree about what a persona is.
 */
export function PersonaPanel({
  instructions,
  draft,
  saving,
  error,
  saved,
  onChange,
  onSave,
  onReset,
}: {
  instructions: string
  draft: string
  saving: boolean
  error?: string | undefined
  saved?: boolean | undefined
  onChange: (value: string) => void
  onSave: () => void
  onReset: () => void
}): JSX.Element {
  const dirty = draft !== instructions
  return (
    <div className={css.assistantDetailBody} data-dsh-assistant-detail-section="persona">
      <label className={css.assistantDetailField}>
        <span className={css.assistantDetailFactLabel}>人设说明</span>
        <textarea
          className={css.assistantDetailTextarea}
          aria-label="人设说明"
          value={draft}
          rows={5}
          placeholder="还没有人设：写下这个助手该怎么做事"
          onChange={event => { onChange(event.target.value) }}
        />
      </label>
      <div className={css.assistantDetailActions}>
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={!dirty || saving}
          onClick={onSave}
        >
          {saving ? '保存中…' : '保存人设'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!dirty || saving}
          onClick={onReset}
        >
          撤销修改
        </Button>
        {saved === true && <span className={css.assistantDetailNotice} role="status">已保存</span>}
      </div>
      {/* The snapshot is read when a Session is created or resumed, so the note
          says when the change lands instead of promising a live edit. */}
      <p className={css.assistantDetailHint}>保存后对新建或恢复的会话生效。</p>
      {error !== undefined && <DetailError message={error} />}
    </div>
  )
}

/** Hook wrapper: the draft, the save, and the error the section shows in place. */
function PersonaSection({
  instance,
  onSaved,
}: {
  instance: AssistantInstanceView
  onSaved?: (() => void) | undefined
}): JSX.Element {
  const instructions = instance.assistantSnapshot.instructions
  const [draft, setDraft] = useState(instructions)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    setDraft(instructions)
    setSaved(false)
    setError(undefined)
  }, [instance.id, instructions])

  const save = (): void => {
    if (saving) return
    setSaving(true)
    setError(undefined)
    setSaved(false)
    void callAgentTeam('assistant.instance.update', {
      id: instance.id,
      value: { instructions: draft },
    }).then(
      () => {
        setSaving(false)
        setSaved(true)
        onSaved?.()
      },
      cause => {
        setSaving(false)
        setError(detailErrorMessage('人设保存失败', cause))
      },
    )
  }

  return (
    <PersonaPanel
      instructions={instructions}
      draft={draft}
      saving={saving}
      {...(error === undefined ? {} : { error })}
      {...(saved ? { saved } : {})}
      onChange={value => { setDraft(value); setSaved(false) }}
      onSave={save}
      onReset={() => { setDraft(instructions); setError(undefined); setSaved(false) }}
    />
  )
}

export interface MemoryPanelState {
  loading: boolean
  error?: string | undefined
  view?: MemoryPanelView | undefined
}

/**
 * 记忆: a read-only view plus the jump to the existing editor. The editor itself
 * lives in the assistant settings dialog, which this panel reuses — nothing here
 * writes memory.
 */
export function MemoryPanel({
  state,
  onEdit,
}: {
  state: MemoryPanelState
  onEdit: () => void
}): JSX.Element {
  const view = state.view
  return (
    <div className={css.assistantDetailBody} data-dsh-assistant-detail-section="memory">
      {state.loading && <p className={css.assistantDetailHint}>正在读取记忆…</p>}
      {state.error !== undefined && <DetailError message={state.error} />}
      {!state.loading && state.error === undefined && view !== undefined && (
        view.empty
          ? <p className={css.assistantDetailHint}>还没有记忆条目</p>
          : (
            <>
              <p className={css.assistantDetailHint}>
                {`共 ${view.active.length + view.proposed.length + view.history.length} 条，修订 ${view.revision}`}
              </p>
              {view.content !== '' && (
                <div className={css.assistantDetailMemoryEntry}>
                  <span className={css.assistantDetailMemoryTitle}>旧版备注</span>
                  <span className={css.assistantDetailMemoryBody}>{view.content}</span>
                </div>
              )}
              <ul className={css.assistantDetailMemoryList}>
                {[...view.active, ...view.proposed].map(entry => (
                  <li key={entry.id} className={css.assistantDetailMemoryEntry}>
                    <span className={css.assistantDetailMemoryTitle}>{entry.title}</span>
                    {entry.status === 'proposed' && (
                      <span className={css.assistantDetailHistoryBadge}>待确认</span>
                    )}
                    {entry.body !== '' && (
                      <span className={css.assistantDetailMemoryBody}>{entry.body}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )
      )}
      <div className={css.assistantDetailActions}>
        <Button type="button" size="sm" variant="outline" onClick={onEdit}>
          在助手设置中编辑记忆
        </Button>
      </div>
    </div>
  )
}

/** Hook wrapper: one `assistant.memory.get` read and the reused settings dialog. */
function MemorySection({ instance }: { instance: AssistantInstanceView }): JSX.Element {
  const [state, setState] = useState<MemoryPanelState>({ loading: true })
  const [editorOpen, setEditorOpen] = useState(false)

  const load = useCallback((): void => {
    setState({ loading: true })
    void callAgentTeam('assistant.memory.get', { assistantId: instance.id }).then(
      value => { setState({ loading: false, view: assistantMemoryView(value.memory) }) },
      cause => {
        setState({ loading: false, error: detailErrorMessage('读取记忆失败', cause) })
      },
    )
  }, [instance.id])

  useEffect(() => { load() }, [load])

  return (
    <>
      <MemoryPanel state={state} onEdit={() => { setEditorOpen(true) }} />
      {/* Mounted on demand only: the shipped dialog reads the model catalog when
          it is created, and an unopened panel must not pay for that. */}
      {editorOpen && (
        <AssistantSettingsDialog
          open
          assistant={instance}
          onClose={() => { setEditorOpen(false) }}
          onSaved={() => { load() }}
        />
      )}
    </>
  )
}

/**
 * 会话历史: the main Session and the additional ones, each opening in the
 * shipped conversation view. Only additional Sessions offer 归档.
 */
export function HistoryPanel({
  instance,
  error,
  busySessionId,
  onOpen,
  onArchive,
}: {
  instance: AssistantInstanceView
  error?: string | undefined
  busySessionId?: string | undefined
  onOpen: (sessionId: string) => void
  onArchive: (sessionId: string) => void
}): JSX.Element {
  const rows = assistantHistoryRows(instance)
  return (
    <div className={css.assistantDetailBody} data-dsh-assistant-detail-section="history">
      {rows.length === 0 && <p className={css.assistantDetailHint}>还没有会话</p>}
      <ul className={css.assistantDetailHistoryList}>
        {rows.map(row => (
          <li
            key={row.sessionId}
            className={css.assistantDetailHistoryRow}
            data-dsh-assistant-history-kind={row.kind}
          >
            <span className={css.assistantDetailHistoryBadge}>{row.badge}</span>
            <span className={css.assistantDetailHistoryId} title={row.sessionId}>
              {row.sessionId}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => { onOpen(row.sessionId) }}
            >
              打开
            </Button>
            {row.archivable && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busySessionId === row.sessionId}
                onClick={() => { onArchive(row.sessionId) }}
              >
                {busySessionId === row.sessionId ? '归档中…' : '归档'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className={css.assistantDetailHint}>主会话是这个助手本身，不能归档。</p>
      {error !== undefined && <DetailError message={error} />}
    </div>
  )
}

function HistorySection({
  instance,
  onChanged,
}: {
  instance: AssistantInstanceView
  onChanged?: (() => void) | undefined
}): JSX.Element {
  const [error, setError] = useState<string>()
  const [busySessionId, setBusySessionId] = useState<string>()

  const open = (sessionId: string): void => {
    setError(undefined)
    if (openAssistantSession(sessionId)) return
    setError('无法打开该会话：宿主还没有可用的会话视图')
  }

  const archive = (sessionId: string): void => {
    if (busySessionId !== undefined) return
    setBusySessionId(sessionId)
    setError(undefined)
    void callAgentTeam('assistant.thread.archive', {
      instanceId: instance.id,
      sessionId,
    }).then(
      () => {
        setBusySessionId(undefined)
        onChanged?.()
      },
      cause => {
        setBusySessionId(undefined)
        setError(detailErrorMessage('归档失败', cause))
      },
    )
  }

  return (
    <HistoryPanel
      instance={instance}
      {...(error === undefined ? {} : { error })}
      {...(busySessionId === undefined ? {} : { busySessionId })}
      onOpen={open}
      onArchive={archive}
    />
  )
}

/**
 * The panel body. Sections default open and are collapsible, which is also what
 * makes the whole panel keyboard reachable: `DisclosureRow` renders the row as a
 * focusable, Enter/Space-operable target.
 *
 * Closing the pane itself is the host's Esc shortcut — no key handler here.
 */
export function AssistantDetailPanel({
  instance,
  notice,
  expanded,
  onRefresh,
}: {
  instance?: AssistantInstanceView | undefined
  /** Shown instead of the empty instruction while the list is loading or failed. */
  notice?: string | undefined
  expanded?: boolean | undefined
  /** Re-read the instance row after an inline write changed it. */
  onRefresh?: (() => void) | undefined
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  if (instance === undefined) {
    return (
      <div
        className={css.assistantDetail}
        data-dsh-assistant-detail
        data-dsh-assistant-detail-empty
        data-expanded={expanded}
      >
        <p className={css.assistantDetailEmpty} role="status">{notice ?? DETAIL_EMPTY_TEXT}</p>
      </div>
    )
  }
  const sections = assistantDetailSections(instance)
  const avatar = assistantAvatarSource(instance)
  const toggle = (id: AssistantDetailSectionId, open: boolean): void => {
    setCollapsed(current => ({ ...current, [id]: open }))
  }
  const isOpen = (id: AssistantDetailSectionId): boolean => collapsed[id] !== true
  return (
    <div className={css.assistantDetail} data-dsh-assistant-detail data-expanded={expanded}>
      {sections.map(section => (
        <DetailSection
          key={section.id}
          id={section.id}
          title={section.title}
          open={isOpen(section.id)}
          onToggle={() => { toggle(section.id, isOpen(section.id)) }}
        >
          {section.id === 'identity' && (
            <div className={css.assistantDetailIdentity}>
              <MemberAvatar
                name={assistantInstanceName(instance)}
                avatar={avatar}
                size={40}
                className={css.assistantDetailAvatar ?? ''}
              />
              {avatar === undefined && (
                <span className={css.assistantDetailAvatarNote}>未设置头像，用名称首字</span>
              )}
            </div>
          )}
          <AssistantDetailFacts section={section} />
        </DetailSection>
      ))}
      <DetailSection
        id="persona"
        title="人设"
        open={isOpen('persona')}
        onToggle={() => { toggle('persona', isOpen('persona')) }}
      >
        <PersonaSection instance={instance} {...(onRefresh === undefined ? {} : { onSaved: onRefresh })} />
      </DetailSection>
      <DetailSection
        id="memory"
        title="记忆"
        open={isOpen('memory')}
        onToggle={() => { toggle('memory', isOpen('memory')) }}
      >
        <MemorySection instance={instance} />
      </DetailSection>
      <DetailSection
        id="history"
        title="会话历史"
        open={isOpen('history')}
        onToggle={() => { toggle('history', isOpen('history')) }}
      >
        <HistorySection instance={instance} {...(onRefresh === undefined ? {} : { onChanged: onRefresh })} />
      </DetailSection>
    </div>
  )
}

interface InstancesState {
  instances: AssistantInstanceView[]
  loading: boolean
  error?: string
}

/** Read the one row this panel shows through the existing list transport. */
function useAssistantInstances(enabled: boolean): InstancesState & { refresh: () => void } {
  const [state, setState] = useState<InstancesState>({ instances: [], loading: enabled })
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => { setNonce(value => value + 1) }, [])
  useEffect(() => {
    if (!enabled) {
      setState({ instances: [], loading: false })
      return
    }
    let live = true
    const read = (): void => {
      void callAgentTeam('assistant.instance.list').then(
        value => { if (live) setState({ instances: value.items, loading: false }) },
        cause => {
          if (!live) return
          setState({
            instances: [],
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        },
      )
    }
    setState({ instances: [], loading: true })
    read()
    const unsubscribe = subscribeAgentTeam(read, () => {}, read)
    return () => {
      live = false
      unsubscribe()
    }
  }, [enabled, nonce])
  return { ...state, refresh }
}

/**
 * The `sidebar.right.pane.tab` entry: the framework hands it `useTabInfo`, and
 * the row it describes is whichever helper the sidebar has selected.
 *
 * The tab record is not needed beyond the shell's own state, so the only thing
 * read from it is whether the pane is expanded; the selection itself lives in
 * the plugin's UI store, which the row menu writes before opening this tab.
 */
export function AssistantDetailBody({
  useTabInfo,
}: PropsRuntime<'sidebar.right.pane.tab'>): JSX.Element {
  const { sidebar } = useTabInfo()
  const { selectedAssistantId } = useAgentTeamUi()
  const { instances, loading, error, refresh } = useAssistantInstances(
    selectedAssistantId !== undefined,
  )
  const instance = instances.find(candidate => candidate.id === selectedAssistantId)
  const notice = error !== undefined
    ? `助手数据加载失败：${error}`
    : loading
      ? '正在加载助手…'
      : DETAIL_EMPTY_TEXT
  return (
    <AssistantDetailPanel
      {...(instance === undefined ? {} : { instance })}
      notice={instance === undefined ? notice : undefined}
      expanded={sidebar.expanded}
      onRefresh={refresh}
    />
  )
}

/** The services the open action needs; the host's face, narrowed to two reads. */
export interface DetailSidebar {
  mounted: { getSnapshot(): string | undefined }
  openTab(kind: string): void
}

/**
 * Open (or focus) the detail tab for one helper.
 *
 * Selection is written first so the body — mounted in the same module graph —
 * renders this row on its first paint. The guard is the contract note's: every
 * write throws while no Session surface is mounted, so a hero screen gets `false`
 * and the row can say why instead of appearing dead.
 */
export function openAssistantDetail(
  sidebar: DetailSidebar | undefined,
  assistantId: string,
): boolean {
  selectAssistant(assistantId)
  if (sidebar === undefined || sidebar.mounted.getSnapshot() === undefined) return false
  try {
    sidebar.openTab(DETAIL_TAB_KIND)
    return true
  } catch {
    return false
  }
}
