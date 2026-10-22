import { useEffect, useRef, useState } from 'react'
import {
  AVATAR_CANDIDATES,
  pickRandomAvatarCandidate,
  type AvatarCandidate,
  avatarPickerUploadError,
  avatarPickerValueError,
} from './avatar-picker.js'
import { AnimatedModal } from './shared.js'
import css from './AgentTeam.module.css'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Reusable avatar picker: a flat grid of built-in DiceBear avatars, plus local
 * upload, random selection, preview, and an explicit apply action. The dialog
 * owns only a draft; the caller decides when (and where) the value is stored.
 */
export function AvatarPickerDialog({
  open,
  value,
  onApply,
  onClose,
  title = '选择头像',
  description = '从内置 DiceBear 头像中挑选，或上传本地图片，确认后应用。',
}: {
  open: boolean
  value?: string
  onApply: (value: string) => void
  onClose: () => void
  title?: string
  description?: string
}): JSX.Element {
  const [draftAvatar, setDraftAvatar] = useState(value ?? '')
  const [selectedId, setSelectedId] = useState<string>()
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string>()
  const scrollRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    // Opening starts from the caller's current value; closing invalidates any
    // in-flight DiceBear request so it cannot overwrite a later draft.
    requestRef.current += 1
    if (!open) return
    setDraftAvatar(value ?? '')
    setSelectedId(undefined)
    setPicking(false)
    setError(undefined)
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0 })
    })
    return () => { cancelAnimationFrame(frame) }
  }, [open, value])

  function readAvatar(file: File): void {
    const fileError = avatarPickerUploadError(file)
    if (fileError !== undefined) {
      setError(fileError)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') return
      const valueError = avatarPickerValueError(reader.result)
      if (valueError !== undefined) {
        setError(valueError)
        return
      }
      setDraftAvatar(reader.result)
      setSelectedId(undefined)
      setError(undefined)
    }
    reader.onerror = () => { setError('读取头像失败，请重试') }
    reader.readAsDataURL(file)
  }

  async function chooseCandidate(candidate: AvatarCandidate): Promise<void> {
    if (picking) return
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
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
      const valueError = avatarPickerValueError(dataUrl)
      if (valueError !== undefined) throw new Error(valueError)
      setDraftAvatar(dataUrl)
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

  function apply(): void {
    const valueError = avatarPickerValueError(draftAvatar)
    if (valueError !== undefined) {
      setError(valueError)
      return
    }
    if (draftAvatar === '') return
    onApply(draftAvatar)
    onClose()
  }

  return (
    <AnimatedModal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      closeLabel="关闭"
      className={css.avatarPickerDialog ?? ''}
      contentClassName={css.avatarPickerDialogContent ?? ''}
    >
      <div className={css.avatarPickerHeader}>
        <div className={css.avatarPickerPreview}>
          <span className={css.avatarPickerPreviewBox}>
            {draftAvatar !== ''
              ? <img src={draftAvatar} alt="选中头像预览" />
              : <span className={css.avatarPickerPreviewEmpty}>未选择</span>}
          </span>
          <span className={css.avatarPickerPreviewText}>
            <strong>预览</strong>
            <small>{picking ? '生成中…' : '点击内置头像、随机一个，或上传本地图片'}</small>
          </span>
        </div>
        <div className={css.avatarPickerActions}>
          <label className={css.avatarUpload}>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className={css.avatarFileInput}
              disabled={picking}
              onChange={event => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file !== undefined) readAvatar(file)
              }}
            />
            本地上传
          </label>
          <button type="button" className={css.avatarGenerate} disabled={picking} onClick={randomize}>
            {picking ? '生成中…' : '随机一个'}
          </button>
        </div>
      </div>
      {error !== undefined && <span className={css.avatarPickerError}>{error}</span>}
      <div ref={scrollRef} className={css.avatarPickerScroll}>
        <div className={css.avatarStyleGrid} role="group" aria-label="内置 DiceBear 头像">
          {AVATAR_CANDIDATES.map(candidate => (
            <button
              key={candidate.id}
              type="button"
              className={css.avatarStyleThumb}
              disabled={picking}
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
      <div className={css.avatarPickerFooter}>
        <span className={css.hint}>PNG/JPEG/WebP，≤256KB；内置头像来自 DiceBear。</span>
        <div className={css.avatarPickerActions}>
          <button type="button" className={css.avatarGenerate} onClick={onClose}>取消</button>
          <button
            type="button"
            className={css.avatarRandom}
            disabled={picking || draftAvatar === ''}
            onClick={apply}
          >
            使用这个头像
          </button>
        </div>
      </div>
    </AnimatedModal>
  )
}
