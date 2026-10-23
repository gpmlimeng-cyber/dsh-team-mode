import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (name: string): string => readFileSync(
  new URL(`../src/client/${name}`, import.meta.url),
  'utf8',
)

const index = readSource('index.tsx')
const board = readSource('team-board.tsx')
const parallel = readSource('team-parallel.tsx')

/** Extract the brace-matched body of the function whose signature contains `needle`. */
function functionBody(source: string, needle: string): string {
  const start = source.indexOf(needle)
  if (start < 0) throw new Error(`missing function signature: ${needle}`)
  const lineEnd = source.indexOf('\n', start)
  const open = source.lastIndexOf('{', lineEnd)
  let depth = 0
  for (let cursor = open; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1
    else if (source[cursor] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, cursor)
    }
  }
  throw new Error(`unbalanced body for: ${needle}`)
}

describe('openTeamPage', () => {
  const body = functionBody(index, 'const openTeamPage = (teamId: string): void => {')

  it('opens the Leader main Session', () => {
    expect(body).toContain('team.members[team.leaderSlotId]')
    expect(body).toContain('openSession(leader.sessionId)')
    expect(body.indexOf('keepNativeConversationTab(leader.sessionId)'))
      .toBeLessThan(body.indexOf('openSession(leader.sessionId)'))
  })

  it('fails safely when the Leader cannot be resolved', () => {
    expect(body).toContain('if (leader === undefined) return')
    expect(body).toContain('.catch(() => undefined)')
    expect(body.indexOf('if (leader === undefined) return'))
      .toBeLessThan(body.indexOf('openSession(leader.sessionId)'))
  })

  it('never selects the parallel view while opening a team', () => {
    expect(body).not.toContain("'parallel'")
    expect(body).not.toContain('setTeamConversationView')
  })
})

describe('native conversation default', () => {
  it('writes the shipped chat view under the shell Session key', () => {
    expect(board).toContain("const CONVERSATION_STORE_KEY = 'dsh.conversation'")
    expect(board).toContain("const NATIVE_CONVERSATION_VIEW_ID = 'chat'")
    const body = functionBody(board, 'function keepConversationView(sessionId: string, view: string): void {')
    expect(body).toContain('`${CONVERSATION_STORE_KEY}.${sessionId}`')
    expect(body).toContain('if (current.view === view) return')
    expect(body).toContain('{ ...current, view }')
  })

  it('preserves the rest of the stored entry and tolerates restricted storage', () => {
    const body = functionBody(board, 'function keepConversationView(sessionId: string, view: string): void {')
    expect(body).toContain('readStorageJson(key)')
    expect(body).toContain('writeStorageJson(key')
    expect(body).not.toContain('removeStorage')
    expect(body).not.toContain('throw ')
  })

  it('is exported and reused before team navigation', () => {
    expect(board).toContain('export function keepNativeConversationTab(sessionId: string): void {')
    expect(board).toContain('keepConversationView(sessionId, NATIVE_CONVERSATION_VIEW_ID)')
    expect(index).toContain('keepNativeConversationTab,')
    expect(index).toContain('keepNativeConversationTab(leader.sessionId)')
  })
})

describe('parallel view stays an explicit tab', () => {
  it('keeps the 群聊 tab registered beside the native chat view', () => {
    expect(index).toContain("register('team-parallel', '群聊', 6, TeamParallelView as never)")
  })

  it('marks parallel presence only when its own view renders', () => {
    const body = functionBody(
      parallel,
      'export function TeamParallelView({ sessionId }: { sessionId?: string }): JSX.Element {',
    )
    expect(body).toContain("setTeamConversationView(sessionId, 'parallel')")
    expect(index).not.toContain("setTeamConversationView(leader.sessionId, 'parallel')")
  })

  it('keeps the board reachable through its own registration', () => {
    expect(index).toContain('register(TEAM_BOARD_VIEW_ID, TEAM_BOARD_VIEW_LABEL, TEAM_BOARD_VIEW_ORDER, TeamBoardView as never)')
    expect(board).toContain('export const TEAM_BOARD_VIEW_ID = ')
  })
})
