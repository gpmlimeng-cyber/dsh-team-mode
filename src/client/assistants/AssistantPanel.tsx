import type { FormEvent } from 'react'
import { BUILTIN_ASSISTANT_AVATARS } from '../assistant-avatars.js'
import { MemberAvatar } from '../member-avatar.js'

const DICEBEAR_STYLES = [
  { id: 'bottts', label: '机器人' },
  { id: 'cameo', label: '浮雕' },
  { id: 'clay', label: '黏土' },
  { id: 'critters', label: '小动物' },
  { id: 'gaze', label: '凝视' },
  { id: 'moods', label: '情绪' },
  { id: 'thumbs', label: '点赞' },
] as const


function dicebearUrl(style: string, seed: string): string {
  return `https://api.dicebear.com/10.x/${style}/svg?seed=${encodeURIComponent(seed)}&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`
}
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  IconArchiveOutlineMedium,
  IconPlusOutlineRegular,
  IconSendOutlineRegular,
  IconStopFillRegular,
  MarkdownText,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantBuilderConversationListView,
  AssistantBuilderConversationSummary,
  AssistantBuilderConversationView,
  AssistantBuilderDraftView,
  AssistantView,
  CatalogView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAssistantBuilderConversation } from '../api.js'
import { CapabilityPicker, savableNames, useCapabilityCatalog } from '../assistant-capabilities.js'
import { assistantModelKey } from '../assistant-form.js'
import { SelectControl } from '../select-control.js'
import css from '../AgentTeam.module.css'
import { shouldSubmitComposer } from '../keyboard.js'
import { PERMISSION_LABELS } from '../labels.js'
import { MARKDOWN_LABELS } from '../markdown-labels.js'
import { defaultReasoningLabel, useModelCapabilities } from '../model-reasoning.js'
import { AnimatedModal, Empty, Field } from '../shared.js'
import { ConversationNodeView } from '../workbench/ConversationColumn.js'
import { PendingInteractionCard } from '../workbench/PendingInteractionCard.js'
import conversationCss from '../workbench/ConversationColumn.module.css'

const ASSISTANT_FORM_ID = 'dsh-team-mode-assistant-form'
const ASSISTANT_EDIT_FORM_ID = 'dsh-team-mode-assistant-edit-form'

