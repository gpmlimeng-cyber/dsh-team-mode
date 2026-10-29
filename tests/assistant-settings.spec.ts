import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AssistantMemory, MemoryEntry } from '../src/domain/types.js'
import type { AssistantCreateDraft } from '../src/client/assistant-form.js'
import type { AssistantCreateBodyProps, AssistantCreateFooterProps } from '../src/client/assistant-dialogs.js'
import type { AssistantInstanceView } from '../src/transport/contracts.js'

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
  // The settings pane builds one icon per group at module scope, so every icon
  // it imports must exist here even when the test never renders the pane.
  const PaneIcon = Icon
  return {
    Button,
    Checkbox,
    Menu,
    Switch,
    IconChevronDownOutlineRegular: Icon,
    IconFolderOpenOutlineRegular: Icon,
    IconPlusOutlineRegular: Icon,
    IconSearchOutlineRegular: Icon,
    IconChevronRightOutlineRegular: Icon,
    IconSparkleRegular: Icon,
    IconProjectAddOutlineRegular: Icon,
    IconArchiveOutlineRegular: PaneIcon,
    IconClockOutlineRegular: PaneIcon,
    IconDatabaseOutlineRegular: PaneIcon,
    IconEditOutlineRegular: PaneIcon,
    IconFlatListOutlineRegular: PaneIcon,
    IconInfoOutlineRegular: PaneIcon,
    IconPersonalizationOutlineRegular: PaneIcon,
    IconSlidersTwoOutlineRegular: PaneIcon,
    IconShieldOutlineRegular: PaneIcon,
    Modal: Stub,
  }
})

const {
  memoryAcceptanceInput,
  memoryAfterUndo,
  memoryWriteFailure,
} = await import('../src/client/assistant-memory-panel.js')
const { AssistantCreateBody, AssistantCreateFooter } = await import('../src/client/assistant-dialogs.js')
const { AssistantDetailPanel } = await import('../src/client/assistant-settings-pane.js')
const {
  UsageSection,
  assistantUsageScope,
  installUsageSessions,
  usageReport,
} = await import('../src/client/usage.js')
const { assistantMemoryCountLine } = await import('../src/client/assistant-overview.js')

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

function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

describe('assistant memory panel wiring', () => {
  const memoryPanel = readFileSync(
    new URL('../src/client/assistant-memory-panel.tsx', import.meta.url),
    'utf8',
  )

  it('renders the default-off auto-capture switch and a batch ignore', () => {
    expect(memoryPanel).toContain('自动记录')
    expect(memoryPanel).toContain('type="checkbox"')
    expect(memoryPanel).toContain('默认关闭')
    // The extra model call is stated, not hidden: it costs money every turn.
    expect(memoryPanel).toContain('额外费用')
    expect(memoryPanel).toContain('只写成「待确认」条目')
    expect(memoryPanel).toContain("callAgentTeam('assistant.memory.autoCapture.set'")
    expect(memoryPanel).toContain('全部忽略')
    // Batch ignore archives through the same revision-fenced entry write path.
    expect(memoryPanel).toContain("status: 'archived'")
    expect(memoryPanel).toContain('expectedRevision: expected')
  })

  it('re-reads the block when the window becomes visible again', () => {
    // An auto-capture write happens with no pane action, so the pane gets the
    // one signal it has: focus / visibilitychange.
    expect(memoryPanel).toContain("window.addEventListener('focus', refresh)")
    expect(memoryPanel).toContain("window.addEventListener('visibilitychange', refresh)")
    expect(memoryPanel).toContain("document.visibilityState === 'hidden'")
    expect(memoryPanel).toContain('void load()')
  })

  it('re-reads after every ask-or-change failure, not only on a conflict', () => {
    // The change path writes proposals one at a time; a later rejection can
    // leave earlier proposals stored, so a failure must re-read to show them.
    expect(memoryPanel).toContain('export function memoryAskFailure')
    expect(memoryPanel).toContain('return { message: memoryError(cause), reload: true }')
  })
})

