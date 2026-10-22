import { useSyncExternalStore } from 'react'

export type TeamDialog =
  | { kind: 'create' }
  | { kind: 'manage'; teamId: string }

export interface AgentTeamUiState {
  visible: boolean
  createTeamRequest: number
  selectedTeamId?: string | undefined
  selectedAssistantId?: string | undefined
  dialog?: TeamDialog | undefined
}

let state: AgentTeamUiState = {
  visible: false,
  createTeamRequest: 0,
}
const listeners = new Set<() => void>()

export function openTeams(): void {
  update({ visible: true, createTeamRequest: 0 })
}

export function openTeam(teamId: string): void {
  update({ visible: true, createTeamRequest: 0, selectedTeamId: teamId })
}

export function openTeamCreator(): void {
  update({ visible: true, createTeamRequest: state.createTeamRequest + 1 })
}

export function closeAgentTeam(): void {
  update({ visible: false, createTeamRequest: 0 })
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

export function useAgentTeamUi(): AgentTeamUiState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

function getSnapshot(): AgentTeamUiState {
  return state
}

function getServerSnapshot(): AgentTeamUiState {
  return { visible: false, createTeamRequest: 0 }
}

function update(next: AgentTeamUiState): void {
  if (
    state.visible === next.visible
    && state.createTeamRequest === next.createTeamRequest
    && state.selectedTeamId === next.selectedTeamId
    && state.selectedAssistantId === next.selectedAssistantId
    && state.dialog === next.dialog
  ) return
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
