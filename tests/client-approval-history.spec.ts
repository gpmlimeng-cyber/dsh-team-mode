import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approvalDecisionLabel,
  approvalHistory,
  rememberApproval,
} from '../src/client/approval-history.js'

function installStorage(): void {
  const data = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
    },
  })
}

describe('approval history', () => {
  beforeEach(installStorage)
  afterEach(() => { vi.unstubAllGlobals() })

  it('remembers the latest decision per tool', () => {
    rememberApproval('Bash', 'allowed-once')
    expect(approvalHistory()).toEqual({ Bash: 'allowed-once' })
    rememberApproval('Write', 'rejected')
    expect(approvalHistory()).toEqual({ Bash: 'allowed-once', Write: 'rejected' })
  })

  it('labels both decisions', () => {
    expect(approvalDecisionLabel('allowed-once')).toBe('允许一次')
    expect(approvalDecisionLabel('rejected')).toBe('拒绝')
  })
})
