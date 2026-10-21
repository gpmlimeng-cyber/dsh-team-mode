import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import {
  assistantAvatarDataUrlError,
  assistantAvatarFileError,
  assistantInstanceName,
} from './assistant-instances.js'
import { MemberAvatar } from './member-avatar.js'
import { AnimatedModal, Field } from './shared.js'
import css from './AgentTeam.module.css'
import type { AssistantInstance } from '../domain/types.js'

const STATUS_LABELS: Record<AssistantInstance['status'], string> = {
  idle: '空闲',
  starting: '启动中',
  active: '活跃',
  error: '出错',
  archived: '已归档',
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function formatCreatedAt(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * Edit one Assistant instance's local identity. The template snapshot keeps the
 * model and Workspace fixed after creation, so this dialog deliberately exposes
 * them as read-only. Archive is a two-step inline action that hides the row and
 * lets the service stop its active background workers.
 */
export function AssistantSettingsDialog({
  open,
  assistant,
  onClose,
  onSaved,
}: {
  open: boolean
  assistant: AssistantInstance
  onClose: () => void
  onSaved: () => Promise<void> | void
}): JSX.Element {
  const [name, setName] = useState(assistantInstanceName(assistant))
  const [avatar, setAvatar] = useState(assistant.assistantSnapshot.avatar ?? '')
  const [avatarChanged, setAvatarChanged] = useState(false)
  const [templateName, setTemplateName] = useState<string>()
  const [workspaceTitle, setWorkspaceTitle] = useState<string>()
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState<string>()

  const busy = saving || archiving

  useEffect(() => {
    if (!open) return
    let live = true
    setName(assistantInstanceName(assistant))
    setAvatar(assistant.assistantSnapshot.avatar ?? '')
    setAvatarChanged(false)
    setTemplateName(undefined)
    setWorkspaceTitle(undefined)
    setConfirmArchive(false)
    setSaving(false)
    setArchiving(false)
    setError(undefined)
    callAgentTeam('assistant.list')
      .then(assistantPage => {
        if (live) setTemplateName(assistantPage.items.find(item => item.id === assistant.templateId)?.name)
      })
      .catch(() => {
        // The summary degrades to the stored template id; editing still works.
      })
    callAgentTeam('catalog.get')
      .then(catalog => {
        if (live) setWorkspaceTitle(catalog.workspaces.find(item => item.id === assistant.workspaceId)?.title)
      })
      .catch(() => {
        // The summary degrades to the stored Workspace path.
      })
    return () => { live = false }
  }, [open, assistant.id])

  const close = (): void => {
    if (busy) return
    onClose()
  }

  function chooseAvatar(file: File): void {
    const fileError = assistantAvatarFileError(file)
    if (fileError !== undefined) {
      setError(fileError)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') return
      const dataUrlError = assistantAvatarDataUrlError(reader.result)
      if (dataUrlError !== undefined) {
        setError(dataUrlError)
        return
      }
      setAvatar(reader.result)
      setAvatarChanged(true)
      setError(undefined)
    }
    reader.onerror = () => { setError('读取头像失败，请重试') }
    reader.readAsDataURL(file)
  }

  function clearAvatar(): void {
    setAvatar('')
    setAvatarChanged(true)
    setError(undefined)
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    const displayName = name.trim()
    if (displayName === '') {
      setError('显示名称不能为空')
      return
    }
    const avatarError = assistantAvatarDataUrlError(avatar)
    if (avatarError !== undefined) {
      setError(avatarError)
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await callAgentTeam('assistant.instance.update', {
        id: assistant.id,
        value: {
          name: displayName,
          ...(avatarChanged ? { avatar } : {}),
        },
      })
      onClose()
      await onSaved()
    } catch (cause) {
      setError(`保存失败：${messageOf(cause)}`)
    } finally {
      setSaving(false)
    }
  }

  async function archive(): Promise<void> {
    if (busy) return
    if (!confirmArchive) {
      setConfirmArchive(true)
      setError(undefined)
      return
    }
    setArchiving(true)
    setError(undefined)
    try {
      await callAgentTeam('assistant.instance.archive', { id: assistant.id })
      onClose()
      await onSaved()
    } catch (cause) {
      setError(`归档失败：${messageOf(cause)}`)
    } finally {
      setArchiving(false)
    }
  }

  const displayName = name.trim() === '' ? '助手' : name.trim()
  const templateLabel = templateName === undefined
    ? assistant.templateId
    : `${templateName}（${assistant.templateId}）`
  const workspaceLabel = workspaceTitle === undefined
    ? assistant.workspacePath
    : `${workspaceTitle} — ${assistant.workspacePath}`

  return (
    <AnimatedModal
      open={open}
      onClose={close}
      title="助手设置"
      description="修改显示名称与头像；Workspace 与模型在创建后保持只读。"
      closeLabel="关闭"
      className={css.assistantSettingsDialog ?? ''}
    >
      <form className={css.assistantSettingsForm} onSubmit={(event) => { void save(event) }}>
        {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
        <div className={css.assistantSettingsAvatarRow}>
          <MemberAvatar name={displayName} avatar={avatar} size={52} />
          <div className={css.assistantSettingsAvatarCopy}>
            <span className={css.assistantSettingsAvatarTitle}>头像</span>
            <div className={css.assistantSettingsAvatarActions}>
              <label className={css.avatarUpload}>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className={css.avatarFileInput}
                  disabled={busy}
                  onChange={event => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file !== undefined) chooseAvatar(file)
                  }}
                />
                选择图片
              </label>
              {avatar !== '' && (
                <Button variant="outline" type="button" disabled={busy} onClick={clearAvatar}>
                  清除头像
                </Button>
              )}
            </div>
            <span className={css.assistantSettingsAvatarHint}>支持 PNG、JPEG、WebP，最大 256KB。</span>
          </div>
        </div>
        <Field label="显示名称">
          <input
            className={css.input}
            value={name}
            disabled={busy}
            autoFocus
            placeholder="助手名称"
            onChange={event => { setName(event.target.value) }}
          />
        </Field>
        <div className={css.assistantSettingsSummary} aria-label="助手信息">
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>助手模板</span>
            <span className={css.assistantSettingsSummaryValue} title={assistant.templateId}>{templateLabel}</span>
          </div>
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>模型</span>
            <span className={css.assistantSettingsSummaryValue}>{assistant.assistantSnapshot.model}</span>
          </div>
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>Workspace</span>
            <span className={css.assistantSettingsSummaryValue} title={assistant.workspacePath}>{workspaceLabel}</span>
          </div>
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>状态</span>
            <span
              className={css.assistantSettingsSummaryValue}
              data-dsh-assistant-settings-status={assistant.status}
            >
              {STATUS_LABELS[assistant.status]}
            </span>
          </div>
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>创建时间</span>
            <span className={css.assistantSettingsSummaryValue}>{formatCreatedAt(assistant.createdAt)}</span>
          </div>
        </div>
        <div className={css.assistantCreateActions}>
          <Button variant="outline" type="button" disabled={busy} onClick={close}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
      <div className={css.assistantSettingsArchive}>
        <div className={css.assistantSettingsArchiveCopy}>
          <span className={css.assistantSettingsArchiveTitle}>归档助手</span>
          <span className={css.assistantSettingsArchiveHint}>
            归档后该助手将从「单聊」列表移除，并停止正在运行的后台任务；主会话记录不会被删除。
          </span>
          {confirmArchive && (
            <span className={css.assistantSettingsArchiveWarning} role="alert">
              再次点击「确认归档」完成归档。
            </span>
          )}
        </div>
        <button
          type="button"
          className={`${css.dangerButton} ${css.confirmDangerButton} ${confirmArchive ? css.assistantSettingsArchiveConfirm : ''}`}
          disabled={busy}
          onClick={() => { void archive() }}
        >
          {archiving ? '归档中…' : confirmArchive ? '确认归档' : '归档助手'}
        </button>
      </div>
    </AnimatedModal>
  )
}
