import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { checkpointFactsSchema, contextCheckpointSchema } from '../src/domain/schemas.js'
import type { AssistantSession } from '../src/domain/types.js'
import { buildCheckpointFacts, checkpointHandoffMessage } from '../src/runtime/checkpoint-facts.js'

function event(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent
}

function userMessage(seq: number, id: string, text: string): SessionEvent {
  return event(seq, 'user/message', {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

function assistantMessage(seq: number, id: string, text: string): SessionEvent {
  return event(seq, 'assistant/message', {
    turn: seq + 1,
    step: 1,
    message: {
      id,
      role: 'assistant',
      source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
      content: [{ type: 'text', text }],
    },
    stream: [],
  })
}

function toolCall(seq: number, callId: string): SessionEvent {
  return event(seq, 'tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'read',
    arguments: '{"path":"a.ts"}',
  })
}

function toolResult(seq: number, callId: string, text: string): SessionEvent {
  return event(seq, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: `result-${callId}`,
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      isError: false,
      content: [{ type: 'text', text }],
    },
  })
}

function task(overrides: Partial<AssistantSession> & { id: string; updatedAt: string }): AssistantSession {
  return {
    schemaVersion: 1,
    assistantId: 'instance-1',
    sessionId: `session-${overrides.id}`,
    role: 'task',
    title: `Task ${overrides.id}`,
    brief: 'Do the thing',
    parentSessionId: 'session-main',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('buildCheckpointFacts', () => {
  it('keeps only the last 12 visible messages, each truncated to 500 chars', () => {
    const events = Array.from({ length: 19 }, (_, index) => (
      index % 2 === 0
        ? userMessage(index, `user-${index}`, `question ${index}`)
        : assistantMessage(index, `assistant-${index}`, `answer ${index}`)
    ))

    const { facts, capturedThroughSeq } = buildCheckpointFacts({
      events,
      tasks: [],
      workspacePath: '/tmp/w',
      note: '',
    })

    expect(facts.recentMessages).toHaveLength(12)
    expect(facts.recentMessages.map(message => message.text))
      .toEqual(Array.from({ length: 12 }, (_, offset) => (
        `${(offset + 7) % 2 === 0 ? 'question' : 'answer'} ${offset + 7}`
      )))
    expect(facts.recentMessages.every(message => message.text.length <= 500)).toBe(true)
    expect(capturedThroughSeq).toBe(18)
  })

  it('collapses whitespace and truncates one long message to 500 chars', () => {
    const long = `  ${'x'.repeat(600)}\n\n  tail  `
    const { facts } = buildCheckpointFacts({
      events: [userMessage(0, 'user-1', long)],
      tasks: [],
      workspacePath: '/tmp/w',
      note: 'note',
    })

    expect(facts.recentMessages).toEqual([{ role: 'user', text: 'x'.repeat(500) }])
  })

  it('excludes tool nodes and keeps user/assistant roles only', () => {
    const events = [
      userMessage(0, 'user-1', 'Read a.ts'),
      assistantMessage(1, 'assistant-1', 'Reading'),
      toolCall(2, 'call-1'),
      toolResult(3, 'call-1', 'secret file contents'),
    ]

    const { facts } = buildCheckpointFacts({
      events,
      tasks: [],
      workspacePath: '/tmp/w',
      note: '',
    })

    expect(facts.recentMessages).toEqual([
      { role: 'user', text: 'Read a.ts' },
      { role: 'assistant', text: 'Reading' },
    ])
    expect(JSON.stringify(facts)).not.toContain('secret file contents')
  })

  it('caps active tasks at 20, newest first, and drops finished tasks', () => {
    const tasks: AssistantSession[] = Array.from({ length: 25 }, (_, index) => task({
      id: `task-${index}`,
      title: `Task ${index}`,
      status: index % 2 === 0 ? 'running' : 'queued',
      updatedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    }))
    tasks.push(task({
      id: 'task-done',
      status: 'completed',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }))

    const { facts } = buildCheckpointFacts({
      events: [],
      tasks,
      workspacePath: '/tmp/w',
      note: '',
    })

    expect(facts.activeTasks).toHaveLength(20)
    expect(facts.activeTasks[0]).toEqual({ id: 'task-24', title: 'Task 24', status: 'running' })
    expect(facts.activeTasks.at(-1)?.id).toBe('task-5')
    expect(facts.activeTasks.some(entry => entry.id === 'task-done')).toBe(false)
  })

  it('returns valid empty facts with capturedThroughSeq -1 for an empty session', () => {
    const { facts, capturedThroughSeq } = buildCheckpointFacts({
      events: [],
      tasks: [],
      workspacePath: '/tmp/w',
      note: 'handoff',
    })

    expect(capturedThroughSeq).toBe(-1)
    expect(facts).toEqual({
      recentMessages: [],
      activeTasks: [],
      workspacePath: '/tmp/w',
      note: 'handoff',
    })
    expect(checkpointFactsSchema.parse(facts)).toEqual(facts)
  })
})

describe('checkpointHandoffMessage', () => {
  it('uses a runtime-context instructions source and includes the checkpoint facts', () => {
    const checkpoint = contextCheckpointSchema.parse({
      schemaVersion: 1,
      id: 'cp-1',
      assistantId: 'instance-1',
      sourceSessionId: 'session-old',
      title: 'Handoff at noon',
      note: '请接着上次的进度继续',
      capturedThroughSeq: 4,
      facts: {
        recentMessages: [
          { role: 'user', text: 'Build the checkpoint' },
          { role: 'assistant', text: 'Done with the schema' },
        ],
        activeTasks: [{ id: 'task-1', title: 'Write tests', status: 'running' }],
        workspacePath: '/tmp/workspace',
        note: '请接着上次的进度继续',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const message = checkpointHandoffMessage(checkpoint)

    expect(message.role).toBe('user')
    expect(message.source).toEqual({ kind: 'runtime-context', form: 'instructions' })
    expect(message.content).toHaveLength(1)
    const block = message.content[0]
    expect(block?.type).toBe('text')
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toContain('Handoff at noon')
    expect(text).toContain('用户提供')
    expect(text).toContain('请接着上次的进度继续')
    expect(text).toContain('Build the checkpoint')
    expect(text).toContain('Done with the schema')
    expect(text).toContain('Write tests')
    expect(text).toContain('/tmp/workspace')
  })
})
