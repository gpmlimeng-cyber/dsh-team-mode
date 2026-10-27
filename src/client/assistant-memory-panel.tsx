import { useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import {
  assistantMemoryView,
  memoryJournalActionLabel,
  memorySourceLabel,
  memoryStatusLabel,
  memoryVisibilityLabel,
} from './labels.js'
import { SelectControl } from './select-control.js'
import { Field } from './shared.js'
import css from './AgentTeam.module.css'
import type {
  AssistantMemory,
  MemoryEntry,
} from '../domain/types.js'
import type { MemoryAskResult } from '../domain/memory.js'
import type { AssistantMemoryEntryWriteView } from '../transport/contracts.js'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function memoryErrorCode(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null && 'code' in cause
    ? (cause as { code?: unknown }).code
    : undefined
}

function memoryError(cause: unknown): string {
  const code = memoryErrorCode(cause)
  if (code === 'MEMORY_REVISION_CONFLICT' || code === 'ASSISTANT_REVISION_CONFLICT') {
    return '记忆已被其他操作更新，已重新加载最新版本，请重试。'
  }
  if (code === 'MEMORY_UNDO_STALE') return '记忆已更新，已重新加载最新版本，请重试撤销。'
  if (code === 'MEMORY_UNDO_UNAVAILABLE') return '这条变更无法安全撤销（快照已脱敏或截断）。'
  return messageOf(cause)
}

function memoryTime(value: string): string {
  return value.slice(0, 16).replace('T', ' ')
}

/**
 * Ask-or-change failures keep the typed request, so the failure is shown
 * instead of the draft being dropped. A revision conflict also means this
 * panel's revision is stale: the caller reloads and the kept draft can be
 * retried against the fresh revision.
 */
export function memoryAskFailure(cause: unknown): { message: string; reload: boolean } {
  return {
    message: memoryError(cause),
    reload: memoryErrorCode(cause) === 'MEMORY_REVISION_CONFLICT',
  }
}

/**
 * Every successful write in the 记忆 block announces itself. The count row in
 * 概览 reads the same document through its own `assistant.memory.get`, so this
 * event is what keeps its N live after a write — the pane renders that row
 * beside, not above, the block that owns the writes.
 */
export const ASSISTANT_MEMORY_CHANGED_EVENT = 'dsh-team-mode:assistant-memory-changed'

function announceMemoryChange(assistantId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(ASSISTANT_MEMORY_CHANGED_EVENT, { detail: { assistantId } }))
  } catch {
    // A blocked dispatch only leaves the count stale until the pane re-reads.
  }
}

/**
 * `assistant.memory.undo` returns the same `{ memory, entry }` envelope as an
 * entry write. The panel stores the memory document, not the envelope.
 */
export function memoryAfterUndo(result: AssistantMemoryEntryWriteView): AssistantMemory {
  return result.memory
}

/** One entry card, shared by the panel and the ask-or-change outcome. */
function memoryEntryCard(entry: MemoryEntry, actions?: JSX.Element): JSX.Element {
  return (
    <article key={entry.id} className={css.memoryEntryCard}>
      <div className={css.memoryEntryHeader}>
        <strong>{entry.title}</strong>
        <span className={css.memoryBadges}>
          <span className={`${css.memoryBadge} ${entry.visibility === 'private' ? css.memoryBadgePrivate : ''}`}>
            {memoryVisibilityLabel(entry.visibility)}
          </span>
          <span className={`${css.memoryBadge} ${entry.status === 'proposed' ? css.memoryBadgeProposed : ''}`}>
            {memoryStatusLabel(entry.status)}
          </span>
          <span className={css.memoryBadge}>v{entry.revision}</span>
        </span>
      </div>
      {entry.body !== '' && <p className={css.memoryEntryBody}>{entry.body}</p>}
      <div className={css.memoryEntryMeta}>
        <span>{memorySourceLabel(entry.source)}{entry.key === undefined ? '' : ` · ${entry.key}`}{` · ${memoryTime(entry.updatedAt)}`}</span>
        {actions}
      </div>
    </article>
  )
}

/**
 * The fixed ask-or-change result: an `answer` renders as text and says the
 * memory was not touched, while a `change` renders the entries the call wrote —
 * every one of them `proposed`, so accepting it stays a separate user action.
 * Rendering nothing here would drop a proposal the user was just told about.
 */
