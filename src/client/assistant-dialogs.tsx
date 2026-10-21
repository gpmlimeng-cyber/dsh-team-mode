import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import { AnimatedModal, Field } from './shared.js'
import css from './AgentTeam.module.css'
import type { AssistantView, CatalogView } from '../transport/contracts.js'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Create one Assistant instance, then lazily materialize its main Session and
 * hand navigation to the shipped conversation view. There is deliberately no
 * custom chat surface here: this dialog only chooses a template and workspace.
 */
export function AssistantCreateDialog({
  open,
  onClose,
  openSession,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  openSession: (sessionId: string) => void
  onCreated: () => Promise<void>
}): JSX.Element | null {
  const [templates, setTemplates] = useState<AssistantView[]>([])
  const [workspaces, setWorkspaces] = useState<CatalogView['workspaces']>([])
  const [templateId, setTemplateId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [createdId, setCreatedId] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    setError(undefined)
    setCreatedId(undefined)
    setTemplateId('')
    setWorkspaceId('')
    setName('')
    setNameEdited(false)
    Promise.all([callAgentTeam('assistant.list'), callAgentTeam('catalog.get')])
      .then(([assistantPage, catalog]) => {
        if (!live) return
        const nextTemplates = assistantPage.items.filter(item => item.enabled !== false)
        const nextWorkspaces = catalog.workspaces.filter(item => item.status === 'ok')
        setTemplates(nextTemplates)
        setWorkspaces(nextWorkspaces)
        const firstTemplate = nextTemplates[0]
        setTemplateId(firstTemplate?.id ?? '')
        setWorkspaceId(nextWorkspaces[0]?.id ?? '')
        setName(firstTemplate?.name ?? '')
      })
      .catch(cause => {
        if (live) setError(`读取助手模板失败：${messageOf(cause)}`)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => { live = false }
  }, [open])

  if (!open) return null

  const selectedTemplate = templates.find(item => item.id === templateId)

  const chooseTemplate = (id: string): void => {
    setTemplateId(id)
    if (nameEdited) return
    setName(templates.find(item => item.id === id)?.name ?? '')
  }

  const close = (): void => {
    if (saving) return
    onClose()
  }

  async function ensureAndOpen(id: string): Promise<void> {
    try {
      const result = await callAgentTeam('assistant.instance.ensure', { id })
      onClose()
      openSession(result.sessionId)
    } catch (cause) {
      setError(`助手已创建，但打开主会话失败：${messageOf(cause)}。也可以从侧栏点击该助手重试。`)
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (saving || templateId === '' || workspaceId === '') return
    setSaving(true)
    setError(undefined)
    try {
      if (createdId !== undefined) {
        await ensureAndOpen(createdId)
        return
      }
      const displayName = name.trim()
      try {
        const created = await callAgentTeam('assistant.instance.create', {
          templateId,
          workspaceId,
          ...(displayName === '' ? {} : { name: displayName }),
        })
        setCreatedId(created.id)
        await onCreated()
        await ensureAndOpen(created.id)
      } catch (cause) {
        setError(messageOf(cause))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <AnimatedModal
      open
      onClose={close}
      title="新建单聊助手"
      description="选择一个助手模板与 Workspace。首次打开时才创建它的主会话。"
      closeLabel="关闭"
      className={css.assistantCreateDialog ?? ''}
    >
      <form className={css.assistantCreateForm} onSubmit={(event) => { void submit(event) }}>
        {error !== undefined && <div className={css.inlineError} role="alert">{error}</div>}
        {loading
          ? <div className={css.dialogEmpty}>正在读取助手模板与 Workspace…</div>
          : templates.length === 0
            ? <div className={css.dialogEmpty}>没有可用的助手模板，请先在设置中启用或创建一个助手。</div>
            : (
              <>
                <Field label="助手模板">
                  <select
                    className={css.input}
                    value={templateId}
                    disabled={createdId !== undefined}
                    onChange={event => { chooseTemplate(event.target.value) }}
                  >
                    {templates.map(item => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </Field>
                {selectedTemplate?.description !== undefined && selectedTemplate.description !== '' && (
                  <p className={css.assistantCreateHint}>{selectedTemplate.description}</p>
                )}
                <Field label="Workspace">
                  <select
                    className={css.input}
                    value={workspaceId}
                    disabled={createdId !== undefined}
                    onChange={event => { setWorkspaceId(event.target.value) }}
                  >
                    {workspaces.length === 0
                      ? <option value="">暂无可用 Workspace</option>
                      : workspaces.map(item => (
                        <option key={item.id} value={item.id}>{item.title} — {item.path}</option>
                      ))}
                  </select>
                </Field>
                <Field label="显示名称（可选）">
                  <input
                    className={css.input}
                    value={name}
                    disabled={createdId !== undefined}
                    placeholder={selectedTemplate?.name ?? '助手名称'}
                    onChange={event => {
                      setNameEdited(true)
                      setName(event.target.value)
                    }}
                  />
                </Field>
              </>
            )}
        <div className={css.assistantCreateActions}>
          <Button variant="outline" type="button" disabled={saving} onClick={close}>取消</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={loading || saving || templateId === '' || workspaceId === ''}
          >
            {saving
              ? (createdId === undefined ? '创建中…' : '打开中…')
              : (createdId === undefined ? '创建并打开' : '重试打开')}
          </Button>
        </div>
      </form>
    </AnimatedModal>
  )
}
