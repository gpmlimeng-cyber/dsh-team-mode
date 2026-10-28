import type { CreateTeamDraftInput } from '../domain/types.js'

/**
 * Built-in starting points for "new team". A template is copy only: it
 * prefills the existing create-team form and is never persisted, so a created
 * team has no template id, no link back, and no template-specific behavior.
 */
export type TeamTemplateId = 'repo-audit' | 'feature-delivery' | 'release-check'

export interface TeamTemplateRole {
  /** Display name of the role, e.g. 审查员. */
  readonly role: string
  /** How many members fill this role. Exactly one role carries `leader`. */
  readonly count: number
  readonly leader?: boolean
}

export interface TeamTemplateTask {
  /** Prefilled task title. */
  readonly title: string
  /** Prefilled acceptance criteria for that task. */
  readonly acceptance: readonly string[]
}

export interface TeamTemplate {
  readonly id: TeamTemplateId
  /** Label of the template's option in the create-team picker. */
  readonly label: string
  /** Prefilled team name. */
  readonly name: string
  readonly roles: readonly TeamTemplateRole[]
  readonly tasks: readonly TeamTemplateTask[]
}

/** One ordered member slot; the first role of a template is the Leader. */
export interface TeamTemplateSlot {
  readonly role: string
  readonly leader: boolean
}

export interface TeamTemplateDraftOptions {
  /** The workspace the form currently has selected; blank means nothing to map yet. */
  readonly workspaceId: string
  /**
   * Eligible assistant ids in form order. The caller filters the assistant
   * pool; this function only distributes it across the template slots.
   */
  readonly assistantIds: readonly string[]
}

/**
 * The three built-in templates from the team-templates plan. The picker adds
 * a "blank" option in the UI; blank creation never reads this file.
 */
export const TEAM_TEMPLATES: readonly TeamTemplate[] = deepFreeze([
  {
    id: 'repo-audit',
    label: '代码库体检队',
    name: '代码库体检',
    roles: [
      { role: 'Leader', count: 1, leader: true },
      { role: '审查员', count: 2 },
      { role: '复核员', count: 1 },
    ],
    tasks: [
      { title: '分片审查（每个审查员一条）', acceptance: ['每条发现带文件/行号/证据'] },
      { title: '交叉复核', acceptance: ['复核员 pass 才算完成'] },
      { title: '汇总报告', acceptance: ['每条发现带文件/行号/证据', '复核员 pass 才算完成'] },
    ],
  },
  {
    id: 'feature-delivery',
    label: '功能开发队',
    name: '功能开发',
    roles: [
      { role: 'Leader', count: 1, leader: true },
      { role: '实现', count: 1 },
      { role: '测试', count: 1 },
    ],
    tasks: [
      { title: '实现', acceptance: ['实现者不自评'] },
      { title: '验证', acceptance: ['验证通过才算完成'] },
      { title: '交付说明', acceptance: ['实现者不自评', '验证通过才算完成'] },
    ],
  },
  {
    id: 'release-check',
    label: '发布检查队',
    name: '发布检查',
    roles: [
      { role: 'Leader', count: 1, leader: true },
      { role: '构建', count: 1 },
      { role: '回归', count: 1 },
    ],
    tasks: [
      { title: '构建', acceptance: ['构建产物可复现'] },
      { title: '回归', acceptance: ['回归清单逐项勾选'] },
      { title: '发布清单', acceptance: ['构建产物可复现', '回归清单逐项勾选'] },
    ],
  },
] satisfies readonly TeamTemplate[])

/** Ordered member slots, with the Leader first and repeated roles expanded. */
export function teamTemplateSlots(template: TeamTemplate): readonly TeamTemplateSlot[] {
  return template.roles.flatMap(group =>
    Array.from({ length: group.count }, (_, index) => ({
      role: group.role,
      leader: group.leader === true && index === 0,
    })),
  )
}

/**
 * Map a template onto the existing `team.createDraft` payload. This is the
 * whole coupling: the result is plain draft input, and nothing from the
 * template survives into the created team.
 *
 * Returns `undefined` until the form has both a workspace and at least one
 * eligible assistant, because the draft schema requires a named workspace and
 * at least one member. Assistant ids are used in order and repeated only when
 * there are fewer assistants than slots.
 */
export function teamTemplateDraft(
  template: TeamTemplate,
  options: TeamTemplateDraftOptions,
): CreateTeamDraftInput | undefined {
  const workspaceId = options.workspaceId.trim()
  if (workspaceId.length === 0 || options.assistantIds.length === 0) return undefined
  const slots = teamTemplateSlots(template)
  return {
    name: template.name,
    workspaceId,
    directMemberChat: true,
    members: slots.map((slot, index) => ({
      assistantId: options.assistantIds[index % options.assistantIds.length]!,
      role: slot.leader ? 'leader' : 'member',
    })),
  }
}

/** Freeze template data in place so a consumer can never edit the built-ins. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}
