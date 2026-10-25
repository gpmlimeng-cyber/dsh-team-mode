import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PERMISSION_LABELS, TASK_STATE_LABELS, taskStatusLabel } from '../src/client/labels.js'

describe('taskStatusLabel', () => {
  it.each([
    ['pending', '待处理'],
    ['assigned', '已分配'],
    ['running', '进行中'],
    ['in_progress', '进行中'],
    ['blocked', '已阻塞'],
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
      running: '进行中',
      in_progress: '进行中',
      blocked: '已阻塞',
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

describe('task labels on the activity and board surfaces', () => {
  it('prints Chinese for running and blocked tasks wherever the table is read directly', () => {
    // The activity rows and the team board index TASK_STATE_LABELS themselves,
    // so a missing key would leak a raw id there even though taskStatusLabel
    // was fixed. The one table must cover every status the board can hold.
    expect(TASK_STATE_LABELS.running).toBe('进行中')
    expect(TASK_STATE_LABELS.blocked).toBe('已阻塞')
    expect(TASK_STATE_LABELS.running).not.toBe('running')
    expect(TASK_STATE_LABELS.blocked).not.toBe('blocked')

    for (const surface of ['team-activity.tsx', 'teams/TeamPanel.tsx']) {
      const source = readFileSync(new URL(`../src/client/${surface}`, import.meta.url), 'utf8')
      expect(source).toContain('TASK_STATE_LABELS')
      expect(source).not.toMatch(/ALL_TASK_STATUS_LABELS/)
    }
  })

  it('keeps every status the schema can hold in the one table', () => {
    const statuses = ['pending', 'assigned', 'running', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']
    expect(Object.keys(TASK_STATE_LABELS).sort()).toEqual([...statuses].sort())
    for (const status of statuses) {
      expect(taskStatusLabel(status)).toBe(TASK_STATE_LABELS[status])
    }
  })
})
