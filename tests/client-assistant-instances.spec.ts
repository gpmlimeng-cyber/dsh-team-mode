import { describe, expect, it } from 'vitest'
import type { AssistantInstance, AssistantSession } from '../src/domain/types.js'
import type { AssistantInstanceView } from '../src/transport/contracts.js'
import { assistantInstanceStatusLabel } from '../src/client/labels.js'
import {
  ASSISTANT_AVATAR_MAX_DATA_URL_LENGTH,
  ASSISTANT_AVATAR_MAX_FILE_BYTES,
  assistantAvatarDataUrlError,
  assistantAvatarFileError,
  assistantAvatarSource,
  assistantInitial,
  assistantInstanceForSession,
  assistantInstanceName,
  assistantNameForSession,
  assistantRowActivity,
  assistantRowState,
  assistantRowStatusText,
  assistantRowStatusTitle,
  assistantSidebarSummary,
  assistantTaskStatusLabel,
  assistantTasksFor,
  assistantThreadTasks,
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
  overrides: Partial<AssistantSession> = {},
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
    ...overrides,
  }
}

describe('assistantRowActivity', () => {
  const idle = instance('assistant-a', 'A', '2026-01-01T00:00:00Z')

  it('prefers needs_input and counts only blockers', () => {
    expect(assistantRowActivity([
      task('assistant-a', 'queued'),
      task('assistant-a', 'needs_input'),
      task('assistant-a', 'needs_input', 'assistant-a-needs-2'),
      task('assistant-a', 'running'),
    ], idle)).toEqual({ status: 'needs_input', count: 2, instanceStatus: 'idle' })
  })

  it('reports running when no task needs input', () => {
    expect(assistantRowActivity([
      task('assistant-a', 'queued'),
      task('assistant-a', 'running'),
      task('assistant-a', 'running', 'assistant-a-running-2'),
      task('assistant-b', 'needs_input'),
    ], idle)).toEqual({ status: 'running', count: 2, instanceStatus: 'idle' })
  })

  it('reports queued only when nothing is running', () => {
    expect(assistantRowActivity([
      task('assistant-a', 'queued'),
      task('assistant-a', 'queued', 'assistant-a-queued-2'),
      task('assistant-a', 'completed'),
    ], idle)).toEqual({ status: 'queued', count: 2, instanceStatus: 'idle' })
  })

  it('ignores terminal tasks and other assistants', () => {
    expect(assistantRowActivity([
      task('assistant-a', 'completed'),
      task('assistant-a', 'failed'),
      task('assistant-a', 'cancelled'),
      task('assistant-b', 'running'),
    ], idle)).toEqual({ status: 'none', count: 0, instanceStatus: 'idle' })
  })

  it('reads an archived instance as idle even with stale active rows', () => {
    expect(assistantRowActivity(
      [task('assistant-a', 'needs_input')],
      instance('assistant-a', 'A', '2026-01-01T00:00:00Z', { status: 'archived' }),
    )).toEqual({ status: 'none', count: 0, instanceStatus: 'archived' })
  })

  it('returns none for an empty task list', () => {
    expect(assistantRowActivity([], idle)).toEqual({ status: 'none', count: 0, instanceStatus: 'idle' })
  })
})

