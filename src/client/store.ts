import { useSyncExternalStore } from 'react'
import { callAgentTeam } from './api.js'
import {
  assistantMainSessionTitle,
  shouldPinAssistantMainSession,
} from './assistant-instances.js'
import type { AssistantInstance } from '../domain/types.js'
import type { SurfaceMode } from './surface-mode.js'

export type TeamDialog =
  | { kind: 'create' }
  | { kind: 'manage'; teamId: string }

export interface AgentTeamUiState {
  visible: boolean
  createTeamRequest: number
  /** Right-side Leader panel; UI-only, never persisted as business data. */
  panelOpen: boolean
  selectedTeamId?: string | undefined
  selectedAssistantId?: string | undefined
  dialog?: TeamDialog | undefined
  /** Last failed team/member row navigation; a click never fails silently. */
  navigationError?: string | undefined
}

let state: AgentTeamUiState = {
  visible: false,
  createTeamRequest: 0,
  panelOpen: false,
}
const listeners = new Set<() => void>()

export function openTeams(): void {
  update({ visible: true, createTeamRequest: 0, panelOpen: state.panelOpen })
}

export function openTeam(teamId: string): void {
  update({ visible: true, createTeamRequest: 0, panelOpen: state.panelOpen, selectedTeamId: teamId })
}

export function openTeamCreator(): void {
  update({
    visible: true,
    createTeamRequest: state.createTeamRequest + 1,
    panelOpen: state.panelOpen,
  })
}

export function closeAgentTeam(): void {
  update({ visible: false, createTeamRequest: 0, panelOpen: state.panelOpen })
}

/** Open or close the Leader side panel; navigation is never part of this write. */
export function setTeamPanelOpen(open: boolean): void {
  update({ ...state, panelOpen: open })
}

export function toggleTeamPanel(): void {
  update({ ...state, panelOpen: !state.panelOpen })
}

/** Close only: the active Session and its conversation stay untouched. */
export function closeTeamPanel(): void {
  setTeamPanelOpen(false)
}

/** Only an active team Session in team surface mode earns the header toggle. */
export function panelToggleAvailable(teamSession: boolean, mode: SurfaceMode): boolean {
  return teamSession && mode === 'team'
}

export function selectTeam(teamId: string): void {
  update({ ...state, selectedTeamId: teamId, selectedAssistantId: undefined })
}

export function selectAssistant(assistantId: string): void {
  update({ ...state, selectedTeamId: undefined, selectedAssistantId: assistantId })
}

export function openCreateTeamDialog(): void {
  update({ ...state, dialog: { kind: 'create' } })
}

export function openManageTeamDialog(teamId: string): void {
  update({ ...state, selectedTeamId: teamId, dialog: { kind: 'manage', teamId } })
}

export function closeTeamDialog(): void {
  update({ ...state, dialog: undefined })
}

/** Report or clear the team/member row navigation failure shown in the sidebar. */
export function reportNavigationError(message: string | undefined): void {
  if (state.navigationError === message) return
  update({ ...state, navigationError: message })
}

export function useAgentTeamUi(): AgentTeamUiState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Read the panel switch; its server snapshot is the live value so SSR tests can observe it. */
export function useTeamPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, panelSnapshot, panelSnapshot)
}

function getSnapshot(): AgentTeamUiState {
  return state
}

function getServerSnapshot(): AgentTeamUiState {
  return { visible: false, createTeamRequest: 0, panelOpen: state.panelOpen }
}

function panelSnapshot(): boolean {
  return state.panelOpen
}

