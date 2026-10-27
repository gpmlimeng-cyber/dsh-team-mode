import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AssistantInstanceView } from '../src/transport/contracts.js'

// The shipped primitives package expects browser peers this node test does not
// install. Anything that is not a control renders as a bare span; the
// assertions below pin copy, structure and wiring, not the shipped widgets.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Icon = (): unknown => createElement('span')
  const Pass = (props: { children?: unknown }): unknown => createElement('span', null, props.children as never)
  const icons = [
    'IconAgentPresetOutlineRegular', 'IconArchiveOutlineMedium', 'IconArchiveOutlineRegular',
    'IconBranchOutlineRegular', 'IconCheckOutlineRegular', 'IconChecklistOutlineRegular',
    'IconChevronDownOutlineRegular', 'IconChevronLeftOutlineRegular', 'IconChevronRightOutlineRegular',
    'IconChevronUpOutlineRegular', 'IconChevronsUpDownOutlineRegular', 'IconClockOutlineRegular',
    'IconCloseFillRegular', 'IconCloseOutlineRegular', 'IconDatabaseOutlineRegular',
    'IconEditOutlineRegular', 'IconEllipsisOutlineRegular', 'IconFlatListOutlineRegular',
    'IconFolderCloseRegular', 'IconFolderOpenOutlineRegular', 'IconFolderOpenRegular',
    'IconInfoOutlineRegular', 'IconLoadingOutlineRegular', 'IconNewChatOutlineRegular',
    'IconPaperclipOutlineRegular', 'IconPersonalizationOutlineRegular', 'IconPinFillRegular',
    'IconPinOutlineRegular', 'IconPlusOutlineRegular', 'IconProjectAddOutlineRegular',
    'IconRefreshOutlineRegular', 'IconRightUpOutlineRegular', 'IconSearchOutlineRegular',
    'IconSendOutlineRegular', 'IconSettingsOutlineRegular', 'IconShieldOutlineRegular',
    'IconSlidersTwoOutlineRegular', 'IconSparkleRegular', 'IconStopFillRegular',
    'IconTrashOutlineRegular', 'IconUserOutlineRegular', 'IconUsersOutlineRegular',
    'IconWarningOutlineRegular', 'IconWarningTriangleOutlineRegular',
  ]
  return {
    Button: (props: { disabled?: boolean; children?: unknown; type?: string }): unknown =>
      createElement('button', { type: props.type ?? 'button', disabled: props.disabled }, props.children as never),
    Switch: (props: { checked?: boolean; label?: string }): unknown =>
      createElement('input', { type: 'checkbox', checked: props.checked, 'aria-label': props.label, readOnly: true }),
    Menu: Pass,
    Modal: Pass,
    Tooltip: Pass,
    Tag: Pass,
    MarkdownText: Pass,
    Input: (props: { value?: string }): unknown => createElement('input', { value: props.value, readOnly: true }),
    Checkbox: Pass,
    ...Object.fromEntries(icons.map(name => [name, Icon])),
  }
})

const {
  AutomationPanel,
  SCHEDULES_PANEL_ID,
  assistantAutomationCount,
  assistantAutomationNextRun,
  assistantAutomationRows,
  assistantAutomationSessionIds,
  installAssistantAutomations,
  openAssistantAutomations,
  HistoryPanel,
  PersonaPanel,
  assistantBoundSessionCount,
  assistantDetailSections,
  assistantHistoryRows,
} = await import('../src/client/assistant-detail.js')

const {
  AssistantDetailBody,
  AssistantDetailPanel,
  applyAssistantDetail,
  ASSISTANT_SETTING_GROUPS,
  assistantDetailTarget,
  visibleSettingGroups,
} = await import('../src/client/assistant-settings-pane.js')
type DetailSidebar = import('../src/client/assistant-settings-pane.js').DetailSidebar
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

function openedDetails(html: string): number {
  return (html.match(/<details[^>]*\bopen\b/g) ?? []).length
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

  it('counts the main session plus visible threads only', () => {
    expect(assistantBoundSessionCount(instance())).toBe(3)
    expect(assistantBoundSessionCount({ threadSessionIds: ['a'] })).toBe(1)
    expect(assistantBoundSessionCount({})).toBe(0)
  })
})