describe('assistantRowState', () => {
  const iso = '2026-01-01T00:00:00Z'

  it('reads a failed instance as 异常 instead of 空闲', () => {
    const activity = assistantRowActivity([], instance('assistant-a', 'A', iso, { status: 'error' }))

    expect(assistantRowState(activity)).toBe('error')
    expect(assistantRowStatusText(activity)).toBe('异常')
    expect(assistantRowStatusTitle(activity)).toBe('异常')
  })

  it('keeps 异常 on top of stale task activity', () => {
    const activity = assistantRowActivity(
      [task('assistant-a', 'running')],
      instance('assistant-a', 'A', iso, { status: 'error' }),
    )

    expect(activity.status).toBe('running')
    expect(assistantRowState(activity)).toBe('error')
    expect(assistantRowStatusText(activity)).toBe('异常')
    expect(assistantRowStatusTitle(activity)).toBe('异常 · 1 个任务未结束')
  })

  it('never reads a waking instance as idle', () => {
    const activity = assistantRowActivity([], instance('assistant-a', 'A', iso, { status: 'starting' }))

    expect(assistantRowState(activity)).toBe('starting')
    expect(assistantRowStatusText(activity)).toBe('唤醒中')
    expect(assistantRowStatusTitle(activity)).toBe('唤醒中')
  })

  it('takes every instance word from the shared labels', () => {
    expect(assistantRowStatusText({ status: 'none', count: 0, instanceStatus: 'error' }))
      .toBe(assistantInstanceStatusLabel('error'))
    expect(assistantRowStatusText({ status: 'none', count: 0, instanceStatus: 'starting' }))
      .toBe(assistantInstanceStatusLabel('starting'))
    expect(assistantRowStatusText({ status: 'none', count: 0, instanceStatus: 'idle' }))
      .toBe(assistantInstanceStatusLabel('idle'))
    expect(assistantRowStatusText({ status: 'none', count: 0 })).toBe('空闲')
  })

  it('keeps task-only states independent of the instance status', () => {
    expect(assistantRowState({ status: 'needs_input', count: 2, instanceStatus: 'active' })).toBe('needs_input')
    expect(assistantRowState({ status: 'queued', count: 1, instanceStatus: 'idle' })).toBe('queued')
    expect(assistantRowState({ status: 'none', count: 0, instanceStatus: 'active' })).toBe('none')
  })
})

describe('assistantSidebarSummary', () => {
  const iso = '2026-01-01T00:00:00Z'

  it('counts every listed assistant once and skips archived ones', () => {
    const instances: AssistantInstanceView[] = [
      {
        ...instance('a', 'A', iso),
        preview: { role: 'assistant', text: '结果', time: 200 },
      },
      instance('b', 'B', iso),
      instance('c', 'C', iso, { status: 'archived' }),
    ]
    const tasks = [
      task('a', 'needs_input'),
      task('b', 'running'),
      task('b', 'queued', 'b-queued'),
      task('c', 'needs_input'),
    ]

    expect(assistantSidebarSummary(instances, tasks, { a: 100 }))
      .toEqual({ waiting: 1, working: 1, queued: 0, unread: 1 })
  })

  it('reads unread from the read markers only', () => {
    const instances: AssistantInstanceView[] = [{
      ...instance('a', 'A', iso),
      preview: { role: 'assistant', text: '结果', time: 200 },
    }]

    // A missing marker is read-at-preview; only an older marker means unread.
    expect(assistantSidebarSummary(instances, [], {}).unread).toBe(0)
    expect(assistantSidebarSummary(instances, [], { a: 100 }).unread).toBe(1)
    expect(assistantSidebarSummary(instances, [], { a: 200 }).unread).toBe(0)
  })
})

describe('assistantRow status labels', () => {
  it('renders a compact second-line preview for every status', () => {
    expect(assistantRowStatusText({ status: 'needs_input', count: 2 })).toBe('待你处理')
    expect(assistantRowStatusText({ status: 'running', count: 2 })).toBe('思考中')
    expect(assistantRowStatusText({ status: 'queued', count: 3 })).toBe('排队中')
    expect(assistantRowStatusText({ status: 'none', count: 0 })).toBe('空闲')
  })

  it('spells out the pending count for the status dot title', () => {
    expect(assistantRowStatusTitle({ status: 'needs_input', count: 2 })).toBe('2 个任务待你处理')
    expect(assistantRowStatusTitle({ status: 'running', count: 2 })).toBe('2 个任务正在思考')
    expect(assistantRowStatusTitle({ status: 'queued', count: 1 })).toBe('1 个任务排队中')
    expect(assistantRowStatusTitle({ status: 'none', count: 0 })).toBe('空闲')
  })
})

