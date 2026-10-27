import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AgentTeam.module.css'
import { assistantAvatarDataUrlError, assistantAvatarFileError } from './assistant-instances.js'
import { mascotPickerOptions, mascotPickerPick, mascotPickerSelected } from './mascot-picker.js'
import type { MascotPickerKind, MascotPickerOption } from './mascot-picker.js'
import { mascotOptionsFor } from './mascot.js'
import type { MascotOptions } from './mascot.js'
import type { AssistantInstance } from '../domain/types.js'

/** The panel's two tabs: pick a mascot shape/colour, or upload a photo. */
export type AvatarEditorTab = 'bot' | 'upload'

/**
 * Everything the avatar editor edits, staged until 保存 writes it — the pane
 * keeps one of these instead of six loose mascot fields.
 */
export interface AvatarDraft {
  /** Mascot seed; the instance id until the assistant is reset. */
  seed: string
  /** Shape, colour, and the eyes/spacing a stored assistant already had. */
  mascot: MascotOptions
  /** Uploaded avatar data URL; `''` shows the mascot instead. */
  avatar: string
}

/**
 * The pane's starting draft for one assistant. The mascot comes from the same
 * helper the sidebar rows use, so the hero and the list always agree.
 */
export function avatarDraftFromInstance(instance: AssistantInstance): AvatarDraft {
  const { seed, options } = mascotOptionsFor(instance)
  return { seed, mascot: options, avatar: instance.assistantSnapshot.avatar ?? '' }
}

/** 恢复默认: the instance id draws the mascot again, with no overrides or photo. */
export function avatarDraftReset(instanceId: string): AvatarDraft {
  return { seed: instanceId, mascot: {}, avatar: '' }
}

/** Picking a shape, expression or colour is a mascot choice, so the photo gives way. */
export function avatarDraftPick(
  draft: AvatarDraft,
  kind: MascotPickerKind,
  option: MascotPickerOption,
): AvatarDraft {
  return { ...draft, mascot: { ...draft.mascot, ...mascotPickerPick(kind, option) }, avatar: '' }
}

/** An upload keeps the mascot configuration; the photo only outranks it. */
export function avatarDraftUpload(draft: AvatarDraft, avatar: string): AvatarDraft {
  return { ...draft, avatar }
}

/** 移除照片 drops only the upload; the staged shape/expression/colour stay. */
export function avatarDraftRemovePhoto(draft: AvatarDraft): AvatarDraft {
  return { ...draft, avatar: '' }
}

/**
 * Whether a shape/expression cell may look chosen. A photo is what the avatar
 * shows, so neither row may claim to be in effect — the reference editor
 * suppresses the shape ring for the same reason. The colour row does not go
 * through here: it keeps its swatch marked, still matching the reference.
 */
export function avatarDraftMarksMascot(
  draft: AvatarDraft,
  kind: 'body' | 'eyes',
  option: MascotPickerOption,
): boolean {
  return draft.avatar === '' && mascotPickerSelected(kind, option, draft.mascot)
}

/** The tab the panel starts on: a photo means the user came here to replace it. */
export function avatarEditorInitialTab(avatar: string): AvatarEditorTab {
  return avatar === '' ? 'bot' : 'upload'
}

export const AVATAR_EDITOR_TAB_OPTIONS: readonly [
  { value: 'bot', label: string },
  { value: 'upload', label: string },
] = [
  { value: 'bot', label: 'Bot' },
  { value: 'upload', label: '上传' },
]

export interface AvatarUploadResult {
  avatar?: string
  error?: string
}

interface AvatarImageFile {
  type: string
  size: number
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('unreadable image'))
    }
    reader.onerror = () => { reject(reader.error ?? new Error('unreadable image')) }
    reader.readAsDataURL(file)
  })
}

/**
 * Validate one picked image and read it. A failure returns the message and no
 * avatar, so the caller can keep showing what it already had.
 */
