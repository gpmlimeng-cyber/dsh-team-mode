import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  IconEditOutlineRegular,
  IconProjectAddOutlineRegular,
  IconSparkleRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { agentTeamErrorCode, callAgentTeam, subscribeAgentTeam } from './api.js'
import { CapabilityList, savableNames, useCapabilityCatalog } from './assistant-capabilities.js'
import {
  AssistantAvatarEditor,
  AVATAR_EDITOR_ID,
  avatarDraftFromInstance,
  avatarDraftReset,
  type AvatarDraft,
} from './assistant-avatar-editor.js'
import {
  assistantAvatarDataUrlError,
  assistantInstanceName,
  assistantNow,
} from './assistant-instances.js'
import { ASSISTANT_TITLE_MAX_CHARS } from './assistant-form.js'
import {
  AutomationSection,
  HistorySection,
  PersonaSection,
} from './assistant-detail.js'
import { AssistantMemorySection } from './assistant-memory-panel.js'
import { PERMISSION_LABELS } from './labels.js'
import { MemberAvatar } from './member-avatar.js'
import { Mascot } from './mascot-view.js'
import type { MascotMotion } from './mascot.js'
import { useModelCapabilities } from './model-reasoning.js'
import {
  ModelControl,
  modelControlReasoning,
  modelControlTrigger,
  type ModelControlModel,
  type ModelControlPatch,
} from './model-control.js'
import { SelectControl } from './select-control.js'
import type { SelectControlOption } from './select-control.js'
import { SettingsRow, SettingsRows } from './settings-row.js'
import { AssistantCheckpointDialog } from './assistant-checkpoint-dialog.js'
import {
  assistantSessionOps,
  ensureAssistantMainSession,
  openAssistantSession,
} from './store.js'
import { UsageSection, assistantUsageScope } from './usage.js'
import css from './AgentTeam.module.css'
import { isCoordinatorInstance } from '../domain/types.js'
import { LeaderMark } from './team-member-chrome.js'
import type {
  AssistantSession,
  UpdateAssistantInstanceInput,
} from '../domain/types.js'
import type {
  AssistantInstanceView,
  CatalogView,
} from '../transport/contracts.js'

/**
 * The page type this plugin owns on the host's right Sidebar. `kind` is the
 * open string `openTab` dispatches on; `id` is also the key the body registers
 * under in `sidebar.right.pane.tab` (see the sidebar-right contract note
 * `docs/superpowers/notes/2026-10-26-sidebar-right.md`).
 */
export const DETAIL_TAB_KIND = 'team-mode'
export const DETAIL_TAB_ID = '@limeng/dsh-team-mode/detail'
export const DETAIL_TAB_TITLE = '助手设置'

/** Shown before any helper was opened through the row menu. */
export const DETAIL_EMPTY_TEXT = '从左侧选择一个助手'

/** Row menu → host listener. The menu never calls `openTab` itself. */
export const OPEN_ASSISTANT_SETTINGS_EVENT = 'dsh-team-mode:open-assistant-settings'

/**
 * The assistant a pane instance was opened for. It is module-level state on
 * purpose: the pane reads the one id that was passed with the open action, not
 * the sidebar's "currently selected" row, so an idle pane never follows the
 * list. `set` happens in the host listener right before `openTab`.
 */
export interface AssistantDetailTarget {
  getSnapshot(): string | undefined
  getServerSnapshot(): string | undefined
  subscribe(listener: () => void): () => void
  set(assistantId: string): void
}

function createAssistantDetailTarget(): AssistantDetailTarget {
  let assistantId: string | undefined
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => assistantId,
    getServerSnapshot: () => assistantId,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      if (next === assistantId) return
      assistantId = next
      for (const listener of listeners) listener()
    },
  }
}

export const assistantDetailTarget = createAssistantDetailTarget()

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** A per-assistant queue: each whole-snapshot patch waits for the previous one. */
export interface AssistantPatchQueue {
  enqueue(patch: UpdateAssistantInstanceInput): Promise<void>
  /** Resolves after every write queued so far has settled. */
  idle(): Promise<void>
}

/**
 * Serialize writes for one assistant. Reading the tail at call time is what
 * makes this immune to a stale render: an avatar debounce captured before a
 * blur write still queues behind it instead of firing a second overlapping
 * `assistant.instance.update` (which would replace the earlier field).
 */
export function createPatchQueue(
  send: (patch: UpdateAssistantInstanceInput) => Promise<void>,
): AssistantPatchQueue {
  let tail: Promise<void> = Promise.resolve()
  return {
    enqueue(patch) {
      const run = tail.then(() => send(patch), () => send(patch))
      tail = run.then(() => undefined, () => undefined)
      return run
    },
    idle: () => tail,
  }
}

const assistantQueues = new Map<string, AssistantPatchQueue>()

/**
 * The one queue for an assistant, shared across pane remounts. A pending write
 * from a closed pane therefore still finishes before the reopened pane's first
 * write, instead of two whole-snapshot updates racing for the same row.
 */
export function assistantPatchQueue(
  assistantId: string,
  send: (patch: UpdateAssistantInstanceInput) => Promise<void>,
): AssistantPatchQueue {
  const existing = assistantQueues.get(assistantId)
  if (existing !== undefined) return existing
  const queue = createPatchQueue(send)
  assistantQueues.set(assistantId, queue)
  return queue
}

/** A blur on 名称 writes one field; an empty or unchanged name writes nothing. */
export function assistantNamePatch(
  assistant: AssistantInstanceView,
  avatarDraft: string,
): { name: string } | undefined {
  const name = avatarDraft.trim()
  if (name === '' || name === assistantInstanceName(assistant)) return undefined
  return { name }
}

/** A blur on 称号 writes one field; an emptied line travels as '' to clear it. */
export function assistantTitlePatch(
  assistant: AssistantInstanceView,
  draft: string,
): { title: string } | undefined {
  const title = draft.trim()
  if (title === (assistant.assistantSnapshot.title ?? '')) return undefined
  return { title }
}

