import { describe, expect, it } from 'vitest'
import {
  assistantCreateDefaults,
  assistantCreatePayload,
  assistantModelKey,
  assistantModelOptionLabel,
  emptyAssistantCreateDraft,
  workspaceSelectable,
} from '../src/client/assistant-form.js'
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

  it('defaults to an isolated workspace while still skipping private bases', () => {
    const draft = emptyAssistantCreateDraft()
    // Isolation is on by default; only an explicit off keeps the shared base.
    expect(draft.workspaceIsolated).toBe(true)

    const defaults = assistantCreateDefaults(catalog([
      { id: 'private', path: '/work/.dsh-team-mode/assistants/paper', title: 'Paper', status: 'ok', isolated: true },
      { id: 'missing', path: '/work/missing', title: 'Missing', status: 'missing-dir' },
      { id: 'shared', path: '/work', title: 'Work', status: 'ok' },
    ]))
    expect(defaults.workspaceId).toBe('shared')
    expect(defaults.workspaceIsolated).toBe(true)
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
    }
    expect(assistantCreatePayload(on)).toMatchObject({
      workspaceId: 'workspace-1',
      workspaceIsolated: true,
    })

    const off = assistantCreatePayload({ ...on, workspaceIsolated: false })
    expect(off.workspaceIsolated).toBeUndefined()
    // Shared creation keeps the exact payload older dialogs sent.
    expect(off).toMatchObject({ workspaceId: 'workspace-1', name: 'Paper Bot' })
  })
})
