/**
 * Response-speed baseline for the team runtime — measurement only.
 *
 * Run: `npx vitest run --config scripts/vitest.measure.config.ts`
 *
 * Part A boots the real `AgentTeamService` + `TeamRuntime` against in-memory
 * doubles and fake Agents (no model call), so every number below is the
 * plugin's own orchestration cost: store writes, publishes, ensure/start,
 * dispatch and status projection. It answers "how much of the wait belongs to
 * Agent Team itself".
 *
 * Part B reads the durable store this machine already has, read-only, and
 * derives the intervals the runtime records on its own (warmup, message
 * delivery, task start). No product code is loaded for Part B.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, it } from 'vitest'
import type { Config } from '../src/config.js'
import { DomainAgentTeamStore } from '../src/storage/store.js'
import { AgentTeamService } from '../src/service/dsh-team-mode-service.js'
import { TeamRuntime } from '../src/runtime/team-runtime.js'

const config: Config = {
  maxRequestBytes: 128 * 1024,
  sseHeartbeatMs: 20_000,
  runtimeConcurrency: 4,
  directMemberChatDefault: true,
  assistantBuilderProvider: '',
  assistantBuilderModel: '',
  assistantBuilderAgentPresetId: '',
  assistantBuilderPermissionPresetId: '',
}

/** The client's change coalescing window in `src/client/components.tsx`. */
const CLIENT_RELOAD_DEBOUNCE_MS = 120

const WORKSPACE_ID = 'workspace-measure'
const WORKSPACE_PATH = '/tmp/dsh-team-mode-measure-workspace'

function now(): number {
  return performance.now()
}

function timed(): { at: number; ms: () => number } {
  const at = now()
  return { at, ms: () => now() - at }
}

/**
 * A Domain-shaped façade over Maps: production `DomainAgentTeamStore` code runs
 * unchanged, only the durable medium is replaced. Writes resolve on a microtask,
 * which is the cheapest possible backend, so the numbers below are the
 * lower bound of a real disk write.
 */
function memoryDomain(): never {
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string): unknown => {
    let rows = tables.get(name)
    if (rows === undefined) {
      rows = new Map()
      tables.set(name, rows)
    }
    const store = rows
    return {
      get: (key: string) => store.get(key),
      entries: () => store.entries(),
      keys: () => store.keys(),
      get size() {
        return store.size
      },
      put: async (key: string, value: unknown) => {
        store.set(key, value)
      },
      delete: async (key: string) => store.delete(key),
      update: async (key: string, update: (current: unknown) => unknown) => {
        if (!store.has(key)) throw new Error(`missing record '${key}' in table '${name}'`)
        const next = update(store.get(key))
        store.set(key, next)
        return next
      },
    }
  }
  return { table } as never
}

interface FakeAgent {
  id: string
  session: { events: unknown[]; snapshotEvents: () => unknown[] }
  status: 'idle' | 'running'
  followup: (message: { id: string }) => void
  cancel: () => void
  whenIdle: () => Promise<void>
}

interface Harness {
  ctx: any
  service: AgentTeamService
  runtime: TeamRuntime
  created: { at: number; kind: string; entityId: string }[]
  agents: Map<string, FakeAgent & { followupAt?: number }>
  emit: (name: string, event: unknown) => void
  waitFor: <T>(read: () => T | undefined, label: string, timeoutMs?: number) => Promise<T>
  interval: (read: () => string | undefined, want: string, label: string, timeoutMs?: number) => Promise<number>
}

