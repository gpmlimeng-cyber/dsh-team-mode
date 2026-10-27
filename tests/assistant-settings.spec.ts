import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AssistantMemory, MemoryEntry } from '../src/domain/types.js'
import type { AssistantCreateDraft } from '../src/client/assistant-form.js'
import type { AssistantCreateBodyProps, AssistantCreateFooterProps } from '../src/client/assistant-dialogs.js'

// The primitives package needs browser peers this node test does not install.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Stub = (): unknown => createElement('div')
  // Keep the real element shape for the dialog footer assertions: text,
  // disabled state and form association are what those tests read.
  const Button = (props: {
    children?: unknown
    disabled?: boolean
    type?: 'button' | 'submit'
    form?: string
  }): unknown => createElement(
    'button',
    { type: props.type ?? 'button', disabled: props.disabled, form: props.form },
    props.children as never,
  )
  // The capability picker is the shipped Checkbox; keep the native input so
  // checked/disabled state stays readable from the rendered markup.
  const Checkbox = (props: {
    checked: boolean
    label: string
    disabled?: boolean
    title?: string
  }): unknown => createElement(
    'label',
    { title: props.title },
    createElement('input', {
      type: 'checkbox',
      checked: props.checked,
      disabled: props.disabled,
      readOnly: true,
    }),
    createElement('span', undefined, props.label),
  )
  // The pill select is the shipped Menu around our trigger; closed renders the
  // anchor only, which is exactly what a server-rendered dialog shows.
  const Menu = (props: { anchor?: unknown }): unknown =>
    createElement('span', { 'data-menu': '' }, props.anchor as never)
  const Switch = (props: {
    checked: boolean
    label: string
    disabled?: boolean
  }): unknown => createElement('input', {
    type: 'checkbox',
    role: 'switch',
    'aria-label': props.label,
    checked: props.checked,
    disabled: props.disabled,
    readOnly: true,
  })
  const Icon = (): unknown => createElement('span')
  return { Button, Checkbox, Menu, Switch, IconChevronDownOutlineRegular: Icon, Modal: Stub }
})

const { memoryAfterUndo } = await import('../src/client/assistant-settings-dialog.js')
const { AssistantCreateBody, AssistantCreateFooter } = await import('../src/client/assistant-dialogs.js')

const NOW = '2026-10-23T00:00:00.000Z'

