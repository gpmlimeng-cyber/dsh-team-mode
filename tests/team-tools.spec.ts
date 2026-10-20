import { describe, expect, it, vi } from 'vitest'
import type { TeamToolHandlers } from '../src/runtime/team-tools.js'
import { registerTeamTools } from '../src/runtime/team-tools.js'

type RegisteredTool = {
  name: string
  description: string
  parameters: {
    properties?: Record<string, unknown>
    required?: string[]
  }
  execute: (args: Record<string, unknown>, exec: { agent: unknown }) => Promise<Record<string, unknown>>
}

function harness(): {
  tools: Map<string, RegisteredTool>
  handlers: TeamToolHandlers
  ctx: { tools: { register: (definition: RegisteredTool) => void } }
} {
  const tools = new Map<string, RegisteredTool>()
  const handlers = {
    assertIdentity: vi.fn(),
    members: vi.fn(() => []),
    readMessages: vi.fn(async () => ({ messages: [], remaining_unread: 0 })),
    sendMessage: vi.fn(async () => ({ messageId: 'm1', deliveryState: 'delivered' as const, deliveredTo: ['member'] })),
    interruptAgent: vi.fn(async (slotId: string) => ({ slot_id: slotId, status: 'delivered' as const })),
    createTask: vi.fn(async () => ({ taskId: 't1', status: 'assigned', deliveryState: 'delivered' as const })),
    updateTask: vi.fn(async () => ({ taskId: 't1', status: 'running', deliveryState: 'delivered' as const })),
    listTasks: vi.fn(() => []),
    listAssistants: vi.fn(() => []),
    describeAssistant: vi.fn(() => ({
      assistant_id: 'a1',
      name: 'A',
      provider: 'p',
      model: 'm',
      agent_preset_id: 'standard',
      permission_preset_id: 'read-only',
      skills: [],
      mcp_servers: [],
    })),
    spawnAgent: vi.fn(async () => ({
      slot_id: 's1',
      name: 'New',
      role: 'member' as const,
      assistant_id: 'a1',
      assistant_name: 'A',
      provider: 'p',
      model: 'm',
      permission_preset_id: 'read-only',
      status: 'idle',
      desired_state: 'online',
      session_id: 'sess',
      is_leader: false,
    })),
    renameAgent: vi.fn(async (slotId: string, newName: string) => ({ slot_id: slotId, name: newName })),
    clearAgentContext: vi.fn(async (slotId: string) => ({ slot_id: slotId, session_id: 'sess', status: 'idle' })),
    shutdownAgent: vi.fn(async (slotId: string) => ({ status: 'requested' as const, slot_id: slotId, message_id: 'm1' })),
  } as unknown as TeamToolHandlers
  const ctx = {
    tools: {
      register: (definition: RegisteredTool) => { tools.set(definition.name, definition) },
    },
  }
  registerTeamTools(ctx as never, handlers)
  return { tools, handlers, ctx }
}

describe('Team Mode tool surface', () => {
  it('registers the 13 primary AionUi tools plus the legacy aliases', () => {
    const { tools } = harness()
    const primary = [
      'team_members',
      'team_read_messages',
      'team_send_message',
      'team_interrupt_agent',
      'team_task_create',
      'team_task_update',
      'team_task_list',
      'team_list_assistants',
      'team_describe_assistant',
      'team_spawn_agent',
      'team_rename_agent',
      'team_clear_agent_context',
      'team_shutdown_agent',
    ]
    for (const name of primary) expect(tools.has(name), name).toBe(true)
    expect(tools.has('team_get_task_board')).toBe(true)
    expect(tools.has('team_create_task')).toBe(true)
    expect(tools.has('team_update_task')).toBe(true)
    expect(tools.size).toBe(16)
  })

  it('publishes the required parameter contracts for the dangerous tools', () => {
    const { tools } = harness()
    expect(tools.get('team_send_message')?.parameters.required).toEqual(expect.arrayContaining(['to', 'message']))
    expect(tools.get('team_task_create')?.parameters.required).toEqual(['subject'])
    expect(tools.get('team_task_update')?.parameters.required).toEqual(expect.arrayContaining(['task_id', 'status']))
    expect(tools.get('team_spawn_agent')?.parameters.required).toEqual(expect.arrayContaining(['name', 'assistant_id']))
    expect(tools.get('team_shutdown_agent')?.description).toContain('Leader only')
    expect(tools.get('team_clear_agent_context')?.description).toContain('Leader only')
  })

  it('executes team_members and team_send_message through the bound handlers', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'agent-1' } }
    await tools.get('team_members')!.execute({}, exec)
    expect(handlers.assertIdentity).toHaveBeenCalledWith(exec.agent)
    expect(handlers.members).toHaveBeenCalled()

    const result = await tools.get('team_send_message')!.execute(
      { to: '*', message: 'hello', summary: 'hi', files: ['src/a.ts'] },
      exec,
    )
    expect(handlers.sendMessage).toHaveBeenCalledWith({
      to: '*',
      message: 'hello',
      summary: 'hi',
      files: ['src/a.ts'],
    })
    expect(result).toMatchObject({ message_id: 'm1', delivery_state: 'delivered' })
  })

  it('maps internal task statuses to AionUi statuses', async () => {
    const { tools } = harness()
    const result = await tools.get('team_task_update')!.execute(
      { task_id: 't1', status: 'in_progress' },
      { agent: { id: 'agent-1' } },
    )
    expect(result).toMatchObject({ task_id: 't1', status: 'in_progress' })
  })
})
