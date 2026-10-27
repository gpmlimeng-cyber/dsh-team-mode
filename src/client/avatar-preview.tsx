import { Mascot } from './mascot-view.js'
import { teamAvatarColor, teamAvatarStack } from './team-avatar.js'
import { MemberAvatar } from './member-avatar.js'
import { teamAvatarSeatStyle } from './sidebar.js'
import css from './AgentTeam.module.css'

/**
 * TEMPORARY preview switch. Flip to false (or delete this file and its one
 * call site) once the avatar sizes have been eyeballed: this renders synthetic
 * rows so every member count can be compared without creating real teams.
 */
export const AVATAR_PREVIEW_ENABLED = true

const PREVIEW_COUNTS = [1, 2, 3, 4, 5, 6] as const

/** Fake members with distinct colours, so each cluster reads immediately. */
function previewMembers(count: number): Record<string, {
  id: string
  displayName: string
  role: string
  assistantSnapshot?: { name?: string; avatar?: string | undefined }
}> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const id = `preview-${count}-${index + 2}`
    return [id, {
      id,
      displayName: `成员 ${index + 2}`,
      role: index === 0 ? 'leader' : 'member',
      assistantSnapshot: { name: `成员 ${index + 2}` },
    }]
  }))
}

export function AvatarPreviewRows(): JSX.Element {
  return (
    <div className={css.avatarPreview} data-dsh-avatar-preview>
      <div className={css.avatarPreviewTitle}>头像预览（临时）</div>
      {PREVIEW_COUNTS.map(count => {
        const stack = teamAvatarStack(previewMembers(count))
        return (
          <div key={count} className={css.sidebarTeamRow} data-preview-count={count}>
            <span
              className={css.sidebarTeamAvatarStack}
              data-count={stack.seats.length}
              aria-hidden="true"
            >
              {stack.seats.map(seat => (
                <span key={seat.key} className={css.sidebarTeamAvatarSeat} style={teamAvatarSeatStyle(seat)}>
                  {seat.kind === 'face' && seat.face !== undefined
                    ? (
                      <Mascot
                        seed={seat.face.mascotSeed}
                        options={{ bodyColor: seat.face.mascotColor }}
                        size={seat.size}
                        avatarShape="rounded"
                        animated={false}
                      />
                    )
                    : seat.kind === 'you'
                      ? <span className={css.sidebarTeamAvatarYou} data-kind="you" />
                      : seat.kind === 'empty'
                        ? <MemberAvatar name="空" size={seat.size} />
                        : (
                          <span className={css.sidebarTeamAvatarChip} data-kind={seat.kind}>
                            {seat.label ?? ''}
                          </span>
                        )}
                </span>
              ))}
            </span>
            <span className={css.sidebarTeamCopy}>
              <span className={css.sidebarTeamName}>{count} 人</span>
              <span className={css.sidebarTeamSubtitle}>
                {stack.seats.length} 个座位 · 主色 {teamAvatarColor(`preview-${count}`)}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