export function AssistantPanel({
  catalog,
  assistants,
  onChanged,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  onChanged: () => Promise<void>
}): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [editingAssistant, setEditingAssistant] = useState<AssistantView>()
  const [builderOpen, setBuilderOpen] = useState(false)
  const [assistantSaving, setAssistantSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string>()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleAssistants = normalizedQuery === ''
    ? assistants
    : assistants.filter(assistant =>
        assistant.name.toLocaleLowerCase().includes(normalizedQuery)
        || (assistant.description ?? '').toLocaleLowerCase().includes(normalizedQuery))
  const enabledCount = assistants.filter(assistant => assistant.enabled).length

  /** Persist the whole visible order so legacy ties (sortOrder 0) become distinct. */
  async function move(assistant: AssistantView, delta: number): Promise<void> {
    if (moving) return
    const index = assistants.findIndex(item => item.id === assistant.id)
    const targetIndex = index + delta
    if (index < 0 || targetIndex < 0 || targetIndex >= assistants.length) return
    const reordered = [...assistants]
    const [item] = reordered.splice(index, 1)
    if (item === undefined) return
    reordered.splice(targetIndex, 0, item)
    setMoving(true)
    setMoveError(undefined)
    try {
      for (const [position, entry] of reordered.entries()) {
        if (entry.sortOrder === position) continue
        await callAgentTeam('assistant.update', { id: entry.id, value: { sortOrder: position } }, entry.revision)
      }
      await onChanged()
    } catch (cause) {
      setMoveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMoving(false)
    }
  }
  return (
    <section className={css.section}>
      <div className={css.sectionHeader}>
        <div>
          <h2 className={css.sectionHeading}>助手模板 <span className={css.count}>{assistants.length}</span></h2>
          <p className={css.sectionDescription}>
            可复用的角色模板；已启用 {enabledCount} 个，且只有启用并允许加入团队的助手会出现在选人列表。
          </p>
        </div>
        <div className={css.sectionHeaderActions}>
          <input
            value={query}
            onChange={event => { setQuery(event.target.value) }}
            className={css.input}
            placeholder="按名称或描述搜索助手"
            aria-label="按名称或描述搜索助手"
          />
          <Button variant="primary" onClick={() => { setCreating(true) }}>手动新建</Button>
        </div>
      </div>
      {moveError && <div role="alert" className={css.inlineError}>{moveError}</div>}
      <article className={css.assistantBuilderCard}>
        <div className={css.assistantBuilderAvatar} aria-hidden="true">AI</div>
        <div className={css.assistantBuilderCopy}>
          <span className={css.assistantBuilderEyebrow}>内置 · 默认</span>
          <strong>团队 Agent 小助手</strong>
          <p>描述你需要的角色，它会询问必要参数、整理长期提示词，并在确认后创建助手。</p>
        </div>
        <Button variant="primary" onClick={() => { setBuilderOpen(true) }}>开始对话</Button>
      </article>
      {assistants.length === 0
        ? <Empty text="还没有助手模板" hint="创建助手后，就可以把它作为 Leader 或普通成员加入不同团队。" />
        : visibleAssistants.length === 0
          ? <Empty text="没有匹配的助手" hint="换个关键词，或清空搜索。" />
          : (
              <div className={css.cardGrid}>
                {visibleAssistants.map(assistant => {
                  const index = assistants.findIndex(item => item.id === assistant.id)
                  return (
                    <AssistantCard
                      key={assistant.id}
                      assistant={assistant}
                      onEdit={() => { setEditingAssistant(assistant) }}
                      onChanged={onChanged}
                      reorderEnabled={normalizedQuery === '' && !moving}
                      canMoveUp={index > 0}
                      canMoveDown={index >= 0 && index < assistants.length - 1}
                      onMoveUp={() => { void move(assistant, -1) }}
                      onMoveDown={() => { void move(assistant, 1) }}
                    />
                  )
                })}
              </div>
            )}
      <AnimatedModal
        open={builderOpen}
        onClose={() => { setBuilderOpen(false) }}
        title="团队 Agent 小助手"
        closeLabel="关闭"
        description="通过对话设计助手，完整配置会在你确认后保存到助手模板库。"
        className={css.assistantBuilderDialog ?? ''}
        contentClassName={css.assistantBuilderDialogContent ?? ''}
      >
        {builderOpen && <AssistantBuilderConversation catalog={catalog} />}
      </AnimatedModal>
      <AnimatedModal
        open={creating}
        onClose={() => { setCreating(false) }}
        title="新建助手"
        closeLabel="关闭"
        description="配置可复用的模型、权限与长期规则。具体任务在团队启动后发送。"
        className={css.assistantDialog ?? ''}
        contentClassName={css.modalScrollContent ?? ''}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCreating(false) }} disabled={assistantSaving}>取消</Button>
            <Button
              variant="primary"
              type="submit"
              form={ASSISTANT_FORM_ID}
              disabled={assistantSaving}
            >
              {assistantSaving ? '保存中…' : '保存助手'}
            </Button>
          </>
        )}
      >
        <AssistantForm
          catalog={catalog}
          formId={ASSISTANT_FORM_ID}
          saving={assistantSaving}
          setSaving={setAssistantSaving}
          onSaved={async () => { setCreating(false); await onChanged() }}
        />
      </AnimatedModal>
      <AnimatedModal
        open={editingAssistant !== undefined}
        onClose={() => { setEditingAssistant(undefined) }}
        title="编辑助手"
        closeLabel="关闭"
        description="更新助手模板只影响之后启动的团队成员，不修改已有成员快照。"
        className={css.assistantDialog ?? ''}
        contentClassName={css.modalScrollContent ?? ''}
        footer={editingAssistant === undefined
          ? undefined
          : (
              <>
                <Button variant="outline" onClick={() => { setEditingAssistant(undefined) }} disabled={assistantSaving}>取消</Button>
                <Button
                  variant="primary"
                  type="submit"
                  form={ASSISTANT_EDIT_FORM_ID}
                  disabled={assistantSaving}
                >
                  {assistantSaving ? '保存中…' : '保存修改'}
                </Button>
              </>
            )}
      >
        {editingAssistant !== undefined && (
          <AssistantForm
            key={`${editingAssistant.id}:${editingAssistant.revision}`}
            catalog={catalog}
            formId={ASSISTANT_EDIT_FORM_ID}
            assistant={editingAssistant}
            saving={assistantSaving}
            setSaving={setAssistantSaving}
            onSaved={async () => { setEditingAssistant(undefined); await onChanged() }}
          />
        )}
      </AnimatedModal>
    </section>
  )
}

