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
      setMemory(result.memory)
      setLegacyDraft(result.memory.content)
      setDraft(undefined)
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
      setMemory(result.memory)
      setLegacyDraft(result.memory.content)
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

  function entryCard(entry: MemoryEntry, actions?: JSX.Element): JSX.Element {
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
          {view.active.map(entry => entryCard(
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
          {view.proposed.map(entry => entryCard(entry))}
        </div>
      )}
      {view.historyTotal > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>历史 · {view.historyTotal}</strong>
          {view.history.map(entry => entryCard(entry))}
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
