import { useEffect, useRef, useState } from 'react'
import {
  avatarPickerValueError,
  randomAvatarCandidates,
  type AvatarCandidate,
} from './avatar-picker.js'
import css from './AgentTeam.module.css'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Flat, embedded DiceBear grid for the Assistant create form. The grid owns
 * only transient selection and error state: the chosen inline data URL is
 * handed to the caller, which stores it in the create payload.
 */
export function AvatarGrid({
  value,
  disabled = false,
  onChange,
}: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}): JSX.Element {
  const [candidates, setCandidates] = useState<AvatarCandidate[]>(() => randomAvatarCandidates(23))
  const [selectedId, setSelectedId] = useState<string>()
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string>()
  const requestRef = useRef(0)

  useEffect(() => {
    if (value === '') setSelectedId(undefined)
  }, [value])

  useEffect(() => () => { requestRef.current += 1 }, [])

  function applyValue(next: string): void {
    const valueError = avatarPickerValueError(next)
    if (valueError !== undefined) {
      setError(valueError)
      return
    }
    setError(undefined)
    onChange(next)
  }

  async function chooseCandidate(candidate: AvatarCandidate): Promise<void> {
    if (disabled || picking) return
    const request = ++requestRef.current
    setPicking(true)
    setSelectedId(candidate.id)
    setError(undefined)
    try {
      const response = await fetch(candidate.url)
      if (request !== requestRef.current) return
      if (!response.ok) throw new Error(`头像服务返回 ${response.status}`)
      const svg = await response.text()
      if (request !== requestRef.current) return
      applyValue(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    } catch (cause) {
      if (request !== requestRef.current) return
      setSelectedId(undefined)
      setError(messageOf(cause))
    } finally {
      if (request === requestRef.current) setPicking(false)
    }
  }

  function randomize(): void {
    requestRef.current += 1
    setPicking(false)
    setSelectedId(undefined)
    setError(undefined)
    setCandidates(randomAvatarCandidates(23))
  }


  return (
    <div className={css.avatarGrid}>
      {error !== undefined && <span className={css.avatarPickerError} role="alert">{error}</span>}
      <div className={css.avatarGridSheet}>
        <div className={css.avatarStyleGrid} role="group" aria-label="随机生成的 DiceBear 头像">
          {candidates.map(candidate => (
            <button
              key={candidate.id}
              type="button"
              className={css.avatarStyleThumb}
              disabled={disabled || picking}
              aria-pressed={selectedId === candidate.id}
              aria-label={candidate.label}
              title={candidate.label}
              onClick={() => { void chooseCandidate(candidate) }}
            >
              <img src={candidate.url} alt="" loading="lazy" />
            </button>
          ))}
          <button
            type="button"
            className={`${css.avatarStyleThumb} ${css.avatarRandomThumb}`}
            disabled={disabled || picking}
            aria-label="随机生成头像"
            title="随机生成头像"
            onClick={randomize}
          >
            <span aria-hidden="true">{picking ? '生成中' : '随机'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
