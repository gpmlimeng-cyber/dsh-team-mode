import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Config } from '../config.js'
import { AgentTeamError, isAgentTeamError } from '../domain/errors.js'
import { GROUP_SHARE_MAX_REQUEST_BYTES } from '../domain/group-share.js'
import {
  SIDEBAR_GROUP_BRIEF_MAX_CHARS,
  TEAM_ANNOUNCEMENT_MAX_CHARS,
  assistantCreateDraftInputSchema,
} from '../domain/schemas.js'
import type { AgentTeamService, AgentTeamChange } from '../service/dsh-team-mode-service.js'
import {
  AGENT_TEAM_API_PATH,
  AGENT_TEAM_EVENTS_PATH,
  AGENT_TEAM_FILE_NAME_HEADER,
  AGENT_TEAM_METHODS,
  AGENT_TEAM_REQUEST_ID_HEADER,
  AGENT_TEAM_UPLOAD_PATH,
  type AgentTeamRequest,
  type AgentTeamResponse,
} from './contracts.js'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const requestSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  method: z.enum(AGENT_TEAM_METHODS),
  expectedRevision: z.int().positive().optional(),
  payload: z.unknown(),
}).strict()

const idPayload = z.object({ id: z.string().trim().min(1) }).strict()
/**
 * The two import methods carry a whole portable document, so they are read
 * against the portable ceiling instead of the general request cap. Every other
 * method keeps `config.maxRequestBytes`: the limit is per method, not global.
 */
const GROUP_IMPORT_METHODS: ReadonlySet<string> = new Set([
  'sidebar.groups.import.preview',
  'sidebar.groups.import',
])
const groupImportPayload = z.object({
  document: z.unknown(),
  workspaceId: z.string().trim().min(1).max(200),
}).strict()
/**
 * A sidebar group label, non-blank after trim. The 40-char limit stays in the
 * service so its rejection carries the limit instead of a bare Zod error.
 */
const sidebarGroupLabel = z.string().trim().min(1)
/**
 * The brief is checked here as well so an oversized request never reaches the
 * service. The service keeps the same cap for direct callers.
 */
const sidebarGroupBrief = z.string().max(SIDEBAR_GROUP_BRIEF_MAX_CHARS)
/**
 * The announcement is checked here as well so an oversized request never
 * reaches the service. The service keeps the same cap for direct callers and
 * refuses instead of truncating; a blank value clears the field.
 */
const teamAnnouncement = z.string().max(TEAM_ANNOUNCEMENT_MAX_CHARS)
const interactionResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    answers: z.array(z.object({
      id: z.string().trim().min(1).max(200),
      selected: z.array(z.string().min(1).max(500)).max(50),
      custom: z.string().max(32_000).optional(),
    }).strict()).min(1).max(32),
  }).strict(),
  z.object({
    kind: z.literal('approval'),
    outcome: z.enum(['allowed-once', 'rejected']),
  }).strict(),
])

export interface WebTransport {
  dispose(): void
}

export function registerWebTransport(
  ctx: Context,
  config: Config,
  service: AgentTeamService,
): WebTransport {
  const clients = new Set<ServerResponse>()
  const history: AgentTeamChange[] = []
  const unsubscribe = service.subscribe(change => {
    history.push(change)
    if (history.length > 256) history.shift()
    broadcast(clients, change)
  })
  const heartbeat = setInterval(() => {
    for (const response of clients) response.write(': heartbeat\n\n')
  }, config.sseHeartbeatMs)
  heartbeat.unref()

  const disposeApi = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_API_PATH,
    handler: async (request, response) => {
      await handleApi(request, response, config, service, ctx)
    },
  })
  const disposeEvents = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_EVENTS_PATH,
    handler: (request, response) => {
      handleEvents(request, response, clients, history, ctx)
    },
  })
  const disposeUpload = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_UPLOAD_PATH,
    handler: async (request, response) => {
      await handleUpload(request, response, service, ctx)
    },
  })

  return {
    dispose() {
      disposeUpload()
      disposeEvents()
      disposeApi()
      unsubscribe()
      clearInterval(heartbeat)
      for (const response of clients) response.end()
      clients.clear()
    },
  }
}

