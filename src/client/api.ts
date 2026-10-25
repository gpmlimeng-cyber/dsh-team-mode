import {
  AGENT_TEAM_API_PATH,
  AGENT_TEAM_EVENTS_PATH,
  AGENT_TEAM_FILE_NAME_HEADER,
  AGENT_TEAM_REQUEST_ID_HEADER,
  AGENT_TEAM_UPLOAD_PATH,
  type AgentTeamMethod,
  type AgentTeamPayload,
  type AgentTeamResponse,
  type AgentTeamResult,
  type AssistantBuilderConversationView,
  type MemberConversationView,
  type WorkspaceUploadView,
} from '../transport/contracts.js'

/**
 * Read-only methods whose identical concurrent requests are shared.
 *
 * A page mount mounts several team hosts (sidebar, row hider, dialogs, overlays)
 * and each pulls the same read on its first render; sharing the in-flight request
 * keeps one mount at one Host read instead of a burst, without caching a
 * response, so a later read can never see stale data.
 */
const SHARED_READ_METHODS = new Set<AgentTeamMethod>([
  'catalog.get',
  'team.list',
  'team.get',
  'assistant.list',
  'assistant.instance.list',
  'assistant.task.list',
])

const sharedReads = new Map<string, Promise<unknown>>()

export function callAgentTeam<M extends AgentTeamMethod>(
  method: M,
  ...args: AgentTeamPayload<M> extends undefined
    ? [payload?: undefined, expectedRevision?: number]
    : [payload: AgentTeamPayload<M>, expectedRevision?: number]
): Promise<AgentTeamResult<M>> {
  const [payload, expectedRevision] = args
  if (expectedRevision !== undefined || !SHARED_READ_METHODS.has(method)) {
    return requestAgentTeam<M>(method, payload, expectedRevision)
  }
  const key = `${method}:${payload === undefined ? '' : JSON.stringify(payload)}`
  const running = sharedReads.get(key)
  if (running !== undefined) return running as Promise<AgentTeamResult<M>>
  const shared = requestAgentTeam<M>(method, payload, expectedRevision)
    .finally(() => {
      // Only the owner clears the entry: a settled response is never reused.
      if (sharedReads.get(key) === shared) sharedReads.delete(key)
    })
  sharedReads.set(key, shared)
  return shared
}

async function requestAgentTeam<M extends AgentTeamMethod>(
  method: M,
  payload: AgentTeamPayload<M> | undefined,
  expectedRevision: number | undefined,
): Promise<AgentTeamResult<M>> {
  const controller = new AbortController()
  // A Leader change archives every Session and activates the successor: it can
  // take as long as a reset, so it gets the same budget. A Leader handoff
  // activates one fresh Session and is bounded by the same wait.
  const timeoutMs = method === 'team.reset'
    || method === 'team.dissolve'
    || method === 'team.changeLeader'
    || method === 'team.checkpoint.handoff'
    ? 60_000
    : 10_000
  const timeout = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(AGENT_TEAM_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        method,
        payload: payload ?? {},
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    })
    const body = await response.json() as AgentTeamResponse
    if (!body.ok) {
      const error = new Error(body.error.message)
      Object.assign(error, { code: body.error.code, details: body.error.details })
      throw error
    }
    return body.value as AgentTeamResult<M>
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时：${method}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Whether the shell's Session controller refused an id it has not pulled yet.
 *
 * `sessions.retain` raises `sessions.retain: unknown session <id>`; the client
 * plugin bundle cannot share the controller's error class, so the message is the
 * only stable signal.
 */
export function isUnknownSessionError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes('unknown session')
}

/** The words a failed navigation is reported in; a shell refusal keeps its text. */
export function navigationErrorMessage(cause: unknown): string {
  if (isUnknownSessionError(cause)) return '无法打开该会话：会话尚未同步到本地，请重新加载页面后再试'
  const message = cause instanceof Error ? cause.message : String(cause)
  return `无法打开该会话：${message}`
}

/** The Leader Slot's Session, or undefined while a team has no resolvable Leader. */
export function teamLeaderSessionId(
  team: { members: Record<string, { sessionId: string }>; leaderSlotId: string },
): string | undefined {
  const leader = team.members[team.leaderSlotId]
  return leader === undefined || leader.sessionId === '' ? undefined : leader.sessionId
}

export interface SessionOpenDeps {
  open: (sessionId: string) => void
  /** Re-pull the client Session catalog; absent when the shell exposes no refresh. */
  refresh?: (() => Promise<unknown>) | undefined
}

/**
 * Open a Session through the shell's workspace controller.
 *
 * Team and Assistant Sessions are created on the Host, so a page that has been
 * open since before that creation does not know the id yet and `openSession`
 * throws instead of navigating. Pull the catalog once and retry; a second
 * failure is returned to the caller so it can be shown, never swallowed.
 */
export async function openSessionInCatalog(sessionId: string, deps: SessionOpenDeps): Promise<void> {
  const refresh = deps.refresh
  try {
    deps.open(sessionId)
    return
  } catch (cause) {
    if (refresh === undefined || !isUnknownSessionError(cause)) throw cause
  }
  await refresh()
  deps.open(sessionId)
}

