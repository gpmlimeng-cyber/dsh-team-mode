import { useEffect, useRef, useState } from 'react'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import { assistantInstanceForSession, assistantNameForSession } from './assistant-instances.js'
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
 * Assistant main Sessions are ordinary DSH Sessions with no durable title, so
 * the native breadcrumb shows the Workspace directory name. This lineage slot
 * appends the Assistant's display name; the Session itself is never renamed.
 */
export function AssistantSessionTitle({ sessionId }: { sessionId?: string }): JSX.Element | null {
  const instances = useAssistantInstances()
  const name = assistantNameForSession(instances, sessionId)
  if (name === undefined) return null
  return <span className={css.assistantSessionTitle} title={name}>{name}</span>
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
