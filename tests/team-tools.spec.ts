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
    createGoal: vi.fn(async () => ({
      goal_id: 'g1',
      title: 'Goal',
      objective: 'Objective',
      acceptance: '',
      mode: 'single' as const,
      status: 'active' as const,
      task_ids: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })),
    listGoals: vi.fn(() => []),
    proposeMemory: vi.fn(async () => ({
      revision: 1,
      entry: memoryView('mem-1', 'proposed'),
    })),
    listMemory: vi.fn(() => ({ revision: 0, entries: [] })),
    decideMemory: vi.fn(async () => ({
      revision: 2,
      entry: memoryView('mem-1', 'active'),
    })),
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
  it('registers the 15 primary AionUi tools, team memory tools, and the legacy aliases', () => {
    const { tools } = harness()
    const primary = [
      'team_members',
      'team_read_messages',
      'team_send_message',
      'team_interrupt_agent',
      'team_mode_goal_create',
      'team_mode_goal_list',
      'team_mode_task_create',
      'team_mode_task_update',
      'team_mode_task_list',
      'team_list_assistants',
      'team_describe_assistant',
      'team_spawn_agent',
      'team_rename_agent',
      'team_clear_agent_context',
      'team_shutdown_agent',
      'team_memory_propose',
      'team_memory_list',
      'team_memory_accept',
    ]
    for (const name of primary) expect(tools.has(name), name).toBe(true)
    expect(tools.has('team_get_task_board')).toBe(true)
    expect(tools.has('team_create_task')).toBe(true)
    expect(tools.has('team_update_task')).toBe(true)
    expect(tools.size).toBe(21)
  })

  it('publishes the required parameter contracts for the dangerous tools', () => {
    const { tools } = harness()
    expect(tools.get('team_send_message')?.parameters.required).toEqual(expect.arrayContaining(['to', 'message']))
    expect(tools.get('team_mode_task_create')?.parameters.required).toEqual(['subject'])
    expect(tools.get('team_mode_task_update')?.parameters.required).toEqual(expect.arrayContaining(['task_id', 'status']))
    expect(tools.get('team_spawn_agent')?.parameters.required).toEqual(expect.arrayContaining(['name', 'assistant_id']))
    expect(tools.get('team_shutdown_agent')?.description).toContain('Leader only')
    expect(tools.get('team_clear_agent_context')?.description).toContain('Leader only')
    expect(tools.get('team_mode_goal_create')?.description).toContain('Leader only')
    expect(tools.get('team_mode_goal_create')?.parameters.required).toEqual(['title', 'objective'])
    expect(tools.get('team_mode_goal_create')?.parameters.properties?.mode).toBeDefined()
    expect(tools.get('team_memory_propose')?.parameters.required)
      .toEqual(expect.arrayContaining(['expected_revision', 'title', 'body']))
    expect(tools.get('team_memory_accept')?.parameters.required)
      .toEqual(expect.arrayContaining(['entry_id', 'expected_revision']))
    expect(tools.get('team_memory_accept')?.description).toContain('Leader only')
    expect(tools.get('team_memory_list')?.description).toContain('only active entries')
  })

  it('executes the team memory tools through the bound handlers', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'session-1' } }
    const propose = tools.get('team_memory_propose')!
    const list = tools.get('team_memory_list')!
    const decide = tools.get('team_memory_accept')!

    const proposed = await propose.execute(
      { expected_revision: 0, title: 'Use tabs', body: 'Agreed in review.', key: 'style' },
      exec,
    )
    expect(handlers.proposeMemory).toHaveBeenCalledWith({
      title: 'Use tabs',
      body: 'Agreed in review.',
      key: 'style',
      expected_revision: 0,
    })
    expect(proposed).toMatchObject({
      memory_revision: 1,
      entry: { entry_id: 'mem-1', status: 'proposed' },
    })

    const listed = await list.execute({}, exec)
    expect(listed).toMatchObject({ memory_revision: 0, entries: [] })

    const accepted = await decide.execute(
      { entry_id: 'mem-1', expected_revision: 1, decision: 'reject' },
      exec,
    )
    expect(handlers.decideMemory).toHaveBeenCalledWith({
      entry_id: 'mem-1',
      expected_revision: 1,
      decision: 'reject',
    })
    expect(accepted).toMatchObject({
      memory_revision: 2,
      entry: { entry_id: 'mem-1', status: 'active' },
    })
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

  it('creates and lists Goals and groups a task under one Goal', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'agent-1' } }

    const created = await tools.get('team_mode_goal_create')!.execute(
      { title: 'Ship parser', objective: 'Parse input', acceptance: 'tests pass', mode: 'single' },
      exec,
    )
    expect(handlers.createGoal).toHaveBeenCalledWith({
      title: 'Ship parser',
      objective: 'Parse input',
      acceptance: 'tests pass',
      mode: 'single',
    })
    expect(created).toMatchObject({ goal: { goal_id: 'g1', mode: 'single' } })

    await tools.get('team_mode_goal_create')!.execute({ title: 'T', objective: 'O' }, exec)
    expect(handlers.createGoal).toHaveBeenLastCalledWith({ title: 'T', objective: 'O' })

    await tools.get('team_mode_goal_list')!.execute({}, exec)
    expect(handlers.listGoals).toHaveBeenCalled()

    await tools.get('team_mode_task_create')!.execute(
      { subject: 'Implement', owner: 'a', goal_id: 'g1' },
      exec,
    )
    expect(handlers.createTask).toHaveBeenLastCalledWith({
      subject: 'Implement',
      owner: 'a',
      goal_id: 'g1',
    })

    await tools.get('team_mode_task_create')!.execute({ subject: 'Ungrouped' }, exec)
    expect(handlers.createTask).toHaveBeenLastCalledWith({ subject: 'Ungrouped' })
  })

  it('declares the attempt token on both task update aliases', () => {
    const { tools } = harness()
    expect(tools.get('team_mode_task_update')?.parameters.properties?.attempt_id).toBeDefined()
    expect(tools.get('team_update_task')?.parameters.properties?.attemptId).toBeDefined()
  })

  it('returns the attempt of an assigned task from both create aliases', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'agent-1' } }
    vi.mocked(handlers.createTask).mockResolvedValue({
      taskId: 't9',
      status: 'assigned',
      deliveryState: 'delivered',
      attemptId: 'att-9',
    })
    const primary = await tools.get('team_mode_task_create')!.execute({ subject: 's', owner: 'a' }, exec)
    expect(primary).toMatchObject({ task_id: 't9', attempt_id: 'att-9' })
    const legacy = await tools.get('team_create_task')!.execute({ title: 's', ownerSlotId: 'a' }, exec)
    expect(legacy).toMatchObject({ task_id: 't9', attempt_id: 'att-9' })

    vi.mocked(handlers.createTask).mockResolvedValue({ taskId: 't10', status: 'pending' })
    const unowned = await tools.get('team_mode_task_create')!.execute({ subject: 's' }, exec)
    expect(unowned).not.toHaveProperty('attempt_id')
  })

  it('forwards either attempt spelling through either update alias and returns the current attempt', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'agent-1' } }
    vi.mocked(handlers.updateTask).mockResolvedValue({
      taskId: 't1',
      status: 'running',
      deliveryState: 'delivered',
      attemptId: 'att-1',
    })

    const primary = await tools.get('team_mode_task_update')!.execute(
      { task_id: 't1', status: 'in_progress', attempt_id: 'att-1' },
      exec,
    )
    expect(handlers.updateTask).toHaveBeenLastCalledWith({
      task_id: 't1',
      status: 'in_progress',
      attemptId: 'att-1',
    })
    expect(primary).toMatchObject({ task_id: 't1', attempt_id: 'att-1' })

    // The camelCase spelling works on the snake_case tool too, and vice versa.
    await tools.get('team_mode_task_update')!.execute(
      { task_id: 't1', status: 'in_progress', attemptId: 'att-1' },
      exec,
    )
    expect(handlers.updateTask).toHaveBeenLastCalledWith({
      task_id: 't1',
      status: 'in_progress',
      attemptId: 'att-1',
    })

    const legacy = await tools.get('team_update_task')!.execute(
      { taskId: 't1', status: 'in_progress', attemptId: 'att-1' },
      exec,
    )
    expect(handlers.updateTask).toHaveBeenLastCalledWith({
      taskId: 't1',
      status: 'in_progress',
      attemptId: 'att-1',
    })
    expect(legacy).toMatchObject({ task_id: 't1', attempt_id: 'att-1' })

    await tools.get('team_update_task')!.execute(
      { taskId: 't1', status: 'in_progress', attempt_id: 'att-1' },
      exec,
    )
    expect(handlers.updateTask).toHaveBeenLastCalledWith({
      taskId: 't1',
      status: 'in_progress',
      attemptId: 'att-1',
    })
  })

  it('maps internal task statuses to AionUi statuses', async () => {
    const { tools } = harness()
    const result = await tools.get('team_mode_task_update')!.execute(
      { task_id: 't1', status: 'in_progress' },
      { agent: { id: 'agent-1' } },
    )
    expect(result).toMatchObject({ task_id: 't1', status: 'in_progress' })
  })
})

function memoryView(entryId: string, status: 'active' | 'proposed' | 'superseded' | 'archived') {
  return {
    entry_id: entryId,
    title: 'Memory',
    body: 'Body',
    status,
    visibility: 'team-safe' as const,
    source: 'member' as const,
    revision: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}
