import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type {
  ApprovalOutcome,
  ApprovalRequest,
} from '@deepseek-ai/dsh-user-approval'
import { AgentTeamError } from '../domain/errors.js'
import type {
  InteractionResponseInput,
  PendingInteractionView,
  QuestionAnswerView,
  QuestionItemView,
} from '../transport/contracts.js'

type PendingInteractionRecord =
  | {
    id: string
    kind: 'question'
    sessionId: string
    questions: QuestionItemView[]
    settle: (answer: AskUserQuestionAnswer) => void
    fail: (error: unknown) => void
  }
  | {
    id: string
    kind: 'approval'
    sessionId: string
    approvalId: string
    toolName: string
    callId?: string
    reason?: string
    settle: (outcome: ApprovalOutcome) => void
    fail: (error: unknown) => void
  }

export interface TeamInteractionScope {
  acceptsSession: (sessionId: string) => boolean
  onChange: (sessionId: string) => void
}

/**
 * Surfaces pending questions and approvals raised by an Agent Team member and
 * resolves them from the Agent Team workbench.
 *
 * DeepSeek Harness composes human interaction through two Agent-scoped Cordis
 * waterfalls — `user-questions/request` and `approval/request`. A member's own
 * Agent scope receives only that member's requests, so the bridge attaches one
 * listener pair per member Agent context (see {@link attachAgent}) instead of
 * tapping the client transport mux it used before this Harness line.
 */
export class TeamInteractionBridge {
  private readonly records = new Map<string, PendingInteractionRecord>()
  private readonly scopes = new Set<TeamInteractionScope>()
  private readonly detachers = new Map<string, () => void>()

  constructor(
    private readonly ctx: Context,
    scope?: TeamInteractionScope,
  ) {
    if (scope !== undefined) this.scopes.add(scope)
  }

  registerScope(scope: TeamInteractionScope): () => void {
    this.scopes.add(scope)
    return () => { this.scopes.delete(scope) }
  }

  /**
   * Answer the member's human-interaction requests from the team workbench.
   * Called from inside the member's Agent setup, before the Agent publishes.
   * @param agentCtx - the member's Agent-scoped context.
   * @param sessionId - the member session the prompt belongs to.
   * @returns disposer removing both waterfall listeners.
   */
  attachAgent(agentCtx: Context, sessionId: string): () => void {
    const detachQuestions = agentCtx.on(
      'user-questions/request',
      (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => {
        if (!this.acceptsSession(sessionId)) return next()
        return this.raiseQuestion(sessionId, request)
      },
    )
    const detachApprovals = agentCtx.on(
      'approval/request',
      (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
        if (!this.acceptsSession(sessionId)) return next()
        return this.raiseApproval(sessionId, request)
      },
    )
    const detach = (): void => {
      detachQuestions()
      detachApprovals()
      this.forget(sessionId)
    }
    this.detachers.set(sessionId, detach)
    return detach
  }

  list(sessionId: string): PendingInteractionView[] {
    return [...this.records.values()]
      .filter(record => record.sessionId === sessionId)
      .map(toView)
  }

  forget(sessionId: string): void {
    for (const [id, record] of this.records) {
      if (record.sessionId === sessionId) this.records.delete(id)
    }
  }

  async respond(
    sessionId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    const record = this.records.get(interactionId)
    if (record === undefined) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求已结束或不存在')
    }
    if (record.sessionId !== sessionId || !this.acceptsSession(sessionId)) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求不属于指定的会话')
    }
    this.records.delete(record.id)
    this.notifyChange(record.sessionId)
    if (record.kind === 'question') {
      if (response.kind !== 'question') {
        throw new AgentTeamError('INTERACTION_INVALID', '交互响应类型与待处理请求不匹配')
      }
      const answers = normalizeQuestionAnswers(record.questions, response.answers)
      record.settle({
        answers: answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        })),
      })
      return
    }
    if (response.kind !== 'approval') {
      throw new AgentTeamError('INTERACTION_INVALID', '交互响应类型与待处理请求不匹配')
    }
    record.settle(response.outcome)
  }

  async dispose(): Promise<void> {
    for (const detach of [...this.detachers.values()]) detach()
    this.detachers.clear()
    for (const record of this.records.values()) {
      record.fail(new AgentTeamError('INTERACTION_NOT_FOUND', '团队已关闭，该交互请求已取消'))
    }
    this.records.clear()
  }

  private raiseQuestion(
    sessionId: string,
    request: AskUserQuestionRequest,
  ): Promise<AskUserQuestionAnswer> {
    const callId = request.wait === undefined ? undefined : String(request.wait.callId)
    const id = callId === undefined ? `question:${randomUUID()}` : `question:${callId}`
    const questions = questionsOf(request.questions)
    const promise = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const record: PendingInteractionRecord = {
        id,
        kind: 'question',
        sessionId,
        questions,
        settle: resolve,
        fail: reject,
      }
      this.records.set(id, record)
      this.notifyChange(sessionId)
      watchAbort(request.signal, () => this.expire(id, sessionId, reject))
    })
    return contained(promise)
  }

  private raiseApproval(
    sessionId: string,
    request: ApprovalRequest,
  ): Promise<ApprovalOutcome> {
    const approvalId = `approval:${request.callId === undefined ? randomUUID() : String(request.callId)}`
    const promise = new Promise<ApprovalOutcome>((resolve, reject) => {
      const record: PendingInteractionRecord = {
        id: approvalId,
        kind: 'approval',
        sessionId,
        approvalId,
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        settle: resolve,
        fail: reject,
      }
      this.records.set(approvalId, record)
      this.notifyChange(sessionId)
      watchAbort(request.signal, () => this.expire(approvalId, sessionId, reject))
    })
    return contained(promise)
  }

  private expire(id: string, sessionId: string, fail: (error: unknown) => void): void {
    if (!this.records.delete(id)) return
    this.notifyChange(sessionId)
    fail(new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求已取消'))
  }

  private remove(id: string, sessionId: string): void {
    if (!this.records.delete(id)) return
    this.notifyChange(sessionId)
  }

  private acceptsSession(sessionId: string): boolean {
    return [...this.scopes].some(scope => scope.acceptsSession(sessionId))
  }

  private notifyChange(sessionId: string): void {
    for (const scope of this.scopes) {
      if (scope.acceptsSession(sessionId)) scope.onChange(sessionId)
    }
  }
}

