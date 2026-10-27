import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AssistantInstance, AssistantSession, AssistantTemplate } from '../src/domain/types.js'
import type { AssistantInstanceView, CatalogView } from '../src/transport/contracts.js'
import { assistantInstanceStatusLabel } from '../src/client/labels.js'
import {
  ASSISTANT_CREATE_SECTIONS,
  ASSISTANT_CREATE_UNSUPPORTED,
  applyStartingRole,
  assistantCreateCanSubmit,
  assistantCreateDefaults,
  assistantCreateGroupOptions,
  assistantCreateIntent,
  assistantCreatePayload,
  assistantCreateValidationError,
  emptyAssistantCreateDraft,
  enabledAssistantRoles,
  type AssistantCreateDraft,
} from '../src/client/assistant-form.js'
import { createAssistantInstanceInputSchema } from '../src/domain/schemas.js'
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
  coordinatorAssistant,
  coordinatorAssistantId,
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

describe('coordinatorAssistant', () => {
  it('picks the row whose coordinator field is true', () => {
    const value = [
      instance('a', '论文助手', '2026-01-01T00:00:00Z'),
      instance('b', '数据助手', '2026-01-02T00:00:00Z', { coordinator: true }),
    ]
    expect(coordinatorAssistant(value)?.id).toBe('b')
    expect(coordinatorAssistantId(value)).toBe('b')
  })

  it('reads a missing field as "no coordinator"', () => {
    const value = [
      instance('a', '论文助手', '2026-01-01T00:00:00Z'),
      instance('b', '数据助手', '2026-01-02T00:00:00Z'),
    ]
    expect(coordinatorAssistant(value)).toBeUndefined()
    expect(coordinatorAssistantId(value)).toBeUndefined()
  })

  it('never infers the role from a name or the shipped chief template', () => {
    // The field is the only source of truth: guessing would resurrect a ghost
    // pinned row whenever no coordinator is set.
    const value = [
      instance('named', '大管家', '2026-01-01T00:00:00Z'),
      instance('chief', 'Chief', '2026-01-02T00:00:00Z', { templateId: 'builtin-chief' }),
    ]
    expect(coordinatorAssistant(value)).toBeUndefined()
    expect(coordinatorAssistantId(value)).toBeUndefined()
  })

  it('pins only the field-marked row out of the 单聊 list', () => {
    const value = [
      instance('named', '大管家', '2026-01-03T00:00:00Z'),
      instance('chief', 'Chief', '2026-01-02T00:00:00Z', { templateId: 'builtin-chief' }),
      instance('coordinator', '总协调', '2026-01-01T00:00:00Z', { coordinator: true }),
    ]
    const coordinatorId = coordinatorAssistantId(value)
    expect(coordinatorId).toBe('coordinator')
    expect(visibleAssistantInstances(value).map(item => item.id).filter(id => id !== coordinatorId))
      .toEqual(['named', 'chief'])
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

const CREATE_NOW = '2026-10-26T00:00:00Z'

function createCatalog(overrides: Partial<CatalogView> = {}): CatalogView {
  return {
    providers: [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'empty', name: 'Empty' }],
    models: {
      deepseek: [{ id: 'flash', name: 'Flash' }, { id: 'pro', name: 'Pro' }],
      empty: [],
    },
    agentPresets: [
      { id: 'broken', name: 'Broken', broken: 'missing dependency' },
      { id: 'standard', name: 'Standard' },
      { id: 'other', name: 'Other' },
    ],
    permissionPresets: [
      { value: 'read-only', name: 'Read only' },
      { value: 'workspace-write', name: 'Workspace write' },
    ],
    workspaces: [
      { id: 'missing', path: '/tmp/missing', title: 'Missing', status: 'missing-dir' },
      { id: 'ws-1', path: '/tmp/ws-1', title: 'Workspace 1', status: 'ok' },
      { id: 'ws-2', path: '/tmp/ws-2', title: 'Workspace 2', status: 'ok' },
    ],
    ...overrides,
  }
}

function createTemplate(overrides: Partial<AssistantTemplate> = {}): AssistantTemplate {
  return {
    schemaVersion: 1,
    id: 'template-1',
    name: '工程师',
    description: '负责实现与验证',
    avatar: 'data:image/png;base64,AAAA',
    instructions: '先读代码，再给最小实现。',
    provider: 'deepseek',
    model: 'flash',
    reasoningEffort: 'high',
    agentPresetId: 'standard',
    permissionPresetId: 'workspace-write',
    skillAllowlist: [],
    mcpServers: [],
    enabled: true,
    teamSelectable: true,
    sortOrder: 0,
    prompts: [],
    source: 'builtin',
    revision: 1,
    createdAt: CREATE_NOW,
    updatedAt: CREATE_NOW,
    ...overrides,
  }
}

function readyDraft(catalog: CatalogView): AssistantCreateDraft {
  return {
    ...assistantCreateDefaults(catalog),
    name: '工程师',
    instructions: '先读代码',
    group: '工作',
  }
}

describe('assistant create sections', () => {
  it('offers exactly the four real sections', () => {
    expect(ASSISTANT_CREATE_SECTIONS.map(section => section.key))
      .toEqual(['identity', 'persona', 'model', 'permissions'])
    expect(ASSISTANT_CREATE_SECTIONS.map(section => section.label))
      .toEqual(['身份', '人设', '模型与环境', '权限'])
  })

  it('explains the remaining unsupported areas instead of rendering tabs for them', () => {
    // Skills and MCP Servers became real instance fields, so they left this list.
    expect(ASSISTANT_CREATE_UNSUPPORTED.map(item => item.key))
      .toEqual(['memory', 'routines', 'access', 'voice'])
    const sectionKeys = new Set<string>(ASSISTANT_CREATE_SECTIONS.map(section => section.key))
    for (const item of ASSISTANT_CREATE_UNSUPPORTED) {
      expect(sectionKeys.has(item.key)).toBe(false)
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.detail.length).toBeGreaterThan(0)
    }
  })
})

describe('assistantCreateDefaults', () => {
  it('takes workspace, permissions, agent preset and model from the catalog', () => {
    const draft = assistantCreateDefaults(createCatalog())
    expect(draft).toEqual({
      ...emptyAssistantCreateDraft(),
      workspaceId: 'ws-1',
      permissionPresetId: 'workspace-write',
      agentPresetId: 'standard',
      provider: 'deepseek',
      model: 'flash',
    })
  })

  it('falls back to the first usable entries when the preferred defaults are absent', () => {
    const draft = assistantCreateDefaults(createCatalog({
      agentPresets: [{ id: 'other', name: 'Other' }],
      permissionPresets: [{ value: 'read-only', name: 'Read only' }],
      workspaces: [{ id: 'ws-2', path: '/tmp/ws-2', title: 'Workspace 2', status: 'ok' }],
    }))
    expect(draft.agentPresetId).toBe('other')
    expect(draft.permissionPresetId).toBe('read-only')
    expect(draft.workspaceId).toBe('ws-2')
  })

  it('leaves a required field empty when the catalog cannot fill it', () => {
    const draft = assistantCreateDefaults(createCatalog({
      agentPresets: [{ id: 'broken', name: 'Broken', broken: 'missing' }],
      permissionPresets: [],
      providers: [],
      models: {},
      workspaces: [{ id: 'missing', path: '/tmp/missing', title: 'Missing', status: 'missing-dir' }],
    }))
    expect(draft.agentPresetId).toBe('')
    expect(draft.permissionPresetId).toBe('')
    expect(draft.provider).toBe('')
    expect(draft.model).toBe('')
    expect(draft.workspaceId).toBe('')
    expect(assistantCreateCanSubmit(draft)).toBe(false)
  })

  it('returns an empty draft while the catalog is still unknown', () => {
    expect(assistantCreateDefaults(undefined)).toEqual(emptyAssistantCreateDraft())
  })
})

describe('applyStartingRole', () => {
  it('fills the real template identity, persona and engine defaults once', () => {
    const catalog = createCatalog()
    const draft = readyDraft(catalog)
    const applied = applyStartingRole(draft, createTemplate(), catalog)
    expect(applied).toEqual({
      ...draft,
      name: '工程师',
      instructions: '先读代码，再给最小实现。',
      avatar: 'data:image/png;base64,AAAA',
      provider: 'deepseek',
      model: 'flash',
      reasoningEffort: 'high',
      agentPresetId: 'standard',
      permissionPresetId: 'workspace-write',
    })
    // Group choice is not a template field: the user's placement survives.
    expect(applied.group).toBe('工作')
  })

  it('carries the template capabilities into the draft, so a role keeps its Skills and MCP', () => {
    const catalog = createCatalog()
    const applied = applyStartingRole(readyDraft(catalog), createTemplate({
      skillAllowlist: ['research', 'review'],
      mcpServers: ['github'],
    }), catalog)
    expect(applied.skillAllowlist).toEqual(['research', 'review'])
    expect(applied.mcpServers).toEqual(['github'])
    // The dialog never sends `templateId`; the payload is the only thing the
    // instance is built from, so the copies have to be real drafts.
    expect(assistantCreatePayload(applied).skillAllowlist).toEqual(['research', 'review'])
  })

  it('never writes an engine value the catalog no longer offers', () => {
    const catalog = createCatalog()
    const draft = { ...readyDraft(catalog), provider: 'deepseek', model: 'pro' }
    const applied = applyStartingRole(draft, createTemplate({
      provider: 'retired',
      model: 'retired-model',
      reasoningEffort: undefined,
      agentPresetId: 'retired-preset',
      permissionPresetId: 'retired-permission',
    }), catalog)
    expect(applied.provider).toBe('deepseek')
    expect(applied.model).toBe('pro')
    expect(applied.reasoningEffort).toBe('')
    expect(applied.agentPresetId).toBe('standard')
    expect(applied.permissionPresetId).toBe('workspace-write')
  })

  it('does not validate engine values when the catalog has not loaded', () => {
    const applied = applyStartingRole(emptyAssistantCreateDraft(), createTemplate(), undefined)
    expect(applied.name).toBe('工程师')
    expect(applied.instructions).toBe('先读代码，再给最小实现。')
    expect(applied.provider).toBe('')
    expect(applied.model).toBe('')
  })

  it('lists only enabled templates as starting roles', () => {
    const enabled = createTemplate()
    const disabled = createTemplate({ id: 'template-2', name: '停用', enabled: false })
    expect(enabledAssistantRoles([enabled, disabled]).map(item => item.id)).toEqual(['template-1'])
  })
})

describe('assistantCreatePayload', () => {
  it('is the direct-create shape and validates against the schema', () => {
    const catalog = createCatalog()
    const draft = {
      ...readyDraft(catalog),
      name: '  工程师  ',
      instructions: '  先读代码  ',
      reasoningEffort: 'high',
      avatar: 'data:image/png;base64,AAAA',
    }
    const payload = assistantCreatePayload(draft)
    expect(payload).toEqual({
      name: '工程师',
      workspaceId: 'ws-1',
      provider: 'deepseek',
      model: 'flash',
      agentPresetId: 'standard',
      permissionPresetId: 'workspace-write',
      instructions: '先读代码',
      avatar: 'data:image/png;base64,AAAA',
      reasoningEffort: 'high',
    })
    expect(createAssistantInstanceInputSchema.safeParse(payload).success).toBe(true)
    expect('templateId' in payload).toBe(false)
    // The group is not part of the create contract; it fails strict parsing.
    expect(createAssistantInstanceInputSchema.safeParse({ ...payload, group: '工作' }).success).toBe(false)
  })

  it('omits empty avatar and reasoning effort but keeps an empty persona', () => {
    const catalog = createCatalog()
    const payload = assistantCreatePayload({
      ...assistantCreateDefaults(catalog),
      name: '助手',
      instructions: '',
    })
    expect(payload).not.toHaveProperty('avatar')
    expect(payload).not.toHaveProperty('reasoningEffort')
    expect(payload.instructions).toBe('')
    expect(createAssistantInstanceInputSchema.safeParse(payload).success).toBe(true)
  })

  it('carries the mascot picked in the create dialog into the payload', () => {
    const catalog = createCatalog()
    const payload = assistantCreatePayload({
      ...readyDraft(catalog),
      mascotSeed: 'seed-7',
      mascotShape: 'pill',
      mascotEyes: 'big',
      mascotColor: '#4E6EF2',
      mascotFill: 'radial',
    })
    expect(payload.mascot).toEqual({
      seed: 'seed-7',
      shape: 'pill',
      eyes: 'big',
      color: '#4E6EF2',
      fill: 'radial',
    })
    // The create contract accepts it: no follow-up update is needed.
    expect(createAssistantInstanceInputSchema.safeParse(payload).success).toBe(true)
    // A flat swatch stores no fill, so the body stays solid.
    const solid = assistantCreatePayload({
      ...readyDraft(catalog),
      mascotSeed: 'seed-7',
      mascotColor: '#4E6EF2',
      mascotFill: 'solid',
    })
    expect(solid.mascot).toEqual({ seed: 'seed-7', color: '#4E6EF2' })
    // No seed means "derive it from the instance id": no mascot field at all.
    const unseeded = assistantCreatePayload({ ...readyDraft(catalog), mascotSeed: '  ' })
    expect(unseeded).not.toHaveProperty('mascot')
  })

  it('carries picked Skills and MCP Servers, and omits both when none are picked', () => {
    const catalog = createCatalog()
    const payload = assistantCreatePayload({
      ...readyDraft(catalog),
      skillAllowlist: ['research'],
      mcpServers: ['github'],
    })
    expect(payload.skillAllowlist).toEqual(['research'])
    expect(payload.mcpServers).toEqual(['github'])
    expect(createAssistantInstanceInputSchema.safeParse(payload).success).toBe(true)

    const bare = assistantCreatePayload(readyDraft(catalog))
    expect(bare).not.toHaveProperty('skillAllowlist')
    expect(bare).not.toHaveProperty('mcpServers')
  })

  it('names the first missing required field', () => {
    const catalog = createCatalog()
    const draft = readyDraft(catalog)
    expect(assistantCreateValidationError({ ...draft, name: '  ' })).toBe('请填写显示名称')
    expect(assistantCreateValidationError({ ...draft, model: '' })).toBe('请选择 Provider 和模型')
    expect(assistantCreateValidationError({ ...draft, workspaceId: '' })).toBe('请选择 Workspace')
    expect(assistantCreateValidationError({ ...draft, permissionPresetId: '' })).toBe('请选择权限预设')
    expect(assistantCreateValidationError({ ...draft, agentPresetId: '' })).toBe('请选择 Agent Preset')
    expect(assistantCreateValidationError(draft)).toBeUndefined()
    expect(assistantCreateCanSubmit(draft)).toBe(true)
  })
})

describe('assistantCreateGroupOptions', () => {
  it('hides the picker when the workspace has no groups', () => {
    expect(assistantCreateGroupOptions([])).toEqual({ visible: false, options: [] })
  })

  it('offers 不分组 first and keeps the Host order', () => {
    expect(assistantCreateGroupOptions(['工作', '学习'])).toEqual({
      visible: true,
      options: [
        { value: '', label: '不分组' },
        { value: '工作', label: '工作' },
        { value: '学习', label: '学习' },
      ],
    })
  })
})

describe('assistantCreateIntent', () => {
  it('creates once, then retries only the ensure step', () => {
    expect(assistantCreateIntent({ createdId: undefined, saving: false })).toBe('create')
    expect(assistantCreateIntent({ createdId: 'assistant-1', saving: false })).toBe('ensure')
    expect(assistantCreateIntent({ createdId: undefined, saving: true })).toBe('ignore')
    expect(assistantCreateIntent({ createdId: 'assistant-1', saving: true })).toBe('ignore')
  })
})

describe('assistant create layout source contract', () => {
  const moduleCss = readFileSync(
    new URL('../src/client/AgentTeam.module.css', import.meta.url),
    'utf8',
  )
  const source = readFileSync(
    new URL('../src/client/assistant-dialogs.tsx', import.meta.url),
    'utf8',
  )

  function block(selector: string): string {
    const start = moduleCss.indexOf(`${selector} {`)
    expect(start).toBeGreaterThan(-1)
    return moduleCss.slice(start, moduleCss.indexOf('}', start) + 1)
  }

  it('sizes the card and gives nav, pane and footer their own regions', () => {
    expect(block('.assistantCreateDialog')).toContain('width: min(900px, calc(100vw - 32px))')
    expect(block('.assistantCreateDialog')).toContain('height: min(760px, 94dvh)')
    expect(block('.assistantCreateNav')).toContain('flex: 0 0 160px')
    expect(block('.assistantCreatePane')).toContain('overscroll-behavior: contain')
    expect(block('.assistantCreateFooter')).toContain('justify-content: flex-end')
  })

  it('turns the nav horizontal below 760px', () => {
    const mobile = moduleCss.slice(
      moduleCss.indexOf('@media (max-width: 760px)', moduleCss.indexOf('.assistantCreateDialog {')),
    )
    expect(mobile).toContain('.assistantCreateNav {')
    const nav = mobile.slice(mobile.indexOf('.assistantCreateNav {'), mobile.indexOf('.assistantCreateNavItem'))
    expect(nav).toContain('flex-direction: row')
    expect(nav).toContain('overflow-x: auto')
  })

  it('uses only DSH semantic tokens in the create shell', () => {
    const shell = [
      block('.assistantCreateDialog'),
      moduleCss.slice(
        moduleCss.indexOf('.assistantCreateLayout {'),
        moduleCss.indexOf('.assistantAdvanced {'),
      ),
      block('.assistantCreateFooter'),
    ].join('\n')
    const tokens = [...shell.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1] ?? '')
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.every(token => token.startsWith('--dsw-'))).toBe(true)
  })

  it('creates one assistant, writes its group, then ensures the session', () => {
    const submit = source.slice(source.indexOf('async function submit'))
    const createAt = submit.indexOf("'assistant.instance.create'")
    const updateAt = submit.indexOf("'assistant.instance.update'")
    const ensureAt = submit.indexOf('await ensureAndOpen(created.id)')
    expect(createAt).toBeGreaterThan(-1)
    expect(createAt).toBeLessThan(updateAt)
    expect(updateAt).toBeLessThan(ensureAt)
    expect(submit).toContain('setWarning(')
    expect(submit).toContain('value: { group: draft.group }')
    // The mascot and the capability allowlists travel in the create payload,
    // not in the follow-up update.
    expect(submit).toContain('assistantCreatePayload(')
    expect(submit).not.toContain('mascot')
  })

  it('reads roles and groups from existing transports only', () => {
    expect(source).toContain("callAgentTeam('assistant.list')")
    expect(source).toContain("callAgentTeam('sidebar.groups.list')")
    // The create payload comes from the pure builder, which never carries a
    // template id: this stays a directly configured Assistant.
    expect(source).toContain('assistantCreatePayload(')
    expect(source).not.toContain("'assistant.create'")
  })
})
