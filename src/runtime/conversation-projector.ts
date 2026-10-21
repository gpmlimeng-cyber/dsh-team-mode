import type {
  AssistantStreamRecord,
  ContentBlock,
  MessageSource,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TeamAggregate, TeamMessage } from '../domain/types.js'
import type { ConversationNode, MemberConversationView } from '../transport/contracts.js'

interface PartialAssistant {
  id: string
  seq: number
  time: number
  text: string
  reasoning: string
  reasoningStartedAt?: number
  reasoningCompletedAt?: number
}

interface AssistantStreamProjection {
  text: string
  reasoning: string
  firstChunkTime?: number
  reasoningStartedAt?: number
  reasoningCompletedAt?: number
}

interface TeamProjectionContext {
  team: Pick<TeamAggregate, 'leaderSlotId' | 'members' | 'retiredSessions'>
  messages: readonly TeamMessage[]
}

export function projectContextUsage(
  events: readonly SessionEvent[],
): MemberConversationView['contextUsage'] {
  let latestUsage: TokenUsage | undefined
  let contextWindow: number | undefined

  for (const event of events) {
    if (event.type === 'request/context') contextWindow = event.data.contextWindow

    const usage = event.type === 'assistant/message'
      ? event.data.usage ?? usageOfStream(event.data.stream)
      : event.type === 'assistant/attempt'
        ? usageOfStream(event.data.stream)
        : undefined
    if (usage !== undefined) latestUsage = usage
  }

  if (latestUsage === undefined) return undefined
  const cacheReadTokens = latestUsage.cacheReadTokens ?? 0
  const cacheWriteTokens = latestUsage.cacheWriteTokens ?? 0
  const inputTokens = latestUsage.inputTokens + cacheReadTokens + cacheWriteTokens
  const outputTokens = latestUsage.outputTokens
  return {
    usedTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: latestUsage.reasoningTokens ?? 0,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

export function projectConversation(
  events: readonly SessionEvent[],
  limit = 240,
  teamContext?: TeamProjectionContext,
): {
  throughSeq: number
  nodes: ConversationNode[]
} {
  const nodes: ConversationNode[] = []
  const tools = new Map<string, number>()
  const partials = new Map<string, PartialAssistant>()
  const teamMessages = new Map(teamContext?.messages.map(message => [message.id, message]) ?? [])

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (!isVisibleUserSource(event.data.source)) break
        const text = textOf(event.data.content)
        if (text.length > 0) {
          const messageId = String(event.data.id)
          const teamMessage = teamMessages.get(messageId)
          if (teamContext !== undefined && teamMessage !== undefined && teamMessage.sender.kind !== 'user') {
            nodes.push(teamMessageNode(teamContext.team, teamMessage, event.seq, event.time))
          } else {
            nodes.push({
              id: messageId,
              kind: 'user',
              seq: event.seq,
              time: event.time,
              text,
            })
          }
        }
        break
      }
      case 'assistant/attempt': {
        const key = `${event.data.turn}:${event.data.step}`
        const projection = projectAssistantStream(event.data.stream)
        if (projection.text.length === 0 && projection.reasoning.length === 0) break
        partials.set(key, {
          id: `stream:${key}`,
          seq: event.seq,
          time: projection.firstChunkTime ?? event.time,
          text: projection.text,
          reasoning: projection.reasoning,
          ...(projection.reasoningStartedAt === undefined
            ? {}
            : { reasoningStartedAt: projection.reasoningStartedAt }),
          ...(projection.reasoningCompletedAt === undefined
            ? {}
            : { reasoningCompletedAt: projection.reasoningCompletedAt }),
        })
        break
      }
      case 'assistant/message': {
        const key = `${event.data.turn}:${event.data.step}`
        const partial = partials.get(key)
        partials.delete(key)
        const text = textOf(event.data.message.content)
        const reasoning = reasoningOf(event.data.message.content)
        if (text.length === 0 && reasoning.length === 0) break
        const timing = projectAssistantStream(event.data.stream)
        const reasoningStartedAt = timing.reasoningStartedAt ?? partial?.reasoningStartedAt
        const reasoningCompletedAt = timing.reasoningCompletedAt
          ?? partial?.reasoningCompletedAt
          ?? (reasoningStartedAt === undefined ? undefined : event.time)
        nodes.push({
          id: String(event.data.message.id),
          kind: 'assistant',
          seq: event.seq,
          time: event.time,
          text,
          ...(reasoning.length === 0 ? {} : { reasoning }),
          ...(reasoningStartedAt === undefined ? {} : {
            reasoningStartedAt,
            reasoningCompletedAt: reasoningCompletedAt ?? event.time,
          }),
        })
        break
      }
      case 'tool/call': {
        const callId = String(event.data.callId)
        tools.set(callId, nodes.length)
        nodes.push({
          id: `tool:${callId}`,
          kind: 'tool',
          seq: event.seq,
          time: event.time,
          callId,
          name: event.data.name,
          arguments: event.data.arguments,
          status: 'running',
        })
        break
      }
      case 'tool/result': {
        const message = event.data.message
        const callId = String(message.toolCallId)
        const index = tools.get(callId)
        const result = textOf(message.content)
        const error = event.data.error === undefined
          ? undefined
          : `${event.data.error.name}: ${event.data.error.code}`
        const status = message.isError === true || error !== undefined ? 'error' : 'success'
        if (index !== undefined) {
          const node = nodes[index]
          if (node?.kind === 'tool') nodes[index] = {
            ...node,
            seq: event.seq,
            status,
            ...(result.length === 0 ? {} : { result }),
            ...(error === undefined ? {} : { error }),
          }
        } else {
          nodes.push({
            id: `tool:${callId}`,
            kind: 'tool',
            seq: event.seq,
            time: event.time,
            callId,
            name: 'tool',
            arguments: '',
            status,
            ...(result.length === 0 ? {} : { result }),
            ...(error === undefined ? {} : { error }),
          })
        }
        break
      }
      case 'turn/end': {
        if (event.data.reason.kind === 'error') nodes.push({
          id: `turn-error:${event.seq}`,
          kind: 'notice',
          seq: event.seq,
          time: event.time,
          tone: 'error',
          text: event.data.reason.error.message,
        })
        if (event.data.reason.kind === 'max-tokens') nodes.push({
          id: `turn-warning:${event.seq}`,
          kind: 'notice',
          seq: event.seq,
          time: event.time,
          tone: 'warning',
          text: '本轮输出已达到模型长度上限。',
        })
        break
      }
    }
  }

  for (const partial of partials.values()) {
    if (partial.text.length === 0 && partial.reasoning.length === 0) continue
    nodes.push({
      id: partial.id,
      kind: 'assistant',
      seq: partial.seq,
      time: partial.time,
      text: partial.text,
      ...(partial.reasoning.length === 0 ? {} : { reasoning: partial.reasoning }),
      ...(partial.reasoningStartedAt === undefined ? {} : {
        reasoningStartedAt: partial.reasoningStartedAt,
        ...(partial.reasoningCompletedAt === undefined ? {} : {
          reasoningCompletedAt: partial.reasoningCompletedAt,
        }),
      }),
      streaming: true,
    })
  }
  nodes.sort((left, right) => left.seq - right.seq)
  return {
    throughSeq: events.at(-1)?.seq ?? -1,
    nodes: nodes.slice(-limit),
  }
}

