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
  return { Button, Modal: Stub }
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

  it('explains the five unsupported areas instead of offering them as tabs', () => {
    const html = renderCreateBody()
    expect(html).toContain('<details')
    expect(html).toContain('<summary>还有 5 项创建时不提供</summary>')
    expect(html).toContain('aria-label="未提供的区块"')
    for (const text of [
      '创建后在助手设置/记忆面板维护',
      '实例快照不开放技能与 MCP 字段',
      '本插件没有按助手的定时任务',
      '只保留 Workspace',
      '通知沿用 DSH 全局行为',
    ]) {
      expect(html).toContain(text)
    }
  })

  it('shows the workspace banner only when it was supplied', () => {
    expect(renderCreateBody()).not.toContain('中创建')
    expect(renderCreateBody({ banner: '将在「主工作区」中创建 · 可在「模型与环境」切换' }))
      .toContain('将在「主工作区」中创建')
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
    expect(section).toContain('内置角色')
    expect(section).toContain('>工程师<')
    expect(section).toContain('上传本地头像')
    expect(section).toContain('aria-label="助手名称"')
    expect(section).toContain('>不分组<')
    expect(section).toContain('>工作<')
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
    expect(section).not.toContain('起始角色')
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
