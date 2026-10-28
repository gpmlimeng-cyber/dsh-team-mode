import { describe, expect, it } from 'vitest'
import { createTeamDraftInputSchema } from '../src/domain/schemas.js'
import {
  TEAM_TEMPLATES,
  teamTemplateDraft,
  teamTemplateSlots,
  type TeamTemplate,
} from '../src/client/team-templates.js'

function template(id: TeamTemplate['id']): TeamTemplate {
  const found = TEAM_TEMPLATES.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`missing template ${id}`)
  return found
}

describe('built-in team templates', () => {
  it('ships exactly the three planned templates, in picker order', () => {
    expect(TEAM_TEMPLATES.map(entry => [entry.id, entry.label, entry.name])).toEqual([
      ['repo-audit', '代码库体检队', '代码库体检'],
      ['feature-delivery', '功能开发队', '功能开发'],
      ['release-check', '发布检查队', '发布检查'],
    ])
  })

  it('keeps the planned member roles and counts', () => {
    expect(template('repo-audit').roles).toEqual([
      { role: 'Leader', count: 1, leader: true },
      { role: '审查员', count: 2 },
      { role: '复核员', count: 1 },
    ])
    expect(template('feature-delivery').roles).toEqual([
      { role: 'Leader', count: 1, leader: true },
      { role: '实现', count: 1 },
      { role: '测试', count: 1 },
    ])
    expect(template('release-check').roles).toEqual([
      { role: 'Leader', count: 1, leader: true },
      { role: '构建', count: 1 },
      { role: '回归', count: 1 },
    ])
  })

  it('gives every template three tasks with the planned acceptance criteria', () => {
    expect(template('repo-audit').tasks).toEqual([
      { title: '分片审查（每个审查员一条）', acceptance: ['每条发现带文件/行号/证据'] },
      { title: '交叉复核', acceptance: ['复核员 pass 才算完成'] },
      { title: '汇总报告', acceptance: ['每条发现带文件/行号/证据', '复核员 pass 才算完成'] },
    ])
    expect(template('feature-delivery').tasks).toEqual([
      { title: '实现', acceptance: ['实现者不自评'] },
      { title: '验证', acceptance: ['验证通过才算完成'] },
      { title: '交付说明', acceptance: ['实现者不自评', '验证通过才算完成'] },
    ])
    expect(template('release-check').tasks).toEqual([
      { title: '构建', acceptance: ['构建产物可复现'] },
      { title: '回归', acceptance: ['回归清单逐项勾选'] },
      { title: '发布清单', acceptance: ['构建产物可复现', '回归清单逐项勾选'] },
    ])
    for (const entry of TEAM_TEMPLATES) {
      expect(entry.tasks).toHaveLength(3)
      for (const task of entry.tasks) expect(task.acceptance.length).toBeGreaterThan(0)
    }
  })

  it('freezes the data deeply so a consumer cannot edit the built-ins', () => {
    expect(Object.isFrozen(TEAM_TEMPLATES)).toBe(true)
    for (const entry of TEAM_TEMPLATES) {
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.roles)).toBe(true)
      expect(Object.isFrozen(entry.tasks)).toBe(true)
      for (const role of entry.roles) expect(Object.isFrozen(role)).toBe(true)
      for (const task of entry.tasks) {
        expect(Object.isFrozen(task)).toBe(true)
        expect(Object.isFrozen(task.acceptance)).toBe(true)
      }
    }
  })

  it('expands roles into ordered slots with the Leader first', () => {
    expect(teamTemplateSlots(template('repo-audit'))).toEqual([
      { role: 'Leader', leader: true },
      { role: '审查员', leader: false },
      { role: '审查员', leader: false },
      { role: '复核员', leader: false },
    ])
    expect(teamTemplateSlots(template('feature-delivery')).map(slot => slot.role))
      .toEqual(['Leader', '实现', '测试'])
    expect(teamTemplateSlots(template('release-check')).map(slot => slot.role))
      .toEqual(['Leader', '构建', '回归'])
  })
})