describe('assistant settings coordinator marker', () => {
  const source = readFileSync(
    new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
    'utf8',
  )

  it('leaves 总协调 out of the duplicated fact table; the hero only marks true', () => {
    // 概览 is a checkup now, not a copy of the detail facts: the coordinator
    // role is set from the sidebar row menu and only named in the hero when on.
    expect(source).not.toContain('>总协调<')
    expect(source).not.toContain("isCoordinatorInstance(assistant) ? '是' : '否'")
    expect(source).not.toContain('data-dsh-assistant-settings-coordinator')
    expect(source).toContain("isCoordinatorInstance(assistant) ? '总协调' : undefined")
  })

  it('edits the same two capability lists the create dialog writes', () => {
    // Both lists are shown, seeded from the saved snapshot, and written back
    // through the instance update only when they actually changed.
    expect((source.match(/<CapabilityList/g) ?? [])).toHaveLength(2)
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
    activeSection: 'identity',
    draft: CREATE_DRAFT,
    roles: [],
    roleError: undefined,
    groups: [],
    workspaces: [{ id: 'ws-1', title: '主工作区' }],
    modelGroups: [{
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      models: [{ id: 'flash', name: 'Flash', reasoning: 'High' }],
    }],
    modelCapabilities: {
      provider: 'deepseek',
      model: 'flash',
      reasoning: {
        efforts: [{ id: 'high', name: 'High' }, { id: 'medium', name: 'Medium' }],
        defaultEffort: 'medium',
      },
    },
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
    onAddWorkspace: async () => null,
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
  it('renders three real sections with exactly one current item', () => {
    const html = renderCreateBody()
    const nav = navMarkup(html)
    expect(nav).toContain('aria-label="创建助手的区块"')
    expect((nav.match(/<button/g) ?? [])).toHaveLength(3)
    expect((nav.match(/aria-current="page"/g) ?? [])).toHaveLength(1)
    for (const label of ['设定与形象', '模型与权限', '技能与MCP']) {
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
    expect(html).toContain('模型与权限')
    // The identity fields are not mounted: switching sections does not render
    // hidden controls that could write.
    expect(html).not.toContain('选择模板')
  })

  it('no longer lists unsupported areas: the dialog only shows what it can save', () => {
    const html = renderCreateBody()
    expect(html).not.toContain('创建时不提供')
    expect(html).not.toContain('aria-label="未提供的区块"')
  })

  it('keeps the dialog header to its title: no workspace banner line', () => {
    const html = renderCreateBody()
    expect(html).not.toContain('中创建 · 可在')
    expect(html).not.toContain('assistantCreateBanner')
  })
})

describe('dialog furniture', () => {
  const createSource = readFileSync(
    new URL('../src/client/assistant-dialogs.tsx', import.meta.url),
    'utf8',
  )
  const settingsSource = readFileSync(
    new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
    'utf8',
  )
  const capabilitiesSource = readFileSync(
    new URL('../src/client/assistant-capabilities.tsx', import.meta.url),
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
    // The remaining switch surfaces use the shipped control; the deleted team
    // activity board was the only other two-switch panel.
    expect(capabilitiesSource).toContain('<Switch')
    expect(capabilitiesSource).not.toContain('type="checkbox"')
    // The settings pane's only switch was the avatar animation toggle; the avatar
    // block now lives in its own floating editor, which ships no checkbox either.
    const avatarEditorSource = readFileSync(
      new URL('../src/client/assistant-avatar-editor.tsx', import.meta.url),
      'utf8',
    )
    expect(settingsSource).not.toContain('type="checkbox"')
    expect(avatarEditorSource).not.toContain('type="checkbox"')
  })

  it('shares one compact header rule across every AnimatedModal', () => {
    // One rule for the header, one for the description — no per-dialog copy.
    expect((moduleCss.match(/class\*="header"/g) ?? [])).toHaveLength(1)
    const rule = moduleCss.slice(moduleCss.indexOf('.teamModal [class*="header"] {'))
    expect(rule.slice(0, rule.indexOf('}'))).toContain('padding: 20px 12px 2px 20px')
    // Descendant selectors: the shell now nests header/body one level deeper.
    expect(moduleCss).toContain('.teamModal [class*="description"] {')
    expect(moduleCss).toContain('.teamModal [class*="body"] {')
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
    expect(section).toContain('选择模板')
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

  it('描述 sits under 名称 in 身份 and writes the instructions', () => {
    const html = renderCreateBody({ activeSection: 'identity' })
    expect(html).toContain('aria-label="描述"')
    expect(html).toContain('先读代码，再给最小实现。')
    expect(html).toContain('留空则使用 Agent Preset 默认')
    // Order inside the pane: name first, then the folded description.
    expect(html.indexOf('助手名称')).toBeLessThan(html.indexOf('aria-label="描述"'))
    // Folded by default: the textarea is in the DOM but the block is closed.
    expect(html).toMatch(/<details[^>]*data-dsh-fold="create-description"(?![^>]*\bopen\b)/)
  })

  it('model and environment merges model and thinking into one two-line control', () => {
    const html = renderCreateBody({ activeSection: 'model' })
    expect(html).toContain('Workspace')
    expect(html).toContain('主工作区')
    // One control, two lines: the model name over provider · the level it runs at.
    expect((html.match(/aria-label="模型与思考模式：/g) ?? [])).toHaveLength(1)
    expect(html).toContain('aria-label="模型与思考模式：Flash，DeepSeek · Medium"')
    // The old separate 思考模式 row is gone, not hidden.
    expect(html).not.toContain('aria-label="思考模式"')
    expect(html).not.toContain('aria-label="模型"')
    expect(html).toContain('Agent Preset')
    expect(html).toContain('>Standard<')
  })

  it('capabilities have their own section and start unchecked for a direct create', () => {
    const html = renderCreateBody({ activeSection: 'capabilities' })
    expect(html).toContain('>技能与MCP<')
    expect(html).toContain('>技能<')
    expect(html).toContain('>MCP<')
    expect(html).toContain('已选 0 个')
    expect(html).toContain('该 Agent Preset 没有可用的 Skill。')
    expect(html).toContain('该 Agent Preset 没有可用的 MCP Server。')
  })

  it('ticks the catalog entries a role brought in and disables the lost ones', () => {
    const resolved = renderCreateBody({
      activeSection: 'capabilities',
      draft: { ...CREATE_DRAFT, skillAllowlist: ['research'], mcpServers: ['github'] },
      skills: [{ name: 'research', detail: '查资料' }],
      mcpServers: [{ name: 'github', detail: '4 个工具' }],
    })
    expect(resolved).toContain('已选 1 个')
    expect(resolved).toContain('>research<')
    expect(resolved).toContain('查资料')
    expect(resolved).toContain('4 个工具')
    expect(resolved).not.toContain('不可用')

    const stale = renderCreateBody({
      activeSection: 'capabilities',
      draft: { ...CREATE_DRAFT, skillAllowlist: ['retired-skill'] },
      skills: [{ name: 'research', detail: '查资料' }],
    })
    // A stored Skill the preset no longer offers stays visible, refused and explained.
    expect(stale).toContain('retired-skill（不可用）')
    expect(stale).toContain('该 Agent Preset 不再提供这个 Skill，保存时不会带上')
    expect(stale).toMatch(/data-capability-unavailable="true"/)
    expect(stale).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/)
  })

  it('keeps the permission preset inside 模型与权限 and states the coordinator rule', () => {
    const html = renderCreateBody({ activeSection: 'model' })
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
    expect(section).not.toContain('aria-label="选择模板"')
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

describe('shared memory entry card and team memory section', () => {
  const read = (path: string): string =>
    readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
  const card = read('memory-entry-card.tsx')
  const assistantPanel = read('assistant-memory-panel.tsx')
  const teamPanel = read('teams/TeamPanel.tsx')

  it('renders entries through one exported card in a shared module', () => {
    expect(card).toContain('export function MemoryEntryCard')
    expect(card).toContain('entry.supersedes !== undefined')
    // Both panels import the shared module; neither keeps its own renderer.
    expect(assistantPanel).toContain("from './memory-entry-card.js'")
    expect(teamPanel).toContain("from '../memory-entry-card.js'")
    expect(assistantPanel).not.toContain('function memoryEntryCard(')
    expect(teamPanel).not.toContain('article className={css.memoryEntryCard}')
    // The team panel keeps its historical import path as a re-export.
    expect(teamPanel).toContain("export { MemoryEntryCard } from '../memory-entry-card.js'")
  })

  it('renders the team memory section even before any team memory exists', () => {
    // No gating on `team.memory !== undefined`: the section owns the empty
    // state and the 添加记忆 action, so a team that never wrote memory can.
    expect(teamPanel).toContain('<TeamMemorySection team={team} onChanged={onChanged} />')
    expect(teamPanel).not.toContain('(compact || team.memory !== undefined) &&')
    expect(teamPanel).toContain('还没有团队记忆')
    expect(teamPanel).toContain('添加记忆')
  })
})

describe('assistant 用量 section', () => {
  const snapshot = {
    phase: 'ready',
    byId: {
      main: {
        projectionValues: {
          tokenUsage: {
            uncachedInputTokens: 1000,
            cacheReadTokens: 3000,
            cacheWriteTokens: 0,
            outputTokens: 500,
          },
          sessionStats: { turns: 4 },
          contextPressure: { projectedTokens: 64_000, contextWindow: 128_000 },
          modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-chat' } },
        },
      },
    },
    projectionsBySession: {},
  }

  function render(
    scope: Array<{ sessionId: string; label?: string; retired?: boolean; hidden?: boolean }>,
    props: Record<string, unknown> = {},
  ): string {
    installUsageSessions({
      list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    })
    try {
      return renderToStaticMarkup(createElement(UsageSection, { scope, ...props }))
    } finally {
      installUsageSessions(undefined)
    }
  }

  it('reads the four buckets, cache hit, turns and context from the projections', () => {
    const html = render([{ sessionId: 'main', label: '主会话' }])

    expect(plainText(html)).toContain('输入 1k · 缓存读 3k · 缓存写 0 · 输出 500')
    expect(html).toContain('data-dsh-usage-total="4500"')
    // cacheRead / (uncached + cacheRead + cacheWrite)
    expect(plainText(html)).toContain('缓存命中 75%')
    expect(plainText(html)).toContain('4 轮')
    // projectedTokens / contextWindow, read as the current occupancy.
    expect(plainText(html)).toContain('上下文 50%')
    // One row per Session, carrying the native conversation opener's target.
    expect(html).toContain('data-dsh-usage-row="0"')
    expect(plainText(html)).not.toContain('部分会话')
  })

  it('renders “—” for a Session the Host has no projections for, never 0', () => {
    const html = render([{ sessionId: 'main', label: '主会话' }, { sessionId: 'cold', label: '附加会话' }])

    expect(html).toContain('data-dsh-usage-row="1"')
    expect(plainText(html)).toContain('— tok · 轮数 — · 缓存 — · 上下文 —')
    expect(plainText(html)).toContain('部分会话暂无法读取，合计只含已读取的 1 个会话')
    expect(plainText(html)).not.toContain('0 tok')
  })


  it('includes the hidden task-worker rows by task title and marks them', () => {
    installUsageSessions({
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          byId: {
            main: snapshot.byId.main,
            worker: {
              projectionValues: {
                tokenUsage: {
                  uncachedInputTokens: 100,
                  cacheReadTokens: 900,
                  cacheWriteTokens: 0,
                  outputTokens: 50,
                },
                sessionStats: { turns: 1 },
              },
            },
            'old-worker': {
              projectionValues: {
                tokenUsage: {
                  uncachedInputTokens: 0,
                  cacheReadTokens: 100,
                  cacheWriteTokens: 0,
                  outputTokens: 10,
                },
              },
            },
          },
        }),
        subscribe: () => () => {},
      },
    })
    try {
      const scope = assistantUsageScope({ id: 'a1', mainSessionId: 'main' }, [
        { assistantId: 'a1', sessionId: 'worker', title: '修复登录' },
        { assistantId: 'a1', sessionId: 'old-worker', title: '旧任务', archivedAt: '2026-01-02T00:00:00Z' },
      ])
      const html = renderToStaticMarkup(createElement(UsageSection, { scope }))

      expect(plainText(html)).toContain('修复登录')
      expect(plainText(html)).toContain('旧任务')
      expect(plainText(html)).toContain('后台任务')
      expect(plainText(html)).toContain('已退役')
      // The hidden mark is on the worker rows, never on the main Session row.
      expect(html.match(/data-dsh-usage-hidden/g)).toHaveLength(2)
      // Worker tokens join the assistant total: 4500 + 1050 + 110.
      expect(html).toContain('data-dsh-usage-total="5660"')
      expect(plainText(html)).not.toContain('部分会话')
    } finally {
      installUsageSessions(undefined)
    }
  })

  it('labels an unreadable task list instead of silently shrinking the total', () => {
    const html = render(
      [{ sessionId: 'main', label: '主会话' }],
      { excludeNote: '任务会话暂无法读取，合计不含任务会话' },
    )

    expect(html).toContain('data-dsh-usage-exclude-note')
    expect(plainText(html)).toContain('任务会话暂无法读取，合计不含任务会话')
  })

  it('never prints a raw Session id as the row label', () => {
    const html = render([{ sessionId: 'raw-session-id' }])

    expect(plainText(html)).toContain('会话')
    expect(html).not.toContain('raw-session-id')
  })
  it('shows a wholly unread scope as “—” and keeps no cost, history or split', () => {
    installUsageSessions({ list: { getSnapshot: () => ({ phase: 'ready' }), subscribe: () => () => {} } })
    const html = renderToStaticMarkup(createElement(UsageSection, { scope: [{ sessionId: 'cold' }] }))
    installUsageSessions(undefined)

    expect(plainText(html)).toContain('—tokens')
    expect(plainText(html)).toContain('缓存命中 —')
    expect(plainText(html)).toContain('轮数 —')
    expect(plainText(html)).toContain('上下文 —')
    // Read-only and native: no price, no time range, no per-model split, no input.
    expect(html).not.toMatch(/\$|cost|price|currency|USD|金额|费用/i)
    expect(html).not.toContain('<select')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('按模型')
  })
})

describe('assistant 用量 wiring', () => {
  const pane = readFileSync(
    new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
    'utf8',
  )
  const usage = readFileSync(new URL('../src/client/usage.ts', import.meta.url), 'utf8')

  it('keeps 用量 inside 行为 as the reference row it is', () => {
    // The nightly page has no 用量 group of its own; it is a 行为 block.
    expect(pane).toContain('data-dsh-assistant-section="behavior"')
    expect(pane).toContain('data-dsh-assistant-block="usage"')
    expect(pane).toContain('scope={assistantUsageScope(assistant, taskUsage.tasks)}')
    // Names the source instead of implying this plugin keeps a ledger.
    expect(pane).toContain('只读 · 来自宿主会话投影')
  })


  it('reads the assistant task list and passes worker Sessions to the rollup', () => {
    expect(pane).toContain("callAgentTeam('assistant.task.list', { assistantId: assistant.id })")
    expect(pane).toContain('scope={assistantUsageScope(assistant, taskUsage.tasks)}')
    expect(pane).toContain('setTaskUsage({ tasks: value.items, failed: false })')
    // A failed task read is labelled, not silently dropped.
    expect(pane).toContain('setTaskUsage({ tasks: [], failed: true })')
    expect(pane).toContain('任务会话暂无法读取，合计不含任务会话')
  })

  it('opens the native Session from a row and writes nothing', () => {
    expect(usage).toContain('onClick: () => { open(row.sessionId) }')
    expect(usage).toContain('if (!openAssistantSession(sessionId))')
    expect(usage).toContain('onOpenSession(sessionId)')
    expect(pane).toContain('scope={assistantUsageScope(assistant, taskUsage.tasks)}')
    // No storage, no request, no ledger: the read channel is the Host store.
    expect(usage).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest/)
    // A comment may say "no cost"; no field, sign or currency may exist.
    expect(usage).not.toMatch(/\$(?!\{)|costUsd|totalCost|currency\s*:|priceUsd|金额|费用/i)
    expect(usage).not.toContain('setItem')
  })

  it('sums only Sessions that reported a complete tokenUsage', () => {
    const report = usageReport(
      [{ sessionId: 'a' }, { sessionId: 'b' }],
      {
        phase: 'ready',
        byId: {
          a: {
            projectionValues: {
              tokenUsage: {
                uncachedInputTokens: 1,
                cacheReadTokens: 2,
                cacheWriteTokens: 3,
                outputTokens: 4,
              },
            },
          },
          // A partial tokenUsage (older state version) contributes nothing.
          b: { projectionValues: { tokenUsage: { outputTokens: 100 } } },
        },
      },
    )

    expect(report.rollup.tokens.total).toBe(10)
    expect(report.rollup.reporting).toBe(1)
    expect(report.rows[1]?.tokens.total).toBeNull()
  })
})

const {
  ASSISTANT_BLURB_MAX_CHARS,
  ASSISTANT_TITLE_MAX_CHARS,
  assistantCreatePayload,
  assistantCreateValidationError,
  assistantIdentityError,
  assistantIdentityUpdate,
} = await import('../src/client/assistant-form.js')

describe('assistant identity lines', () => {
  it('collects 职能 and 一句话介绍 in the create dialog with their counters', () => {
    const html = renderCreateBody({
      draft: { ...CREATE_DRAFT, title: '后端工程师', blurb: '负责接口' },
    })

    expect(html).toContain('aria-label="职能"')
    expect(html).toContain('aria-label="一句话介绍"')
    expect(html).toContain(`>5 / ${ASSISTANT_TITLE_MAX_CHARS}<`)
    expect(html).toContain(`>4 / ${ASSISTANT_BLURB_MAX_CHARS}<`)
    // Name first, then the two identity lines, then the folded persona.
    expect(html.indexOf('助手名称')).toBeLessThan(html.indexOf('aria-label="职能"'))
    expect(html.indexOf('aria-label="职能"')).toBeLessThan(html.indexOf('aria-label="一句话介绍"'))
    expect(html.indexOf('aria-label="一句话介绍"')).toBeLessThan(html.indexOf('aria-label="描述"'))
  })

  it('starts both counters at zero and keeps the values out of a blank payload', () => {
    const html = renderCreateBody()
    expect(html).toContain(`>0 / ${ASSISTANT_TITLE_MAX_CHARS}<`)
    expect(html).toContain(`>0 / ${ASSISTANT_BLURB_MAX_CHARS}<`)

    // A blank line is absent from the create payload, not an empty string.
    const payload = assistantCreatePayload(CREATE_DRAFT)
    expect(payload).not.toHaveProperty('title')
    expect(payload).not.toHaveProperty('blurb')
  })

  it('trims the identity lines it does send', () => {
    const payload = assistantCreatePayload({
      ...CREATE_DRAFT,
      title: '  后端工程师  ',
      blurb: '  负责接口  ',
    })
    expect(payload.title).toBe('后端工程师')
    expect(payload.blurb).toBe('负责接口')
  })

  it('refuses an over-cap line instead of truncating it', () => {
    expect(assistantIdentityError({ title: 'x'.repeat(ASSISTANT_TITLE_MAX_CHARS + 1) }))
      .toBe(`职能最多 ${ASSISTANT_TITLE_MAX_CHARS} 个字`)
    expect(assistantIdentityError({ blurb: 'x'.repeat(ASSISTANT_BLURB_MAX_CHARS + 1) }))
      .toBe(`一句话介绍最多 ${ASSISTANT_BLURB_MAX_CHARS} 个字`)
    expect(assistantIdentityError({ title: 'x'.repeat(ASSISTANT_TITLE_MAX_CHARS) })).toBeUndefined()
    expect(assistantCreateValidationError({
      ...CREATE_DRAFT,
      blurb: 'x'.repeat(ASSISTANT_BLURB_MAX_CHARS + 1),
    })).toBe(`一句话介绍最多 ${ASSISTANT_BLURB_MAX_CHARS} 个字`)
  })

  it('writes a changed line, omits an unchanged one, and clears an emptied one', () => {
    // Unchanged (modulo surrounding spaces) stays out of the patch.
    expect(assistantIdentityUpdate({ title: '后端', blurb: '负责接口' }, {
      title: ' 后端 ',
      blurb: '负责接口',
    })).toEqual({})
    // A cleared field travels as '' so the service removes the stored line.
    expect(assistantIdentityUpdate({ title: '后端', blurb: '负责接口' }, {
      title: '  ',
      blurb: '',
    })).toEqual({ title: '', blurb: '' })
    // Setting lines that were never stored carries the trimmed values.
    expect(assistantIdentityUpdate({}, { title: ' 数据 ', blurb: ' 报表 ' }))
      .toEqual({ title: '数据', blurb: '报表' })
  })

  it('edits 名称 and 称号 on the detail page, writing through on blur', () => {
    const settings = readFileSync(
      new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
      'utf8',
    )
    // The reference page calls the second line 称号 and has no 一句话介绍 row.
    expect(settings).toContain('aria-label="名称"')
    expect(settings).toContain('aria-label="称号"')
    expect(settings).toContain('data-dsh-assistant-title-count')
    expect(settings).not.toContain('aria-label="一句话介绍"')
    expect(settings).not.toContain('data-dsh-assistant-blurb-count')
    // Each field writes its own patch on blur; nothing is staged.
    expect(settings).toContain('onBlur={() => { void commitName() }}')
    expect(settings).toContain('onBlur={() => { void commitTitle() }}')
    expect(settings).toContain('assistantNamePatch(assistant, name)')
    expect(settings).toContain('assistantTitlePatch(assistant, title)')
    expect(settings).toContain("await write('name', patch)")
    expect(settings).toContain("await write('title', patch)")
    expect(settings).not.toContain('settingsSaveBar')
  })

})

describe('assistant detail status line', () => {
  const pane = readFileSync(
    new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
    'utf8',
  )

  it('keeps the live task status in the hero subtitle without a 现在 block', () => {
    // The one status read stays: it feeds the identity subtitle instead of a
    // separate folded block.
    expect(pane).toContain('const now = assistantNow(assistant, taskUsage.tasks)')
    expect(pane).toContain('now.statusText')
    expect(pane).not.toContain('AssistantNowBlock')
    expect(pane).not.toContain('data-dsh-assistant-now')
  })

  it('drops the folds, search and staged save bar the reference lacks', () => {
    expect(pane).not.toContain('FoldGroup')
    expect(pane).not.toContain('settingsSearch')
    expect(pane).not.toContain('settingsSaveBar')
    expect(pane).not.toContain('AssistantOverviewBlock')
    expect(pane).not.toContain('function save()')
  })
})

describe('assistant detail relationship actions (P0.5)', () => {
  const pane = readFileSync(
    new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
    'utf8',
  )
  const store = readFileSync(new URL('../src/client/store.ts', import.meta.url), 'utf8')
  const entry = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

  it('offers the native compact action and the explicit new-relationship action', () => {
    // They live under 高级 inside 规则, not in a removed 现在 block.
    expect(pane).toContain('data-dsh-assistant-rules-action="compact"')
    expect(pane).toContain('data-dsh-assistant-rules-action="relationship"')
    expect(pane).toContain('压缩上下文')
    expect(pane).toContain('开始新关系')
  })

  it('runs /compact through the installed host Session face, never a second compactor', () => {
    expect(store).toContain('export interface AssistantSessionOps')
    expect(store).toContain('installAssistantSessionOps')
    expect(entry).toContain('installAssistantSessionOps(')
    expect(entry).toContain('sessions.using!(')
    expect(entry).toContain('reference.binding.session.rename(title)')
    expect(entry).toContain('reference.binding.session.command(line)')
    // The pane calls the face; it does not import a compaction backend.
    expect(pane).toContain('assistantSessionOps()')
    expect(pane).toContain("ops.command(session.sessionId, '/compact')")
    expect(pane).toContain('压缩被拒绝')
    expect(pane).not.toMatch(/from '@deepseek-ai\/dsh-compaction'/)
    // Host session pin is never used: the mark is the plugin's own pinned flag.
    expect(store).not.toContain('pinSession')
    expect(entry).not.toContain('pinSession')
  })

  it('starts a new relationship through the checkpoint handoff, never by archiving main', () => {
    expect(pane).toContain('<AssistantCheckpointDialog')
    expect(pane).toContain('function startNewRelationship')
    const start = pane.indexOf('function startNewRelationship')
    const end = pane.indexOf('const displayName', start)
    const body = pane.slice(start, end)
    expect(body).toContain('setCheckpointOpen(true)')
    expect(body).not.toContain('assistant.instance.archive')
    // /new is not intercepted or rewritten anywhere in the relationship path.
    expect(pane).not.toContain("'/new'")
    expect(pane).not.toContain('"/new"')
  })
})

describe('archive visibility and its second exit', () => {
  const paneSource = readFileSync(
    new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
    'utf8',
  )
  const labelsSource = readFileSync(new URL('../src/client/labels.ts', import.meta.url), 'utf8')
  const teamPanelSource = readFileSync(
    new URL('../src/client/teams/TeamPanel.tsx', import.meta.url),
    'utf8',
  )
  const teamOverviewSource = readFileSync(
    new URL('../src/client/team-overview.tsx', import.meta.url),
    'utf8',
  )

  it('turns a refused archive or restore into a choice, not an error box', () => {
    // Both service codes are recognised and the force call is real.
    expect(paneSource).toContain("agentTeamErrorCode(cause) === 'ASSISTANT_INSTANCE_TEAM_LINKED'")
    expect(paneSource).toContain("agentTeamErrorCode(cause) === 'ASSISTANT_INSTANCE_TEAM_UNAVAILABLE'")
    expect(paneSource).toContain('force: true')
    expect(paneSource).toContain('data-dsh-assistant-team-conflict-force')
    // The server owns the wording: its message is rendered verbatim.
    expect(paneSource).toContain('{teamConflict.message}')
    // Both ways out are named, and the forced one is a button.
    expect(paneSource).toContain('先到团队页把该成员移除')
    expect(paneSource).toContain('强制归档')
    expect(paneSource).toContain('强制恢复')
  })

  it('says where a model or reasoning change takes effect, like the permission row', () => {
    expect(paneSource).toContain('模型与推理强度只影响之后启动的会话；已打开的主会话沿用旧模型，重新打开后生效。')
    expect(paneSource).toContain('权限只影响之后创建或恢复的会话；已打开的主会话保持原权限。')
  })

  it('marks an archived linked assistant on both team member surfaces', () => {
    expect(teamPanelSource).toContain('data-dsh-member-assistant-archived')
    expect(teamOverviewSource).toContain('data-dsh-member-assistant-archived')
    expect(labelsSource).toContain('MEMBER_ASSISTANT_ARCHIVED_HINT')
    expect(labelsSource).toContain("'已归档'")
  })

  it('documents where the archived assistant can be restored', () => {
    const docs = readFileSync(new URL('../docs/assistant.md', import.meta.url), 'utf8')
    expect(docs).not.toContain('归档没有恢复入口')
    expect(docs).not.toContain('归档也没有恢复入口')
    expect(docs).toContain('ASSISTANT_INSTANCE_TEAM_LINKED')
    expect(docs).toContain('恢复只恢复可用性')
  })
})
