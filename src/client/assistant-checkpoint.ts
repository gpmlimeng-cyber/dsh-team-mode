import type { ContextCheckpoint } from '../domain/types.js'

/**
 * Longest handoff note the dialog and the host accept. Over-limit notes are
 * rejected, never truncated: a silently shortened handoff note would drop the
 * user's own instruction.
 */
export const CHECKPOINT_NOTE_LIMIT = 4_000

/** Validation error for one note; an empty note is always valid. */
export function checkpointNoteError(note: string): string | undefined {
  return note.trim().length > CHECKPOINT_NOTE_LIMIT
    ? `交接说明不能超过 ${CHECKPOINT_NOTE_LIMIT} 字`
    : undefined
}

/** Checkpoints a user may still hand off, newest first (store order). */
export function readyCheckpoints(checkpoints: readonly ContextCheckpoint[]): ContextCheckpoint[] {
  return checkpoints.filter(checkpoint => checkpoint.status === 'ready')
}

export function checkpointStatusLabel(status: ContextCheckpoint['status']): string {
  if (status === 'ready') return '可交接'
  if (status === 'consumed') return '已交接'
  return '已归档'
}

/** One line of bounded fact counts, shown under a checkpoint title. */
export function checkpointFactsSummary(checkpoint: ContextCheckpoint): string {
  return `${checkpoint.facts.recentMessages.length} 条消息 · ${checkpoint.facts.activeTasks.length} 个进行中任务`
}

/** The handoff button is a two-click confirmation, so its label follows the armed state. */
export function checkpointHandoffLabel(confirming: boolean): string {
  return confirming ? '确认交接' : '交接新会话'
}
