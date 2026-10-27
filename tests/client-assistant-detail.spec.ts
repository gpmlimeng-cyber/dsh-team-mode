import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AssistantInstanceView } from '../src/transport/contracts.js'

// The shipped primitives package expects browser peers this node test does not
// install. The DisclosureRow stub mirrors the shipped row's dispatch contract —
// a focusable header carrying aria-expanded, content only while open — so the
// assertions below still pin how this panel uses the seat.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Icon = (): unknown => createElement('span')
  const Button = (props: { disabled?: boolean; children?: unknown }): unknown =>
    createElement('button', { type: 'button', disabled: props.disabled }, props.children as never)
  const DisclosureRow = (props: {
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    children?: unknown
  }): unknown => createElement(
    'div',
    { 'data-disclosure-row': '', 'data-open': props.open ? '' : undefined },
    createElement('div', {
      role: props.expandable ? 'button' : undefined,
      tabIndex: props.expandable ? 0 : undefined,
      'aria-expanded': props.open,
    }, props.title),
    props.open ? props.children as never : null,
  )
  return {
    Button,
    DisclosureRow,
    IconClockOutlineRegular: Icon,
    IconDatabaseOutlineRegular: Icon,
    IconEditOutlineRegular: Icon,
    IconFlatListOutlineRegular: Icon,
    IconInfoOutlineRegular: Icon,
    IconPersonalizationOutlineRegular: Icon,
    IconShieldOutlineRegular: Icon,
    IconSlidersTwoOutlineRegular: Icon,
  }
})

// The 记忆 jump reuses the shipped settings dialog wholesale; the panel never
// re-implements memory editing, so the test only needs to see that the dialog
// was asked to open for the selected instance.
vi.mock('../src/client/assistant-settings-dialog.js', () => ({
  AssistantSettingsDialog: (props: { open: boolean; assistant: { id: string } }): unknown =>
    props.open
      ? createElement('div', { 'data-settings-dialog': props.assistant.id }, '助手设置')
      : null,
}))

const {
  AssistantDetailBody,
  AssistantDetailPanel,
  AutomationPanel,
  SCHEDULES_PANEL_ID,
  assistantAutomationNextRun,
  assistantAutomationRows,
  assistantAutomationSessionIds,
  installAssistantAutomations,
  openAssistantAutomations,
  DETAIL_EMPTY_TEXT,
  DETAIL_TAB_ID,
  DETAIL_TAB_KIND,
  HistoryPanel,
  MemoryPanel,
  PersonaPanel,
  assistantBoundSessionCount,
  assistantDetailSections,
  assistantHistoryRows,
  openAssistantDetail,
} = await import('../src/client/assistant-detail.js')
type DetailSidebar = import('../src/client/assistant-detail.js').DetailSidebar
type MemoryPanelView = import('../src/client/labels.js').MemoryPanelView
type AssistantAutomationEntry = import('../src/client/assistant-detail.js').AssistantAutomationEntry

const ISO = '2026-01-01T00:00:00Z'

