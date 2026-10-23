import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  CHECKPOINT_NOTE_LIMIT,
  checkpointFactsSummary,
  checkpointHandoffLabel,
  checkpointNoteError,
  checkpointStatusLabel,
  readyCheckpoints,
} from '../src/client/assistant-checkpoint.js'
import type { AssistantInstance, ContextCheckpoint } from '../src/domain/types.js'

// The shipped primitives package expects browser peers (clsx) that this node
// test does not install; every primitive renders as a trivial wrapper so the
// markup assertions can target the real dialog and list components.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (props: { children?: unknown }): unknown => createElement('div', null, props?.children as never)
  const names = [
    'Button', 'Input', 'Menu', 'Modal', 'Tag', 'Tooltip', 'MarkdownText', 'UserTextRun',
    'IconChecklistOutlineRegular', 'IconChevronRightOutlineRegular', 'IconCloseFillRegular',
    'IconEditOutlineRegular', 'IconEllipsisOutlineRegular', 'IconNewChatOutlineRegular',
    'IconPinFillRegular', 'IconPinOutlineRegular', 'IconPlusOutlineRegular',
    'IconSearchOutlineRegular', 'IconSlidersTwoOutlineRegular', 'IconWarningOutlineRegular',
    'IconLoadingOutlineRegular',
  ]
  return Object.fromEntries(names.map(name => [name, Stub]))
})

const { CheckpointList } = await import('../src/client/assistant-checkpoint-dialog.js')
const { assistantMenuEntries } = await import('../src/client/assistant-sidebar.js')

const NOW = '2026-10-23T00:00:00.000Z'

function checkpoint(overrides: Partial<ContextCheckpoint> = {}): ContextCheckpoint {
  return {
    schemaVersion: 1,
    id: 'cp-1',
    assistantId: 'instance-1',
    sourceSessionId: 'session-old',
    title: '检查点 A',
    note: '',
    capturedThroughSeq: 4,
    facts: {
      recentMessages: [
        { role: 'user', text: 'question' },
        { role: 'assistant', text: 'answer' },
      ],
      activeTasks: [{ id: 'task-1', title: 'Write tests', status: 'running' }],
      workspacePath: '/tmp/w',
      note: '',
    },
    status: 'ready',
    createdAt: NOW,
    ...overrides,
  }
}

function instance(): AssistantInstance {
  return {
    schemaVersion: 1,
    id: 'instance-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: 'Researcher',
      instructions: '',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/w',
    status: 'active',
    pinned: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function renderList(options: {
  checkpoints: readonly ContextCheckpoint[]
  confirmingId?: string
  busy?: boolean
}): string {
  return renderToStaticMarkup(createElement(CheckpointList, {
    checkpoints: options.checkpoints,
    confirmingId: options.confirmingId,
    busy: options.busy ?? false,
    onHandoff: () => {},
  }))
}

describe('checkpoint note validation', () => {
  it('accepts an empty note and one at the limit', () => {
    expect(checkpointNoteError('')).toBeUndefined()
    expect(checkpointNoteError('  handoff note  ')).toBeUndefined()
    expect(checkpointNoteError('x'.repeat(CHECKPOINT_NOTE_LIMIT))).toBeUndefined()
  })

  it('rejects a note over 4000 characters with a clear message', () => {
    expect(checkpointNoteError('x'.repeat(CHECKPOINT_NOTE_LIMIT + 1))).toBe('交接说明不能超过 4000 字')
    expect(CHECKPOINT_NOTE_LIMIT).toBe(4_000)
  })
})

describe('checkpoint helpers', () => {
  it('filters to ready checkpoints and labels every status', () => {
    const list = [
      checkpoint({ id: 'ready', status: 'ready' }),
      checkpoint({ id: 'consumed', status: 'consumed' }),
      checkpoint({ id: 'archived', status: 'archived' }),
    ]
    expect(readyCheckpoints(list).map(value => value.id)).toEqual(['ready'])
    expect(checkpointStatusLabel('ready')).toBe('可交接')
    expect(checkpointStatusLabel('consumed')).toBe('已交接')
    expect(checkpointStatusLabel('archived')).toBe('已归档')
  })

  it('summarizes the bounded facts and labels the two handoff clicks', () => {
    expect(checkpointFactsSummary(checkpoint())).toBe('2 条消息 · 1 个进行中任务')
    expect(checkpointHandoffLabel(false)).toBe('交接新会话')
    expect(checkpointHandoffLabel(true)).toBe('确认交接')
  })
})

describe('CheckpointList', () => {
  it('shows an explicit empty state', () => {
    expect(renderList({ checkpoints: [] })).toContain('还没有检查点')
  })

  it('shows a ready checkpoint with its facts and handoff action', () => {
    const markup = renderList({ checkpoints: [checkpoint()] })

    expect(markup).toContain('检查点 A')
    expect(markup).toContain('可交接')
    expect(markup).toContain('2 条消息 · 1 个进行中任务')
    expect(markup).toContain('交接新会话')
    expect(markup).toContain('data-dsh-checkpoint-status="ready"')
  })

  it('asks for a second confirmation instead of handing off on the first click', () => {
    const armed = renderList({ checkpoints: [checkpoint()], confirmingId: 'cp-1' })
    expect(armed).toContain('确认交接')
    expect(armed).not.toContain('交接新会话')

    const other = renderList({ checkpoints: [checkpoint()], confirmingId: 'cp-2' })
    expect(other).toContain('交接新会话')
    expect(other).not.toContain('确认交接')
  })

  it('shows consumed checkpoints without a handoff action', () => {
    const markup = renderList({ checkpoints: [checkpoint({ status: 'consumed', targetSessionId: 'session-new' })] })

    expect(markup).toContain('已交接')
    expect(markup).not.toContain('交接新会话')
    expect(markup).not.toContain('确认交接')
  })
})

describe('assistant menu entries', () => {
  it('exposes one checkpoint item and no separate handoff duplicate', () => {
    const entries = assistantMenuEntries(instance(), false)
    const ids = entries.map(entry => entry.id)

    expect(ids.filter(id => id === 'checkpoint')).toHaveLength(1)
    expect(entries.find(entry => entry.id === 'checkpoint')?.label).toBe('检查点与交接')
    expect(ids.some(id => id.includes('handoff'))).toBe(false)
    expect(ids).toContain('settings')
    expect(ids).toContain('tasks')
  })

  it('keeps the read/unread entry and the full menu order', () => {
    expect(assistantMenuEntries(instance(), false).map(entry => entry.id))
      .toEqual(['checkpoint', 'settings', 'pin', 'tasks', 'mark-unread', 'open-main'])
    expect(assistantMenuEntries(instance(), true).map(entry => entry.id))
      .toContain('mark-read')
  })
})