function entry(): MemoryEntry {
  return {
    id: 'mem-1',
    scope: 'assistant',
    visibility: 'private',
    status: 'active',
    source: 'assistant',
    title: 'Tone',
    body: 'Be terse.',
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

describe('assistant settings memory panel', () => {
  it('stores the undo envelope’s memory document instead of the envelope', () => {
    const memory: AssistantMemory = {
      schemaVersion: 1,
      assistantId: 'instance-1',
      content: 'Restored note.',
      entries: [entry()],
      revision: 4,
      updatedAt: NOW,
    }

    // The panel's undo path uses this helper; the wire value is the same
    // `{ memory, entry }` shape as assistant.memory.entry.write.
    const next = memoryAfterUndo({ memory, entry: entry() })
    expect(next).toBe(memory)
    expect(next.content).toBe('Restored note.')
    expect(next.revision).toBe(4)
    expect(next.entries?.[0]?.body).toBe('Be terse.')
  })
})

describe('assistant settings coordinator marker', () => {
  const source = readFileSync(
    new URL('../src/client/assistant-settings-dialog.tsx', import.meta.url),
    'utf8',
  )

  it('shows 总协调 for every assistant, so 否 does not read as "unsupported"', () => {
    expect(source).toContain('>总协调<')
    expect(source).toContain("isCoordinatorInstance(assistant) ? '是' : '否'")
    expect(source).toContain('data-dsh-assistant-settings-coordinator')
  })

  it('edits the same two capability lists the create dialog writes', () => {
    // Both lists are shown, seeded from the saved snapshot, and written back
    // through the instance update only when they actually changed.
    expect((source.match(/<CapabilityPicker/g) ?? [])).toHaveLength(2)
    expect(source).toContain('assistant.assistantSnapshot.skillAllowlist')
    expect(source).toContain('assistant.assistantSnapshot.mcpServers')
    expect(source).toContain('value.skillAllowlist =')
    expect(source).toContain('value.mcpServers =')
    expect(source).toMatch(/callAgentTeam\('assistant\.instance\.update'/)
  })
})

const CREATE_DRAFT: AssistantCreateDraft = {
  name: '工程师',
  avatar: '',
  instructions: '先读代码，再给最小实现。',
  provider: 'deepseek',
  model: 'flash',
  reasoningEffort: '',
  workspaceId: 'ws-1',
  agentPresetId: 'standard',
  permissionPresetId: 'workspace-write',
  group: '',
  mascotSeed: 'seed-1',
  mascotShape: '',
  mascotEyes: '',
  mascotColor: '',
  mascotFill: '',
  skillAllowlist: [],
  mcpServers: [],
}

function baseCreateBodyProps(): AssistantCreateBodyProps {
  return {
    loading: false,
    saving: false,
    locked: false,
    catalogError: undefined,
    error: undefined,
    warning: undefined,
    banner: undefined,
    activeSection: 'identity',
    draft: CREATE_DRAFT,
    roles: [],
    roleError: undefined,
    groups: [],
    workspaces: [{ id: 'ws-1', title: '主工作区' }],
    modelGroups: [{
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      models: [{ id: 'flash', label: 'Flash — DeepSeek' }],
    }],
    reasoningOptions: [{ id: 'high', label: 'High' }],
    defaultReasoning: '模型默认（Medium）',
    capabilityError: undefined,
    skills: [],
    mcpServers: [],
    capabilitiesLoading: false,
    capabilitiesError: undefined,
    agentPresets: [{ id: 'standard', name: 'Standard' }],
    permissionPresets: [{ value: 'workspace-write', name: 'Workspace write' }],
    onSectionChange: () => undefined,
    onDraftChange: () => undefined,
    onRoleSelect: () => undefined,
    onRetryCatalog: () => undefined,
    onAvatarFile: () => undefined,
  }
}

function renderCreateBody(overrides: Partial<AssistantCreateBodyProps> = {}): string {
  const props: AssistantCreateBodyProps = { ...baseCreateBodyProps(), ...overrides }
  return renderToStaticMarkup(createElement(AssistantCreateBody, props))
}

function renderCreateFooter(overrides: Partial<AssistantCreateFooterProps> = {}): string {
  const props: AssistantCreateFooterProps = {
    loading: false,
    saving: false,
    locked: false,
    canCreate: true,
    onCancel: () => undefined,
    ...overrides,
  }
  return renderToStaticMarkup(createElement(AssistantCreateFooter, props))
}

function navMarkup(html: string): string {
  return html.slice(html.indexOf('<nav'), html.indexOf('</nav>') + '</nav>'.length)
}

describe('assistant create dialog shell', () => {
  it('renders four real sections with exactly one current item', () => {
    const html = renderCreateBody()
    const nav = navMarkup(html)
    expect(nav).toContain('aria-label="创建助手的区块"')
    expect((nav.match(/<button/g) ?? [])).toHaveLength(4)
    expect((nav.match(/aria-current="page"/g) ?? [])).toHaveLength(1)
    for (const label of ['身份', '人设', '模型与环境', '权限']) {
      expect(nav).toContain(`>${label}<`)
    }
    for (const label of ['记忆', '技能', '例程', '访问', '语音与通知']) {
      expect(nav).not.toContain(`>${label}<`)
    }
  })

  it('marks the selected section and renders only that pane', () => {
    const html = renderCreateBody({ activeSection: 'model' })
    const nav = navMarkup(html)
    expect(nav).toContain('aria-current="page"')
    expect(html).toContain('<section')
    expect(html).toContain('Workspace')
    expect(html).toContain('模型与环境')
    // The identity fields are not mounted: switching sections does not render
    // hidden controls that could write.
    expect(html).not.toContain('起始角色')
  })

  it('explains the remaining unsupported areas instead of offering them as tabs', () => {
    const html = renderCreateBody()
    expect(html).toContain('<details')
    expect(html).toContain('<summary>还有 4 项创建时不提供</summary>')
    expect(html).toContain('aria-label="未提供的区块"')
    for (const text of [
      '创建后在助手设置/记忆面板维护',
      '本插件没有按助手的定时任务',
      '只保留 Workspace',
      '通知沿用 DSH 全局行为',
    ]) {
      expect(html).toContain(text)
    }
    // Skills and MCP are real instance fields now, so they are not listed as missing.
    expect(html).not.toContain('实例快照不开放技能与 MCP 字段')
  })

  it('shows the workspace banner only when it was supplied', () => {
    expect(renderCreateBody()).not.toContain('中创建')
    expect(renderCreateBody({ banner: '将在「主工作区」中创建 · 可在「模型与环境」切换' }))
      .toContain('将在「主工作区」中创建')
  })
})

describe('dialog furniture', () => {
  const createSource = readFileSync(
    new URL('../src/client/assistant-dialogs.tsx', import.meta.url),
    'utf8',
  )
  const settingsSource = readFileSync(
    new URL('../src/client/assistant-settings-dialog.tsx', import.meta.url),
    'utf8',
  )
  const activitySource = readFileSync(
    new URL('../src/client/team-activity.tsx', import.meta.url),
    'utf8',
  )
  const moduleCss = readFileSync(
    new URL('../src/client/AgentTeam.module.css', import.meta.url),
    'utf8',
  )

  it('writes every field in both dialogs as one setting per row', () => {
    for (const source of [createSource, settingsSource]) {
      expect(source).toContain('settings-row.js')
      expect(source).toMatch(/<SettingsRows>/)
      expect(source).toMatch(/<SettingsRow\b/)
      // The old labelled-field and native-dropdown pair is gone.
      expect(source).not.toMatch(/<select[\s>]/)
      expect(source).not.toMatch(/<option\b/)
    }
    // The create dialog has no free-floating Field left.
    expect(createSource).not.toMatch(/<Field\b/)
  })

  it('renders the rows as label/hint left and control right', () => {
    expect(moduleCss).toContain('.settingsRow {')
    expect(moduleCss).toContain('.settingsRowCopy {')
    expect(moduleCss).toContain('.settingsRowControl {')
    const body = renderCreateBody({ activeSection: 'model' })
    expect(body).toMatch(/class="[^"]*settingsRow[^"]*"/)
    expect(body).toMatch(/class="[^"]*settingsRowHint[^"]*"/)
  })

  it('uses the shipped Switch for toggles instead of a checkbox row', () => {
    expect(activitySource).toContain('Switch')
    expect((activitySource.match(/<Switch/g) ?? [])).toHaveLength(2)
    expect(activitySource).not.toContain('type="checkbox"')
    expect(settingsSource).toMatch(/<Switch\b/)
    expect(settingsSource).not.toContain('type="checkbox"')
  })

  it('shares one compact header rule across every AnimatedModal', () => {
    // One rule, scoped to the dialog's own header — no per-dialog copy.
    expect((moduleCss.match(/class\*="header"/g) ?? [])).toHaveLength(1)
    const rule = moduleCss.slice(
      moduleCss.indexOf('.teamModal > [class*="content"] > [class*="header"] {'),
    )
    expect(rule.slice(0, rule.indexOf('}'))).toContain('padding: 14px 12px 2px 20px')
    expect(moduleCss).toContain('.teamModal > [class*="content"] > [class*="description"] {')
  })
})

describe('assistant create dialog sections', () => {
  it('identity collects a starting role, avatar, name and optional group', () => {
    const html = renderCreateBody({
      roles: [{
        schemaVersion: 1,
        id: 'template-1',
        name: '工程师',
        instructions: '',
        provider: 'deepseek',
        model: 'flash',
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
        createdAt: '2026-10-26T00:00:00Z',
        updatedAt: '2026-10-26T00:00:00Z',
      }],
      groups: ['工作', '学习'],
    })
    const section = html.slice(html.indexOf('<section'), html.indexOf('</section>'))
    expect(section).toContain('起始角色')
    expect(section).toContain('上传本地头像')
    expect(section).toContain('aria-label="助手名称"')
    // The starting role and group are pill selects; a closed pill shows its
    // current value, and the template names live in the opened menu.
    expect(section).toContain('自定义配置')
    expect(section).toContain('>不分组<')
    expect(section).not.toContain('<select')
    expect((section.match(/data-menu/g) ?? [])).toHaveLength(2)
  })

  it('shows the chosen group in the pill instead of a browser select', () => {
    const html = renderCreateBody({ groups: ['工作'], draft: { ...CREATE_DRAFT, group: '工作' } })
    const section = html.slice(html.indexOf('<section'), html.indexOf('</section>'))
    expect(section).toContain('>工作<')
    expect(section).not.toContain('<select')
  })

  it('explains the empty group state instead of rendering an empty picker', () => {
    const html = renderCreateBody()
    const section = html.slice(html.indexOf('<section'), html.indexOf('</section>'))
    expect(section).toContain('还没有分组；先在侧栏新建分组')
    expect(section).not.toContain('>不分组<')
  })

  it('persona is an editable instructions control', () => {
    const html = renderCreateBody({ activeSection: 'persona' })
    expect(html).toContain('aria-label="人设"')
    expect(html).toContain('先读代码，再给最小实现。')
    expect(html).toContain('留空则使用 Agent Preset 默认')
  })

  it('model and environment writes workspace, model, reasoning and preset', () => {
    const html = renderCreateBody({ activeSection: 'model' })
    expect(html).toContain('Workspace')
    expect(html).toContain('主工作区')
    expect(html).toContain('Flash — DeepSeek')
    expect(html).toContain('思考模式')
    expect(html).toContain('模型默认（Medium）')
    expect(html).toContain('Agent Preset')
    expect(html).toContain('>Standard<')
  })

  it('capabilities are part of 模型与环境 and start unchecked for a direct create', () => {
    const html = renderCreateBody({ activeSection: 'model' })
    expect(html).toContain('>能力<')
    expect(html).toContain('技能（已选 0 个）')
    expect(html).toContain('MCP（已选 0 个）')
    expect(html).toContain('该 Agent Preset 没有可用的 Skill。')
    expect(html).toContain('该 Agent Preset 没有可用的 MCP Server。')
  })

  it('ticks the catalog entries a role brought in and disables the lost ones', () => {
    const resolved = renderCreateBody({
      activeSection: 'model',
      draft: { ...CREATE_DRAFT, skillAllowlist: ['research'], mcpServers: ['github'] },
      skills: [{ name: 'research', detail: '查资料' }],
      mcpServers: [{ name: 'github', detail: '4 个工具' }],
    })
    expect(resolved).toContain('技能（已选 1 个）')
    expect(resolved).toContain('MCP（已选 1 个）')
    expect(resolved).toContain('>research<')
    expect(resolved).toContain('查资料')
    expect(resolved).toContain('4 个工具')
    expect(resolved).not.toContain('不可用')

    const stale = renderCreateBody({
      activeSection: 'model',
      draft: { ...CREATE_DRAFT, skillAllowlist: ['retired-skill'] },
      skills: [{ name: 'research', detail: '查资料' }],
    })
    // A stored Skill the preset no longer offers stays visible, refused and explained.
    expect(stale).toContain('retired-skill（不可用）')
    expect(stale).toContain('该 Agent Preset 不再提供这个 Skill，保存时不会带上')
    expect(stale).toMatch(/data-capability-unavailable="true"/)
    expect(stale).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/)
  })

  it('permissions writes the preset and states the coordinator is set elsewhere', () => {
    const html = renderCreateBody({ activeSection: 'permissions' })
    expect(html).toContain('权限预设')
    expect(html).toContain('工作区可写')
    expect(html).toContain('只影响之后创建或恢复的会话')
    expect(html).toContain('总协调（Coordinator）在侧栏行菜单设置，创建时不设。')
  })

  it('hides the role picker when the template read failed but keeps the form usable', () => {
    const html = renderCreateBody({ roleError: '模板服务不可用' })
    const section = html.slice(html.indexOf('<section'), html.indexOf('</section>'))
    expect(section).toContain('读取助手模板失败：模板服务不可用')
    // The row stays (the reason replaces the control), but no picker opens.
    expect(section).not.toContain('aria-label="起始角色"')
  })
})

describe('assistant create mascot section', () => {
  /** The create dialog's 形象 preview: the first mascot `<img>` in the details. */
  function previewSource(html: string): string {
    const at = html.indexOf('data-dsh-assistant-create-mascot')
    const img = html.indexOf('<img', at)
    return /src="([^"]+)"/.exec(html.slice(img))?.[1] ?? ''
  }

  function mascotDetails(html: string): string {
    const start = html.indexOf('data-dsh-assistant-create-mascot')
    return html.slice(start, html.indexOf('</details>', start))
  }

  it('is expanded by default and opens onto the shared picker', () => {
    const html = renderCreateBody()
    const tag = /<details[^>]*data-dsh-assistant-create-mascot[^>]*>/.exec(html)?.[0] ?? ''
    expect(tag).not.toBe('')
    // `open`: the shipped section starts unfolded, so the look is picked in place.
    expect(tag).toContain('open')
    const details = mascotDetails(html)
    expect(details).toContain('>形象<')
    // Same three MausBot-style sections as the settings dialog.
    expect(details).toContain('data-dsh-mascot-picker')
    expect(details).toContain('>表情<')
    expect(details).toContain('>颜色<')
    expect(details).toContain('>身体<')
  })

  it('re-renders the preview as soon as an option changes', () => {
    const dots = renderCreateBody({ draft: { ...CREATE_DRAFT, mascotEyes: 'dots' } })
    const big = renderCreateBody({ draft: { ...CREATE_DRAFT, mascotEyes: 'big' } })
    expect(previewSource(dots)).not.toBe('')
    expect(previewSource(dots)).not.toBe(previewSource(big))
    // Exactly one tile is pressed (the eyes group); the selection follows the draft.
    expect((mascotDetails(dots).match(/aria-pressed="true"/g) ?? [])).toHaveLength(1)
    expect((mascotDetails(big).match(/aria-pressed="true"/g) ?? [])).toHaveLength(1)
  })
})