function createHarness(): Harness {
  const listeners = new Map<string, Set<(event: any) => void>>()
  const ctx = new Context() as any
  ctx.on = (name: string, handler: (event: any) => void) => {
    let bucket = listeners.get(name)
    if (bucket === undefined) {
      bucket = new Set()
      listeners.set(name, bucket)
    }
    bucket.add(handler)
    return () => {
      bucket?.delete(handler)
    }
  }
  ctx.emit = (name: string, ...args: unknown[]) => {
    for (const handler of listeners.get(name) ?? []) handler(...args)
  }
  ctx.provide('logger', { debug() {}, info() {}, warn() {}, error() {} })
  ctx.provide('llm', {
    listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
    listModels: async () => [{ id: 'codex', name: 'Codex' }],
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      model,
      reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
    }),
  })
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'default', name: 'Default' }],
    resolve: async (id: string) => ({ id, name: id }),
    mount: async () => {},
    acquireScope: async () => ({ key: { kind: 'preset-scope' }, [Symbol.asyncDispose]: async () => {} }),
  })
  ctx.provide('tools', { get: () => undefined, schemas: () => [], register() {}, restrict() {}, guard() {} })
  ctx.provide('skills', { list: async () => [], registerProvider() {} })
  ctx.provide('permissionPresets', {
    names: ['standard'],
    optionOf: (name: string) => ({ value: name, name }),
    set: () => {},
  })
  const agents = new Map<string, FakeAgent & { followupAt?: number }>()
  ctx.provide('agents', {
    get: () => undefined,
    create: async (options: any) => {
      const sessionId = String(options.sessionId)
      const events: unknown[] = []
      const agent: FakeAgent & { followupAt?: number } = {
        id: sessionId,
        session: { events, snapshotEvents: () => events },
        status: 'idle',
        followup: (message: { id: string }) => {
          agent.followupAt = now()
          events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
          agent.status = 'running'
        },
        cancel: () => {},
        whenIdle: async () => {},
      }
      agents.set(sessionId, agent)
      const sections = new Map<string, { order: number; text: () => string }>()
      const agentCtx: any = {
        on: () => () => {},
        effect: () => {},
        inject: async (_deps: string[], callback: (scope: unknown) => void) => {
          callback(agentCtx)
        },
        skills: { registerProvider: () => {} },
        tools: { schemas: () => [], register: () => {}, restrict: () => {}, guard: () => {}, get: () => undefined },
        systemPrompt: {
          section: (spec: { name: string; order: number; text: () => string }) => {
            sections.set(spec.name, spec)
          },
          assemble: async () => ({ sections: [...sections.keys()].map(name => ({ name })) }),
        },
      }
      await options.setup(agentCtx, agent)
      return { agent, dispose: async () => {} }
    },
    resume: async (options: any) => ctx.agents.create(options),
  })
  ctx.provide('sessions', { flush: async () => {} })
  ctx.provide('sessionPersistence', { list: async () => [] })
  const workspace = {
    id: WORKSPACE_ID,
    path: WORKSPACE_PATH,
    title: 'Measure',
    status: async () => 'ok' as const,
    attachSession: async () => {},
    detachSession: async () => {},
  }
  ctx.provide('workspaceRegistry', {
    get: (id: string) => (id === workspace.id ? workspace : undefined),
    list: () => [workspace],
  })

  const service = new AgentTeamService(ctx, config, new DomainAgentTeamStore(memoryDomain() as never))
  const runtime = new TeamRuntime(ctx, config, service)
  service.attachRuntime(runtime)
  const created: { at: number; kind: string; entityId: string }[] = []
  service.subscribe(change => {
    created.push({ at: now(), kind: change.kind, entityId: change.entityId })
  })

  const emit = (name: string, ...args: unknown[]): void => ctx.emit(name, ...args)

  return {
    ctx,
    service,
    runtime,
    created,
    agents,
    emit,
    async waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> {
      const deadline = now() + timeoutMs
      for (;;) {
        const value = read()
        if (value !== undefined) return value
        if (now() > deadline) throw new Error(`timeout waiting for ${label}`)
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    },
    async interval(read, want, label, timeoutMs = 10_000): Promise<number> {
      const start = now()
      await this.waitFor(() => (read() === want ? true : undefined), label, timeoutMs)
      return now() - start
    },
  }
}

interface Sample {
  createMs: number
  rowReadMs: number
  startMs: number
  leaderWarmupMs: number
  fullWarmupMs: number
  dispatchMs: number
  wakeMs: number
  queuedWhileBusy: string
  dispatchWhileBusy: string
  statusPublishMs: number
  /** Change events the SSE stream pushes for each stage (the client reload trigger). */
  reloadMs: number
  createEvents: number
  startEvents: number
  dispatchEvents: number
  statusEvents: number
}

