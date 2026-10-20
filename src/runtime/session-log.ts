import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Read a stopped session's durable event log for projection.
 *
 * A live Agent is read from its own `Session`; a session with no live Agent is
 * opened through persistence with read access only, so projecting a stopped
 * conversation never takes write ownership away from the runtime that may own
 * it next.
 *
 * @param ctx - context providing `sessionPersistence`.
 * @param sessionId - session identity to read.
 * @returns the stored events, or an empty log when the session is unreadable.
 */
export async function readStoredSessionEvents(
  ctx: Context,
  sessionId: string,
): Promise<readonly SessionEvent[]> {
  let handle: Awaited<ReturnType<Context['sessionPersistence']['open']>> | undefined
  try {
    handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read')
    return (await handle.read()).events
  } catch {
    return []
  } finally {
    await handle?.close()
  }
}