function update(next: AgentTeamUiState): void {
  if (
    state.visible === next.visible
    && state.createTeamRequest === next.createTeamRequest
    && state.panelOpen === next.panelOpen
    && state.selectedTeamId === next.selectedTeamId
    && state.selectedAssistantId === next.selectedAssistantId
    && state.dialog === next.dialog
    && state.navigationError === next.navigationError
  ) return
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Navigation bridge for surfaces the plugin does not own the Context in.
 *
 * The right Sidebar's tab body is mounted by the host frame and carries no
 * `uiWorkspace`; the sidebar host installs the controller's opener here so a
 * detail-panel row can open a Session through exactly the same call the 单聊 row
 * uses (including its catalog refresh and error reporting).
 */
let sessionOpener: ((sessionId: string) => void) | undefined

export function installAssistantSessionOpener(opener: (sessionId: string) => void): void {
  sessionOpener = opener
}

/** Open one Assistant Session; false until the sidebar host installs its opener. */
export function openAssistantSession(sessionId: string): boolean {
  if (sessionOpener === undefined) return false
  sessionOpener(sessionId)
  return true
}

/** One host Session operation the relationship needs; the client entry owns the service. */
export interface AssistantSessionOps {
  /** The Session's current host title, from the Host Session list when known. */
  title(sessionId: string): string | undefined
  /** Rename through the native session-title path; resolves with the accepted title. */
  rename(sessionId: string, title: string): Promise<string>
  /**
   * Run one native slash command in that Session and report the host verdict.
   * A refusal is `ok: false` plus the host message; `matched: false` means the
   * deployment offers no such command.
   */
  command(
    sessionId: string,
    line: string,
  ): Promise<{ ok: boolean; matched: boolean; message?: string | undefined }>
}

let sessionOps: AssistantSessionOps | undefined

/**
 * Point the relationship flow at the Host's client Session service. Called once
 * by the client entry, which is the only owner of `ctx.sessions`; passing
 * `undefined` detaches it (server render and tests).
 */
export function installAssistantSessionOps(ops: AssistantSessionOps | undefined): void {
  sessionOps = ops
}

export function assistantSessionOps(): AssistantSessionOps | undefined {
  return sessionOps
}

export interface AssistantMainSession {
  instance: AssistantInstance
  sessionId: string
  /** Non-fatal naming problem; the Session is still usable. */
  notice?: string | undefined
}

/**
 * Materialize (or resume) the one canonical chat for a coworker, name it after
 * the assistant, and mark the relationship with the plugin's pinned state.
 *
 * `options.bound` is the caller's pre-ensure fact: a first bind is the only one
 * that writes the plugin pin. Renaming compares the current host title first, so
 * opening the same assistant repeatedly appends no title events. Naming failure
 * never blocks the open — it travels back as `notice`.
 */
export async function ensureAssistantMainSession(
  assistantId: string,
  options?: { bound?: boolean | undefined },
): Promise<AssistantMainSession> {
  const result = await callAgentTeam('assistant.instance.ensure', { id: assistantId })
  const notice = await markAssistantMainSession(
    result.instance,
    result.sessionId,
    options?.bound === true,
  )
  return notice === undefined
    ? { instance: result.instance, sessionId: result.sessionId }
    : { instance: result.instance, sessionId: result.sessionId, notice }
}

/**
 * The one door every coworker row uses: ensure the canonical main Session, then
 * hand navigation to the host opener. A raw stored session id is never opened.
 */
export async function openAssistantMainSession(
  assistantId: string,
  open: (sessionId: string) => void,
  options?: { bound?: boolean | undefined },
): Promise<AssistantMainSession> {
  const session = await ensureAssistantMainSession(assistantId, options)
  open(session.sessionId)
  return session
}

async function markAssistantMainSession(
  instance: AssistantInstance,
  sessionId: string,
  wasBound: boolean,
): Promise<string | undefined> {
  // Plugin mark, not the host's session pin: the main row is hidden from the
  // native sidebar, so a host pin would be invisible state on a hidden row.
  if (shouldPinAssistantMainSession(instance, wasBound)) {
    try {
      await callAgentTeam('assistant.instance.update', {
        id: instance.id,
        value: { pinned: true },
      })
    } catch {
      // The row marker is decoration; opening the relationship must still work.
    }
  }
  const ops = sessionOps
  if (ops === undefined) return undefined
  const title = assistantMainSessionTitle(instance, ops.title(sessionId))
  if (title === undefined) return undefined
  try {
    await ops.rename(sessionId, title)
    return undefined
  } catch (cause) {
    return `主会话命名失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
}
