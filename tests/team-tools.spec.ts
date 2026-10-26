import { describe, expect, it, vi } from 'vitest'
import { AgentTeamError } from '../src/domain/errors.js'
import type { TeamToolHandlers } from '../src/runtime/team-tools.js'
import {
  allowedInheritedToolNames,
  allowedTeamToolNames,
  memberToolPolicyFor,
  registerTeamTools,
  resolveMemberToolPolicy,
  TEAM_TOOL_NAMES,
} from '../src/runtime/team-tools.js'

type RegisteredTool = {
  name: string
  description: string
  parameters: {
    properties?: Record<string, unknown>
    required?: string[]
  }
  execute: (args: Record<string, unknown>, exec: { agent: unknown }) => Promise<Record<string, unknown>>
}

function harness(options: { allow: string[] } | undefined = undefined): {
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
    createTask: vi.fn(async () => ({ taskId: 't1', status: 'assigned', kind: 'work' as const, deliveryState: 'delivered' as const })),
    updateTask: vi.fn(async () => ({ taskId: 't1', status: 'running', deliveryState: 'delivered' as const })),
    claimTask: vi.fn(async () => ({ taskId: 't1', status: 'assigned' as const, owner: 'member', attemptId: 'att-1' })),
    refreshEscalations: vi.fn(async () => undefined),
    inbox: vi.fn(() => ({ assigned: [], ready: [], unread: [], approvals: [], remaining_unread: 0 })),
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
    updateGoal: vi.fn(async () => ({
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
    proposeMemory: vi.fn(async () => ({
      revision: 1,
      entry: memoryView('mem-1', 'proposed'),
    })),
    listMemory: vi.fn(() => ({ revision: 0, total: 0, truncated: false, entries: [] })),
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
  registerTeamTools(
    ctx as never,
    handlers,
    options === undefined ? {} : { policy: { allow: options.allow } },
  )
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
      'team_mode_goal_update',
      'team_mode_task_create',
      'team_mode_task_update',
      'team_mode_task_claim',
      'team_mode_task_list',
      'team_mode_inbox',
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
    expect(tools.size).toBe(24)
  })

  it('publishes the required parameter contracts for the dangerous tools', () => {
    const { tools } = harness()
    expect(tools.get('team_send_message')?.parameters.required).toEqual(expect.arrayContaining(['to', 'message']))
    expect(tools.get('team_mode_task_create')?.parameters.required).toEqual(['subject'])
    expect(tools.get('team_mode_task_update')?.parameters.required).toEqual(expect.arrayContaining(['task_id', 'status']))
    expect(tools.get('team_spawn_agent')?.parameters.required).toEqual(expect.arrayContaining(['name', 'assistant_id']))
    expect(tools.get('team_mode_task_claim')?.parameters.required).toEqual(['task_id'])
    expect(tools.get('team_mode_task_claim')?.description).toContain('atomic')
    expect(tools.get('team_shutdown_agent')?.description).toContain('Leader only')
    expect(tools.get('team_clear_agent_context')?.description).toContain('Leader only')
    expect(tools.get('team_mode_goal_create')?.description).toContain('Leader only')
    expect(tools.get('team_mode_goal_create')?.parameters.required).toEqual(['title', 'objective'])
    expect(tools.get('team_mode_goal_create')?.parameters.properties?.mode).toBeDefined()
    expect(tools.get('team_mode_goal_create')?.parameters.properties?.max_turns).toBeDefined()
    expect(tools.get('team_mode_goal_update')?.description).toContain('Leader only')
    // status is optional now: the same tool renews an exhausted max_turns budget.
    expect(tools.get('team_mode_goal_update')?.parameters.required).toEqual(['goal_id'])
    expect(tools.get('team_mode_goal_update')?.parameters.properties?.status).toMatchObject({
      enum: ['active', 'paused', 'completed', 'cancelled'],
    })
    expect(tools.get('team_mode_goal_update')?.parameters.properties?.max_turns).toBeDefined()
    expect(tools.get('team_memory_propose')?.parameters.required)
      .toEqual(expect.arrayContaining(['expected_revision', 'title', 'body']))
    expect(tools.get('team_memory_accept')?.parameters.required)
      .toEqual(expect.arrayContaining(['entry_id', 'expected_revision']))
    expect(tools.get('team_memory_accept')?.description).toContain('Leader only')
    expect(tools.get('team_memory_list')?.description).toContain('only active entries')
    expect(tools.get('team_spawn_agent')?.parameters.properties?.assistant_instance_id).toBeDefined()
  })

  it('forwards an explicit assistant instance link through team_spawn_agent', async () => {
    const { tools, handlers } = harness()
    const spawn = tools.get('team_spawn_agent')!
    const spawned = await spawn.execute(
      { name: 'Linked', assistant_id: 'assistant-1', assistant_instance_id: 'instance-1' },
      { agent: { id: 'session-leader' } },
    )

    expect(handlers.spawnAgent).toHaveBeenCalledWith({
      name: 'Linked',
      assistantId: 'assistant-1',
      assistantInstanceId: 'instance-1',
    })
    expect(spawned.member).toMatchObject({ slot_id: 's1' })

    // An omitted link keeps the legacy call shape so existing callers are
    // unaffected.
    await spawn.execute(
      { name: 'Plain', assistant_id: 'assistant-1' },
      { agent: { id: 'session-leader' } },
    )
    expect(handlers.spawnAgent).toHaveBeenLastCalledWith({
      name: 'Plain',
      assistantId: 'assistant-1',
    })
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
    expect(listed).toMatchObject({
      memory_revision: 0,
      total: 0,
      truncated: false,
      entries: [],
    })
    expect(handlers.listMemory).toHaveBeenCalledWith({})

    await list.execute({ query: 'tabs', status: 'active', limit: 5 }, exec)
    expect(handlers.listMemory).toHaveBeenLastCalledWith({
      query: 'tabs',
      status: 'active',
      limit: 5,
    })

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
      { title: 'Ship parser', objective: 'Parse input', acceptance: 'tests pass', mode: 'single', max_turns: 3 },
      exec,
    )
    expect(handlers.createGoal).toHaveBeenCalledWith({
      title: 'Ship parser',
      objective: 'Parse input',
      acceptance: 'tests pass',
      mode: 'single',
      max_turns: 3,
    })
    expect(created).toMatchObject({ goal: { goal_id: 'g1', mode: 'single' } })

    await tools.get('team_mode_goal_create')!.execute({ title: 'T', objective: 'O' }, exec)
    expect(handlers.createGoal).toHaveBeenLastCalledWith({ title: 'T', objective: 'O' })

    await tools.get('team_mode_goal_list')!.execute({}, exec)
    expect(handlers.listGoals).toHaveBeenCalled()

    // A paused Goal (the epoch transition pauses active Goals) is resumed
    // through the same tool; the handler receives the raw status.
    const resumed = await tools.get('team_mode_goal_update')!.execute(
      { goal_id: 'g1', status: 'active' },
      exec,
    )
    expect(handlers.updateGoal).toHaveBeenCalledWith({ goal_id: 'g1', status: 'active' })
    expect(resumed).toMatchObject({ goal: { goal_id: 'g1' } })

    // Renewal is a budget-only write: no status is needed to raise the ceiling.
    await tools.get('team_mode_goal_update')!.execute({ goal_id: 'g1', max_turns: 9 }, exec)
    expect(handlers.updateGoal).toHaveBeenLastCalledWith({ goal_id: 'g1', max_turns: 9 })

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

  it('forwards thread, Goal and reply links through team_send_message', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'session-member' } }
    const send = tools.get('team_send_message')!

    await send.execute(
      {
        to: 'a',
        message: 'reply body',
        thread_id: 'thread-1',
        goal_id: 'goal-1',
        reply_to: 'message-1',
      },
      exec,
    )
    expect(handlers.sendMessage).toHaveBeenLastCalledWith({
      to: 'a',
      message: 'reply body',
      thread_id: 'thread-1',
      goal_id: 'goal-1',
      reply_to: 'message-1',
    })

    // Legacy callers keep the exact old shape: no link keys are invented.
    await send.execute({ to: 'a', message: 'plain body' }, exec)
    expect(handlers.sendMessage).toHaveBeenLastCalledWith({ to: 'a', message: 'plain body' })
  })

  it('forwards thread and task filters through team_read_messages', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'session-member' } }
    const read = tools.get('team_read_messages')!
    expect(read.parameters.properties?.thread_id).toBeDefined()
    expect(read.parameters.properties?.task_id).toBeDefined()
    expect(read.description).toContain('leaves messages outside the filter unread')

    await read.execute({ limit: 5, thread_id: 'thread-1', task_id: 'task-1' }, exec)
    expect(handlers.readMessages).toHaveBeenLastCalledWith(5, {
      threadId: 'thread-1',
      taskId: 'task-1',
    })

    // Legacy unfiltered reads are byte-identical calls: no filter argument.
    await read.execute({ limit: 5 }, exec)
    expect(handlers.readMessages).toHaveBeenLastCalledWith(5, undefined)
  })

  it('reads the inbox through the bound handler without marking mail read', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'session-member' } }
    const inbox = tools.get('team_mode_inbox')!
    expect(inbox.description).toContain('Read-only')
    expect(inbox.description).toContain('never marks mail read')
    expect(inbox.parameters.required).toBeUndefined()

    vi.mocked(handlers.inbox).mockReturnValue({
      assigned: [],
      ready: [],
      unread: [],
      approvals: [{ id: 'i1', kind: 'approval', approvalId: 'ap-1', toolName: 'bash' }],
      remaining_unread: 3,
      cross_team: {
        teams: [{ team_id: 'team-2', team_name: 'Other', ready: 1, approvals: 0, questions: 0 }],
        items: [{ team_id: 'team-2', team_name: 'Other', kind: 'ready_task', id: 't9', summary: 'Ready' }],
        total: 1,
      },
    })
    const result = await inbox.execute({ limit: 5 }, exec)
    expect(handlers.assertIdentity).toHaveBeenCalledWith(exec.agent)
    expect(handlers.inbox).toHaveBeenCalledWith({ limit: 5 })
    expect(result).toMatchObject({
      assigned: [],
      ready: [],
      unread: [],
      approvals: [{ approvalId: 'ap-1' }],
      remaining_unread: 3,
      // Coordinator fields are additive: the tool name and existing shape hold.
      cross_team: {
        teams: [{ team_id: 'team-2', ready: 1 }],
        items: [{ team_id: 'team-2', kind: 'ready_task' }],
        total: 1,
      },
    })

    // An omitted limit is forwarded as an empty input, not as limit: undefined.
    await inbox.execute({}, exec)
    expect(handlers.inbox).toHaveBeenLastCalledWith({})
  })

  it('claims a task through the bound handler and returns the fresh attempt', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'session-member' } }
    const claim = tools.get('team_mode_task_claim')!

    const claimed = await claim.execute({ task_id: 't7' }, exec)
    expect(handlers.assertIdentity).toHaveBeenCalledWith(exec.agent)
    expect(handlers.claimTask).toHaveBeenCalledWith({ task_id: 't7' })
    expect(claimed).toMatchObject({
      task_id: 't1',
      status: 'pending',
      raw_status: 'assigned',
      owner: 'member',
      attempt_id: 'att-1',
    })

    // A legacy task without a fence omits attempt_id instead of printing null.
    vi.mocked(handlers.claimTask).mockResolvedValue({ taskId: 't8', status: 'assigned', owner: 'member' })
    const unfenced = await claim.execute({ task_id: 't8' }, exec)
    expect(unfenced).toMatchObject({ task_id: 't8', owner: 'member' })
    expect(unfenced).not.toHaveProperty('attempt_id')
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
      kind: 'work',
      deliveryState: 'delivered',
      attemptId: 'att-9',
    })
    const primary = await tools.get('team_mode_task_create')!.execute({ subject: 's', owner: 'a' }, exec)
    expect(primary).toMatchObject({ task_id: 't9', attempt_id: 'att-9' })
    const legacy = await tools.get('team_create_task')!.execute({ title: 's', ownerSlotId: 'a' }, exec)
    expect(legacy).toMatchObject({ task_id: 't9', attempt_id: 'att-9' })

    vi.mocked(handlers.createTask).mockResolvedValue({ taskId: 't10', status: 'pending', kind: 'work' })
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

  it('declares the quality parameters and their enums on task create and update', () => {
    const { tools } = harness()
    const create = tools.get('team_mode_task_create')!
    expect(create.parameters.properties?.kind).toMatchObject({
      enum: ['work', 'implementation', 'repair', 'verification', 'review'],
    })
    expect(create.parameters.properties?.acceptance).toBeDefined()
    expect(create.parameters.properties?.reviewed_task_id).toBeDefined()

    const update = tools.get('team_mode_task_update')!
    expect(update.parameters.properties?.verdict).toMatchObject({
      enum: ['pass', 'needs_revision', 'reject'],
    })
    expect(update.parameters.properties?.findings).toBeDefined()

    // The legacy aliases stay frozen at their pre-quality shape.
    expect(tools.get('team_create_task')?.parameters.properties).not.toHaveProperty('kind')
    expect(tools.get('team_update_task')?.parameters.properties).not.toHaveProperty('verdict')
  })

  it('forwards kind, acceptance and reviewed_task_id from create and omits absent defaults', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'agent-1' } }
    const create = tools.get('team_mode_task_create')!

    await create.execute(
      {
        subject: 'Review parser',
        kind: 'review',
        acceptance: 'tests pass',
        reviewed_task_id: 'task-impl',
      },
      exec,
    )
    expect(handlers.createTask).toHaveBeenLastCalledWith({
      subject: 'Review parser',
      kind: 'review',
      acceptance: 'tests pass',
      reviewed_task_id: 'task-impl',
    })

    vi.mocked(handlers.createTask).mockResolvedValue({
      taskId: 'task-review',
      status: 'assigned',
      kind: 'review',
      reviewedTaskId: 'task-impl',
      deliveryState: 'delivered',
    })
    const created = await create.execute(
      { subject: 'Review parser', kind: 'review', reviewed_task_id: 'task-impl' },
      exec,
    )
    expect(created).toMatchObject({ kind: 'review', reviewed_task_id: 'task-impl' })

    await create.execute({ subject: 'Plain work' }, exec)
    expect(handlers.createTask).toHaveBeenLastCalledWith({ subject: 'Plain work' })
  })

  it('forwards verdict and findings from update and leaves the legacy alias without them', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'agent-1' } }
    const update = tools.get('team_mode_task_update')!

    vi.mocked(handlers.updateTask).mockResolvedValue({
      taskId: 't1',
      status: 'failed',
      verdict: 'reject',
      deliveryState: 'delivered',
    })
    const failed = await update.execute(
      {
        task_id: 't1',
        status: 'failed',
        attempt_id: 'att-1',
        verdict: 'reject',
        findings: 'Parser drops trailing bytes.',
      },
      exec,
    )
    expect(handlers.updateTask).toHaveBeenLastCalledWith({
      task_id: 't1',
      status: 'failed',
      attemptId: 'att-1',
      verdict: 'reject',
      findings: 'Parser drops trailing bytes.',
    })
    expect(failed).toMatchObject({ verdict: 'reject' })

    // A pass needs no findings, and the alias has no quality parameters at all.
    await update.execute({ task_id: 't2', status: 'completed', verdict: 'pass' }, exec)
    expect(handlers.updateTask).toHaveBeenLastCalledWith({
      task_id: 't2',
      status: 'completed',
      verdict: 'pass',
    })

    await tools.get('team_update_task')!.execute(
      { taskId: 't3', status: 'completed', attemptId: 'att-3' },
      exec,
    )
    expect(handlers.updateTask).toHaveBeenLastCalledWith({
      taskId: 't3',
      status: 'completed',
      attemptId: 'att-3',
    })
  })

  it('declares due/remind times on the primary task tools and freezes the aliases', () => {
    const { tools } = harness()
    const create = tools.get('team_mode_task_create')!
    expect(create.parameters.properties?.due_at).toBeDefined()
    expect(create.parameters.properties?.remind_at).toBeDefined()

    const update = tools.get('team_mode_task_update')!
    expect(update.parameters.properties?.due_at).toBeDefined()
    expect(update.parameters.properties?.remind_at).toBeDefined()

    // The legacy aliases stay frozen at their pre-reminder shape.
    expect(tools.get('team_create_task')?.parameters.properties).not.toHaveProperty('due_at')
    expect(tools.get('team_update_task')?.parameters.properties).not.toHaveProperty('remind_at')
  })

  it('forwards due/remind times from the primary tools and omits absent values', async () => {
    const { tools, handlers } = harness()
    const exec = { agent: { id: 'agent-1' } }
    const create = tools.get('team_mode_task_create')!
    const update = tools.get('team_mode_task_update')!

    await create.execute(
      {
        subject: 'Timed work',
        due_at: '2026-02-01T10:30:00.000Z',
        remind_at: '2026-02-01T08:00:00.000Z',
      },
      exec,
    )
    expect(handlers.createTask).toHaveBeenLastCalledWith({
      subject: 'Timed work',
      due_at: '2026-02-01T10:30:00.000Z',
      remind_at: '2026-02-01T08:00:00.000Z',
    })

    await create.execute({ subject: 'Plain work' }, exec)
    expect(handlers.createTask).toHaveBeenLastCalledWith({ subject: 'Plain work' })

    await update.execute(
      {
        task_id: 't1',
        status: 'in_progress',
        attempt_id: 'att-1',
        due_at: '',
        remind_at: '2026-02-01T08:00:00.000Z',
      },
      exec,
    )
    expect(handlers.updateTask).toHaveBeenLastCalledWith({
      task_id: 't1',
      status: 'in_progress',
      attemptId: 'att-1',
      due_at: '',
      remind_at: '2026-02-01T08:00:00.000Z',
    })
  })
})

