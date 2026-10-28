import { useEffect, useRef, useState } from 'react'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import {
  assistantInstanceForSession,
  assistantInstanceLabel,
} from './assistant-instances.js'
import css from './AgentTeam.module.css'
import type { AssistantInstance } from '../domain/types.js'

/** Shared read of every instance, refreshed by the plugin's change stream. */
function useAssistantInstances(): AssistantInstance[] {
  const [instances, setInstances] = useState<AssistantInstance[]>([])
  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      try {
        const value = await callAgentTeam('assistant.instance.list')
        if (live) setInstances(value.items)
      } catch {
        // Keep the previous set; the SSE subscription retries on the next snapshot.
      }
    }
    void load()
    const unsubscribe = subscribeAgentTeam(() => { void load() }, () => {}, () => { void load() })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  return instances
}

/**
 * The lineage chip text, or `undefined` when the owner's own title already says
 * it. The slot owner renders `displayTitle` first and then this chip, so after
 * the canonical chat is renamed to the assistant label the chip must disappear —
 * otherwise the header shows the same label twice.
 *
 * Before the rename existed this chip was the only place the label appeared
 * (the native title was the Workspace directory). It stays as the fallback for
 * a deployment where the host title could not be written.
 */
export function assistantLineageTitle(
  instance: Pick<AssistantInstance, 'assistantSnapshot'> | undefined,
  displayTitle: string | undefined,
): string | undefined {
  if (instance === undefined) return undefined
  const label = assistantInstanceLabel(instance)
  return displayTitle === label ? undefined : label
}

export function AssistantSessionTitle({
  lineageSessionId,
  displayTitle,
}: {
  lineageSessionId?: string
  displayTitle?: string
}): JSX.Element | null {
  const instances = useAssistantInstances()
  const label = assistantLineageTitle(
    assistantInstanceForSession(instances, lineageSessionId),
    displayTitle,
  )
  if (label === undefined) return null
  return <span className={css.assistantSessionTitle} title={label}>{label}</span>
}

/**
 * Always mounted for the active Session through the utilities list slot. Only
 * while this Session is a live Assistant main Session does it register the
 * lineage title, so the shipped subagent lineage stays untouched everywhere
 * else. The registration is disposed on session change and unmount.
 */
export function AssistantSessionTitleHost({
  sessionId,
  registerTitle,
}: {
  sessionId?: string
  registerTitle: () => (() => void) | void
}): null {
  const instances = useAssistantInstances()
  const active = assistantInstanceForSession(instances, sessionId) !== undefined
  const registerRef = useRef(registerTitle)
  registerRef.current = registerTitle

  useEffect(() => {
    if (!active) return
    const dispose = registerRef.current()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, [active])

  return null
}