describe('assistant settings pane', () => {
  it('renders a search field and every accordion group', () => {
    const html = renderPanel(instance())
    const view = text(html)

    expect(html).toContain('data-dsh-assistant-detail')
    expect(html).toContain('aria-label="搜索设置"')
    expect(html.match(/data-dsh-fold=/g)).toHaveLength(ASSISTANT_SETTING_GROUPS.length)
    for (const group of ASSISTANT_SETTING_GROUPS) {
      expect(view).toContain(group.title)
    }
    expect(view).toContain('保存')
  })

  it('heads the page with the avatar, its name and subtitle behind one edit button', () => {
    const html = renderPanel(instance())
    const view = text(html)

    expect(html).toContain('data-dsh-assistant-avatar-hero')
    // A 64px avatar, the name, and the existing group/status as the subtitle.
    expect(html).toMatch(/data-dsh-assistant-avatar-hero[\s\S]*?width:64px/)
    expect(view).toContain('小码')
    expect(view).toContain('前端 · 空闲')
    // The edit affordance is a real, keyboard-focusable button.
    expect(html).toMatch(/<button[^>]*aria-label="编辑头像"[^>]*aria-expanded="false"/)
    expect(html).not.toContain('disabled="" aria-label="编辑头像"')
    // Clicking is what expands it: a fresh render mounts no panel at all.
    expect(html).not.toContain('data-dsh-avatar-editor')
    // And there is no second avatar control left in 身份与形象.
    expect(view).not.toContain('选择图片')
    expect(html).not.toContain('data-dsh-assistant-mascot')
  })

  function instanceWith(patch: {
    instructions?: string
    skills?: string[]
    mcp?: string[]
  }): AssistantInstanceView {
    const base = instance()
    return {
      ...base,
      assistantSnapshot: {
        ...base.assistantSnapshot,
        instructions: patch.instructions ?? '',
        skillAllowlist: patch.skills ?? [],
        mcpServers: patch.mcp ?? [],
      },
    }
  }

  it('renders 概览 as the three-part checkup, not the old fact table', () => {
    const html = renderPanel(instanceWith({}))
    const view = text(html)

    expect(html).toContain('data-dsh-assistant-overview')
    expect(html).toContain('data-dsh-assistant-overview-todos')
    expect(html).toContain('data-dsh-assistant-overview-who')
    expect(html).toContain('data-dsh-assistant-overview-limits')

    expect(view).toContain('待办清单')
    expect(view).toContain('它是什么')
    expect(view).toContain('能力边界')
    expect(view).toContain('能做到')
    // The three known gaps here: description, skills, MCP. Counts are not read
    // in a static render, so 自动化 / 记忆 make no claim yet.
    expect(html.match(/data-dsh-assistant-overview-todo=/g)).toHaveLength(3)
    expect(view).toContain('写一段描述，让它知道自己是干什么的')
    expect(view).toContain('还没有授予任何技能')
    expect(view).toContain('还没有可用的 MCP 工具')
    expect(view).not.toContain('没有自动化任务')
    // Every row is a whole-row button with the jump arrow on the right.
    expect((html.match(/→/g) ?? [])).toHaveLength(3)
    // The description keeps two lines here; the full text stays in the title.
    const css = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
    const description = css.slice(css.indexOf('.assistantOverviewDescription {'))
    expect(description.slice(0, description.indexOf('}'))).toContain('-webkit-line-clamp: 2')
    // Who: the 24px avatar, the name, the missing-description jump and the meta.
    expect(html).toContain('还没有描述')
    expect(view).toContain('小码')
    expect(view).toContain('模板：template-1')
    expect(view).toContain('Workspace：/tmp/workspace-1')
    expect(view).toContain('权限：工作区可写')
    // Limits: the real workspace sentence, and no invented negative.
    expect(view).toContain('运行在「/tmp/workspace-1」工作区，权限：工作区可写')
    expect(html).not.toContain('data-dsh-assistant-overview-unable')

    // The old read-only duplicate is gone from the settings page.
    expect(view).not.toContain('创建时间')
    expect(html).not.toContain('data-dsh-assistant-settings-status')
    expect(html).not.toContain('data-dsh-assistant-settings-coordinator')
  })

  it('always gives a non-empty description a 读全部 text action into 身份与形象', () => {
    const html = renderPanel(instanceWith({ instructions: '第一行\n第二行\n第三行' }))

    // The clamped two-line excerpt is followed by a real text button.
    expect(html).toContain('assistantOverviewDescription')
    expect(html).toContain('data-dsh-assistant-overview-read-all')
    expect(html).toContain('>读全部<')
    expect(html).toMatch(/<button[^>]*data-dsh-assistant-overview-read-all/)

    const pane = source('assistant-settings-pane.tsx')
    const readAll = pane.slice(
      pane.indexOf('data-dsh-assistant-overview-read-all'),
      pane.indexOf('</button>', pane.indexOf('data-dsh-assistant-overview-read-all')),
    )
    // It jumps to the group that owns the description, and it is a text action,
    // not an icon.
    expect(readAll).toContain("jumpToOverviewTarget('identity')")
    expect(readAll).not.toContain('<svg')

    // The empty branch keeps its own entry; the read-all only appears with text.
    const empty = renderPanel(instanceWith({}))
    expect(empty).toContain('还没有描述')
    expect(empty).not.toContain('data-dsh-assistant-overview-read-all')
  })

  it('drops the checklist entirely once nothing is missing', () => {
    const html = renderPanel(instanceWith({
      instructions: '写代码',
      skills: ['research'],
      mcp: ['files'],
    }))
    const view = text(html)

    // No empty shell, no completion badge: just the other two sections.
    expect(html).not.toContain('data-dsh-assistant-overview-todos')
    expect(view).not.toContain('待办清单')
    expect(html).toContain('data-dsh-assistant-overview-who')
    expect(view).toContain('写代码')
    expect(view).toContain('可以使用 1 个技能（research）')
    expect(view).toContain('可以调用 1 个 MCP 工具')
  })

  it('jumps inside the pane: opens the target group and scrolls to it', () => {
    const pane = source('assistant-settings-pane.tsx')

    expect(pane).toContain('querySelector(`[data-dsh-fold="${target}"]`)')
    expect(pane).toContain(".scrollIntoView({ block: 'start' })")
    expect(pane).toContain("setOpenGroups(current => ({ ...current, [target]: true }))")
    // A search hides non-matching groups, so the jump clears it first.
    expect(pane).toContain("setQuery('')")
    // 概览 is read-only: the block maps the pure results and calls nothing that writes.
    const overviewBlock = pane.slice(
      pane.indexOf('data-dsh-assistant-overview'),
      pane.indexOf("isVisible('identity')"),
    )
    expect(overviewBlock).toContain('jumpToOverviewTarget')
    expect(overviewBlock).not.toContain('callAgentTeam')
    expect(overviewBlock).not.toContain('setAvatarDraft')
    expect(overviewBlock).not.toContain('<Button')
  })

  it('matches 概览 by its own sections without stealing the other groups’ words', () => {
    expect(visibleSettingGroups('待办')).toEqual(['overview'])
    expect(visibleSettingGroups('能力边界')).toEqual(['overview'])
    // 技能 / MCP / 自动化 / 记忆 still belong to the groups that edit them.
    expect(visibleSettingGroups('技能')).toEqual(['capabilities'])
    expect(visibleSettingGroups('自动化')).toEqual(['automations'])
    expect(visibleSettingGroups('记忆')).toEqual(['memory'])
  })

  it('opens only 概览 by default', () => {
    const html = renderPanel(instance())

    expect(openedDetails(html)).toBe(1)
    expect(html).toContain('data-dsh-fold="overview"')
    // Closed groups keep a one-row summary and mount nothing under it.
    expect(html).not.toContain('data-dsh-assistant-detail-section="history"')
  })

  it('shows the empty instruction when no helper was opened', () => {
    const html = renderPanel(undefined)
    const view = text(html)

    expect(view).toBe('从左侧选择一个助手')
    expect(html).toContain('data-dsh-assistant-detail-empty')
    expect(html).not.toContain('data-dsh-fold')
  })

  it('mounts in the host seat with the identity the open action injected', () => {
    assistantDetailTarget.set('assistant-1')
    const html = renderToStaticMarkup(createElement(AssistantDetailBody as never, {
      useTabInfo: () => ({ sidebar: { expanded: false, fullscreen: false } }),
      state: assistantDetailTarget,
    }))

    // No list read in a static render: the pane starts in its loading notice,
    // but it is the pane — not the "currently selected" list row.
    expect(html).toContain('data-expanded="false"')
    expect(html).toMatch(/正在加载助手|从左侧选择一个助手/)
  })
})

