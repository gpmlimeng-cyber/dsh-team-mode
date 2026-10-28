import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AssistantMemory, AssistantSession, MemoryEntry } from '../src/domain/types.js'
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
const {
  ASSISTANT_SETTING_GROUPS,
  AssistantNowBlock,
  AssistantOverviewMemoryRow,
  visibleSettingGroups,
} = await import('../src/client/assistant-settings-pane.js')
const { assistantNow } = await import('../src/client/assistant-instances.js')
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
    // The block's one memory read also carries the persisted auto-capture
    // switch, so the pane passes no extra state path down to it.
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
    // Entry writes (add/edit and archive share one announce tail), legacy text,
    // undo, ask-or-change, 全部忽略, the two adoption paths (采纳 and 全部采纳),
    // and the focus/visibility re-read a capture write cannot otherwise reach.
    expect((memoryPanel.match(/announceMemoryChange\(assistantId\)/g) ?? [])).toHaveLength(8)
    expect(pane).toContain('window.addEventListener(ASSISTANT_MEMORY_CHANGED_EVENT, onChanged)')
    expect(pane).toContain('if (detail?.assistantId === assistant.id) setMemoryReadNonce')
    // The read effect is keyed by the nonce, so an event is a fresh read.
    expect(pane).toContain('[assistant.id, overviewSessionKey, memoryReadNonce]')
  })

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

  it('re-reads the block and the count row when the window becomes visible again', () => {
    // An auto-capture write happens with no pane action, so the pane gets the
    // one signal it has: focus / visibilitychange. The announce is what reaches
    // the count row, which lives outside the block.
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

describe('assistant memory proposal adoption', () => {
  const memoryPanel = readFileSync(
    new URL('../src/client/assistant-memory-panel.tsx', import.meta.url),
    'utf8',
  )

  it('adopts a proposal by flipping exactly that entry to active', () => {
    // The same entry with the same body the user was shown: adoption invents no
    // field and rewrites no text.
    expect(memoryAcceptanceInput(entry())).toEqual({
      id: 'mem-1',
      title: 'Tone',
      body: 'Be terse.',
      visibility: 'private',
      status: 'active',
    })
    // A keyed decision keeps its key, so adoption does not drop the handle the
    // runtime dedupes proposals on.
    expect(memoryAcceptanceInput({ ...entry(), key: 'tone' })).toMatchObject({
      key: 'tone',
      status: 'active',
    })
  })

  it('keeps a proposal and reloads when the revision moved under it', () => {
    const conflict = Object.assign(new Error('conflict'), { code: 'MEMORY_REVISION_CONFLICT' })
    expect(memoryWriteFailure(conflict)).toEqual({
      message: '记忆已被其他操作更新，已重新加载最新版本，请重试。',
      reload: true,
    })
    // Any other failure is reported as it is; the proposal is still not dropped.
    const broken = Object.assign(new Error('写入失败'), { code: 'INTERNAL_ERROR' })
    expect(memoryWriteFailure(broken)).toEqual({ message: '写入失败', reload: false })
  })

  it('offers 采纳 per proposal and 全部采纳 beside 全部忽略', () => {
    expect(memoryPanel).toContain('全部采纳')
    expect(memoryPanel).toContain('全部忽略')
    expect(memoryPanel).toContain("acceptingProposals ? '采纳中…' : '全部采纳'")
    // One 采纳 action per proposal card, keyed by the entry it adopts.
    expect(memoryPanel).toContain('data-dsh-memory-accept={entry.id}')
    expect(memoryPanel).toContain('void acceptEntry(entry)')
    expect(memoryPanel).toContain('void acceptProposals()')
  })

  it('writes active through the same revision-fenced entry write, then announces and reloads', () => {
    // No second write path: one endpoint, one expectedRevision fence per write.
    expect(memoryPanel).toContain("callAgentTeam('assistant.memory.entry.write'")
    expect(memoryPanel).toContain('entry: memoryAcceptanceInput(entry)')
    expect(memoryPanel).toContain('await acceptProposalWrite(entry, revision)')
    // 全部采纳 chains the revision each write returned, so a concurrent edit
    // stops the batch instead of adopting a stale body.
    expect(memoryPanel).toContain(
      'expected = (await acceptProposalWrite(entry, expected)).revision',
    )
    const accept = memoryPanel.slice(
      memoryPanel.indexOf('async function acceptEntry'),
      memoryPanel.indexOf('async function acceptProposals'),
    )
    expect(accept).toContain('announceMemoryChange(assistantId)')
    expect(accept).toContain('await load()')
    expect(accept).toContain('if (failure.reload) void load()')
    // Adoption never archives: a proposal is not handled by deleting it.
    expect(accept).not.toContain("status: 'archived'")
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

  it('adds 用量 as its own accordion group on the existing settings surface', () => {
    const group = ASSISTANT_SETTING_GROUPS.find(entry => entry.id === 'usage')
    expect(group?.title).toBe('用量')
    expect(visibleSettingGroups('缓存')).toEqual(['usage'])
    expect(pane).toContain('dataKind="usage"')
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

const { assistantDetailSections } = await import('../src/client/assistant-detail.js')
const {
  ASSISTANT_BLURB_MAX_CHARS,
  ASSISTANT_TITLE_MAX_CHARS,
  assistantCreatePayload,
  assistantCreateValidationError,
  assistantIdentityError,
  assistantIdentityUpdate,
} = await import('../src/client/assistant-form.js')

function identityInstance(overrides: Partial<AssistantInstanceView> = {}): AssistantInstanceView {
  return {
    schemaVersion: 1,
    id: 'assistant-1',
    templateId: 'template-1',
    assistantSnapshot: {
      assistantId: 'template-1',
      revision: 1,
      name: '小码',
      title: '后端工程师',
      blurb: '把需求变成可上线的接口。',
      instructions: '',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

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

  it('edits the same two lines in the settings pane and clears them on save', () => {
    const settings = readFileSync(
      new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
      'utf8',
    )
    // Same two rows as the create dialog, staged on the one 保存 bar.
    expect(settings).toContain('aria-label="职能"')
    expect(settings).toContain('aria-label="一句话介绍"')
    expect(settings).toContain('data-dsh-assistant-title-count')
    expect(settings).toContain('data-dsh-assistant-blurb-count')
    expect(settings).toContain('assistantIdentityUpdate(snapshot')
    expect(settings).toContain('value.title = identityPatch.title')
    expect(settings).toContain('value.blurb = identityPatch.blurb')
    expect(settings).toContain('assistantIdentityError({ title, blurb })')
  })

  it('shows 职能 and 一句话介绍 on the detail only when the snapshot carries them', () => {
    const identity = assistantDetailSections(identityInstance())
      .find(section => section.id === 'identity')
    expect(identity?.facts).toContainEqual({ label: '职能', value: '后端工程师' })
    expect(identity?.facts).toContainEqual({ label: '一句话介绍', value: '把需求变成可上线的接口。' })

    const plainSnapshot = { ...identityInstance().assistantSnapshot }
    delete plainSnapshot.title
    delete plainSnapshot.blurb
    const plain = identityInstance({ assistantSnapshot: plainSnapshot })
    const facts = assistantDetailSections(plain).find(section => section.id === 'identity')?.facts ?? []
    expect(facts.map(fact => fact.label)).toEqual(['名称', '头像'])
    expect(facts.some(fact => fact.label === '职能' || fact.label === '一句话介绍')).toBe(false)
  })
})

const NOW_AT = Date.parse('2026-01-01T01:00:00.000Z')

function nowInstance(overrides: Partial<AssistantInstanceView> = {}): AssistantInstanceView {
  return {
    schemaVersion: 1,
    id: 'paper',
    templateId: 'template-paper',
    assistantSnapshot: {
      assistantId: 'template-paper',
      revision: 1,
      name: 'Paper Bot',
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function nowTask(
  status: AssistantSession['status'],
  id = `task-${status}`,
  overrides: Partial<AssistantSession> = {},
): AssistantSession {
  return {
    schemaVersion: 1,
    id,
    assistantId: 'paper',
    sessionId: `session-${id}`,
    role: 'task',
    title: `task ${id}`,
    brief: '',
    parentSessionId: 'session-main',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('assistant detail 现在 block', () => {
  const pane = readFileSync(
    new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
    'utf8',
  )

  function block(
    instance: AssistantInstanceView,
    tasks: AssistantSession[] = [],
  ): string {
    return renderToStaticMarkup(createElement(AssistantNowBlock, {
      now: assistantNow(instance, tasks),
      at: NOW_AT,
      onOpenChat: () => {},
      onOpenTask: () => {},
      onCompact: () => {},
      onNewRelationship: () => {},
      onAllSettings: () => {},
    }))
  }

  it('answers status, current task, recent preview and three actions before the settings', () => {
    const instance = nowInstance({
      mainSessionId: 'session-main',
      preview: {
        role: 'assistant',
        text: '先读接口，再改一轮。',
        time: NOW_AT - 30 * 60_000,
      },
    })
    const html = block(instance, [nowTask('running', 'task-run', { title: '整理本周资料' })])
    const plain = plainText(html)

    expect(plain).toContain('现在')
    expect(plain).toContain('思考中')
    expect(plain).toContain('整理本周资料')
    expect(plain).toContain('助手：先读接口，再改一轮。')
    expect(plain).toContain('30分钟')
    expect(plain).toContain('打开会话')
    expect(plain).toContain('查看')
    expect(plain).toContain('全部设置')
    expect(html).toContain('data-dsh-assistant-now-status="running"')
    // Situated above 概览, below the hero: the block is the first body element
    // after the avatar hero markup.
    expect(pane.indexOf('<AssistantNowBlock')).toBeLessThan(pane.indexOf("isVisible('overview')"))
  })

  it('names a needs_input task 处理 and never prints the stale 活跃 lifecycle', () => {
    const instance = nowInstance({ mainSessionId: 'session-main' })
    const html = block(instance, [
      nowTask('queued', 'task-queue'),
      nowTask('needs_input', 'task-pending', { title: '确认发布范围' }),
    ])
    const plain = plainText(html)

    expect(plain).toContain('待你处理')
    expect(plain).toContain('确认发布范围')
    expect(plain).toContain('处理')
    // The old hero word came from the never-cleared lifecycle status.
    expect(plain).not.toContain('活跃')
    expect(pane).not.toContain("active: '活跃'")
    expect(pane).toContain('assistantNow(assistant, taskUsage.tasks)')
    expect(pane).toContain('now.statusText')
  })

  it('falls back to the main session when no task is active, and disables 查看', () => {
    const html = block(nowInstance({ mainSessionId: 'session-main' }))
    const plain = plainText(html)

    expect(plain).toContain('主会话')
    expect(plain).toContain('没有进行中的任务')
    expect(plain).toContain('还没有最近的消息')
    expect(html).toMatch(/data-dsh-assistant-now-action="task"[^>]*disabled/)
  })

  it('wires 打开会话 through the canonical ensure door, 处理/查看 through task.open, and 全部设置 locally', () => {
    // The one canonical door owns ensure + naming + pin; the pane never calls
    // ensure itself and never opens a raw stored session id.
    expect(pane).toContain('openAssistantMainSession(assistant.id, sessionId => {')
    expect(pane).toContain('openAssistantSession(sessionId)')
    expect(pane).not.toContain("callAgentTeam('assistant.instance.ensure'")
    expect(pane).toContain("callAgentTeam('assistant.task.open', { taskId: task.taskId })")
    expect(pane).toContain('onOpenChat={() => { void openChat() }}')
    expect(pane).toContain('onOpenTask={() => { void openCurrentTask() }}')
    expect(pane).toContain('onAllSettings={showAllSettings}')
    expect(pane).toContain('function showAllSettings')
    expect(pane).toContain('setOpenGroups(allOpen)')
  })

  it('keeps the task read live on Host events so status and current never go stale', () => {
    expect(pane).toContain("callAgentTeam('assistant.task.list', { assistantId: assistant.id })")
    expect(pane).toContain('const unsubscribe = subscribeAgentTeam(read, () => {}, read)')
    // The same live list feeds 用量 and the 现在 summary.
    expect(pane).toContain('scope={assistantUsageScope(assistant, taskUsage.tasks)}')
    expect(pane).toContain('assistantNow(assistant, taskUsage.tasks)')
  })
})

describe('assistant detail relationship actions (P0.5)', () => {
  const pane = readFileSync(
    new URL('../src/client/assistant-settings-pane.tsx', import.meta.url),
    'utf8',
  )
  const store = readFileSync(new URL('../src/client/store.ts', import.meta.url), 'utf8')
  const entry = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

  function renderBlock(): string {
    return renderToStaticMarkup(createElement(AssistantNowBlock, {
      now: assistantNow(nowInstance({ mainSessionId: 'session-main' }), []),
      at: NOW_AT,
      onOpenChat: () => {},
      onOpenTask: () => {},
      onCompact: () => {},
      onNewRelationship: () => {},
      onAllSettings: () => {},
    }))
  }

  it('offers the native compact action and the explicit new-relationship action', () => {
    const plain = plainText(renderBlock())
    expect(plain).toContain('压缩上下文')
    expect(plain).toContain('开始新关系')
    expect(renderBlock()).toContain('data-dsh-assistant-now-action="compact"')
    expect(renderBlock()).toContain('data-dsh-assistant-now-action="relationship"')
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
    const end = pane.indexOf('function showAllSettings')
    const body = pane.slice(start, end)
    expect(body).toContain('setCheckpointOpen(true)')
    expect(body).not.toContain('assistant.instance.archive')
    // /new is not intercepted or rewritten anywhere in the relationship path.
    expect(pane).not.toContain("'/new'")
    expect(pane).not.toContain('"/new"')
  })
})