describe('assistant create dialog state', () => {
  it('shows a status message and disables navigation while loading', () => {
    const html = renderCreateBody({ loading: true })
    expect(html).toContain('role="status"')
    expect(html).toContain('正在读取配置…')
    expect(navMarkup(html)).toContain('aria-disabled="true"')
    expect(renderCreateFooter({ loading: true }))
      .toMatch(/<button[^>]*disabled=""[^>]*>创建<\/button>/)
  })

  it('reports a catalog failure with a retry action', () => {
    const html = renderCreateBody({ catalogError: 'catalog offline' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('读取配置失败：catalog offline')
    expect(html).toMatch(/<button[^>]*>重试<\/button>/)
  })

  it('locks every field and the primary action while saving', () => {
    const html = renderCreateBody({ saving: true })
    expect(html).toMatch(/<fieldset[^>]*disabled=""/)
    const footer = renderCreateFooter({ saving: true })
    expect(footer).toMatch(/<button[^>]*disabled=""[^>]*>创建中…<\/button>/)
    expect(footer).toMatch(/<button[^>]*disabled=""[^>]*>取消<\/button>/)
  })

  it('offers only retry-open after the assistant was created', () => {
    const html = renderCreateBody({ locked: true })
    expect(html).toMatch(/<fieldset[^>]*disabled=""/)
    expect(html).toContain('aria-busy="true"')
    expect(renderCreateFooter({ locked: true })).toContain('重试打开')
    expect(renderCreateFooter({ locked: true })).not.toContain('>创建<')
  })

  it('disables the primary action until a name and every required default exist', () => {
    expect(renderCreateFooter({ canCreate: false }))
      .toMatch(/<button[^>]*disabled=""[^>]*>创建<\/button>/)
    expect(renderCreateFooter({ canCreate: true }))
      .not.toMatch(/<button[^>]*disabled=""[^>]*>创建<\/button>/)
  })

  it('shows the non-blocking group warning next to the form', () => {
    const html = renderCreateBody({ warning: '助手已创建，但分组未写入：未知分组' })
    expect(html).toContain('role="status"')
    expect(html).toContain('助手已创建，但分组未写入：未知分组')
  })
})
