import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import {
  assistantAvatarDataUrlError,
  assistantAvatarFileError,
  assistantInstanceName,
} from './assistant-instances.js'
import {
  assistantMemoryView,
  memoryJournalActionLabel,
  memorySourceLabel,
  memoryStatusLabel,
  memoryVisibilityLabel,
  PERMISSION_LABELS,
} from './labels.js'
import { MemberAvatar } from './member-avatar.js'
import { Mascot, usePrefersReducedMotion } from './mascot-view.js'
import { MascotPicker } from './mascot-picker.js'
import {
  nextMascotSeed,
  randomMascotDraft,
  type MascotBodyFill,
  type MascotEyes,
  type MascotMotion,
  type MascotShape,
  type MascotSpacing,
} from './mascot.js'
import { defaultReasoningLabel, useModelCapabilities } from './model-reasoning.js'
import { AnimatedModal, Field } from './shared.js'
import css from './AgentTeam.module.css'
import { isCoordinatorInstance } from '../domain/types.js'
import type {
  AssistantInstance,
  AssistantMemory,
  MemoryEntry,
  UpdateAssistantInstanceInput,
} from '../domain/types.js'
import type { AssistantMemoryEntryWriteView, CatalogView } from '../transport/contracts.js'

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
 * Edit one Assistant instance's local identity and engine settings. The model,
 * reasoning effort, and permission preset are validated against the live
 * catalog and saved on the instance snapshot; the referenced template is never
 * changed. Workspace remains fixed after creation.
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
  const [catalog, setCatalog] = useState<CatalogView>()
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string>()
  const [provider, setProvider] = useState(assistant.assistantSnapshot.provider)
  const [model, setModel] = useState(assistant.assistantSnapshot.model)
  const [reasoningEffort, setReasoningEffort] = useState(assistant.assistantSnapshot.reasoningEffort ?? '')
  const [permissionPresetId, setPermissionPresetId] = useState(assistant.assistantSnapshot.permissionPresetId)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState<string>()
  const [mascotSeed, setMascotSeed] = useState(assistant.mascot?.seed ?? assistant.id)
  const [mascotShape, setMascotShape] = useState(assistant.mascot?.shape ?? '')
  const [mascotEyes, setMascotEyes] = useState(assistant.mascot?.eyes ?? '')
  const [mascotSpacing, setMascotSpacing] = useState(assistant.mascot?.spacing ?? '')
  const [mascotColor, setMascotColor] = useState(assistant.mascot?.color ?? '')
  const [mascotFill, setMascotFill] = useState<MascotBodyFill>(assistant.mascot?.fill ?? 'solid')
  const [mascotAnimated, setMascotAnimated] = useState(true)
  const [mascotMotion, setMascotMotion] = useState<MascotMotion>('idle')
  const [mascotMotionKey, setMascotMotionKey] = useState(0)
  const reducedMotion = usePrefersReducedMotion()
  // Closing waits for the save-bounce's animationend instead of a timer.
  const closeAfterMascot = useRef(false)

  const busy = saving || archiving
  const modelCapabilities = useModelCapabilities(provider, model)

  useEffect(() => {
    if (!open) return
    let live = true
    setName(assistantInstanceName(assistant))
    setAvatar(assistant.assistantSnapshot.avatar ?? '')
    setAvatarChanged(false)
    setTemplateName(undefined)
    setWorkspaceTitle(undefined)
    setCatalog(undefined)
    setCatalogLoading(true)
    setCatalogError(undefined)
    setProvider(assistant.assistantSnapshot.provider)
    setModel(assistant.assistantSnapshot.model)
    setReasoningEffort(assistant.assistantSnapshot.reasoningEffort ?? '')
    setPermissionPresetId(assistant.assistantSnapshot.permissionPresetId)
    setConfirmArchive(false)
    setSaving(false)
    setArchiving(false)
    setError(undefined)
    setMascotSeed(assistant.mascot?.seed ?? assistant.id)
    setMascotShape(assistant.mascot?.shape ?? '')
    setMascotEyes(assistant.mascot?.eyes ?? '')
    setMascotSpacing(assistant.mascot?.spacing ?? '')
    setMascotColor(assistant.mascot?.color ?? '')
    setMascotFill(assistant.mascot?.fill ?? 'solid')
    setMascotAnimated(true)
    setMascotMotion('idle')
    setMascotMotionKey(0)
    closeAfterMascot.current = false
    callAgentTeam('catalog.get')
      .then(value => {
        if (!live) return
        setCatalog(value)
        setWorkspaceTitle(value.workspaces.find(item => item.id === assistant.workspaceId)?.title)
      })
      .catch((cause: unknown) => {
        // Keep name/avatar editing available; model and permission controls stay
        // disabled until a catalog is available.
        if (live) setCatalogError(`读取模型/权限目录失败：${messageOf(cause)}`)
      })
      .finally(() => {
        if (live) setCatalogLoading(false)
      })
    if (assistant.templateId !== undefined) {
      callAgentTeam('assistant.list')
        .then(assistantPage => {
          if (live) setTemplateName(assistantPage.items.find(item => item.id === assistant.templateId)?.name)
        })
        .catch(() => {
          // The summary degrades to the stored template id; editing still works.
        })
    }
    return () => { live = false }
  }, [open, assistant.id])

  useEffect(() => {
    // A newly selected model may advertise a different set of reasoning efforts
    // (or none at all). Drop an unsupported effort so the select always shows a
    // value the model accepts; saving then clears it on the snapshot.
    if (modelCapabilities.loading || modelCapabilities.value === undefined) return
    const efforts = modelCapabilities.value.reasoning?.efforts ?? []
    setReasoningEffort(current => (
      current !== '' && !efforts.some(effort => effort.id === current) ? '' : current
    ))
  }, [modelCapabilities.loading, modelCapabilities.value])

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
    if (provider.trim() === '' || model.trim() === '') {
      setError('请选择 Provider 和模型')
      return
    }
    if (permissionPresetId.trim() === '') {
      setError('请选择权限预设')
      return
    }
    const avatarError = assistantAvatarDataUrlError(avatar)
    if (avatarError !== undefined) {
      setError(avatarError)
      return
    }
    const snapshot = assistant.assistantSnapshot
    const value: UpdateAssistantInstanceInput = { name: displayName }
    if (avatarChanged) value.avatar = avatar
    if (provider !== snapshot.provider || model !== snapshot.model) {
      // provider and model always travel together so the service can validate
      // the pair against the current model catalog.
      value.provider = provider
      value.model = model
    }
    const nextReasoningEffort = reasoningEffort.trim()
    if (nextReasoningEffort !== (snapshot.reasoningEffort ?? '')) {
      // An empty string clears the effort and falls back to the model default.
      value.reasoningEffort = nextReasoningEffort
    }
    if (permissionPresetId !== snapshot.permissionPresetId) {
      value.permissionPresetId = permissionPresetId
    }
    const nextMascot = {
      seed: mascotSeed.trim() === '' ? assistant.id : mascotSeed.trim(),
      ...(mascotShape === '' ? {} : { shape: mascotShape }),
      ...(mascotEyes === '' ? {} : { eyes: mascotEyes }),
      ...(mascotSpacing === '' ? {} : { spacing: mascotSpacing }),
      ...(mascotColor === '' ? {} : { color: mascotColor }),
      ...(mascotFill === 'radial' ? { fill: 'radial' as const } : {}),
    }
    if (JSON.stringify(nextMascot) !== JSON.stringify(assistant.mascot)) value.mascot = nextMascot
    setSaving(true)
    setError(undefined)
    try {
      await callAgentTeam('assistant.instance.update', {
        id: assistant.id,
        value,
      })
      if (reducedMotion) {
        onClose()
        await onSaved()
      } else {
        // Bounce the preview once, then close when the CSS animation reports it
        // finished — no timer decides task completion.
        closeAfterMascot.current = true
        setMascotMotion('success')
        setMascotMotionKey(key => key + 1)
      }
    } catch (cause) {
      setError(`保存失败：${messageOf(cause)}`)
      setMascotMotion('failure')
      setMascotMotionKey(key => key + 1)
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
  const templateLabel = assistant.templateId === undefined
    ? '无（直接创建）'
    : templateName === undefined
      ? assistant.templateId
      : `${templateName}（${assistant.templateId}）`
  const workspaceLabel = workspaceTitle === undefined
    ? assistant.workspacePath
    : `${workspaceTitle} — ${assistant.workspacePath}`
  const modelGroups = (catalog?.providers ?? []).map(providerEntry => ({
    provider: providerEntry,
    models: catalog?.models[providerEntry.id] ?? [],
  })).filter(group => group.models.length > 0)
  const modelSelection = JSON.stringify([provider, model])
  const modelSelectionInCatalog = modelGroups.some(group => (
    group.provider.id === provider && group.models.some(modelEntry => modelEntry.id === model)
  ))
  const permissionOptions = catalog?.permissionPresets ?? []
  const permissionInCatalog = permissionOptions.some(option => option.value === permissionPresetId)
  const reasoningEfforts = modelCapabilities.value?.reasoning?.efforts ?? []
  const mascotOptions = {
    ...(mascotShape === '' ? {} : { shapeVariant: mascotShape as MascotShape }),
    ...(mascotEyes === '' ? {} : { eyesVariant: mascotEyes as MascotEyes }),
    ...(mascotSpacing === '' ? {} : { spacingVariant: mascotSpacing as MascotSpacing }),
    ...(mascotColor === '' ? {} : { bodyColor: mascotColor }),
    bodyColorFill: mascotFill,
  }

  return (
    <AnimatedModal
      open={open}
      onClose={close}
      title="助手设置"
      description="修改显示名称、头像、模型、思考模式与权限；Workspace 在创建后保持只读。"
      closeLabel="关闭"
      className={css.assistantSettingsDialog ?? ''}
    >
      <form className={css.assistantSettingsForm} onSubmit={(event) => { void save(event) }}>
        {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
        {catalogError !== undefined && <div className={css.inlineError} role="alert">{catalogError}</div>}
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
        <div className={css.assistantMascotSection} data-dsh-assistant-mascot>
          <div className={css.assistantMascotPreview}>
            <Mascot
              seed={mascotSeed}
              options={mascotOptions}
              size={52}
              avatarShape="rounded"
              motion={mascotMotion}
              motionKey={mascotMotionKey}
              animated={mascotAnimated}
              onMotionEnd={() => {
                if (!closeAfterMascot.current) return
                closeAfterMascot.current = false
                onClose()
                void onSaved()
              }}
            />
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => {
                const next = randomMascotDraft()
                setMascotSeed(next.seed)
                setMascotShape(next.shape)
                setMascotEyes(next.eyes)
                setMascotColor(next.color)
              }}
            >
              换一只
            </Button>
          </div>
          <div className={css.assistantMascotFields}>
            <span className={css.assistantSettingsAvatarTitle}>吉祥物</span>
            <span className={css.assistantSettingsAvatarHint}>
              没有上传头像时显示；同一个种子永远是同一只。
            </span>
            <MascotPicker
              seed={mascotSeed}
              value={mascotOptions}
              disabled={busy}
              onChange={next => {
                setMascotShape(next.shapeVariant ?? '')
                setMascotEyes(next.eyesVariant ?? '')
                setMascotColor(next.bodyColor ?? '')
                setMascotFill(next.bodyColorFill ?? 'solid')
              }}
            />
            <label className={css.assistantMascotToggle}>
              <input
                type="checkbox"
                checked={mascotAnimated && !reducedMotion}
                disabled={busy || reducedMotion}
                onChange={event => { setMascotAnimated(event.target.checked) }}
              />
              {reducedMotion ? '动画（系统已要求减少动效）' : '动画'}
            </label>
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
        <Field label="模型">
          <select
            className={css.input}
            value={modelSelection}
            disabled={busy || catalog === undefined}
            onChange={event => {
              const [nextProvider, nextModel] = JSON.parse(event.target.value) as [string, string]
              setProvider(nextProvider)
              setModel(nextModel)
              setError(undefined)
            }}
          >
            {!modelSelectionInCatalog && (
              <option value={modelSelection}>{provider} / {model}（当前）</option>
            )}
            {modelGroups.map(group => (
              <optgroup key={group.provider.id} label={group.provider.name}>
                {group.models.map(modelEntry => (
                  <option
                    key={`${group.provider.id}/${modelEntry.id}`}
                    value={JSON.stringify([group.provider.id, modelEntry.id])}
                  >
                    {modelEntry.name === modelEntry.id ? modelEntry.id : `${modelEntry.name}（${modelEntry.id}）`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className={css.assistantSettingsAvatarHint}>
            {catalogLoading
              ? '正在读取模型列表…'
              : '按 Provider 分组；保存时同时写入 Provider 与模型。'}
          </span>
        </Field>
        {reasoningEfforts.length > 0 && (
          <Field label="思考模式">
            <select
              className={css.input}
              value={reasoningEffort}
              disabled={busy}
              onChange={event => { setReasoningEffort(event.target.value) }}
            >
              <option value="">{defaultReasoningLabel(modelCapabilities.value)}</option>
              {reasoningEfforts.map(effort => (
                <option key={effort.id} value={effort.id}>
                  {effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`}
                </option>
              ))}
            </select>
            <span className={css.assistantSettingsAvatarHint}>
              由当前模型决定可用档位；选择「模型默认」会清除已保存的档位。
            </span>
          </Field>
        )}
        {modelCapabilities.error !== undefined && (
          <div className={css.inlineError} role="alert">
            读取模型能力失败：{modelCapabilities.error}
          </div>
        )}
        <Field label="权限预设">
          <select
            className={css.input}
            value={permissionPresetId}
            disabled={busy || catalog === undefined}
            onChange={event => {
              setPermissionPresetId(event.target.value)
              setError(undefined)
            }}
          >
            {!permissionInCatalog && (
              <option value={permissionPresetId}>
                {PERMISSION_LABELS[permissionPresetId] ?? permissionPresetId}（当前）
              </option>
            )}
            {permissionOptions.map(option => (
              <option key={option.value} value={option.value}>
                {PERMISSION_LABELS[option.value] ?? option.name}
              </option>
            ))}
          </select>
          <span className={css.assistantSettingsAvatarHint}>
            权限只影响之后创建或恢复的会话；已打开的主会话保持原权限。
          </span>
        </Field>
        <div className={css.assistantSettingsSummary} aria-label="助手信息">
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>助手模板</span>
            <span className={css.assistantSettingsSummaryValue} title={assistant.templateId}>{templateLabel}</span>
          </div>
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>Workspace</span>
            <span className={css.assistantSettingsSummaryValue} title={assistant.workspacePath}>{workspaceLabel}</span>
          </div>
          {/* Always shown, so 否 states the role is off instead of the row missing. */}
          <div className={css.assistantSettingsSummaryRow}>
            <span className={css.assistantSettingsSummaryLabel}>总协调</span>
            <span
              className={css.assistantSettingsSummaryValue}
              data-dsh-assistant-settings-coordinator={String(isCoordinatorInstance(assistant))}
            >
              {isCoordinatorInstance(assistant) ? '是' : '否'}
            </span>
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
        <span className={css.assistantSettingsAvatarHint}>
          已打开的主会话会沿用旧模型，直到重新创建或恢复；新建的后台任务和未来恢复的主会话使用保存后的配置。
        </span>
        <div className={css.assistantCreateActions}>
          <Button variant="outline" type="button" disabled={busy} onClick={close}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
      <AssistantMemorySection assistantId={assistant.id} />
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

function memoryErrorCode(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null && 'code' in cause
    ? (cause as { code?: unknown }).code
    : undefined
}

function memoryError(cause: unknown): string {
  const code = memoryErrorCode(cause)
  if (code === 'MEMORY_REVISION_CONFLICT' || code === 'ASSISTANT_REVISION_CONFLICT') {
    return '记忆已被其他操作更新，已重新加载最新版本，请重试。'
  }
  if (code === 'MEMORY_UNDO_STALE') return '记忆已更新，已重新加载最新版本，请重试撤销。'
  if (code === 'MEMORY_UNDO_UNAVAILABLE') return '这条变更无法安全撤销（快照已脱敏或截断）。'
  return messageOf(cause)
}

function memoryTime(value: string): string {
  return value.slice(0, 16).replace('T', ' ')
}

/**
 * `assistant.memory.undo` returns the same `{ memory, entry }` envelope as an
 * entry write. The panel stores the memory document, not the envelope.
 */
export function memoryAfterUndo(result: AssistantMemoryEntryWriteView): AssistantMemory {
  return result.memory
}

interface MemoryDraft {
  id?: string
  title: string
  body: string
  visibility: MemoryEntry['visibility']
  key: string
}

/**
 * Structured assistant memory is keyed by the Assistant instance id, not by
 * the template. The panel sits outside the settings `<form>` so its controls
 * cannot submit the settings form; every write sends the document revision and
 * surfaces a conflict by reloading the latest value.
 */
function AssistantMemorySection({ assistantId }: { assistantId: string }): JSX.Element {
  const [memory, setMemory] = useState<AssistantMemory | null>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<MemoryDraft>()
  const [legacyEditing, setLegacyEditing] = useState(false)
  const [legacyDraft, setLegacyDraft] = useState('')
  const [confirmClear, setConfirmClear] = useState<string>()
  const [undoing, setUndoing] = useState<string>()
  const view = useMemo(() => assistantMemoryView(memory), [memory])
  const revision = memory?.revision ?? 0
  const journal = memory?.journal ?? []

  async function load(): Promise<void> {
    setLoading(true)
    setLoadError(undefined)
    try {
      const value = await callAgentTeam('assistant.memory.get', { assistantId })
      setMemory(value.memory)
      setLegacyDraft(value.memory?.content ?? '')
    } catch (cause) {
      setLoadError(`读取记忆失败：${messageOf(cause)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let live = true
    setLoading(true)
    setLoadError(undefined)
    callAgentTeam('assistant.memory.get', { assistantId })
      .then(value => {
        if (!live) return
        setMemory(value.memory)
        setLegacyDraft(value.memory?.content ?? '')
      })
      .catch((cause: unknown) => {
        if (live) setLoadError(`读取记忆失败：${messageOf(cause)}`)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => { live = false }
  }, [assistantId])

  async function writeEntry(): Promise<void> {
    if (draft === undefined || busy) return
    const title = draft.title.trim()
    if (title === '') {
      setError('条目标题不能为空。')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const result = await callAgentTeam('assistant.memory.entry.write', {
        assistantId,
        expectedRevision: revision,
        entry: {
          ...(draft.id === undefined ? {} : { id: draft.id }),
          title,
          body: draft.body,
          visibility: draft.visibility,
          ...(draft.key.trim() === '' ? {} : { key: draft.key.trim() }),
        },
      })
      setMemory(result.memory)
      setLegacyDraft(result.memory.content)
      setDraft(undefined)
      setConfirmClear(undefined)
    } catch (cause) {
      const message = memoryError(cause)
      setError(message)
      if (message.startsWith('记忆已被')) void load()
    } finally {
      setBusy(false)
    }
  }

  async function archiveEntry(entry: MemoryEntry): Promise<void> {
    if (busy) return
    if (confirmClear !== entry.id) {
      setError(undefined)
      setConfirmClear(entry.id)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const result = await callAgentTeam('assistant.memory.entry.write', {
        assistantId,
        expectedRevision: revision,
        entry: {
          id: entry.id,
          title: entry.title,
          body: entry.body,
          visibility: entry.visibility,
          status: 'archived',
        },
      })
      setMemory(result.memory)
      setLegacyDraft(result.memory.content)
      setConfirmClear(undefined)
    } catch (cause) {
      const message = memoryError(cause)
      setError(message)
      if (message.startsWith('记忆已被')) void load()
    } finally {
      setBusy(false)
    }
  }

  async function saveLegacy(content: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await callAgentTeam('assistant.memory.write', {
        assistantId,
        content,
        mode: 'replace',
        expectedRevision: revision,
      })
      setMemory(next)
      setLegacyDraft(next.content)
      setLegacyEditing(false)
      setConfirmClear(undefined)
    } catch (cause) {
      const message = memoryError(cause)
      setError(message)
      if (message.startsWith('记忆已被')) void load()
    } finally {
      setBusy(false)
    }
  }

  async function undo(journalId: string): Promise<void> {
    if (busy || undoing !== undefined) return
    setUndoing(journalId)
    setError(undefined)
    try {
      const result = await callAgentTeam('assistant.memory.undo', {
        assistantId,
        journalId,
        expectedRevision: revision,
      })
      const next = memoryAfterUndo(result)
      setMemory(next)
      setLegacyDraft(next.content)
      setConfirmClear(undefined)
    } catch (cause) {
      setError(memoryError(cause))
      if (memoryErrorCode(cause) === 'MEMORY_UNDO_STALE') void load()
    } finally {
      setUndoing(undefined)
    }
  }

  function entryCard(entry: MemoryEntry, actions?: JSX.Element): JSX.Element {
    return (
      <article key={entry.id} className={css.memoryEntryCard}>
        <div className={css.memoryEntryHeader}>
          <strong>{entry.title}</strong>
          <span className={css.memoryBadges}>
            <span className={`${css.memoryBadge} ${entry.visibility === 'private' ? css.memoryBadgePrivate : ''}`}>
              {memoryVisibilityLabel(entry.visibility)}
            </span>
            <span className={`${css.memoryBadge} ${entry.status === 'proposed' ? css.memoryBadgeProposed : ''}`}>
              {memoryStatusLabel(entry.status)}
            </span>
            <span className={css.memoryBadge}>v{entry.revision}</span>
          </span>
        </div>
        {entry.body !== '' && <p className={css.memoryEntryBody}>{entry.body}</p>}
        <div className={css.memoryEntryMeta}>
          <span>{memorySourceLabel(entry.source)}{entry.key === undefined ? '' : ` · ${entry.key}`}{` · ${memoryTime(entry.updatedAt)}`}</span>
          {actions}
        </div>
      </article>
    )
  }

  return (
    <section className={css.assistantMemorySection} aria-label="助手持久记忆">
      <div className={css.teamSectionHeader}>
        <strong>持久记忆</strong>
        <span className={css.teamSectionActions}>
          <span>版本 {view.revision}</span>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={busy || draft !== undefined}
            onClick={() => {
              setError(undefined)
              setLegacyEditing(true)
            }}
          >
            旧版文本
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={busy || draft !== undefined}
            onClick={() => {
              setError(undefined)
              setDraft({ title: '', body: '', visibility: 'private', key: '' })
            }}
          >
            新建条目
          </Button>
        </span>
      </div>
      <p className={css.assistantMemoryHint}>
        只注入本助手的主会话与后台任务；「团队可见」条目也只有显式关联到本实例的团队成员才会读取。
      </p>
      {(loadError !== undefined || error !== undefined) && (
        <div role="alert" className={css.inlineError}>{error ?? loadError}</div>
      )}
      {loading && <p className={css.memoryEmpty}>读取记忆中…</p>}
      {!loading && view.empty && draft === undefined && !legacyEditing && (
        <p className={css.memoryEmpty}>还没有持久记忆。助手也可以通过工具写入，或在此新建结构化条目。</p>
      )}
      {(view.content.trim() !== '' || legacyEditing) && (
        <div className={css.memoryGroup}>
          <div className={css.memoryGroupTitleRow}>
            <strong className={css.memoryGroupTitle}>旧版文本记忆</strong>
            <span className={css.memoryBadges}>
              <span className={css.memoryBadge}>旧版</span>
              <span className={css.memoryBadge}>v{revision}</span>
            </span>
          </div>
          {legacyEditing
            ? (
                <div className={css.memoryForm}>
                  <textarea
                    className={`${css.input} ${css.memoryTextarea}`}
                    value={legacyDraft}
                    rows={3}
                    maxLength={16_000}
                    aria-label="旧版文本记忆"
                    disabled={busy}
                    onChange={event => { setLegacyDraft(event.target.value) }}
                  />
                  <div className={css.memoryFormActions}>
                    <Button
                      variant="outline"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setLegacyDraft(view.content)
                        setLegacyEditing(false)
                        setConfirmClear(undefined)
                      }}
                    >
                      取消
                    </Button>
                    <Button variant="primary" type="button" disabled={busy} onClick={() => { void saveLegacy(legacyDraft) }}>
                      {busy ? '保存中…' : '保存旧版文本'}
                    </Button>
                  </div>
                </div>
              )
            : (
                <>
                  <p className={css.memoryEntryBody}>{view.content}</p>
                  <div className={css.memoryEntryMeta}>
                    <span>旧版单段文本；结构化条目优先</span>
                    <span className={css.memoryEntryActions}>
                      <button type="button" className={css.memoryAction} disabled={busy} onClick={() => { setLegacyEditing(true) }}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className={`${css.memoryAction} ${confirmClear === 'legacy' ? css.memoryActionConfirm : ''}`}
                        disabled={busy}
                        onClick={() => {
                          if (confirmClear !== 'legacy') {
                            setConfirmClear('legacy')
                            return
                          }
                          void saveLegacy('')
                        }}
                      >
                        {confirmClear === 'legacy' ? '确认清空' : '清空'}
                      </button>
                    </span>
                  </div>
                </>
              )}
        </div>
      )}
      {view.active.length > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>生效条目 · {view.active.length}</strong>
          {view.active.map(entry => entryCard(
            entry,
            <span className={css.memoryEntryActions}>
              <button
                type="button"
                className={css.memoryAction}
                disabled={busy}
                onClick={() => {
                  setError(undefined)
                  setConfirmClear(undefined)
                  setDraft({
                    id: entry.id,
                    title: entry.title,
                    body: entry.body,
                    visibility: entry.visibility,
                    key: entry.key ?? '',
                  })
                }}
              >
                编辑
              </button>
              <button
                type="button"
                className={`${css.memoryAction} ${confirmClear === entry.id ? css.memoryActionConfirm : ''}`}
                disabled={busy}
                onClick={() => { void archiveEntry(entry) }}
              >
                {confirmClear === entry.id ? '确认归档' : '归档'}
              </button>
            </span>,
          ))}
        </div>
      )}
      {view.proposed.length > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>待确认 · {view.proposed.length}</strong>
          {view.proposed.map(entry => entryCard(entry))}
        </div>
      )}
      {view.historyTotal > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>历史 · {view.historyTotal}</strong>
          {view.history.map(entry => entryCard(entry))}
          {view.historyTotal > view.history.length && (
            <p className={css.memoryEmpty}>仅显示最近 {view.history.length} 条历史记录。</p>
          )}
        </div>
      )}
      {journal.length > 0 && (
        <div className={css.memoryGroup}>
          <strong className={css.memoryGroupTitle}>变更日志 · {journal.length}</strong>
          {[...journal].reverse().map(record => {
            const blocked = record.redacted === true || record.trimmed === true
            return (
              <article key={record.id} className={css.memoryEntryCard}>
                <div className={css.memoryEntryHeader}>
                  <strong>{record.after?.title ?? record.before?.title ?? record.entryId}</strong>
                  <span className={css.memoryBadges}>
                    <span className={css.memoryBadge}>{memoryJournalActionLabel(record.action)}</span>
                    <span className={css.memoryBadge}>{memorySourceLabel(record.actor)}</span>
                    <span className={css.memoryBadge}>{memoryTime(record.at)}</span>
                  </span>
                </div>
                <div className={css.memoryEntryMeta}>
                  <span>{record.reason}</span>
                  <span className={css.memoryEntryActions}>
                    <button
                      type="button"
                      className={css.memoryAction}
                      disabled={busy || undoing !== undefined || blocked}
                      title={blocked ? '快照已脱敏或截断，无法安全撤销' : undefined}
                      onClick={() => { void undo(record.id) }}
                    >
                      {undoing === record.id ? '撤销中…' : '撤销'}
                    </button>
                  </span>
                </div>
              </article>
            )
          })}
        </div>
      )}
      {draft !== undefined && (
        <form
          className={css.memoryForm}
          onSubmit={event => { event.preventDefault(); void writeEntry() }}
        >
          <Field label="标题">
            <input
              className={css.input}
              value={draft.title}
              maxLength={200}
              disabled={busy}
              onChange={event => { setDraft({ ...draft, title: event.target.value }) }}
            />
          </Field>
          <Field label="内容">
            <textarea
              className={`${css.input} ${css.memoryTextarea}`}
              value={draft.body}
              rows={3}
              disabled={busy}
              onChange={event => { setDraft({ ...draft, body: event.target.value }) }}
            />
          </Field>
          <Field label="可见性">
            <select
              className={css.input}
              value={draft.visibility}
              disabled={busy}
              onChange={event => {
                setDraft({ ...draft, visibility: event.target.value === 'team-safe' ? 'team-safe' : 'private' })
              }}
            >
              <option value="private">私有（仅此助手）</option>
              <option value="team-safe">团队可见（仅关联成员读取）</option>
            </select>
          </Field>
          <Field label="键（可选）">
            <input
              className={css.input}
              value={draft.key}
              maxLength={200}
              disabled={busy}
              onChange={event => { setDraft({ ...draft, key: event.target.value }) }}
            />
          </Field>
          <div className={css.memoryFormActions}>
            <Button variant="outline" type="button" disabled={busy} onClick={() => { setDraft(undefined) }}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? '保存中…' : draft.id === undefined ? '添加条目' : '保存条目'}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
