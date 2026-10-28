import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The primitives bundle ships without its own runtime dependencies in this
// checkout; the entry only needs the element shape, not the styling.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: h } = await import('react')
  const api: Record<string, unknown> = {
    Button: (props: Record<string, unknown>) => h('button', {
      disabled: props.disabled as boolean,
      onClick: props.onClick as () => void,
    }, props.children as never),
  }
  return new Proxy(api, {
    get: (target, key) => {
      if (typeof key !== 'string' || key === 'then' || key === '__esModule') return undefined
      if (!(key in target)) target[key] = () => null
      return target[key]
    },
  })
})

// One spy stands in for the Host call, so the test asserts the method and the
// payload the primary action posts — not that a string appears in the source.
const { send } = vi.hoisted(() => ({ send: vi.fn(async () => ({})) }))
vi.mock('../src/client/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/client/api.js')>('../src/client/api.js')
  return { ...actual, callAgentTeam: send }
})

import {
  NEXT_STEP_BODY,
  NEXT_STEP_SAMPLE_DETAIL,
  NEXT_STEP_SAMPLE_LABEL,
  NEXT_STEP_TALK_LABEL,
  NEXT_STEP_TITLE,
  SAMPLE_TASK_INSTRUCTION,
  TeamNextStepCard,
  sampleTaskRequest,
  showTeamNextStep,
  startSampleTask,
  type NextStepTeam,
} from '../src/client/team-next-step.js'

function team(overrides: Partial<NextStepTeam> = {}): NextStepTeam {
  return {
    id: 'team-1',
    leaderSlotId: 'leader',
    members: { leader: { sessionId: 'session-leader' } },
    tasks: {},
    state: 'active',
    ...overrides,
  }
}

/** The same team after the Lead has created the sample task. */
const withTask = team({ tasks: { 'task-1': { id: 'task-1', status: 'pending' } } })

function render(target: NextStepTeam): string {
  return renderToStaticMarkup(createElement(TeamNextStepCard, {
    team: target,
    onOpenLeader: () => {},
  }))
}

beforeEach(() => { send.mockClear() })

describe('first-use next step: when it shows', () => {
  it('shows on a fresh team that has no task yet', () => {
    expect(showTeamNextStep(team())).toBe(true)
    expect(sampleTaskRequest(team())).toBeDefined()
    const html = render(team())
    expect(html).toContain('data-dsh-team-next-step')
    expect(html).toContain(NEXT_STEP_TITLE)
    expect(html).toContain(NEXT_STEP_BODY)
    expect(html).toContain(NEXT_STEP_SAMPLE_LABEL)
    expect(html).toContain(NEXT_STEP_TALK_LABEL)
    // The task the button creates is quoted: no mystery click.
    expect(html).toContain(NEXT_STEP_SAMPLE_DETAIL)
  })

  it('hides once the team has a task, so it never becomes furniture', () => {
    expect(showTeamNextStep(withTask)).toBe(false)
    expect(sampleTaskRequest(withTask)).toBeUndefined()
    expect(render(withTask)).toBe('')
  })

  it('hides once the team has a Goal, so a template-created team adds no duplicate', () => {
    // A template can hand a new team its objective before the user ever sees
    // the row; the team has then started, and a second "create the first task"
    // instruction would be exactly the duplicate this entry exists to avoid.
    const withGoal = team({ goals: { 'goal-1': { id: 'goal-1', status: 'active' } } })
    expect(showTeamNextStep(withGoal)).toBe(false)
    expect(sampleTaskRequest(withGoal)).toBeUndefined()
    expect(render(withGoal)).toBe('')
  })

  it('hides once the team has a thread, so it never talks over a conversation', () => {
    const withThread = team({ threads: { 'thread-1': { id: 'thread-1', sessionId: 's-1' } } })
    expect(showTeamNextStep(withThread)).toBe(false)
    expect(sampleTaskRequest(withThread)).toBeUndefined()
    expect(render(withThread)).toBe('')
  })

  it('hides while the Leader is already working or parked on an approval', () => {
    const running = team({ members: { leader: { sessionId: 'session-leader', lastRuntimeState: 'running' } } })
    const waiting = team({ members: { leader: { sessionId: 'session-leader', lastRuntimeState: 'waiting_approval' } } })
    expect(showTeamNextStep(running)).toBe(false)
    expect(render(running)).toBe('')
    expect(showTeamNextStep(waiting)).toBe(false)
    expect(render(waiting)).toBe('')
  })

  it('still shows when the Leader is merely resting, so the gate is not a blanket hide', () => {
    const idle = team({ members: { leader: { sessionId: 'session-leader', lastRuntimeState: 'idle' } } })
    expect(showTeamNextStep(idle)).toBe(true)
    expect(render(idle)).toContain('data-dsh-team-next-step')
    // An absent member record reads as resting too: old fixtures keep working.
    expect(showTeamNextStep(team({ goals: {}, threads: {} }))).toBe(true)
  })

  it('hides on a team that cannot take an instruction yet', () => {
    expect(showTeamNextStep(team({ state: 'starting' }))).toBe(false)
    expect(render(team({ state: 'starting' }))).toBe('')
    expect(showTeamNextStep(team({ archivedAt: '2026-01-01T00:00:00.000Z' }))).toBe(false)
  })

  it('hides on an empty team (no resolvable leader session) instead of offering a dead button', () => {
    const noSession = team({ members: { leader: { sessionId: '' } } })
    expect(showTeamNextStep(noSession)).toBe(false)
    expect(render(noSession)).toBe('')
    const noMembers = team({ members: {} })
    expect(showTeamNextStep(noMembers)).toBe(false)
    expect(render(noMembers)).toBe('')
  })
})