/** The avatar draft's diff against the stored snapshot, or undefined if clean. */
export function assistantAvatarPatch(
  assistant: AssistantInstanceView,
  avatarDraft: AvatarDraft,
): UpdateAssistantInstanceInput | undefined {
  const snapshot = assistant.assistantSnapshot
  const value: UpdateAssistantInstanceInput = {}
  if (avatarDraft.avatar !== (snapshot.avatar ?? '')) value.avatar = avatarDraft.avatar
  const nextMascot = {
    seed: avatarDraft.seed.trim() === '' ? assistant.id : avatarDraft.seed.trim(),
    ...(avatarDraft.mascot.shapeVariant === undefined ? {} : { shape: avatarDraft.mascot.shapeVariant }),
    ...(avatarDraft.mascot.eyesVariant === undefined ? {} : { eyes: avatarDraft.mascot.eyesVariant }),
    ...(avatarDraft.mascot.spacingVariant === undefined ? {} : { spacing: avatarDraft.mascot.spacingVariant }),
    ...(avatarDraft.mascot.bodyColor === undefined ? {} : { color: avatarDraft.mascot.bodyColor }),
    ...(avatarDraft.mascot.bodyColorFill === 'radial' ? { fill: 'radial' as const } : {}),
  }
  if (JSON.stringify(nextMascot) !== JSON.stringify(assistant.mascot)) value.mascot = nextMascot
  return Object.keys(value).length === 0 ? undefined : value
}