export async function uploadAgentTeamFile(teamId: string, file: File): Promise<WorkspaceUploadView> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, 120_000)
  const requestId = crypto.randomUUID()
  try {
    const response = await fetch(`${AGENT_TEAM_UPLOAD_PATH}?teamId=${encodeURIComponent(teamId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        [AGENT_TEAM_FILE_NAME_HEADER]: encodeURIComponent(file.name),
        [AGENT_TEAM_REQUEST_ID_HEADER]: requestId,
      },
      signal: controller.signal,
      body: file,
    })
    const body = await response.json() as AgentTeamResponse
    if (!body.ok) {
      const error = new Error(body.error.message)
      Object.assign(error, { code: body.error.code, details: body.error.details })
      throw error
    }
    return body.value as WorkspaceUploadView
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`文件上传超时：${file.name}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

interface ChangeSubscription {
  onChange: () => void
  onError: () => void
  onOpen?: () => void
}

interface ConversationSubscription {
  teamId: string
  onChange: (conversation?: MemberConversationView) => void
  onError: () => void
  onOpen?: () => void
}

interface AssistantBuilderSubscription {
  onChange: (conversation?: AssistantBuilderConversationView) => void
  onError: () => void
  onOpen?: () => void
}

interface WorkspaceSubscription {
  teamId: string
  onChange: () => void
  onError: () => void
  onOpen?: () => void
}

const changeSubscriptions = new Set<ChangeSubscription>()
const conversationSubscriptions = new Set<ConversationSubscription>()
const assistantBuilderSubscriptions = new Set<AssistantBuilderSubscription>()
const workspaceSubscriptions = new Set<WorkspaceSubscription>()
let sharedEventSource: EventSource | undefined

function eventSource(): EventSource {
  if (sharedEventSource !== undefined) return sharedEventSource
  const source = new EventSource(AGENT_TEAM_EVENTS_PATH)
  source.addEventListener('change', () => {
    for (const subscription of changeSubscriptions) subscription.onChange()
  })
  source.addEventListener('conversation', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as {
        entityId?: string
        conversation?: MemberConversationView
      }
      for (const subscription of conversationSubscriptions) {
        if (subscription.teamId === change.entityId) subscription.onChange(change.conversation)
      }
    } catch {
      for (const subscription of conversationSubscriptions) subscription.onChange()
    }
  }) as EventListener)
  source.addEventListener('assistant-builder-conversation', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as {
        assistantBuilderConversation?: AssistantBuilderConversationView
      }
      for (const subscription of assistantBuilderSubscriptions) {
        subscription.onChange(change.assistantBuilderConversation)
      }
    } catch {
      for (const subscription of assistantBuilderSubscriptions) subscription.onChange()
    }
  }) as EventListener)
  source.addEventListener('workspace', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as { entityId?: string }
      for (const subscription of workspaceSubscriptions) {
        if (subscription.teamId === change.entityId) subscription.onChange()
      }
    } catch {
      for (const subscription of workspaceSubscriptions) subscription.onChange()
    }
  }) as EventListener)
  source.onerror = () => {
    for (const subscription of changeSubscriptions) subscription.onError()
    for (const subscription of conversationSubscriptions) subscription.onError()
    for (const subscription of assistantBuilderSubscriptions) subscription.onError()
    for (const subscription of workspaceSubscriptions) subscription.onError()
  }
  const resync = (): void => {
    for (const subscription of changeSubscriptions) subscription.onOpen?.()
    for (const subscription of conversationSubscriptions) subscription.onOpen?.()
    for (const subscription of assistantBuilderSubscriptions) subscription.onOpen?.()
    for (const subscription of workspaceSubscriptions) subscription.onOpen?.()
  }
  source.addEventListener('resync', resync)
  source.onopen = resync
  sharedEventSource = source
  return source
}

function releaseEventSourceIfUnused(): void {
  if (
    changeSubscriptions.size > 0
    || conversationSubscriptions.size > 0
    || assistantBuilderSubscriptions.size > 0
    || workspaceSubscriptions.size > 0
  ) return
  sharedEventSource?.close()
  sharedEventSource = undefined
}

export function subscribeAgentTeamWorkspace(
  teamId: string,
  onChange: () => void,
  onError: () => void,
  onOpen?: () => void,
): () => void {
  const subscription: WorkspaceSubscription = {
    teamId,
    onChange,
    onError,
    ...(onOpen === undefined ? {} : { onOpen }),
  }
  workspaceSubscriptions.add(subscription)
  eventSource()
  return () => {
    workspaceSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

export function subscribeAgentTeam(
  onChange: () => void,
  onError: () => void,
  onOpen?: () => void,
): () => void {
  const subscription: ChangeSubscription = { onChange, onError, ...(onOpen === undefined ? {} : { onOpen }) }
  changeSubscriptions.add(subscription)
  eventSource()
  return () => {
    changeSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

export function subscribeAgentTeamConversation(
  teamId: string,
  onChange: (conversation?: MemberConversationView) => void,
  onError: () => void,
  onOpen?: () => void,
): () => void {
  const subscription: ConversationSubscription = {
    teamId,
    onChange,
    onError,
    ...(onOpen === undefined ? {} : { onOpen }),
  }
  conversationSubscriptions.add(subscription)
  const source = eventSource()
  if (source.readyState === EventSource.OPEN) queueMicrotask(() => { onOpen?.() })
  return () => {
    conversationSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

export function subscribeAssistantBuilderConversation(
  onChange: (conversation?: AssistantBuilderConversationView) => void,
  onError: () => void,
  onOpen?: () => void,
): () => void {
  const subscription: AssistantBuilderSubscription = {
    onChange,
    onError,
    ...(onOpen === undefined ? {} : { onOpen }),
  }
  assistantBuilderSubscriptions.add(subscription)
  const source = eventSource()
  if (source.readyState === EventSource.OPEN) queueMicrotask(() => { onOpen?.() })
  return () => {
    assistantBuilderSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}
