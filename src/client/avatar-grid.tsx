import { useEffect, useRef, useState } from 'react'
import {
  AVATAR_CANDIDATES,
  avatarPickerUploadError,
  avatarPickerValueError,
  pickRandomAvatarCandidate,
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

  function readAvatar(file: File): void {
    const fileError = avatarPickerUploadError(file)
    if (fileError !== undefined) {
      setError(fileError)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') return
      setSelectedId(undefined)
      applyValue(reader.result)
    }
    reader.onerror = () => { setError('读取头像失败，请重试') }
    reader.readAsDataURL(file)
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
    const candidate = pickRandomAvatarCandidate(AVATAR_CANDIDATES)
    if (candidate !== undefined) void chooseCandidate(candidate)
  }

  function clear(): void {
    requestRef.current += 1
    setPicking(false)
    setSelectedId(undefined)
    setError(undefined)
    onChange('')
  }

  return (
    <div className={css.avatarGrid}>
      <div className={css.avatarGridToolbar}>
        <label className={css.avatarUpload}>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className={css.avatarFileInput}
            disabled={disabled || picking}
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) readAvatar(file)
            }}
          />
          本地上传
        </label>
        <button
          type="button"
          className={css.avatarGenerate}
          disabled={disabled || picking}
          onClick={randomize}
        >
          {picking ? '生成中…' : '随机一个'}
        </button>
        {value !== '' && (
          <button
            type="button"
            className={css.assistantRemoveAvatar}
            disabled={disabled}
            onClick={clear}
          >
            移除
          </button>
        )}
      </div>
      {error !== undefined && <span className={css.avatarPickerError} role="alert">{error}</span>}
      <div className={css.avatarGridScroll}>
        <div className={css.avatarStyleGrid} role="group" aria-label="内置 DiceBear 头像">
          {AVATAR_CANDIDATES.map(candidate => (
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
        </div>
      </div>
    </div>
  )
}