function questionsOf(questions: readonly AskUserQuestionItem[]): QuestionItemView[] {
  return questions.map(question => ({
    id: question.id,
    question: question.question,
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined ? {} : {
      options: question.options.map(option => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    }),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    ...(question.intent === undefined ? {} : {
      intent: { kind: question.intent.kind, approve: question.intent.approve },
    }),
  }))
}

export function normalizeQuestionAnswers(
  questions: readonly QuestionItemView[],
  answers: readonly QuestionAnswerView[],
): QuestionAnswerView[] {
  const byId = new Map<string, QuestionAnswerView>()
  for (const answer of answers) {
    if (byId.has(answer.id)) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${answer.id}”存在重复答案`)
    }
    byId.set(answer.id, answer)
  }
  if (byId.size !== questions.length) {
    throw new AgentTeamError('INTERACTION_INVALID', '请完成全部问题后再提交')
  }
  return questions.map(question => {
    const answer = byId.get(question.id)
    if (answer === undefined) {
      throw new AgentTeamError('INTERACTION_INVALID', `缺少问题“${question.id}”的答案`)
    }
    const selected = [...answer.selected]
    if (new Set(selected).size !== selected.length) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”包含重复选项`)
    }
    const allowed = new Set(question.options?.map(option => option.label) ?? [])
    if (selected.some(label => !allowed.has(label))) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”包含无效选项`)
    }
    if (question.multiSelect !== true && selected.length > 1) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”只能选择一个选项`)
    }
    const custom = answer.custom?.trim()
    if (question.multiSelect !== true && custom !== undefined && custom.length > 0 && selected.length > 0) {
      throw new AgentTeamError('INTERACTION_INVALID', `问题“${question.id}”的自定义答案不能与单选项同时提交`)
    }
    if (selected.length === 0 && (custom === undefined || custom.length === 0)) {
      throw new AgentTeamError('INTERACTION_INVALID', `请回答问题“${question.question}”`)
    }
    return {
      id: question.id,
      selected,
      ...(custom === undefined || custom.length === 0 ? {} : { custom }),
    }
  })
}

function toView(record: PendingInteractionRecord): PendingInteractionView {
  if (record.kind === 'question') {
    return { id: record.id, kind: record.kind, questions: record.questions }
  }
  return {
    id: record.id,
    kind: record.kind,
    approvalId: record.approvalId,
    toolName: record.toolName,
    ...(record.callId === undefined ? {} : { callId: record.callId }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  }
}

/**
 * The Harness waterfall contains the settled outcome itself; consuming the
 * rejection here keeps a request whose caller already abandoned it from
 * surfacing as an unhandled rejection in the plugin's own logs.
 */
function contained<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {})
  return promise
}

function watchAbort(signal: AbortSignal | undefined, abort: () => void): void {
  if (signal === undefined) return
  if (signal.aborted) {
    abort()
    return
  }
  signal.addEventListener('abort', abort, { once: true })
}