function instance(overrides: Partial<AssistantInstanceView> = {}): AssistantInstanceView {
  return {
    schemaVersion: 1,
    id: 'assistant-1',
    templateId: 'template-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: '小码',
      avatar: 'data:image/png;base64,AAAA',
      instructions: '',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
      agentPresetId: 'default',
      permissionPresetId: 'workspace-write',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/workspace-1',
    mainSessionId: 'session-main',
    threadSessionIds: ['session-thread-1', 'session-thread-2'],
    status: 'idle',
    pinned: false,
    group: '前端',
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
}

function source(name: string): string {
  return readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
}

function renderPanel(value: AssistantInstanceView | undefined): string {
  return renderToStaticMarkup(createElement(AssistantDetailPanel, {
    ...(value === undefined ? {} : { instance: value }),
    expanded: true,
  }))
}

describe('assistant detail sections', () => {
  it('reads the four blocks out of one list row and nothing else', () => {
    const sections = assistantDetailSections(instance())

    expect(sections.map(section => section.id)).toEqual([
      'overview',
      'identity',
      'model',
      'permission',
    ])
    expect(sections.map(section => section.title)).toEqual(['概览', '身份', '模型', '权限'])
    expect(sections[0]?.facts).toEqual([
      { label: '名称', value: '小码' },
      { label: '状态', value: '空闲' },
      { label: '所属分组', value: '前端' },
      { label: '绑定会话数', value: '3' },
    ])
    expect(sections[2]?.facts).toEqual([
      { label: 'Provider', value: 'deepseek' },
      { label: 'Model', value: 'deepseek-reasoner' },
      { label: '推理强度', value: 'high' },
    ])
    expect(sections[3]?.facts).toEqual([{ label: '权限预设', value: '工作区可写' }])
  })

  it('says what an unset field actually is instead of leaving it blank', () => {
    const bare = instance({
      group: undefined,
      mainSessionId: undefined,
      threadSessionIds: undefined,
      assistantSnapshot: {
        ...instance().assistantSnapshot,
        avatar: undefined,
        reasoningEffort: undefined,
        permissionPresetId: 'read-only',
      },
    })
    const sections = assistantDetailSections(bare)

    expect(sections[0]?.facts).toEqual([
      { label: '名称', value: '小码' },
      { label: '状态', value: '空闲' },
      { label: '所属分组', value: '未分组' },
      { label: '绑定会话数', value: '0' },
    ])
    expect(sections[1]?.facts[1]).toEqual({ label: '头像', value: '首字头像' })
    expect(sections[2]?.facts[2]).toEqual({ label: '推理强度', value: '模型默认' })
    expect(sections[3]?.facts[0]?.value).toBe('只读')
  })

  it('counts the main session plus visible threads only', () => {
    expect(assistantBoundSessionCount(instance())).toBe(3)
    expect(assistantBoundSessionCount({ threadSessionIds: ['a'] })).toBe(1)
    expect(assistantBoundSessionCount({})).toBe(0)
  })
})

describe('assistant detail panel', () => {
  it('renders the eight blocks of a selected helper', () => {
    const html = renderPanel(instance())
    const view = text(html)

    expect(html).toContain('data-dsh-assistant-detail')
    expect(html.match(/data-disclosure-row/g)).toHaveLength(8)
    for (const title of ['概览', '身份', '模型', '权限', '人设', '记忆', '自动化', '会话历史']) {
      expect(view).toContain(title)
    }
    for (const id of ['persona', 'memory', 'automations', 'history']) {
      expect(html).toContain(`data-dsh-assistant-detail-section="${id}"`)
    }
    expect(html.match(/data-dsh-assistant-detail-section="(?!persona|memory|automations|history)/g))
      .toHaveLength(4)
    expect(view).toContain('小码')
    expect(view).toContain('空闲')
    expect(view).toContain('前端')
    expect(view).toContain('deepseek-reasoner')
    expect(view).toContain('工作区可写')
    expect(view).toContain('自定义头像')
    // Keyboard reachable: the row header is the disclosure target itself.
    expect(html).toContain('role="button"')
    expect(html).toContain('aria-expanded="true"')
  })

  it('shows the empty instruction when no helper is chosen', () => {
    const html = renderPanel(undefined)
    const view = text(html)

    expect(view).toBe(DETAIL_EMPTY_TEXT)
    expect(html).toContain('data-dsh-assistant-detail-empty')
    expect(html).not.toContain('data-disclosure-row')
  })

  it('mounts in the host seat with the pane state it was given', () => {
    const html = renderToStaticMarkup(createElement(AssistantDetailBody as never, {
      useTabInfo: () => ({ sidebar: { expanded: false, fullscreen: false } }),
    }))

    expect(text(html)).toBe(DETAIL_EMPTY_TEXT)
    expect(html).toContain('data-expanded="false"')
  })
})

describe('assistant automations', () => {
  function entry(
    overrides: Partial<AssistantAutomationEntry> = {},
  ): AssistantAutomationEntry {
    return {
      id: 'task-1',
      title: '每日回顾',
      status: 'active',
      scheduledAt: '2026-01-02T01:00:00.000Z',
      sessionId: 'session-main',
      ...overrides,
    }
  }

  it('joins on the Sessions the row already stores', () => {
    expect(assistantAutomationSessionIds(instance())).toEqual([
      'session-main',
      'session-thread-1',
      'session-thread-2',
    ])
    expect(assistantAutomationSessionIds({})).toEqual([])
  })

  it('keeps only this assistant\'s tasks, active first, by next run', () => {
    const rows = assistantAutomationRows(instance(), [
      entry({ id: 'thread-but-later', sessionId: 'session-thread-2', scheduledAt: '2026-03-01T00:00:00.000Z' }),
      entry({ id: 'other-assistant', sessionId: 'session-someone-else' }),
      entry({ id: 'ended', status: 'inactive', scheduledAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: 'main-sooner', scheduledAt: '2026-02-01T00:00:00.000Z' }),
    ])

    expect(rows.map(row => row.id)).toEqual(['main-sooner', 'thread-but-later', 'ended'])
    expect(rows[0]).toEqual({
      id: 'main-sooner',
      title: '每日回顾',
      status: 'active',
      nextRunAt: '2026-02-01T00:00:00.000Z',
    })
  })

  it('reports no task for an assistant without Sessions', () => {
    expect(assistantAutomationRows({}, [entry()])).toEqual([])
  })

  it('reads the stored occurrence the way task times are read', () => {
    const stored = '2026-01-02T01:00:00.000Z'
    expect(assistantAutomationNextRun(stored)).toBe(new Date(stored).toLocaleString('zh-CN'))
    expect(assistantAutomationNextRun('not-a-time')).toBe('not-a-time')
  })

  it('says nothing is scheduled and where to create one', () => {
    const opened: string[] = []
    const view = text(renderToStaticMarkup(createElement(AutomationPanel, {
      state: { loading: false, rows: [] },
      onOpen: () => { opened.push('open') },
    })))

    expect(view).toContain('还没有自动化任务')
    expect(view).toContain('打开自动化任务')
    expect(view).toContain('自动化任务')
    expect(opened).toEqual([])
  })

  it('lists a task by its stored title, status and next run', () => {
    const html = renderToStaticMarkup(createElement(AutomationPanel, {
      state: {
        loading: false,
        rows: assistantAutomationRows(instance(), [entry({ id: 'task-9', title: '周报' })]),
      },
      onOpen: () => {},
    }))
    const view = text(html)

    expect(html).toContain('data-dsh-assistant-automation="task-9"')
    expect(view).toContain('周报')
    expect(view).toContain('已开启')
    expect(view).toContain(new Date('2026-01-02T01:00:00.000Z').toLocaleString('zh-CN'))
    expect(view).not.toContain('还没有自动化任务')
  })

  it('distinguishes a deployment without the host service from an empty list', () => {
    const view = text(renderToStaticMarkup(createElement(AutomationPanel, {
      state: { loading: false, unavailable: true },
      onOpen: () => {},
    })))

    expect(view).toContain('当前部署没有自动化任务服务')
    expect(view).not.toContain('还没有自动化任务')
    // No dead button: nothing to open when the deployment has no Host panel.
    expect(view).not.toContain('打开自动化任务')
  })

  it('jumps through the host entrance it was installed with', () => {
    installAssistantAutomations(undefined)
    expect(openAssistantAutomations()).toBe(false)
    expect(SCHEDULES_PANEL_ID).toBe('schedules')

    const opened: string[] = []
    installAssistantAutomations({ open: () => { opened.push('panel') } })
    expect(openAssistantAutomations()).toBe(true)
    expect(opened).toEqual(['panel'])
    installAssistantAutomations(undefined)
  })

  it('reads the host Remote and selects the host panel, never its own page', () => {
    const client = source('index.tsx')

    expect(client).toContain("get?.('remote.schedule')")
    expect(client).toContain('installAssistantAutomations(scheduleRemote === undefined ? undefined : {')
    expect(client).toContain('ctx.layout.selectPanel(SCHEDULES_PANEL_ID as never)')
    expect(source('assistant-detail.tsx')).not.toContain('createPortal')
  })

  it('shows the reading state inside the panel before the catalog settles', () => {
    const view = text(renderPanel(instance()))

    expect(view).toContain('正在读取自动化任务…')
  })
})

describe('opening the detail tab', () => {
  it('opens the page type after a session surface is mounted', () => {
    const opened: string[] = []
    const sidebar: DetailSidebar = {
      mounted: { getSnapshot: () => 'session-main' },
      openTab: kind => { opened.push(kind) },
    }

    expect(openAssistantDetail(sidebar, 'assistant-1')).toBe(true)
    expect(opened).toEqual([DETAIL_TAB_KIND])
  })

  it('reports refusal instead of throwing on a hero screen', () => {
    const opened: string[] = []
    const hero: DetailSidebar = {
      mounted: { getSnapshot: () => undefined },
      openTab: kind => { opened.push(kind) },
    }

    expect(openAssistantDetail(hero, 'assistant-1')).toBe(false)
    expect(openAssistantDetail(undefined, 'assistant-1')).toBe(false)
    expect(opened).toEqual([])
  })

  it('survives a host that refuses the write', () => {
    const sidebar: DetailSidebar = {
      mounted: { getSnapshot: () => 'session-main' },
      openTab: () => { throw new Error('sidebarRight: no session surface is mounted') },
    }

    expect(openAssistantDetail(sidebar, 'assistant-1')).toBe(false)
  })
})

describe('native pane wiring', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dsh: { client: { inject: string[] } }
    peerDependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

  it('declares the host package statically, as the contract requires', () => {
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar-right')
    expect(pkg.peerDependencies['@deepseek-ai/dsh-client-ui-sidebar-right']).toBe('^0.2.1-rc.2')
    expect(pkg.devDependencies['@deepseek-ai/dsh-client-ui-sidebar-right']).toBe('0.2.1-rc.2')
  })

  it('registers the page type and its body under the same id', () => {
    const client = source('index.tsx')

    expect(client).toContain("ctx.inject(['sidebarRight', 'sidebarRightTabs']")
    expect(client).toContain('native.sidebarRightTabs.register({')
    expect(client).toContain('id: DETAIL_TAB_ID')
    expect(client).toContain('kind: DETAIL_TAB_KIND')
    expect(client).toContain("native.slots.inject('sidebar.right.pane.tab'")
    expect(client).toContain('key: DETAIL_TAB_ID')
    expect(client).toContain('openAssistantDetail(sidebarRight, assistantId)')
    expect(DETAIL_TAB_ID).toBe('@limeng/dsh-team-mode/detail')
    expect(DETAIL_TAB_KIND).toBe('team-mode')
  })
})

describe('the old settings dialog stays the old settings dialog', () => {
  it('adds the panel entry beside 助手设置 and keeps the dialog wired', () => {
    const sidebar = source('assistant-sidebar.tsx')

    expect(sidebar).toContain("{ id: 'settings', label: '助手设置'")
    expect(sidebar).toContain("{ id: 'detail', label: '在面板中打开'")
    expect(sidebar).toContain("else if (id === 'settings') openSettings(instance)")
    expect(sidebar).toContain('onOpenDetail?.(instance.id)')
    expect(sidebar).toContain('<AssistantSettingsDialog')
    expect(sidebar).toContain('<AssistantCheckpointDialog')
  })

  it('leaves the settings dialog itself untouched by the panel', () => {
    const dialog = source('assistant-settings-dialog.tsx')

    expect(dialog).toContain('export function AssistantSettingsDialog')
    expect(dialog).not.toContain('sidebarRight')
    expect(dialog).not.toContain('openTab')
    expect(dialog).not.toContain('assistant-detail')
  })

  it('draws no overlay of its own: the pane belongs to the host frame', () => {
    const detail = source('assistant-detail.tsx')

    expect(detail).not.toContain('createPortal')
    expect(detail).not.toContain('shell.overlay')
    expect(detail).toContain("import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'")
  })
})

function memoryView(overrides: Partial<MemoryPanelView> = {}): MemoryPanelView {
  return {
    revision: 4,
    content: '',
    active: [],
    proposed: [],
    history: [],
    historyTotal: 0,
    empty: true,
    ...overrides,
  }
}

function memoryEntry(id: string, overrides: Record<string, unknown> = {}): MemoryPanelView['active'][number] {
  return {
    schemaVersion: 1,
    id,
    scope: 'assistant',
    visibility: 'private',
    status: 'active',
    source: 'user',
    title: `条目 ${id}`,
    body: `正文 ${id}`,
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  } as MemoryPanelView['active'][number]
}

function persona(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(PersonaPanel, {
    instructions: '原有的人设',
    draft: '原有的人设',
    saving: false,
    onChange: () => undefined,
    onSave: () => undefined,
    onReset: () => undefined,
    ...overrides,
  } as never))
}

describe('人设 block', () => {
  it('edits the stored instructions through the existing instance update', () => {
    const detail = source('assistant-detail.tsx')

    expect(detail).toContain("callAgentTeam('assistant.instance.update'")
    expect(detail).toContain('value: { instructions: draft }')
    expect(detail).toContain('保存后对新建或恢复的会话生效')
  })

  it('shows the stored persona in a labelled field', () => {
    const html = persona()

    expect(html).toContain('aria-label="人设说明"')
    expect(html).toContain('原有的人设')
    expect(html).toContain('保存人设')
    expect(html).toContain('撤销修改')
  })

  it('keeps the save control disabled until the draft changes', () => {
    expect(persona()).toContain('disabled=""')
    expect(persona({ draft: '改过的人设' })).not.toContain('disabled=""')
  })

  it('reports a failed save inside the block instead of swallowing it', () => {
    const html = persona({ error: '人设保存失败：network down' })
    const view = text(html)

    expect(html).toContain('role="alert"')
    expect(view).toContain('人设保存失败：network down')
  })

  it('confirms a saved draft in place', () => {
    expect(text(persona({ saved: true }))).toContain('已保存')
  })
})

describe('记忆 block', () => {
  it('only reads memory; editing stays in the shipped settings dialog', () => {
    const detail = source('assistant-detail.tsx')

    expect(detail).toContain("callAgentTeam('assistant.memory.get'")
    expect(detail).not.toContain("'assistant.memory.write'")
    expect(detail).not.toContain("'assistant.memory.entry.write'")
    expect(detail).not.toContain("'assistant.memory.undo'")
    expect(detail).toContain('<AssistantSettingsDialog')
    expect(detail).toContain('在助手设置中编辑记忆')
  })

  it('lists the entries read-only with their pending state', () => {
    const html = renderToStaticMarkup(createElement(MemoryPanel, {
      state: {
        loading: false,
        view: memoryView({
          empty: false,
          active: [memoryEntry('a')],
          proposed: [memoryEntry('b', { status: 'proposed' })],
          history: [memoryEntry('c', { status: 'superseded' })],
          historyTotal: 1,
        }),
      },
      onEdit: () => undefined,
    }))
    const view = text(html)

    expect(view).toContain('条目 a')
    expect(view).toContain('正文 b')
    expect(view).toContain('待确认')
    expect(view).toContain('修订 4')
    expect(view).toContain('在助手设置中编辑记忆')
  })

  it('shows the loading and empty states', () => {
    const loading = renderToStaticMarkup(createElement(MemoryPanel, {
      state: { loading: true },
      onEdit: () => undefined,
    }))
    expect(text(loading)).toContain('正在读取记忆…')

    const empty = renderToStaticMarkup(createElement(MemoryPanel, {
      state: { loading: false, view: memoryView() },
      onEdit: () => undefined,
    }))
    expect(text(empty)).toContain('还没有记忆条目')
  })

  it('reports a failed read inside the block', () => {
    const html = renderToStaticMarkup(createElement(MemoryPanel, {
      state: { loading: false, error: '读取记忆失败：boom' },
      onEdit: () => undefined,
    }))

    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('读取记忆失败：boom')
  })
})

describe('会话历史 block', () => {
  it('marks the main Session and keeps it unarchivable', () => {
    const rows = assistantHistoryRows(instance({
      mainSessionId: 'session-main',
      threadSessionIds: ['session-thread-1'],
    }))

    expect(rows).toEqual([
      { sessionId: 'session-main', kind: 'main', badge: '主', archivable: false },
      { sessionId: 'session-thread-1', kind: 'thread', badge: '附加', archivable: true },
    ])
    expect(assistantHistoryRows({ threadSessionIds: ['a'] }).map(row => row.kind)).toEqual(['thread'])
  })

  it('offers 归档 only on the additional Sessions', () => {
    const html = renderToStaticMarkup(createElement(HistoryPanel, {
      instance: instance({ mainSessionId: 'session-main', threadSessionIds: ['session-thread-1'] }),
      onOpen: () => undefined,
      onArchive: () => undefined,
    }))
    const main = html.slice(
      html.indexOf('data-dsh-assistant-history-kind="main"'),
      html.indexOf('data-dsh-assistant-history-kind="thread"'),
    )
    const thread = html.slice(html.indexOf('data-dsh-assistant-history-kind="thread"'))
    const view = text(html)

    expect(text(main)).toContain('主')
    expect(text(main)).not.toContain('归档')
    expect(text(main)).toContain('打开')
    expect(text(thread)).toContain('附加')
    expect(text(thread)).toContain('归档')
    expect(view).toContain('主会话是这个助手本身，不能归档。')
  })

  it('opens and archives through the existing navigation and thread methods', () => {
    const detail = source('assistant-detail.tsx')

    expect(detail).toContain('openAssistantSession(sessionId)')
    expect(detail).toContain("callAgentTeam('assistant.thread.archive'")
    expect(detail).toContain("detailErrorMessage('归档失败'")
    expect(source('store.ts')).toContain('export function openAssistantSession')
    expect(source('index.tsx')).toContain('installAssistantSessionOpener(openSession)')
  })

  it('reports a failed archive inside the block', () => {
    const html = renderToStaticMarkup(createElement(HistoryPanel, {
      instance: instance({ mainSessionId: 'session-main', threadSessionIds: ['session-thread-1'] }),
      error: '归档失败：network down',
      busySessionId: 'session-thread-1',
      onOpen: () => undefined,
      onArchive: () => undefined,
    }))

    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('归档失败：network down')
    expect(text(html)).toContain('归档中…')
  })
})