export function MemoryAskOutcome({ result }: { result: MemoryAskResult }): JSX.Element {
  if (result.kind === 'answer') {
    return (
      <article className={css.memoryEntryCard}>
        <div className={css.memoryEntryHeader}>
          <strong>回答</strong>
          <span className={css.memoryBadges}>
            <span className={css.memoryBadge}>未改动记忆</span>
          </span>
        </div>
        <p className={css.memoryEntryBody}>{result.answer}</p>
      </article>
    )
  }
  return (
    <div className={css.memoryGroup}>
      <div className={css.memoryGroupTitleRow}>
        <strong className={css.memoryGroupTitle}>已提出 {result.entries.length} 条待确认条目</strong>
        <span className={css.memoryBadges}>
          <span className={css.memoryBadge}>采纳后生效</span>
        </span>
      </div>
      {result.entries.map(entry => memoryEntryCard(entry))}
    </div>
  )
}

interface MemoryDraft {
  id?: string
  title: string
  body: string
  visibility: MemoryEntry['visibility']
  key: string
}

/**
 * Structured assistant memory is keyed by the Assistant instance id, not by
 * the template. The panel sits outside the settings `<form>` so its controls
 * cannot submit the settings form; every write sends the document revision and
 * surfaces a conflict by reloading the latest value.
 */
