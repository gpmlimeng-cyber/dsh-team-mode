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
    // `team.get` is the authoritative Leader: the row's cached aggregate can be
    // a revision behind a Leader change.
    expect(body).toContain("callAgentTeam('team.get', { id: teamId })")
    expect(body).toContain('teamLeaderSessionId(value)')
    expect(body).toContain('openSession(sessionId)')
    expect(body.indexOf('keepNativeConversationTab(sessionId)'))
      .toBeLessThan(body.indexOf('openSession(sessionId)'))
  })

  it('fails visibly when the Leader cannot be resolved', () => {
    // F2: an unresolvable Leader used to `return`, so the click did nothing and
    // the swallowed `.catch(() => undefined)` hid a refused navigation.
    expect(body).toContain('reportNavigationError(\'无法打开该团队')
    expect(body).not.toContain('.catch(() => undefined)')
    expect(body.indexOf('if (sessionId === undefined)'))
      .toBeLessThan(body.indexOf('openSession(sessionId)'))
    expect(body).toContain('reportNavigationError(navigationErrorMessage(cause))')
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
    expect(index).toContain('keepNativeConversationTab(sessionId)')
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
