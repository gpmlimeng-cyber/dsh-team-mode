import { AgentTeamError } from '../domain/errors.js'

export interface TurnRoutingTeam {
  leaderSlotId: string
  members: Record<
    string,
    { id: string; displayName: string; role: 'leader' | 'member' }
  >
}

export function resolveTeamTarget(input: {
  team: TurnRoutingTeam
  content: string
  senderSlotId?: string
  explicitSlotId?: string
}): { slotId: string; reason: 'explicit' | 'mention' | 'default' } {
  const { team, content } = input
  const leaderSlotId = team.leaderSlotId

  if (input.explicitSlotId !== undefined) {
    const explicit = String(input.explicitSlotId)
    if (team.members[explicit] !== undefined) {
      return { slotId: explicit, reason: 'explicit' }
    }
    if (!explicit.includes('@')) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown team member: ${explicit}`, { explicitSlotId: explicit })
    }
    // An email-like value is not a slot id; treat it as no explicit target.
  }

  const mentions = findMentions(content, team)
  if (content.match(/(^|\s)@all(?=$|\s|@)/i) !== null) {
    if (input.senderSlotId !== leaderSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', '@all is only allowed from the Leader')
    }
    return { slotId: leaderSlotId, reason: 'mention' }
  }
  if (mentions.length > 1) {
    throw new AgentTeamError('INVALID_REQUEST', 'A message may address only one team member', { mentions })
  }
  if (mentions.length === 1) {
    const target = mentions[0]
    if (target !== undefined) {
      return { slotId: target, reason: 'mention' }
    }
  }
  return { slotId: leaderSlotId, reason: 'default' }
}

function findMentions(content: string, team: TurnRoutingTeam): string[] {
  const candidates = Object.values(team.members)
    .map(member => ({ id: member.id, name: member.displayName.trim() }))
    .filter(candidate => candidate.name.length > 0)
  // Longest first so "@Beta One" wins over a "@Beta" prefix.
  candidates.sort((left, right) => right.name.length - left.name.length || left.name.localeCompare(right.name))
  const found: string[] = []
  for (const match of content.matchAll(/(?:^|\s)@/g)) {
    const index = match.index
    if (index === undefined) continue
    const start = index + match[0].length
    const rest = content.slice(start)
    const hit = candidates.find(candidate => {
      const after = rest.slice(candidate.name.length)
      return rest.toLowerCase().startsWith(candidate.name.toLowerCase())
        && (after === '' || /^[\s@]/.test(after))
    })
    if (hit !== undefined && !found.includes(hit.id)) {
      found.push(hit.id)
    }
  }
  return found
}
