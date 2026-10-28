import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { memoryRecallFilterOf, recallMemoryEntries } from '../domain/memory.js'
import type { AssistantMemory, AssistantSession, MemoryEntry, WriteAssistantMemoryEntryInput } from '../domain/types.js'

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

export interface AssistantMemoryToolHandlers {
  /** Reject a caller that is not this assistant instance's main Session. */
  assertIdentity: (agent: Agent | undefined) => void
  readMemory: () => AssistantMemory | undefined
  writeMemory: (input: {
    content: string
    mode: 'replace' | 'append'
  }) => Promise<AssistantMemory>
  writeEntry: (
    input: WriteAssistantMemoryEntryInput,
    expectedRevision: number,
  ) => Promise<{ memory: AssistantMemory; entry: MemoryEntry }>
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
    description: 'Create a hidden worker Session for one background task. The task is persisted in this assistant’s FIFO queue and starts as soon as a worker slot is free, so its status may be queued; use assistant_task_wait to follow it. The user never sees the worker Session or its transcript; this main conversation receives only the tool result and later assistant_task_wait/assistant_task_summary output. The worker inherits this assistant’s workspace, model, preset, permission, and instructions.',
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

/**
 * Durable-memory tools are registered only on the main Session, like the task
 * tools. Workers receive the memory in their system prompt but cannot mutate it.
 * Write output intentionally omits the stored text: the write already happened,
 * and re-emitting up to 16k characters would waste main-conversation context.
 */
export function registerAssistantMemoryTools(
  agentCtx: Context,
  handlers: AssistantMemoryToolHandlers,
): void {
  const register = (tool: Parameters<typeof agentCtx.tools.register>[0]): void => {
    try {
      agentCtx.tools.register(tool)
    } catch (error) {
      if (error instanceof Error && /already registered/i.test(error.message)) return
      throw error
    }
  }

  register(defineTool({
    name: 'assistant_memory_read',
    description: 'Read this assistant’s durable memory: one bounded legacy note plus structured entries, shared by its main and worker Sessions. Returns null when no memory has been written yet. Entries carry visibility (private by default), status, key, and revisions. Read-only: query/status/limit narrow the returned entries without changing anything.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive text matched against entry key, title, and body.' },
      status: {
        type: 'string',
        enum: ['active', 'proposed', 'superseded', 'archived'],
        description: 'Only return entries with this status; omit for every status.',
      },
      limit: { type: 'number', description: 'Maximum entries to return (1-50, default 20).' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const memory = handlers.readMemory()
      const recall = recallMemoryEntries(memory?.entries ?? [], memoryRecallFilterOf(args))
      return {
        memory: memory === undefined
          ? null
          : {
            assistant_id: memory.assistantId,
            content: memory.content,
            revision: memory.revision,
            updated_at: memory.updatedAt,
            entries: recall.entries.map(entryView),
          },
        total: recall.total,
        truncated: recall.truncated,
      } as never
    },
  }))

  register(defineTool({
    name: 'assistant_memory_write',
    description: 'Replace or append this assistant’s durable legacy note, a bounded string shared with every worker Session. Use it for lasting user preferences and facts, not transcripts. Content over 16000 characters is rejected, not truncated. Structured entries use assistant_memory_entry_write instead.',
    parameters: {
      content: { type: 'string', required: true, description: 'Memory text (combined stored content must stay within 16000 characters).' },
      mode: {
        type: 'string',
        enum: ['replace', 'append'],
        description: 'replace overwrites the note (default); append adds a newline and the new text.',
      },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const mode = args.mode === 'append' ? 'append' : 'replace'
      const memory = await handlers.writeMemory({ content: args.content, mode })
      return {
        assistant_id: memory.assistantId,
        mode,
        revision: memory.revision,
        content_length: memory.content.length,
        updated_at: memory.updatedAt,
      } as never
    },
  }))

  register(defineTool({
    name: 'assistant_memory_entry_write',
    description: 'Create or update one structured memory entry. Omit entry_id to create a new entry (default visibility private, status active); pass an existing entry_id to revise that entry, which bumps its own revision (an unknown entry_id is rejected, never silently created). expected_revision is the memory revision returned by assistant_memory_read (0 when nothing is stored yet), so a concurrent write is rejected instead of overwritten. Combined title and body size across all entries must stay within 16000 characters.',
    parameters: {
      expected_revision: { type: 'number', required: true, description: 'Memory document revision this write is based on; 0 when no memory is stored yet.' },
      entry_id: { type: 'string', description: 'Existing entry id to revise; omit to create a new entry. An unknown id is rejected.' },
      title: { type: 'string', required: true, description: 'Short human-readable heading for the entry.' },
      body: { type: 'string', required: true, description: 'Entry text stored verbatim. Keep it to durable facts and preferences, not transcripts.' },
      visibility: {
        type: 'string',
        enum: ['private', 'team-safe'],
        description: 'private (default) never leaves this assistant; team-safe marks content suitable for team sharing. Team injection is not implemented yet, so both currently stay with this assistant.',
      },
      status: {
        type: 'string',
        enum: ['active', 'proposed', 'archived'],
        description: 'active (default) injects the entry into this main Session prompt; proposed stores the entry without injecting it until the user accepts it, and archived keeps it stored but out of the prompt.',
      },
      key: { type: 'string', description: 'Optional stable key for later lookup; omit unless the entry has a durable name.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const input: WriteAssistantMemoryEntryInput = {
        ...(typeof args.entry_id === 'string' && args.entry_id.trim() !== ''
          ? { id: args.entry_id }
          : {}),
        title: args.title,
        body: args.body,
        ...(args.visibility === 'team-safe' || args.visibility === 'private'
          ? { visibility: args.visibility }
          : {}),
        ...(args.status === 'archived' || args.status === 'active' || args.status === 'proposed'
          ? { status: args.status }
          : {}),
        ...(typeof args.key === 'string' && args.key.trim() !== '' ? { key: args.key } : {}),
      }
      const { memory, entry } = await handlers.writeEntry(
        input,
        Math.max(Math.floor(args.expected_revision), 0),
      )
      return {
        assistant_id: memory.assistantId,
        memory_revision: memory.revision,
        entry: entryView(entry),
      } as never
    },
  }))
}

function entryView(entry: MemoryEntry): ToolResult {
  return {
    entry_id: entry.id,
    scope: entry.scope,
    visibility: entry.visibility,
    status: entry.status,
    source: entry.source,
    ...(entry.key === undefined ? {} : { key: entry.key }),
    title: entry.title,
    body: entry.body,
    revision: entry.revision,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  }
}