describe('team template draft mapping', () => {
  it('maps a template onto the existing strict createDraft input', () => {
    const draft = teamTemplateDraft(template('repo-audit'), {
      workspaceId: '/tmp/repo',
      assistantIds: ['a1', 'a2', 'a3', 'a4'],
    })
    expect(draft).toEqual({
      name: '代码库体检',
      workspaceId: '/tmp/repo',
      directMemberChat: true,
      members: [
        { assistantId: 'a1', role: 'leader' },
        { assistantId: 'a2', role: 'member' },
        { assistantId: 'a3', role: 'member' },
        { assistantId: 'a4', role: 'member' },
      ],
    })
    // Proves no schema change is needed: the payload already parses as-is.
    expect(createTeamDraftInputSchema.parse(draft)).toEqual(draft)
  })

  it('maps every built-in template without leaving the draft shape', () => {
    for (const entry of TEAM_TEMPLATES) {
      const draft = teamTemplateDraft(entry, {
        workspaceId: ' ws-1 ',
        assistantIds: ['a1', 'a2', 'a3', 'a4'],
      })
      expect(draft).toBeDefined()
      expect(createTeamDraftInputSchema.parse(draft)).toEqual(draft)
      expect(draft?.workspaceId).toBe('ws-1')
      expect(draft?.name).toBe(entry.name)
      expect(draft?.members).toHaveLength(teamTemplateSlots(entry).length)
      expect(draft?.members[0]?.role).toBe('leader')
    }
  })

  it('repeats assistants only when there are fewer than member slots', () => {
    const draft = teamTemplateDraft(template('release-check'), {
      workspaceId: '/tmp/repo',
      assistantIds: ['only', 'second'],
    })
    expect(draft?.members.map(member => member.assistantId)).toEqual(['only', 'second', 'only'])
    expect(draft?.members.map(member => member.role)).toEqual(['leader', 'member', 'member'])
  })

  it('waits for a workspace and an eligible assistant instead of fabricating a draft', () => {
    expect(teamTemplateDraft(template('feature-delivery'), {
      workspaceId: '   ',
      assistantIds: ['a1'],
    })).toBeUndefined()
    expect(teamTemplateDraft(template('feature-delivery'), {
      workspaceId: '/tmp/repo',
      assistantIds: [],
    })).toBeUndefined()
  })

  it('carries no template link into the created team', () => {
    const draft = teamTemplateDraft(template('repo-audit'), {
      workspaceId: '/tmp/repo',
      assistantIds: ['a1', 'a2', 'a3', 'a4'],
    })
    expect(Object.keys(draft ?? {}).sort()).toEqual(
      ['directMemberChat', 'members', 'name', 'workspaceId'],
    )
    for (const member of draft?.members ?? []) {
      expect(Object.keys(member).sort()).toEqual(['assistantId', 'role'])
    }
    expect(JSON.stringify(draft)).not.toContain('template')
    expect(draft).not.toHaveProperty('templateId')
    expect(draft).not.toHaveProperty('id')
  })

  it('returns fresh arrays and never mutates the frozen templates', () => {
    const before = JSON.stringify(TEAM_TEMPLATES)
    const templateEntry = template('feature-delivery')
    const first = teamTemplateDraft(templateEntry, {
      workspaceId: '/tmp/repo',
      assistantIds: ['a1', 'a2', 'a3'],
    })
    const second = teamTemplateDraft(templateEntry, {
      workspaceId: '/tmp/repo',
      assistantIds: ['a1', 'a2', 'a3'],
    })
    expect(first).not.toBe(second)
    expect(first?.members).not.toBe(second?.members)
    expect(Object.isFrozen(first?.members)).toBe(false)
    expect(JSON.stringify(TEAM_TEMPLATES)).toBe(before)
  })
})