async function oneSample(sample: number): Promise<Sample> {
  const h = createHarness()
  const assistant = await h.service.createAssistant({
    name: `Measure ${sample}`,
    instructions: 'Measure.',
    provider: 'openai',
    model: 'codex',
    agentPresetId: 'default',
    permissionPresetId: 'standard',
    skillAllowlist: [],
    mcpServers: [],
  })

  // ── 1. create team → row visible ─────────────────────────────────────────
  const create = timed()
  const draft = await h.service.createTeamDraft({
    name: `Measure ${sample}`,
    workspaceId: WORKSPACE_ID,
    members: [
      { assistantId: assistant.id, role: 'leader' },
      { assistantId: assistant.id, role: 'member' },
      { assistantId: assistant.id, role: 'member' },
    ],
  })
  const published = h.created.find(change => change.kind === 'team.created')
  const createMs = (published?.at ?? now()) - create.at
  const rowRead = timed()
  h.service.listTeams()
  const rowReadMs = rowRead.ms()
  const afterCreate = h.created.length
  // What one client reload fetches: catalog.get + assistant.list + team.list.
  const reload = timed()
  await Promise.all([h.service.catalog(), h.service.listAssistants(), h.service.listTeams()])
  const reloadMs = reload.ms()

  // ── 2. row visible → Leader Session openable (`team.start`) ─────────────
  const start = timed()
  await h.service.startTeam(draft.id)
  const startMs = start.ms()
  const startedTeam = h.service.getTeam(draft.id)
  const warmup = startedTeam.warmup
  const leaderWarmupMs = warmup?.startedAt !== undefined && warmup.leaderReadyAt !== undefined
    ? Date.parse(warmup.leaderReadyAt) - Date.parse(warmup.startedAt)
    : Number.NaN
  const afterStart = h.created.length
  const fullWarmupMs = await h.interval(
    () => h.service.getTeam(draft.id).warmup?.phase,
    'ready',
    'full warmup',
  )

  const team = h.service.getTeam(draft.id)
  const memberId = Object.keys(team.members).find(id => id !== team.leaderSlotId)!
  const secondMember = Object.keys(team.members)
    .filter(id => id !== team.leaderSlotId && id !== memberId)[0]!
  const leaderSession = team.members[team.leaderSlotId]!.sessionId
  const memberSession = team.members[memberId]!.sessionId
  const secondSession = team.members[secondMember]!.sessionId
  const tick = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 1)) }

  // ── 3a. dispatch to an idle member ──────────────────────────────────────
  const dispatch = timed()
  await commandsOf(h).createTask(team.id, team.leaderSlotId, {
    subject: 'measure dispatch',
    description: '',
    owner: memberId,
  })
  const dispatchMs = (h.agents.get(memberSession)?.followupAt ?? now()) - dispatch.at
  const afterDispatch = h.created.length
  // Release that turn so the next stage starts from a team with no active turn.
  h.agents.get(memberSession)!.status = 'idle'
  h.emit('agent/status', { agent: { id: memberSession }, status: 'idle' })
  await tick()

  // ── 3b. a second recipient's turn while one turn already runs ───────────
  // The turn coordinator allows one active turn per team, so a member message
  // addressed elsewhere is parked and only woken when the active turn releases.
  // Its wait therefore equals the remainder of that turn; what is measured here
  // is the release→wake step, never the model time inside the running turn.
  await h.runtime.sendUserMessage(team.id, 'hold the turn')
  // A busy Session is never handed a second turn, so the running state must be
  // published only after the turn was taken (the host emits it on the wake).
  h.agents.get(leaderSession)!.status = 'running'
  h.emit('agent/status', { agent: { id: leaderSession }, status: 'running' })
  await h.waitFor(
    () => (h.service.getTeam(draft.id).members[team.leaderSlotId]!.lastRuntimeState === 'running' ? true : undefined),
    'leader running',
  )
  h.agents.get(secondSession)!.followupAt = undefined
  const parked = await commandsOf(h).sendMemberMessage(
    team.id,
    team.leaderSlotId,
    secondMember,
    'measure parked turn',
    'instruction',
  )
  const queuedWhileBusy = parked.deliveryState ?? 'delivered'
  const wake = timed()
  h.agents.get(leaderSession)!.status = 'idle'
  h.emit('agent/status', { agent: { id: leaderSession }, status: 'idle' })
  const wakeMs = await h.waitFor(
    () => h.agents.get(secondSession)?.followupAt,
    'parked member woken',
  ).then(at => at - wake.at)

  // ── 3d. task dispatch while another member holds a turn ─────────────────
  // Task assignments go out through the message dispatcher, not the turn
  // coordinator: this records whether they wait behind a running turn.
  const busyTask = await commandsOf(h).createTask(team.id, team.leaderSlotId, {
    subject: 'measure task while busy',
    description: '',
    owner: memberId,
  })
  const dispatchWhileBusy = busyTask.deliveryState ?? 'delivered'
  h.agents.get(secondSession)!.status = 'idle'
  h.emit('agent/status', { agent: { id: secondSession }, status: 'idle' })
  await tick()
  h.agents.get(memberSession)!.followupAt = undefined

  // ── 4. member finishes → status back to the team row ────────────────────
  h.agents.get(memberSession)!.status = 'running'
  h.emit('agent/status', { agent: { id: memberSession }, status: 'running' })
  await h.waitFor(
    () => (h.service.getTeam(draft.id).members[memberId]!.lastRuntimeState === 'running' ? true : undefined),
    'member running',
  )
  const seen = h.created.length
  const status = timed()
  h.emit('agent/status', { agent: { id: memberSession }, status: 'idle' })
  await h.waitFor(
    () => h.created.slice(seen).find(change =>
      change.kind === 'team.member_status'
      && change.entityId === draft.id
      && h.service.getTeam(draft.id).members[memberId]!.lastRuntimeState === 'idle'),
    'idle status publish',
  )
  const statusPublishMs = status.ms()
  const afterStatus = h.created.length

  return {
    createMs,
    rowReadMs,
    startMs,
    leaderWarmupMs,
    fullWarmupMs,
    dispatchMs,
    wakeMs: Math.max(0, wakeMs),
    queuedWhileBusy,
    dispatchWhileBusy,
    statusPublishMs: Math.max(0, statusPublishMs),
    reloadMs,
    createEvents: afterCreate,
    startEvents: afterStart - afterCreate,
    dispatchEvents: afterDispatch - afterStart,
    statusEvents: afterStatus - seen,
  }
}

