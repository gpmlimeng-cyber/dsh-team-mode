import { describe, expect, it } from 'vitest'
import {
  assistantOverviewLimits,
  assistantOverviewTodos,
  assistantOverviewWho,
} from '../src/client/assistant-overview.js'
import type { AssistantInstanceView } from '../src/transport/contracts.js'

const ISO = '2026-01-01T00:00:00Z'

function instance(overrides: {
  instructions?: string
  skills?: string[]
  mcp?: string[]
} = {}): AssistantInstanceView {
  return {
    schemaVersion: 1,
    id: 'assistant-1',
    templateId: 'template-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: '小码',
      instructions: overrides.instructions ?? '',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: overrides.skills ?? [],
      mcpServers: overrides.mcp ?? [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/workspace-1',
    status: 'idle',
    pinned: false,
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
  }
}

const LABELS = {
  template: '工程师（template-1）',
  workspace: 'DSH-Team Mode',
  permission: '完全权限',
}

describe('assistantOverviewTodos', () => {
  it('lists all five gaps in the order the panel fixes them', () => {
    const todos = assistantOverviewTodos(instance(), { automations: 0, memory: 0 })

    expect(todos.map(todo => todo.id)).toEqual([
      'instructions',
      'skills',
      'mcp',
      'automations',
      'memory',
    ])
    expect(todos.map(todo => todo.text)).toEqual([
      '写一段描述，让它知道自己是干什么的',
      '还没有授予任何技能',
      '还没有可用的 MCP 工具',
      '没有自动化任务，它不会自己定时干活',
      '还没有记忆，它不会记住上次的结论',
    ])
    expect(todos.map(todo => todo.target)).toEqual([
      'identity',
      'capabilities',
      'capabilities',
      'automations',
      'memory',
    ])
  })

  it('returns nothing once every gap is filled, so the block is not rendered', () => {
    const complete = instance({ instructions: '写代码', skills: ['research'], mcp: ['files'] })
    expect(assistantOverviewTodos(complete, { automations: 2, memory: 3 })).toEqual([])
    // The description alone still leaves the capability gaps.
    expect(assistantOverviewTodos(instance({ instructions: '写代码' }), { automations: 1, memory: 1 }))
      .toHaveLength(2)
  })

  it('does not turn an unread count into a missing item', () => {
    // `undefined` means "not read / unavailable", never "none".
    expect(assistantOverviewTodos(instance()).map(todo => todo.id)).toEqual([
      'instructions',
      'skills',
      'mcp',
    ])
    expect(assistantOverviewTodos(instance(), { automations: 1 }).map(todo => todo.id))
      .not.toContain('automations')
    expect(assistantOverviewTodos(instance(), { memory: 1 }).map(todo => todo.id))
      .not.toContain('memory')
  })
})

describe('assistantOverviewWho', () => {
  it('carries the name, the trimmed description and the three kept fields', () => {
    expect(assistantOverviewWho(instance({ instructions: '  维护前端\n并做评审  ' }), LABELS)).toEqual({
      name: '小码',
      description: '维护前端\n并做评审',
      meta: [
        '模板：工程师（template-1）',
        'Workspace：DSH-Team Mode',
        '权限：完全权限',
      ],
    })
  })

  it('reports an empty description instead of inventing one', () => {
    const who = assistantOverviewWho(instance({ instructions: '   ' }), LABELS)
    expect(who.description).toBe('')
    expect(who.meta).toHaveLength(3)
  })
})

describe('assistantOverviewLimits', () => {
  it('generates 能做到 from real fields and leaves 不会做 empty when nothing is missing', () => {
    const limits = assistantOverviewLimits(
      instance({ skills: ['research', 'plan', 'review'], mcp: ['files', 'search'] }),
      { automations: 2, memory: 3, ...LABELS },
    )

    expect(limits.capable).toEqual([
      '可以使用 3 个技能（research、plan、review）',
      '可以调用 2 个 MCP 工具',
      '运行在「DSH-Team Mode」工作区，权限：完全权限',
    ])
    expect(limits.unable).toEqual([])
  })

  it('只列真实缺失项: a configured capability never shows up under 不会做', () => {
    const withAutomations = assistantOverviewLimits(instance(), { automations: 1, memory: 0, ...LABELS })
    expect(withAutomations.unable).toEqual(['没有记忆，不会保留上次的结论'])
    expect(withAutomations.unable.join('')).not.toContain('定时')

    const withMemory = assistantOverviewLimits(instance(), { automations: 0, memory: 2, ...LABELS })
    expect(withMemory.unable).toEqual(['没有自动化任务，不会自己按时执行'])
    expect(withMemory.unable.join('')).not.toContain('记住')

    // Neither count read: no negative claim at all.
    expect(assistantOverviewLimits(instance(), { ...LABELS }).unable).toEqual([])
  })

  it('has no capability sentence at all when nothing was granted', () => {
    const limits = assistantOverviewLimits(instance(), {
      automations: 0,
      memory: 0,
      ...LABELS,
      workspace: '',
    })
    expect(limits.capable).toEqual([])
    expect(limits.unable).toEqual([
      '没有自动化任务，不会自己按时执行',
      '没有记忆，不会保留上次的结论',
    ])
  })
})
