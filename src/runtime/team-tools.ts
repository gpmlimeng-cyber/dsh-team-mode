import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  CreateTaskInput,
  ReadMessagesResult,
  SendMessageInput,
  SendMessageResult,
  TeamMemberView,
  TeamMessageView,
  TeamTaskView,
  UpdateTaskInput,
} from './team-command-handler.js'

export interface TeamAssistantView {
  assistant_id: string
  name: string
  description?: string
  provider: string
  model: string
  agent_preset_id: string
  permission_preset_id: string
  skills: string[]
  mcp_servers: string[]
  instructions?: string
}

export interface TeamToolHandlers {
  assertIdentity: (agent: Agent | undefined) => void
  members: () => TeamMemberView[]
  readMessages: (limit?: number) => Promise<ReadMessagesResult>
  sendMessage: (input: SendMessageInput) => Promise<SendMessageResult>
  interruptAgent: (slotId: string, message: string) => Promise<{ slot_id: string; status: 'delivered' }>
  createTask: (input: CreateTaskInput) => Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }>
  updateTask: (input: UpdateTaskInput) => Promise<{
    taskId: string
    status: string
    deliveryState?: 'queued' | 'delivered'
    woken?: string[]
  }>
  listTasks: (limit?: number) => TeamTaskView[]
  listAssistants: () => TeamAssistantView[]
  describeAssistant: (assistantId: string) => TeamAssistantView
  spawnAgent: (input: { name: string; assistantId: string }) => Promise<TeamMemberView>
  renameAgent: (slotId: string, newName: string) => Promise<{ slot_id: string; name: string }>
  clearAgentContext: (slotId: string) => Promise<{ slot_id: string; session_id: string; status: string }>
  shutdownAgent: (slotId: string, message?: string) => Promise<{
    status: 'requested'
    slot_id: string
    message_id: string
  }>
}

type ToolResult = Record<string, unknown>

const textOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: ToolResult): Array<{ type: 'text'; text: string }> => [
    { type: 'text', text: JSON.stringify(value) },
  ],
}

const membersOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: ToolResult): Array<{ type: 'text'; text: string }> => [
    {
      type: 'text',
      text: (value.members as TeamMemberView[] | undefined)
        ?.map(member => `${member.name} (${member.role}, ${member.status}) ${member.slot_id}`)
        .join('\n') ?? '',
    },
  ],
}