export async function readAvatarFile(
  file: AvatarImageFile,
  read: (file: AvatarImageFile) => Promise<string> = candidate => readFileAsDataUrl(candidate as unknown as Blob),
): Promise<AvatarUploadResult> {
  const fileError = assistantAvatarFileError(file)
  if (fileError !== undefined) return { error: fileError }
  let dataUrl: string
  try {
    dataUrl = await read(file)
  } catch {
    return { error: '读取头像失败，请重试' }
  }
  const dataUrlError = assistantAvatarDataUrlError(dataUrl)
  if (dataUrlError !== undefined) return { error: dataUrlError }
  return { avatar: dataUrl }
}

interface ClipboardImageData {
  files?: ArrayLike<File> | undefined
  items?: ArrayLike<{ kind?: string | undefined; type?: string | undefined; getAsFile?: () => File | null }> | undefined
}

/**
 * The first image in a paste. Safari fills `items` and leaves `files` empty,
 * so the item list is the fallback rather than an omission.
 */
export function avatarImageFromClipboard(data: ClipboardImageData | null): File | undefined {
  if (data === null) return undefined
  const pasted = Array.from(data.files ?? []).find(candidate => candidate.type.startsWith('image/'))
  if (pasted !== undefined) return pasted
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || item.type?.startsWith('image/') !== true) continue
    const file = item.getAsFile?.() ?? null
    if (file !== null) return file
  }
  return undefined
}

/** The editor panel's element id; the hero's trigger points at it. */
export const AVATAR_EDITOR_ID = 'dsh-team-mode-avatar-editor'
const TAB_ID = 'dsh-team-mode-avatar-source'
const COLUMNS = 6

/**
 * The floating avatar editor anchored under the hero: a Bot tab with every
 * mascot shape and the colour row, an Upload tab with drag, paste and a file
 * input, and 恢复默认 on the right. Not a modal — it closes on outside click,
 * Esc, or the hero trigger again, and a close never discards the draft.
 */
