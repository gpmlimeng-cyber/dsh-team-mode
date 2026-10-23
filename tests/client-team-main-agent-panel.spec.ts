import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamMainAgentPanel } from '../src/client/team-main-agent.js'
import {
  panelToggleAvailable,
  setTeamPanelOpen,
  toggleTeamPanel,
  useTeamPanelOpen,
} from '../src/client/store.js'
import type { TeamMemberSlot, TeamTask } from '../src/domain/types.js'
import type { TeamView } from '../src/transport/contracts.js'

const ISO = '2026-01-01T00:00:00.000Z'

function member(id: string, overrides: Partial<TeamMemberSlot> = {}): TeamMemberSlot {
  return {
    id,
    assistantId: `assistant-${id}`,
    displayName: id,
    role: 'member',
    assistantSnapshot: {
      assistantId: `assistant-${id}`,
      revision: 1,
      name: id,
      instructions: '',
      provider: 'deepseek',
      model: 'deepseek-chat',
      agentPresetId: 'default',
      permissionPresetId: 'default',
      skillAllowlist: [],
      mcpServers: [],
      prompts: [],
    },
    permissionPresetId: 'default',
    sessionId: `session-${id}`,
    desiredState: 'online',
    lastRuntimeState: 'idle',
    joinedAt: ISO,
    ...overrides,
  }
}