describe('settings search', () => {
  it('keeps every group for a blank query', () => {
    expect(visibleSettingGroups('')).toHaveLength(ASSISTANT_SETTING_GROUPS.length)
  })

  it('narrows to the matching group by title or keyword', () => {
    expect(visibleSettingGroups('模型')).toEqual(['model'])
    expect(visibleSettingGroups('技能')).toEqual(['capabilities'])
    expect(visibleSettingGroups('显示名称')).toEqual(['identity'])
    // The mascot/animation controls moved out of 身份与形象 into the avatar
    // editor at the page header, so the old word no longer names a group.
    expect(visibleSettingGroups('吉祥物')).toEqual([])
    expect(visibleSettingGroups('归档')).toContain('archive')
  })

  it('is empty when nothing matches, so the pane can say so', () => {
    expect(visibleSettingGroups('没有这个设置')).toEqual([])
  })

  it('matches case-insensitively and ignores surrounding spaces', () => {
    expect(visibleSettingGroups('  MCP ')).toEqual(['capabilities'])
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
  })

  it('reads the stored occurrence the way task times are read', () => {
    const stored = '2026-01-02T01:00:00.000Z'
    expect(assistantAutomationNextRun(stored)).toBe(new Date(stored).toLocaleString('zh-CN'))
    expect(assistantAutomationNextRun('not-a-time')).toBe('not-a-time')
  })

  it('says nothing is scheduled and where to create one', () => {
    const view = text(renderToStaticMarkup(createElement(AutomationPanel, {
      state: { loading: false, rows: [] },
      onOpen: () => undefined,
    })))

    expect(view).toContain('还没有自动化任务')
    expect(view).toContain('打开自动化任务')
  })

  it('distinguishes a deployment without the host service from an empty list', () => {
    const view = text(renderToStaticMarkup(createElement(AutomationPanel, {
      state: { loading: false, unavailable: true },
      onOpen: () => undefined,
    })))

    expect(view).toContain('当前部署没有自动化任务服务')
    expect(view).not.toContain('还没有自动化任务')
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

  it('counts this assistant\'s automations for 概览, and admits when it cannot', async () => {
    const entries = [
      entry({ id: 'mine-1' }),
      entry({ id: 'mine-2', sessionId: 'session-thread-1' }),
      entry({ id: 'someone-else', sessionId: 'session-someone-else' }),
    ]

    // No Schedule Remote composed: no count, so 概览 makes no claim.
    installAssistantAutomations(undefined)
    expect(await assistantAutomationCount(instance())).toBeUndefined()

    installAssistantAutomations({ open: () => undefined, catalog: async () => entries })
    expect(await assistantAutomationCount(instance())).toBe(2)

    installAssistantAutomations({
      open: () => undefined,
      catalog: async () => { throw new Error('catalog down') },
    })
    expect(await assistantAutomationCount(instance())).toBeUndefined()

    installAssistantAutomations(undefined)
  })
})

describe('人设 block', () => {
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

  it('edits the stored instructions through the existing instance update', () => {
    const detail = source('assistant-detail.tsx')

    expect(detail).toContain("callAgentTeam('assistant.instance.update'")
    expect(detail).toContain('value: { instructions: draft }')
    expect(detail).toContain('保存后对新建或恢复的会话生效')
  })

  it('shows the stored persona in a labelled field', () => {
    const html = persona()

    expect(html).toContain('aria-label="人设说明"')
    expect(html).toContain('保存人设')
  })

  it('keeps the save control disabled until the draft changes', () => {
    expect(persona()).toContain('disabled=""')
    expect(persona({ draft: '改过的人设' })).not.toContain('disabled=""')
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

    expect(text(main)).toContain('主')
    expect(text(main)).not.toContain('归档')
    expect(text(thread)).toContain('归档')
  })

  it('opens and archives through the existing navigation and thread methods', () => {
    const detail = source('assistant-detail.tsx')

    expect(detail).toContain('openAssistantSession(sessionId)')
    expect(detail).toContain("callAgentTeam('assistant.thread.archive'")
    expect(source('index.tsx')).toContain('installAssistantSessionOpener(openSession)')
  })
})

describe('opening the settings tab', () => {
  it('opens the page type after a session surface is mounted', () => {
    const opened: string[] = []
    const sidebar: DetailSidebar = {
      mounted: { getSnapshot: () => 'session-main' },
      openTab: kind => { opened.push(kind) },
    }

    expect(applyAssistantDetail(sidebar, 'assistant-1')).toBe(true)
    expect(opened).toEqual(['team-mode'])
    expect(assistantDetailTarget.getSnapshot()).toBe('assistant-1')
  })

  it('reports refusal instead of throwing on a hero screen', () => {
    const opened: string[] = []
    const hero: DetailSidebar = {
      mounted: { getSnapshot: () => undefined },
      openTab: kind => { opened.push(kind) },
    }

    expect(applyAssistantDetail(hero, 'assistant-2')).toBe(false)
    expect(applyAssistantDetail(undefined, 'assistant-2')).toBe(false)
    expect(opened).toEqual([])
    // The identity still travels: a later open shows the helper the user chose.
    expect(assistantDetailTarget.getSnapshot()).toBe('assistant-2')
  })

  it('survives a host that refuses the write', () => {
    const sidebar: DetailSidebar = {
      mounted: { getSnapshot: () => 'session-main' },
      openTab: () => { throw new Error('sidebarRight: no session surface is mounted') },
    }

    expect(applyAssistantDetail(sidebar, 'assistant-3')).toBe(false)
  })
})

describe('native pane wiring', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dsh: { client: { inject: string[] } }
    peerDependencies: Record<string, string>
  }

  it('declares the host package statically, as the contract requires', () => {
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar-right')
    expect(pkg.peerDependencies['@deepseek-ai/dsh-client-ui-sidebar-right']).toBe('^0.2.1-rc.2')
  })

  it('registers the page type with a function title, under the same id', () => {
    const client = source('index.tsx')

    expect(client).toContain("ctx.inject(['sidebarRight', 'sidebarRightTabs']")
    expect(client).toContain('native.sidebarRightTabs.register({')
    expect(client).toContain('id: DETAIL_TAB_ID')
    expect(client).toContain('kind: DETAIL_TAB_KIND')
    expect(client).toContain('title: () => DETAIL_TAB_TITLE')
    expect(client).toContain("native.slots.inject('sidebar.right.pane.tab'")
    expect(client).toContain('key: DETAIL_TAB_ID')
  })

  it('injects the module-level target and owns the layout write in a listener', () => {
    const client = source('index.tsx')

    expect(client).toContain('inject: () => ({ state: assistantDetailTarget })')
    expect(client).toContain('window.addEventListener(OPEN_ASSISTANT_SETTINGS_EVENT, open)')
    expect(client).toContain('applyAssistantDetail(native.sidebarRight, detail.assistantId)')
    expect(client).toContain('window.removeEventListener(OPEN_ASSISTANT_SETTINGS_EVENT, open)')
  })

  it('never reads the sidebar selection for the pane identity', () => {
    const pane = source('assistant-settings-pane.tsx')

    expect(pane).toContain('useSyncExternalStore(state.subscribe, state.getSnapshot, state.getServerSnapshot)')
    expect(pane).not.toContain('selectedAssistantId')
    expect(pane).not.toContain('useAgentTeamUi')
  })

  it('lets the row menu publish an event instead of calling the layout', () => {
    const pane = source('assistant-settings-pane.tsx')
    const sidebar = source('assistant-sidebar.tsx')

    expect(pane).toContain('window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_SETTINGS_EVENT')
    expect(sidebar).toContain('openAssistantDetail(instance.id)')
    expect(sidebar).not.toContain('AssistantSettingsDialog')
    expect(sidebar).not.toContain("id === 'detail'")
  })

  it('keeps no modal of its own', () => {
    const pane = source('assistant-settings-pane.tsx')

    expect(pane).not.toContain('AnimatedModal')
    expect(pane).not.toContain('createPortal')
    expect(pane).toContain("import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'")
  })
})

describe('记忆 edits inside the pane', () => {
  it('writes memory from the pane modules, not from a dialog', () => {
    const memory = source('assistant-memory-panel.tsx')

    expect(memory).toContain("callAgentTeam('assistant.memory.get'")
    expect(memory).toContain("callAgentTeam('assistant.memory.entry.write'")
    expect(memory).toContain("callAgentTeam('assistant.memory.write'")
    expect(memory).toContain("callAgentTeam('assistant.memory.undo'")
    expect(source('assistant-settings-pane.tsx')).toContain('<AssistantMemorySection assistantId={assistant.id} />')
  })
})
