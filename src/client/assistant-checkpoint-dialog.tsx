import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import {
  CHECKPOINT_NOTE_LIMIT,
  checkpointFactsSummary,
  checkpointHandoffLabel,
  checkpointNoteError,
  checkpointStatusLabel,
} from './assistant-checkpoint.js'
import { assistantInstanceName, relativeAssistantTime } from './assistant-instances.js'
import { AnimatedModal, Field } from './shared.js'
import css from './AgentTeam.module.css'
import type { AssistantInstance, ContextCheckpoint } from '../domain/types.js'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The checkpoint rows of one dialog. Consumed and archived rows stay visible as
 * history but expose no handoff action; only `ready` rows can be handed off,
 * and a handoff always needs the second confirming click.
 */
export function CheckpointList({
  checkpoints,
  confirmingId,
  busy,
  onHandoff,
}: {
  checkpoints: readonly ContextCheckpoint[]
  confirmingId?: string | undefined
  busy: boolean
  onHandoff: (checkpoint: ContextCheckpoint, confirming: boolean) => void
}): JSX.Element {
  if (checkpoints.length === 0) {
    return (
      <div className={css.checkpointEmpty}>
        还没有检查点。填写可选的交接说明后点击「生成检查点」，再用它开始一个新会话。
      </div>
    )
  }
  return (
    <div className={css.checkpointList}>
      {checkpoints.map(checkpoint => {
        const ready = checkpoint.status === 'ready'
        const confirming = confirmingId === checkpoint.id
        return (
          <article
            key={checkpoint.id}
            className={css.checkpointRow}
            data-dsh-checkpoint={checkpoint.id}
            data-dsh-checkpoint-status={checkpoint.status}
          >
            <span className={css.checkpointRowCopy}>
              <span className={css.checkpointRowTitle}>{checkpoint.title}</span>
              <span className={css.checkpointRowMeta}>
                <span className={`${css.checkpointBadge} ${ready ? css.checkpointBadgeReady : ''}`}>
                  {checkpointStatusLabel(checkpoint.status)}
                </span>
                <span>{checkpointFactsSummary(checkpoint)}</span>
                <span>{relativeAssistantTime(checkpoint.createdAt)}</span>
              </span>
            </span>
            {ready && (
              <button
                type="button"
                className={`${css.checkpointAction} ${confirming ? css.checkpointActionConfirm : ''}`}
                disabled={busy}
                onClick={() => { onHandoff(checkpoint, confirming) }}
              >
                {busy ? '交接中…' : checkpointHandoffLabel(confirming)}
              </button>
            )}
          </article>
        )
      })}
    </div>
  )
}

/**
 * Create, review, and hand off one Assistant DM checkpoint. Creation is
 * manual and deterministic on the host (facts plus the optional note, no model
 * call); handing off opens the fresh Session the host returns, and the old
 * Session stays persisted but hidden from the sidebar.
 */
export function AssistantCheckpointDialog({
  open,
  assistant,
  onClose,
  openSession,
}: {
  open: boolean
  assistant: AssistantInstance
  onClose: () => void
  openSession: (sessionId: string) => void
}): JSX.Element {
  const name = assistantInstanceName(assistant)
  const [checkpoints, setCheckpoints] = useState<ContextCheckpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [note, setNote] = useState('')
  const [creating, setCreating] = useState(false)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string>()
  const [error, setError] = useState<string>()
  const busy = creating || handoffBusy
  const noteError = checkpointNoteError(note)

  useEffect(() => {
    if (!open) return
    let live = true
    setCheckpoints([])
    setLoading(true)
    setLoadError(undefined)
    setNote('')
    setCreating(false)
    setHandoffBusy(false)
    setConfirmingId(undefined)
    setError(undefined)
    void (async () => {
      try {
        const list = await callAgentTeam('assistant.checkpoint.list', { assistantId: assistant.id })
        if (live) setCheckpoints(list)
      } catch (cause) {
        if (live) setLoadError(`检查点读取失败：${messageOf(cause)}`)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [open, assistant.id])

  async function create(): Promise<void> {
    if (busy || noteError !== undefined) return
    setCreating(true)
    setError(undefined)
    try {
      const created = await callAgentTeam('assistant.checkpoint.create', {
        assistantId: assistant.id,
        note,
      })
      setCheckpoints(current => [created, ...current])
      setNote('')
      setConfirmingId(undefined)
    } catch (cause) {
      setError(`生成检查点失败：${messageOf(cause)}`)
    } finally {
      setCreating(false)
    }
  }

  async function handoff(checkpoint: ContextCheckpoint, confirming: boolean): Promise<void> {
    if (busy) return
    if (!confirming) {
      setError(undefined)
      setConfirmingId(checkpoint.id)
      return
    }
    setHandoffBusy(true)
    setError(undefined)
    try {
      const result = await callAgentTeam('assistant.checkpoint.handoff', {
        checkpointId: checkpoint.id,
      })
      setConfirmingId(undefined)
      onClose()
      openSession(result.sessionId)
    } catch (cause) {
      setError(`交接失败：${messageOf(cause)}`)
    } finally {
      setHandoffBusy(false)
    }
  }

  return (
    <AnimatedModal
      open={open}
      onClose={onClose}
      title="检查点与交接"
      description={`为「${name}」保存当前进度，并带着它在一个新会话里继续；旧会话记录保留但不再显示在侧栏。`}
      closeLabel="关闭"
      className={css.assistantCheckpointDialog ?? ''}
    >
      {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
      {loadError !== undefined && <div className={css.inlineError} role="alert">{loadError}</div>}
      <Field label="交接说明（可选，用户提供）">
        <textarea
          className={css.checkpointNote}
          value={note}
          maxLength={CHECKPOINT_NOTE_LIMIT}
          rows={3}
          disabled={busy}
          placeholder="写下希望新会话接着做的工作；这段说明会原样进入新会话的上下文。"
          onChange={event => {
            setNote(event.target.value)
            setError(undefined)
            setConfirmingId(undefined)
          }}
        />
      </Field>
      <div className={css.checkpointNoteMeta}>
        <span>{note.length} / {CHECKPOINT_NOTE_LIMIT}</span>
        {noteError !== undefined && <span role="alert">{noteError}</span>}
      </div>
      <div className={css.assistantCreateActions}>
        <span className={css.checkpointHint}>检查点只包含最近的消息和进行中的任务，不调用模型。</span>
        <Button
          variant="primary"
          type="button"
          disabled={busy || noteError !== undefined}
          onClick={() => { void create() }}
        >
          {creating ? '生成中…' : '生成检查点'}
        </Button>
      </div>
      <section className={css.checkpointSection} aria-label="检查点列表">
        {loading
          ? <div className={css.checkpointEmpty}>读取检查点中…</div>
          : (
            <CheckpointList
              checkpoints={checkpoints}
              confirmingId={confirmingId}
              busy={handoffBusy}
              onHandoff={(checkpoint, confirming) => { void handoff(checkpoint, confirming) }}
            />
          )}
      </section>
    </AnimatedModal>
  )
}
