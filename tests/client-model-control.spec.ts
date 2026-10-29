import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The primitives package needs browser peers this node test does not load. The
// Menu stub keeps the anchor (the closed trigger) and ignores its items, which
// is exactly the markup a server render shows.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Icon = (): unknown => createElement('span')
  return {
    Menu: (props: { anchor?: unknown }): unknown => createElement('span', { 'data-menu': '' }, props.anchor as never),
    IconChevronDownOutlineRegular: Icon,
  }
})

const {
  EFFORT_GROUP,
  ModelControl,
  modelControlEffortRow,
  modelControlModelRow,
  modelControlOptions,
  modelControlPick,
  modelControlReasoning,
  modelControlSelection,
  modelControlTrigger,
} = await import('../src/client/model-control.js')
type ModelControlModel = import('../src/client/model-control.js').ModelControlModel

const MODELS: ModelControlModel[] = [
  { providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'flash', label: 'DeepSeek-Flash' },
  { providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'pro', label: 'DeepSeek-Pro' },
  { providerId: 'openai', providerName: 'OpenAI', modelId: 'codex', label: 'Codex', description: '默认 Low' },
]

const CAPABILITIES: import('../src/transport/contracts.js').ModelCapabilitiesView = {
  provider: 'deepseek',
  model: 'flash',
  reasoning: {
    efforts: [{ id: 'high', name: 'High' }, { id: 'medium', name: 'Medium' }],
    defaultEffort: 'medium',
  },
}

const REASONING = modelControlReasoning(CAPABILITIES)

function source(name: string): string {
  return readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
}

function renderControl(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(ModelControl, {
    provider: 'deepseek',
    model: 'flash',
    reasoningEffort: '',
    models: MODELS,
    capabilities: CAPABILITIES,
    onChange: () => {},
    ...overrides,
  } as never))
}

describe('modelControlPick', () => {
  it('writes the provider and model together for a model row', () => {
    expect(modelControlPick(modelControlModelRow('deepseek', 'flash')))
      .toEqual({ provider: 'deepseek', model: 'flash' })
    expect(modelControlPick(modelControlModelRow('openai', 'codex')))
      .toEqual({ provider: 'openai', model: 'codex' })
  })

  it('writes only the level for an effort row, with an empty id clearing it', () => {
    expect(modelControlPick(modelControlEffortRow('high'))).toEqual({ reasoningEffort: 'high' })
    expect(modelControlPick(modelControlEffortRow(''))).toEqual({ reasoningEffort: '' })
  })

  it('ignores anything that is not a known row kind', () => {
    expect(modelControlPick('')).toBeUndefined()
    expect(modelControlPick('deepseek/flash')).toBeUndefined()
    expect(modelControlPick('model:flash')).toBeUndefined()
    expect(modelControlPick('model:deepseek/')).toBeUndefined()
  })
})

describe('modelControlReasoning', () => {
  it('words the default row and lists every level of the shown model', () => {
    expect(REASONING).toEqual({
      defaultLabel: '模型默认（Medium）',
      levels: [
        { id: 'high', label: 'High' },
        { id: 'medium', label: 'Medium' },
      ],
      defaultLevel: 'Medium',
    })
  })

  it('is undefined for a model without levels, so no thinking row is built', () => {
    expect(modelControlReasoning(undefined)).toBeUndefined()
    expect(modelControlReasoning({ provider: 'deepseek', model: 'flash', reasoning: { efforts: [] } }))
      .toBeUndefined()
  })
})

describe('modelControlOptions', () => {
  it('lists the models grouped by provider, then the thinking levels', () => {
    const options = modelControlOptions(MODELS, REASONING)

    expect(options.map(option => option.value)).toEqual([
      'model:deepseek/flash',
      'model:deepseek/pro',
      'model:openai/codex',
      'effort:',
      'effort:high',
      'effort:medium',
    ])
    expect(options.map(option => option.group)).toEqual([
      'DeepSeek',
      'DeepSeek',
      'OpenAI',
      EFFORT_GROUP,
      EFFORT_GROUP,
      EFFORT_GROUP,
    ])
    // The default row comes first and clears the stored level.
    expect(options[3]).toMatchObject({ label: '模型默认（Medium）', group: '思考模式' })
    expect(options[4]).toMatchObject({ label: 'High' })
    // A model may carry its own default level as a second line.
    expect(options[2]?.description).toBe('默认 Low')
  })

  it('leaves the thinking group out when the model has no levels', () => {
    const options = modelControlOptions(MODELS, undefined)
    expect(options).toHaveLength(3)
    expect(options.some(option => option.group === EFFORT_GROUP)).toBe(false)
  })
})

describe('modelControlSelection', () => {
  it('marks the chosen model and the chosen level', () => {
    expect(modelControlSelection('deepseek', 'flash', 'high', REASONING))
      .toEqual(['model:deepseek/flash', 'effort:high'])
  })

  it('marks the default row when no level is stored, and when the stored one is gone', () => {
    expect(modelControlSelection('deepseek', 'flash', '', REASONING))
      .toEqual(['model:deepseek/flash', 'effort:'])
    expect(modelControlSelection('deepseek', 'flash', 'ultra', REASONING))
      .toEqual(['model:deepseek/flash', 'effort:'])
  })

  it('marks no level row when the model has none', () => {
    expect(modelControlSelection('deepseek', 'flash', '', undefined)).toEqual(['model:deepseek/flash'])
    expect(modelControlSelection('', '', '', undefined)).toEqual([])
  })
})

