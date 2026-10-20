import { describe, expect, it } from 'vitest'
import { PERMISSION_LABELS, TASK_STATE_LABELS, taskStatusLabel } from '../src/client/labels.js'

describe('taskStatusLabel', () => {
  it.each([
    ['pending', '待处理'],
    ['assigned', '已分配'],
    ['in_progress', '进行中'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
  ])('maps %s to its Chinese label', (status, label) => {
    expect(taskStatusLabel(status)).toBe(label)
  })

  it.each(['paused', 'unknown_state', ''])('returns an unknown status %j as-is', status => {
    expect(taskStatusLabel(status)).toBe(status)
  })

  it('keeps TASK_STATE_LABELS intact', () => {
    expect(TASK_STATE_LABELS).toEqual({
      pending: '待处理',
      assigned: '已分配',
      in_progress: '进行中',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
    })
  })

  it('keeps PERMISSION_LABELS intact', () => {
    expect(PERMISSION_LABELS).toEqual({
      'read-only': '只读',
      'workspace-write': '工作区可写',
      'danger-full-access': '完全访问',
    })
  })
})