export function registerTeamTools(
  agentCtx: Context,
  handlers: TeamToolHandlers,
): void {
  const register = (tool: Parameters<typeof agentCtx.tools.register>[0]): void => {
    try {
      agentCtx.tools.register(tool)
    } catch (error) {
      // A member session can be set up more than once (reconnect / warmup
      // retry). The tool names are already present in that agent scope, so a
      // duplicate registration must not fail the whole member startup.
      if (error instanceof Error && /already registered/i.test(error.message)) return
      throw error
    }
  }
  register(defineTool({
    name: 'team_members',
    description: 'List the current team roster: name, role, slot id, assistant, model, and runtime status. Call this before planning or delegating.',
    parameters: {},
    output: membersOutput,
    execute: async (_args, exec) => {
      handlers.assertIdentity(exec.agent)
      return { members: handlers.members() } as never
    },
  }))

  register(defineTool({
    name: 'team_read_messages',
    description: 'Read your team mailbox (unread first, then recent), FIFO, at most 50 messages. Marks returned messages read.',
    parameters: {
      limit: { type: 'number', description: 'Maximum messages to return (1-50, default 20).' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.readMessages(args.limit) as never
    },
  }))

  register(defineTool({
    name: 'team_send_message',
    description: 'Send a durable team message. `to` is a member slot id (or display name) or `*` to broadcast to every active member except yourself. Use summary for the mailbox preview; files attaches workspace paths or URLs.',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient slot id, member name, or * for broadcast.' },
      message: { type: 'string', required: true, description: 'Full message content.' },
      summary: { type: 'string', description: 'Short mailbox preview (<=500 chars).' },
      files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths or URLs to attach.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const result = await handlers.sendMessage({
        to: args.to,
        message: args.message,
        ...(args.summary === undefined ? {} : { summary: args.summary }),
        ...(args.files === undefined ? {} : { files: args.files }),
      })
      return {
        message_id: result.messageId,
        delivery_state: result.deliveryState,
        delivered_to: result.deliveredTo,
        ...(result.queuedFor === undefined ? {} : { queued_for: result.queuedFor }),
        ...(result.shutdown === undefined ? {} : { shutdown: result.shutdown }),
      } as never
    },
  }))

  register(defineTool({
    name: 'team_interrupt_agent',
    description: 'Leader only. Stop a member’s current turn and deliver a replacement instruction to that member.',
    parameters: {
      slot_id: { type: 'string', required: true, description: 'Target member slot id.' },
      message: { type: 'string', required: true, description: 'Replacement instruction for the member.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.interruptAgent(args.slot_id, args.message) as never
    },
  }))

  register(defineTool({
    name: 'team_mode_task_create',
    description: 'Leader only. Create a task on the shared task board. `blocked_by` lists task ids that must finish first. Assigning an owner wakes that member automatically.',
    parameters: {
      subject: { type: 'string', required: true, description: 'Short task subject.' },
      description: { type: 'string', description: 'Task details.' },
      owner: { type: 'string', description: 'Owner slot id or member name.' },
      blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete before this task can start.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const result = await handlers.createTask({
        subject: args.subject,
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.owner === undefined ? {} : { owner: args.owner }),
        ...(args.blocked_by === undefined ? {} : { blocked_by: args.blocked_by }),
      })
      return {
        task_id: result.taskId,
        status: toAionTaskStatus(result.status),
        delivery_state: result.deliveryState ?? 'queued',
      } as never
    },
  }))

  register(defineTool({
    name: 'team_mode_task_update',
    description: 'Update a task you own (the Leader may update any task). Completing a task clears its downstream blockers. The task owner or Leader may reassign an owner or change blockers; reassignment wakes the new owner.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id.' },
      status: {
        type: 'string',
        required: true,
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description: 'New task status.',
      },
      owner: { type: 'string', description: 'New owner slot id or name (Leader or current owner).' },
      blocked_by: { type: 'array', items: { type: 'string' }, description: 'Replacement blocker task ids (Leader or current owner).' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const result = await handlers.updateTask({
        task_id: args.task_id,
        status: args.status as NonNullable<UpdateTaskInput['status']>,
        ...(args.owner === undefined ? {} : { owner: args.owner }),
        ...(args.blocked_by === undefined ? {} : { blocked_by: args.blocked_by }),
      })
      return {
        task_id: result.taskId,
        status: toAionTaskStatus(result.status),
        delivery_state: result.deliveryState ?? 'delivered',
        ...(result.woken === undefined ? {} : { woken: result.woken }),
      } as never
    },
  }))

  register(defineTool({
    name: 'team_mode_task_list',
    description: 'Read the shared task board, including owner, blockers, reverse blocks, and file scopes.',
    parameters: {
      limit: { type: 'number', description: 'Maximum tasks to return (1-200, default 200).' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return { tasks: handlers.listTasks(args.limit) } as never
    },
  }))

  register(defineTool({
    name: 'team_list_assistants',
    description: 'List reusable assistant templates available for spawning a new teammate.',
    parameters: {},
    output: textOutput,
    execute: async (_args, exec) => {
      handlers.assertIdentity(exec.agent)
      return { assistants: handlers.listAssistants() } as never
    },
  }))

  register(defineTool({
    name: 'team_describe_assistant',
    description: 'Read one assistant template: model, preset, permissions, Skills, MCP servers, and long-term instructions.',
    parameters: {
      assistant_id: { type: 'string', required: true, description: 'Assistant template id.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.describeAssistant(args.assistant_id) as never
    },
  }))

  register(defineTool({
    name: 'team_spawn_agent',
    description: 'Leader only. Add one new member from an assistant template and activate it. Returns the new slot id.',
    parameters: {
      name: { type: 'string', required: true, description: 'Team-local display name for the new member.' },
      assistant_id: { type: 'string', required: true, description: 'Assistant template id.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const member = await handlers.spawnAgent({ name: args.name, assistantId: args.assistant_id })
      return {
        slot_id: member.slot_id,
        name: member.name,
        role: member.role,
        member,
      } as never
    },
  }))

  register(defineTool({
    name: 'team_rename_agent',
    description: 'Leader only. Rename a member’s team-local display name without changing its session or configuration.',
    parameters: {
      slot_id: { type: 'string', required: true, description: 'Target member slot id.' },
      new_name: { type: 'string', required: true, description: 'New display name (<=80 chars).' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.renameAgent(args.slot_id, args.new_name) as never
    },
  }))

  register(defineTool({
    name: 'team_clear_agent_context',
    description: 'Leader only. Give one member a fresh session and context, preserving the team, task board, and workspace. Other members are untouched.',
    parameters: {
      slot_id: { type: 'string', required: true, description: 'Target member slot id.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.clearAgentContext(args.slot_id) as never
    },
  }))

  register(defineTool({
    name: 'team_shutdown_agent',
    description: 'Leader only. Ask one member to stop. The member replies shutdown_approved or shutdown_rejected: reason; approval removes it after a short delay.',
    parameters: {
      slot_id: { type: 'string', required: true, description: 'Target member slot id.' },
      message: { type: 'string', description: 'Optional reason/instructions for the shutdown request.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.shutdownAgent(args.slot_id, args.message) as never
    },
  }))

  // Backward-compatible aliases for the pre-AionUi tool names. New prompts and
  // code should use the primary names above.
  register(defineTool({
    name: 'team_get_task_board',
    description: 'Alias for team_mode_task_list. Read the shared task board.',
    parameters: {},
    output: textOutput,
    execute: async (_args, exec) => {
      handlers.assertIdentity(exec.agent)
      return { tasks: handlers.listTasks(200) } as never
    },
  }))

  register(defineTool({
    name: 'team_create_task',
    description: 'Alias for team_mode_task_create. Create and optionally assign a shared task.',
    parameters: {
      title: { type: 'string', required: true, description: 'Task subject.' },
      description: { type: 'string' },
      ownerSlotId: { type: 'string', description: 'Owner slot id.' },
      fileScopes: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative file scopes.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const result = await handlers.createTask({
        title: args.title,
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.ownerSlotId === undefined ? {} : { ownerSlotId: args.ownerSlotId }),
        ...(args.fileScopes === undefined ? {} : { fileScopes: args.fileScopes }),
      })
      return {
        task_id: result.taskId,
        status: toAionTaskStatus(result.status),
        delivery_state: result.deliveryState ?? 'queued',
      } as never
    },
  }))

  register(defineTool({
    name: 'team_update_task',
    description: 'Alias for team_mode_task_update. Update a task you own (Leader may update any task).',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
      status: {
        type: 'string',
        required: true,
        enum: ['pending', 'assigned', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'in_progress', 'deleted'],
      },
      result: { type: 'string' },
      error: { type: 'string' },
      ownerSlotId: { type: 'string', description: 'Leader-only reassignment target.' },
    },
    output: textOutput,
    execute: async (args, exec) => {
      handlers.assertIdentity(exec.agent)
      const result = await handlers.updateTask({
        taskId: args.taskId,
        status: args.status as NonNullable<UpdateTaskInput['status']>,
        ...(args.result === undefined ? {} : { result: args.result }),
        ...(args.error === undefined ? {} : { error: args.error }),
        ...(args.ownerSlotId === undefined ? {} : { ownerSlotId: args.ownerSlotId }),
      })
      return {
        task_id: result.taskId,
        status: toAionTaskStatus(result.status),
        delivery_state: result.deliveryState ?? 'delivered',
        ...(result.woken === undefined ? {} : { woken: result.woken }),
      } as never
    },
  }))
}

export function toAionTaskStatus(status: string): string {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'cancelled' || status === 'deleted') return 'deleted'
  if (status === 'running' || status === 'blocked' || status === 'in_progress') return 'in_progress'
  return 'pending'
}

export type {
  ReadMessagesResult,
  SendMessageResult,
  TeamMemberView,
  TeamMessageView,
  TeamTaskView,
}