export function AssistantAvatarEditor({
  draft,
  disabled = false,
  onDraftChange,
  onReset,
  onClose,
}: {
  draft: AvatarDraft
  disabled?: boolean
  /** The next draft from the current one, so a slow upload never reverts a pick. */
  onDraftChange: (update: (draft: AvatarDraft) => AvatarDraft) => void
  onReset: () => void
  onClose: () => void
}): JSX.Element {
  const [tab, setTab] = useState<AvatarEditorTab>(() => avatarEditorInitialTab(draft.avatar))
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string>()
  const panelRef = useRef<HTMLDivElement>(null)

  const upload = useCallback((file: File | undefined): void => {
    if (file === undefined) return
    void readAvatarFile(file).then(result => {
      const { avatar, error: message } = result
      if (message !== undefined) {
        setError(message)
        return
      }
      if (avatar !== undefined) {
        setError(undefined)
        onDraftChange(current => avatarDraftUpload(current, avatar))
      }
    })
  }, [onDraftChange])

  useEffect(() => {
    const onPointerDown = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      // The trigger toggles the panel itself; closing here would fight its click.
      if (panelRef.current?.contains(target) === true) return
      if (target.closest('[data-dsh-avatar-trigger]') !== null) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  useEffect(() => {
    if (tab !== 'upload') return undefined
    const onPaste = (event: ClipboardEvent): void => {
      const file = avatarImageFromClipboard(event.clipboardData)
      if (file === undefined) return
      event.preventDefault()
      upload(file)
    }
    document.addEventListener('paste', onPaste)
    return () => { document.removeEventListener('paste', onPaste) }
  }, [tab, upload])

  // Shape and expression share one row layout; both read the same option data
  // the old picker produced, only the grid is new.
  const mascotSections = useMemo(() => {
    const build = (kind: 'body' | 'eyes', title: string): {
      kind: 'body' | 'eyes'
      title: string
      rows: MascotPickerOption[][]
    } => {
      const options = mascotPickerOptions(kind, draft.seed, draft.mascot)
      const rows: MascotPickerOption[][] = []
      for (let index = 0; index < options.length; index += COLUMNS) {
        rows.push(options.slice(index, index + COLUMNS))
      }
      return { kind, title, rows }
    }
    return [build('body', '形状'), build('eyes', '表情')]
  }, [draft.seed, JSON.stringify(draft.mascot)])
  const colors = mascotPickerOptions('color')
  // A photo is what the avatar shows, so no mascot row may look active; the
  // reference implementation suppresses the shape ring for exactly this reason.
  const hasPhoto = draft.avatar !== ''

  return (
    <div className={css.avatarEditor} ref={panelRef} role="dialog" aria-label="编辑头像" id={AVATAR_EDITOR_ID} data-dsh-avatar-editor>
      <div className={css.avatarEditorTop}>
        <SegmentedControl
          id={TAB_ID}
          value={tab}
          options={AVATAR_EDITOR_TAB_OPTIONS}
          onChange={(next) => { setTab(next); setError(undefined) }}
          label="头像来源"
          disabled={disabled}
          className={css.avatarEditorTabs}
        />
        <button type="button" className={css.avatarEditorReset} disabled={disabled} onClick={onReset}>
          恢复默认
        </button>
      </div>
      {tab === 'bot' ? (
        <div
          id={`${TAB_ID}-bot-panel`}
          role="tabpanel"
          aria-labelledby={`${TAB_ID}-bot`}
          className={css.avatarEditorBody}
        >
          {hasPhoto && (
            <p className={css.avatarMascotHint} data-dsh-avatar-photo-hint>
              当前显示上传的照片；选形状或表情会换回吉祥物。
            </p>
          )}
          {mascotSections.map(section => (
            <div
              key={section.kind}
              className={css.avatarMascotSection}
              data-dsh-avatar-row={section.kind}
            >
              <span className={css.avatarMascotTitle}>{section.title}</span>
              <div className={css.avatarMascotGrid} role="group" aria-label={section.title}>
                {section.rows.map((row, rowIndex) => (
                  <div key={rowIndex} className={css.avatarMascotRow}>
                    {row.map(option => (
                      <button
                        key={option.value}
                        type="button"
                        className={css.avatarMascotOption}
                        aria-label={option.label}
                        title={option.label}
                        aria-pressed={avatarDraftMarksMascot(draft, section.kind, option)}
                        disabled={disabled}
                        onClick={() => { onDraftChange(current => avatarDraftPick(current, section.kind, option)) }}
                      >
                        <img src={option.preview} alt="" draggable={false} />
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className={css.avatarMascotSection} data-dsh-avatar-row="color">
            <span className={css.avatarMascotTitle}>颜色</span>
            <div className={css.avatarColorRow} role="group" aria-label="颜色">
              {colors.map(option => (
                <button
                  key={`${option.value}-${option.fill ?? ''}`}
                  type="button"
                  className={css.avatarColor}
                  aria-label={option.label}
                  title={option.label}
                  aria-pressed={mascotPickerSelected('color', option, draft.mascot)}
                  disabled={disabled}
                  onClick={() => { onDraftChange(current => avatarDraftPick(current, 'color', option)) }}
                >
                  <img src={option.preview} alt="" draggable={false} />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div
          id={`${TAB_ID}-upload-panel`}
          role="tabpanel"
          aria-labelledby={`${TAB_ID}-upload`}
          className={css.avatarEditorBody}
        >
          <div
            className={css.avatarDropzone}
            data-dsh-avatar-dropzone
            {...(over ? { 'data-over': '' } : {})}
            onDragOver={(event) => { event.preventDefault(); setOver(true) }}
            onDragLeave={() => { setOver(false) }}
            onDrop={(event) => {
              event.preventDefault()
              setOver(false)
              upload(event.dataTransfer.files?.[0])
            }}
          >
            {draft.avatar !== '' && <img className={css.avatarDropzonePreview} src={draft.avatar} alt="" />}
            <span>拖入或粘贴一张图片</span>
            <span className={css.avatarDropzoneHint}>PNG、JPEG、WebP，最大 256KB</span>
            <label className={css.avatarUpload}>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className={css.avatarFileInput}
                disabled={disabled}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  upload(file)
                }}
              />
              选择文件
            </label>
          </div>
          {hasPhoto && (
            <button
              type="button"
              className={css.avatarEditorRemove}
              disabled={disabled}
              data-dsh-avatar-remove-photo
              onClick={() => { onDraftChange(current => avatarDraftRemovePhoto(current)) }}
            >
              移除照片
            </button>
          )}
          {error !== undefined && <div className={css.avatarEditorError} role="alert">{error}</div>}
        </div>
      )}
    </div>
  )
}