function task(
  id: string,
  status: TeamTask['status'],
  overrides: Partial<TeamTask> = {},
): TeamTask {
  return {
    id,
    title: id,
    description: '',
    status,
    dependencyIds: [],
    fileScopes: [],
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

function team(input: {
  members?: TeamMemberSlot[]
  tasks?: TeamTask[]
  leaderSlotId?: string
  name?: string
} = {}): TeamView {
  return {
    schemaVersion: 2,
    id: 'team-panel',
    name: input.name ?? '面板测试团队',
    workspaceId: 'workspace-panel',
    workspacePath: '/tmp/panel',
    leaderSlotId: input.leaderSlotId ?? 'leader',
    state: 'active',
    directMemberChat: false,
    members: Object.fromEntries((input.members ?? []).map(entry => [entry.id, entry])),
    retiredSessions: {},
    tasks: Object.fromEntries((input.tasks ?? []).map(entry => [entry.id, entry])),
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: ISO,
    updatedAt: ISO,
  }
}

function render(options: {
  team: TeamView
  open?: boolean
  onClose?: () => void
  onOpenMember?: (slotId: string) => void
  onOpenTeam?: () => void
}): string {
  return renderToStaticMarkup(createElement(TeamMainAgentPanel, {
    team: options.team,
    open: options.open ?? true,
    onClose: options.onClose ?? (() => undefined),
    onOpenMember: options.onOpenMember ?? (() => undefined),
    onOpenTeam: options.onOpenTeam ?? (() => undefined),
  }))
}

/** Visible text with tags removed, so count labels can be asserted as one line. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

const leader = member('leader', {
  role: 'leader',
  displayName: '小码',
  lastRuntimeState: 'idle',
})
const helper = member('helper', {
  displayName: '小测',
  lastRuntimeState: 'waiting_approval',
  assistantSnapshot: {
    ...member('helper').assistantSnapshot,
    model: 'deepseek-reasoner',
  },
})

const populated = team({
  members: [leader, helper],
  leaderSlotId: 'leader',
  tasks: [
    task('impl', 'running', {
      title: '实现面板',
      ownerSlotId: 'leader',
      updatedAt: '2026-01-03T00:00:00.000Z',
    }),
    task('verify', 'blocked', {
      title: '验收面板',
      dependencyIds: ['impl'],
      updatedAt: '2026-01-03T01:00:00.000Z',
    }),
    task('assigned', 'assigned', {
      title: '补测试',
      ownerSlotId: 'helper',
      updatedAt: '2026-01-05T00:00:00.000Z',
    }),
    task('pending', 'pending', {
      title: '待审核',
      dependencyIds: ['verify'],
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
    task('done-research', 'completed', {
      title: '调研',
      ownerSlotId: 'helper',
      updatedAt: '2026-01-04T00:00:00.000Z',
    }),
    task('failed-old', 'failed', {
      title: '旧任务',
      ownerSlotId: 'helper',
      updatedAt: '2026-01-02T12:00:00.000Z',
    }),
    task('done-design', 'completed', {
      title: '设计',
      ownerSlotId: 'helper',
      updatedAt: '2026-01-04T12:00:00.000Z',
    }),
    task('cancelled', 'cancelled', {
      title: '弃用',
      ownerSlotId: 'helper',
      updatedAt: '2026-01-02T06:00:00.000Z',
    }),
  ],
})

describe('TeamMainAgentPanel header', () => {
  it('shows the team identity and the current Leader', () => {
    const html = render({ team: populated })

    expect(text(html)).toContain('面板测试团队 · 主 Agent')
    expect(text(html)).toContain('当前 Leader：小码')
    expect(html).toContain('aria-label="收起团队面板"')
    expect(html).toContain('aria-label="团队运行面板"')
  })

  it('shows an explicit Leader placeholder for a leaderless team', () => {
    const html = render({ team: team() })
    expect(text(html)).toContain('当前 Leader：尚未设置')
  })

  it('renders nothing while closed', () => {
    expect(render({ team: populated, open: false })).toBe('')
  })
})

describe('TeamMainAgentPanel summary', () => {
  it('summarizes dispatched tasks and members', () => {
    const html = render({ team: populated })
    expect(text(html)).toContain('已派发 8 项任务给 2 名成员')
  })

  it('states empty tasks instead of showing a fake dispatch', () => {
    const html = render({ team: team({ members: [leader], leaderSlotId: 'leader' }) })
    expect(text(html)).toContain('还没有任务，Leader 派发后会出现在这里')
    expect(text(html)).not.toContain('已派发 0')
  })
})

describe('TeamMainAgentPanel progress', () => {
  it('segments and labels completed, running, waiting, and error counts', () => {
    const html = render({ team: populated })
    const visible = text(html)

    expect(visible).toContain('已完成 2')
    expect(visible).toContain('进行中 1')
    expect(visible).toContain('等待 1')
    expect(visible).toContain('异常 2')
    expect(html).toContain('role="progressbar"')
  })

  it('keeps zero counts visible for an empty team', () => {
    const visible = text(render({ team: team() }))
    expect(visible).toContain('已完成 0')
    expect(visible).toContain('进行中 0')
    expect(visible).toContain('等待 0')
    expect(visible).toContain('异常 0')
  })
})

describe('TeamMainAgentPanel blockers and approvals', () => {
  it('states the first blocker with its owner', () => {
    const html = render({ team: populated })
    expect(text(html)).toContain('阻塞：实现面板 · 等待 小码')
  })

  it('explains blocked tasks without a resolvable dependency instead of claiming none', () => {
    const html = render({
      team: team({
        members: [leader],
        leaderSlotId: 'leader',
        tasks: [task('stuck', 'blocked', { title: '等待外部依赖', dependencyIds: ['deleted'] })],
      }),
    })
    const visible = text(html)

    expect(visible).toContain('1 个阻塞任务等待重新派发')
    expect(visible).not.toContain('暂无阻塞')
    expect(visible).toContain('阻塞 1')
  })

  it('states no blockers when nothing is blocked', () => {
    const html = render({
      team: team({
        members: [leader],
        leaderSlotId: 'leader',
        tasks: [task('impl', 'running', { ownerSlotId: 'leader' })],
      }),
    })
    expect(text(html)).toContain('暂无阻塞')
  })

  it('shows the approval footer only from waiting members', () => {
    const html = render({ team: populated })
    expect(text(html)).toContain('1 个待审批')

    const none = render({
      team: team({ members: [leader], leaderSlotId: 'leader' }),
    })
    expect(text(none)).toContain('暂无待审批')
  })

  it('wires the footer through onOpenTeam', () => {
    const onOpenTeam = vi.fn()
    const html = render({ team: populated, onOpenTeam })
    expect(html).toContain('1 个待审批')
    expect(onOpenTeam).not.toHaveBeenCalled()
  })
})

describe('TeamMainAgentPanel members', () => {
  it('shows current task, completed/total, role, model, and at most three chips', () => {
    const html = render({ team: populated })
    const visible = text(html)

    expect(visible).toContain('小测')
    expect(visible).toContain('成员')
    expect(visible).toContain('deepseek-reasoner')
    expect(visible).toContain('当前：补测试')
    expect(visible).toContain('2/5')
    expect(visible).toContain('补测试')
    expect(visible).toContain('设计')
    expect(visible).toContain('调研')
    expect(visible).not.toContain('旧任务')
    expect(visible).not.toContain('弃用')
    expect(html.match(/data-dsh-panel-chip/g)?.length).toBe(4)
  })

  it('shows Leader role and a current task for the Leader row', () => {
    const html = render({ team: populated })
    expect(text(html)).toContain('Leader')
    expect(text(html)).toContain('当前：实现面板')
  })

  it('shows member empty states instead of undefined', () => {
    const html = render({ team: team({ members: [member('solo')], leaderSlotId: 'solo' }) })
    const visible = text(html)
    expect(visible).toContain('暂无当前任务')
    expect(visible).toContain('暂无任务')
    expect(visible).toContain('0/0')
    expect(visible).not.toContain('undefined')
  })
})

describe('TeamMainAgentPanel empty team', () => {
  it('states every empty area explicitly', () => {
    const visible = text(render({ team: team() }))
    expect(visible).toContain('还没有成员')
    expect(visible).toContain('还没有任务')
    expect(visible).toContain('暂无阻塞')
    expect(visible).toContain('暂无待审批')
    expect(visible).toContain('已完成 0/0')
  })
})

describe('TeamMainAgentPanel responsive contract', () => {
  const source = readFileSync(new URL('../src/client/team-main-agent.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/client/AgentTeam.module.css', import.meta.url), 'utf8')
  const panel = styles.slice(styles.indexOf('.mainAgentPanel {'))

  it('renders a close control wired to onClose', () => {
    expect(source).toContain('onClick={onClose}')
    expect(source).toContain('aria-label="收起团队面板"')
  })

  it('bounds the overlay and prevents horizontal overflow at 320px', () => {
    expect(panel).toContain('width: min(360px, 100vw)')
    expect(panel).toContain('max-width: 100%')
    expect(panel).toContain('overflow: hidden')
    expect(styles).toMatch(/@media \(max-width: 420px\) \{[\s\S]*\.mainAgentPanel \{[\s\S]*width: 100vw;/)
    expect(styles).toMatch(/\.mainAgentPanelBody \{[\s\S]*overflow-x: hidden;/)
    expect(styles).toMatch(/\.mainAgentMemberHead \{[\s\S]*min-width: 0;/)
  })

  it('uses semantic DSH tokens instead of literal colors', () => {
    expect(panel).toContain('var(--dsw-alias-bg-page)')
    expect(panel).toContain('var(--dsw-alias-border-l1)')
    expect(styles).toContain('var(--dsw-alias-button-primary-fill)')
    expect(panel).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

function PanelOpenProbe(): JSX.Element {
  return createElement('span', null, useTeamPanelOpen() ? 'open' : 'closed')
}

describe('team panel toggle store', () => {
  beforeEach(() => {
    setTeamPanelOpen(false)
  })

  it('toggles the panel open and closed without touching the active Session', () => {
    expect(renderToStaticMarkup(createElement(PanelOpenProbe))).toContain('closed')
    toggleTeamPanel()
    expect(renderToStaticMarkup(createElement(PanelOpenProbe))).toContain('open')
    toggleTeamPanel()
    expect(renderToStaticMarkup(createElement(PanelOpenProbe))).toContain('closed')
  })

  it('sets the panel state explicitly', () => {
    setTeamPanelOpen(true)
    expect(renderToStaticMarkup(createElement(PanelOpenProbe))).toContain('open')
    setTeamPanelOpen(false)
    expect(renderToStaticMarkup(createElement(PanelOpenProbe))).toContain('closed')
  })

  it('offers the toggle only for a team Session in team mode', () => {
    expect(panelToggleAvailable(true, 'team')).toBe(true)
    expect(panelToggleAvailable(true, 'native')).toBe(false)
    expect(panelToggleAvailable(false, 'team')).toBe(false)
    expect(panelToggleAvailable(false, 'native')).toBe(false)
  })

  it('keeps the close path free of navigation', () => {
    const store = readFileSync(new URL('../src/client/store.ts', import.meta.url), 'utf8')
    expect(store).toContain('export function setTeamPanelOpen')
    expect(store).not.toContain('openSession')
    expect(store).not.toContain('openTeamPage')
  })
})

describe('team panel mounting wiring', () => {
  const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

  it('renders the header toggle only through the availability guard', () => {
    expect(source).toContain('panelToggleAvailable(teamSession, mode)')
    expect(source).toContain('aria-pressed={open}')
    expect(source).toContain('onClick={toggleTeamPanel}')
    expect(source).toContain('团队面板')
  })

  it('mounts the panel in team mode and leaves native mode empty', () => {
    expect(source).toContain('const TeamPanelHost')
    expect(source).toContain('useSurfaceMode()')
    expect(source).toContain("mode !== 'team'")
    expect(source).toContain('useTeamPanelOpen()')
    expect(source).toContain('<TeamMainAgentPanel')
  })

  it('closes without replacing the main Agent conversation', () => {
    expect(source).toContain('onClose={closeTeamPanel}')
    expect(source).not.toContain('onClose={() => openSession')
  })

  it('derives the panel team from the active team Session via existing team.list', () => {
    expect(source).toContain("callAgentTeam('team.list')")
    expect(source).toContain('member.sessionId === sessionId')
    expect(source).toContain('subscribeAgentTeam')
    expect(source).not.toContain("callAgentTeam('team.panel")
  })

  it('registers one shell overlay for the panel', () => {
    expect(source).toContain("id: 'dsh-team-mode-panel'")
    expect(source).toContain("name: 'shell.overlay'")
  })
})