export function AssistantMemorySection({ assistantId }: { assistantId: string }): JSX.Element {
  const [memory, setMemory] = useState<AssistantMemory | null>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<MemoryDraft>()
  const [legacyEditing, setLegacyEditing] = useState(false)
  const [legacyDraft, setLegacyDraft] = useState('')
  const [confirmClear, setConfirmClear] = useState<string>()
  const [undoing, setUndoing] = useState<string>()
  const [askText, setAskText] = useState('')
  const [asking, setAsking] = useState(false)
  const [askResult, setAskResult] = useState<MemoryAskResult>()
  const view = useMemo(() => assistantMemoryView(memory), [memory])
  const revision = memory?.revision ?? 0
  const journal = memory?.journal ?? []

  async function load(): Promise<void> {
    setLoading(true)
    setLoadError(undefined)
    try {
      const value = await callAgentTeam('assistant.memory.get', { assistantId })
      setMemory(value.memory)
      setLegacyDraft(value.memory?.content ?? '')
    } catch (cause) {
      setLoadError(`读取记忆失败：${messageOf(cause)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let live = true
    setLoading(true)
    setLoadError(undefined)
    callAgentTeam('assistant.memory.get', { assistantId })
      .then(value => {
        if (!live) return
        setMemory(value.memory)
        setLegacyDraft(value.memory?.content ?? '')
      })
      .catch((cause: unknown) => {
        if (live) setLoadError(`读取记忆失败：${messageOf(cause)}`)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => { live = false }
  }, [assistantId])

  /**
   * One explicit ask-or-change call, triggered only by the form below: no
   * polling and no background work. An answer is shown as text; a change shows
   * the entries the call wrote and re-reads the document so the panel's next
   * write is fenced by the revision those proposals just created.
   */
  async function askMemory(): Promise<void> {
    const text = askText.trim()
    if (text === '' || asking) return
    setAsking(true)
    setError(undefined)
    setAskResult(undefined)
    try {
      const result = await callAgentTeam('assistant.memory.ask', { assistantId, text })
      setAskResult(result)
      setAskText('')
      if (result.kind === 'change') {
        announceMemoryChange(assistantId)
        await load()
      }
    } catch (cause) {
      const failure = memoryAskFailure(cause)
      // The draft stays in askText, including across a conflict reload.
      setError(failure.message)
      if (failure.reload) void load()
    } finally {
      setAsking(false)
    }
  }

  /** Shared tail of every entry write: store the document, then announce it. */
  function applyEntryWrite(result: AssistantMemoryEntryWriteView): void {
    setMemory(result.memory)
    setLegacyDraft(result.memory.content)
    setConfirmClear(undefined)
    announceMemoryChange(assistantId)
  }

  async function writeEntry(): Promise<void> {
    if (draft === undefined || busy) return
    const title = draft.title.trim()
    if (title === '') {
      setError('条目标题不能为空。')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const result = await callAgentTeam('assistant.memory.entry.write', {
        assistantId,
        expectedRevision: revision,
        entry: {
          ...(draft.id === undefined ? {} : { id: draft.id }),
          title,
          body: draft.body,
          visibility: draft.visibility,
          ...(draft.key.trim() === '' ? {} : { key: draft.key.trim() }),
        },
      })
      applyEntryWrite(result)
      setDraft(undefined)
    } catch (cause) {
      const message = memoryError(cause)
      setError(message)
      if (message.startsWith('记忆已被')) void load()
    } finally {
      setBusy(false)
    }
  }

  async function archiveEntry(entry: MemoryEntry): Promise<void> {
    if (busy) return
    if (confirmClear !== entry.id) {
      setError(undefined)
      setConfirmClear(entry.id)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const result = await callAgentTeam('assistant.memory.entry.write', {
        assistantId,
        expectedRevision: revision,
        entry: {
          id: entry.id,
          title: entry.title,
          body: entry.body,
          visibility: entry.visibility,
          status: 'archived',
        },
      })
      applyEntryWrite(result)
    } catch (cause) {
      const message = memoryError(cause)
      setError(message)
      if (message.startsWith('记忆已被')) void load()
    } finally {
      setBusy(false)
    }
  }

  async function saveLegacy(content: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await callAgentTeam('assistant.memory.write', {
        assistantId,
        content,
        mode: 'replace',
        expectedRevision: revision,
      })
      setMemory(next)
      setLegacyDraft(next.content)
      setLegacyEditing(false)
      setConfirmClear(undefined)
      announceMemoryChange(assistantId)
    } catch (cause) {
      const message = memoryError(cause)
      setError(message)
      if (message.startsWith('记忆已被')) void load()
    } finally {
      setBusy(false)
    }
  }

  async function undo(journalId: string): Promise<void> {
    if (busy || undoing !== undefined) return
    setUndoing(journalId)
    setError(undefined)
    try {
      const result = await callAgentTeam('assistant.memory.undo', {
        assistantId,
        journalId,
        expectedRevision: revision,
      })
      const next = memoryAfterUndo(result)
      setMemory(next)
      setLegacyDraft(next.content)
      setConfirmClear(undefined)
      announceMemoryChange(assistantId)
    } catch (cause) {
      setError(memoryError(cause))
      if (memoryErrorCode(cause) === 'MEMORY_UNDO_STALE') void load()
    } finally {
      setUndoing(undefined)
    }
  }

  return (
    <section className={css.assistantMemorySection} aria-label="助手持久记忆">
      <div className={css.teamSectionHeader}>
        <strong>持久记忆</strong>
        <span className={css.teamSectionActions}>
          <span>版本 {view.revision}</span>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={busy || draft !== undefined}
            onClick={() => {
              setError(undefined)
              setLegacyEditing(true)
            }}
          >
            旧版文本
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={busy || draft !== undefined}
            onClick={() => {
              setError(undefined)
              setDraft({ title: '', body: '', visibility: 'private', key: '' })
            }}
          >
            新建条目
          </Button>
        </span>
      </div>
      <p className={css.assistantMemoryHint}>
        只注入本助手的主会话与后台任务；「团队可见」条目也只有显式关联到本实例的团队成员才会读取。
      </p>
      {(loadError !== undefined || error !== undefined) && (
        <div role="alert" className={css.inlineError}>{error ?? loadError}</div>
      )}
      <p className={css.assistantMemoryHint}>
        一句话提问，或让助手提出记忆修改；修改只写成「待确认」条目，采纳后才会生效。
      </p>
      <form
        className={css.memoryForm}
        onSubmit={event => { event.preventDefault(); void askMemory() }}
      >
        <Field label="问 / 改">
          <input
            className={css.input}
            value={askText}
            maxLength={2_000}
            placeholder="例如：我们一般怎么组织表格？"
            aria-label="问 / 改记忆"
            disabled={asking}
            onChange={event => { setAskText(event.target.value) }}
          />
        </Field>
        <div className={css.memoryFormActions}>
          <Button variant="primary" type="submit" disabled={asking || askText.trim() === ''}>
            {asking ? '思考中…' : '问 / 改'}
          </Button>
        </div>
      </form>
      {askResult !== undefined && <MemoryAskOutcome result={askResult} />}
      {loading && <p className={css.memoryEmpty}>读取记忆中…</p>}
      {!loading && view.empty && draft === undefined && !legacyEditing && (
        <p className={css.memoryEmpty}>还没有持久记忆。助手也可以通过工具写入，或在此新建结构化条目。</p>
      )}
      {(view.content.trim() !== '' || legacyEditing) && (
        <div className={css.memoryGroup}>
          <div className={css.memoryGroupTitleRow}>
            <strong className={css.memoryGroupTitle}>旧版文本记忆</strong>
            <span className={css.memoryBadges}>
              <span className={css.memoryBadge}>旧版</span>
              <span className={css.memoryBadge}>v{revision}</span>
            </span>
          </div>
          {legacyEditing
            ? (
                <div className={css.memoryForm}>
                  <textarea
                    className={`${css.input} ${css.memoryTextarea}`}
                    value={legacyDraft}
                    rows={3}
                    maxLength={16_000}
                    aria-label="旧版文本记忆"
                    disabled={busy}
                    onChange={event => { setLegacyDraft(event.target.value) }}
                  />
                  <div className={css.memoryFormActions}>
                    <Button
                      variant="outline"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setLegacyDraft(view.content)
                        setLegacyEditing(false)
                        setConfirmClear(undefined)
                      }}
                    >
                      取消
                    </Button>
                    <Button variant="primary" type="button" disabled={busy} onClick={() => { void saveLegacy(legacyDraft) }}>
                      {busy ? '保存中…' : '保存旧版文本'}
                    </Button>
                  </div>
                </div>
              )
            : (
                <>
                  <p className={css.memoryEntryBody}>{view.content}</p>
                  <div className={css.memoryEntryMeta}>
                    <span>旧版单段文本；结构化条目优先</span>
                    <span className={css.memoryEntryActions}>
                      <button type="button" className={css.memoryAction} disabled={busy} onClick={() => { setLegacyEditing(true) }}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className={`${css.memoryAction} ${confirmClear === 'legacy' ? css.memoryActionConfirm : ''}`}
                        disabled={busy}
                        onClick={() => {
                          if (confirmClear !== 'legacy') {
                            setConfirmClear('legacy')
                            return
                          }
                          void saveLegacy('')
                        }}
                      >
                        {confirmClear === 'legacy' ? '确认清空' : '清空'}
                      </button>
                    </span>
                  </div>
                </>
              )}
        </div>
      )}
      {view.active.length > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>生效条目 · {view.active.length}</strong>
          {view.active.map(entry => memoryEntryCard(
            entry,
            <span className={css.memoryEntryActions}>
              <button
                type="button"
                className={css.memoryAction}
                disabled={busy}
                onClick={() => {
                  setError(undefined)
                  setConfirmClear(undefined)
                  setDraft({
                    id: entry.id,
                    title: entry.title,
                    body: entry.body,
                    visibility: entry.visibility,
                    key: entry.key ?? '',
                  })
                }}
              >
                编辑
              </button>
              <button
                type="button"
                className={`${css.memoryAction} ${confirmClear === entry.id ? css.memoryActionConfirm : ''}`}
                disabled={busy}
                onClick={() => { void archiveEntry(entry) }}
              >
                {confirmClear === entry.id ? '确认归档' : '归档'}
              </button>
            </span>,
          ))}
        </div>
      )}
      {view.proposed.length > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>待确认 · {view.proposed.length}</strong>
          {view.proposed.map(entry => memoryEntryCard(entry))}
        </div>
      )}
      {view.historyTotal > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>历史 · {view.historyTotal}</strong>
          {view.history.map(entry => memoryEntryCard(entry))}
          {view.historyTotal > view.history.length && (
            <p className={css.memoryEmpty}>仅显示最近 {view.history.length} 条历史记录。</p>
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
                      disabled={busy || undoing !== undefined || blocked}
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
          onSubmit={event => { event.preventDefault(); void writeEntry() }}
        >
          <Field label="标题">
            <input
              className={css.input}
              value={draft.title}
              maxLength={200}
              disabled={busy}
              onChange={event => { setDraft({ ...draft, title: event.target.value }) }}
            />
          </Field>
          <Field label="内容">
            <textarea
              className={`${css.input} ${css.memoryTextarea}`}
              value={draft.body}
              rows={3}
              disabled={busy}
              onChange={event => { setDraft({ ...draft, body: event.target.value }) }}
            />
          </Field>
          <Field label="可见性">
            <SelectControl
              ariaLabel="可见性"
              value={draft.visibility}
              options={[
                { value: 'private', label: '私有（仅此助手）' },
                { value: 'team-safe', label: '团队可见（仅关联成员读取）' },
              ]}
              disabled={busy}
              onChange={next => {
                setDraft({ ...draft, visibility: next === 'team-safe' ? 'team-safe' : 'private' })
              }}
            />
          </Field>
          <Field label="键（可选）">
            <input
              className={css.input}
              value={draft.key}
              maxLength={200}
              disabled={busy}
              onChange={event => { setDraft({ ...draft, key: event.target.value }) }}
            />
          </Field>
          <div className={css.memoryFormActions}>
            <Button variant="outline" type="button" disabled={busy} onClick={() => { setDraft(undefined) }}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? '保存中…' : draft.id === undefined ? '添加条目' : '保存条目'}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
