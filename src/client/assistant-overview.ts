import { assistantInstanceName } from './assistant-instances.js'
import type { AssistantInstanceView } from '../transport/contracts.js'

/** The settings groups 概览 may jump to; the pane owns the actual scroll. */
export type AssistantOverviewTarget = 'identity' | 'capabilities' | 'automations' | 'memory'

export type AssistantOverviewTodoId = 'instructions' | 'skills' | 'mcp' | 'automations' | 'memory'

/** One row of the 待办清单: what is missing, and the group that fixes it. */
export interface AssistantOverviewTodo {
  id: AssistantOverviewTodoId
  text: string
  target: AssistantOverviewTarget
}

/**
 * The two counts 概览 cannot derive from the instance snapshot. `undefined`
 * means "not read yet, or the deployment cannot tell us" — never evidence of
 * absence, so neither the checklist nor 不会做 may treat it as zero.
 */
export interface AssistantOverviewCounts {
  automations?: number | undefined
  memory?: number | undefined
}

/**
 * M1's one summary line, and the whole of its copy: how many memory entries the
 * assistant keeps, and the way into the 记忆 group. Zero is never shown as a
 * number — the empty memory says 还没有记录 instead of claiming "0 条", so the
 * line can only ever report a count it actually read.
 */
export function assistantMemoryCountLine(count: number): string {
  return count === 0 ? '记忆 · 还没有记录' : `记忆 · ${count} 条 · 管理 →`
}

/** Labels resolved by the pane from the catalog / snapshot. */
export interface AssistantOverviewLabels {
  template: string
  workspace: string
  permission: string
}

/**
 * The 待办清单, in the order 概览 shows them: description, skills, MCP, then the
 * two counts. An empty list means there is nothing to nag about — the block is
 * not rendered at all, so there is never an empty shell or a fake "all done".
 */
export function assistantOverviewTodos(
  instance: AssistantInstanceView,
  counts: AssistantOverviewCounts = {},
): AssistantOverviewTodo[] {
  const snapshot = instance.assistantSnapshot
  const todos: AssistantOverviewTodo[] = []
  if (snapshot.instructions.trim() === '') {
    todos.push({ id: 'instructions', text: '写一段描述，让它知道自己是干什么的', target: 'identity' })
  }
  if (snapshot.skillAllowlist.length === 0) {
    todos.push({ id: 'skills', text: '还没有授予任何技能', target: 'capabilities' })
  }
  if (snapshot.mcpServers.length === 0) {
    todos.push({ id: 'mcp', text: '还没有可用的 MCP 工具', target: 'capabilities' })
  }
  if (counts.automations === 0) {
    todos.push({ id: 'automations', text: '没有自动化任务，它不会自己定时干活', target: 'automations' })
  }
  if (counts.memory === 0) {
    todos.push({ id: 'memory', text: '还没有记忆，它不会记住上次的结论', target: 'memory' })
  }
  return todos
}

/** 它是什么: the name, the stored description, and the three fields worth keeping. */
export interface AssistantOverviewWho {
  name: string
  /** Stored description, trimmed; `''` when the assistant has none. */
  description: string
  /** 模板 · Workspace · 权限预设, already resolved by the pane. */
  meta: string[]
}

export function assistantOverviewWho(
  instance: AssistantInstanceView,
  labels: AssistantOverviewLabels,
): AssistantOverviewWho {
  return {
    name: assistantInstanceName(instance),
    description: instance.assistantSnapshot.instructions.trim(),
    meta: [`模板：${labels.template}`, `Workspace：${labels.workspace}`, `权限：${labels.permission}`],
  }
}

/** 能力边界, as generated sentences rather than a field table. */
export interface AssistantOverviewLimits {
  /** What it can do. Empty means nothing at all was granted. */
  capable: string[]
  /** What it really cannot do; a known capability never appears here. */
  unable: string[]
}

export function assistantOverviewLimits(
  instance: AssistantInstanceView,
  input: AssistantOverviewCounts & AssistantOverviewLabels,
): AssistantOverviewLimits {
  const snapshot = instance.assistantSnapshot
  const capable: string[] = []
  if (snapshot.skillAllowlist.length > 0) {
    capable.push(`可以使用 ${snapshot.skillAllowlist.length} 个技能（${snapshot.skillAllowlist.join('、')}）`)
  }
  if (snapshot.mcpServers.length > 0) {
    capable.push(`可以调用 ${snapshot.mcpServers.length} 个 MCP 工具`)
  }
  if (input.workspace.trim() !== '') {
    capable.push(`运行在「${input.workspace}」工作区，权限：${input.permission}`)
  }
  // Both negatives are real observations only: an unread count stays silent.
  const unable: string[] = []
  if (input.automations === 0) unable.push('没有自动化任务，不会自己按时执行')
  if (input.memory === 0) unable.push('没有记忆，不会保留上次的结论')
  return { capable, unable }
}
