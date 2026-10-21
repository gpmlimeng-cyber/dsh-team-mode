import { describe, expect, it } from 'vitest'
import type { AssistantInstance, AssistantSession } from '../src/domain/types.js'
import {
  assistantAvatarSource,
  assistantInitial,
  assistantInstanceForSession,
  assistantInstanceName,
  assistantNameForSession,
  assistantTaskBadge,
  relativeAssistantTime,
  visibleAssistantInstances,
} from '../src/client/assistant-instances.js'

function instance(
  id: string,
  name: string,
  updatedAt: string,
  overrides: Partial<AssistantInstance> = {},
): AssistantInstance {
  return {
    schemaVersion: 1,
    id,
    templateId: `template-${id}`,
    assistantSnapshot: {
      assistantId: `template-${id}`,
      revision: 1,
      name,
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
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  }
}

function task(
  assistantId: string,
  status: AssistantSession['status'],
  id = `${assistantId}-${status}`,
): AssistantSession {
  return {
    schemaVersion: 1,
    id,
    assistantId,
    sessionId: `session-${id}`,
    role: 'task',
    title: `task ${id}`,
    brief: '',
    parentSessionId: `parent-${assistantId}`,
    status,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('assistantTaskBadge', () => {
  it('counts only active tasks that belong to the instance', () => {
    const badge = assistantTaskBadge([
      task('assistant-a', 'queued'),
      task('assistant-a', 'running'),
      task('assistant-a', 'completed'),
      task('assistant-b', 'running'),
    ], instance('assistant-a', 'A', '2026-01-01T00:00:00Z'))
    expect(badge).toEqual({ count: 2, needsInput: false })
  })

  it('prefers the needs_input label over the plain count', () => {
    const badge = assistantTaskBadge([
      task('assistant-a', 'queued'),
      task('assistant-a', 'needs_input'),
      task('assistant-a', 'running'),
    ], instance('assistant-a', 'A', '2026-01-01T00:00:00Z'))
    expect(badge).toEqual({ count: 3, needsInput: true })
  })

  it('ignores terminal tasks and archived instances', () => {
    const terminal = [
      task('assistant-a', 'completed'),
      task('assistant-a', 'failed'),
      task('assistant-a', 'cancelled'),
    ]
    expect(assistantTaskBadge(
      terminal,
      instance('assistant-a', 'A', '2026-01-01T00:00:00Z'),
    )).toBeUndefined()
    expect(assistantTaskBadge(
      [task('assistant-a', 'running')],
      instance('assistant-a', 'A', '2026-01-01T00:00:00Z', { status: 'archived' }),
    )).toBeUndefined()
  })

  it('returns undefined when there are no tasks', () => {
    expect(assistantTaskBadge(
      [],
      instance('assistant-a', 'A', '2026-01-01T00:00:00Z'),
    )).toBeUndefined()
  })
})

describe('visibleAssistantInstances', () => {
  it('hides archived instances while keeping every other status', () => {
    const value = visibleAssistantInstances([
      instance('a', '论文助手', '2026-01-01T00:00:00Z'),
      instance('b', '数据助手', '2026-01-02T00:00:00Z', { status: 'archived' }),
      instance('c', '写作助手', '2026-01-03T00:00:00Z', { status: 'error' }),
    ])
    expect(value.map(item => item.id)).toEqual(['c', 'a'])
  })

  it('matches the search query against the display name without case sensitivity', () => {
    const value = visibleAssistantInstances([
      instance('a', 'Paper Bot', '2026-01-01T00:00:00Z'),
      instance('b', 'Data Bot', '2026-01-02T00:00:00Z'),
    ], '  paper ')
    expect(value.map(item => item.id)).toEqual(['a'])
  })

  it('sorts pinned rows first, then recent activity, then id', () => {
    const value = visibleAssistantInstances([
      instance('a', 'A', '2026-01-01T00:00:00Z'),
      instance('b', 'B', '2026-01-03T00:00:00Z'),
      instance('c', 'C', '2026-01-02T00:00:00Z'),
      instance('p', 'Pinned', '2025-12-01T00:00:00Z', { pinned: true }),
    ])
    expect(value.map(item => item.id)).toEqual(['p', 'b', 'c', 'a'])
  })

  it('does not mutate the input order', () => {
    const values = [
      instance('a', 'A', '2026-01-01T00:00:00Z'),
      instance('b', 'B', '2026-01-02T00:00:00Z'),
    ]
    visibleAssistantInstances(values)
    expect(values.map(item => item.id)).toEqual(['a', 'b'])
  })
})

describe('relativeAssistantTime', () => {
  const now = Date.parse('2026-03-10T12:00:00Z')

  it.each([
    ['2026-03-10T11:59:30Z', '刚刚'],
    ['2026-03-10T11:55:00Z', '5分钟'],
    ['2026-03-10T10:00:00Z', '2小时'],
    ['2026-03-07T12:00:00Z', '3天'],
  ])('renders %s as %s', (iso, label) => {
    expect(relativeAssistantTime(iso, now)).toBe(label)
  })

  it('falls back to a month/day label beyond a week', () => {
    expect(relativeAssistantTime('2026-02-01T12:00:00Z', now)).toBe('2月1日')
  })

  it('returns an empty label for an unparsable timestamp', () => {
    expect(relativeAssistantTime('not-a-date', now)).toBe('')
  })
})

describe('assistant display identity', () => {
  it('falls back to a placeholder when the snapshot name is blank', () => {
    expect(assistantInstanceName(instance('a', '   ', '2026-01-01T00:00:00Z'))).toBe('助手')
  })

  it('uses the first upper-cased character for the avatar fallback', () => {
    expect(assistantInitial('data bot')).toBe('D')
    expect(assistantInitial('  ')).toBe('?')
  })

  it('renders only data URLs as avatars', () => {
    const dataUrl = 'data:image/png;base64,AAAA'
    expect(assistantAvatarSource(instance('a', 'A', '2026-01-01T00:00:00Z', {
      assistantSnapshot: {
        ...instance('a', 'A', '2026-01-01T00:00:00Z').assistantSnapshot,
        avatar: dataUrl,
      },
    }))).toBe(dataUrl)
    expect(assistantAvatarSource(instance('b', 'B', '2026-01-01T00:00:00Z', {
      assistantSnapshot: {
        ...instance('b', 'B', '2026-01-01T00:00:00Z').assistantSnapshot,
        avatar: 'https://example.test/avatar.png',
      },
    }))).toBeUndefined()
  })
})

describe('assistantNameForSession', () => {
  it('returns the Assistant name for its bound main Session', () => {
    const value = [
      instance('a', '论文助手', '2026-01-01T00:00:00Z', { mainSessionId: 'session-a' }),
      instance('b', '数据助手', '2026-01-02T00:00:00Z', { mainSessionId: 'session-b' }),
    ]
    expect(assistantNameForSession(value, 'session-b')).toBe('数据助手')
  })

  it('returns undefined for another Session, a missing id, or an empty id', () => {
    const value = [instance('a', '论文助手', '2026-01-01T00:00:00Z', { mainSessionId: 'session-a' })]
    expect(assistantNameForSession(value, 'session-other')).toBeUndefined()
    expect(assistantNameForSession(value, undefined)).toBeUndefined()
    expect(assistantNameForSession(value, '')).toBeUndefined()
  })

  it('does not title an archived Assistant', () => {
    const value = [
      instance('a', '论文助手', '2026-01-01T00:00:00Z', {
        mainSessionId: 'session-a',
        status: 'archived',
      }),
    ]
    expect(assistantInstanceForSession(value, 'session-a')).toBeUndefined()
    expect(assistantNameForSession(value, 'session-a')).toBeUndefined()
  })

  it('uses the sidebar fallback for a blank stored name', () => {
    const value = [
      instance('a', '   ', '2026-01-01T00:00:00Z', { mainSessionId: 'session-a' }),
    ]
    expect(assistantNameForSession(value, 'session-a')).toBe('助手')
  })
})