describe('Leader handoff authority', () => {
  it('never exposes a model-facing handoff tool', () => {
    const { tools } = harness()
    // A Leader handing off its own turn would leave that turn dangling, so the
    // handoff is a user action over the transport, not a tool. This guards the
    // surface against a future accidental registration.
    expect([...tools.keys()].some(name => /handoff/i.test(name))).toBe(false)
    expect(TEAM_TOOL_NAMES.some(name => /handoff/i.test(name))).toBe(false)
  })
})

describe('member tool policies', () => {
  it('keeps the member tool baseline at exactly 24 names', () => {
    expect(TEAM_TOOL_NAMES).toHaveLength(24)
    expect(new Set(TEAM_TOOL_NAMES).size).toBe(24)
    const { tools } = harness()
    expect(tools.size).toBe(24)
    expect([...tools.keys()].sort()).toEqual([...TEAM_TOOL_NAMES].sort())
  })

  it('narrows the baseline in baseline order and never widens it', () => {
    expect(allowedTeamToolNames(TEAM_TOOL_NAMES, {
      allow: ['team_send_message', 'team_members', 'tool_that_does_not_exist'],
    })).toEqual(['team_members', 'team_send_message'])

    // An empty policy is a closed surface, not a re-opened baseline.
    expect(allowedTeamToolNames(TEAM_TOOL_NAMES, { allow: [] })).toEqual([])

    // Omitted policy keeps the full baseline, and the result is a copy.
    const full = allowedTeamToolNames(TEAM_TOOL_NAMES, undefined)
    expect(full).toEqual([...TEAM_TOOL_NAMES])
    full.pop()
    expect(TEAM_TOOL_NAMES).toHaveLength(24)

    // Whitespace and blank entries are normalized out.
    expect(allowedTeamToolNames(TEAM_TOOL_NAMES, { allow: [' team_members ', ''] }))
      .toEqual(['team_members'])
  })

  it('filters team tools at registration instead of through tools.restrict', () => {
    const { tools } = harness({ allow: ['team_members', 'team_mode_task_list'] })
    expect([...tools.keys()]).toEqual(['team_members', 'team_mode_task_list'])
    expect(tools.has('team_spawn_agent')).toBe(false)
    expect(tools.has('team_create_task')).toBe(false)
  })

  it('resolves a policy id against deployment config and fails closed on unknown ids', () => {
    const policies = { readonly: { description: 'read only', allow: ['team_members'] } }
    expect(resolveMemberToolPolicy(policies, undefined)).toBeUndefined()
    expect(resolveMemberToolPolicy(policies, 'readonly')).toBe(policies.readonly)
    expect(resolveMemberToolPolicy(undefined, undefined)).toBeUndefined()

    expect(() => resolveMemberToolPolicy(policies, 'missing')).toThrowError(AgentTeamError)
    expect(() => resolveMemberToolPolicy(policies, 'missing'))
      .toThrowError(/Unknown member tool policy 'missing'/)
    expect(() => resolveMemberToolPolicy(undefined, 'readonly')).toThrowError(AgentTeamError)
    // Inherited Object members are not policy ids.
    expect(() => resolveMemberToolPolicy(policies, 'constructor')).toThrowError(AgentTeamError)
  })

  it('applies policies to members only, so the Leader surface is unaffected', () => {
    const policies = { readonly: { allow: ['team_members'] } }
    expect(memberToolPolicyFor('leader', policies, 'readonly')).toBeUndefined()
    // Even an id that deployment config no longer declares cannot fail Leader startup.
    expect(memberToolPolicyFor('leader', policies, 'missing')).toBeUndefined()
    expect(memberToolPolicyFor('member', policies, 'readonly')).toBe(policies.readonly)
    expect(memberToolPolicyFor('member', policies, undefined)).toBeUndefined()
    expect(() => memberToolPolicyFor('member', policies, 'missing')).toThrowError(AgentTeamError)
  })

  it('allows only inherited tools named by the policy, never team tools or run_code', () => {
    expect(allowedInheritedToolNames(
      ['bash', 'read', 'skill', 'run_code', 'team_members', 'team_create_task'],
      { allow: ['bash', 'skill', 'team_members', 'run_code', 'missing'] },
    )).toEqual(['bash', 'skill'])
    expect(allowedInheritedToolNames(['bash'], { allow: ['team_members'] })).toEqual([])
  })
})

function memoryView(
  entryId: string,
  status: 'active' | 'proposed' | 'superseded' | 'archived',
) {
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
