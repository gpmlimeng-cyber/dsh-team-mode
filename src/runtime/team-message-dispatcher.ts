import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamAggregate } from '../domain/types.js'
import type { AgentTeamService } from '../service/dsh-team-mode-service.js'
import { messageFromRecord, sessionHasMessage } from './team-messages.js'

interface TeamMessageDispatcherPort {
  resolveAgent: (sessionId: string) => Agent
  warn: (message: string, error: unknown) => void
}

export class TeamMessageDispatcher {
  constructor(
    private readonly service: AgentTeamService,
    private readonly port: TeamMessageDispatcherPort,
  ) {}

  async recover(team: TeamAggregate): Promise<void> {
    for (const messageId of Object.keys(team.outbox)) {
      await this.deliver(team.id, messageId)
    }
    team = this.service.getTeam(team.id)
    const pending = this.service.listMessages(team.id).items.filter(message => message.deliveryState === 'queued')
    for (const record of pending) {
      if (record.recipient.kind === 'broadcast') {
        await this.deliverBroadcast(team, record)
        continue
      }
      const slotId = record.recipient.slotId
      if (slotId === undefined) continue
      const recipient = team.members[slotId]
      if (recipient === undefined) {
        await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
        continue
      }
      try {
        const agent = this.port.resolveAgent(recipient.sessionId)
        if (!sessionHasMessage(agent, record.id)) agent.followup(messageFromRecord(team, record))
        await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
      } catch (error) {
        this.port.warn(`dsh-team-mode: queued message ${record.id} recovery failed`, error)
      }
    }
  }

  async deliver(teamId: string, messageId: string): Promise<boolean> {
    const current = this.service.getTeam(teamId)
    const record = current.outbox[messageId]
    if (record === undefined) return true
    if (record.recipient.kind === 'broadcast') {
      const delivered = await this.deliverBroadcast(current, record)
      if (delivered) {
        await this.service.updateRuntimeTeam(
          teamId,
          team => {
            if (team.outbox[messageId] === undefined) return team
            const outbox = { ...team.outbox }
            delete outbox[messageId]
            return { ...team, outbox }
          },
          'team.message_delivered',
          `Broadcast ${messageId} delivered`,
        )
      }
      return delivered
    }
    const slotId = record.recipient.slotId
    const recipient = slotId === undefined ? undefined : current.members[slotId]
    if (recipient === undefined) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      return false
    }
    try {
      // Re-write queued before every retry so the durable message table reflects
      // that the aggregate outbox still owns delivery.
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'queued' })
      const agent = this.port.resolveAgent(recipient.sessionId)
      if (!sessionHasMessage(agent, record.id)) agent.followup(messageFromRecord(current, record))
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
      await this.service.updateRuntimeTeam(
        teamId,
        team => {
          if (team.outbox[messageId] === undefined) return team
          const outbox = { ...team.outbox }
          delete outbox[messageId]
          return { ...team, outbox }
        },
        'team.message_delivered',
        `Team message ${messageId} delivered`,
      )
      return true
    } catch (error) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      this.port.warn(`dsh-team-mode: queued message ${messageId} delivery failed`, error)
      return false
    }
  }

  private async deliverBroadcast(
    team: TeamAggregate,
    record: TeamAggregate['outbox'][string],
  ): Promise<boolean> {
    if (record.sender.kind !== 'member') return true
    const recipients = Object.values(team.members)
      .filter(member => member.id !== record.sender.id && member.desiredState === 'online')
    let delivered = 0
    let pending = 0
    for (const recipient of recipients) {
      try {
        const agent = this.port.resolveAgent(recipient.sessionId)
        if (!sessionHasMessage(agent, record.id)) agent.followup(messageFromRecord(team, record))
        delivered += 1
      } catch (error) {
        pending += 1
        this.port.warn(`dsh-team-mode: broadcast ${record.id} delivery failed for ${recipient.id}`, error)
      }
    }
    await this.service.putRuntimeMessage({
      ...record,
      deliveryState: pending === 0 && delivered > 0 ? 'delivered' : 'queued',
    })
    return pending === 0 && delivered > 0
  }
}