function teamMessageNode(
  team: TeamProjectionContext['team'],
  message: TeamMessage,
  seq: number,
  time: number,
): Extract<ConversationNode, { kind: 'team-message' }> {
  if (message.sender.kind === 'system') {
    return {
      id: message.id,
      kind: 'team-message',
      seq,
      time,
      text: message.content,
      senderName: '团队事件',
      senderId: message.sender.id,
      senderRole: 'system',
      messageType: message.type,
      ...(message.relatedTaskId === undefined ? {} : { relatedTaskId: message.relatedTaskId }),
    }
  }
  const current = team.members[message.sender.id]
  const retired = Object.values(team.retiredSessions)
    .find(session => session.formerSlotId === message.sender.id)
  return {
    id: message.id,
    kind: 'team-message',
    seq,
    time,
    text: message.content,
    senderName: current?.displayName ?? retired?.displayName ?? '已移出成员',
    senderId: message.sender.id,
    senderRole: message.sender.id === team.leaderSlotId ? 'leader' : 'member',
    messageType: message.type,
    ...(message.relatedTaskId === undefined ? {} : { relatedTaskId: message.relatedTaskId }),
  }
}

function isVisibleUserSource(source: MessageSource): boolean {
  if (source.kind === 'user') return true
  if (source.kind === 'plugin-relay') {
    return source.plugin === 'dsh-team-mode' && source.form === 'relay'
  }
  if (source.kind === 'team-message') {
    return source.plugin === 'dsh-team-mode'
  }
  return isLegacyRelaySource(source)
}

