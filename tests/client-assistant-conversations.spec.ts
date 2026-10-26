import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantInstance } from '../src/domain/types.js'

// The shipped primitives package expects browser peers this node test does not
// install; the Menu stub renders its anchor so row markup stays assertable.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (props: { children?: unknown }): unknown =>
    createElement('div', null, props?.children as never)
  const Menu = (props: { anchor?: unknown; children?: unknown }): unknown =>
    createElement('div', null, props?.anchor as never, props?.children as never)
  return {
    Menu,
    Tooltip: Stub,
    IconArchiveOutlineRegular: Stub,
    IconEllipsisOutlineRegular: Stub,
  }
})

const {
  AssistantConversationList,
  assistantConversationExpanded,
  assistantConversationRows,
} = await import('../src/client/assistant-conversations.js')

afterEach(() => {
  vi.unstubAllGlobals()
})

function instance(overrides: Partial<AssistantInstance> = {}): AssistantInstance {
  return {
    schemaVersion: 1,
    id: 'instance-1',
    templateId: 'template-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: 'Paper Bot',
      instructions: '',
      provider: 'deepseek',
      model: 'deepseek-chat',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/workspace-1',
    status: 'idle',
    pinned: false,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mainSessionId: 'session-main',
    ...overrides,
  }
}

function renderRows(rows = assistantConversationRows(instance({
  threadSessionIds: ['session-thread-1', 'session-thread-2'],
}))): string {
  return renderToStaticMarkup(createElement(AssistantConversationList, {
    name: 'Paper Bot',
    rows,
    onOpen: () => {},
    onArchive: () => {},
  }))
}

describe('assistantConversationRows', () => {
  it('leads with the main Session and numbers the threads in stored order', () => {
    const rows = assistantConversationRows(instance({
      threadSessionIds: ['session-thread-1', 'session-thread-2'],
    }))

    expect(rows.map(row => row.sessionId))
      .toEqual(['session-main', 'session-thread-1', 'session-thread-2'])
    expect(rows[0]).toMatchObject({ main: true, title: '主会话', role: '主' })
    expect(rows.slice(1)).toEqual([
      { sessionId: 'session-thread-1', main: false, title: '附加会话 1', subtitle: '附加会话' },
      { sessionId: 'session-thread-2', main: false, title: '附加会话 2', subtitle: '附加会话' },
    ])
  })

  it('never invents a main row for an instance that has not bound one', () => {
    const rows = assistantConversationRows({ threadSessionIds: ['session-thread-1'] })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: 'session-thread-1', main: false })
    expect(assistantConversationRows({})).toEqual([])
  })
})

describe('assistantConversationExpanded', () => {
  it('defaults collapsed, then follows storage per assistant', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => 'true' } })
    expect(assistantConversationExpanded('instance-1', {})).toBe(true)
    expect(assistantConversationExpanded('instance-2', { 'instance-2': false })).toBe(false)
  })

  it('lets this session toggle win over the stored value', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => 'false' } })

    expect(assistantConversationExpanded('instance-1', { 'instance-1': true })).toBe(true)
  })
})

describe('AssistantConversationList', () => {
  it('renders the main Session with the roster role slot and no thread menu', () => {
    const markup = renderRows()

    expect(markup).toContain('data-dsh-assistant-conversation-main')
    expect(markup).toContain('>主<')
    expect(markup).not.toContain('会话操作 主会话')
  })

  it('offers the row menu on thread conversations only', () => {
    const markup = renderRows()

    expect(markup).toContain('会话操作 附加会话 1')
    expect(markup).toContain('会话操作 附加会话 2')
    // Two menus for two threads; the main Session contributes none.
    expect(markup.match(/data-dsh-assistant-conversation-menu/g)).toHaveLength(2)
  })
})