describe('assistantTaskStatusLabel', () => {
  it.each([
    ['queued', '排队中'],
    ['running', '运行中'],
    ['needs_input', '待你处理'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
  ] as const)('labels %s as %s', (status, label) => {
    expect(assistantTaskStatusLabel(status)).toBe(label)
  })
})

describe('assistantTasksFor', () => {
  it('keeps only one assistant and orders newest first', () => {
    const older = task('assistant-a', 'completed', 'a-old', { updatedAt: '2026-01-01T00:00:00Z' })
    const newer = task('assistant-a', 'running', 'a-new', { updatedAt: '2026-03-01T00:00:00Z' })
    const other = task('assistant-b', 'running', 'b-new', { updatedAt: '2026-04-01T00:00:00Z' })
    const values = [older, other, newer]
    expect(assistantTasksFor(values, 'assistant-a').map(item => item.id)).toEqual(['a-new', 'a-old'])
    expect(values.map(item => item.id)).toEqual(['a-old', 'b-new', 'a-new'])
  })

  it('returns an empty list for an unknown assistant', () => {
    expect(assistantTasksFor([task('assistant-a', 'running')], 'assistant-b')).toEqual([])
  })
})

describe('assistantThreadTasks', () => {
  it('orders thread rows newest first and never repeats the main session', () => {
    const owner = instance('assistant-a', 'A', '2026-01-01T00:00:00Z', {
      mainSessionId: 'session-main',
    })
    const older = task('assistant-a', 'completed', 'a-old', {
      sessionId: 'session-old',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    const newer = task('assistant-a', 'running', 'a-new', {
      sessionId: 'session-new',
      updatedAt: '2026-03-01T00:00:00Z',
    })
    const staleMain = task('assistant-a', 'running', 'a-main', {
      sessionId: 'session-main',
      updatedAt: '2026-04-01T00:00:00Z',
    })
    expect(assistantThreadTasks([older, staleMain, newer], owner).map(item => item.id))
      .toEqual(['a-new', 'a-old'])
  })

  it('keeps tasks while the assistant has no main session yet', () => {
    const owner = instance('assistant-a', 'A', '2026-01-01T00:00:00Z')
    const value = task('assistant-a', 'needs_input')
    expect(assistantThreadTasks([value], owner).map(item => item.id)).toEqual([value.id])
  })

  it('ignores tasks belonging to another assistant', () => {
    const owner = instance('assistant-a', 'A', '2026-01-01T00:00:00Z', {
      mainSessionId: 'session-main',
    })
    expect(assistantThreadTasks([task('assistant-b', 'running')], owner)).toEqual([])
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

describe('assistant avatar validation', () => {
  it('accepts a small inline image data URL and the clear-avatar value', () => {
    expect(assistantAvatarDataUrlError('data:image/png;base64,AAAA')).toBeUndefined()
    expect(assistantAvatarDataUrlError('')).toBeUndefined()
  })

  it('rejects non-image and oversized data URLs', () => {
    expect(assistantAvatarDataUrlError('https://example.test/avatar.png')).toBe('头像必须是内嵌图片')
    expect(assistantAvatarDataUrlError('data:text/html;base64,AAAA')).toBe('头像必须是内嵌图片')
    expect(assistantAvatarDataUrlError(
      `data:image/png;base64,${'A'.repeat(ASSISTANT_AVATAR_MAX_DATA_URL_LENGTH)}`,
    )).toBe('头像图片过大')
  })

  it('validates the local file type and size before reading it', () => {
    expect(assistantAvatarFileError({ type: 'image/png', size: 1024 })).toBeUndefined()
    expect(assistantAvatarFileError({ type: 'image/webp', size: ASSISTANT_AVATAR_MAX_FILE_BYTES })).toBeUndefined()
    expect(assistantAvatarFileError({ type: 'text/plain', size: 1024 })).toBe('请选择 PNG、JPEG 或 WebP 图片')
    expect(assistantAvatarFileError({ type: 'image/gif', size: 1024 })).toBe('请选择 PNG、JPEG 或 WebP 图片')
    expect(assistantAvatarFileError({ type: 'image/png', size: ASSISTANT_AVATAR_MAX_FILE_BYTES + 1 }))
      .toBe('头像图片不能超过 256KB')
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
    expect(assistantAvatarSource(instance('c', 'C', '2026-01-01T00:00:00Z', {
      assistantSnapshot: {
        ...instance('c', 'C', '2026-01-01T00:00:00Z').assistantSnapshot,
        avatar: 'data:text/html;base64,AAAA',
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
