import { useEffect, useState } from 'react'

type Translate = (key: string, vars?: Readonly<Record<string, string | number>>) => string

export interface TeamLocaleService {
  register: (ns: string, dictionaries: { zh: Record<string, string>, en: Record<string, string> }) => (() => void) | void
  bind: (ns: string) => Translate
  subscribe?: (listener: () => void) => () => void
}

const zh: Record<string, string> = {
  'view.label': '视图',
  'view.parallel': '并行',
  'view.single': '单聊',
  'view.board': '看板',
  'member.add': '添加成员',
  'member.retry': '重试',
  'member.reconnect': '重连',
  'member.resetContext': '清空上下文',
  'member.rename': '重命名',
  'member.remove': '移出成员',
  'member.up': '上移',
  'member.down': '下移',
  'member.leader': 'Leader',
  'member.setLeader': '设为 Leader',
  'warmup.title': '正在唤醒团队…',
  'warmup.timeoutTitle': '团队启动超时',
  'warmup.errorTitle': '团队未能启动',
  'warmup.preparing': '正在准备 {name} 与成员',
  'warmup.timeoutText': 'Leader 在 60 秒内没有就绪，可以重试启动。',
  'warmup.failed': '已失败的成员：{names}',
  'warmup.retry': '重试',
  'warmup.leaderFailed': 'Leader 启动失败，请重试。',
  'sidebar.pin': '置顶',
  'sidebar.title': '团队',
  'sidebar.expandAll': '展开全部成员',
  'sidebar.collapseAll': '收起全部成员',
  'sidebar.onlyPending': '只看待确认',
  'sidebar.members': '成员',
  'sidebar.filter': '筛选',
  'sidebar.sort': '排序',
  'sidebar.sortUpdated': '最近更新',
  'sidebar.sortName': '名称',
  'sidebar.empty': '新建团队',
  'sidebar.noMatches': '没有匹配的团队',
  'sidebar.unpin': '取消置顶',
  'sidebar.archive': '归档',
  'sidebar.restore': '恢复',
  'sidebar.showArchived': '显示归档团队',
  'sidebar.manage': '团队管理',
  'sidebar.add': '新建团队',
  'sidebar.search': '搜索团队',
  'sidebar.viewOptions': '视图选项',
  'context.title': '清空成员上下文',
  'context.description': '只替换该成员的 Session，任务、文件、模型和团队配置保留。',
  'context.confirmTitle': '为“{name}”开始新上下文？',
  'context.body': '当前 Agent 会话会停止并换用新的 Session；聊天记录、任务、文件、模型和成员配置都会保留，但该成员不再拥有旧会话的推理上下文。',
  'context.confirm': '确认清空',
  'context.busy': '清空中…',
  'common.cancel': '取消',
  'common.close': '关闭',
}

const en: Record<string, string> = {
  'view.label': 'View',
  'view.parallel': 'Parallel',
  'view.single': 'Single',
  'view.board': 'Board',
  'member.add': 'Add member',
  'member.retry': 'Retry',
  'member.reconnect': 'Reconnect',
  'member.resetContext': 'Reset context',
  'member.rename': 'Rename',
  'member.remove': 'Remove member',
  'member.up': 'Move up',
  'member.down': 'Move down',
  'member.leader': 'Leader',
  'member.setLeader': 'Set as Leader',
  'warmup.title': 'Waking up the team…',
  'warmup.timeoutTitle': 'Team startup timed out',
  'warmup.errorTitle': 'The team failed to start',
  'warmup.preparing': 'Preparing {name} and the members',
  'warmup.timeoutText': 'The Leader did not become ready within 60 seconds. You can retry.',
  'warmup.failed': 'Members that failed: {names}',
  'warmup.retry': 'Retry',
  'warmup.leaderFailed': 'The Leader failed to start. Please retry.',
  'sidebar.pin': 'Pin',
  'sidebar.title': 'Teams',
  'sidebar.expandAll': 'Expand all members',
  'sidebar.collapseAll': 'Collapse all members',
  'sidebar.onlyPending': 'Only pending',
  'sidebar.members': 'Members',
  'sidebar.filter': 'Filter',
  'sidebar.sort': 'Sort',
  'sidebar.sortUpdated': 'Recently updated',
  'sidebar.sortName': 'Name',
  'sidebar.empty': 'New team',
  'sidebar.noMatches': 'No matching teams',
  'sidebar.unpin': 'Unpin',
  'sidebar.archive': 'Archive',
  'sidebar.restore': 'Restore',
  'sidebar.showArchived': 'Show archived teams',
  'sidebar.manage': 'Manage team',
  'sidebar.add': 'New team',
  'sidebar.search': 'Search teams',
  'sidebar.viewOptions': 'View options',
  'context.title': 'Reset member context',
  'context.description': 'Replace only this member’s Session; tasks, files, model and team config stay.',
  'context.confirmTitle': 'Start a new context for “{name}”?',
  'context.body': 'The current Agent session stops and a fresh Session replaces it. History, tasks, files, model and member config stay, but the member loses the old reasoning context.',
  'context.confirm': 'Reset context',
  'context.busy': 'Resetting…',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
}

export const TEAM_ZH = zh
export const TEAM_EN = en

let translate: Translate | undefined
let service: TeamLocaleService | undefined

function fallback(key: string, vars?: Readonly<Record<string, string | number>>): string {
  const table = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? zh : en
  return interpolate(table[key] ?? zh[key] ?? key, vars)
}

function interpolate(text: string, vars?: Readonly<Record<string, string | number>>): string {
  if (vars === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars[name] === undefined ? match : String(vars[name]))
}

/** Register the namespace once per client tree. */
export interface TeamLocaleContext {
  locale?: TeamLocaleService | undefined
}

export function installTeamLocale(ctx: TeamLocaleContext): void {
  const next = ctx.locale
  if (next === undefined) return
  service = next
  next.register('team', { zh, en })
  translate = next.bind('team')
}

export function teamText(
  key: string,
  vars?: Readonly<Record<string, string | number>>,
): string {
  try {
    return translate === undefined ? fallback(key, vars) : interpolate(translate(key), vars)
  } catch {
    return fallback(key, vars)
  }
}

/** Translate and re-render the calling component when the locale changes. */
export function useTeamText(): typeof teamText {
  const [, setRevision] = useState(0)
  useEffect(() => {
    if (service?.subscribe === undefined) return
    return service.subscribe(() => { setRevision(value => value + 1) })
  }, [])
  return teamText
}
