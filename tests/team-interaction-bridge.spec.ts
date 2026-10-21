import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { AgentTeamError } from '../src/domain/errors.js'
import {
  normalizeQuestionAnswers,
  TeamInteractionBridge,
} from '../src/runtime/team-interaction-bridge.js'

describe('TeamInteractionBridge', () => {
  it('projects a question waterfall request and settles it from the workbench', async () => {
    const onChange = vi.fn()
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: id => id === 'session-1',
      onChange,
    })
    const agent = agentContext()
    bridge.attachAgent(agent.ctx, 'session-1')

    const answered = agent.ask('user-questions/request', {
      questions: [{
        id: 'language',
        question: '选择语言？',
        options: [{ label: 'TypeScript', description: '推荐' }, { label: 'Rust' }],
      }],
      wait: { callId: 'call-1' },
    }) as Promise<AskUserQuestionAnswer>

    await vi.waitFor(() => {
      expect(bridge.list('session-1')).toEqual([expect.objectContaining({
        id: 'question:call-1',
        kind: 'question',
      })])
    })

    await bridge.respond('session-1', 'question:call-1', {
      kind: 'question',
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    await expect(answered).resolves.toEqual({
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    expect(bridge.list('session-1')).toEqual([])
    expect(onChange).toHaveBeenCalled()
    await bridge.dispose()
  })

  it('keeps a pending question answerable after an invalid response', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: id => id === 'session-3',
      onChange: vi.fn(),
    })
    const agent = agentContext()
    bridge.attachAgent(agent.ctx, 'session-3')

    const answered = agent.ask('user-questions/request', {
      questions: [{
        id: 'language',
        question: '选择语言？',
        options: [{ label: 'TypeScript' }, { label: 'Rust' }],
      }],
      wait: { callId: 'call-3' },
    }) as Promise<AskUserQuestionAnswer>

    await vi.waitFor(() => { expect(bridge.list('session-3')).toHaveLength(1) })

    await expect(bridge.respond('session-3', 'question:call-3', {
      kind: 'question',
      answers: [{ id: 'language', selected: ['Unknown'] }],
    })).rejects.toMatchObject({ code: 'INTERACTION_INVALID' })

    expect(bridge.list('session-3')).toHaveLength(1)

    await bridge.respond('session-3', 'question:call-3', {
      kind: 'question',
      answers: [{ id: 'language', selected: ['Rust'] }],
    })
    await expect(answered).resolves.toEqual({
      answers: [{ id: 'language', selected: ['Rust'] }],
    })
    expect(bridge.list('session-3')).toEqual([])
    await bridge.dispose()
  })

  it('uses the one-shot approval outcome and rejects an unknown request', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: () => true,
      onChange: vi.fn(),
    })
    const agent = agentContext()
    bridge.attachAgent(agent.ctx, 'session-2')

    const decided = agent.ask('approval/request', {
      toolName: 'bash',
      callId: 'call-2',
      reason: '需要访问工作区之外的路径',
    }) as Promise<ApprovalOutcome>

    await vi.waitFor(() => { expect(bridge.list('session-2')).toHaveLength(1) })
    await expect(bridge.respond('session-2', 'approval:missing', {
      kind: 'approval',
      outcome: 'allowed-once',
    })).rejects.toMatchObject({ code: 'INTERACTION_NOT_FOUND' })

    await bridge.respond('session-2', 'approval:call-2', {
      kind: 'approval',
      outcome: 'allowed-once',
    })
    await expect(decided).resolves.toBe('allowed-once')
    await bridge.dispose()
  })

  it('delegates to the next answerer for a session outside the team', async () => {
    const bridge = new TeamInteractionBridge({} as Context, {
      acceptsSession: id => id === 'session-1',
      onChange: vi.fn(),
    })
    const agent = agentContext()
    bridge.attachAgent(agent.ctx, 'someone-else')

    await expect(agent.ask('approval/request', { toolName: 'bash' })).resolves.toBe('unavailable')
    expect(bridge.list('someone-else')).toEqual([])
    await bridge.dispose()
  })
})

describe('normalizeQuestionAnswers', () => {
  it('rejects incomplete and forged option answers', () => {
    const questions = [{
      id: 'model',
      question: '选择模型？',
      options: [{ label: 'DeepSeek' }, { label: 'GLM' }],
    }]
    expect(() => normalizeQuestionAnswers(questions, [])).toThrow(AgentTeamError)
    expect(() => normalizeQuestionAnswers(questions, [{
      id: 'model',
      selected: ['Unknown'],
    }])).toThrow('包含无效选项')
  })
})

interface AgentContextStub {
  ctx: Context
  /** Dispatch one waterfall event and resolve with its settled outcome. */
  ask: (event: string, request: Record<string, unknown>) => Promise<unknown>
}

/**
 * Minimal Agent-scoped Cordis stand-in: `on()` collects waterfall listeners and
 * `ask()` runs them in order, delegating with `next()`.
 */
function agentContext(): AgentContextStub {
  const listeners = new Map<string, Array<(request: never, next: () => Promise<never>) => Promise<never>>>()
  const ctx = {
    on(event: string, listener: (request: never, next: () => Promise<never>) => Promise<never>) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const live = listeners.get(event) ?? []
        listeners.set(event, live.filter(candidate => candidate !== listener))
      }
    },
  } as unknown as Context
  return {
    ctx,
    ask: async (event, request) => {
      const chain = listeners.get(event) ?? []
      let index = 0
      const next = async (): Promise<never> => {
        const listener = chain[index]
        index += 1
        if (listener === undefined) return 'unavailable' as never
        return listener(request as never, next)
      }
      return next()
    },
  }
}

export type { AskUserQuestionRequest, ApprovalRequest }
