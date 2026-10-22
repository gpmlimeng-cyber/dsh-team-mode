const APPROVAL_HISTORY_KEY = 'dsh-team-mode:approval-history'

export type ApprovalDecision = 'allowed-once' | 'rejected'
export type ApprovalHistory = Record<string, ApprovalDecision>

function readHistory(): ApprovalHistory {
  try {
    const raw = window.localStorage.getItem(APPROVAL_HISTORY_KEY)
    if (raw === null) return {}
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const next: ApprovalHistory = {}
    for (const [tool, decision] of Object.entries(value)) {
      if (decision === 'allowed-once' || decision === 'rejected') next[tool] = decision
    }
    return next
  } catch {
    return {}
  }
}

export function approvalHistory(): ApprovalHistory {
  return readHistory()
}

export function rememberApproval(toolName: string, decision: ApprovalDecision): ApprovalHistory {
  const next = { ...readHistory(), [toolName]: decision }
  try { window.localStorage.setItem(APPROVAL_HISTORY_KEY, JSON.stringify(next)) } catch { /* storage may be unavailable */ }
  return next
}

export function approvalDecisionLabel(decision: ApprovalDecision): string {
  return decision === 'allowed-once' ? '允许一次' : '拒绝'
}
