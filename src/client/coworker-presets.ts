import type { CatalogView } from '../transport/contracts.js'
import type { AssistantCreateDraft } from './assistant-form.js'

/**
 * The one-sentence field's cap. It mirrors
 * `ASSISTANT_CREATE_DRAFT_MAX_SENTENCE_CHARS` in src/domain/schemas.ts; the
 * client keeps its own copy so the browser bundle never imports the zod module
 * (same split as `ASSISTANT_TITLE_MAX_CHARS` in assistant-form.ts).
 */
export const COWORKER_SENTENCE_MAX_CHARS = 2_000

/**
 * One frozen starting role. A preset is a client constant, never a transport
 * call: picking one writes the same editable draft fields the user could type
 * by hand, and the footer 创建 is still the only thing that creates anything.
 */
export interface CoworkerPreset {
  id: string
  /** Chip label, and the name proposed for the draft. */
  name: string
  title: string
  blurb: string
  instructions: string
  /** Applied only while the catalog still offers it. */
  permissionPresetId: string
}

/**
 * Five fixed roles. They carry no Skill/MCP names on purpose: those catalogs
 * are per Agent Preset and live on the Host, so a hard-coded id would show up
 * as "no longer offered". The user's own capability selection is left alone.
 */
export const COWORKER_PRESETS: readonly CoworkerPreset[] = [
  {
    id: 'researcher',
    name: '研究员',
    title: '调研与结论',
    blurb: '先查一手资料，再给结论和不确定项。',
    instructions: '你负责调研：先收集一手资料并核对来源，再给出结论、依据和不确定的地方。没有依据的数字不要编。',
    permissionPresetId: 'read-only',
  },
  {
    id: 'reviewer',
    name: '审查员',
    title: '改动评审',
    blurb: '看改动是否有回归、越界和漏掉的测试。',
    instructions: '你负责评审：先读懂改动及其调用方，再指出正确性、回归风险和缺失的测试；每条结论给出文件与行号。',
    permissionPresetId: 'read-only',
  },
  {
    id: 'implementer',
    name: '实现者',
    title: '最小实现',
    blurb: '把需求变成可运行的最小改动。',
    instructions: '你负责实现：先读懂相关代码，再写最小可用的改动，并留下一条能抓住回归的检查。',
    permissionPresetId: 'workspace-write',
  },
  {
    id: 'tester',
    name: '测试员',
    title: '回归验证',
    blurb: '为改动补上能抓住回归的测试。',
    instructions: '你负责验证：针对改动补上最小但真实的测试，实际跑一遍，并报告观察到的结果而不是预期。',
    permissionPresetId: 'workspace-write',
  },
  {
    id: 'coordinator',
    name: '协调者',
    title: '拆解与协作',
    blurb: '把一句话拆成可并行、可验收的任务。',
    instructions: '你负责协调：把目标拆成可独立验收的任务，写清依赖与验收标准，再跟踪执行结果。',
    permissionPresetId: 'workspace-write',
  },
]

export function coworkerPresetById(presetId: string): CoworkerPreset | undefined {
  return COWORKER_PRESETS.find(preset => preset.id === presetId)
}

/** The permission a preset asks for, or nothing when the catalog lost it. */
function presetPermission(
  preset: CoworkerPreset,
  catalog: CatalogView | undefined,
): string | undefined {
  return catalog?.permissionPresets.some(entry => entry.value === preset.permissionPresetId) === true
    ? preset.permissionPresetId
    : undefined
}

/**
 * Fill one preset's identity and persona into the draft. Only the permission
 * preset is catalog-checked (an engine value the picker no longer offers would
 * be refused at submit); the workspace and the Skill/MCP selection stay exactly
 * as the user left them. A value the user edits afterwards is never re-applied:
 * this is one click, not a binding.
 */
export function applyCoworkerPreset(
  draft: AssistantCreateDraft,
  presetId: string,
  catalog: CatalogView | undefined,
): AssistantCreateDraft {
  const preset = coworkerPresetById(presetId)
  if (preset === undefined) return draft
  const permission = presetPermission(preset, catalog)
  return {
    ...draft,
    name: preset.name,
    title: preset.title,
    blurb: preset.blurb,
    instructions: preset.instructions,
    ...(permission === undefined ? {} : { permissionPresetId: permission }),
  }
}

/** The fields one read-only model call may propose; every one is optional. */
export interface CoworkerDraftSuggestion {
  name?: string | undefined
  title?: string | undefined
  blurb?: string | undefined
  instructions?: string | undefined
  /** One of `COWORKER_PRESETS`; an unknown id is ignored. */
  presetId?: string | undefined
}

/**
 * Apply one generated draft on top of what the dialog already holds. The
 * preset (when the model named a known one) fills the base, then the fields the
 * model actually answered override it; an absent or blank field keeps the
 * current value. Nothing here creates, saves or binds a template.
 */
export function applyCoworkerSuggestion(
  draft: AssistantCreateDraft,
  suggestion: CoworkerDraftSuggestion,
  catalog: CatalogView | undefined,
): AssistantCreateDraft {
  const base = suggestion.presetId === undefined
    ? draft
    : applyCoworkerPreset(draft, suggestion.presetId, catalog)
  const patch: Partial<AssistantCreateDraft> = {}
  const name = suggestion.name?.trim() ?? ''
  if (name !== '') patch.name = name
  const title = suggestion.title?.trim() ?? ''
  if (title !== '') patch.title = title
  const blurb = suggestion.blurb?.trim() ?? ''
  if (blurb !== '') patch.blurb = blurb
  const instructions = suggestion.instructions?.trim() ?? ''
  if (instructions !== '') patch.instructions = instructions
  return { ...base, ...patch }
}
