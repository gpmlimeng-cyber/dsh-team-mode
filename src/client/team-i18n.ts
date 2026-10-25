import { useEffect, useState } from 'react'

type Translate = (key: string, vars?: Readonly<Record<string, string | number>>) => string

export interface TeamLocaleService {
  register: (ns: string, dictionaries: { zh: Record<string, string>, en: Record<string, string> }) => (() => void) | void
  bind: (ns: string) => Translate
  subscribe?: (listener: () => void) => () => void
}

const zh: Record<string, string> = {
  'view.label': '视图',
  'view.parallel': '群聊',
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
  'sidebar.title': '群聊',
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
  'leaderChange.title': '更换 Leader',
  'leaderChange.description': '更换 Leader 会开启新的团队纪元，所有旧成员 Session 都会被归档。',
  'leaderChange.confirmTitle': '确定把「{name}」设为 Leader？',
  'leaderChange.body': '原 Leader 与所有成员的 Session 将停止并归档（聊天记录保留），每位成员换用新 Session；进行中的任务会被阻塞并解除负责人，进行中的目标会被暂停。确认后会自动打开新 Leader 的会话。',
  'leaderChange.confirm': '确认更换',
  'leaderChange.busy': '更换中…',
  'epoch.tag': '纪元 {epoch}',
  'common.cancel': '取消',
  'common.close': '关闭',
}

const en: Record<string, string> = {
  'view.label': 'View',
  'view.parallel': 'Parallel',
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
  'sidebar.title': 'Group chat',
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
  'leaderChange.title': 'Change Leader',
  'leaderChange.description': 'Changing the Leader starts a new team epoch; every old member Session is archived.',
  'leaderChange.confirmTitle': 'Make “{name}” the Leader?',
  'leaderChange.body': 'The current Leader and every member Session stop and are archived (history is kept); each member gets a fresh Session. Open tasks become blocked and lose their owner, active Goals are paused. The new Leader Session opens automatically.',
  'leaderChange.confirm': 'Change Leader',
  'leaderChange.busy': 'Changing…',
  'epoch.tag': 'Epoch {epoch}',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
}

export const TEAM_ZH = zh
export const TEAM_EN = en

let service: TeamLocaleService | undefined

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
}

/**
 * The team surface ships Chinese copy end to end: every hardcoded label, menu,
 * dialog and hint is Chinese. Resolving one key at a time from the shell locale
 * is what half-translated it — `Manage team` and `Reconnect` sitting next to
 * 置顶 and 归档 — so the namespace resolves Chinese and the `en` table stays as
 * the source for a future full pass instead of an always-partial result.
 */
export function teamText(
  key: string,
  vars?: Readonly<Record<string, string | number>>,
): string {
  return interpolate(zh[key] ?? key, vars)
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
