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
 * One Assistant's hidden worker Tasks. Rows are read-only navigational entries:
 * clicking one closes the dialog and opens that worker Session in the shipped
 * conversation view. Task creation stays in the assistant's main Session.
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
                  onClick={() => {
                    onClose()
                    openSession(task.sessionId)
                  }}
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
