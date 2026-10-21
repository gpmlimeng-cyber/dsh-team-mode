import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AssistantSession } from '../domain/types.js'

export interface AssistantTaskSummaryMessage {
  kind: 'user' | 'assistant'
  text: string
}

export interface AssistantTaskWaitResult {
  task: AssistantSession
  timedOut: boolean
}

export interface AssistantTaskSummaryResult {
  task: AssistantSession
  summary: string
  messages: AssistantTaskSummaryMessage[]
}

export interface AssistantTaskToolHandlers {
  /** Reject a caller that is not this assistant instance's main Session. */
  assertIdentity: (agent: Agent | undefined) => void
  createTask: (input: { title: string; brief: string }) => Promise<AssistantSession>
  sendTask: (taskId: string, message: string) => Promise<AssistantSession>
  listTasks: (limit?: number) => AssistantSession[]
  waitTask: (taskId: string, timeoutMs?: number) => Promise<AssistantTaskWaitResult>
  summaryTask: (taskId: string) => Promise<AssistantTaskSummaryResult>
  cancelTask: (taskId: string) => Promise<AssistantSession>
}

type ToolResult = Record<string, unknown>

const textOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: ToolResult): Array<{ type: 'text'; text: string }> => [
    { type: 'text', text: JSON.stringify(value) },
  ],
}

const taskListOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: ToolResult): Array<{ type: 'text'; text: string }> => [
    {
      type: 'text',
      text: (value.tasks as AssistantSession[] | undefined)
        ?.map(task => `${task.title} [${task.status}] ${task.id}`)
        .join('\n') ?? '',
    },
  ],
}

export function taskView(task: AssistantSession): ToolResult {
  return {
    task_id: task.id,
    title: task.title,
    status: task.status,
    session_id: task.sessionId,
    ...(task.resultSummary === undefined ? {} : { result_summary: task.resultSummary }),
    ...(task.error === undefined ? {} : { error: task.error }),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  }
}

/**
 * Task tools are registered only on an Assistant instance's main Session.
 * Worker Sessions never receive them, which keeps delegation one level deep and
 * prevents a worker from spawning or cancelling sibling workers.
 */
export function registerAssistantTaskTools(
  agentCtx: Context,
  handlers: AssistantTaskToolHandlers,
): void {
  const register = (tool: Parameters<typeof agentCtx.tools.register>[0]): void => {
    try {
      agentCtx.tools.register(tool)
    } catch (error) {
      // A resumed main Session can be set up again after a reconnect. The tool
      // names already exist in that agent scope, so a duplicate must not fail
      // the whole assistant startup.
      if (error instanceof Error && /already registered/i.test(error.message)) return
      throw error
    }
  }

  register(defineTool({
    name: 'assistant_task_create',
    description: 'Create a hidden worker Session for one background task. The user never sees the worker Session or its transcript; this main conversation receives only the tool result and later assistant_task_wait/assistant_task_summary output. The worker inherits this assistant’s workspace, model, preset, permission, and instructions.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short task title shown in task lists.' },
      brief: { type: 'string', required: true, description: 'Complete instruction for the worker, including the expected deliverable.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const task = await handlers.createTask({ title: args.title, brief: args.brief })
      return { task: taskView(task) } as never
    },
  }))

  register(defineTool({
    name: 'assistant_task_send',
    description: 'Send another instruction to a hidden worker Session created by assistant_task_create. The worker resumes with its existing context and reports a fresh result; the user still sees only this main conversation.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by assistant_task_create or assistant_task_list.' },
      message: { type: 'string', required: true, description: 'Additional instruction or question for the worker.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const task = await handlers.sendTask(args.task_id, args.message)
      return { task: taskView(task) } as never
    },
  }))

  register(defineTool({
    name: 'assistant_task_list',
    description: 'List this assistant’s hidden worker Sessions with title, status, task id, and timestamps. Use this before deciding whether to continue an existing task or create a new one. Worker Sessions do not appear in the native Sidebar.',
    parameters: {
      limit: { type: 'number', description: 'Maximum tasks to return (1-50, default 20). Newest first.' },
    },
    output: taskListOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return { tasks: handlers.listTasks(args.limit).map(taskView) } as never
    },
  }))

  register(defineTool({
    name: 'assistant_task_wait',
    description: 'Wait for a hidden worker Session to reach completed, failed, or cancelled, up to timeout_ms. Returns the current status; timed_out=true means the worker is still running, so poll again later or continue with other work. This never blocks forever.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by assistant_task_create or assistant_task_list.' },
      timeout_ms: { type: 'number', description: 'Maximum wait in milliseconds (1000-120000, default 30000).' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const result = await handlers.waitTask(args.task_id, args.timeout_ms)
      return {
        task: taskView(result.task),
        timed_out: result.timedOut,
      } as never
    },
  }))

  register(defineTool({
    name: 'assistant_task_summary',
    description: 'Read a compact summary of a hidden worker Session’s recent messages and persist it as the task result. Only this bounded summary enters the main conversation; the full worker transcript is never copied into it. Summarize the returned text to the user rather than dumping it.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by assistant_task_create or assistant_task_list.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const result = await handlers.summaryTask(args.task_id)
      return {
        task: taskView(result.task),
        summary: result.summary,
        messages: result.messages,
      } as never
    },
  }))

  register(defineTool({
    name: 'assistant_task_cancel',
    description: 'Cancel a hidden worker Session’s active turn and mark the task cancelled. The Session log is preserved; the user sees only this main conversation.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by assistant_task_create or assistant_task_list.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const task = await handlers.cancelTask(args.task_id)
      return { task: taskView(task) } as never
    },
  }))
}
