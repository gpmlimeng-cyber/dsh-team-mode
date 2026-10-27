import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assistantPendingDecisions,
  assistantSidebarSummary,
  visibleAssistantInstances,
} from '../src/client/assistant-instances.js'
import type { AssistantInstance, AssistantSession } from '../src/domain/types.js'
import type { AssistantInstanceView } from '../src/transport/contracts.js'

const ISO = '2026-01-01T00:00:00Z'

function instance(
  id: string,
  name: string,
  overrides: Partial<AssistantInstance> = {},
): AssistantInstanceView {
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
    createdAt: ISO,
    updatedAt: ISO,
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
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

const paper = instance('paper', 'Paper Bot')
const data = instance('data', 'Data Bot', { status: 'active' })
const broken = instance('broken', 'Broken Bot', { status: 'error', archivedAt: undefined })
const instances: AssistantInstanceView[] = [paper, data, broken]

const tasks: AssistantSession[] = [
  task('paper', 'needs_input', 'paper-pending'),
  task('data', 'needs_input', 'data-pending'),
  task('data', 'running', 'data-running'),
  task('broken', 'needs_input', 'broken-pending'),
]

describe('assistant sidebar search only narrows the ordinary list', () => {
  it('keeps every pending decision when the query matches no assistant', () => {
    // The query is a view over the rows; the decision block is workspace-wide.
    expect(visibleAssistantInstances(instances, '不存在的名字')).toEqual([])
    expect(assistantPendingDecisions(instances, tasks).map(entry => entry.task.id))
      .toEqual(['paper-pending', 'data-pending', 'broken-pending'])
  })

  it('keeps the decision block identical for a matching and a non-matching query', () => {
    const matching = visibleAssistantInstances(instances, 'paper')
    const missing = visibleAssistantInstances(instances, 'nothing here')

    expect(matching.map(item => item.id)).toEqual(['paper'])
    expect(missing).toEqual([])
    expect(assistantPendingDecisions(instances, tasks))
      .toEqual(assistantPendingDecisions(instances, tasks))
    expect(assistantPendingDecisions(instances, tasks)).toHaveLength(3)
  })

  it('counts the summary over every listed assistant, with no query input', () => {
    const summary = assistantSidebarSummary(instances, tasks, {})

    expect(summary).toEqual({ waiting: 3, working: 0, queued: 0, unread: 0 })
    // Same inputs, same numbers: there is no query parameter to narrow them.
    expect(assistantSidebarSummary(instances, tasks, {})).toEqual(summary)
    expect(assistantSidebarSummary(instances, tasks, {}).waiting)
      .toBe(assistantPendingDecisions(instances, tasks).length)

    const busy = instance('busy', 'Busy Bot', { status: 'active' })
    expect(assistantSidebarSummary([busy], [task('busy', 'running')], {}))
      .toEqual({ waiting: 0, working: 1, queued: 0, unread: 0 })
    expect(assistantSidebarSummary([busy], [task('busy', 'queued')], {}))
      .toEqual({ waiting: 0, working: 0, queued: 1, unread: 0 })
  })

  it('never offers an archived instance as a decision or a row', () => {
    const archived = instance('gone', 'Gone Bot', { status: 'archived' })
    const archivedTask = task('paper', 'needs_input', 'paper-archived', {
      archivedAt: '2026-01-02T00:00:00Z',
    })

    expect(visibleAssistantInstances([...instances, archived], '').map(item => item.id))
      .toEqual(['broken', 'data', 'paper'])
    expect(assistantPendingDecisions([...instances, archived], [...tasks, archivedTask])
      .map(entry => entry.task.id)).toEqual(['paper-pending', 'data-pending', 'broken-pending'])
    expect(assistantSidebarSummary([...instances, archived], [...tasks, archivedTask], {}).waiting).toBe(3)
  })
})

describe('assistant sidebar source contract', () => {
  const source = readFileSync(new URL('../src/client/assistant-sidebar.tsx', import.meta.url), 'utf8')
  const moduleCss = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')

  it('builds 待你处理 from the workspace instead of the filtered rows', () => {
    expect(source).toContain('assistantPendingDecisions(instances, tasks)')
    expect(source).not.toContain('visible.some(instance => instance.id === item.instance.id)')
    expect(source).toContain('{attentionItems.length > 0 && (')
    expect(source).toContain('{attentionItems.length}')
  })

  it('has no section header left to carry counts', () => {
    // The header row is gone: no title, no summary line, no section-level fold.
    expect(source).not.toContain('data-dsh-assistant-title')
    expect(source).not.toContain('sidebarAssistantSummary')
    expect(source).toContain('aria-label="单聊"')
    expect(source).not.toContain('for (const instance of visible)')
  })

  it('renders an explicit loading and failure state instead of an empty section', () => {
    expect(source).toContain('正在加载助手…')
    expect(source).toContain('data-dsh-assistant-loading')
    expect(source).toContain('助手数据加载失败：')
    expect(source).toContain('setLoaded(true)')
    expect(source).toContain('className={css.sidebarTeamRetry}')
  })

  it('takes every status word from the shared source', () => {
    expect(source).not.toContain("'空闲'")
    expect(source).not.toContain("'异常'")
    expect(source).not.toContain("'唤醒中'")
    expect(source).toContain('assistantRowState(activity)')
    expect(source).toContain('assistantRowStatusText(activity)')
    expect(source).toContain('assistantRowStatusTitle(activity)')
  })

  it('tones a failed or waking row with the error and business tokens', () => {
    expect(source).toContain('css.sidebarAssistantDotError')
    expect(source).toContain('css.sidebarAssistantDotStarting')
    expect(source).toContain('css.sidebarAssistantStatusError')
    expect(source).toContain('css.sidebarAssistantStatusStarting')
    expect(moduleCss).toMatch(/\.sidebarAssistantDotError\s*\{[^}]*--dsw-alias-state-error-primary/)
    expect(moduleCss).toMatch(/\.sidebarAssistantDotStarting\s*\{[^}]*--dsw-alias-state-business-primary/)
    expect(moduleCss).toMatch(/\.sidebarAssistantStatusError\s*\{[^}]*--dsw-alias-state-error-primary/)
    expect(moduleCss).toMatch(/\.sidebarAssistantStatusStarting\s*\{[^}]*--dsw-alias-state-business-primary/)
  })

  it('follows the effective row state for the dot and the second line', () => {
    expect(source).toContain("const state = assistantRowState(activity)")
    expect(source).toContain("const activeStatus = state !== 'none'")
    expect(source).toContain("{state !== 'none' && (")
    expect(source).toContain('data-dsh-assistant-status={state}')
  })

  it('draws a mascot and an uploaded picture at one 36px row size', () => {
    // DeepSeek-Bot's sidebar Bot is 36px; one constant keeps the row from
    // jumping when a helper swaps a picture for its mascot (was 32 vs 34).
    expect(source).toContain('export const SIDEBAR_ASSISTANT_AVATAR_SIZE = 36')
    expect(source.match(/size=\{SIDEBAR_ASSISTANT_AVATAR_SIZE\}/g) ?? []).toHaveLength(2)
    expect(source).not.toContain('size={32}')
    expect(source).not.toContain('size={34}')
    expect(moduleCss).toMatch(/\.sidebarAssistantAvatar\s*\{[^}]*width: 36px;[^}]*height: 36px;/)
  })

  it('keeps the coordinator in the team column instead of a body host', () => {
    // The pinned 总协调 row leads the lists as one more row: it scrolls with
    // them, needs no host polling, and owns no fixed position or z-index.
    expect(source).toContain('data-dsh-assistant-coordinator-row')
    expect(source).toContain('css.sidebarCoordinatorRow')
    expect(source).not.toContain('createPortal')
    expect(source).not.toContain('useStewardHost')
    expect(source).not.toContain('STEWARD_HOST_ID')
    expect(source).not.toContain('requestAnimationFrame')
    expect(moduleCss).toMatch(/\.sidebarCoordinatorRow\s*\{[^}]*order: 0/)
    expect(moduleCss).toMatch(/\.sidebarCoordinatorRow\s*\{[^}]*flex: none/)
    // The coordinator is still not repeated in the list.
    expect(source).toMatch(/filter\(instance => instance\.id !== coordinatorId\)/)
  })
})
