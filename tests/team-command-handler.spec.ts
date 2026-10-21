import { describe, expect, it, vi } from 'vitest'
import type {
  TeamAggregate,
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
})