async function handleUpload(
  request: IncomingMessage,
  response: ServerResponse,
  service: AgentTeamService,
  ctx: Context,
): Promise<void> {
  const requestId = headerValue(request.headers[AGENT_TEAM_REQUEST_ID_HEADER]) ?? 'unknown'
  if (!admit(request, response, ctx, requestId)) return
  if (request.method !== 'POST') {
    writeJson(response, 405, failure(requestId, 'METHOD_NOT_ALLOWED', 'Only POST is supported'))
    return
  }
  try {
    const url = new URL(request.url ?? AGENT_TEAM_UPLOAD_PATH, `http://${request.headers.host ?? 'localhost'}`)
    const teamId = url.searchParams.get('teamId')?.trim()
    const encodedName = headerValue(request.headers[AGENT_TEAM_FILE_NAME_HEADER])
    if (!teamId || !encodedName) throw new AgentTeamError('INVALID_REQUEST', 'Team id and file name are required')
    let fileName: string
    try {
      fileName = decodeURIComponent(encodedName)
    } catch {
      throw new AgentTeamError('INVALID_REQUEST', 'File name encoding is invalid')
    }
    const data = await readBytes(request, MAX_UPLOAD_BYTES)
    const value = await service.uploadWorkspaceFile(teamId, fileName, data)
    writeJson(response, 200, { requestId, ok: true, value })
  } catch (error) {
    if (!isAgentTeamError(error)) {
      ctx.logger.error('dsh-team-mode: unhandled upload error', error)
    }
    const normalized = normalizeError(requestId, error)
    const status = normalized.error.code.endsWith('_NOT_FOUND') ? 404 : 400
    writeJson(response, status, normalized)
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  service: AgentTeamService,
  ctx: Context,
): Promise<void> {
  if (!admit(request, response, ctx)) return
  if (request.method !== 'POST') {
    writeJson(response, 405, failure('unknown', 'METHOD_NOT_ALLOWED', 'Only POST is supported'))
    return
  }
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    writeJson(response, 415, failure('unknown', 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'))
    return
  }

  let parsed: AgentTeamRequest
  let bodyBytes: number
  try {
    const body = await readJson(
      request,
      Math.max(config.maxRequestBytes, GROUP_SHARE_MAX_REQUEST_BYTES),
    )
    bodyBytes = body.bytes
    parsed = requestSchema.parse(body.value) as AgentTeamRequest
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request'
    writeJson(response, 400, failure('unknown', 'INVALID_REQUEST', message))
    return
  }
  if (bodyBytes > config.maxRequestBytes && !GROUP_IMPORT_METHODS.has(parsed.method)) {
    writeJson(response, 400, failure(
      parsed.requestId,
      'INVALID_REQUEST',
      `Request body exceeds ${config.maxRequestBytes} bytes`,
    ))
    return
  }

  try {
    const value = await dispatch(service, parsed)
    writeJson(response, 200, { requestId: parsed.requestId, ok: true, value })
  } catch (error) {
    if (!isAgentTeamError(error) && !(error instanceof z.ZodError)) {
      ctx.logger.error('dsh-team-mode: unhandled API error', error)
    }
    const normalized = normalizeError(parsed.requestId, error)
    const status = normalized.error.code.endsWith('_NOT_FOUND') ? 404
      : normalized.error.code.includes('REVISION_CONFLICT') ? 409
        : 400
    writeJson(response, status, normalized)
  }
}

function handleEvents(
  request: IncomingMessage,
  response: ServerResponse,
  clients: Set<ServerResponse>,
  history: readonly AgentTeamChange[],
  ctx: Context,
): void {
  if (!admit(request, response, ctx)) return
  if (request.method !== 'GET') {
    writeJson(response, 405, failure('unknown', 'METHOD_NOT_ALLOWED', 'Only GET is supported'))
    return
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  })
  response.write('retry: 2000\n\n')
  replayEvents(request, response, history)
  clients.add(response)
  const close = () => { clients.delete(response) }
  request.once('close', close)
  response.once('close', close)
}

async function dispatch(service: AgentTeamService, request: AgentTeamRequest): Promise<unknown> {
  const options = request.expectedRevision === undefined
    ? {}
    : { expectedRevision: request.expectedRevision }
  switch (request.method) {
    case 'catalog.get': return service.catalog()
    case 'catalog.model.get': {
      const payload = z.object({
        provider: z.string().trim().min(1).max(200),
        model: z.string().trim().min(1).max(500),
      }).strict().parse(request.payload)
      return service.modelCapabilities(payload.provider, payload.model)
    }
    case 'skill.catalog': {
      const payload = z.object({ agentPresetId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.skillCatalog(payload.agentPresetId)
    }
    case 'mcp.catalog': {
      const payload = z.object({ agentPresetId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.mcpCatalog(payload.agentPresetId)
    }
    case 'assistant.list': return service.listAssistants()
    case 'assistant.get': return service.getAssistant(idPayload.parse(request.payload).id)
    case 'assistant.create': return service.createAssistant(request.payload as never)
    case 'assistant.create.draft':
      return service.draftAssistantFromSentence(assistantCreateDraftInputSchema.parse(request.payload))
    case 'assistant.update': {
      const payload = z.object({ id: z.string().min(1), value: z.unknown() }).strict().parse(request.payload)
      return service.updateAssistant(payload.id, payload.value as never, options)
    }
    case 'assistant.clone': {
      const payload = z.object({ id: z.string().min(1), name: z.string().optional() }).strict().parse(request.payload)
      return service.cloneAssistant(payload.id, payload.name)
    }
    case 'assistant.delete': await service.deleteAssistant(idPayload.parse(request.payload).id); return null
    case 'assistant.instance.list': {
      const payload = request.payload === undefined || request.payload === null
        ? undefined
        : z.object({ includeArchived: z.boolean().optional() }).strict().parse(request.payload)
      return service.listAssistantInstanceViews(payload)
    }
    case 'assistant.instance.create': return service.createAssistantInstance(request.payload as never)
    case 'assistant.instance.update': {
      const payload = z.object({
        id: z.string().trim().min(1).max(200),
        value: z.unknown(),
      }).strict().parse(request.payload)
      return service.updateAssistantInstance(payload.id, payload.value as never)
    }
    case 'assistant.instance.archive': {
      const payload = z.object({ id: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.archiveAssistantInstance(payload.id)
    }
    case 'assistant.instance.restore': {
      const payload = z.object({ id: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.restoreAssistantInstance(payload.id)
    }
    case 'assistant.instance.pause': {
      const payload = z.object({ id: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.pauseAssistantInstance(payload.id)
    }
    case 'assistant.instance.resume': {
      const payload = z.object({ id: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.resumeAssistantInstance(payload.id)
    }
    case 'assistant.instance.ensure':
      return service.ensureAssistantInstance(idPayload.parse(request.payload).id)
    case 'assistant.thread.create': {
      const payload = z.object({
        instanceId: z.string().trim().min(1).max(200),
        cwd: z.string().trim().min(1).max(4096).optional(),
      }).strict().parse(request.payload)
      // The runtime attaches the new Session before answering, so the instance
      // it returns is already the one that lists it.
      const { instance } = await service.createAssistantThread(payload.instanceId, payload.cwd)
      return instance
    }
    case 'assistant.thread.archive': {
      const payload = z.object({
        instanceId: z.string().trim().min(1).max(200),
        sessionId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.archiveAssistantThread(payload.instanceId, payload.sessionId)
    }
    case 'assistant.thread.restore': {
      const payload = z.object({
        instanceId: z.string().trim().min(1).max(200),
        sessionId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.restoreAssistantThread(payload.instanceId, payload.sessionId)
    }
    case 'assistant.coordinator.get':
      return service.getCoordinatorInstance() ?? null
    case 'assistant.coordinator.set': {
      const payload = z.object({
        assistantId: z.string().trim().min(1).max(200).nullable(),
      }).strict().parse(request.payload)
      return (await service.setCoordinatorInstance(payload.assistantId)) ?? null
    }
    case 'assistant.memory.get': {
      const payload = z.object({
        assistantId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return {
        memory: service.getAssistantMemory(payload.assistantId) ?? null,
        // Read beside the document so the memory block's one read renders the
        // switch too; an unknown id has no row and reads as off.
        memoryAutoCapture: service.getAssistantMemoryAutoCapture(payload.assistantId),
      }
    }
    case 'assistant.memory.write': {
      const payload = z.object({
        assistantId: z.string().trim().min(1).max(200),
        content: z.string(),
        mode: z.enum(['replace', 'append']).optional(),
        expectedRevision: z.int().nonnegative().optional(),
      }).strict().parse(request.payload)
      return service.writeAssistantMemory(payload.assistantId, payload.content, payload.mode, {
        ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
      })
    }
    case 'assistant.memory.entry.write': {
      const payload = z.object({
        assistantId: z.string().trim().min(1).max(200),
        expectedRevision: z.int().nonnegative().optional(),
        entry: z.unknown(),
      }).strict().parse(request.payload)
      return service.writeAssistantMemoryEntry(payload.assistantId, payload.entry as never, {
        ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
        actor: 'user',
      })
    }
    case 'assistant.memory.undo': {
      const payload = z.object({
        assistantId: z.string().trim().min(1).max(200),
        journalId: z.string().trim().min(1).max(200),
        expectedRevision: z.int().nonnegative().optional(),
      }).strict().parse(request.payload)
      return service.undoAssistantMemory(payload.assistantId, payload.journalId, {
        ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
        actor: 'user',
      })
    }
    case 'assistant.memory.ask': {
      const payload = z.object({
        assistantId: z.string().trim().min(1).max(200),
        // The runtime trims and bounds the request so its rejection carries the limit.
        text: z.string(),
      }).strict().parse(request.payload)
      return service.askAssistantMemory(payload.assistantId, payload.text)
    }
    case 'assistant.memory.autoCapture.set': {
      const payload = z.object({
        assistantId: z.string().trim().min(1).max(200),
        enabled: z.boolean(),
      }).strict().parse(request.payload)
      return service.setAssistantMemoryAutoCapture(payload.assistantId, payload.enabled)
    }
    case 'assistant.checkpoint.create': {
      const payload = z.object({
        assistantId: z.string().trim().min(1).max(200),
        note: z.string().max(4000).optional(),
      }).strict().parse(request.payload)
      return service.createAssistantCheckpoint(payload.assistantId, payload.note)
    }
    case 'assistant.checkpoint.list': {
      const payload = z.object({
        assistantId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.listAssistantCheckpoints(payload.assistantId)
    }
    case 'assistant.checkpoint.handoff': {
      const payload = z.object({
        checkpointId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.handoffAssistant(payload.checkpointId)
    }
    case 'assistant.task.list': {
      const payload = request.payload === undefined || request.payload === null
        ? undefined
        : z.object({
          assistantId: z.string().trim().min(1).max(200).optional(),
          includeArchived: z.boolean().optional(),
        }).strict().parse(request.payload)
      return service.listAssistantSessions(payload?.assistantId, {
        ...(payload?.includeArchived === undefined ? {} : { includeArchived: payload.includeArchived }),
      })
    }
    case 'assistant.task.open': {
      const payload = z.object({
        taskId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.openAssistantTask(payload.taskId)
    }
    case 'assistant.task.pause': {
      const payload = z.object({
        taskId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.pauseAssistantTask(payload.taskId)
    }
    case 'assistant.task.resume': {
      const payload = z.object({
        taskId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.resumeAssistantTask(payload.taskId)
    }
    case 'assistant.task.archive': {
      const payload = z.object({
        taskId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.archiveAssistantTask(payload.taskId)
    }
    case 'assistant.task.restore': {
      const payload = z.object({
        taskId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.restoreAssistantTask(payload.taskId)
    }
    case 'assistant.task.interactions': {
      const payload = z.object({
        taskId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.listAssistantTaskInteractions(payload.taskId)
    }
    case 'assistant.task.interaction.respond': {
      const payload = z.object({
        taskId: z.string().trim().min(1).max(200),
        interactionId: z.string().trim().min(1).max(200),
        response: z.unknown(),
      }).strict().parse(request.payload)
      await service.respondAssistantTaskInteraction(
        payload.taskId,
        payload.interactionId,
        payload.response as never,
      )
      return null
    }
    case 'assistant.builder.list': return service.listAssistantBuilderConversations()
    case 'assistant.builder.draft.get': return service.getAssistantBuilderDraft()
    case 'assistant.builder.draft.configure': {
      const payload = z.object({
        provider: z.string().trim().min(1).max(200),
        model: z.string().trim().min(1).max(500),
      }).strict().parse(request.payload)
      return service.configureAssistantBuilderDraft(payload.provider, payload.model)
    }
    case 'assistant.builder.start': {
      const payload = z.object({
        provider: z.string().trim().min(1).max(200),
        model: z.string().trim().min(1).max(500),
        content: z.string().trim().min(1).max(32_000),
      }).strict().parse(request.payload)
      return service.startAssistantBuilderConversation(payload.provider, payload.model, payload.content)
    }
    case 'assistant.builder.get': {
      const payload = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.getAssistantBuilderConversation(payload.sessionId)
    }
    case 'assistant.builder.configure': {
      const payload = z.object({
        sessionId: z.string().trim().min(1).max(200),
        provider: z.string().trim().min(1).max(200),
        model: z.string().trim().min(1).max(500),
      }).strict().parse(request.payload)
      return service.configureAssistantBuilder(payload.sessionId, payload.provider, payload.model)
    }
    case 'assistant.builder.send': {
      const payload = z.object({
        sessionId: z.string().trim().min(1).max(200),
        content: z.string().trim().min(1).max(32_000),
      }).strict().parse(request.payload)
      return service.sendAssistantBuilderMessage(payload.sessionId, payload.content)
    }
    case 'assistant.builder.interaction.respond': {
      const payload = z.object({
        sessionId: z.string().trim().min(1).max(200),
        interactionId: z.string().trim().min(1).max(500),
        response: interactionResponseSchema,
      }).strict().parse(request.payload)
      await service.respondToAssistantBuilderInteraction(
        payload.sessionId,
        payload.interactionId,
        payload.response.kind === 'approval'
          ? payload.response
          : {
            kind: 'question',
            answers: payload.response.answers.map(answer => ({
              id: answer.id,
              selected: answer.selected,
              ...(answer.custom === undefined ? {} : { custom: answer.custom }),
            })),
          },
      )
      return { accepted: true }
    }
    case 'assistant.builder.stop': {
      const payload = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      await service.stopAssistantBuilder(payload.sessionId)
      return { accepted: true }
    }
    case 'assistant.builder.archive': {
      const payload = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      await service.archiveAssistantBuilderConversation(payload.sessionId)
      return { archived: true }
    }
    case 'team.list': return service.listTeams()
    case 'team.get': return service.getTeam(idPayload.parse(request.payload).id)
    case 'team.createDraft': return service.createTeamDraft(request.payload as never)
    case 'team.clone': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(500),
        workspaceId: z.string().trim().min(1).max(500),
      }).strict().parse(request.payload)
      return service.cloneTeam(payload.teamId, {
        name: payload.name,
        workspaceId: payload.workspaceId,
      })
    }
    case 'team.start': return service.startTeam(idPayload.parse(request.payload).id, options)
    case 'team.warmup.retry': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        slotId: z.string().trim().min(1).max(200).optional(),
      }).strict().parse(request.payload)
      return service.retryWarmup(payload.teamId, payload.slotId, options)
    }
    case 'team.addMember': {
      const payload = z.object({ teamId: z.string().min(1), value: z.unknown() }).strict().parse(request.payload)
      return service.addMember(payload.teamId, payload.value as never, options)
    }
    case 'team.renameMember': {
      const payload = z.object({
        teamId: z.string().min(1),
        slotId: z.string().min(1),
        displayName: z.string().min(1),
      }).strict().parse(request.payload)
      return service.renameMember(payload.teamId, payload.slotId, payload.displayName, options)
    }
    case 'team.rename': {
      const payload = z.object({
        teamId: z.string().min(1),
        name: z.string().trim().min(1).max(80),
      }).strict().parse(request.payload)
      return service.renameTeam(payload.teamId, payload.name, options)
    }
    case 'team.announcement.set': {
      const payload = z.object({
        teamId: z.string().min(1),
        announcement: teamAnnouncement,
      }).strict().parse(request.payload)
      // User-only write: no expectedRevision fence, matching the group brief.
      return service.setTeamAnnouncement(payload.teamId, payload.announcement)
    }
    case 'team.removeMember': {
      const payload = z.object({ teamId: z.string().min(1), slotId: z.string().min(1) }).strict().parse(request.payload)
      return service.removeMember(payload.teamId, payload.slotId, options)
    }
    case 'team.changeLeader': {
      const payload = z.object({ teamId: z.string().min(1), successorSlotId: z.string().min(1) }).strict().parse(request.payload)
      return service.changeLeader(payload.teamId, payload.successorSlotId, options)
    }
    case 'team.updateGoal': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        goalId: z.string().trim().min(1).max(200),
        value: z.unknown(),
      }).strict().parse(request.payload)
      return service.updateGoal(payload.teamId, payload.goalId, payload.value as never)
    }
    case 'team.reset': {
      const payload = z.object({ teamId: z.string().min(1), confirmation: z.string() }).strict().parse(request.payload)
      return service.resetTeam(payload.teamId, payload.confirmation, options)
    }
    case 'team.message.list': return service.listMessages(idPayload.parse(request.payload).id)
    case 'team.message.send': {
      const payload = z.object({
        teamId: z.string().min(1),
        content: z.string(),
        targetSlotId: z.string().min(1).optional(),
      }).strict().parse(request.payload)
      return service.sendUserMessage(payload.teamId, payload.content, payload.targetSlotId)
    }
    case 'team.workbench.get': return service.getWorkbench(idPayload.parse(request.payload).id)
    case 'team.thread.create': {
      // The Session is created in the team Workspace by the runtime before the
      // record is written; the transport only carries the team id.
      return service.createTeamThread(idPayload.parse(request.payload).id, options)
    }
    case 'team.thread.rename': {
      const payload = z.object({
        id: z.string().trim().min(1).max(200),
        threadId: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(80),
      }).strict().parse(request.payload)
      return service.renameThread(payload.id, payload.threadId, payload.title, options)
    }
    case 'team.thread.archive': {
      const payload = z.object({
        id: z.string().trim().min(1).max(200),
        threadId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.archiveThread(payload.id, payload.threadId, options)
    }
    case 'team.member.stop': {
      const payload = z.object({ teamId: z.string().min(1), slotId: z.string().min(1) }).strict().parse(request.payload)
      await service.stopMember(payload.teamId, payload.slotId)
      return { accepted: true }
    }
    case 'team.member.contextReset': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        slotId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.contextResetMember(payload.teamId, payload.slotId, options)
    }
    case 'team.checkpoint.create': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        note: z.string().max(4000).optional(),
      }).strict().parse(request.payload)
      return service.createTeamLeaderCheckpoint(payload.teamId, payload.note, options)
    }
    case 'team.checkpoint.list': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.listTeamCheckpoints(payload.teamId)
    }
    case 'team.checkpoint.handoff': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        checkpointId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.handoffTeamLeader(payload.teamId, payload.checkpointId, options)
    }
    case 'team.member.reconnect': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        slotId: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.reconnectMember(payload.teamId, payload.slotId, options)
    }
    case 'team.members.reorder': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        order: z.array(z.string().trim().min(1).max(200)).max(64),
      }).strict().parse(request.payload)
      return service.reorderMembers(payload.teamId, payload.order, options)
    }
    case 'team.pin': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        pinned: z.boolean(),
      }).strict().parse(request.payload)
      return service.setTeamPinned(payload.teamId, payload.pinned, options)
    }
    case 'team.archive': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        archived: z.boolean(),
      }).strict().parse(request.payload)
      return service.setTeamArchived(payload.teamId, payload.archived, options)
    }
    case 'team.group.set': {
      // The length/whitespace rule stays in the service: its rejection carries the
      // limit, whereas a transport-side cap would answer with a bare validation error.
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        group: z.string().nullable(),
      }).strict().parse(request.payload)
      return service.setTeamGroup(payload.teamId, payload.group, options)
    }
    case 'team.memory.write': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        expectedMemoryRevision: z.int().nonnegative().optional(),
        value: z.object({
          id: z.string().trim().min(1).max(200).optional(),
          key: z.string().max(200).optional(),
          title: z.string(),
          body: z.string(),
        }).strict(),
      }).strict().parse(request.payload)
      return service.writeUserTeamMemory(payload.teamId, {
        ...(payload.value.id === undefined ? {} : { id: payload.value.id }),
        ...(payload.value.key === undefined ? {} : { key: payload.value.key }),
        title: payload.value.title,
        body: payload.value.body,
      }, {
        ...(payload.expectedMemoryRevision === undefined
          ? {}
          : { expectedMemoryRevision: payload.expectedMemoryRevision }),
      })
    }
    case 'team.memory.decide': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        entryId: z.string().trim().min(1).max(200),
        expectedMemoryRevision: z.int().nonnegative().optional(),
        decision: z.enum(['accept', 'reject']),
      }).strict().parse(request.payload)
      return service.decideUserTeamMemory(payload.teamId, payload.entryId, payload.decision, {
        ...(payload.expectedMemoryRevision === undefined
          ? {}
          : { expectedMemoryRevision: payload.expectedMemoryRevision }),
      })
    }
    case 'team.memory.undo': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        journalId: z.string().trim().min(1).max(200),
        expectedMemoryRevision: z.int().nonnegative().optional(),
      }).strict().parse(request.payload)
      return service.undoUserTeamMemory(payload.teamId, payload.journalId, {
        ...(payload.expectedMemoryRevision === undefined
          ? {}
          : { expectedMemoryRevision: payload.expectedMemoryRevision }),
      })
    }
    case 'team.interaction.respond': {
      const payload = z.object({
        teamId: z.string().trim().min(1).max(200),
        slotId: z.string().trim().min(1).max(200),
        interactionId: z.string().trim().min(1).max(300),
        response: interactionResponseSchema,
      }).strict().parse(request.payload)
      await service.respondToInteraction(
        payload.teamId,
        payload.slotId,
        payload.interactionId,
        payload.response.kind === 'approval'
          ? payload.response
          : {
            kind: 'question',
            answers: payload.response.answers.map(answer => ({
              id: answer.id,
              selected: answer.selected,
              ...(answer.custom === undefined ? {} : { custom: answer.custom }),
            })),
          },
      )
      return { accepted: true }
    }
    case 'team.member.setPermissionPreset': {
      const payload = z.object({
        teamId: z.string().min(1),
        slotId: z.string().min(1),
        permissionPresetId: z.string().min(1),
      }).strict().parse(request.payload)
      return service.setMemberPermissionPreset(
        payload.teamId,
        payload.slotId,
        payload.permissionPresetId,
        options,
      )
    }
    case 'team.member.setReasoningEffort': {
      const payload = z.object({
        teamId: z.string().min(1),
        slotId: z.string().min(1),
        reasoningEffort: z.string().trim().min(1).max(200).optional(),
      }).strict().parse(request.payload)
      return service.setMemberReasoningEffort(
        payload.teamId,
        payload.slotId,
        payload.reasoningEffort,
        options,
      )
    }
    case 'team.member.setAssistantInstance': {
      const payload = z.object({
        teamId: z.string().min(1),
        slotId: z.string().min(1),
        assistantInstanceId: z.string().trim().min(1).max(200).nullable(),
      }).strict().parse(request.payload)
      return service.setMemberAssistantInstance(
        payload.teamId,
        payload.slotId,
        payload.assistantInstanceId,
        options,
      )
    }
    case 'team.workspace.list': {
      const payload = z.object({
        teamId: z.string().min(1),
        path: z.string().max(4096).optional(),
      }).strict().parse(request.payload)
      return service.listWorkspace(payload.teamId, payload.path)
    }
    case 'team.workspace.search': {
      const payload = z.object({
        teamId: z.string().min(1),
        query: z.string().max(4096).optional(),
        limit: z.int().min(1).max(100).optional(),
      }).strict().parse(request.payload)
      return service.searchWorkspace(payload.teamId, payload.query, payload.limit)
    }
    case 'team.workspace.changes': {
      const payload = z.object({ teamId: z.string().min(1) }).strict().parse(request.payload)
      return service.getWorkspaceChanges(payload.teamId)
    }
    case 'team.workspace.diff': {
      const payload = z.object({
        teamId: z.string().min(1),
        path: z.string().min(1).max(4096),
        scope: z.enum(['staged', 'unstaged']),
        layout: z.enum(['unified', 'split']),
        theme: z.enum(['light', 'dark']),
      }).strict().parse(request.payload)
      return service.getWorkspaceDiff(payload.teamId, payload.path, payload.scope, payload.layout, payload.theme)
    }
    case 'escalation.list': {
      // The read is also the aggregation pass: a live approval or question is
      // recorded (and a cleared gate lifted) before the rows go out, so 今天's
      // 等你确认 and every badge never lag behind the runtime. No payload, so
      // nothing to parse.
      await service.refreshEscalations()
      const items = service.listEscalations()
      return { items, total: items.length }
    }
    case 'sidebar.groups.list':
      // Ordered labels only; no payload, so nothing to parse.
      return service.listGroups()
    case 'sidebar.groups.create': {
      const payload = z.object({ name: sidebarGroupLabel }).strict().parse(request.payload)
      return service.createGroup(payload.name)
    }
    case 'sidebar.groups.rename': {
      const payload = z.object({ from: sidebarGroupLabel, to: sidebarGroupLabel }).strict().parse(request.payload)
      return service.renameGroup(payload.from, payload.to)
    }
    case 'sidebar.groups.delete': {
      const payload = z.object({ name: sidebarGroupLabel }).strict().parse(request.payload)
      return service.deleteGroup(payload.name)
    }
    case 'sidebar.groups.reorder': {
      const payload = z.object({ names: z.array(sidebarGroupLabel) }).strict().parse(request.payload)
      return service.setGroupOrder(payload.names)
    }
    case 'sidebar.groups.briefs':
      // Full records for the editor; no payload, so nothing to parse.
      return service.listGroupBriefs()
    case 'sidebar.groups.brief.set': {
      const payload = z.object({
        name: sidebarGroupLabel,
        brief: sidebarGroupBrief,
      }).strict().parse(request.payload)
      return service.setGroupBrief(payload.name, payload.brief)
    }
    case 'sidebar.groups.export': {
      const payload = z.object({ name: sidebarGroupLabel }).strict().parse(request.payload)
      return service.exportGroup(payload.name)
    }
    case 'sidebar.groups.import.preview': {
      const payload = groupImportPayload.parse(request.payload)
      return service.previewGroupImport(payload.document, payload.workspaceId)
    }
    case 'sidebar.groups.import': {
      const payload = groupImportPayload.extend({
        expectedPlanHash: z.string().trim().min(1).max(200),
      }).strict().parse(request.payload)
      return service.importGroup(payload.document, payload.workspaceId, payload.expectedPlanHash)
    }
    case 'team.dissolve': {
      const payload = z.object({ teamId: z.string().min(1), confirmation: z.string() }).strict().parse(request.payload)
      await service.dissolveTeam(payload.teamId, payload.confirmation, options)
      return null
    }
  }
}

/**
 * Read one JSON body. The byte count is returned with the value so the caller
 * can hold a general method to `config.maxRequestBytes` while the two import
 * methods use the larger portable-document ceiling.
 */
async function readJson(
  request: IncomingMessage,
  limit: number,
): Promise<{ value: unknown; bytes: number }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) throw new AgentTeamError('INVALID_REQUEST', `Request body exceeds ${limit} bytes`)
    chunks.push(buffer)
  }
  if (chunks.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Request body is empty')
  return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, bytes: size }
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > limit) {
    throw new AgentTeamError('INVALID_REQUEST', `File exceeds the ${Math.floor(limit / 1024 / 1024)} MB upload limit`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) {
      throw new AgentTeamError('INVALID_REQUEST', `File exceeds the ${Math.floor(limit / 1024 / 1024)} MB upload limit`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Reuse the Harness connection's trusted-Host/origin fence and signed browser
 * or API credential. A plugin-owned route must not invent its own auth.
 */
function admit(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: Context,
  requestId = 'unknown',
): boolean {
  const rejection = ctx.connection.requestRejection(request)
  if (rejection === undefined) return true
  writeJson(
    response,
    rejection,
    failure(
      requestId,
      rejection === 401 ? 'UNAUTHORIZED' : 'ORIGIN_REJECTED',
      rejection === 401 ? 'Authentication required' : 'Request origin is not trusted',
    ),
  )
  return false
}

function eventFrame(change: AgentTeamChange): string {
  const event = change.entityType === 'conversation' ? 'conversation'
    : change.entityType === 'assistant-builder' ? 'assistant-builder-conversation'
      : change.entityType === 'workspace' ? 'workspace'
      : 'change'
  return `id: ${change.cursor}\nevent: ${event}\ndata: ${JSON.stringify(change)}\n\n`
}

function broadcast(clients: Set<ServerResponse>, change: AgentTeamChange): void {
  const frame = eventFrame(change)
  for (const response of clients) response.write(frame)
}

/**
 * Replay the tail the client missed. EventSource sends `Last-Event-ID` on its
 * own reconnect; `?cursor=` keeps curl and tests explicit. If the requested
 * cursor predates the retained window, ask the client to resync instead of
 * pretending the gap does not exist.
 */
function replayEvents(
  request: IncomingMessage,
  response: ServerResponse,
  history: readonly AgentTeamChange[],
): void {
  const headerId = headerValue(request.headers['last-event-id'])
  const queryId = (() => {
    try {
      return new URL(request.url ?? '', 'http://localhost').searchParams.get('cursor') ?? undefined
    } catch {
      return undefined
    }
  })()
  const raw = headerId ?? queryId
  if (raw === undefined || raw.trim() === '') return
  const cursor = Number(raw)
  if (!Number.isSafeInteger(cursor) || cursor < 0) return
  const latest = history.at(-1)?.cursor ?? 0
  if (cursor === latest) return
  if (cursor > latest) {
    // A restarted host or a different process: the client is ahead of this
    // history, so it must reload rather than wait for events that never come.
    response.write(`event: resync\ndata: ${JSON.stringify({ cursor: latest })}\n\n`)
    return
  }
  const first = history[0]
  if (first === undefined || cursor < first.cursor - 1) {
    response.write(`event: resync\ndata: ${JSON.stringify({ cursor: latest })}\n\n`)
    return
  }
  for (const change of history) {
    if (change.cursor <= cursor) continue
    response.write(eventFrame(change))
  }
}

function normalizeError(requestId: string, error: unknown): AgentTeamResponse & { ok: false } {
  if (isAgentTeamError(error)) {
    return failure(requestId, error.code, error.message, error.details)
  }
  if (error instanceof z.ZodError) {
    return failure(requestId, 'INVALID_REQUEST', 'Request validation failed', { issues: error.issues })
  }
  return failure(requestId, 'INTERNAL_ERROR', 'Agent Team encountered an internal error')
}

function failure(
  requestId: string,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AgentTeamResponse & { ok: false } {
  return {
    requestId,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }
}

function writeJson(response: ServerResponse, status: number, body: AgentTeamResponse): void {
  const json = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(json)
}
