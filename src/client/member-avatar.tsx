import css from './AgentTeam.module.css'

/** DSH sidebar user-avatar treatment: a 50%-radius tile with a very light
 * platform fill, image cover, and an initial fallback. */
export function MemberAvatar({
  name,
  avatar,
  size,
  className,
}: {
  name: string
  avatar?: string | undefined
  size: number
  className?: string
}): JSX.Element {
  return (
    <span
      className={`${css.memberAvatar}${className === undefined ? '' : ` ${className}`}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden="true"
    >
      {avatar !== undefined && avatar !== ''
        ? <img src={avatar} alt="" />
        : name.trim().slice(0, 1).toLocaleUpperCase() || '?'}
    </span>
  )
}
