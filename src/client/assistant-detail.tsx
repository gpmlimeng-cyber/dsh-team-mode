import { useEffect, useState } from 'react'
import {
  Button,
  IconClockOutlineRegular,
  IconDatabaseOutlineRegular,
  IconEditOutlineRegular,
  IconFlatListOutlineRegular,
  IconInfoOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconShieldOutlineRegular,
  IconSlidersTwoOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import { openAssistantMainSession, openAssistantSession } from './store.js'
import css from './AgentTeam.module.css'
import type { UpdateAssistantInstanceInput } from '../domain/types.js'
import type { AssistantInstanceView } from '../transport/contracts.js'

/**
 * Sessions the row can open: the main Session plus every visible thread. Retired
 * ids are history, so they are deliberately not counted.
 */
export function assistantBoundSessionCount(
  instance: Pick<AssistantInstanceView, 'mainSessionId' | 'threadSessionIds'>,
): number {
  return (instance.mainSessionId === undefined ? 0 : 1) + (instance.threadSessionIds?.length ?? 0)
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
  disabled = false,
  onChange,
  onSave,
  onReset,
}: {
  instructions: string
  draft: string
  saving: boolean
  error?: string | undefined
  saved?: boolean | undefined
  /** The pane has another write in flight; do not start a second one. */
  disabled?: boolean | undefined
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
          disabled={disabled}
          placeholder="还没有人设：写下这个助手该怎么做事"
          onChange={event => { onChange(event.target.value) }}
        />
      </label>
      <div className={css.assistantDetailActions}>
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={!dirty || saving || disabled}
          onClick={onSave}
        >
          {saving ? '保存中…' : '保存人设'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!dirty || saving || disabled}
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
export function PersonaSection({
  instance,
  onSaved,
  write,
  disabled = false,
  onSavingChange,
}: {
  instance: AssistantInstanceView
  onSaved?: (() => void) | undefined
  /**
   * The pane's per-assistant serializer: the same queue every field write
   * joins, so 保存人设 can never overlap a whole-snapshot field update.
   * Resolves to the failure message, or undefined after it landed.
   */
  write?: ((value: UpdateAssistantInstanceInput) => Promise<string | undefined>) | undefined
  disabled?: boolean | undefined
  onSavingChange?: ((saving: boolean) => void) | undefined
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

  const finish = (failure: string | undefined): void => {
    setSaving(false)
    onSavingChange?.(false)
    if (failure === undefined) {
      setSaved(true)
      onSaved?.()
      return
    }
    setError(failure)
  }

  const save = (): void => {
    if (saving || disabled) return
    setSaving(true)
    onSavingChange?.(true)
    setError(undefined)
    setSaved(false)
    if (write !== undefined) {
      void write({ instructions: draft }).then(
        finish,
        cause => { finish(detailErrorMessage('人设保存失败', cause)) },
      )
      return
    }
    void callAgentTeam('assistant.instance.update', {
      id: instance.id,
      value: { instructions: draft },
    }).then(
      () => { finish(undefined) },
      cause => { finish(detailErrorMessage('人设保存失败', cause)) },
    )
  }

  return (
    <PersonaPanel
      instructions={instructions}
      draft={draft}
      saving={saving}
      disabled={disabled}
      {...(error === undefined ? {} : { error })}
      {...(saved ? { saved } : {})}
      onChange={value => { setDraft(value); setSaved(false) }}
      onSave={save}
      onReset={() => { setDraft(instructions); setError(undefined); setSaved(false) }}
    />
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

export function HistorySection({
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
    // The main row is the relationship itself: re-ensure it so the assistant
    // tools/model are attached, exactly like the sidebar row. Thread rows (and
    // an archived assistant's retained main Session, where ensure must fail)
    // still open the raw Session id.
    if (sessionId === instance.mainSessionId && instance.status !== 'archived') {
      void openAssistantMainSession(instance.id, target => {
        if (!openAssistantSession(target)) {
          setError('无法打开该会话：宿主还没有可用的会话视图')
        }
      }, { bound: true }).then(
        outcome => { if (outcome.notice !== undefined) setError(outcome.notice) },
        cause => { setError(detailErrorMessage('打开会话失败', cause)) },
      )
      return
    }
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
 * The slice of one Host `schedule.catalog` row this panel reads. The Host owns
 * the reminders: its catalog already carries the stored title, status, next
 * occurrence and the Session the task runs on, so nothing here is derived.
 */
export interface AssistantAutomationEntry {
  id: string
  title: string
  status: 'active' | 'inactive'
  /** Committed next occurrence while active, or the final one once it ended. */
  scheduledAt: string
  sessionId: string
}

export interface AssistantAutomationRow {
  id: string
  title: string
  status: 'active' | 'inactive'
  nextRunAt: string
}

/**
 * The Sessions this assistant's automations run on: the main Session plus every
 * visible thread. Retired ids are history and are dropped, exactly like
 * `assistantBoundSessionCount`.
 */
export function assistantAutomationSessionIds(
  instance: Pick<AssistantInstanceView, 'mainSessionId' | 'threadSessionIds'>,
): string[] {
  const ids: string[] = []
  if (instance.mainSessionId !== undefined) ids.push(instance.mainSessionId)
  for (const sessionId of instance.threadSessionIds ?? []) ids.push(sessionId)
  return ids
}

/**
 * This assistant's automations out of the Host's whole catalog.
 *
 * The Host binds a task to the Session that created it and offers no
 * per-assistant query, so the filter is the join against the Sessions this row
 * already stores — no index, no copied task. Active tasks sort first, then by
 * their stored next occurrence; the id breaks ties so two reads agree.
 */
export function assistantAutomationRows(
  instance: Pick<AssistantInstanceView, 'mainSessionId' | 'threadSessionIds'>,
  entries: readonly AssistantAutomationEntry[],
): AssistantAutomationRow[] {
  const sessions = new Set(assistantAutomationSessionIds(instance))
  return entries
    .filter(entry => sessions.has(entry.sessionId))
    .map(entry => ({
      id: entry.id,
      title: entry.title,
      status: entry.status,
      nextRunAt: entry.scheduledAt,
    }))
    .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active')
      || left.nextRunAt.localeCompare(right.nextRunAt)
      || left.id.localeCompare(right.id))
}

/** The stored occurrence read the same way `labels.ts` reads a task time. */
export function assistantAutomationNextRun(nextRunAt: string): string {
  const at = Date.parse(nextRunAt)
  return Number.isNaN(at) ? nextRunAt : new Date(at).toLocaleString('zh-CN')
}

/**
 * The Host surfaces this block needs, installed once from `apply()`. This plugin
 * owns no scheduling and renders no page of its own, so the reader is the Host's
 * catalog and the jump selects the Host's own panel.
 */
export interface AssistantAutomationSource {
  /** The Host's whole schedule catalog; absent when no Schedule Remote is composed. */
  catalog?: () => Promise<readonly AssistantAutomationEntry[]>
  /** Select the Host's automations panel. */
  open: () => void
}

let automationSource: AssistantAutomationSource | undefined

/**
 * The Host's own automations panel, as `@deepseek-ai/dsh-client-ui-schedule`
 * registers it in `sidebar.panellist`. This plugin only selects it.
 */
export const SCHEDULES_PANEL_ID = 'schedules'

export function installAssistantAutomations(source: AssistantAutomationSource | undefined): void {
  automationSource = source
}

/** True once the Host panel was asked to open. */
export function openAssistantAutomations(): boolean {
  if (automationSource === undefined) return false
  automationSource.open()
  return true
}

/**
 * The Host's whole schedule catalog, for a surface that lists the next
 * occurrences. `undefined` when the deployment composes no Schedule Remote, so
 * a caller can tell "nothing scheduled" from "nothing to ask".
 */
export function readAssistantAutomations(): Promise<readonly AssistantAutomationEntry[]> | undefined {
  return automationSource?.catalog?.()
}

/**
 * How many automations this assistant has, for 概览. `undefined` when the
 * deployment composes no Schedule Remote or the catalog read failed: the
 * overview must not report "没有自动化" without evidence.
 */
export async function assistantAutomationCount(
  instance: Pick<AssistantInstanceView, 'mainSessionId' | 'threadSessionIds'>,
): Promise<number | undefined> {
  const read = automationSource?.catalog
  if (read === undefined) return undefined
  try {
    return assistantAutomationRows(instance, await read()).length
  } catch {
    return undefined
  }
}

export interface AutomationPanelState {
  /** True until the Host catalog read settles. */
  loading: boolean
  /** The deployment composes no Schedule Remote, so there is nothing to list. */
  unavailable?: boolean | undefined
  error?: string | undefined
  rows?: AssistantAutomationRow[] | undefined
}

/**
 * 自动化: the Host's scheduled tasks for this assistant, read-only. Rules,
 * editing and run history stay in the Host panel the footer opens — this block
 * only answers "does this assistant have automations, and when do they run".
 */
export function AutomationPanel({
  state,
  onOpen,
}: {
  state: AutomationPanelState
  onOpen: () => void
}): JSX.Element {
  const rows = state.rows ?? []
  const empty = !state.loading && state.unavailable !== true
    && state.error === undefined && rows.length === 0
  return (
    <div className={css.assistantDetailBody} data-dsh-assistant-detail-section="automations">
      {state.loading && <p className={css.assistantDetailHint}>正在读取自动化任务…</p>}
      {state.unavailable === true && (
        <p className={css.assistantDetailHint}>当前部署没有自动化任务服务</p>
      )}
      {state.error !== undefined && <DetailError message={state.error} />}
      {empty && <p className={css.assistantDetailHint}>还没有自动化任务</p>}
      {rows.length > 0 && (
        <ul className={css.assistantDetailHistoryList}>
          {rows.map(row => (
            <li
              key={row.id}
              className={css.assistantDetailHistoryRow}
              data-dsh-assistant-automation={row.id}
            >
              <Button
                type="button"
                size="sm"
                variant="ghost"
                title="在自动化任务面板里查看"
                onClick={onOpen}
              >
                {row.title}
              </Button>
              <span className={css.assistantDetailHistoryBadge}>
                {row.status === 'active' ? '已开启' : '未运行'}
              </span>
              <span className={css.assistantDetailHistoryId} title={row.nextRunAt}>
                {assistantAutomationNextRun(row.nextRunAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Nothing to jump to in a deployment without the Host panel: the block
          states that instead of offering a button that cannot work. */}
      {state.unavailable !== true && (
        <>
          <div className={css.assistantDetailActions}>
            <Button type="button" size="sm" variant="outline" onClick={onOpen}>
              打开自动化任务
            </Button>
          </div>
          <p className={css.assistantDetailHint}>
            任务在「自动化任务」面板里新建，跑在创建它的会话上；这里只列本助手会话名下的任务。
          </p>
        </>
      )}
    </div>
  )
}

/** Hook wrapper: one Host catalog read, plus the jump to the Host's own panel. */
export function AutomationSection({ instance }: { instance: AssistantInstanceView }): JSX.Element {
  const [state, setState] = useState<AutomationPanelState>({ loading: true })
  const [jumpError, setJumpError] = useState<string>()
  const sessionKey = assistantAutomationSessionIds(instance).join('\u0000')

  useEffect(() => {
    const readCatalog = automationSource?.catalog
    if (readCatalog === undefined) {
      setState({ loading: false, unavailable: true })
      return
    }
    let live = true
    setState({ loading: true })
    void readCatalog().then(
      entries => {
        if (live) setState({ loading: false, rows: assistantAutomationRows(instance, entries) })
      },
      cause => {
        if (live) setState({ loading: false, error: detailErrorMessage('读取自动化任务失败', cause) })
      },
    )
    return () => { live = false }
    // The row's Session list is what selects the tasks; `instance` itself is a
    // fresh object on every list refresh and would re-read for nothing.
  }, [instance.id, sessionKey])

  const open = (): void => {
    setJumpError(openAssistantAutomations() ? undefined : '无法打开自动化任务面板：宿主没有该面板')
  }

  return (
    <>
      <AutomationPanel state={state} onOpen={open} />
      {jumpError !== undefined && <DetailError message={jumpError} />}
    </>
  )
}
