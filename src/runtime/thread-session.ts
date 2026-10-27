import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { AgentTeamError } from '../domain/errors.js'

export interface ThreadSessionRequest {
  workspaceId: string
  /** Working directory of the new Session; the team or assistant workspace by default. */
  cwd: string
  agentPresetId: string
  agentOptions: AgentOptions
  setup: AgentSetup
}

export interface CreatedThreadSession {
  sessionId: string
  handle: AgentHandle
}

/**
 * The one factory behind every additional conversation Session: the Assistant
 * thread path and the team thread path both create → attach → flush through it,
 * so a thread is always a real Host-owned Session and never a minted id.
 *
 * The Workspace account is written before the Session header, and the header is
 * flushed before the caller records the thread, so the Session is openable from
 * the native browser even when the caller immediately stops this Agent.
 */
export async function createThreadSession(
  ctx: Context,
  request: ThreadSessionRequest,
): Promise<CreatedThreadSession> {
  const workspace = ctx.workspaceRegistry.get(WorkspaceId(request.workspaceId))
  if (workspace === undefined || await workspace.status() !== 'ok') {
    throw new AgentTeamError(
      'WORKSPACE_UNAVAILABLE',
      `Workspace '${request.workspaceId}' is unavailable`,
    )
  }
  const sessionId = `session-${randomUUID()}`
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    meta: { cwd: request.cwd, agentPreset: request.agentPresetId },
    agentOptions: request.agentOptions,
    setup: request.setup,
  })
  try {
    await workspace.attachSession(SessionId(sessionId))
    await ctx.sessions.flush(handle.agent.session)
    return { sessionId, handle }
  } catch (error) {
    try {
      await handle.dispose()
    } catch (disposeError) {
      ctx.logger.warn(`dsh-team-mode: thread Session '${sessionId}' failed to dispose`, disposeError)
    }
    throw error
  }
}
