import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assistantCreateDefaults,
  assistantCreatePayload,
  assistantModelKey,
  assistantModelOptionLabel,
  emptyAssistantCreateDraft,
  workspaceSelectable,
} from '../src/client/assistant-form.js'
import {
  COWORKER_PRESETS,
  COWORKER_SENTENCE_MAX_CHARS,
  applyCoworkerPreset,
  applyCoworkerSuggestion,
  coworkerPresetById,
} from '../src/client/coworker-presets.js'
import type { CatalogView } from '../src/transport/contracts.js'

describe('assistantModelKey', () => {
  it('joins provider and model into one stable catalog key', () => {
    expect(assistantModelKey('deepseek', 'deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash')
    expect(assistantModelKey('', '')).toBe('/')
  })
})

describe('assistantModelOptionLabel', () => {
  it('renders model, provider and reasoning in DS Bot order', () => {
    expect(assistantModelOptionLabel('DeepSeek', 'DeepSeek-V4.1-Flash', 'High'))
      .toBe('DeepSeek-V4.1-Flash — DeepSeek · High')
  })

  it('omits the reasoning subtitle when the model does not advertise one', () => {
    expect(assistantModelOptionLabel('OpenAI', 'Codex')).toBe('Codex — OpenAI')
    expect(assistantModelOptionLabel('OpenAI', 'Codex', '  ')).toBe('Codex — OpenAI')
  })

  it('trims provider and reasoning text and keeps a model-only fallback', () => {
    expect(assistantModelOptionLabel('  DeepSeek  ', '  DeepSeek-V4.1-Flash  ', '  High  '))
      .toBe('DeepSeek-V4.1-Flash — DeepSeek · High')
    expect(assistantModelOptionLabel('', 'Codex', 'Low')).toBe('Codex · Low')
  })
})

function catalog(workspaces: CatalogView['workspaces']): CatalogView {
  return {
    providers: [{ id: 'openai', name: 'OpenAI' }],
    models: { openai: [{ id: 'gpt-5', name: 'GPT-5' }] },
    agentPresets: [{ id: 'default', name: 'Default' }],
    permissionPresets: [{ value: 'read-only', name: 'Read only' }],
    workspaces,
  }
}

describe('isolated assistant workspaces in the create form', () => {
  it('offers only real, non-isolated workspaces to pickers', () => {
    expect(workspaceSelectable({ status: 'ok' })).toBe(true)
    expect(workspaceSelectable({ status: 'missing-dir' })).toBe(false)
    // A private Assistant registration nests under a base workspace; offering
    // it would create isolation inside isolation.
    expect(workspaceSelectable({ status: 'ok', isolated: true })).toBe(false)
  })

  it('defaults to the shared workspace while still skipping private bases', () => {
    const draft = emptyAssistantCreateDraft()
    // Shared is the default: only a shared coworker can join a team.
    expect(draft.workspaceIsolated).toBe(false)

    const defaults = assistantCreateDefaults(catalog([
      { id: 'private', path: '/work/.dsh-team-mode/assistants/paper', title: 'Paper', status: 'ok', isolated: true },
      { id: 'missing', path: '/work/missing', title: 'Missing', status: 'missing-dir' },
      { id: 'shared', path: '/work', title: 'Work', status: 'ok' },
    ]))
    expect(defaults.workspaceId).toBe('shared')
    expect(defaults.workspaceIsolated).toBe(false)
  })

  it('sends the isolation default unless the user explicitly chooses shared', () => {
    const on = {
      ...emptyAssistantCreateDraft(),
      name: 'Paper Bot',
      workspaceId: 'workspace-1',
      provider: 'openai',
      model: 'gpt-5',
      agentPresetId: 'default',
      permissionPresetId: 'read-only',
      workspaceIsolated: true,
    }
    expect(assistantCreatePayload(on)).toMatchObject({
      workspaceId: 'workspace-1',
      workspaceIsolated: true,
    })

    // Shared is the payload older dialogs sent and the default a new draft
    // starts from, because only a shared coworker can join a team.
    const off = assistantCreatePayload({ ...on, workspaceIsolated: false })
    expect(off.workspaceIsolated).toBeUndefined()
    expect(off).toMatchObject({ workspaceId: 'workspace-1', name: 'Paper Bot' })
    expect(emptyAssistantCreateDraft().workspaceIsolated).toBe(false)
  })
})

function presetCatalog(): CatalogView {
  return {
    providers: [{ id: 'openai', name: 'OpenAI' }],
    models: { openai: [{ id: 'gpt-5', name: 'GPT-5' }] },
    agentPresets: [{ id: 'default', name: 'Default' }],
    permissionPresets: [
      { value: 'read-only', name: 'Read only' },
      { value: 'workspace-write', name: 'Workspace write' },
    ],
    workspaces: [{ id: 'shared', path: '/work', title: 'Work', status: 'ok' }],
  }
}

describe('coworker presets', () => {
  it('freezes exactly the five starting roles as client constants', () => {
    expect(COWORKER_PRESETS.map(preset => preset.name))
      .toEqual(['研究员', '审查员', '实现者', '测试员', '协调者'])
    expect(new Set(COWORKER_PRESETS.map(preset => preset.id)).size).toBe(5)
    expect(COWORKER_SENTENCE_MAX_CHARS).toBe(2_000)
    expect(coworkerPresetById('reviewer')?.title).toBe('改动评审')
    expect(coworkerPresetById('missing')).toBeUndefined()
  })

  it('fills an editable draft without touching workspace or capabilities', () => {
    const catalog = presetCatalog()
    const draft = {
      ...assistantCreateDefaults(catalog),
      name: '我的助手',
      skillAllowlist: ['skill-a'],
      mcpServers: ['server-a'],
      group: '工作',
    }
    const applied = applyCoworkerPreset(draft, 'implementer', catalog)
    const preset = coworkerPresetById('implementer')
    expect(applied.name).toBe('实现者')
    expect(applied.title).toBe(preset?.title)
    expect(applied.blurb).toBe(preset?.blurb)
    expect(applied.instructions).toBe(preset?.instructions)
    expect(applied.permissionPresetId).toBe('workspace-write')
    // The base workspace and the user's own Skill/MCP choice survive the fill.
    expect(applied.workspaceId).toBe('shared')
    expect(applied.skillAllowlist).toEqual(['skill-a'])
    expect(applied.mcpServers).toEqual(['server-a'])
    expect(applied.group).toBe('工作')
    // Pure: the draft it was given is unchanged.
    expect(draft.name).toBe('我的助手')
    expect(draft.title).toBe('')
    // No template id, and nothing create-shaped is added.
    expect(applied).not.toHaveProperty('templateId')
  })

  it('applies a permission preset only while the catalog still offers it', () => {
    const catalog = presetCatalog()
    const base = { ...assistantCreateDefaults(catalog), permissionPresetId: 'workspace-write' }
    const withoutReadOnly: CatalogView = {
      ...catalog,
      permissionPresets: [{ value: 'workspace-write', name: 'Workspace write' }],
    }
    expect(applyCoworkerPreset(base, 'reviewer', withoutReadOnly).permissionPresetId)
      .toBe('workspace-write')
    // An unloaded catalog cannot vouch for an engine value, so it is skipped.
    expect(applyCoworkerPreset(base, 'reviewer', undefined).permissionPresetId)
      .toBe('workspace-write')
    const unknown = { ...base, permissionPresetId: '' }
    expect(applyCoworkerPreset(unknown, 'missing', catalog)).toBe(unknown)
  })
})

describe('applyCoworkerSuggestion', () => {
  it('lets the model text override a named preset, field by field', () => {
    const catalog = presetCatalog()
    const draft = { ...assistantCreateDefaults(catalog), instructions: '旧提示' }
    const applied = applyCoworkerSuggestion(draft, {
      presetId: 'tester',
      name: '  测试伙伴  ',
      title: '跑回归',
      instructions: '  只跑受影响的用例  ',
      // no blurb: the preset's blurb stays
    }, catalog)
    expect(applied.name).toBe('测试伙伴')
    expect(applied.title).toBe('跑回归')
    expect(applied.instructions).toBe('只跑受影响的用例')
    expect(applied.blurb).toBe(coworkerPresetById('tester')?.blurb)
    expect(applied.permissionPresetId).toBe('workspace-write')
    expect(applied.workspaceId).toBe('shared')
  })

  it('ignores an unknown preset and keeps every current value for blank fields', () => {
    const catalog = presetCatalog()
    const draft = {
      ...assistantCreateDefaults(catalog),
      name: '保持',
      title: '原职能',
      blurb: '原介绍',
      instructions: '原提示',
    }
    const applied = applyCoworkerSuggestion(draft, {
      presetId: 'retired-preset',
      name: '',
      title: '   ',
    }, catalog)
    expect(applied).toEqual(draft)
  })

  it('treats an all-empty suggestion as no change', () => {
    const catalog = presetCatalog()
    const draft = assistantCreateDefaults(catalog)
    expect(applyCoworkerSuggestion(draft, {}, catalog)).toEqual(draft)
  })
})

describe('coworker preset module is client-only', () => {
  it('never reaches a transport or a create path', () => {
    const source = readFileSync(
      new URL('../src/client/coworker-presets.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toContain('callAgentTeam')
    expect(source).not.toContain('assistant.instance')
    // Only the schema module's type shape is mirrored; no zod import ships.
    expect(source).not.toContain("from '../domain/schemas.js'")
  })
})