describe('first-use next step: the one-click wiring', () => {
  it('sends the sample instruction to the leader through team.message.send', async () => {
    await startSampleTask(team())
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('team.message.send', {
      teamId: 'team-1',
      content: SAMPLE_TASK_INSTRUCTION,
      targetSlotId: 'leader',
    })
  })

  it('posts nothing once the entry is hidden', async () => {
    await startSampleTask(withTask)
    expect(send).not.toHaveBeenCalled()
  })

  it('renders directly under the team row, with no expandable roster', () => {
    // The entry has to sit where a new team appears: under its own row, in the
    // row's flow, now that the sidebar no longer expands into a thread list.
    const sidebar = readFileSync(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')
    expect(sidebar).toMatch(/<\/div>\n\s*\{\/\* First use:[\s\S]{0,400}<TeamNextStepCard team=\{team\} onOpenLeader/)
    expect(sidebar).not.toContain('data-dsh-team-threads')
  })
})

describe('first-use next step: copy', () => {
  it('names the two things the user can actually see: 工作区 and Leader', () => {
    const html = render(team())
    expect(html).toContain('工作区')
    expect(html).toContain('Leader')
    expect(NEXT_STEP_BODY).toContain('工作区')
    expect(NEXT_STEP_BODY).toContain('Leader')
  })

  it('labels the primary action as the first task, not as a demo', () => {
    expect(NEXT_STEP_SAMPLE_LABEL).toBe('建第一条任务')
    const html = render(team())
    expect(html).toContain('建第一条任务')
    expect(html).not.toContain('样例')
  })

  it('asks for a resumable task, so sending it twice cannot duplicate work', () => {
    // Idempotence lives in the instruction: a second send (another window, a
    // reload, a retry) resumes instead of creating a parallel task.
    expect(SAMPLE_TASK_INSTRUCTION).toContain('已经存在')
    expect(SAMPLE_TASK_INSTRUCTION).toContain('不要重复建')
    expect(SAMPLE_TASK_INSTRUCTION).toContain('接着做')
    // Delivery is still the one shipped payload, clause included.
    const request = sampleTaskRequest(team())
    expect(request?.content).toBe(SAMPLE_TASK_INSTRUCTION)
  })

  it('keeps the team protocol out of the copy', () => {
    const copy = [
      NEXT_STEP_TITLE,
      NEXT_STEP_BODY,
      NEXT_STEP_SAMPLE_DETAIL,
      NEXT_STEP_SAMPLE_LABEL,
      NEXT_STEP_TALK_LABEL,
      SAMPLE_TASK_INSTRUCTION,
      render(team()),
    ].join('\n')
    // Internal words must never be a precondition for the first task.
    expect(copy).not.toMatch(/评审|线程|批量/)
  })

  it('renders from exactly one place in the client, and that place is the sidebar row', () => {
    // A second surface (hero, board, detail tab) would duplicate the action;
    // this pins the entry to the one row the user lands on after creation.
    const dir = fileURLToPath(new URL('../src/client/', import.meta.url))
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.tsx'))
    const renderers = files.filter((entry) => {
      const source = readFileSync(join(dir, entry), 'utf8')
      return /<TeamNextStepCard\b/.test(source)
    })
    expect(renderers).toEqual(['sidebar.tsx'])
  })
})
