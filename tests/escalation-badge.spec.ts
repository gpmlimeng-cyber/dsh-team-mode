import { describe, expect, it } from 'vitest'
import { coordinatorEscalationBadge } from '../src/client/assistant-instances.js'
import type { Escalation } from '../src/domain/types.js'

type Row = Pick<Escalation, 'status'>

const coordinator = { coordinator: true }
const member = { coordinator: false }

function row(status: Escalation['status']): Row {
  return { status }
}

describe('coordinator escalation badge', () => {
  // Lock 1: the number is the count of open gates, not of rows on file.
  it('counts the open escalations of the coordinator row', () => {
    expect(coordinatorEscalationBadge(coordinator, [row('open'), row('open'), row('open')])).toBe(3)
    // One open among closed history still reads 1, never the row total.
    expect(coordinatorEscalationBadge(coordinator, [row('open'), row('lifted'), row('lifted')])).toBe(1)
  })

  // Lock 2: a gate that was answered is lifted, and a lifted gate must leave no
  // badge behind — neither a stale number nor a "0".
  it('hides the badge when no gate is open', () => {
    expect(coordinatorEscalationBadge(coordinator, [row('lifted'), row('lifted')])).toBeUndefined()
    expect(coordinatorEscalationBadge(coordinator, [])).toBeUndefined()
  })

  // Lock 3: the badge belongs to the coordinator's pinned row alone; an ordinary
  // 单聊 row keeps rendering exactly as it did before the feature existed.
  it('never badges a non-coordinator row', () => {
    expect(coordinatorEscalationBadge(member, [row('open'), row('open')])).toBeUndefined()
  })
})