/**
 * DSH 0.1.x persisted a shared catch-all `plugin` source that 0.2.x removed.
 * Existing session logs must keep rendering their relayed team messages.
 */
function isLegacyRelaySource(source: MessageSource): boolean {
  const legacy = source as { kind?: string; plugin?: string; form?: string }
  return legacy.kind === 'plugin' && legacy.plugin === 'dsh-team-mode' && legacy.form === 'relay'
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'image') return ['[图片]']
    if (block.type === 'file') return ['[文件]']
    return []
  }).filter(Boolean).join('\n')
}

function reasoningOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('\n')
}

function usageOfStream(stream: readonly AssistantStreamRecord[]): TokenUsage | undefined {
  let usage: TokenUsage | undefined
  for (const record of stream) {
    if (record.type === 'chunk' && record.chunk.type === 'usage') usage = record.chunk.usage
  }
  return usage
}

/**
 * Replay one durable assistant stream into the same transcript fields the
 * removed `assistant/chunk` events used to carry: joined text/reasoning plus
 * the reasoning window derived from each chunk's original timestamp.
 */
function projectAssistantStream(stream: readonly AssistantStreamRecord[]): AssistantStreamProjection {
  let text = ''
  let reasoning = ''
  let firstChunkTime: number | undefined
  let reasoningStartedAt: number | undefined
  let reasoningCompletedAt: number | undefined

  const apply = (time: number, chunk: StreamChunk): void => {
    firstChunkTime ??= time
    if (chunk.type === 'text-delta') {
      text += chunk.text
      if (chunk.text.length > 0 && reasoningStartedAt !== undefined) reasoningCompletedAt ??= time
      return
    }
    if (chunk.type === 'reasoning-delta') {
      reasoning += chunk.text
      if (chunk.text.length > 0) {
        reasoningStartedAt ??= time
        if (text.length > 0) reasoningCompletedAt ??= time
      }
      return
    }
    if (chunk.type !== 'block-end') return
    if (chunk.block.type === 'text') {
      text = chunk.block.text
      if (reasoningStartedAt !== undefined) reasoningCompletedAt ??= time
      return
    }
    if (chunk.block.type === 'reasoning') {
      reasoning = chunk.block.text
      if (chunk.block.text.length > 0) {
        reasoningStartedAt ??= firstChunkTime
        reasoningCompletedAt ??= time
      }
    }
  }

  for (const record of stream) {
    if (record.type === 'chunk') {
      apply(record.time, record.chunk)
      continue
    }
    if (record.type !== 'text-chunks' && record.type !== 'reasoning-chunks') continue
    let time = record.time0
    for (let index = 0; index < record.texts.length; index += 1) {
      if (index > 0) time += record.dt[index - 1] ?? 0
      const member = record.texts[index] ?? ''
      apply(time, record.type === 'text-chunks'
        ? { type: 'text-delta', index: record.index, text: member }
        : { type: 'reasoning-delta', index: record.index, text: member })
    }
  }

  return {
    text,
    reasoning,
    ...(firstChunkTime === undefined ? {} : { firstChunkTime }),
    ...(reasoningStartedAt === undefined ? {} : { reasoningStartedAt }),
    ...(reasoningCompletedAt === undefined ? {} : { reasoningCompletedAt }),
  }
}
