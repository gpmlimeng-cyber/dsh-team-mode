import { useEffect, useState } from 'react'
import { callAgentTeam } from './api.js'
import { AnimatedModal } from './shared.js'
import {
  assistantInstanceName,
  assistantTaskStatusLabel,
  assistantTasksFor,
  relativeAssistantTime,
} from './assistant-instances.js'
import css from './AgentTeam.module.css'
import type { AssistantInstance, AssistantSession } from '../domain/types.js'

/**
 * One Assistant's hidden worker Tasks. Rows are navigational entries: clicking
 * one first reattaches the task's worker Session through `assistant.task.open`,
 * then opens that Session in the shipped conversation view. A failed open keeps
 * the dialog visible with an inline error. Task creation stays in the main
 * Session.
 */
export function AssistantTaskDialog({
  open,
  assistant,
  tasks,
  onClose,
  openSession,
}: {
  open: boolean
  assistant: AssistantInstance
  tasks: readonly AssistantSession[]
  onClose: () => void
  openSession: (sessionId: string) => void
}): JSX.Element {
  const name = assistantInstanceName(assistant)
  const rows = assistantTasksFor(tasks, assistant.id)
  const [openingTaskId, setOpeningTaskId] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    setOpeningTaskId(undefined)
    setError(undefined)
  }, [open])

  async function openTask(task: AssistantSession): Promise<void> {
    if (openingTaskId !== undefined) return
    setOpeningTaskId(task.id)
    setError(undefined)
    try {
      const result = await callAgentTeam('assistant.task.open', { taskId: task.id })
      onClose()
      openSession(result.sessionId)
    } catch (cause) {
      setError(`任务打开失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setOpeningTaskId(undefined)
    }
  }

  return (
    <AnimatedModal
      open={open}
      onClose={onClose}
      title={`${name} 的任务`}
      description="后台任务在隐藏的 worker 会话中运行；点击任一任务可打开它。"
      closeLabel="关闭"
      className={css.assistantTaskDialog ?? ''}
      contentClassName={css.assistantTaskDialogContent ?? ''}
    >
      {error !== undefined && <div className={css.sidebarTeamError} role="alert">{error}</div>}
      {rows.length === 0
        ? <div className={css.assistantTaskEmpty}>还没有任务</div>
        : (
          <div className={css.assistantTaskList}>
            {rows.map(task => {
              const statusClass = task.status === 'needs_input'
                ? css.assistantTaskStatusWaiting
                : task.status === 'running'
                  ? css.assistantTaskStatusRunning
                  : css.assistantTaskStatusIdle
              const rowClass = task.status === 'needs_input'
                ? css.assistantTaskRowWaiting
                : task.status === 'running'
                  ? css.assistantTaskRowRunning
                  : task.status === 'queued'
                    ? ''
                    : css.assistantTaskRowMuted
              return (
                <button
                  key={task.id}
                  type="button"
                  className={`${css.assistantTaskRow} ${rowClass}`}
                  data-dsh-assistant-task={task.id}
                  data-dsh-assistant-task-status={task.status}
                  title={task.title}
                  disabled={openingTaskId === task.id}
                  aria-busy={openingTaskId === task.id}
                  onClick={() => { void openTask(task) }}
                >
                  <span className={css.assistantTaskRowCopy}>
                    <span className={css.assistantTaskRowTitle}>{task.title}</span>
                    <span className={css.assistantTaskRowMeta}>
                      <span className={`${css.assistantTaskStatus} ${statusClass}`}>
                        {assistantTaskStatusLabel(task.status)}
                      </span>
                      <span className={css.assistantTaskRowTime}>
                        {relativeAssistantTime(task.updatedAt)}
                      </span>
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
    </AnimatedModal>
  )
}
