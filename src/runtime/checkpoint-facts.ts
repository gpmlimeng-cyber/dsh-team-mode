import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm/message'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantSession, CheckpointFacts, ContextCheckpoint } from '../domain/types.js'
import { projectConversation } from './conversation-projector.js'

/**
 * DSH core kind for producer-declared runtime context. The installed
 * `dsh-llm` declarations predate it, so this plugin declares the same shape
 * the host assembles; a consumer falls through to opaque context.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': {
      kind: 'runtime-context'
    } & ContextFormed
  }
}

/** Visible nodes read from the main Session before the checkpoint window is cut. */
const PROJECTION_LIMIT = 80
/** Longest transcript tail one checkpoint may copy. */
const MESSAGE_LIMIT = 12
/** Longest text kept per copied message. */
const MESSAGE_TEXT_LIMIT = 500
/** Most in-flight worker tasks one checkpoint may list. */
const TASK_LIMIT = 20

const ACTIVE_TASK_STATUSES: ReadonlySet<AssistantSession['status']> = new Set([
  'queued',
  'running',
  'needs_input',
])

export interface CheckpointFactsInput {
  events: readonly SessionEvent[]
  tasks: readonly AssistantSession[]
  workspacePath: string
  note: string
}

/**
 * Build the bounded, deterministic facts of one checkpoint. No model runs and
 * no tool result or reasoning text is copied: only visible user/assistant
 * messages and in-flight worker tasks enter the record.
 */
export function buildCheckpointFacts(input: CheckpointFactsInput): {
  facts: CheckpointFacts
  capturedThroughSeq: number
} {
  const projection = projectConversation(input.events, PROJECTION_LIMIT)
  const recentMessages = projection.nodes
    .flatMap(node => {
      if (node.kind !== 'user' && node.kind !== 'assistant') return []
      const text = node.text.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_TEXT_LIMIT)
      return text === '' ? [] : [{ role: node.kind, text }]
    })
    .slice(-MESSAGE_LIMIT)
  const activeTasks = [...input.tasks]
    .filter(task => ACTIVE_TASK_STATUSES.has(task.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .slice(0, TASK_LIMIT)
    .map(task => ({ id: task.id, title: task.title, status: task.status }))

  return {
    facts: {
      recentMessages,
      activeTasks,
      workspacePath: input.workspacePath,
      note: input.note,
    },
    capturedThroughSeq: projection.throughSeq,
  }
}

/**
 * The single durable context message a handed-off Session receives. It is a
 * real `user/message` whose `runtime-context` source keeps it out of the
 * visible conversation while staying model-visible in the Session log.
 */
export function checkpointHandoffMessage(checkpoint: ContextCheckpoint): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: checkpointHandoffText(checkpoint) }],
    source: { kind: 'runtime-context', form: 'instructions' },
  })
}

function checkpointHandoffText(checkpoint: ContextCheckpoint): string {
  const { facts } = checkpoint
  const lines = [
    `# 上下文交接：${checkpoint.title}`,
    '',
    `这是一份手工生成的上下文检查点（捕获到会话序号 ${checkpoint.capturedThroughSeq}）。`,
    '以下内容由系统从上一次会话中确定性提取，不是模型总结。请在此基础上继续工作。',
    '',
    '## 用户交接说明（用户提供，非系统推断）',
    facts.note.trim() === '' ? '（未填写）' : facts.note.trim(),
    '',
    '## 工作区',
    facts.workspacePath,
    '',
    '## 最近消息（按时间先后，最多最后 12 条）',
    ...(facts.recentMessages.length === 0
      ? ['（无可见消息）']
      : facts.recentMessages.map(message => (
        `- ${message.role === 'user' ? '用户' : '助手'}：${message.text}`
      ))),
    '',
    '## 进行中的任务（最多 20 条）',
    ...(facts.activeTasks.length === 0
      ? ['（无进行中任务）']
      : facts.activeTasks.map(task => `- [${task.status}] ${task.title}（${task.id}）`)),
  ]
  return `${lines.join('\n')}\n`
}
