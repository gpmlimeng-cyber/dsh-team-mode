import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { AssistantPanel } from './assistants/AssistantPanel.js'
import {
  callAgentTeam,
  subscribeAgentTeam,
} from './api.js'
import css from './AgentTeam.module.css'
import type {
  AssistantView,
  CatalogView,
  TeamView,
} from '../transport/contracts.js'

export type { WorkspaceChoice } from './types.js'

/** Trailing window that folds a change-event burst into one reload. */
const TEAM_RELOAD_DEBOUNCE_MS = 120
/** A connection open this soon after a load is the first one, not a recovery. */
const TEAM_RESYNC_SETTLE_MS = 1_500

export function useAgentTeamData(includeTeams: boolean, active = true): {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  teams: TeamView[]
  loading: boolean
  error: string | undefined
  catalogLoading: boolean
  teamsLoading: boolean
  teamsError: string | undefined
  load: () => Promise<void>
} {
  const [catalog, setCatalog] = useState<CatalogView>()
  const [assistants, setAssistants] = useState<AssistantView[]>([])
  const [teams, setTeams] = useState<TeamView[]>([])
  const [teamsLoaded, setTeamsLoaded] = useState(false)
  const [teamsError, setTeamsError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [error, setError] = useState<string>()
  const inFlight = useRef<Promise<void>>()
  const lastLoadAt = useRef(0)

  const load = useCallback((): Promise<void> => {
    // One load per hook at a time: a change-event burst must not multiply reads.
    const running = inFlight.current
    if (running !== undefined) return running
    lastLoadAt.current = Date.now()
    const request = (async (): Promise<void> => {
      setLoading(true)
      setError(undefined)
      try {
        // The catalog stays fire-and-forget for the batch (its own resolution
        // publishes `catalogLoading`), so a slow catalog never delays the Team
        // list the sidebar draws from.
        setCatalogLoading(true)
        void callAgentTeam('catalog.get')
          .then(value => { setCatalog(value) })
          .catch((cause: unknown) => {
            const message = cause instanceof Error ? cause.message : String(cause)
            setError(current => current === undefined ? message : `${current}；${message}`)
          })
          .finally(() => { setCatalogLoading(false) })
        const coreRequests = [
          callAgentTeam('assistant.list').then(value => { setAssistants(value.items) }),
          includeTeams
            ? callAgentTeam('team.list')
                .then(value => {
                  setTeams(value.items)
                  setTeamsError(undefined)
                })
                .catch((cause: unknown) => {
                  const message = cause instanceof Error ? cause.message : String(cause)
                  setTeamsError(message)
                  throw cause
                })
                .finally(() => { setTeamsLoaded(true) })
            : Promise.resolve().then(() => {
              setTeams([])
              setTeamsLoaded(true)
            }),
        ]
        const results = await Promise.allSettled(coreRequests)
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason))
        if (failures.length > 0) setError(failures.join('；'))
      } finally {
        setLoading(false)
      }
    })()
    inFlight.current = request
    void request.finally(() => {
      if (inFlight.current === request) inFlight.current = undefined
    })
    return request
  }, [includeTeams])

  useEffect(() => {
    if (!active) return
    void load()
    // Trailing debounce: the startup change/resync burst collapses into one reload.
    // The first connection open is not a recovery — the load above already covers
    // it, so a resync inside that window must not double the read.
    // Coalescing throttle, not a trailing debounce: a steady stream of change
    // events must never starve the reload that a just-settled mutation awaits.
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (resync = false): void => {
      if (resync && Date.now() - lastLoadAt.current < TEAM_RESYNC_SETTLE_MS) return
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; void load() }, TEAM_RELOAD_DEBOUNCE_MS)
    }
    const unsubscribe = subscribeAgentTeam(
      () => { schedule() },
      () => { setError('事件连接已断开，正在等待重连') },
      () => { schedule(true) },
    )
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }, [active, load])

  return {
    catalog,
    assistants,
    teams,
    loading,
    error,
    catalogLoading,
    teamsLoading: !teamsLoaded,
    teamsError,
    load,
  }
}

export function AgentTeamSettingsSection(_props: SettingsSectionOwnerProps): JSX.Element {
  const { catalog, assistants, loading, error, load } = useAgentTeamData(false)
  return (
    <section className={css.settingsSection}>
      <div className={css.settingsHeading}>
        <div>
          <h1 className={css.settingsTitle}>团队</h1>
          <p className={css.settingsDescription}>管理可在不同团队间复用的成员模板、模型和权限配置。</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { void load() }} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>
      {error && <div role="alert" className={css.error}>{error}</div>}
      <AssistantPanel catalog={catalog} assistants={assistants} onChanged={load} />
    </section>
  )
}
