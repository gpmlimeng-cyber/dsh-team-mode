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
  assistantHistoryRows,
} = await import('../src/client/assistant-detail.js')

const {
  AssistantDetailBody,
  AssistantDetailPanel,
  applyAssistantDetail,
  assistantAvatarPatch,
  assistantDetailTarget,
  assistantNamePatch,
  assistantPatchQueue,
  assistantTitlePatch,
  createPatchQueue,
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

/** The settings-row labels in document order (the rows use shared primitives). */
function rowLabels(html: string): string[] {
  return [...html.matchAll(/class="[^"]*settingsRowLabel[^"]*">([^<]+)</g)]
    .flatMap(match => (match[1] === undefined ? [] : [match[1].trim()]))
}

function renderPanel(value: AssistantInstanceView | undefined): string {
  return renderToStaticMarkup(createElement(AssistantDetailPanel, {
    ...(value === undefined ? {} : { instance: value }),
    expanded: true,
  }))
}

describe('assistant detail helpers', () => {
  it('counts the main session plus visible threads only', () => {
    expect(assistantBoundSessionCount(instance())).toBe(3)
    expect(assistantBoundSessionCount({ threadSessionIds: ['a'] })).toBe(1)
    expect(assistantBoundSessionCount({})).toBe(0)
  })
})

describe('assistant detail continuous layout', () => {
  it('is one continuous page: no folds, no search box and no save bar', () => {
    const html = renderPanel(instance())
    const view = text(html)

    expect(html).toContain('data-dsh-assistant-detail')
    expect(html).not.toContain('<details')
    expect(html).not.toContain('data-dsh-fold')
    expect(html).not.toContain('aria-label="搜索设置"')
    expect(html).not.toContain('settingsSearch')
    expect(html).not.toContain('settingsSaveBar')
    // The one explicit save left on the page belongs to 指令.
    expect(view).toContain('保存人设')
    expect(html).not.toContain('>保存</button>')
  })

  it('starts with the avatar over full-width 名称 / 称号 / 指令 fields', () => {
    const html = renderPanel(instance())
    const view = text(html)

    expect(html).toContain('data-dsh-assistant-avatar-hero')
    expect(html).toMatch(/data-dsh-assistant-avatar-hero[\s\S]*?width:64px/)
    expect(view).toContain('小码')
    expect(view).toContain('前端 · 空闲')
    expect(html).toMatch(/<button[^>]*aria-label="编辑头像"[^>]*aria-expanded="false"/)
    expect(html).not.toContain('data-dsh-avatar-editor')
    // 一句话介绍 is not in the reference layout; the create dialog still has it.
    expect(view).not.toContain('一句话介绍')

    const hero = html.indexOf('data-dsh-assistant-avatar-hero')
    const name = html.indexOf('aria-label="名称"')
    const title = html.indexOf('aria-label="称号"')
    const instructions = html.indexOf('data-dsh-assistant-section="instructions"')
    expect(hero).toBeGreaterThan(-1)
    expect(hero).toBeLessThan(name)
    expect(name).toBeLessThan(title)
    expect(title).toBeLessThan(instructions)

    // 指令 keeps its own explicit save instead of riding the write-through.
    expect(html).toContain('aria-label="人设说明"')
    expect(html).toContain('保存人设')

    // Full-width fields, not the dialog's label-left/control-right row.
    const cssSource = readFileSync(
      new URL('../src/client/AgentTeam.module.css', import.meta.url),
      'utf8',
    )
    expect(cssSource).toContain('.assistantIdentityField .input {')
    expect(cssSource.slice(cssSource.indexOf('.assistantIdentityField .input {')))
      .toContain('width: 100%;')
  })

  it('reads 核心 / 备用模型 / 已知 / 行为 / 规则 in the reference order', () => {
    const html = renderPanel(instance())
    const view = text(html)
    const sectionAt = (id: string): number => html.indexOf(`data-dsh-assistant-section="${id}"`)

    expect(sectionAt('identity')).toBeLessThan(sectionAt('instructions'))
    expect(sectionAt('instructions')).toBeLessThan(sectionAt('core'))
    expect(sectionAt('core')).toBeLessThan(sectionAt('fallback'))
    expect(sectionAt('fallback')).toBeLessThan(sectionAt('known'))
    expect(sectionAt('known')).toBeLessThan(sectionAt('behavior'))
    expect(sectionAt('behavior')).toBeLessThan(sectionAt('rules'))

    for (const heading of ['核心', '备用模型', '已知', '行为', '规则']) {
      expect(view).toContain(heading)
    }
    expect(view.indexOf('核心')).toBeLessThan(view.indexOf('备用模型'))
    expect(view.indexOf('备用模型')).toBeLessThan(view.indexOf('已知'))
    expect(view.indexOf('已知')).toBeLessThan(view.indexOf('行为'))
    expect(view.indexOf('行为')).toBeLessThan(view.indexOf('规则'))

    // 核心: the model and reasoning rows, split from the merged control.
    const rows = rowLabels(html)
    expect(rows).toEqual([
      '模型', '推理', '备用模型', 'MCP', '文件', '数据表', '发布助手', '权限', '通知',
    ])
    const pane = source('assistant-settings-pane.tsx')
    expect((pane.match(/<ModelControl/g) ?? [])).toHaveLength(2)
    expect(pane).toContain('section="model"')
    expect(pane).toContain('section="reasoning"')

    // 已知 / 行为 rows exist over the real editors.
    for (const section of ['memory', 'skills', 'automations', 'usage', 'history']) {
      expect(html).toContain(`data-dsh-assistant-block="${section}"`)
    }
    expect(view).toContain('记忆')
    expect(view).toContain('技能')
    expect(view).toContain('文件')
    expect(view).toContain('数据表')
    expect(view).toContain('自动化任务')
    expect(view).toContain('用量')
    expect(view).toContain('发布助手')
    expect(view).toContain('权限')
    expect(view).toContain('通知')
    expect(view).toContain('高级')
  })

  it('renders 备用模型/数据表/发布助手/通知 as disabled 暂不支持 rows', () => {
    const html = renderPanel(instance())

    for (const label of ['备用模型', '数据表', '发布助手', '通知']) {
      const marker = `data-dsh-assistant-unsupported="${label}"`
      expect(html).toContain(marker)
      const control = html.slice(html.indexOf(marker))
      expect(control.slice(0, control.indexOf('</span>'))).toContain('暂不支持')
      expect(html).toContain('aria-disabled="true"')
    }
    expect((html.match(/data-dsh-assistant-unsupported=/g) ?? [])).toHaveLength(4)
  })

  it('removes 现在 and 概览 from this page', () => {
    const html = renderPanel(instance())
    const view = text(html)

    expect(view).not.toContain('现在')
    expect(view).not.toContain('概览')
    expect(html).not.toContain('data-dsh-assistant-now')
    expect(html).not.toContain('data-dsh-assistant-overview')
    const pane = source('assistant-settings-pane.tsx')
    expect(pane).not.toContain('AssistantNowBlock')
    expect(pane).not.toContain('AssistantOverviewBlock')
  })

  it('turns a blur into one single-field patch, never the whole snapshot', () => {
    expect(assistantNamePatch(instance(), '小码')).toBeUndefined()
    expect(assistantNamePatch(instance(), '  ')).toBeUndefined()
    expect(assistantNamePatch(instance(), ' 新名字 ')).toEqual({ name: '新名字' })
    expect(assistantTitlePatch(instance(), '')).toBeUndefined()
    expect(assistantTitlePatch(instance(), ' 后端工程师 ')).toEqual({ title: '后端工程师' })

    const withMascot = instance({ mascot: { seed: 'assistant-1' } })
    const draft = {
      seed: 'assistant-1',
      mascot: {},
      avatar: 'data:image/png;base64,AAAA',
    }
    expect(assistantAvatarPatch(withMascot, draft)).toBeUndefined()
    const avatar = assistantAvatarPatch(withMascot, { ...draft, avatar: 'data:image/png;base64,BBBB' })
    expect(avatar).toEqual({ avatar: 'data:image/png;base64,BBBB' })
    expect(avatar).not.toHaveProperty('name')
  })

  it('serializes a text write and the avatar debounce so both fields land', async () => {
    let stored: Record<string, unknown> = { name: '旧名', avatar: 'old' }
    let active = 0
    let maxActive = 0
    // The service reads the whole snapshot, then writes it verbatim. A parallel
    // second write would overwrite the first with its stale copy — this fake
    // reproduces that shape so the test fails if the queue ever unlinks.
    const queue = createPatchQueue(async patch => {
      const current = { ...stored }
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      stored = { ...current, ...patch }
      active -= 1
    })

    // The avatar debounce fires while the name blur write is still running:
    // both go through the same queue and both fields survive.
    const name = queue.enqueue({ name: '新名' })
    await new Promise(resolve => setTimeout(resolve, 1))
    const avatar = queue.enqueue({ avatar: 'data:image/png;base64,BBBB' })
    await Promise.all([name, avatar])

    expect(maxActive).toBe(1)
    expect(stored).toEqual({ name: '新名', avatar: 'data:image/png;base64,BBBB' })
  })

  it('keeps the queue usable after a failed write, so a retry can still land', async () => {
    const sent: Array<Record<string, unknown>> = []
    const queue = createPatchQueue(async patch => {
      sent.push(patch)
      if (sent.length === 1) throw new Error('offline')
    })

    await expect(queue.enqueue({ name: '新名' })).rejects.toThrow('offline')
    await queue.enqueue({ avatar: 'data:image/png;base64,BBBB' })
    expect(sent).toEqual([{ name: '新名' }, { avatar: 'data:image/png;base64,BBBB' }])
    await expect(queue.idle()).resolves.toBeUndefined()
  })

  it('shares one write queue across pane remounts for the same assistant', async () => {
    const first = assistantPatchQueue('shared-assistant', async () => {})
    const second = assistantPatchQueue('shared-assistant', async () => {})
    expect(second).toBe(first)
    await first.idle()
  })

  it('routes 保存人设 through the same queue as field writes', async () => {
    const sent: Array<Record<string, unknown>> = []
    const queue = createPatchQueue(async patch => { sent.push(patch) })

    await Promise.all([
      queue.enqueue({ name: '新名' }),
      queue.enqueue({ instructions: '新指令' }),
    ])
    expect(sent).toEqual([{ name: '新名' }, { instructions: '新指令' }])

    // Secondary guard: the pane hands the persona save the same sender, and
    // gates both directions of the overlap.
    const pane = source('assistant-settings-pane.tsx')
    const personaStart = pane.indexOf('<PersonaSection')
    const persona = pane.slice(personaStart, pane.indexOf('/>', personaStart))
    expect(persona).toContain('write={value => send(value)}')
    expect(persona).toContain('onSavingChange={setPersonaSaving}')
    expect(persona).toContain('disabled={busy}')
    const detail = source('assistant-detail.tsx')
    expect(detail).toContain('void write({ instructions: draft }).then(')
    expect(detail).toContain('disabled={!dirty || saving || disabled}')
  })

  it('writes each row through on blur/debounce and reports inline', () => {
    const pane = source('assistant-settings-pane.tsx')

    // Text identity fields commit on blur.
    expect(pane).toContain('onBlur={() => { void commitName() }}')
    expect(pane).toContain('onBlur={() => { void commitTitle() }}')
    // The avatar writes its settled draft through a debounce.
    expect(pane).toContain('const timer = window.setTimeout(() => {')
    expect(pane).toContain('void commitAvatar()')
    expect(pane).toContain('}, 600)')
    // Selects and capability toggles write on change.
    expect(pane).toContain('onChange={next => { void commitPermission(next) }}')
    expect(pane).toContain("commitCapabilities('skills', next)")
    expect(pane).toContain("commitCapabilities('mcpServers', next)")
    // One shared per-assistant queue, with inline saving/saved/error feedback.
    expect(pane).toContain("await callAgentTeam('assistant.instance.update'")
    expect(pane).toContain('assistantPatchQueue(assistant.id')
    expect(pane).toContain('const run = tail.then(() => send(patch), () => send(patch))')
    expect(pane).not.toContain('if (savingKey !== undefined) return false')
    expect(pane).toContain('flushAvatarRef.current()')
    expect(pane).toContain('mounted.current = false')
    expect(pane).toContain('if (!saved) avatarDirty.current = true')
    expect(pane).toContain("setFeedback({ key, kind: 'saved' })")
    expect(pane).toContain("setFeedback({ key, kind: 'error', message: failure })")
    expect(pane).toContain('data-dsh-assistant-save-status="saved"')
    expect(pane).toContain('data-dsh-assistant-save-status="error"')
    // No staged identity save bar and no multi-field save.
    expect(pane).not.toContain('settingsSaveBar')
    expect(pane).not.toContain('function save()')
    expect(pane).not.toContain('const value: UpdateAssistantInstanceInput = { name: displayName }')
    // 指令 keeps its own save.
    expect(pane).toContain('<PersonaSection')
  })

  it('keeps the preserved editors and lifecycle actions', () => {
    const html = renderPanel(instance())
    const view = text(html)

    expect(html).toContain('aria-label="助手持久记忆"')
    expect(html).toContain('选择助手可使用的 Skills')
    expect(html).toContain('选择助手可使用的 MCP Server')
    expect(html).toContain('data-dsh-usage-section')
    expect(html).toContain('data-dsh-assistant-detail-section="history"')
    expect(view).toContain('/tmp/workspace-1')
    expect(html).toContain('data-dsh-assistant-rules-action="compact"')
    expect(html).toContain('data-dsh-assistant-rules-action="relationship"')
    expect(view).toContain('暂停运行')
    expect(view).toContain('归档助手')
  })

  it('lifts the mobile fullscreen rightbar above the header, clear of the notch', () => {
    const cssSource = readFileSync(
      new URL('../src/client/AgentTeam.module.css', import.meta.url),
      'utf8',
    )
    const marker = '@media (max-width: 767px)'
    const at = cssSource.indexOf(marker)
    expect(at).toBeGreaterThan(-1)
    const block = cssSource.slice(at)

    // The host's fullscreen panel is the native rightbar, not a plugin overlay.
    expect(block).toContain("[data-sidebar-right-panel='fullscreen']")
    expect(block).toContain('z-index: 60;')
    expect(block).toContain('padding-top: calc(8px + env(safe-area-inset-top, 0px));')
    // Narrow-screen only, so desktop stacking is untouched.
    expect(cssSource.lastIndexOf('z-index: 60;')).toBeGreaterThan(at)
    expect(cssSource.slice(0, at)).not.toContain('z-index: 60;')
  })

  it('keeps a lifecycle error and lets compaction block the lifecycle actions', () => {
    const pane = source('assistant-settings-pane.tsx')
    const start = pane.indexOf('async function write(')
    const writeBody = pane.slice(start, pane.indexOf('/** 名称 writes', start))
    // A field write clears only its own row feedback, never the page error.
    expect(writeBody).not.toContain('setError(')
    expect(writeBody).toContain('current.key === key')

    // Compaction joins busy, so pause/archive/restore cannot overlap it.
    expect(pane).toMatch(/const busy = [\s\S]{0,200}compacting/)
    expect(pane).toContain('disabled={busy || compacting}')
  })

  it('shows the empty instruction when no helper was opened', () => {
    const html = renderPanel(undefined)
    const view = text(html)

    expect(view).toBe('从左侧选择一个助手')
    expect(html).toContain('data-dsh-assistant-detail-empty')
    expect(html).not.toContain('data-dsh-assistant-section')
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