function commandsOf(h: Harness): any {
  return (h.runtime as unknown as { commands: any }).commands
}

interface Stats {
  median: number
  p95: number
  max: number
  n: number
}

function stats(values: number[]): Stats | undefined {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (finite.length === 0) return undefined
  const middle = finite.length / 2
  const median = finite.length % 2 === 1
    ? finite[(finite.length - 1) / 2]!
    : (finite[middle - 1]! + finite[middle]!) / 2
  const p95 = finite[Math.min(finite.length - 1, Math.max(0, Math.ceil(0.95 * finite.length) - 1))]!
  return { median, p95, max: finite[finite.length - 1]!, n: finite.length }
}

function describeNumbers(values: number[]): string {
  const result = stats(values)
  if (result === undefined) return 'n/a'
  const round = (value: number): string => `${value.toFixed(1)} ms`
  return `median ${round(result.median)} · p95 ${round(result.p95)} · max ${round(result.max)} · n=${result.n}`
}

describe('team responsiveness baseline', () => {
  it('measures the four user-visible intervals and prints the baseline', async () => {
    const samples: Sample[] = []
    for (let index = 0; index < 8; index += 1) samples.push(await oneSample(index))

    const load = `load ${(await import('node:os')).loadavg().map(value => value.toFixed(2)).join(' / ')}`
    process.stdout.write([
      '',
      '# In-process orchestration baseline (fake Agents — no model time)',
      `# ${process.platform} ${process.arch} · node ${process.version} · cpus ${(await import('node:os')).cpus().length} · ${load}`,
      '',
      `1  create → row visible (server publish)      ${describeNumbers(samples.map(s => s.createMs))}`,
      `1b sidebar refetch (listTeams)                ${describeNumbers(samples.map(s => s.rowReadMs))}`,
      `1c one client reload (catalog+assist+teams)   ${describeNumbers(samples.map(s => s.reloadMs))}`,
      `2  row → Leader openable (team.start)         ${describeNumbers(samples.map(s => s.startMs))}`,
      `2b record: warmup startedAt → leaderReadyAt   ${describeNumbers(samples.map(s => s.leaderWarmupMs))}`,
      `2c record: warmup startedAt → phase ready     ${describeNumbers(samples.map(s => s.fullWarmupMs))}`,
      `3  task dispatch → idle member woken          ${describeNumbers(samples.map(s => s.dispatchMs))}`,
      `3b member message while a turn is active     ${[...new Set(samples.map(s => s.queuedWhileBusy))].join('/')}`,
      `3c turn released → parked member woken        ${describeNumbers(samples.map(s => s.wakeMs))}`,
      `3d task assigned while another turn is active ${[...new Set(samples.map(s => s.dispatchWhileBusy))].join('/')}`,
      `4  member idle → team-row status published    ${describeNumbers(samples.map(s => s.statusPublishMs))}`,
      `4b client coalescing window (source constant) ${CLIENT_RELOAD_DEBOUNCE_MS} ms added to 1 and 4`,
      '',
      'change events per sample (each one wakes the client, which reloads at most once per 120 ms):',
      `1 ${describeCount(samples.map(s => s.createEvents))}`,
      `2 ${describeCount(samples.map(s => s.startEvents))}`,
      `3 ${describeCount(samples.map(s => s.dispatchEvents))}`,
      `4 ${describeCount(samples.map(s => s.statusEvents))}`,
      `total ${describeCount(samples.map(s => s.createEvents + s.startEvents + s.dispatchEvents + s.statusEvents))}`,
      '',
    ].join('\n'))

    realStoreTable()
  })
})