describe('modelControlTrigger', () => {
  it('names the model over provider · level', () => {
    expect(modelControlTrigger('deepseek', 'flash', MODELS, REASONING, 'high')).toEqual({
      title: 'DeepSeek-Flash',
      subtitle: 'DeepSeek · High',
    })
  })

  it('falls back to the model’s default level name, never a blank second line', () => {
    expect(modelControlTrigger('deepseek', 'flash', MODELS, REASONING, '').subtitle)
      .toBe('DeepSeek · Medium')
    expect(modelControlTrigger('deepseek', 'flash', MODELS, REASONING, 'ultra').subtitle)
      .toBe('DeepSeek · Medium')
  })

  it('shows the provider alone when the model has no levels', () => {
    expect(modelControlTrigger('deepseek', 'flash', MODELS, undefined, '')).toEqual({
      title: 'DeepSeek-Flash',
      subtitle: 'DeepSeek',
    })
    // A provider with no rows and no level still names itself.
    expect(modelControlTrigger('local', 'llama', [], undefined, '')).toEqual({
      title: 'llama',
      subtitle: 'local',
    })
  })

  it('asks for a model instead of rendering an empty title', () => {
    expect(modelControlTrigger('', '', MODELS, undefined, '')).toEqual({ title: '选择模型' })
  })
})

describe('split rows for the detail page', () => {
  it('leaves the model rows alone when only the model half is asked for', () => {
    const options = modelControlOptions(MODELS, REASONING, 'model')
    const selection = modelControlSelection('deepseek', 'flash', 'high', REASONING, 'model')
    const trigger = modelControlTrigger(
      'deepseek', 'flash', MODELS, REASONING, 'high', 'model',
    )

    expect(options.map(option => option.value)).toEqual([
      modelControlModelRow('deepseek', 'flash'),
      modelControlModelRow('deepseek', 'pro'),
      modelControlModelRow('openai', 'codex'),
    ])
    expect(selection).toEqual([modelControlModelRow('deepseek', 'flash')])
    expect(trigger).toEqual({ title: 'DeepSeek-Flash', subtitle: 'DeepSeek' })
  })

  it('leaves only the reasoning rows when the reasoning half is asked for', () => {
    const options = modelControlOptions(MODELS, REASONING, 'reasoning')
    const selection = modelControlSelection('deepseek', 'flash', 'high', REASONING, 'reasoning')
    const trigger = modelControlTrigger(
      'deepseek', 'flash', MODELS, REASONING, 'high', 'reasoning',
    )

    expect(options.map(option => option.value)).toEqual([
      modelControlEffortRow(''),
      modelControlEffortRow('high'),
      modelControlEffortRow('medium'),
    ])
    expect(selection).toEqual([modelControlEffortRow('high')])
    expect(trigger).toEqual({ title: 'High' })
  })

  it('shows the model default when the shown model has no levels', () => {
    expect(modelControlOptions(MODELS, undefined, 'reasoning')).toEqual([])
    expect(modelControlSelection('deepseek', 'flash', '', undefined, 'reasoning')).toEqual([])
    expect(modelControlTrigger('deepseek', 'flash', MODELS, undefined, '', 'reasoning'))
      .toEqual({ title: '模型默认' })
  })
})

describe('ModelControl rendering', () => {
  it('renders one two-line trigger; the level lives in its second line', () => {
    const html = renderControl()

    expect(html).toContain('aria-label="模型与思考模式：DeepSeek-Flash，DeepSeek · Medium"')
    expect(html).toContain('>DeepSeek-Flash<')
    expect(html).toContain('>DeepSeek · Medium<')
    // One control, not two dropdowns.
    expect(html.match(/data-menu/g) ?? []).toHaveLength(1)
    expect(html).not.toContain('<select')
  })

  it('drops the level from the second line when the model has none', () => {
    const html = renderControl({ capabilities: undefined, reasoningEffort: '' })
    expect(html).toContain('aria-label="模型与思考模式：DeepSeek-Flash，DeepSeek"')
    expect(html).not.toContain('·')
  })

  it('is built on the shared SelectControl instead of a second dropdown', () => {
    const control = source('model-control.tsx')
    expect(control).toContain("from './select-control.js'")
    expect(control).toContain('<SelectControl')
    expect(control).not.toContain("from '@deepseek-ai/dsh-client-ui-primitives'")
    expect(control).not.toContain('<select')
  })
})

describe('both call sites use the shared control', () => {
  const pane = source('assistant-settings-pane.tsx')
  const dialog = source('assistant-dialogs.tsx')

  it('splits the detail page into a model row and a reasoning row', () => {
    // The reference page has 模型 and 推理 as separate rows.
    expect((pane.match(/<ModelControl/g) ?? [])).toHaveLength(2)
    expect(pane).toContain('label="模型"')
    expect(pane).toContain('label="推理"')
    expect(pane).toContain('section="model"')
    expect(pane).toContain('section="reasoning"')
    expect(pane).not.toContain('label="思考模式"')
    expect(pane).not.toContain('ariaLabel="思考模式"')
    // The model row keeps the provider · level hint its trigger shows.
    expect(pane).toContain('modelControlHint.subtitle')
    // Saving still writes the same three fields.
    expect(pane).toContain('value.provider = nextProvider')
    expect(pane).toContain('value.model = nextModel')
    expect(pane).toContain('value.reasoningEffort = nextReasoningEffort')
  })

  it('keeps the merged control in the create dialog', () => {
    expect((dialog.match(/<ModelControl/g) ?? [])).toHaveLength(1)
    expect(dialog).not.toContain('label="思考模式"')
    expect(dialog).not.toContain('ariaLabel="思考模式"')
    expect(dialog).toContain('modelCapabilities={modelCapabilities.value}')
    // The draft still receives the patch the control decoded.
    expect(dialog).toContain('props.onDraftChange(patch)')
  })
})
