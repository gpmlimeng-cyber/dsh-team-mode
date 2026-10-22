import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AssistantInstance, AssistantSession, CreateAssistantInstanceInput, UpdateAssistantInstanceInput } from '../src/domain/types.js'
import type { AssistantInstanceView, TeamView } from '../src/transport/contracts.js'
import {
  AGENT_TEAM_METHODS,
  type AgentTeamPayload,
  type AgentTeamResult,
  type PageView,
  type WorkspaceEntryView,
  type WorkspaceGitDiffView,
} from '../src/transport/contracts.js'

describe('Agent Team transport contracts', () => {
  it('keeps API method names unique', () => {
    expect(new Set(AGENT_TEAM_METHODS).size).toBe(AGENT_TEAM_METHODS.length)
  })

  it('associates Workspace methods with their payload and result types', () => {
    expectTypeOf<AgentTeamPayload<'team.workspace.diff'>>().toEqualTypeOf<{
      teamId: string
      path: string
      scope: 'staged' | 'unstaged'
      layout: 'unified' | 'split'
      theme: 'light' | 'dark'
    }>()
    expectTypeOf<AgentTeamResult<'team.workspace.diff'>>().toEqualTypeOf<WorkspaceGitDiffView>()
    expectTypeOf<AgentTeamResult<'team.workspace.list'>>().toEqualTypeOf<WorkspaceEntryView[]>()
  })

  it('associates Assistant instance methods with their payload and result types', () => {
    expectTypeOf<AgentTeamPayload<'assistant.instance.list'>>().toEqualTypeOf<undefined>()
    expectTypeOf<AgentTeamResult<'assistant.instance.list'>>().toEqualTypeOf<PageView<AssistantInstanceView>>()
    expectTypeOf<AgentTeamPayload<'assistant.instance.create'>>()
      .toEqualTypeOf<CreateAssistantInstanceInput>()
    expectTypeOf<AgentTeamResult<'assistant.instance.create'>>().toEqualTypeOf<AssistantInstance>()
    expectTypeOf<AgentTeamPayload<'assistant.instance.update'>>().toEqualTypeOf<{
      id: string
      value: UpdateAssistantInstanceInput
    }>()
    expectTypeOf<AgentTeamResult<'assistant.instance.update'>>().toEqualTypeOf<AssistantInstance>()
    expectTypeOf<AgentTeamPayload<'assistant.instance.archive'>>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<AgentTeamResult<'assistant.instance.archive'>>().toEqualTypeOf<AssistantInstance>()
    expectTypeOf<AgentTeamPayload<'assistant.instance.ensure'>>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<AgentTeamResult<'assistant.instance.ensure'>>().toEqualTypeOf<{
      instance: AssistantInstance
      sessionId: string
    }>()
    expectTypeOf<AgentTeamPayload<'assistant.task.open'>>().toEqualTypeOf<{ taskId: string }>()
    expectTypeOf<AgentTeamResult<'assistant.task.open'>>().toEqualTypeOf<{
      task: AssistantSession
      sessionId: string
    }>()
  })

  it('maps the explicit member assistant-instance update method', () => {
    expect(AGENT_TEAM_METHODS).toContain('team.member.setAssistantInstance')
    expectTypeOf<AgentTeamPayload<'team.member.setAssistantInstance'>>().toEqualTypeOf<{
      teamId: string
      slotId: string
      assistantInstanceId: string | null
    }>()
    expectTypeOf<AgentTeamResult<'team.member.setAssistantInstance'>>().toEqualTypeOf<TeamView>()
  })
})
