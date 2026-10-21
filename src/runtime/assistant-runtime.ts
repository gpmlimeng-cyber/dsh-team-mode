import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Config } from '../config.js'
import { AgentTeamError } from '../domain/errors.js'
import type { AssistantInstance, AssistantSnapshot } from '../domain/types.js'
import type { AgentTeamService } from '../service/dsh-team-mode-service.js'

export interface AssistantEnsureResult {
  instance: AssistantInstance
  sessionId: string
}

/**
 * Lazily materializes one Assistant instance's main Session. Phase 0 owns a
 * single visible Session per instance; worker Sessions and dispatch tools are
 * deliberately out of scope. The runtime never creates a replacement for a
 * bound but unloadable Session.
 */
export class AssistantRuntime {
  private readonly owned = new Map<string, AgentHandle>()
  private readonly starting = new Map<string, Promise<AssistantEnsureResult>>()
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly service: AgentTeamService,
  ) {}

  async ensureInstance(rawId: string): Promise<AssistantEnsureResult> {
    if (this.closing) throw new AgentTeamError('INVALID_REQUEST', 'Assistant runtime is closing')
    const id = rawId.trim()
    if (id === '') throw new AgentTeamError('INVALID_REQUEST', 'Assistant instance id cannot be empty')
    const pending = this.starting.get(id)
    if (pending !== undefined) return pending
    const started = this.start(id)
    this.starting.set(id, started)
    try {
      return await started
    } finally {
      if (this.starting.get(id) === started) this.starting.delete(id)
    }
  }

  async dispose(): Promise<void> {
    this.closing = true
    const pending = [...this.starting.values()]
    this.starting.clear()
    await Promise.allSettled(pending)
    const handles = [...this.owned.values()]
    this.owned.clear()
    for (const handle of handles) {
      try {
        handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
        await handle.dispose()
      } catch (error) {
        this.ctx.logger.warn('dsh-team-mode: failed to dispose assistant main Session', error)
      }
    }
  }

  private async start(id: string): Promise<AssistantEnsureResult> {
    const instance = this.service.getAssistantInstance(id)
    if (instance.status === 'archived') {
      throw new AgentTeamError(
        'ASSISTANT_INSTANCE_ARCHIVED',
        `Assistant instance '${id}' is archived`,
      )
    }
    const boundSessionId = instance.mainSessionId
    if (boundSessionId !== undefined) {
      if (this.owned.has(boundSessionId)) {
        return { instance, sessionId: boundSessionId }
      }
      if (this.ctx.agents.get(SessionId(boundSessionId)) !== undefined) {
        throw new AgentTeamError(
          'AGENT_HANDLE_OWNERSHIP_CONFLICT',
          `Session '${boundSessionId}' is live without this plugin's AgentHandle`,
        )
      }
    }

    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(instance.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError(
        'WORKSPACE_UNAVAILABLE',
        `Workspace '${instance.workspaceId}' is unavailable`,
      )
    }

    const sessionId = boundSessionId ?? `session-${randomUUID()}`
    const snapshot = instance.assistantSnapshot
    const modelSelection: ModelSelectionRef = {
      current: {
        provider: snapshot.provider,
        model: snapshot.model,
        ...(snapshot.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(snapshot.reasoningEffort) }),
      },
      assembled: undefined,
    }
    const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, snapshot.agentPresetId)
      installModelSelection(agentCtx, modelSelection)
      agentCtx.systemPrompt.section({
        name: `dsh-team-mode:assistant-identity:${instance.id}`,
        order: 10,
        text: () => assistantPrompt(this.service.getAssistantInstance(id).assistantSnapshot),
      })
      this.ctx.permissionPresets.set(agent.session, snapshot.permissionPresetId)
    }
    const agentOptions = {
      provider: snapshot.provider,
      model: snapshot.model,
      ...(snapshot.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(snapshot.reasoningEffort) }),
    }

    let handle: AgentHandle
    try {
      handle = boundSessionId === undefined
        ? await this.ctx.agents.create({
          sessionId: SessionId(sessionId),
          meta: { cwd: instance.workspacePath, agentPreset: snapshot.agentPresetId },
          agentOptions,
          setup,
        })
        : await this.ctx.agents.resume({
          resumeSessionId: SessionId(boundSessionId),
          agentOptions,
          setup,
        })
    } catch (error) {
      throw this.startupError(instance, error)
    }

    try {
      await workspace.attachSession(SessionId(sessionId))
      // Persist the Session header immediately: a freshly created Session has
      // no event yet, and the native session browser cannot reveal a Session
      // the Host has never written.
      await this.ctx.sessions.flush(handle.agent.session)
      const bound = await this.service.bindAssistantMainSession(id, sessionId)
      this.owned.set(sessionId, handle)
      return { instance: bound, sessionId }
    } catch (error) {
      try {
        await handle.dispose()
      } catch (disposeError) {
        this.ctx.logger.warn(
          `dsh-team-mode: failed to dispose assistant Session '${sessionId}' after startup failure`,
          disposeError,
        )
      }
      throw this.startupError(instance, error)
    }
  }

  private startupError(instance: AssistantInstance, error: unknown): AgentTeamError {
    if (error instanceof AgentTeamError) return error
    const causeMessage = error instanceof Error ? error.message : String(error)
    return new AgentTeamError(
      'SESSION_CREATE_FAILED',
      `Assistant '${instance.assistantSnapshot.name}' main Session failed: ${causeMessage}`,
      { instanceId: instance.id, cause: causeMessage },
      { cause: error },
    )
  }
}

/**
 * Phase 0 keeps the prompt to the assistant's stable identity. Team tools,
 * worker dispatch, and routing instructions arrive in later phases.
 */
function assistantPrompt(snapshot: AssistantSnapshot): string {
  const instructions = snapshot.instructions.trim()
  const identity = `You are ${snapshot.name}, a persistent assistant for one workspace.`
  return instructions === '' ? identity : `${identity}\n\n${instructions}`
}
