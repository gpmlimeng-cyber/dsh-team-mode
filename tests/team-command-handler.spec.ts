import { describe, expect, it, vi } from 'vitest'
import type {
  TeamAggregate,
  TeamGoal,
  TeamMemberSlot,
  TeamMessage,
  TeamTask,
} from '../src/domain/types.js'
import { AgentTeamError } from '../src/domain/errors.js'
import { teamMessageSchema } from '../src/domain/schemas.js'
import type { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import {
  TeamCommandHandler,
  type ClaimTaskResult,
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

/** A second team with its own leader and members, for isolation tests. */
function makeOtherTeam(): TeamAggregate {
  const leader = member('leader-2', 'Other Lead', 'leader', 'session-leader-2')
  const peer = member('a2', 'Other Member', 'member', 'session-a2')
  return {
    ...makeTeam(),
    id: 'team-2',
    name: 'Other Team',
    leaderSlotId: leader.id,
    members: { [leader.id]: leader, [peer.id]: peer },
  }
}

function harness() {
  let team = makeTeam()
  let other = makeOtherTeam()
  const messages: TeamMessage[] = []
  const aggregates = (): Map<string, TeamAggregate> => new Map([
    [team.id, team],
    [other.id, other],
  ])
  const requireAggregate = (teamId: string): TeamAggregate => {
    const found = aggregates().get(teamId)
    if (found === undefined) {
      throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${teamId}'`)
    }
    return found
  }
  const service = {
    config: { maxTeamTasks: 256, maxTeamMessageBytes: 64 * 1024 },
    getTeam: vi.fn((teamId: string) => requireAggregate(teamId)),
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
      teamId: string,
      update: (current: TeamAggregate) => TeamAggregate,
      _kind?: string,
      _summary?: string,
      options?: { expectedEpoch?: number },
    ) => {
      const current = requireAggregate(teamId)
      // Model the real service's serialized epoch fence.
      if (options?.expectedEpoch !== undefined && (current.epoch ?? 1) !== options.expectedEpoch) {
        throw new AgentTeamError('EPOCH_STALE', `Team epoch changed to ${current.epoch ?? 1}`)
      }
      const next = update(current)
      if (next.id === other.id) other = next
      else team = next
      return next
    }),
    addMemberWithSlot: vi.fn(async (
      _teamId: string,
      input: { assistantId: string; displayName?: string; assistantInstanceId?: string },
    ) => {
      const added = {
        ...member(`spawn-${input.assistantId}`, input.displayName ?? 'Spawned', 'member', 'session-spawn'),
        ...(input.assistantInstanceId === undefined
          ? {}
          : { assistantInstanceId: input.assistantInstanceId }),
      }
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
    updateGoal: vi.fn(async (
      _teamId: string,
      goalId: string,
      value: { status?: TeamGoal['status'] },
    ) => {
      const existing = team.goals?.[goalId]
      if (existing === undefined) {
        throw new AgentTeamError('INVALID_REQUEST', `Unknown goal '${goalId}' in team '${team.id}'`)
      }
      const updated: TeamGoal = {
        ...existing,
        ...(value.status === undefined ? {} : { status: value.status }),
        updatedAt: NOW,
      }
      team = { ...team, goals: { ...team.goals, [goalId]: updated } }
      return updated
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
    port,
    service,
    team: () => team,
    otherTeam: () => other,
    mutate: (next: TeamAggregate) => {
      if (next.id === other.id) other = next
      else team = next
    },
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

  it('lets a member claim a ready unowned task and fences the claim with a fresh attempt', async () => {
    const { commands, team } = harness()
    const created = await commands.createTask(team().id, 'leader', { subject: 'Ready work' })
    expect(team().tasks[created.taskId]).toMatchObject({ status: 'pending', dependencyIds: [] })
    expect(team().tasks[created.taskId]?.ownerSlotId).toBeUndefined()

    const claimed = await commands.claimTask(team().id, 'b', { task_id: created.taskId })
    expect(claimed).toMatchObject({ taskId: created.taskId, status: 'assigned', owner: 'b' })
    expect(claimed.attemptId).toBeTypeOf('string')
    const claimAttempt = claimed.attemptId!
    expect(team().tasks[created.taskId]).toMatchObject({
      status: 'assigned',
      ownerSlotId: 'b',
      attemptId: claimed.attemptId,
      revision: 2,
    })
    expect(commands.listTasks(team().id).find(task => task.task_id === created.taskId))
      .toMatchObject({ owner: 'b', attempt_id: claimed.attemptId })

    // The claim token is the fence for every later member update.
    await expect(commands.updateTask(team().id, 'b', {
      taskId: created.taskId,
      status: 'in_progress',
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      details: { taskId: created.taskId, attemptId: claimed.attemptId },
    })
    await commands.updateTask(team().id, 'b', {
      taskId: created.taskId,
      status: 'in_progress',
      attempt_id: claimAttempt,
    })
    expect(team().tasks[created.taskId]?.status).toBe('running')

    // A Leader takeover mints its own attempt; the claim token stops working.
    const takeover = await commands.updateTask(team().id, 'leader', {
      taskId: created.taskId,
      status: 'pending',
      owner: 'a',
    })
    expect(takeover.attemptId).toBeTypeOf('string')
    expect(takeover.attemptId).not.toBe(claimed.attemptId)
    await expect(commands.updateTask(team().id, 'b', {
      taskId: created.taskId,
      status: 'in_progress',
      attempt_id: claimAttempt,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(team().tasks[created.taskId]).toMatchObject({
      ownerSlotId: 'a',
      attemptId: takeover.attemptId,
    })
  })

  it('awards exactly one concurrent claim and returns the winner owner and attempt to the loser', async () => {
    const { commands, team } = harness()
    const created = await commands.createTask(team().id, 'leader', { subject: 'Contested' })

    const settled = await Promise.allSettled([
      commands.claimTask(team().id, 'a', { task_id: created.taskId }),
      commands.claimTask(team().id, 'b', { task_id: created.taskId }),
    ])
    const winners = settled.filter(
      (entry): entry is PromiseFulfilledResult<ClaimTaskResult> => entry.status === 'fulfilled',
    )
    const losers = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    )
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    const winner = winners[0]!.value
    const winningAttempt = winner.attemptId!
    expect(winner.owner).toBe('a')
    expect(losers[0]!.reason).toMatchObject({
      code: 'INVALID_REQUEST',
      details: {
        taskId: created.taskId,
        owner: winner.owner,
        attemptId: winner.attemptId,
      },
    })
    expect(team().tasks[created.taskId]).toMatchObject({
      ownerSlotId: winner.owner,
      attemptId: winner.attemptId,
      revision: 2,
    })

    // The losing member's inferred token is not usable; only the winner's is.
    await expect(commands.updateTask(team().id, 'b', {
      taskId: created.taskId,
      status: 'in_progress',
      attempt_id: winningAttempt,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await commands.updateTask(team().id, 'a', {
      taskId: created.taskId,
      status: 'in_progress',
      attempt_id: winningAttempt,
    })
  })

  it('rejects claims for owned, blocked, running and terminal tasks without mutating the board', async () => {
    const { commands, team } = harness()
    const owned = await commands.createTask(team().id, 'leader', { subject: 'Owned', owner: 'a' })
    const ownedAttempt = team().tasks[owned.taskId]?.attemptId
    await expect(commands.claimTask(team().id, 'b', { task_id: owned.taskId }))
      .rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        details: {
          taskId: owned.taskId,
          owner: 'a',
          attemptId: ownedAttempt,
          status: 'assigned',
        },
      })

    const dependency = await commands.createTask(team().id, 'leader', { subject: 'First' })
    const blocked = await commands.createTask(team().id, 'leader', {
      subject: 'Blocked',
      blocked_by: [dependency.taskId],
    })
    expect(team().tasks[blocked.taskId]).toMatchObject({
      status: 'pending',
      dependencyIds: [dependency.taskId],
    })
    await expect(commands.claimTask(team().id, 'a', { task_id: blocked.taskId }))
      .rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        details: { taskId: blocked.taskId, status: 'pending', blocked_by: [dependency.taskId] },
      })

    const completed = await commands.createTask(team().id, 'leader', { subject: 'Done' })
    await commands.updateTask(team().id, 'leader', { taskId: completed.taskId, status: 'completed' })
    await expect(commands.claimTask(team().id, 'a', { task_id: completed.taskId }))
      .rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        details: { taskId: completed.taskId, status: 'completed' },
      })

    const cancelled = await commands.createTask(team().id, 'leader', { subject: 'Dropped' })
    await commands.updateTask(team().id, 'leader', { taskId: cancelled.taskId, status: 'cancelled' })
    await expect(commands.claimTask(team().id, 'a', { task_id: cancelled.taskId }))
      .rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        details: { taskId: cancelled.taskId, status: 'cancelled' },
      })

    const running = await commands.createTask(team().id, 'leader', { subject: 'Busy' })
    await commands.updateTask(team().id, 'leader', { taskId: running.taskId, status: 'running' })
    await expect(commands.claimTask(team().id, 'a', { task_id: running.taskId }))
      .rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        details: { taskId: running.taskId, status: 'running' },
      })

    await expect(commands.claimTask(team().id, 'a', { task_id: 'missing-task' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', details: { taskId: 'missing-task' } })
    await expect(commands.claimTask(team().id, 'a', { task_id: '   ' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    // Every rejection left the blocked task exactly as the Leader created it.
    expect(team().tasks[blocked.taskId]).toMatchObject({ status: 'pending', revision: 1 })
    expect(team().tasks[blocked.taskId]?.ownerSlotId).toBeUndefined()
    expect(team().tasks[blocked.taskId]?.attemptId).toBeUndefined()
  })

  it('keeps claims inside the team and treats a re-claim by the owner as a read', async () => {
    const { commands, team } = harness()
    const created = await commands.createTask(team().id, 'leader', { subject: 'Isolated' })
    const other = await commands.createTask('team-2', 'leader-2', { subject: 'Other team work' })

    // Another team's member cannot address this board at all.
    await expect(commands.claimTask(team().id, 'a2', { task_id: created.taskId }))
      .rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
    // A task id from another board is unknown in this team.
    await expect(commands.claimTask(team().id, 'a', { task_id: other.taskId }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', details: { taskId: other.taskId } })

    const claimed = await commands.claimTask(team().id, 'a', { task_id: created.taskId })
    const again = await commands.claimTask(team().id, 'a', { task_id: created.taskId })
    expect(again).toEqual(claimed)
    // A re-claim is informational: it neither rotates the fence nor rewrites.
    expect(team().tasks[created.taskId]).toMatchObject({
      ownerSlotId: 'a',
      attemptId: claimed.attemptId,
      revision: 2,
    })
  })

  it('projects a read-only inbox of assigned tasks, ready work, unread mail and approvals', async () => {
    const { commands, team, messages, port } = harness()
    const mine = await commands.createTask(team().id, 'leader', { subject: 'Mine', owner: 'a' })
    const mineAttempt = team().tasks[mine.taskId]!.attemptId!
    await commands.updateTask(team().id, 'a', {
      taskId: mine.taskId,
      status: 'in_progress',
      attempt_id: mineAttempt,
    })
    await commands.createTask(team().id, 'leader', { subject: 'Someone else', owner: 'b' })
    const ready = await commands.createTask(team().id, 'leader', { subject: 'Ready work' })
    const dependency = await commands.createTask(team().id, 'leader', { subject: 'Dependency' })
    await commands.createTask(team().id, 'leader', {
      subject: 'Ready but blocked',
      blocked_by: [dependency.taskId],
    })
    // Dispatch mails from the task setup above would otherwise mix into a's
    // unread section; this test owns the message log from here.
    messages.length = 0
    await commands.sendMessage(team().id, 'leader', { to: 'a', message: 'first mail' })
    await commands.sendMessage(team().id, 'leader', { to: 'a', message: 'second mail' })
    await commands.sendMessage(team().id, 'leader', { to: 'b', message: 'not for a' })
    ;(port as { pendingInteractions?: TeamCommandPort['pendingInteractions'] }).pendingInteractions = () => [
      { id: 'i1', kind: 'approval', approvalId: 'ap-1', toolName: 'bash', reason: 'needs review' },
      { id: 'q1', kind: 'question', questions: [] },
    ]

    const inbox = commands.inbox(team().id, 'a')

    expect(inbox.assigned.map(task => task.task_id)).toEqual([mine.taskId])
    expect(inbox.assigned[0]).toMatchObject({ owner: 'a', raw_status: 'running' })
    // The dependency itself is ready; the task blocked by it is not. Created in
    // one millisecond, so only membership is deterministic here.
    expect(inbox.ready.map(task => task.task_id).sort())
      .toEqual([ready.taskId, dependency.taskId].sort())
    // Both sends can share one millisecond timestamp, so order is only stable
    // within a timestamp; assert membership, not clock order.
    expect(inbox.unread.map(message => message.message).sort()).toEqual(['first mail', 'second mail'])
    // Only approvals are surfaced; a pending question stays in the workbench.
    expect(inbox.approvals).toEqual([
      { id: 'i1', kind: 'approval', approvalId: 'ap-1', toolName: 'bash', reason: 'needs review' },
    ])
    expect(inbox.remaining_unread).toBe(0)

    // Read-only: the projection must not consume the mail it shows.
    const stored = messages.filter(message => message.recipient.slotId === 'a')
    expect(stored).toHaveLength(2)
    for (const message of stored) {
      expect(message.deliveryState).toBe('delivered')
      expect(message.readBy).toEqual([])
    }
    expect(commands.inbox(team().id, 'a').unread).toHaveLength(2)
  })

  it('caps the inbox at 20 per section and 50 rows total in fill order', async () => {
    const { commands, team, messages, port } = harness()
    for (let index = 0; index < 25; index += 1) {
      await commands.createTask(team().id, 'leader', { subject: `Mine ${index}`, owner: 'a' })
    }
    for (let index = 0; index < 18; index += 1) {
      await commands.createTask(team().id, 'leader', { subject: `Ready ${index}` })
    }
    messages.length = 0
    for (let index = 0; index < 18; index += 1) {
      await commands.sendMessage(team().id, 'leader', { to: 'a', message: `mail ${index}` })
    }
    ;(port as { pendingInteractions?: TeamCommandPort['pendingInteractions'] }).pendingInteractions =
      () => Array.from({ length: 18 }, (_, index) => ({
        id: `i${index}`,
        kind: 'approval' as const,
        approvalId: `ap-${index}`,
        toolName: 'bash',
      }))

    // Default limit 20: the section cap holds, and the 50-row budget is spent
    // in the documented order (assigned, ready, unread, approvals).
    const big = commands.inbox(team().id, 'a')
    expect(big.assigned).toHaveLength(20)
    expect(big.ready).toHaveLength(18)
    expect(big.unread).toHaveLength(12)
    expect(big.approvals).toHaveLength(0)
    expect(big.assigned.length + big.ready.length + big.unread.length + big.approvals.length).toBe(50)
    expect(big.remaining_unread).toBe(6)

    // A smaller limit cuts every section, including approvals.
    const small = commands.inbox(team().id, 'a', { limit: 3 })
    expect(small.assigned).toHaveLength(3)
    expect(small.ready).toHaveLength(3)
    expect(small.unread).toHaveLength(3)
    expect(small.approvals).toHaveLength(3)
    expect(small.remaining_unread).toBe(15)

    // Out-of-range limits clamp instead of throwing or returning everything.
    expect(commands.inbox(team().id, 'a', { limit: 0 }).assigned).toHaveLength(1)
    expect(commands.inbox(team().id, 'a', { limit: 500 }).assigned).toHaveLength(20)
  })

  it('scopes the inbox to the calling member and team', async () => {
    const { commands, team, messages } = harness()
    const mine = await commands.createTask(team().id, 'leader', { subject: 'Mine', owner: 'a' })
    await commands.createTask(team().id, 'leader', { subject: 'Ready for anyone' })
    await commands.createTask('team-2', 'leader-2', { subject: 'Other team ready' })
    messages.length = 0
    await commands.sendMessage(team().id, 'leader', { to: 'a', message: 'mine to read' })
    await commands.sendMessage(team().id, 'leader', { to: 'a', message: 'a user dm' })
    const userDm = messages.find(message => message.content === 'a user dm')!
    userDm.sender = { kind: 'user', id: 'local-user' }
    await commands.sendMessage(team().id, 'a', { to: '*', message: 'a broadcast by a' })

    const inbox = commands.inbox(team().id, 'a')
    expect(inbox.assigned.map(task => task.task_id)).toEqual([mine.taskId])
    expect(inbox.ready.map(task => task.subject)).toEqual(['Ready for anyone'])
    // A direct user message and a broadcast from the caller are not inbox mail.
    expect(inbox.unread.map(message => message.message)).toEqual(['mine to read'])
    // Another team's member cannot address this inbox at all.
    expect(() => commands.inbox(team().id, 'a2')).toThrow(expect.objectContaining({ code: 'MEMBER_NOT_FOUND' }))
    expect(() => commands.inbox(team().id, 'missing-member')).toThrow(
      expect.objectContaining({ code: 'MEMBER_NOT_FOUND' }),
    )
    // No approvals provider (or a restarted runtime) degrades to an empty list.
    expect(commands.inbox(team().id, 'a').approvals).toEqual([])
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

  it('carries the task link, thread and Goal on dispatch, reassignment and unblock mail', async () => {
    const { commands, team, messages } = harness()
    const goal = await commands.createGoal(team().id, 'leader', {
      title: 'Ship parser',
      objective: 'Parse input',
      mode: 'single',
    })
    const task = await commands.createTask(team().id, 'leader', {
      subject: 'Implement parser',
      owner: 'a',
      goal_id: goal.goal_id,
    })
    const assignment = messages.find(message => message.relatedTaskId === task.taskId)!
    expect(assignment).toMatchObject({
      relatedTaskId: task.taskId,
      threadId: task.taskId,
      goalId: goal.goal_id,
      recipient: { kind: 'member', slotId: 'a' },
    })
    // Thread id and the single task link are separate fields, never a second
    // `taskId`; a task thread is stable because every task mail reuses the id.
    expect(assignment).not.toHaveProperty('taskId')

    await commands.updateTask(team().id, 'leader', {
      taskId: task.taskId,
      owner: 'b',
      status: 'assigned',
    })
    const reassignment = messages.filter(
      message => message.relatedTaskId === task.taskId && message.recipient.slotId === 'b',
    ).at(-1)!
    expect(reassignment).toMatchObject({ threadId: task.taskId, goalId: goal.goal_id })

    const dependency = await commands.createTask(team().id, 'leader', { subject: 'Prep' })
    const blocked = await commands.createTask(team().id, 'leader', {
      subject: 'Blocked work',
      owner: 'a',
      blocked_by: [dependency.taskId],
      goal_id: goal.goal_id,
    })
    await commands.updateTask(team().id, 'leader', {
      taskId: dependency.taskId,
      status: 'completed',
    })
    const unblock = messages.filter(
      message => message.relatedTaskId === blocked.taskId,
    ).at(-1)!
    expect(unblock).toMatchObject({
      relatedTaskId: blocked.taskId,
      threadId: blocked.taskId,
      goalId: goal.goal_id,
      recipient: { kind: 'member', slotId: 'a' },
    })
  })

  it('round-trips thread, Goal and reply links through send_message and the read filters', async () => {
    const { commands, team, messages } = harness()
    const goal = await commands.createGoal(team().id, 'leader', {
      title: 'Release',
      objective: 'Ship',
      mode: 'single',
    })
    const first = await commands.sendMessage(team().id, 'leader', {
      to: 'a',
      message: 'Please review the parser',
      thread_id: 'review-thread',
      goal_id: goal.goal_id,
    })
    const second = await commands.sendMessage(team().id, 'a', {
      to: 'leader',
      message: 'Reviewed, one nit',
      thread_id: 'review-thread',
      reply_to: first.messageId,
    })
    const unrelated = await commands.sendMessage(team().id, 'leader', {
      to: 'a',
      message: 'Unrelated note',
      thread_id: 'other-thread',
    })

    const record = messages.find(message => message.id === first.messageId)!
    expect(record).toMatchObject({ threadId: 'review-thread', goalId: goal.goal_id })
    const reply = messages.find(message => message.id === second.messageId)!
    expect(reply).toMatchObject({ threadId: 'review-thread', replyTo: first.messageId })
    expect(reply.goalId).toBeUndefined()

    const leaderThread = await commands.readMessages(team().id, 'leader', 10, {
      threadId: 'review-thread',
    })
    expect(leaderThread.messages.map(message => message.id)).toEqual([second.messageId])
    expect(leaderThread.messages[0]).toMatchObject({
      thread_id: 'review-thread',
      reply_to: first.messageId,
    })
    expect(leaderThread.messages[0]?.goal_id).toBeUndefined()

    // A filtered read consumes only what it returns; unrelated mail stays unread.
    const memberThread = await commands.readMessages(team().id, 'a', 10, {
      threadId: 'review-thread',
    })
    expect(memberThread.messages.map(message => message.id)).toEqual([first.messageId])
    expect(memberThread.messages[0]).toMatchObject({
      thread_id: 'review-thread',
      goal_id: goal.goal_id,
    })
    expect(memberThread.messages[0]).not.toHaveProperty('task_id')
    expect(commands.inbox(team().id, 'a').unread.map(message => message.id))
      .toEqual([unrelated.messageId])

    // Task filtering uses the single task link and returns only that task mail.
    const task = await commands.createTask(team().id, 'leader', { subject: 'Task mail', owner: 'a' })
    const taskMail = await commands.readMessages(team().id, 'a', 10, { taskId: task.taskId })
    expect(taskMail.messages.map(message => message.task_id)).toEqual([task.taskId])
    expect(taskMail.messages[0]?.thread_id).toBe(task.taskId)
  })

  it('rejects unknown or malformed message links and ignores blank ones', async () => {
    const { commands, team, messages, otherTeam, mutate } = harness()
    await expect(commands.sendMessage(team().id, 'leader', {
      to: 'a',
      message: 'bad goal',
      goal_id: 'no-such-goal',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(commands.sendMessage(team().id, 'leader', {
      to: 'a',
      message: 'bad reply',
      reply_to: 'no-such-message',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(commands.sendMessage(team().id, 'leader', {
      to: 'a',
      message: 'long thread',
      thread_id: 'x'.repeat(201),
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    // Another team's Goal is unknown here, not merely unvalidated.
    mutate({
      ...otherTeam(),
      goals: {
        'goal-other': {
          id: 'goal-other',
          teamId: otherTeam().id,
          title: 'Other',
          objective: 'Other',
          acceptance: '',
          mode: 'single',
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    })
    await expect(commands.sendMessage(team().id, 'leader', {
      to: 'a',
      message: 'foreign goal',
      goal_id: 'goal-other',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const sent = await commands.sendMessage(team().id, 'leader', {
      to: 'a',
      message: 'blank links',
      thread_id: '   ',
      goal_id: '',
      reply_to: '',
    })
    const record = messages.find(message => message.id === sent.messageId)!
    expect(record.threadId).toBeUndefined()
    expect(record.goalId).toBeUndefined()
    expect(record.replyTo).toBeUndefined()
  })

  it('keeps legacy messages without thread links parseable and readable unfiltered', async () => {
    const { commands, team, messages } = harness()
    // A record persisted before thread context existed.
    const legacy: TeamMessage = {
      schemaVersion: 1,
      id: 'legacy-message',
      teamId: team().id,
      sender: { kind: 'member', id: 'leader' },
      recipient: { kind: 'member', slotId: 'a' },
      type: 'instruction',
      content: 'legacy body',
      attachments: [],
      readBy: [],
      deliveryState: 'delivered',
      idempotencyKey: 'legacy-message',
      createdAt: '2025-12-31T23:59:59.000Z',
    }
    expect(teamMessageSchema.parse(legacy)).toEqual(legacy)
    messages.push(legacy)

    const legacyRead = await commands.readMessages(team().id, 'a', 10)
    expect(legacyRead.messages.map(message => message.id)).toEqual(['legacy-message'])
    expect(legacyRead.messages[0]).not.toHaveProperty('thread_id')
    expect(legacyRead.messages[0]).not.toHaveProperty('goal_id')
    expect(legacyRead.messages[0]).not.toHaveProperty('reply_to')

    // A record carrying links still parses under the same schema/version.
    const linked = await commands.sendMessage(team().id, 'leader', {
      to: 'a',
      message: 'linked body',
      thread_id: 'thread-1',
    })
    const linkedRecord = messages.find(message => message.id === linked.messageId)!
    expect(teamMessageSchema.parse(linkedRecord)).toEqual(linkedRecord)
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

  it('forwards an explicit assistant instance link when spawning', async () => {
    const { commands, service } = harness()
    const spawned = await commands.spawnAgent('team-1', 'leader', {
      name: 'Linked',
      assistantId: 'assistant-linked',
      assistantInstanceId: 'instance-1',
    })
    expect(service.addMemberWithSlot).toHaveBeenCalledWith(
      'team-1',
      expect.objectContaining({ assistantInstanceId: 'instance-1' }),
    )
    expect(spawned.assistant_instance_id).toBe('instance-1')

    // Whitespace is not an id: the explicit link is validated like every other
    // tool input rather than being silently dropped.
    await expect(commands.spawnAgent('team-1', 'leader', {
      name: 'Blank link',
      assistantId: 'assistant-linked',
      assistantInstanceId: '   ',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
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

  it('lets a member propose team memory and only the Leader decide it', async () => {
    const { commands, team } = harness()

    const proposal = await commands.proposeMemory(team().id, 'a', {
      title: 'Use tabs',
      body: 'Agreed in the design review.',
      expected_revision: 0,
    })
    expect(proposal.revision).toBe(1)
    expect(proposal.entry).toMatchObject({
      status: 'proposed',
      visibility: 'team-safe',
      source: 'member',
      author_slot: 'a',
      revision: 1,
    })
    expect(team().memory?.entries).toHaveLength(1)

    // A member cannot decide any proposal, including its own.
    await expect(commands.decideMemory(team().id, 'a', {
      entry_id: proposal.entry.entry_id,
      expected_revision: 1,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const accepted = await commands.decideMemory(team().id, 'leader', {
      entry_id: proposal.entry.entry_id,
      expected_revision: 1,
    })
    expect(accepted.revision).toBe(2)
    expect(accepted.entry).toMatchObject({ status: 'active', revision: 2 })

    // A decided proposal is decided exactly once.
    await expect(commands.decideMemory(team().id, 'leader', {
      entry_id: proposal.entry.entry_id,
      expected_revision: 2,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const listed = commands.listMemory(team().id)
    expect(listed.revision).toBe(2)
    expect(listed.entries.map(entry => entry.status)).toEqual(['active'])
  })

  it('rejects a stale or missing team memory revision instead of overwriting', async () => {
    const { commands, team } = harness()
    await commands.proposeMemory(team().id, 'leader', {
      title: 'Commit style',
      body: 'Conventional commits.',
      expected_revision: 0,
    })

    await expect(commands.proposeMemory(team().id, 'a', {
      title: 'Stale proposal',
      body: 'Should not land.',
      expected_revision: 0,
    })).rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' })
    expect(team().memory?.entries).toHaveLength(1)

    await expect(commands.proposeMemory(team().id, 'missing-slot', {
      title: 'Unknown member',
      body: 'Should not land.',
      expected_revision: 1,
    })).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
  })

  it('refuses a Leader decision on its own proposal', async () => {
    const { commands, team, mutate } = harness()
    // Seeded directly: a Leader proposal normally becomes active on write, so
    // this is the only reachable shape where the author could decide its own.
    const entry = {
      id: 'own-proposal',
      scope: 'team' as const,
      visibility: 'team-safe' as const,
      status: 'proposed' as const,
      source: 'leader' as const,
      authorSlotId: 'leader',
      title: 'Own idea',
      body: 'Waiting for someone else.',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }
    mutate({ ...team(), memory: { revision: 1, entries: [entry], updatedAt: NOW } })

    await expect(commands.decideMemory(team().id, 'leader', {
      entry_id: entry.id,
      expected_revision: 1,
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('cannot decide its own'),
    })
  })

  it('writes Leader memory directly and supersedes an earlier keyed entry', async () => {
    const { commands, team } = harness()
    const first = await commands.proposeMemory(team().id, 'leader', {
      title: 'Lint',
      body: 'Use eslint.',
      key: 'lint',
      expected_revision: 0,
    })
    expect(first.entry).toMatchObject({ status: 'active', source: 'leader', revision: 1 })

    const second = await commands.proposeMemory(team().id, 'leader', {
      title: 'Lint',
      body: 'Use biome.',
      key: 'lint',
      expected_revision: 1,
    })
    const entries = new Map(
      commands.listMemory(team().id).entries.map(entry => [entry.entry_id, entry]),
    )
    expect(entries.get(first.entry.entry_id)).toMatchObject({ status: 'superseded', revision: 2 })
    expect(entries.get(second.entry.entry_id)).toMatchObject({ status: 'active', revision: 1 })
  })

  it('supersedes an active keyed entry when a member proposal is accepted, and rejects archive proposals', async () => {
    const { commands, team } = harness()
    const active = await commands.proposeMemory(team().id, 'leader', {
      title: 'Lint',
      body: 'Use eslint.',
      key: 'lint',
      expected_revision: 0,
    })
    const proposal = await commands.proposeMemory(team().id, 'a', {
      title: 'Lint',
      body: 'Use biome.',
      key: 'lint',
      expected_revision: 1,
    })
    const accepted = await commands.decideMemory(team().id, 'leader', {
      entry_id: proposal.entry.entry_id,
      expected_revision: 2,
    })
    expect(accepted.entry).toMatchObject({ status: 'active', revision: 2 })

    const entries = new Map(
      commands.listMemory(team().id).entries.map(entry => [entry.entry_id, entry.status]),
    )
    expect(entries.get(active.entry.entry_id)).toBe('superseded')
    expect(entries.get(proposal.entry.entry_id)).toBe('active')

    const pending = await commands.proposeMemory(team().id, 'b', {
      title: 'Release cadence',
      body: 'Every Friday.',
      expected_revision: 3,
    })
    const rejected = await commands.decideMemory(team().id, 'leader', {
      entry_id: pending.entry.entry_id,
      expected_revision: 4,
      decision: 'reject',
    })
    expect(rejected.entry).toMatchObject({ status: 'archived', revision: 2 })
    expect(new Set(commands.listMemory(team().id).entries.map(entry => entry.status)))
      .toEqual(new Set(['superseded', 'active', 'archived']))
  })

  it('keeps team memory isolated between two real aggregates', async () => {
    const { commands, team, otherTeam } = harness()
    const aEntry = await commands.proposeMemory(team().id, 'leader', {
      title: 'A fact',
      body: 'Only for team A.',
      expected_revision: 0,
    })
    expect(commands.listMemory(team().id).entries.map(entry => entry.title)).toEqual(['A fact'])
    expect(commands.listMemory(otherTeam().id)).toEqual({ revision: 0, entries: [] })

    // A member of team B cannot write into team A.
    await expect(commands.proposeMemory(team().id, 'a2', {
      title: 'B into A',
      body: 'Should not land.',
      expected_revision: 1,
    })).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
    // A member of team A cannot write into team B.
    await expect(commands.proposeMemory(otherTeam().id, 'a', {
      title: 'A into B',
      body: 'Should not land.',
      expected_revision: 0,
    })).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
    // Team B's leader cannot observe or decide team A's entry: it is unknown
    // inside aggregate B, so the decision fails without touching A.
    await expect(commands.decideMemory(otherTeam().id, 'leader-2', {
      entry_id: aEntry.entry.entry_id,
      expected_revision: 0,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(commands.listMemory(otherTeam().id).entries).toEqual([])
    expect(team().memory?.entries).toHaveLength(1)

    // Each aggregate keeps only its own entries.
    await commands.proposeMemory(otherTeam().id, 'leader-2', {
      title: 'B fact',
      body: 'Only for team B.',
      expected_revision: 0,
    })
    expect(commands.listMemory(team().id).entries.map(entry => entry.title)).toEqual(['A fact'])
    expect(commands.listMemory(otherTeam().id).entries.map(entry => entry.title)).toEqual(['B fact'])
  })

  it('rejects an unknown memory decision instead of defaulting to accept', async () => {
    const { commands, team } = harness()
    const proposal = await commands.proposeMemory(team().id, 'a', {
      title: 'Proposed',
      body: 'Waits for the Leader.',
      expected_revision: 0,
    })

    await expect(commands.decideMemory(team().id, 'leader', {
      entry_id: proposal.entry.entry_id,
      expected_revision: 1,
      decision: 'maybe' as never,
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('accept or reject'),
    })
    expect(team().memory?.revision).toBe(1)
    expect(team().memory?.entries[0]?.status).toBe('proposed')
  })

  it('counts only live team memory entries against the caps', async () => {
    const { commands, team, mutate } = harness()
    // 100 archived entries would fill both caps if history counted: the write
    // succeeds, which pins the "history is excluded" behavior.
    const history = Array.from({ length: 100 }, (_, index) => ({
      id: `mem-${index}`,
      scope: 'team' as const,
      visibility: 'team-safe' as const,
      status: (index % 2 === 0 ? 'archived' : 'superseded') as 'archived' | 'superseded',
      source: 'member' as const,
      authorSlotId: 'a',
      title: `Entry ${index}`,
      body: 'x'.repeat(200),
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }))
    mutate({ ...team(), memory: { revision: 3, entries: history, updatedAt: NOW } })

    const created = await commands.proposeMemory(team().id, 'a', {
      title: 'Fresh',
      body: 'Counts.',
      expected_revision: 3,
    })
    expect(created.revision).toBe(4)
    expect(created.entry.status).toBe('proposed')

    // 100 live entries are a hard cap: P0 has no delete for active entries.
    const live = Array.from({ length: 100 }, (_, index) => ({
      ...history[index]!,
      id: `live-${index}`,
      status: 'active' as const,
    }))
    mutate({ ...team(), memory: { revision: 5, entries: live, updatedAt: NOW } })
    await expect(commands.proposeMemory(team().id, 'a', {
      title: 'Over',
      body: 'Cap.',
      expected_revision: 5,
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('100 live entries'),
    })
  })
})

describe('Team Epoch writes and Goal status', () => {
  it('resumes a paused Goal through the Leader-only status write', async () => {
    const { commands, team, mutate } = harness()
    const goal = await commands.createGoal(team().id, 'leader', {
      title: 'Epoch goal',
      objective: 'Survive a Leader change',
    })
    mutate({
      ...team(),
      goals: {
        ...team().goals,
        [goal.goal_id]: { ...team().goals![goal.goal_id]!, status: 'paused' },
      },
    })

    // Only the Leader may move a Goal.
    await expect(commands.updateGoal(team().id, 'a', {
      goal_id: goal.goal_id,
      status: 'active',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const resumed = await commands.updateGoal(team().id, 'leader', {
      goal_id: goal.goal_id,
      status: 'active',
    })
    expect(resumed).toMatchObject({ goal_id: goal.goal_id, status: 'active' })
    expect(team().goals?.[goal.goal_id]?.status).toBe('active')

    await expect(commands.updateGoal(team().id, 'leader', {
      goal_id: 'missing',
      status: 'active',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(commands.updateGoal(team().id, 'leader', {
      goal_id: goal.goal_id,
      status: 'unknown',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    // A blank goal id never reaches the service.
    await expect(commands.updateGoal(team().id, 'leader', { status: 'active' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects a member write that presents a previous epoch', async () => {
    const { commands, team, mutate } = harness()
    const taskId = 'task-epoch'
    mutate({
      ...team(),
      epoch: 2,
      tasks: {
        [taskId]: {
          id: taskId,
          title: 'Old work',
          description: '',
          status: 'running',
          ownerSlotId: 'a',
          attemptId: 'attempt-1',
          dependencyIds: [],
          fileScopes: [],
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    })

    await expect(commands.updateTask(team().id, 'a', {
      task_id: taskId,
      status: 'completed',
      attempt_id: 'attempt-1',
    }, 1)).rejects.toMatchObject({ code: 'EPOCH_STALE' })
    expect(team().tasks[taskId]).toMatchObject({ status: 'running', revision: 1 })

    // The same write under the current epoch is accepted.
    await commands.updateTask(team().id, 'a', {
      task_id: taskId,
      status: 'completed',
      attempt_id: 'attempt-1',
    }, 2)
    expect(team().tasks[taskId]?.status).toBe('completed')
  })
})
