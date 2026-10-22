import { describe, expect, it, vi } from 'vitest'
import type {
  TeamAggregate,
  TeamGoal,
  TeamMemberSlot,
  TeamMessage,
  TeamTask,
} from '../src/domain/types.js'
import type { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import {
  TeamCommandHandler,
  type TeamCommandPort,
} from '../src/runtime/team-command-handler.js'

const NOW = '2026-01-01T00:00:00.000Z'

function member(
  id: string,
  displayName: string,
  role: 'leader' | 'member',
  sessionId: string,
): TeamMemberSlot {
  return {
    id,
    assistantId: `assistant-${id}`,
    displayName,
    role,
    assistantSnapshot: {
      assistantId: `assistant-${id}`,
      revision: 1,
      name: displayName,
      instructions: '',
      provider: 'test',
      model: 'test-model',
      agentPresetId: 'standard',
      permissionPresetId: 'read-only',
      skillAllowlist: [],
      mcpServers: [],
    },
    permissionPresetId: 'read-only',
    sessionId,
    desiredState: 'online',
    lastRuntimeState: 'idle',
    joinedAt: NOW,
  } as unknown as TeamMemberSlot
}

function makeTeam(): TeamAggregate {
  const leader = member('leader', 'Lead', 'leader', 'session-leader')
  const a = member('a', 'Alpha', 'member', 'session-a')
  const b = member('b', 'Beta', 'member', 'session-b')
  return {
    schemaVersion: 1,
    id: 'team-1',
    name: 'Test Team',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/test-team',
    leaderSlotId: leader.id,
    state: 'active',
    directMemberChat: true,
    members: { [leader.id]: leader, [a.id]: a, [b.id]: b },
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function harness() {
  let team = makeTeam()
  const messages: TeamMessage[] = []
  const service = {
    config: { maxTeamTasks: 256, maxTeamMessageBytes: 64 * 1024 },
    getTeam: vi.fn(() => team),
    listMessages: vi.fn(() => ({
      items: messages.filter(message => message.teamId === team.id),
      total: messages.filter(message => message.teamId === team.id).length,
    })),
    putRuntimeMessage: vi.fn(async (message: TeamMessage) => {
      const index = messages.findIndex(item => item.id === message.id)
      if (index === -1) messages.push(message)
      else messages[index] = message
    }),
    updateRuntimeTeam: vi.fn(async (
      _teamId: string,
      update: (current: TeamAggregate) => TeamAggregate,
    ) => {
      team = update(team)
      return team
    }),
    addMemberWithSlot: vi.fn(async (
      _teamId: string,
      input: { assistantId: string; displayName?: string },
    ) => {
      const added = member(`spawn-${input.assistantId}`, input.displayName ?? 'Spawned', 'member', 'session-spawn')
      team = { ...team, members: { ...team.members, [added.id]: added } }
      return { team, member: added }
    }),
    createGoal: vi.fn(async (
      _teamId: string,
      input: {
        title: string
        objective: string
        acceptance?: string
        mode?: 'direct' | 'single' | 'orchestrated'
      },
    ) => {
      const goal: TeamGoal = {
        id: `goal-${Object.keys(team.goals ?? {}).length + 1}`,
        teamId: team.id,
        title: input.title,
        objective: input.objective,
        acceptance: input.acceptance ?? '',
        mode: input.mode ?? 'single',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      }
      team = { ...team, goals: { ...team.goals, [goal.id]: goal } }
      return goal
    }),
    renameMember: vi.fn(async (_teamId: string, slotId: string, newName: string) => {
      team = {
        ...team,
        members: {
          ...team.members,
          [slotId]: { ...team.members[slotId]!, displayName: newName },
        },
      }
      return team
    }),
  } as unknown as AgentTeamService

  const followup = vi.fn()
  const removeMember = vi.fn(async () => undefined)
  const port: TeamCommandPort = {
    deliverMessage: vi.fn(async (_teamId: string, messageId: string) => {
      const record = team.outbox[messageId]
      if (record === undefined) return true
      const index = messages.findIndex(item => item.id === record.id)
      if (index === -1) messages.push({ ...record, deliveryState: 'delivered' })
      else messages[index] = { ...record, deliveryState: 'delivered' }
      const recipientSlotId = record.recipient.slotId
      const recipient = recipientSlotId === undefined ? undefined : team.members[recipientSlotId]
      if (recipient !== undefined) followup(recipient.sessionId, { id: record.id })
      const outbox = { ...team.outbox }
      delete outbox[messageId]
      team = { ...team, outbox }
      return true
    }),
    followup,
    removeMember,
  }
  const commands = new TeamCommandHandler(service, port)
  return {
    commands,
    service,
    team: () => team,
    mutate: (next: TeamAggregate) => { team = next },
    messages,
    followup,
    removeMember,
  }
}

describe('TeamCommandHandler AionUi semantics', () => {
  it('wakes an assigned task owner and records blocked_by as dependencyIds', async () => {
    const { commands, team, followup } = harness()
    const created = await commands.createTask(team().id, 'leader', {
      subject: 'Implement parser',
      description: 'Add the parser.',
      owner: 'a',
    })

    expect(created).toMatchObject({ status: 'assigned', deliveryState: 'delivered' })
    expect(followup).toHaveBeenCalledWith('session-a', expect.anything())
    expect(team().tasks[created.taskId]).toMatchObject({
      ownerSlotId: 'a',
      dependencyIds: [],
    })

    const blocker = await commands.createTask(team().id, 'leader', {
      subject: 'Design parser',
      owner: 'b',
    })
    const blocked = await commands.createTask(team().id, 'leader', {
      subject: 'Review parser',
      owner: 'a',
      blocked_by: [blocker.taskId],
    })
    expect(team().tasks[blocked.taskId]?.dependencyIds).toEqual([blocker.taskId])
  })

  it('does not wake the owner of a task that is still blocked', async () => {
    const { commands, team, followup } = harness()
    const blocker = await commands.createTask(team().id, 'leader', { subject: 'Blocker', owner: 'a' })
    followup.mockClear()

    const blocked = await commands.createTask(team().id, 'leader', {
      subject: 'Blocked work',
      owner: 'b',
      blocked_by: [blocker.taskId],
    })

    expect(blocked).toMatchObject({ status: 'assigned' })
    expect(blocked).not.toHaveProperty('deliveryState')
    expect(followup).not.toHaveBeenCalled()

    await commands.updateTask(team().id, 'a', {
      taskId: blocker.taskId,
      status: 'completed',
      attempt_id: team().tasks[blocker.taskId]!.attemptId!,
    })
    expect(followup).toHaveBeenCalledWith('session-b', expect.anything())
  })

  it('merges a concurrent task update instead of clobbering the latest board', async () => {
    const { commands, service, team, mutate } = harness()
    const first = await commands.createTask(team().id, 'leader', { subject: 'First', owner: 'a' })
    const second = await commands.createTask(team().id, 'leader', { subject: 'Second', owner: 'b' })
    const extra: TeamTask = {
      id: 'extra',
      title: 'Concurrent task',
      description: '',
      status: 'pending',
      dependencyIds: [],
      fileScopes: [],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const baseUpdate = (service as unknown as {
      updateRuntimeTeam: (...args: never[]) => Promise<TeamAggregate>
    }).updateRuntimeTeam
    let injected = false
    ;(service as unknown as { updateRuntimeTeam: unknown }).updateRuntimeTeam = vi.fn(async (
      ...args: never[]
    ) => {
      if (!injected) {
        injected = true
        mutate({ ...team(), tasks: { ...team().tasks, [extra.id]: extra } })
      }
      return baseUpdate(...args)
    })

    await commands.updateTask(team().id, 'a', {
      taskId: first.taskId,
      status: 'in_progress',
      attempt_id: team().tasks[first.taskId]!.attemptId!,
    })

    expect(team().tasks[extra.id]).toBeDefined()
    expect(team().tasks[first.taskId]?.status).toBe('running')
    expect(team().tasks[second.taskId]?.status).toBe('assigned')
  })

  it('clears downstream blockers when a task completes and wakes the unblocked owner', async () => {
    const { commands, team, followup } = harness()
    const first = await commands.createTask(team().id, 'leader', { subject: 'First', owner: 'a' })
    const second = await commands.createTask(team().id, 'leader', {
      subject: 'Second',
      owner: 'b',
      blocked_by: [first.taskId],
    })
    followup.mockClear()

    const result = await commands.updateTask(team().id, 'a', {
      taskId: first.taskId,
      status: 'completed',
      attempt_id: team().tasks[first.taskId]!.attemptId!,
    })

    expect(result.woken).toContain('b')
    expect(team().tasks[second.taskId]?.dependencyIds).toEqual([])
    expect(followup).toHaveBeenCalledWith('session-b', expect.anything())
  })

  it('enforces the task and message quotas', async () => {
    const { commands, service, team } = harness()
    ;(service.config as { maxTeamTasks?: number }).maxTeamTasks = 1
    await commands.createTask(team().id, 'leader', { subject: 'One' })
    await expect(commands.createTask(team().id, 'leader', { subject: 'Two' }))
      .rejects.toMatchObject({ code: 'TEAM_LIMIT_REACHED' })

    ;(service.config as { maxTeamMessageBytes?: number }).maxTeamMessageBytes = 8
    await expect(commands.sendMessage(team().id, 'leader', { to: 'a', message: 'more than eight bytes' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('wakes a new owner when the leader reassigns a task', async () => {
    const { commands, team, followup } = harness()
    const created = await commands.createTask(team().id, 'leader', { subject: 'Move me', owner: 'a' })
    followup.mockClear()
    const updated = await commands.updateTask(team().id, 'leader', {
      taskId: created.taskId,
      status: 'pending',
      owner: 'b',
    })
    expect(updated.deliveryState).toBe('delivered')
    expect(followup).toHaveBeenCalledWith('session-b', expect.anything())
    expect(team().tasks[created.taskId]?.ownerSlotId).toBe('b')
  })

  it('mints an attempt when a task gains an owner and exposes it on the board', async () => {
    const { commands, team } = harness()
    const owned = await commands.createTask(team().id, 'leader', { subject: 'Owned', owner: 'a' })
    const attempt = owned.attemptId
    expect(attempt).toBeTypeOf('string')
    expect(team().tasks[owned.taskId]?.attemptId).toBe(attempt)
    expect(commands.listTasks(team().id).find(task => task.task_id === owned.taskId)).toMatchObject({
      owner: 'a',
      attempt_id: attempt,
    })

    const unowned = await commands.createTask(team().id, 'leader', { subject: 'Unowned' })
    expect(unowned.attemptId).toBeUndefined()
    expect(team().tasks[unowned.taskId]?.attemptId).toBeUndefined()
    expect(commands.listTasks(team().id).find(task => task.task_id === unowned.taskId))
      .not.toHaveProperty('attempt_id')

    // Assignment of a previously unowned task mints its first attempt.
    const assigned = await commands.updateTask(team().id, 'leader', {
      taskId: unowned.taskId,
      status: 'assigned',
      owner: 'b',
    })
    expect(assigned.attemptId).toBeTypeOf('string')
    expect(team().tasks[unowned.taskId]?.attemptId).toBe(assigned.attemptId)
  })

  it('rejects a member update with a missing or stale attempt and accepts the current one', async () => {
    const { commands, team } = harness()
    const created = await commands.createTask(team().id, 'leader', { subject: 'Fenced', owner: 'a' })
    const attempt = created.attemptId!

    await expect(commands.updateTask(team().id, 'a', {
      taskId: created.taskId,
      status: 'in_progress',
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      details: { taskId: created.taskId, attemptId: attempt },
    })
    await expect(commands.updateTask(team().id, 'a', {
      taskId: created.taskId,
      status: 'in_progress',
      attempt_id: 'not-the-current-attempt',
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      details: { taskId: created.taskId, attemptId: attempt },
    })
    expect(team().tasks[created.taskId]).toMatchObject({ status: 'assigned', revision: 1 })

    const accepted = await commands.updateTask(team().id, 'a', {
      taskId: created.taskId,
      status: 'in_progress',
      attemptId: attempt,
    })
    expect(accepted).toMatchObject({ status: 'running', attemptId: attempt })
    expect(team().tasks[created.taskId]?.status).toBe('running')
  })

  it('rotates the attempt on reassignment and keeps leader updates token-free', async () => {
    const { commands, team } = harness()
    const created = await commands.createTask(team().id, 'leader', { subject: 'Handoff', owner: 'a' })
    const first = created.attemptId!

    // The leader needs no token and a plain update must not rotate the fence.
    const leaderUpdate = await commands.updateTask(team().id, 'leader', {
      taskId: created.taskId,
      status: 'running',
    })
    expect(leaderUpdate).toMatchObject({ status: 'running', attemptId: first })

    // Naming the current owner explicitly is not an ownership change.
    const sameOwner = await commands.updateTask(team().id, 'leader', {
      taskId: created.taskId,
      status: 'running',
      owner: 'a',
    })
    expect(sameOwner.attemptId).toBe(first)

    const moved = await commands.updateTask(team().id, 'leader', {
      taskId: created.taskId,
      status: 'pending',
      owner: 'b',
    })
    const second = moved.attemptId
    expect(second).toBeDefined()
    expect(second).not.toBe(first)

    // Handing the task back to the previous member does not revive its token.
    const back = await commands.updateTask(team().id, 'leader', {
      taskId: created.taskId,
      status: 'pending',
      owner: 'a',
    })
    const third = back.attemptId
    expect(third).not.toBe(first)
    expect(third).not.toBe(second)
    await expect(commands.updateTask(team().id, 'a', {
      taskId: created.taskId,
      status: 'in_progress',
      attempt_id: second!,
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      details: { taskId: created.taskId, attemptId: third },
    })
    await commands.updateTask(team().id, 'a', {
      taskId: created.taskId,
      status: 'in_progress',
      attempt_id: third!,
    })
    expect(team().tasks[created.taskId]?.status).toBe('running')
  })

  it('leaves a legacy task without an attempt unfenced until its owner changes', async () => {
    const { commands, team, mutate } = harness()
    // A board record persisted before attemptId existed.
    const legacy: TeamTask = {
      id: 'legacy',
      title: 'Legacy task',
      description: '',
      status: 'running',
      ownerSlotId: 'a',
      dependencyIds: [],
      fileScopes: [],
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
    }
    mutate({ ...team(), tasks: { ...team().tasks, [legacy.id]: legacy } })

    const done = await commands.updateTask(team().id, 'a', { taskId: legacy.id, status: 'completed' })
    expect(done.status).toBe('completed')
    // A plain status update never lazy-mints an attempt for a legacy task.
    expect(team().tasks[legacy.id]?.attemptId).toBeUndefined()

    // Reopening with the same owner is not an ownership change either.
    const reopened = await commands.updateTask(team().id, 'leader', {
      taskId: legacy.id,
      status: 'running',
      owner: 'a',
    })
    expect(reopened.attemptId).toBeUndefined()

    // The next real owner change mints one, and fencing starts there.
    const moved = await commands.updateTask(team().id, 'leader', {
      taskId: legacy.id,
      status: 'running',
      owner: 'b',
    })
    expect(moved.attemptId).toBeTypeOf('string')
    await expect(commands.updateTask(team().id, 'b', { taskId: legacy.id, status: 'completed' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await commands.updateTask(team().id, 'b', {
      taskId: legacy.id,
      status: 'completed',
      attempt_id: moved.attemptId!,
    })
  })

  it('fences a member write when the attempt rotates between the board read and the write', async () => {
    const { commands, service, team, mutate } = harness()
    const created = await commands.createTask(team().id, 'leader', { subject: 'Race', owner: 'a' })
    const staleAttempt = team().tasks[created.taskId]!.attemptId!
    const baseUpdate = (service as unknown as {
      updateRuntimeTeam: (...args: never[]) => Promise<TeamAggregate>
    }).updateRuntimeTeam
    let injected = false
    ;(service as unknown as { updateRuntimeTeam: unknown }).updateRuntimeTeam = vi.fn(async (
      ...args: never[]
    ) => {
      if (!injected) {
        injected = true
        // Takeover and hand-back land after the member read the board: same
        // owner, new attempt.
        mutate({
          ...team(),
          tasks: {
            ...team().tasks,
            [created.taskId]: { ...team().tasks[created.taskId]!, attemptId: 'rotated-attempt' },
          },
        })
      }
      return baseUpdate(...args)
    })

    await expect(commands.updateTask(team().id, 'a', {
      taskId: created.taskId,
      status: 'in_progress',
      attempt_id: staleAttempt,
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      details: { taskId: created.taskId, attemptId: 'rotated-attempt' },
    })
    // The rejected write must not have partially updated the board.
    expect(team().tasks[created.taskId]).toMatchObject({
      ownerSlotId: 'a',
      attemptId: 'rotated-attempt',
      status: 'assigned',
      revision: 1,
    })
  })

  it('rejects a member write when ownership moved between the board read and the write', async () => {
    const { commands, service, team, mutate } = harness()
    const created = await commands.createTask(team().id, 'leader', { subject: 'Race 2', owner: 'a' })
    const currentAttempt = team().tasks[created.taskId]!.attemptId!
    const baseUpdate = (service as unknown as {
      updateRuntimeTeam: (...args: never[]) => Promise<TeamAggregate>
    }).updateRuntimeTeam
    let injected = false
    ;(service as unknown as { updateRuntimeTeam: unknown }).updateRuntimeTeam = vi.fn(async (
      ...args: never[]
    ) => {
      if (!injected) {
        injected = true
        mutate({
          ...team(),
          tasks: {
            ...team().tasks,
            [created.taskId]: {
              ...team().tasks[created.taskId]!,
              ownerSlotId: 'b',
              attemptId: 'reassigned-attempt',
            },
          },
        })
      }
      return baseUpdate(...args)
    })

    await expect(commands.updateTask(team().id, 'a', {
      taskId: created.taskId,
      status: 'in_progress',
      attempt_id: currentAttempt,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST', details: { taskId: created.taskId } })
    expect(team().tasks[created.taskId]).toMatchObject({
      ownerSlotId: 'b',
      attemptId: 'reassigned-attempt',
      status: 'assigned',
      revision: 1,
    })
  })

  it('broadcasts to every active member except the sender', async () => {
    const { commands, team, followup, messages } = harness()
    const result = await commands.sendMessage(team().id, 'leader', {
      to: '*',
      message: 'Deploy freeze starts now',
      summary: 'Freeze',
      files: ['docs/release.md', 'https://example.com/runbook'],
    })

    expect(result.deliveredTo.sort()).toEqual(['a', 'b'])
    expect(result.deliveryState).toBe('delivered')
    expect(followup.mock.calls.map(call => call[0]).sort()).toEqual(['session-a', 'session-b'])
    expect(messages[0]).toMatchObject({
      recipient: { kind: 'broadcast' },
      summary: 'Freeze',
      deliveryState: 'delivered',
      attachments: [
        { kind: 'workspace_path', value: 'docs/release.md' },
        { kind: 'url', value: 'https://example.com/runbook' },
      ],
    })
  })

  it('tracks broadcast read receipts per recipient', async () => {
    const { commands, team, messages } = harness()
    await commands.sendMessage(team().id, 'leader', { to: '*', message: 'everyone please read' })
    expect(messages[0]?.readBy).toEqual([])

    await commands.readMessages(team().id, 'a', 10)
    expect(messages[0]?.readBy).toEqual(['a'])
    await commands.readMessages(team().id, 'b', 10)
    expect(messages[0]?.readBy).toEqual(['a', 'b'])
  })

  it('reads the mailbox unread-first and marks returned messages read', async () => {
    const { commands, team } = harness()
    await commands.sendMessage(team().id, 'a', { to: 'leader', message: 'progress update' })
    const before = await commands.readMessages(team().id, 'leader', 10)
    expect(before.messages).toHaveLength(1)
    expect(before.messages[0]).toMatchObject({ from: 'Alpha', was_unread: true })
    expect(before.remaining_unread).toBe(0)
    expect(team().members['leader']).toBeDefined()
    const after = await commands.readMessages(team().id, 'leader', 10)
    expect(after.messages[0]?.was_unread).toBe(false)
  })

  it('spawns and renames members only for the leader', async () => {
    const { commands } = harness()
    const spawned = await commands.spawnAgent('team-1', 'leader', {
      name: 'Gamma',
      assistantId: 'assistant-gamma',
    })
    expect(spawned.name).toBe('Gamma')
    expect(spawned.role).toBe('member')
    await expect(commands.spawnAgent('team-1', 'a', {
      name: 'Nope',
      assistantId: 'assistant-gamma',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const renamed = await commands.renameAgent('team-1', 'leader', spawned.slot_id, 'Delta')
    expect(renamed).toEqual({ slot_id: spawned.slot_id, name: 'Delta' })
  })

  it('wakes the leader when a shutdown is rejected', async () => {
    const { commands, team, followup, removeMember } = harness()
    await commands.shutdownAgent(team().id, 'leader', 'a')
    followup.mockClear()

    await commands.sendMessage(team().id, 'a', {
      to: 'leader',
      message: 'shutdown_rejected: still waiting for review',
    })

    expect(followup).toHaveBeenCalledWith('session-leader', expect.anything())
    expect(removeMember).not.toHaveBeenCalled()
  })

  it('requests shutdown and removes the target after shutdown_approved', async () => {
    vi.useFakeTimers()
    try {
      const { commands, team, removeMember } = harness()
      const request = await commands.shutdownAgent(team().id, 'leader', 'a')
      expect(request.status).toBe('requested')

      await commands.sendMessage(team().id, 'a', {
        to: 'leader',
        message: 'shutdown_approved',
      })
      expect(removeMember).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(removeMember).toHaveBeenCalledWith(team().id, 'a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates a Goal and groups a single deliverable as one Goal plus one Task', async () => {
    const { commands, team } = harness()
    await expect(commands.createGoal(team().id, 'a', {
      title: 'Unauthorized',
      objective: 'Members cannot create goals',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const goal = await commands.createGoal(team().id, 'leader', {
      title: 'Ship parser',
      objective: 'Parse the input format',
      acceptance: 'tests pass',
    })
    expect(goal).toMatchObject({
      title: 'Ship parser',
      objective: 'Parse the input format',
      acceptance: 'tests pass',
      mode: 'single',
      status: 'active',
      task_ids: [],
    })

    const task = await commands.createTask(team().id, 'leader', {
      subject: 'Implement parser',
      owner: 'a',
      goal_id: goal.goal_id,
    })
    expect(team().tasks[task.taskId]?.goalId).toBe(goal.goal_id)
    expect(commands.listGoals(team().id)).toEqual([
      { ...goal, task_ids: [task.taskId] },
    ])
    expect(commands.listTasks(team().id)[0]?.goal_id).toBe(goal.goal_id)
  })

  it('groups orchestrated dependent tasks under one Goal', async () => {
    const { commands, team } = harness()
    const goal = await commands.createGoal(team().id, 'leader', {
      title: 'Ship parser',
      objective: 'Parse and verify the input format',
      acceptance: 'review passes',
      mode: 'orchestrated',
    })
    const implement = await commands.createTask(team().id, 'leader', {
      subject: 'Implement parser',
      owner: 'a',
      goal_id: goal.goal_id,
    })
    const review = await commands.createTask(team().id, 'leader', {
      subject: 'Review parser',
      owner: 'b',
      blocked_by: [implement.taskId],
      goalId: goal.goal_id,
    })

    expect(goal.mode).toBe('orchestrated')
    expect(team().tasks[review.taskId]?.dependencyIds).toEqual([implement.taskId])
    expect(commands.listGoals(team().id)[0]?.task_ids.sort()).toEqual(
      [implement.taskId, review.taskId].sort(),
    )
  })

  it('rejects a task goal_id that is not a Goal of this team', async () => {
    const { commands, team } = harness()
    await expect(commands.createTask(team().id, 'leader', {
      subject: 'Orphan',
      goal_id: 'goal-from-another-team',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(Object.keys(team().tasks)).toHaveLength(0)
  })

  it('keeps ungrouped tasks valid and puts the attempt token in wake copy', async () => {
    const { commands, team, messages } = harness()
    expect(commands.listGoals(team().id)).toEqual([])

    const created = await commands.createTask(team().id, 'leader', {
      subject: 'Ungrouped work',
      owner: 'a',
    })
    expect(team().tasks[created.taskId]).not.toHaveProperty('goalId')
    expect(commands.listTasks(team().id)[0]).not.toHaveProperty('goal_id')
    const dispatch = messages.find(message => message.relatedTaskId === created.taskId)
    expect(dispatch?.content).toContain('Your attempt_id for this task is')
    expect(dispatch?.content).toContain(created.attemptId)
    expect(dispatch?.content).toContain('team_mode_task_update')

    const reassigned = await commands.updateTask(team().id, 'leader', {
      taskId: created.taskId,
      status: 'assigned',
      owner: 'b',
    })
    const wake = messages.find(
      message => message.relatedTaskId === created.taskId && message.recipient.slotId === 'b',
    )
    expect(wake?.content).toContain('Your attempt_id for this task is')
    expect(wake?.content).toContain(reassigned.attemptId)
  })

  it('keeps an optional Goal link on the task board across updates', async () => {
    const { commands, team, mutate } = harness()
    const goal: TeamGoal = {
      id: 'goal-1',
      teamId: team().id,
      title: 'Ship the parser',
      objective: 'Parse the input format',
      acceptance: 'tests pass',
      mode: 'single',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    }
    const linked: TeamTask = {
      id: 'linked',
      title: 'Linked task',
      description: '',
      status: 'pending',
      goalId: goal.id,
      dependencyIds: [],
      fileScopes: [],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const unlinked: TeamTask = {
      id: 'unlinked',
      title: 'Unlinked task',
      description: '',
      status: 'pending',
      dependencyIds: [],
      fileScopes: [],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }
    mutate({ ...team(), goals: { [goal.id]: goal }, tasks: { [linked.id]: linked, [unlinked.id]: unlinked } })

    expect(commands.listTasks(team().id).map(view => view.task_id)).toEqual(['linked', 'unlinked'])

    await commands.updateTask(team().id, 'leader', { taskId: linked.id, status: 'in_progress' })
    expect(team().tasks[linked.id]?.goalId).toBe(goal.id)
    expect(team().tasks[unlinked.id]).not.toHaveProperty('goalId')
    expect(team().goals?.[goal.id]?.title).toBe('Ship the parser')
  })
})
