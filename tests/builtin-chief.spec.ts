import { describe, expect, it } from 'vitest'
import { CHIEF_ASSISTANT } from '../src/domain/chief.js'

describe('built-in Chief assistant', () => {
  it('has a stable built-in identity', () => {
    expect(CHIEF_ASSISTANT.id).toBe('builtin-chief')
    expect(CHIEF_ASSISTANT.name).toBe('Chief')
    expect(CHIEF_ASSISTANT.avatar.startsWith('data:image/svg+xml')).toBe(true)
  })

  it('carries the chief-of-staff operating rules', () => {
    expect(CHIEF_ASSISTANT.instructions).toContain('幕僚长')
    expect(CHIEF_ASSISTANT.instructions).toContain('验收标准')
    expect(CHIEF_ASSISTANT.instructions).toContain('阻塞')
    expect(CHIEF_ASSISTANT.prompts.length).toBeGreaterThan(0)
  })
})