export function AssistantSettingsPane({
  assistant,
  expanded,
  onSaved,
}: {
  assistant: AssistantInstanceView
  expanded?: boolean | undefined
  onSaved: () => Promise<void> | void
}): JSX.Element {
  const [name, setName] = useState(assistantInstanceName(assistant))
  // 称号 is the optional second identity line; 指令 keeps its own explicit save
  // inside PersonaSection, so it never rides a write-through path.
  const [title, setTitle] = useState(assistant.assistantSnapshot.title ?? '')
  // The avatar, its mascot options and its seed are one draft; the floating
  // editor stages it and a debounce writes the settled draft through.
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>(() => avatarDraftFromInstance(assistant))
  const [avatarEditing, setAvatarEditing] = useState(false)
  const [workspaceTitle, setWorkspaceTitle] = useState<string>()
  const [catalog, setCatalog] = useState<CatalogView>()
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string>()
  const [provider, setProvider] = useState(assistant.assistantSnapshot.provider)
  const [model, setModel] = useState(assistant.assistantSnapshot.model)
  const [reasoningEffort, setReasoningEffort] = useState(assistant.assistantSnapshot.reasoningEffort ?? '')
  const [permissionPresetId, setPermissionPresetId] = useState(assistant.assistantSnapshot.permissionPresetId)
  const [selectedSkills, setSelectedSkills] = useState<string[]>([...assistant.assistantSnapshot.skillAllowlist])
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([...assistant.assistantSnapshot.mcpServers])
  const [confirmArchive, setConfirmArchive] = useState(false)
  /**
   * Server wording for a lifecycle refusal that has an explicit second exit:
   * archive with a live team link (`ASSISTANT_INSTANCE_TEAM_LINKED`) or restore
   * against an archived team (`ASSISTANT_INSTANCE_TEAM_UNAVAILABLE`). Shown
   * verbatim — the service owns the team names and the ways out, and a second
   * copy here would drift the day that message changes.
   */
  const [teamConflict, setTeamConflict] = useState<{
    kind: 'archive' | 'restore'
    message: string
  }>()
  // Every row's write joins one per-assistant queue; these keys only drive the
  // inline 保存中…/已保存/失败 lines. There is no bottom save bar.
  const [savingKeys, setSavingKeys] = useState<string[]>([])
  const [personaSaving, setPersonaSaving] = useState(false)
  const [feedback, setFeedback] = useState<{
    key: string
    kind: 'saved' | 'error'
    message?: string
  }>()
  const [archiving, setArchiving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const [actionNotice, setActionNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [mascotMotion, setMascotMotion] = useState<MascotMotion>('idle')
  const [mascotMotionKey, setMascotMotionKey] = useState(0)
  // The hidden task-worker Sessions are part of this assistant's usage. One
  // scoped read; a failure is labelled on the panel instead of silently
  // shrinking the total.
  const [taskUsage, setTaskUsage] = useState<{ tasks: AssistantSession[]; failed: boolean }>({
    tasks: [],
    failed: false,
  })
  // Only a user edit marks the draft dirty; the initial/reset draft must never
  // write back just because the pane mounted.
  const avatarDirty = useRef(false)
  const mounted = useRef(true)
  const avatarDraftRef = useRef(avatarDraft)
  avatarDraftRef.current = avatarDraft
  // One queue per mounted pane (and therefore one per assistant: the pane is
  // keyed by instance id). Every write below joins it.
  const queue = useMemo(() => assistantPatchQueue(assistant.id, async value => {
    await callAgentTeam('assistant.instance.update', { id: assistant.id, value })
  }), [assistant.id])

  const busy = savingKeys.length > 0 || personaSaving
    || archiving || restoring || pausing || compacting
  const modelCapabilities = useModelCapabilities(provider, model)
  // The hero subtitle still names the live task status, so opening a helper
  // remains a status read even without a 现在 block.
  const now = assistantNow(assistant, taskUsage.tasks)
  // The Agent Preset is fixed at creation, so this catalog never changes for
  // one instance: whatever it lists is exactly what a save may carry.
  const capabilities = useCapabilityCatalog(assistant.assistantSnapshot.agentPresetId)
  const reasoning = modelControlReasoning(modelCapabilities.value)

  // The task list feeds 用量. It is read once per assistant the pane is pointed
  // at and re-read on every Host event, because a task changing status must
  // move the subtitle with it instead of leaving it stale.
  useEffect(() => {
    let live = true
    setTaskUsage({ tasks: [], failed: false })
    const read = (): void => {
      void callAgentTeam('assistant.task.list', { assistantId: assistant.id }).then(
        value => {
          if (live) setTaskUsage({ tasks: value.items, failed: false })
        },
        () => {
          if (live) setTaskUsage({ tasks: [], failed: true })
        },
      )
    }
    read()
    const unsubscribe = subscribeAgentTeam(read, () => {}, read)
    return () => {
      live = false
      unsubscribe()
    }
  }, [assistant.id])

  // Refresh the editable draft whenever the pane is pointed at another helper.
  // Keyed by id: a list refresh for the same helper must not overwrite typing.
  useEffect(() => {
    let live = true
    setName(assistantInstanceName(assistant))
    setTitle(assistant.assistantSnapshot.title ?? '')
    setAvatarDraft(avatarDraftFromInstance(assistant))
    setAvatarEditing(false)
    avatarDirty.current = false
    setWorkspaceTitle(undefined)
    setCatalog(undefined)
    setCatalogLoading(true)
    setCatalogError(undefined)
    setProvider(assistant.assistantSnapshot.provider)
    setModel(assistant.assistantSnapshot.model)
    setReasoningEffort(assistant.assistantSnapshot.reasoningEffort ?? '')
    setPermissionPresetId(assistant.assistantSnapshot.permissionPresetId)
    setSelectedSkills([...assistant.assistantSnapshot.skillAllowlist])
    setSelectedMcpServers([...assistant.assistantSnapshot.mcpServers])
    setConfirmArchive(false)
    setTeamConflict(undefined)
    setSavingKeys([])
    setPersonaSaving(false)
    setFeedback(undefined)
    setArchiving(false)
    setRestoring(false)
    setPausing(false)
    setError(undefined)
    setMascotMotion('idle')
    setMascotMotionKey(0)
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
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on identity, not on every list refresh
  }, [assistant.id])

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

  // A settled avatar draft writes itself. Debouncing keeps a colour drag from
  // firing one update per pointer move; closing the editor does not discard it.
  useEffect(() => {
    if (!avatarDirty.current) return undefined
    const timer = window.setTimeout(() => {
      if (!avatarDirty.current) return
      avatarDirty.current = false
      void commitAvatar()
    }, 600)
    return () => { window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one write per settled draft
  }, [avatarDraft])

  // A switch remounts this pane (key=instance.id) and unmount clears the
  // debounce, so the old instance flushes its pending draft through its own
  // queue before it goes away; a close flush also covers the editor case.
  const flushAvatarRef = useRef<() => void>(() => {})
  flushAvatarRef.current = () => {
    if (!avatarDirty.current) return
    avatarDirty.current = false
    const value = assistantAvatarPatch(assistant, avatarDraftRef.current)
    if (value !== undefined) void queue.enqueue(value).catch(() => {})
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      flushAvatarRef.current()
    }
  }, [assistant.id])

  const closeAvatarEditor = useCallback((): void => {
    setAvatarEditing(false)
    flushAvatarRef.current()
  }, [])

  /** Stage one avatar edit; the debounce above owns writing it. */
  function stageAvatar(update: (draft: AvatarDraft) => AvatarDraft): void {
    avatarDirty.current = true
    setAvatarDraft(update)
    setFeedback(current => (current?.key === 'avatar' ? undefined : current))
  }

  /** Queue one patch; resolves to the failure message, or undefined on success. */
  async function send(value: UpdateAssistantInstanceInput): Promise<string | undefined> {
    try {
      await queue.enqueue(value)
      return undefined
    } catch (cause) {
      return `保存失败：${messageOf(cause)}`
    }
  }

  /**
   * The one write-through path: one field's patch travels alone, and its row
   * owns the inline status. Writes queue behind each other per assistant, so a
   * debounced avatar patch and a blur patch can never race the whole-snapshot
   * update; a patch is deferred, never dropped, when another write is in
   * flight. Only the lifecycle error is left alone: a field save must not erase
   * an archive/pause refusal.
   */
  async function write(key: string, value: UpdateAssistantInstanceInput): Promise<boolean> {
    setSavingKeys(keys => (keys.includes(key) ? keys : [...keys, key]))
    setFeedback(current => (
      current !== undefined && current.key === key ? undefined : current
    ))
    const failure = await send(value)
    if (mounted.current) {
      if (failure === undefined) {
        setFeedback({ key, kind: 'saved' })
        try {
          await onSaved()
        } catch {
          // The write landed; a refresh failure is not a write failure.
        }
      } else {
        setFeedback({ key, kind: 'error', message: failure })
      }
      setSavingKeys(keys => keys.filter(candidate => candidate !== key))
    }
    return failure === undefined
  }

  /** 名称 writes on blur; an empty name is refused inline, never sent. */
  async function commitName(): Promise<void> {
    const displayName = name.trim()
    if (displayName === '') {
      setFeedback({ key: 'name', kind: 'error', message: '名称不能为空' })
      return
    }
    const patch = assistantNamePatch(assistant, name)
    if (patch === undefined) return
    if (await write('name', patch)) setName(displayName)
  }

  /** 称号 writes on blur; an emptied line travels as '' to clear it. */
  async function commitTitle(): Promise<void> {
    const nextTitle = title.trim()
    if (nextTitle.length > ASSISTANT_TITLE_MAX_CHARS) {
      setFeedback({
        key: 'title',
        kind: 'error',
        message: `称号最多 ${ASSISTANT_TITLE_MAX_CHARS} 个字`,
      })
      return
    }
    const patch = assistantTitlePatch(assistant, title)
    if (patch === undefined) return
    if (await write('title', patch)) setTitle(nextTitle)
  }

  /** The avatar draft, written after the debounce settles. */
  async function commitAvatar(): Promise<void> {
    const avatarError = assistantAvatarDataUrlError(avatarDraft.avatar)
    if (avatarError !== undefined) {
      setFeedback({ key: 'avatar', kind: 'error', message: avatarError })
      return
    }
    const value = assistantAvatarPatch(assistant, avatarDraft)
    if (value === undefined) return
    const saved = await write('avatar', value)
    // A failed avatar keeps the draft dirty, so the next close/unmount retries
    // the same patch rather than silently forgetting it.
    if (!saved) avatarDirty.current = true
    if (!mounted.current) return
    setMascotMotion(saved ? 'success' : 'failure')
    setMascotMotionKey(key => key + 1)
  }

  /** 模型/推理 write on change; a failure rolls the two controls back. */
  async function commitModel(patch: ModelControlPatch): Promise<void> {
    const snapshot = assistant.assistantSnapshot
    const nextProvider = patch.provider ?? provider
    const nextModel = patch.model ?? model
    let nextReasoningEffort = patch.reasoningEffort ?? reasoningEffort
    const value: UpdateAssistantInstanceInput = {}
    if (patch.provider !== undefined || patch.model !== undefined) {
      if (nextProvider.trim() === '' || nextModel.trim() === '') {
        setFeedback({ key: 'model', kind: 'error', message: '请选择 Provider 和模型' })
        return
      }
      // A new model may not serve the stored level. Read its levels before the
      // write so the pair and the cleared effort land in one patch instead of
      // leaving a level the new model never offered.
      try {
        const capabilities = await callAgentTeam('catalog.model.get', {
          provider: nextProvider,
          model: nextModel,
        })
        const efforts = capabilities.reasoning?.efforts ?? []
        if (nextReasoningEffort !== ''
          && !efforts.some(effort => effort.id === nextReasoningEffort)) {
          nextReasoningEffort = ''
        }
      } catch {
        // Keep the stored level; the capability read reports its own failure.
      }
      // provider and model always travel together so the service can validate
      // the pair against the current model catalog.
      value.provider = nextProvider
      value.model = nextModel
    }
    if (nextReasoningEffort.trim() !== (snapshot.reasoningEffort ?? '')) {
      // An empty string clears the effort and falls back to the model default.
      value.reasoningEffort = nextReasoningEffort
    }
    if (Object.keys(value).length === 0) return
    setProvider(nextProvider)
    setModel(nextModel)
    setReasoningEffort(nextReasoningEffort)
    const key = patch.reasoningEffort !== undefined && patch.provider === undefined
      && patch.model === undefined ? 'reasoning' : 'model'
    if (await write(key, value)) return
    setProvider(snapshot.provider)
    setModel(snapshot.model)
    setReasoningEffort(snapshot.reasoningEffort ?? '')
  }

  /** 权限 writes on change; it only affects sessions created or resumed later. */
  async function commitPermission(next: string): Promise<void> {
    if (next.trim() === '') return
    const previous = permissionPresetId
    setPermissionPresetId(next)
    if (next === assistant.assistantSnapshot.permissionPresetId) return
    if (await write('permission', { permissionPresetId: next })) return
    setPermissionPresetId(previous)
  }

  /** Skills/MCP toggles write on change; the pair keeps its saved order. */
  async function commitCapabilities(
    kind: 'skills' | 'mcpServers',
    next: string[],
  ): Promise<void> {
    if (kind === 'skills') setSelectedSkills(next)
    else setSelectedMcpServers(next)
    // Only a successful catalog read can say a stored reference is gone; an
    // unavailable row is never written back.
    if (!capabilities.loaded) return
    const snapshot = assistant.assistantSnapshot
    const value: UpdateAssistantInstanceInput = {}
    if (kind === 'skills') {
      const names = savableNames(next, capabilities.skills)
      setSelectedSkills(names)
      if (JSON.stringify(names) !== JSON.stringify(snapshot.skillAllowlist)) {
        value.skillAllowlist = names
      }
    } else {
      const names = savableNames(next, capabilities.mcpServers)
      setSelectedMcpServers(names)
      if (JSON.stringify(names) !== JSON.stringify(snapshot.mcpServers)) {
        value.mcpServers = names
      }
    }
    if (Object.keys(value).length === 0) return
    if (await write('capabilities', value)) return
    setSelectedSkills([...snapshot.skillAllowlist])
    setSelectedMcpServers([...snapshot.mcpServers])
  }

  /**
   * Archive, with the second exit the service asks for. A live team still
   * linking this assistant refuses the call; the refusal is not an error box —
   * it is a choice between "remove it from the team first" and "archive anyway,
   * keep the link as invalidated" (`force`), so the server message is surfaced
   * verbatim next to the force button.
   */
  async function archive(force = false): Promise<void> {
    if (busy) return
    if (!force && !confirmArchive) {
      setConfirmArchive(true)
      setError(undefined)
      setTeamConflict(undefined)
      return
    }
    setArchiving(true)
    setError(undefined)
    try {
      await callAgentTeam(
        'assistant.instance.archive',
        force ? { id: assistant.id, force: true } : { id: assistant.id },
      )
      setTeamConflict(undefined)
      await onSaved()
    } catch (cause) {
      if (!force && agentTeamErrorCode(cause) === 'ASSISTANT_INSTANCE_TEAM_LINKED') {
        setTeamConflict({ kind: 'archive', message: messageOf(cause) })
        setConfirmArchive(false)
        return
      }
      setError(`归档失败：${messageOf(cause)}`)
    } finally {
      setArchiving(false)
    }
  }

  /** Pause stops the live turn (destructive) and gates the queue; resume drains it. */
  async function togglePause(): Promise<void> {
    if (busy) return
    setPausing(true)
    setError(undefined)
    try {
      await callAgentTeam(
        assistant.pausedAt === undefined ? 'assistant.instance.pause' : 'assistant.instance.resume',
        { id: assistant.id },
      )
      await onSaved()
    } catch (cause) {
      setError(`${assistant.pausedAt === undefined ? '暂停' : '继续'}失败：${messageOf(cause)}`)
    } finally {
      setPausing(false)
    }
  }

  /**
   * Restore an archived assistant row; Sessions and the workspace stay
   * untouched. A link whose team is archived refuses the call and offers the
   * same second exit as archive: force, which clears the dead link.
   */
  async function restore(force = false): Promise<void> {
    if (busy) return
    setRestoring(true)
    setError(undefined)
    try {
      await callAgentTeam(
        'assistant.instance.restore',
        force ? { id: assistant.id, force: true } : { id: assistant.id },
      )
      setTeamConflict(undefined)
      await onSaved()
    } catch (cause) {
      if (!force && agentTeamErrorCode(cause) === 'ASSISTANT_INSTANCE_TEAM_UNAVAILABLE') {
        setTeamConflict({ kind: 'restore', message: messageOf(cause) })
        return
      }
      setError(`恢复失败：${messageOf(cause)}`)
    } finally {
      setRestoring(false)
    }
  }

  /**
   * 压缩上下文: run the shipped `/compact` in the canonical chat through the
   * host's client Session service (the same call the composer uses). No second
   * compactor and no endpoint; a busy/unavailable host refusal is shown inline,
   * and the session opens so the native compaction flow/refusal is visible.
   */
  async function compactMainSession(): Promise<void> {
    if (compacting) return
    setCompacting(true)
    setError(undefined)
    setActionNotice(undefined)
    try {
      const ops = assistantSessionOps()
      if (ops === undefined) {
        setError('宿主会话服务不可用，无法执行 /compact')
        return
      }
      const session = await ensureAssistantMainSession(assistant.id, {
        bound: assistant.mainSessionId !== undefined,
      })
      if (session.notice !== undefined) setActionNotice(session.notice)
      const verdict = await ops.command(session.sessionId, '/compact')
      if (!verdict.ok) {
        setError(`压缩被拒绝：${verdict.message ?? '宿主拒绝执行 /compact'}`)
        return
      }
      if (!verdict.matched) {
        setError('这个会话没有可用的 /compact 命令')
        return
      }
      setActionNotice('已发送原生 /compact')
      if (!openAssistantSession(session.sessionId)) {
        setActionNotice('已发送原生 /compact；会话界面还未就绪')
      }
      await onSaved()
    } catch (cause) {
      setError(`压缩失败：${messageOf(cause)}`)
    } finally {
      setCompacting(false)
    }
  }

  /** 开始新关系: reuse the existing checkpoint handoff; never archive main. */
  function startNewRelationship(): void {
    setError(undefined)
    setActionNotice(undefined)
    setCheckpointOpen(true)
  }

  const displayName = name.trim() === '' ? '助手' : name.trim()
  const workspaceLabel = workspaceTitle === undefined
    ? assistant.workspacePath
    : workspaceTitle
  const modelGroups = (catalog?.providers ?? []).map(providerEntry => ({
    provider: providerEntry,
    models: catalog?.models[providerEntry.id] ?? [],
  })).filter(group => group.models.length > 0)
  const modelSelectionInCatalog = modelGroups.some(group => (
    group.provider.id === provider && group.models.some(modelEntry => modelEntry.id === model)
  ))
  // The split model/reasoning controls read one flat row list. A stored model
  // the catalog dropped stays in it, so the menu never hides what is saved.
  const modelControlModels: ModelControlModel[] = [
    ...modelGroups.flatMap(group => group.models.map(modelEntry => ({
      providerId: group.provider.id,
      providerName: group.provider.name,
      modelId: modelEntry.id,
      label: modelEntry.name,
    }))),
    ...(modelSelectionInCatalog || model === ''
      ? []
      : [{ providerId: provider, providerName: provider, modelId: model, label: model }]),
  ]
  const modelControlHint = modelControlTrigger(
    provider,
    model,
    modelControlModels,
    reasoning,
    reasoningEffort,
    'model',
  )
  const permissionOptions = catalog?.permissionPresets ?? []
  const permissionInCatalog = permissionOptions.some(option => option.value === permissionPresetId)
  const permissionSelectOptions: SelectControlOption[] = [
    ...(permissionInCatalog
      ? []
      : [{
          value: permissionPresetId,
          label: `${PERMISSION_LABELS[permissionPresetId] ?? permissionPresetId}（当前）`,
        }]),
    ...permissionOptions.map(option => ({
      value: option.value,
      label: PERMISSION_LABELS[option.value] ?? option.name,
    })),
  ]
  // The subtitle names what the assistant is: its group, role and task-derived
  // status. The lifecycle "活跃" is not read here any more: it was written once
  // at bind time and stayed forever, so it answered nothing.
  const avatarSubtitle = [
    assistant.group,
    isCoordinatorInstance(assistant) ? '总协调' : undefined,
    now.statusText,
  ].filter((part): part is string => part !== undefined && part !== '').join(' · ')

  /** Inline write-through status for one row: saving, saved, or the failure. */
  function status(key: string): JSX.Element | undefined {
    if (savingKeys.includes(key)) {
      return (
        <span className={css.assistantSaveStatus} data-dsh-assistant-save-status="saving" role="status">
          保存中…
        </span>
      )
    }
    if (feedback === undefined || feedback.key !== key) return undefined
    return feedback.kind === 'saved'
      ? (
        <span className={css.assistantSaveStatus} data-dsh-assistant-save-status="saved" role="status">
          已保存
        </span>
      )
      : (
        <span className={css.assistantSaveStatusError} data-dsh-assistant-save-status="error" role="alert">
          {feedback.message}
        </span>
      )
  }

  /** One nightly row this plugin cannot save: inert, honest, never a fake value. */
  function unsupported(label: string): JSX.Element {
    return (
      <span
        className={css.assistantUnsupportedValue}
        data-dsh-assistant-unsupported={label}
        aria-disabled="true"
      >
        暂不支持
      </span>
    )
  }

  return (
    <div
      className={css.assistantDetail}
      data-dsh-assistant-detail
      data-expanded={expanded}
    >
      {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
      {actionNotice !== undefined && (
        <div className={css.assistantDetailNotice} role="status">{actionNotice}</div>
      )}
      {catalogError !== undefined && <div className={css.inlineError} role="alert">{catalogError}</div>}

      {/* 身份: the avatar, then 名称 / 称号 as full-width fields. 指令 follows in
          its own block because it keeps its own save. */}
      <section
        className={css.assistantSettingsSection}
        data-dsh-assistant-section="identity"
        aria-label="身份"
      >
        {/* Only the avatar shows; the pencil at its corner floats the editor. */}
        <div className={css.assistantAvatarHero} data-dsh-assistant-avatar-hero>
          <div className={css.assistantAvatarAnchor}>
            <button
              type="button"
              className={css.assistantAvatarTrigger}
              data-dsh-avatar-trigger
              aria-label="编辑头像"
              aria-expanded={avatarEditing}
              aria-controls={avatarEditing ? AVATAR_EDITOR_ID : undefined}
              onClick={() => { setAvatarEditing(open => !open) }}
            >
              {avatarDraft.avatar === ''
                ? (
                  <Mascot
                    seed={avatarDraft.seed}
                    options={avatarDraft.mascot}
                    size={64}
                    avatarShape="rounded"
                    motion={mascotMotion}
                    motionKey={mascotMotionKey}
                  />
                )
                : <MemberAvatar name={displayName} avatar={avatarDraft.avatar} size={64} />}
              <span className={css.assistantAvatarBadge} aria-hidden="true">
                <IconEditOutlineRegular size={12} />
              </span>
            </button>
          </div>
          <div className={css.assistantAvatarWho}>
            <span className={css.assistantAvatarNameRow}>
              <span className={css.assistantAvatarName}>{displayName}</span>
              {isCoordinatorInstance(assistant) && (
                <span
                  className={css.assistantAvatarCrownChip}
                  data-dsh-assistant-avatar-crown
                  role="img"
                  aria-label="总协调"
                  title="总协调"
                >
                  <LeaderMark size={11} />
                </span>
              )}
            </span>
            <span className={css.assistantAvatarSub}>{avatarSubtitle}</span>
          </div>
          {avatarEditing && (
            <AssistantAvatarEditor
              draft={avatarDraft}
              disabled={busy}
              onDraftChange={stageAvatar}
              onReset={() => { stageAvatar(() => avatarDraftReset(assistant.id)) }}
              onClose={closeAvatarEditor}
            />
          )}
        </div>
        {status('avatar')}
        <div className={css.assistantIdentityFields}>
          <label className={css.assistantIdentityField}>
            <span className={css.assistantIdentityLabel}>名称</span>
            <input
              className={css.input}
              value={name}
              disabled={busy}
              placeholder="助手名称"
              aria-label="名称"
              onChange={event => { setName(event.target.value); setFeedback(undefined) }}
              onBlur={() => { void commitName() }}
            />
            {status('name')}
          </label>
          <label className={css.assistantIdentityField}>
            <span className={css.assistantIdentityLabel}>称号</span>
            <input
              className={css.input}
              value={title}
              disabled={busy}
              placeholder="例如：后端工程师"
              aria-label="称号"
              data-dsh-assistant-title
              onChange={event => { setTitle(event.target.value); setFeedback(undefined) }}
              onBlur={() => { void commitTitle() }}
            />
            <span className={css.assistantIdentityCounter} data-dsh-assistant-title-count>
              {title.length} / {ASSISTANT_TITLE_MAX_CHARS}
            </span>
            {status('title')}
          </label>
        </div>
      </section>

      <section
        className={css.assistantSettingsSection}
        data-dsh-assistant-section="instructions"
        aria-label="指令"
      >
        <h3 className={css.assistantSettingsSectionTitle}>指令</h3>
        <PersonaSection
          instance={assistant}
          onSaved={() => { void onSaved() }}
          write={value => send(value)}
          disabled={busy}
          onSavingChange={setPersonaSaving}
        />
      </section>

      <section
        className={css.assistantSettingsSection}
        data-dsh-assistant-section="core"
        aria-label="核心"
      >
        <h3 className={css.assistantSettingsSectionTitle}>核心</h3>
        <SettingsRows>
          <SettingsRow
            label="模型"
            hint={catalogLoading
              ? '正在读取模型列表…'
              : `${modelControlHint.subtitle ?? provider} · 模型与推理强度只影响之后启动的会话；已打开的主会话沿用旧模型，重新打开后生效。`}
            control={(
              <>
                <ModelControl
                  provider={provider}
                  model={model}
                  reasoningEffort={reasoningEffort}
                  models={modelControlModels}
                  capabilities={modelCapabilities.value}
                  disabled={busy || catalog === undefined}
                  section="model"
                  ariaLabel="模型"
                  onChange={patch => { void commitModel(patch) }}
                />
                {status('model')}
              </>
            )}
          />
          <SettingsRow
            label="推理"
            hint={modelCapabilities.loading
              ? '正在读取推理档位…'
              : reasoning === undefined
                ? '当前模型没有可调档位，沿用模型默认。'
                : '只影响之后启动的会话；已打开的主会话沿用旧档位。'}
            control={(
              <>
                <ModelControl
                  provider={provider}
                  model={model}
                  reasoningEffort={reasoningEffort}
                  models={modelControlModels}
                  capabilities={modelCapabilities.value}
                  disabled={busy || catalog === undefined || reasoning === undefined}
                  section="reasoning"
                  ariaLabel="推理"
                  onChange={patch => { void commitModel(patch) }}
                />
                {status('reasoning')}
              </>
            )}
          />
        </SettingsRows>
        {modelCapabilities.error !== undefined && (
          <div className={css.inlineError} role="alert">
            读取模型能力失败：{modelCapabilities.error}
          </div>
        )}
      </section>

      <section
        className={css.assistantSettingsSection}
        data-dsh-assistant-section="fallback"
        aria-label="备用模型"
      >
        <h3 className={css.assistantSettingsSectionTitle}>备用模型</h3>
        <SettingsRows>
          <SettingsRow
            label="备用模型"
            hint="主模型不可用时自动切换；宿主没有备用模型概念。"
            control={unsupported('备用模型')}
          />
        </SettingsRows>
      </section>

      <section
        className={css.assistantSettingsSection}
        data-dsh-assistant-section="known"
        aria-label="已知"
      >
        <h3 className={css.assistantSettingsSectionTitle}>已知</h3>
        <div className={css.assistantSettingsBlock} data-dsh-assistant-block="memory">
          <span className={css.assistantSettingsBlockTitle}>记忆</span>
          <AssistantMemorySection assistantId={assistant.id} />
        </div>
        <div className={css.assistantSettingsBlock} data-dsh-assistant-block="skills">
          <span className={css.assistantSettingsBlockTitle}>
            {`技能 · 已选 ${selectedSkills.length + selectedMcpServers.length} 项`}
          </span>
          <CapabilityList
            ariaLabel="选择助手可使用的 Skills"
            icon={<IconSparkleRegular size={14} />}
            emptyText="该 Agent Preset 没有可用的 Skill。"
            missingDetail="该 Agent Preset 不再提供这个 Skill，保存时不会带上"
            selected={selectedSkills}
            options={capabilities.skills}
            loading={capabilities.loading}
            error={capabilities.error}
            disabled={busy}
            onChange={next => { void commitCapabilities('skills', next) }}
          />
          <strong className={css.settingsRowLabel}>MCP</strong>
          <CapabilityList
            ariaLabel="选择助手可使用的 MCP Server"
            icon={<IconProjectAddOutlineRegular size={14} />}
            emptyText="该 Agent Preset 没有可用的 MCP Server。"
            missingDetail="该 Agent Preset 不再提供这个 MCP Server，保存时不会带上"
            selected={selectedMcpServers}
            options={capabilities.mcpServers}
            loading={capabilities.loading}
            error={capabilities.error}
            disabled={busy}
            onChange={next => { void commitCapabilities('mcpServers', next) }}
          />
          {status('capabilities')}
        </div>
        <SettingsRows>
          <SettingsRow
            label="文件"
            hint="只读；这个助手的文件读写都发生在该工作区里。"
            control={(
              <span className={css.assistantWorkValue} title={assistant.workspacePath}>
                {workspaceLabel}
              </span>
            )}
          />
          <SettingsRow
            label="数据表"
            hint="宿主没有可映射的数据表能力。"
            control={unsupported('数据表')}
          />
        </SettingsRows>
      </section>

      <section
        className={css.assistantSettingsSection}
        data-dsh-assistant-section="behavior"
        aria-label="行为"
      >
        <h3 className={css.assistantSettingsSectionTitle}>行为</h3>
        <div className={css.assistantSettingsBlock} data-dsh-assistant-block="automations">
          <span className={css.assistantSettingsBlockTitle}>自动化任务</span>
          <AutomationSection instance={assistant} />
        </div>
        <div className={css.assistantSettingsBlock} data-dsh-assistant-block="usage">
          <span className={css.assistantSettingsBlockTitle}>用量</span>
          <span className={css.assistantWorkHint}>只读 · 来自宿主会话投影</span>
          <UsageSection
            scope={assistantUsageScope(assistant, taskUsage.tasks)}
            {...(taskUsage.failed
              ? { excludeNote: '任务会话暂无法读取，合计不含任务会话' }
              : {})}
          />
        </div>
        <div className={css.assistantSettingsBlock} data-dsh-assistant-block="history">
          <span className={css.assistantSettingsBlockTitle}>会话历史</span>
          <HistorySection instance={assistant} onChanged={() => { void onSaved() }} />
        </div>
        <SettingsRows>
          <SettingsRow
            label="发布助手"
            hint="没有分发通道；宿主不提供发布能力。"
            control={unsupported('发布助手')}
          />
        </SettingsRows>
      </section>

      <section
        className={css.assistantSettingsSection}
        data-dsh-assistant-section="rules"
        aria-label="规则"
      >
        <h3 className={css.assistantSettingsSectionTitle}>规则</h3>
        <SettingsRows>
          <SettingsRow
            label="权限"
            hint="权限只影响之后创建或恢复的会话；已打开的主会话保持原权限。"
            control={(
              <>
                <SelectControl
                  ariaLabel="权限预设"
                  value={permissionPresetId}
                  options={permissionSelectOptions}
                  disabled={busy || catalog === undefined}
                  onChange={next => { void commitPermission(next) }}
                />
                {status('permission')}
              </>
            )}
          />
          <SettingsRow
            label="通知"
            hint="宿主暂无系统通知通道。"
            control={unsupported('通知')}
          />
        </SettingsRows>
        {/* 高级: the relationship operations and every irreversible move, kept
            next to 归档 so they live on one surface. */}
        <div className={css.assistantRulesAdvanced} data-dsh-assistant-rules-advanced>
          <span className={css.assistantSettingsBlockTitle}>高级</span>
          <div className={css.assistantDetailActions}>
            <button
              type="button"
              className={css.assistantSettingsAction}
              data-dsh-assistant-rules-action="compact"
              disabled={busy || compacting}
              title="在主会话里执行原生 /compact；忙碌或不可用时宿主的拒绝会显示在上方"
              onClick={() => { void compactMainSession() }}
            >
              {compacting ? '压缩中…' : '压缩上下文'}
            </button>
            <button
              type="button"
              className={css.assistantSettingsAction}
              data-dsh-assistant-rules-action="relationship"
              disabled={busy}
              title="用检查点交接开始一个新关系；旧主会话保留，不归档"
              onClick={startNewRelationship}
            >
              开始新关系
            </button>
          </div>
        </div>
        {assistant.status !== 'archived' && (
          <div className={css.assistantSettingsArchive}>
            <div className={css.assistantSettingsArchiveCopy}>
              <span className={css.assistantSettingsArchiveTitle}>
                {assistant.pausedAt === undefined ? '暂停运行' : '继续运行'}
              </span>
              <span className={css.assistantSettingsArchiveHint}>
                {assistant.pausedAt === undefined
                  ? '暂停会取消正在进行的回合（无法回放），并停止领取排队任务；之后可继续运行。'
                  : '继续会清空暂停标记，重新排队被暂停的任务并从原会话继续。'}
              </span>
            </div>
            <button
              type="button"
              className={css.dangerButton}
              disabled={busy}
              onClick={() => { void togglePause() }}
            >
              {pausing ? '处理中…' : assistant.pausedAt === undefined ? '暂停运行' : '继续运行'}
            </button>
          </div>
        )}
        <div className={css.assistantSettingsArchive}>
          <div className={css.assistantSettingsArchiveCopy}>
            <span className={css.assistantSettingsArchiveTitle}>
              {assistant.status === 'archived' ? '恢复助手' : '归档助手'}
            </span>
            <span className={css.assistantSettingsArchiveHint}>
              {assistant.status === 'archived'
                ? '恢复只恢复可用性：助手重新出现在「单聊」列表，主会话、线程与工作区文件都还在原处；归档时被取消的后台任务不会复活。'
                : '归档会立即停用该助手：从「单聊」列表移除、停止主会话与会话线程、取消正在运行的后台任务；记录、日志和工作区文件不会被删除。'}
            </span>
            {confirmArchive && assistant.status !== 'archived' && (
              <span className={css.assistantSettingsArchiveWarning} role="alert">
                再次点击「确认归档」完成归档。
              </span>
            )}
          </div>
          {assistant.status === 'archived'
            ? (
              <button
                type="button"
                className={css.dangerButton}
                disabled={busy}
                onClick={() => { void restore() }}
              >
                {restoring ? '恢复中…' : '恢复助手'}
              </button>
            )
            : (
              <button
                type="button"
                className={`${css.dangerButton} ${css.confirmDangerButton} ${confirmArchive ? css.assistantSettingsArchiveConfirm : ''}`}
                disabled={busy}
                onClick={() => { void archive() }}
              >
                {archiving ? '归档中…' : confirmArchive ? '确认归档' : '归档助手'}
              </button>
            )}
        </div>
        {teamConflict !== undefined && (
          <div className={css.assistantSettingsArchive} data-dsh-assistant-team-conflict={teamConflict.kind}>
            <div className={css.assistantSettingsArchiveCopy}>
              <span className={css.assistantSettingsArchiveWarning} role="alert">
                {teamConflict.message}
              </span>
              <span className={css.assistantSettingsArchiveHint}>
                {teamConflict.kind === 'archive'
                  ? '两条出口：先到团队页把该成员移除（或归档那个团队）后再归档；或者强制归档，团队侧的关联会被标记为已失效。'
                  : '两条出口：先恢复那个团队后再恢复助手；或者强制恢复，助手以未关联身份回来，失效的关联会被清除。'}
              </span>
            </div>
            <span className={css.assistantSettingsArchiveActions}>
              <button
                type="button"
                className={css.dangerButton}
                disabled={busy}
                onClick={() => {
                  setTeamConflict(undefined)
                  setError(undefined)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={`${css.dangerButton} ${css.confirmDangerButton}`}
                data-dsh-assistant-team-conflict-force
                disabled={busy}
                onClick={() => {
                  void (teamConflict.kind === 'archive' ? archive(true) : restore(true))
                }}
              >
                {archiving || restoring
                  ? '处理中…'
                  : teamConflict.kind === 'archive' ? '强制归档' : '强制恢复'}
              </button>
            </span>
          </div>
        )}
      </section>

      {/* The one new-relationship path: the existing checkpoint handoff. It
          retires the old main Session into the history list and binds a fresh
          one; this pane never archives the main Session. */}
      <AssistantCheckpointDialog
        open={checkpointOpen}
        assistant={assistant}
        onClose={() => { setCheckpointOpen(false) }}
        openSession={sessionId => {
          if (!openAssistantSession(sessionId)) {
            setError('暂时打不开新会话：会话界面还没就绪')
          }
        }}
      />
    </div>
  )
}

interface InstancesState {
  instances: AssistantInstanceView[]
  loading: boolean
  error?: string
}

/** Read the one row this pane shows through the existing list transport. */
function useAssistantInstances(enabled: boolean): InstancesState & { refresh: () => void } {
  const [state, setState] = useState<InstancesState>({ instances: [], loading: enabled })
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => { setNonce(value => value + 1) }, [])
  useEffect(() => {
    if (!enabled) {
      setState({ instances: [], loading: false })
      return
    }
    let live = true
    const read = (): void => {
      void callAgentTeam('assistant.instance.list').then(
        value => { if (live) setState({ instances: value.items, loading: false }) },
        cause => {
          if (!live) return
          setState({
            instances: [],
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        },
      )
    }
    setState({ instances: [], loading: true })
    read()
    const unsubscribe = subscribeAgentTeam(read, () => {}, read)
    return () => {
      live = false
      unsubscribe()
    }
  }, [enabled, nonce])
  return { ...state, refresh }
}

/**
 * The pane body. The identity it shows comes from the open action's module
 * state (injected by the host registration), never from the sidebar's current
 * selection, so opening helper B then A leaves no stale row behind.
 */
export function AssistantDetailBody(
  props: PropsRuntime<'sidebar.right.pane.tab'>,
): JSX.Element {
  const { useTabInfo } = props
  const { sidebar } = useTabInfo()
  const state = (props as unknown as { state: AssistantDetailTarget }).state
  const assistantId = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getServerSnapshot)
  const { instances, loading, error, refresh } = useAssistantInstances(assistantId !== undefined)
  const instance = instances.find(candidate => candidate.id === assistantId)
  const notice = error !== undefined
    ? `助手数据加载失败：${error}`
    : loading
      ? '正在加载助手…'
      : DETAIL_EMPTY_TEXT
  return (
    <AssistantDetailPanel
      {...(instance === undefined ? {} : { instance })}
      notice={instance === undefined ? notice : undefined}
      expanded={sidebar.expanded}
      onRefresh={refresh}
    />
  )
}

/** The pane shell: the empty instruction, or the settings of the open helper. */
export function AssistantDetailPanel({
  instance,
  notice,
  expanded,
  onRefresh,
}: {
  instance?: AssistantInstanceView | undefined
  notice?: string | undefined
  expanded?: boolean | undefined
  onRefresh?: (() => void) | undefined
}): JSX.Element {
  if (instance === undefined) {
    return (
      <div
        className={css.assistantDetail}
        data-dsh-assistant-detail
        data-dsh-assistant-detail-empty
        data-expanded={expanded}
      >
        <p className={css.assistantDetailEmpty} role="status">{notice ?? DETAIL_EMPTY_TEXT}</p>
      </div>
    )
  }
  return (
    <AssistantSettingsPane
      key={instance.id}
      assistant={instance}
      expanded={expanded}
      onSaved={() => { onRefresh?.() }}
    />
  )
}

/** The services the host listener needs; the host's face, narrowed to two reads. */
export interface DetailSidebar {
  mounted: { getSnapshot(): string | undefined }
  openTab(kind: string): void
}

/**
 * Point the pane at one helper and open its tab — the host side of the row
 * menu's event. Every write throws while no Session surface is mounted, so the
 * mounted guard runs first and the caller can report the refusal.
 */
export function applyAssistantDetail(
  sidebar: DetailSidebar | undefined,
  assistantId: string,
): boolean {
  assistantDetailTarget.set(assistantId)
  if (sidebar === undefined || sidebar.mounted.getSnapshot() === undefined) return false
  try {
    sidebar.openTab(DETAIL_TAB_KIND)
    return true
  } catch {
    return false
  }
}

/**
 * The row menu's half: publish the target, let the host listener own the layout
 * write. No service handle travels through the component tree.
 */
export function openAssistantDetail(assistantId: string): void {
  assistantDetailTarget.set(assistantId)
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_SETTINGS_EVENT, {
    detail: { assistantId },
  }))
}