function AssistantBuilderConversation({ catalog }: { catalog: CatalogView | undefined }): JSX.Element {
  const [conversation, setConversation] = useState<AssistantBuilderConversationView>()
  const [draft, setDraft] = useState<AssistantBuilderDraftView>()
  const [history, setHistory] = useState<AssistantBuilderConversationSummary[]>([])
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [applyingModel, setApplyingModel] = useState(false)
  const [archivingSessionId, setArchivingSessionId] = useState<string>()
  const [archiveCandidate, setArchiveCandidate] = useState<AssistantBuilderConversationSummary>()
  const [archiveError, setArchiveError] = useState<string>()
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [modelSelectionDirty, setModelSelectionDirty] = useState(false)
  const [error, setError] = useState<string>()
  const timeline = useRef<HTMLDivElement>(null)
  const drafting = useRef(false)
  const composing = useRef(false)
  const sendInFlight = useRef(false)

  const loadHistory = useCallback(async (): Promise<AssistantBuilderConversationListView> => {
    const next = await callAgentTeam('assistant.builder.list')
    setHistory(next.items)
    return next
  }, [])

  const load = useCallback(async (sessionId?: string) => {
    try {
      if (sessionId !== undefined) {
        const next = await callAgentTeam('assistant.builder.get', { sessionId })
        setConversation(next)
        setDraft(undefined)
        drafting.current = false
        await loadHistory()
      } else {
        const nextHistory = await loadHistory()
        const latest = nextHistory.items[0]
        if (latest !== undefined) {
          const next = await callAgentTeam('assistant.builder.get', {
            sessionId: latest.sessionId,
          })
          setConversation(next)
          setDraft(undefined)
          drafting.current = false
        } else {
          const next = await callAgentTeam('assistant.builder.draft.get')
          setConversation(undefined)
          setDraft(next)
          drafting.current = true
        }
      }
      setModelSelectionDirty(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [loadHistory])

  useEffect(() => {
    void load()
    return subscribeAssistantBuilderConversation(next => {
      if (next !== undefined) {
        setConversation(current => {
          if (current?.sessionId !== next.sessionId) return current
          if (current.status === 'running' && next.status === 'idle') void loadHistory()
          return next
        })
      }
      else if (drafting.current) void loadHistory()
      else void load()
      setError(undefined)
    }, () => {
      setError('实时连接已断开，正在等待重连')
    }, () => {
      setError(undefined)
      if (drafting.current) void loadHistory()
      else void load()
    })
  }, [load, loadHistory])

  useEffect(() => {
    const configuration = conversation?.configuration ?? draft?.configuration
    if (configuration === undefined || modelSelectionDirty) return
    setSelectedProvider(configuration.provider)
    setSelectedModel(configuration.model)
  }, [conversation, draft, modelSelectionDirty])

  useEffect(() => {
    const element = timeline.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [conversation?.throughSeq, conversation?.nodes.length, conversation?.pendingInteractions.length])

  async function send(): Promise<void> {
    const message = content.trim()
    if (
      message.length === 0
      || !selectedProvider
      || !selectedModel
      || sendInFlight.current
      || (conversation === undefined && draft === undefined)
      || conversation?.status === 'running'
    ) return
    sendInFlight.current = true
    setSending(true)
    try {
      if (conversation === undefined) {
        const next = await callAgentTeam('assistant.builder.start', {
          provider: selectedProvider,
          model: selectedModel,
          content: message,
        })
        setConversation(next)
        setDraft(undefined)
        drafting.current = false
        setModelSelectionDirty(false)
      } else {
        await callAgentTeam('assistant.builder.send', {
          sessionId: conversation.sessionId,
          content: message,
        })
      }
      setContent('')
      await loadHistory()
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sendInFlight.current = false
      setSending(false)
    }
  }

  async function stop(): Promise<void> {
    if (conversation === undefined) return
    try {
      await callAgentTeam('assistant.builder.stop', { sessionId: conversation.sessionId })
      await load(conversation.sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function applyModel(): Promise<void> {
    if (!selectedProvider || !selectedModel || applyingModel || (conversation === undefined && draft === undefined) || conversation?.status === 'running') return
    setApplyingModel(true)
    try {
      if (conversation === undefined) {
        const next = await callAgentTeam('assistant.builder.draft.configure', {
          provider: selectedProvider,
          model: selectedModel,
        })
        setDraft(next)
      } else {
        const next = await callAgentTeam('assistant.builder.configure', {
          sessionId: conversation.sessionId,
          provider: selectedProvider,
          model: selectedModel,
        })
        setConversation(next)
      }
      setModelSelectionDirty(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setApplyingModel(false)
    }
  }

  async function createDraft(): Promise<void> {
    if (running || loading || draft !== undefined) return
    setLoading(true)
    try {
      const next = await callAgentTeam('assistant.builder.draft.get')
      setConversation(undefined)
      setDraft(next)
      drafting.current = true
      setContent('')
      setModelSelectionDirty(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function selectConversation(sessionId: string): Promise<void> {
    if (running || loading || sessionId === conversation?.sessionId) return
    setLoading(true)
    setContent('')
    setDraft(undefined)
    drafting.current = false
    await load(sessionId)
  }

  async function archiveConversation(): Promise<void> {
    const item = archiveCandidate
    if (item === undefined || loading || archivingSessionId !== undefined) return
    setArchivingSessionId(item.sessionId)
    setArchiveError(undefined)
    try {
      await callAgentTeam('assistant.builder.archive', { sessionId: item.sessionId })
      setContent('')
      if (item.sessionId === conversation?.sessionId) {
        setConversation(undefined)
        setLoading(true)
        await load()
      } else {
        await loadHistory()
      }
      setArchiveCandidate(undefined)
      setError(undefined)
    } catch (cause) {
      setArchiveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setArchivingSessionId(undefined)
      setLoading(false)
    }
  }

  const running = conversation?.status === 'running'
  const pendingInteractions = conversation?.pendingInteractions ?? []
  const runtimeLabel = pendingInteractions.some(interaction => interaction.kind === 'approval')
    ? '等待审批'
    : pendingInteractions.length > 0
      ? '等待回答'
      : loading
        ? '正在启动…'
        : running
          ? '正在思考'
          : '可以对话'
  const providers = catalog?.providers ?? []
  const modelSelection = JSON.stringify([selectedProvider, selectedModel])
  const appliedConfiguration = conversation?.configuration ?? draft?.configuration
  const modelChanged = appliedConfiguration !== undefined && (
    selectedProvider !== appliedConfiguration.provider
    || selectedModel !== appliedConfiguration.model
  )
  return (
    <>
      <section className={css.assistantBuilderConversation}>
      <aside className={css.assistantBuilderHistory}>
        <button
          type="button"
          className={css.assistantBuilderNewConversation}
          disabled={loading || running || draft !== undefined}
          onClick={() => { void createDraft() }}
        >
          <IconPlusOutlineRegular size={14} />
          <span>新对话</span>
        </button>
        <div className={css.assistantBuilderHistoryList}>
          {history.map(item => (
            <div key={item.sessionId} className={css.assistantBuilderHistoryRow}>
              <button
                type="button"
                className={`${css.assistantBuilderHistoryItem} ${item.sessionId === conversation?.sessionId ? css.assistantBuilderHistoryItemActive : ''}`}
                disabled={loading || running || archivingSessionId !== undefined}
                onClick={() => { void selectConversation(item.sessionId) }}
              >
                <strong>{item.title}</strong>
                <span>
                  <time dateTime={item.updatedAt}>{formatConversationTime(item.updatedAt)}</time>
                  <em>{assistantBuilderStateLabel(item.state)}</em>
                </span>
              </button>
              <Tooltip label="归档会话" side="right" delayMs={400}>
                <button
                  type="button"
                  className={css.assistantBuilderHistoryArchive}
                  aria-label={`归档会话 ${item.title}`}
                  disabled={loading || archivingSessionId !== undefined || (running && item.sessionId === conversation?.sessionId)}
                  onClick={() => {
                    setArchiveError(undefined)
                    setArchiveCandidate(item)
                  }}
                >
                  <IconArchiveOutlineMedium size={14} />
                </button>
              </Tooltip>
            </div>
          ))}
          {!loading && history.length === 0 && <span className={css.assistantBuilderHistoryEmpty}>暂无历史对话</span>}
        </div>
      </aside>
      <div className={css.assistantBuilderMain}>
        <div className={css.assistantBuilderRuntime}>
        <span className={css.assistantBuilderRuntimeState}>
          <span className={`${css.statusDot} ${running ? css.statusRunning : css.statusIdle}`} aria-hidden="true" />
          <span>{runtimeLabel}</span>
        </span>
        <div className={css.assistantBuilderModelControls}>
          <SelectControl
            ariaLabel="小助手模型目录"
            value={modelSelection}
            options={providers.flatMap(provider => (
              (catalog?.models[provider.id] ?? []).map(model => ({
                value: assistantModelKey(provider.id, model.id),
                label: model.name === model.id ? model.id : `${model.name}（${model.id}）`,
                group: provider.name,
              }))
            ))}
            align="end"
            disabled={loading || running || applyingModel}
            onChange={next => {
              const at = next.indexOf('/')
              setSelectedProvider(at < 0 ? next : next.slice(0, at))
              setSelectedModel(at < 0 ? '' : next.slice(at + 1))
              setModelSelectionDirty(true)
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!modelChanged || !selectedProvider || !selectedModel || loading || running || applyingModel}
            onClick={() => { void applyModel() }}
          >
            {applyingModel ? '切换中…' : '应用模型'}
          </Button>
        </div>
        </div>
        <div ref={timeline} className={`${conversationCss.timeline} ${css.assistantBuilderTimeline}`}>
        {!loading && (draft !== undefined || conversation?.nodes.length === 0) && (
          <article className={`${conversationCss.messageNode} ${conversationCss.assistantMessage}`}>
            <div className={conversationCss.messageText}>
              <MarkdownText
                text="你好，我是团队 Agent 小助手。告诉我你想创建什么样的助手，以及它主要负责什么；缺少的配置我会逐项询问你。"
                labels={MARKDOWN_LABELS}
              />
            </div>
          </article>
        )}
        {conversation?.nodes.map(node => <ConversationNodeView key={node.id} node={node} />)}
        {pendingInteractions.map(interaction => (
          <PendingInteractionCard
            key={interaction.id}
            interaction={interaction}
            onRespond={async response => {
              if (conversation === undefined) return
              await callAgentTeam('assistant.builder.interaction.respond', {
                sessionId: conversation.sessionId,
                interactionId: interaction.id,
                response,
              })
            }}
          />
        ))}
        </div>
        <form
        className={`${conversationCss.composer} ${css.assistantBuilderComposer}`}
        onSubmit={event => { event.preventDefault(); void send() }}
      >
        <textarea
          value={content}
          onChange={event => { setContent(event.target.value) }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => {
            if (!shouldSubmitComposer({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.nativeEvent.keyCode,
            }, composing.current)) return
            event.preventDefault()
            void send()
          }}
          placeholder={running ? '小助手正在回复…' : '例如：我需要一个负责 React 前端开发和代码审查的助手'}
          disabled={loading || running}
          rows={3}
        />
        <div className={conversationCss.composerFooter}>
          <span className={css.muted}>Enter 发送 · Shift+Enter 换行</span>
          <div className={conversationCss.composerActions}>
            {running && (
              <Tooltip label="停止生成" side="top" delayMs={400}>
                <button type="button" className={conversationCss.composerIconButton} onClick={() => { void stop() }} aria-label="停止生成">
                  <IconStopFillRegular size={16} />
                </button>
              </Tooltip>
            )}
            <Tooltip label={sending ? '发送中…' : '发送消息'} side="top" delayMs={400}>
              <button
                type="submit"
                className={conversationCss.composerIconButton}
                disabled={loading || running || sending || !selectedProvider || !selectedModel || content.trim().length === 0}
                aria-label={sending ? '发送中' : '发送消息'}
              >
                <IconSendOutlineRegular size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
        {error && <span className={conversationCss.composerError}>{error}</span>}
        </form>
      </div>
      </section>
      <AnimatedModal
        open={archiveCandidate !== undefined}
        onClose={() => {
          if (archivingSessionId === undefined) {
            setArchiveCandidate(undefined)
            setArchiveError(undefined)
          }
        }}
        title="归档会话"
        closeLabel="关闭"
        description="归档后，该会话将不再显示在团队 Agent 小助手的历史记录中。"
        className={css.assistantBuilderArchiveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={archivingSessionId !== undefined}
              onClick={() => {
                setArchiveCandidate(undefined)
                setArchiveError(undefined)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={archiveCandidate === undefined || archivingSessionId !== undefined}
              onClick={() => { void archiveConversation() }}
            >
              {archivingSessionId !== undefined ? '归档中…' : '确认归档'}
            </Button>
          </>
        )}
      >
        {archiveCandidate !== undefined && (
          <div className={css.assistantBuilderArchiveConfirm}>
            <div className={css.assistantBuilderArchiveIcon} aria-hidden="true">
              <IconArchiveOutlineMedium size={20} />
            </div>
            <div>
              <strong>{archiveCandidate.title}</strong>
              <p>会话内容不会被删除，底层 Session 日志仍由 Harness 保留。</p>
            </div>
            {archiveError && <div role="alert" className={css.inlineError}>{archiveError}</div>}
          </div>
        )}
      </AnimatedModal>
    </>
  )
}

function assistantBuilderStateLabel(state: AssistantBuilderConversationSummary['state']): string {
  if (state === 'completed') return '已创建'
  if (state === 'in_progress') return '配置中'
  return '新对话'
}

function formatConversationTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function AssistantCard({
  assistant,
  onEdit,
  onChanged,
  reorderEnabled,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  assistant: AssistantView
  onEdit: () => void
  onChanged: () => Promise<void>
  reorderEnabled: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [deleteOpen, setDeleteOpen] = useState(false)

  async function clone(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('assistant.clone', { id: assistant.id, name: `${assistant.name} Copy` })
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('assistant.delete', { id: assistant.id })
      setDeleteOpen(false)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function toggleEnabled(next: boolean): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('assistant.update', { id: assistant.id, value: { enabled: next } }, assistant.revision)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <article className={css.card}>
        <div
          className={css.assistantCardContent}
          role="button"
          tabIndex={busy ? -1 : 0}
          aria-label={`编辑助手 ${assistant.name}`}
          onClick={() => { if (!busy) onEdit() }}
          onKeyDown={event => {
            if (busy || (event.key !== 'Enter' && event.key !== ' ')) return
            event.preventDefault()
            onEdit()
          }}
        >
          {assistant.avatar !== undefined && assistant.avatar !== ''
            ? <img className={css.assistantAvatar} src={assistant.avatar} alt="" />
            : null}
          <strong>{assistant.name}</strong>
          {(!assistant.enabled || !assistant.teamSelectable || assistant.source !== 'user') && (
            <div className={css.assistantCardBadges}>
              {!assistant.enabled && <span className={css.assistantBadge}>已停用</span>}
              {assistant.enabled && !assistant.teamSelectable && <span className={css.assistantBadge}>仅单聊</span>}
              {assistant.source !== 'user' && (
                <span className={css.assistantBadge}>{assistant.source === 'generated' ? 'AI 生成' : '内置'}</span>
              )}
            </div>
          )}
          <span className={css.assistantCardModel} title={`${assistant.provider} / ${assistant.model}`}>
            {assistant.provider} / {assistant.model}
          </span>
          <span className={css.assistantCardMeta}>
            Preset {assistant.agentPresetId} · 权限 {PERMISSION_LABELS[assistant.permissionPresetId] ?? assistant.permissionPresetId} · 思考 {assistant.reasoningEffort ?? '模型默认'}
          </span>
          <span
            className={css.assistantCardMeta}
            title={`Skills: ${assistant.skillAllowlist.join('、') || '未选择'}；MCP: ${assistant.mcpServers.join('、') || '未选择'}`}
          >
            Skills {assistant.skillAllowlist.length} · MCP {assistant.mcpServers.length} · 提示词 {assistant.prompts.length}
          </span>
          {assistant.description && <p className={css.description}>{assistant.description}</p>}
        </div>
        <div className={css.actions}>
          <label className={css.muted}>
            <input
              type="checkbox"
              checked={assistant.enabled}
              disabled={busy}
              onChange={event => { void toggleEnabled(event.target.checked) }}
            />
            {' '}启用
          </label>
          <button
            type="button"
            className={css.assistantIconButton}
            disabled={busy || !reorderEnabled || !canMoveUp}
            aria-label={`上移助手 ${assistant.name}`}
            title="上移"
            onClick={onMoveUp}
          >
            ↑
          </button>
          <button
            type="button"
            className={css.assistantIconButton}
            disabled={busy || !reorderEnabled || !canMoveDown}
            aria-label={`下移助手 ${assistant.name}`}
            title="下移"
            onClick={onMoveDown}
          >
            ↓
          </button>
          <button type="button" className={css.secondaryButton} disabled={busy} onClick={onEdit}>编辑</button>
          <button type="button" className={css.secondaryButton} disabled={busy} onClick={() => { void clone() }}>复制</button>
          <button
            type="button"
            className={css.dangerButton}
            disabled={busy}
            onClick={() => {
              setError(undefined)
              setDeleteOpen(true)
            }}
          >
            删除
          </button>
        </div>
        {error && !deleteOpen && <div role="alert" className={css.inlineError}>{error}</div>}
      </article>
      <AnimatedModal
        open={deleteOpen}
        onClose={() => {
          if (busy) return
          setDeleteOpen(false)
          setError(undefined)
        }}
        title="删除助手模板"
        closeLabel="关闭"
        description="此操作无法撤销。"
        className={css.assistantDeleteDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDeleteOpen(false)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void remove() }}
            >
              {busy ? '删除中…' : '确认删除'}
            </button>
          </>
        )}
      >
        <div className={css.assistantDeleteConfirm}>
          <div className={css.assistantDeleteIcon} aria-hidden="true">
            {assistant.name.slice(0, 1).toLocaleUpperCase()}
          </div>
          <div>
            <strong>{assistant.name}</strong>
            <p>删除后不会影响团队或 Workspace。若模板仍被团队成员引用，系统会拒绝删除。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
    </>
  )
}

function AssistantForm({
  catalog,
  formId,
  assistant,
  saving,
  setSaving,
  onSaved,
}: {
  catalog: CatalogView | undefined
  formId: string
  assistant?: AssistantView
  saving: boolean
  setSaving: (saving: boolean) => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const providers = catalog?.providers ?? []
  const presets = catalog?.agentPresets.filter(preset => preset.broken === undefined) ?? []
  const permissions = catalog?.permissionPresets ?? []
  const [name, setName] = useState(assistant?.name ?? '')
  const [avatar, setAvatar] = useState(assistant?.avatar ?? '')
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [draftAvatar, setDraftAvatar] = useState('')
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false)
  const avatarScrollRef = useRef<HTMLDivElement>(null)
  const [description, setDescription] = useState(assistant?.description ?? '')
  const [instructions, setInstructions] = useState(assistant?.instructions ?? '')
  const [promptsText, setPromptsText] = useState((assistant?.prompts ?? []).join('\n'))
  const providerHasModels = (id: string): boolean => (catalog?.models[id]?.length ?? 0) > 0
  const preferredProvider = providers.find(entry => providerHasModels(entry.id))?.id ?? providers[0]?.id ?? ''
  const [provider, setProvider] = useState(assistant?.provider ?? preferredProvider)
  const models = catalog?.models[provider] ?? []
  const [modelChoice, setModelChoice] = useState(assistant?.model ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(assistant?.reasoningEffort ?? '')
  const [agentPresetId, setAgentPresetId] = useState(assistant?.agentPresetId ?? presets[0]?.id ?? '')
  const [permissionPresetId, setPermissionPresetId] = useState(assistant?.permissionPresetId ?? permissions[0]?.value ?? '')
  const [enabled, setEnabled] = useState(assistant?.enabled ?? true)
  const [teamSelectable, setTeamSelectable] = useState(assistant?.teamSelectable ?? true)
  const [selectedSkills, setSelectedSkills] = useState<string[]>(assistant?.skillAllowlist ?? [])
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>(assistant?.mcpServers ?? [])
  const [error, setError] = useState<string>()
  const modelCapabilities = useModelCapabilities(provider, modelChoice)
  // One capability reader for the whole plugin: the same widget and the same
  // "a lost entry stays visible instead of vanishing" rule as the dialogs.
  const capabilities = useCapabilityCatalog(agentPresetId)

  useEffect(() => {
    // New templates default to a provider that actually lists models; an
    // existing template keeps its recorded provider even if the catalog is empty.
    if (assistant === undefined && (!provider || !providerHasModels(provider))) {
      const next = providers.find(entry => providerHasModels(entry.id))?.id ?? providers[0]?.id ?? ''
      if (next !== '' && next !== provider) setProvider(next)
    }
    if (!agentPresetId && presets[0]) setAgentPresetId(presets[0].id)
    if (!permissionPresetId && permissions[0]) setPermissionPresetId(permissions[0].value)
  }, [agentPresetId, catalog, permissionPresetId, permissions, presets, provider, providers])
  useEffect(() => {
    setModelChoice(current => {
      if (models.some(candidate => candidate.id === current)) return current
      return models[0]?.id ?? ''
    })
  }, [models])
  useEffect(() => {
    if (modelCapabilities.loading || modelCapabilities.value === undefined) return
    const efforts = modelCapabilities.value.reasoning?.efforts ?? []
    setReasoningEffort(current => current && !efforts.some(effort => effort.id === current) ? '' : current)
  }, [modelCapabilities.loading, modelCapabilities.value])

  const model = modelChoice

  function readAvatar(file: File): void {
    if (!file.type.startsWith('image/')) {
      setError('请选择 PNG、JPEG 或 WebP 图片')
      return
    }
    if (file.size > 256 * 1024) {
      setError('头像图片不能超过 256KB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setDraftAvatar(reader.result)
        setError(undefined)
      }
    }
    reader.readAsDataURL(file)
  }

  useEffect(() => {
    if (!avatarPickerOpen) return
    const frame = requestAnimationFrame(() => {
      avatarScrollRef.current?.scrollTo({ top: 0 })
    })
    return () => { cancelAnimationFrame(frame) }
  }, [avatarPickerOpen])

  useEffect(() => {
    if (avatarPickerOpen) setDraftAvatar(avatar)
  }, [avatarPickerOpen])

  async function applyGeneratedAvatar(style: string, seed: string): Promise<void> {
    if (pickingAvatar) return
    setPickingAvatar(true)
    setError(undefined)
    try {
      const response = await fetch(dicebearUrl(style, seed))
      if (!response.ok) throw new Error(`头像服务返回 ${response.status}`)
      const svg = await response.text()
      setDraftAvatar(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPickingAvatar(false)
    }
  }

  function randomizeAvatar(): void {
    const style = DICEBEAR_STYLES[Math.floor(Math.random() * DICEBEAR_STYLES.length)]
    if (style === undefined) return
    void applyGeneratedAvatar(style.id, `${name.trim() || 'assistant'}-${Date.now().toString(36)}`)
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const value = {
        name,
        avatar,
        ...(assistant === undefined && !description.trim()
          ? {}
          : { description: description.trim() }),
        instructions,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        agentPresetId,
        permissionPresetId,
        // Rows the preset no longer offers stay visible but are not written:
        // the picker says so, and the service would refuse the MCP ones.
        skillAllowlist: capabilities.loaded
          ? savableNames(selectedSkills, capabilities.skills)
          : selectedSkills,
        mcpServers: capabilities.loaded
          ? savableNames(selectedMcpServers, capabilities.mcpServers)
          : selectedMcpServers,
        enabled,
        teamSelectable,
        prompts: promptsText.split('\n').map(line => line.trim()).filter(Boolean),
      }
      if (assistant === undefined) {
        await callAgentTeam('assistant.create', value)
      } else {
        await callAgentTeam('assistant.update', { id: assistant.id, value }, assistant.revision)
      }
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form id={formId} onSubmit={(event) => { void submit(event) }} className={`${css.form} ${css.assistantForm}`}>
      <div className={css.assistantFormSection}>
        <div className={css.assistantFormSectionHeading}>
          <strong>身份</strong>
          <span className={css.assistantFormSectionHint}>改动立即生效</span>
        </div>
        <div className={css.assistantIdentityGrid}>
          <div className={css.assistantIdentityAvatar}>
            <MemberAvatar name={name.trim() || '助手'} avatar={avatar !== '' ? avatar : undefined} size={48} />
            <button type="button" className={css.assistantAvatarButton} onClick={() => { setDraftAvatar(avatar); setAvatarPickerOpen(true) }}>
              {avatar === '' ? '上传图片' : '更换图片'}
            </button>
            {avatar !== '' && (
              <button type="button" className={css.assistantRemoveAvatar} onClick={() => { setAvatar('') }}>
                移除
              </button>
            )}
          </div>
          <div className={css.assistantIdentityFields}>
            <label className={css.assistantInlineField}>
              <span className={css.assistantInlineLabel}><span className={css.assistantRequired} aria-hidden="true">*</span> 名称</span>
              <input required value={name} onChange={event => { setName(event.target.value) }} className={css.input} placeholder="请输入助手名称" />
            </label>
            <label className={css.assistantInlineField}>
              <span className={css.assistantInlineLabel}>描述</span>
              <input value={description} onChange={event => { setDescription(event.target.value) }} className={css.input} placeholder="帮你解决什么问题" />
            </label>
          </div>
        </div>
        <div className={css.assistantToggleRow}>
          <label className={css.muted}>
            <input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked) }} />
            {' '}在助手库与选择器中显示
          </label>
          <label className={css.muted}>
            <input type="checkbox" checked={teamSelectable} onChange={event => { setTeamSelectable(event.target.checked) }} />
            {' '}允许被拉入团队（关闭后仅用于单聊）
          </label>
        </div>
      </div>
      <div className={css.assistantFormSection}>
        <div className={css.assistantFormSectionHeading}>
          <strong>推荐提示词</strong>
          <span className={css.assistantFormSectionHint}>改动立即生效</span>
        </div>
        <div className={css.formGrid}>
          <Field label="推荐提示词（可选，每行一条）" className={css.fullWidth ?? ''}>
            <textarea
              value={promptsText}
              onChange={event => { setPromptsText(event.target.value) }}
              rows={3}
              placeholder="例如：帮我梳理需求 / 先读代码再改 / 完成后跑测试"
              className={css.input}
            />
            <span className={css.hint}>成员会话为空时，会把这些建议展示在输入区上方。</span>
          </Field>
        </div>
      </div>
      <div className={css.assistantFormSection}>
        <div className={css.assistantFormSectionHeading}>
          <strong>引擎与默认配置</strong>
          <span className={css.assistantFormSectionHint}>仅对新会话生效</span>
        </div>
        <div className={css.formGrid}>
        <Field label="Provider">
          <SelectControl
            ariaLabel="Provider"
            value={provider}
            placeholder="请选择"
            options={providers.map(item => ({ value: item.id, label: item.name }))}
            onChange={setProvider}
          />
        </Field>
        <Field label={`模型（${models.length} 个可选）`}>
          <SelectControl
            ariaLabel="模型"
            value={modelChoice}
            placeholder="请选择"
            options={models.map(item => ({
              value: item.id,
              label: item.name === item.id ? item.id : `${item.name}（${item.id}）`,
            }))}
            onChange={setModelChoice}
          />
        </Field>
        {modelCapabilities.value?.reasoning !== undefined && modelCapabilities.value.reasoning.efforts.length > 0 && (
          <Field label="思考模式">
            <SelectControl
              ariaLabel="思考模式"
              value={reasoningEffort}
              options={[
                { value: '', label: defaultReasoningLabel(modelCapabilities.value) },
                ...modelCapabilities.value.reasoning.efforts.map(effort => ({
                  value: effort.id,
                  label: effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`,
                })),
              ]}
              onChange={setReasoningEffort}
            />
            <span id={`${formId}-reasoning-hint`} className={css.hint}>由当前 Provider 和模型决定可用档位。</span>
          </Field>
        )}
        {modelCapabilities.error && <span className={conversationCss.composerError}>{modelCapabilities.error}</span>}
        <Field label="Agent Preset">
          <SelectControl
            ariaLabel="Agent Preset"
            value={agentPresetId}
            options={presets.map(item => ({ value: item.id, label: item.name }))}
            onChange={setAgentPresetId}
          />
        </Field>
        <Field label="权限预设">
          <SelectControl
            ariaLabel="权限预设"
            value={permissionPresetId}
            options={permissions.map(item => ({
              value: item.value,
              label: PERMISSION_LABELS[item.value] ?? item.name,
            }))}
            onChange={setPermissionPresetId}
          />
        </Field>
      </div>
      </div>
      <div className={css.assistantFormSection}>
        <div className={css.assistantFormSectionHeading}>
          <strong>规则</strong>
          <span className={css.assistantFormSectionHint}>仅对新会话生效</span>
        </div>
        <div className={css.formGrid}>
        <Field label="助手规则（可选）" className={css.fullWidth ?? ''}>
          <textarea
            value={instructions}
            onChange={event => { setInstructions(event.target.value) }}
            rows={4}
            placeholder="例如：你负责前端实现；遵循现有代码风格；修改前先阅读相关文件；完成后向 Leader 汇报测试结果。"
            className={css.input}
          />
          <span className={css.hint}>随助手模板保存，在成员启动时加入系统提示词；这里不填写具体任务。</span>
        </Field>
      </div>
      </div>
      <div className={css.assistantFormSection}>
        <div className={css.assistantFormSectionHeading}>
          <strong>可用能力</strong>
          <span className={css.assistantFormSectionHint}>仅对新会话生效</span>
        </div>
        <div className={css.formGrid}>
        <CapabilityPicker
          label={`可用 Skills（已选 ${selectedSkills.length} 个）`}
          ariaLabel="选择助手可使用的 Skills"
          hint="只选择这个助手执行任务时可能需要的 Skills；运行时会按任务需要加载具体 Skill 指令。"
          emptyText="该 Agent Preset 没有可用的 Skill。"
          missingDetail="该 Agent Preset 不再提供这个 Skill，保存时不会带上"
          selected={selectedSkills}
          options={capabilities.skills}
          loading={capabilities.loading}
          error={capabilities.error}
          disabled={saving}
          onChange={setSelectedSkills}
        />
        <CapabilityPicker
          label={`可用 MCP（已选 ${selectedMcpServers.length} 个）`}
          ariaLabel="选择助手可使用的 MCP Server"
          hint="MCP 连接和密钥由 Harness Profile/Preset 统一管理；运行时只向助手开放已选 Server 的工具。"
          emptyText="当前 Harness 未为该 Agent Preset 配置 MCP Server。"
          missingDetail="该 Agent Preset 不再提供这个 MCP Server，保存时不会带上"
          selected={selectedMcpServers}
          options={capabilities.mcpServers}
          loading={capabilities.loading}
          error={capabilities.error}
          disabled={saving}
          onChange={setSelectedMcpServers}
        />
        </div>
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
      <AnimatedModal
        open={avatarPickerOpen}
        onClose={() => { setAvatarPickerOpen(false) }}
        title="选择头像"
        closeLabel="关闭"
        description="从职业头像、DiceBear 风格中选择，或上传本地图片，确认后应用。"
        className={css.avatarPickerDialog ?? ''}
        contentClassName={css.avatarPickerDialogContent ?? ''}
      >
        <div className={css.avatarPickerHeader}>
          <div className={css.avatarPickerPreview}>
            <span className={css.avatarPickerPreviewBox}>
              {draftAvatar !== '' ? <img src={draftAvatar} alt="选中头像预览" /> : <span className={css.avatarPickerPreviewEmpty}>未选择</span>}
            </span>
            <span className={css.avatarPickerPreviewText}>
              <strong>预览</strong>
              <small>点击下方头像或「随机一个」，确认后使用</small>
            </span>
          </div>
          <div className={css.avatarPickerActions}>
            <label className={css.avatarUpload}>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className={css.avatarFileInput}
                onChange={event => {
                  const file = event.target.files?.[0]
                  if (file !== undefined) readAvatar(file)
                }}
              />
              本地上传
            </label>
            <button type="button" className={css.avatarGenerate} disabled={pickingAvatar} onClick={randomizeAvatar}>
              {pickingAvatar ? '生成中…' : '随机一个'}
            </button>
          </div>
        </div>
        {error !== undefined && <span className={css.avatarPickerError}>{error}</span>}
        <div ref={avatarScrollRef} className={css.avatarPickerScroll}>
          <div className={css.avatarStyleRow}>
            <div className={css.avatarStyleMeta}>
              <strong>职业</strong>
            </div>
            <div className={css.avatarStyleGrid}>
              {BUILTIN_ASSISTANT_AVATARS.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={css.avatarBuiltinItem}
                  aria-pressed={avatar === item.data}
                  aria-label={`使用${item.label}头像`}
                  title={item.label}
                  onClick={() => { setDraftAvatar(item.data) }}
                >
                  <img src={item.data} alt="" />
                </button>
              ))}
            </div>
          </div>
          {DICEBEAR_STYLES.map(style => (
            <div key={style.id} className={css.avatarStyleRow}>
              <div className={css.avatarStyleMeta}>
                <strong>{style.label}</strong>
                <span>{style.id}</span>
              </div>
              <div className={css.avatarStyleGrid}>
                {Array.from({ length: 8 }, (_, index) => {
                  const seed = `${name.trim() || 'assistant'}-${style.id}-${index}`
                  return (
                    <button
                      key={index}
                      type="button"
                      className={css.avatarStyleThumb}
                      disabled={pickingAvatar}
                      aria-label={`使用${style.label}头像 ${index + 1}`}
                      onClick={() => { void applyGeneratedAvatar(style.id, seed) }}
                    >
                      <img src={dicebearUrl(style.id, seed)} alt="" loading="lazy" />
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        <div className={css.avatarPickerFooter}>
          <span className={css.hint}>PNG/JPEG/WebP，≤256KB</span>
          <div className={css.avatarPickerActions}>
            <button type="button" className={css.avatarRandom} onClick={() => { setAvatar(draftAvatar); setAvatarPickerOpen(false) }}>
              使用这个头像
            </button>
          </div>
        </div>
      </AnimatedModal>
    </form>
  )
}
