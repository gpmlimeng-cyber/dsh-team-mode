import { useSyncExternalStore } from 'react'
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