/** Part B: what this machine already recorded, read-only. */
function realStoreTable(): void {
  const path = process.env.DSH_TEAM_STORE ?? join(homedir(), '.dsh', 'storages', 'dsh_team_mode.json')
  let parsed: any
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    process.stdout.write(`# durable store not readable at ${path}; skipping recorded-data table\n`)
    return
  }
  const rows = (name: string): any[] => {
    const table = parsed?.tables?.[name]
    if (table === undefined || table === null) return []
    return (Array.isArray(table) ? table : Object.values(table)).map((entry: any) => entry?.value ?? entry)
  }
  const teams = rows('teams')
  const messages = rows('messages')
  const activities = rows('activities')

  const leaderWarmups = teams
    .map(team => team.warmup)
    .filter(warmup => warmup?.startedAt !== undefined && warmup?.leaderReadyAt !== undefined)
    .map(warmup => Date.parse(warmup.leaderReadyAt) - Date.parse(warmup.startedAt))
    .filter(Number.isFinite)

  const deliveries = activities
    .filter(activity => activity.kind === 'team.message_delivered')
    .map(activity => {
      const match = /Team message (\S+) delivered/.exec(String(activity.summary ?? ''))
      if (match === null) return undefined
      const message = messages.find(candidate => candidate.id === match[1])
      if (message === undefined) return undefined
      return Date.parse(activity.createdAt) - Date.parse(message.createdAt)
    })
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0)

  const teamPublishes = teams
    .map(team => {
      const activity = activities.find(candidate =>
        candidate.kind === 'team.created' && candidate.entityId === team.id)
      if (activity === undefined) return undefined
      return Date.parse(activity.createdAt) - Date.parse(team.createdAt)
    })
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0)

  const taskStarts = activities
    .filter(activity => activity.kind === 'team.task_created')
    .map(activity => {
      const next = activities
        .filter(candidate => candidate.kind === 'team.task_updated')
        .filter(candidate => String(candidate.summary ?? '').startsWith(String(activity.summary ?? '').replace(/ created$/, '')))
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))[0]
      if (next === undefined) return undefined
      return Date.parse(next.createdAt) - Date.parse(activity.createdAt)
    })
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0)

  process.stdout.write([
    '# Recorded-data baseline (read-only, this machine)',
    `# source ${path}`,
    '',
    `team record written → row change published   ${describeNumbers(teamPublishes)}`,
    `warmup startedAt → leaderReadyAt              ${describeNumbers(leaderWarmups)}`,
    `message created → delivered (dispatch ack)    ${describeNumbers(deliveries)}`,
    `task created → entered running (member start) ${describeSeconds(taskStarts)}`,
    '',
  ].join('\n'))
}

function describeCount(values: number[]): string {
  const result = stats(values)
  if (result === undefined) return 'n/a'
  return `median ${result.median} · max ${result.max} · n=${result.n}`
}

function describeSeconds(values: number[]): string {
  const result = stats(values)
  if (result === undefined) return 'n/a'
  const round = (value: number): string => `${(value / 1000).toFixed(1)} s`
  return `median ${round(result.median)} · p95 ${round(result.p95)} · max ${round(result.max)} · n=${result.n}`
}
