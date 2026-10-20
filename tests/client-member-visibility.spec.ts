import { describe, expect, it } from 'vitest'
import {
  initialVisibleMemberSlots,
  reconcileVisibleMemberSlots,
  toggleVisibleMemberSlot,
} from '../src/client/member-visibility.js'

describe('team member visibility', () => {
  it('opens every team member without a three-column cap', () => {
    expect(initialVisibleMemberSlots(['leader', 'member-1', 'member-2', 'member-3'])).toEqual([
      'leader',
      'member-1',
      'member-2',
      'member-3',
    ])
  })

  it('keeps every selected member when another member is shown', () => {
    expect(toggleVisibleMemberSlot(['leader', 'member-1', 'member-2'], 'member-3')).toEqual([
      'leader',
      'member-1',
      'member-2',
      'member-3',
    ])
  })

  it('automatically shows a newly added member without restoring intentionally hidden members', () => {
    expect(reconcileVisibleMemberSlots(
      ['leader', 'member-2'],
      ['leader', 'member-1', 'member-2'],
      ['leader', 'member-1', 'member-2', 'member-3'],
    )).toEqual(['leader', 'member-2', 'member-3'])
  })
})
