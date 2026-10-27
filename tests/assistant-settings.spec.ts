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

const { memoryAfterUndo } = await import('../src/client/assistant-memory-panel.js')
const { AssistantCreateBody, AssistantCreateFooter } = await import('../src/client/assistant-dialogs.js')
const { AssistantOverviewMemoryRow } = await import('../src/client/assistant-settings-pane.js')
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

describe('assistant 概览 memory count row (M1)', () => {
  function row(count: number, onManage: () => void = () => undefined): string {
    return renderToStaticMarkup(createElement(AssistantOverviewMemoryRow, { count, onManage }))
  }

  it('is one line: 记忆 · N 条 · 管理 →', () => {
    const html = row(12)

    expect(plainText(html)).toBe('记忆 · 12 条 · 管理 →')
    // One real button carrying the count — not a link, not a menu, not a row
    // that writes anything by itself.
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-dsh-memory-count="12"/)
    expect(html).not.toContain('<input')
  })

  it('says 还没有记录 instead of 0 when it remembers nothing', () => {
    expect(assistantMemoryCountLine(0)).toBe('记忆 · 还没有记录')
    expect(plainText(row(0))).toBe('记忆 · 还没有记录')
    expect(plainText(row(0))).not.toContain('0')
    // A single entry is already a count, never the empty sentence.
    expect(assistantMemoryCountLine(1)).toBe('记忆 · 1 条 · 管理 →')
  })

  it('hands the click to the pane: the row itself owns no navigation', () => {
    const onManage = vi.fn()
    const element = AssistantOverviewMemoryRow({ count: 3, onManage }) as {
      props: { onClick: () => void }
    }

    element.props.onClick()
    expect(onManage).toHaveBeenCalledTimes(1)
  })
})

describe('assistant memory count row wiring', () => {
  const pane = readFileSync(
    new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
    'utf8',
  )
  const memoryPanel = readFileSync(
    new URL('../src/client/assistant-memory-panel.tsx', import.meta.url),
    'utf8',
  )

  it('takes N from the assistant.memory.get read the pane already makes', () => {
    expect(pane).toContain("callAgentTeam('assistant.memory.get'")
    // The assistant-scoped entries that read answered with — the same rows the
    // 记忆 block lists — not a second endpoint and not a stored counter.
    expect(pane).toContain(
      'const entries = view.active.length + view.proposed.length + view.historyTotal',
    )
    expect(pane).toContain('count={memoryEntryCount.count}')
    // The count is tagged with the instance it was read for, so switching
    // helpers can never show the previous assistant's number.
    expect(pane).toContain('setMemoryEntryCount({ assistantId: assistant.id, count: entries })')
    expect(pane).toContain('memoryEntryCount?.assistantId === assistant.id')
    expect(pane).toContain('<AssistantMemorySection assistantId={assistant.id} />')
  })

  it('renders the row in 概览, where the jump to 记忆 already lives', () => {
    const overview = pane.slice(
      pane.indexOf('data-dsh-assistant-overview'),
      pane.indexOf("isVisible('identity')"),
    )

    expect(overview).toContain('<AssistantOverviewMemoryRow')
    expect(overview).toContain("jumpToOverviewTarget('memory')")
    // The jump is the overview mechanism, not a new one: the pane owns exactly
    // one jump handler and the row borrows it.
    expect((pane.match(/const jumpToOverviewTarget/g) ?? [])).toHaveLength(1)
  })

  it('re-reads after a write inside the 记忆 block instead of going stale', () => {
    // The block keeps its own document; every successful write announces it so
    // the count row's one read runs again.
    expect(memoryPanel).toContain("export const ASSISTANT_MEMORY_CHANGED_EVENT")
    expect((memoryPanel.match(/announceMemoryChange\(assistantId\)/g) ?? [])).toHaveLength(5)
    expect(pane).toContain('window.addEventListener(ASSISTANT_MEMORY_CHANGED_EVENT, onChanged)')
    expect(pane).toContain('if (detail?.assistantId === assistant.id) setMemoryReadNonce')
    // The read effect is keyed by the nonce, so an event is a fresh read.
    expect(pane).toContain('[assistant.id, overviewSessionKey, memoryReadNonce]')
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
