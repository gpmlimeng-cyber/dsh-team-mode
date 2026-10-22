import { describe, expect, it } from 'vitest'
import { assistantModelKey, assistantModelOptionLabel } from '../src/client/assistant-form.js'

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
