import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconProjectAddOutlineRegular,
  IconSearchOutlineRegular,
  IconSparkleRegular,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { callAgentTeam } from './api.js'
import css from './AgentTeam.module.css'

/**
 * One capability a picker can offer. `detail` is the one-line explanation the
 * row shows under its name (a Skill description, or how many tools an MCP
 * Server carries).
 */
export interface CapabilityOption {
  name: string
  detail: string
}

/** One rendered row: a catalog option, or a selected name the catalog lost. */
export interface CapabilityRow extends CapabilityOption {
  checked: boolean
  /** Selected but not offered by this Agent Preset: shown, explained, never saved. */
  unavailable: boolean
}

/**
 * The picker's rows. A selected name the catalog no longer offers is kept in
 * front instead of being dropped, so a stale selection is visible with its
 * reason rather than quietly disappearing from the dialog.
 */
export function capabilityRows(
  selected: readonly string[],
  options: readonly CapabilityOption[],
  missingDetail: string,
): CapabilityRow[] {
  const chosen = new Set(selected)
  const offered = new Set(options.map(option => option.name))
  return [
    ...selected
      .filter(name => !offered.has(name))
      .map(name => ({ name, detail: missingDetail, checked: true, unavailable: true })),
    ...options.map(option => ({
      ...option,
      checked: chosen.has(option.name),
      unavailable: false,
    })),
  ]
}

/** The selection a write may carry: names the current catalog still offers. */
export function savableNames(
  selected: readonly string[],
  options: readonly CapabilityOption[],
): string[] {
  const offered = new Set(options.map(option => option.name))
  return selected.filter(name => offered.has(name))
}

function toggled(selected: readonly string[], name: string, next: boolean): string[] {
  return next
    ? [...selected, name].sort()
    : selected.filter(entry => entry !== name)
}

/**
 * One Skill/MCP multi-select. It is the shipped `Checkbox` in the shipped
 * two-column option grid — not a new control — so the create dialog, the
 * settings dialog and the template editor read the same way.
 */
export function CapabilityPicker({
  label,
  ariaLabel,
  hint,
  emptyText,
  missingDetail,
  selected,
  options,
  loading,
  error,
  disabled,
  onChange,
  icon = <IconSparkleRegular size={14} />,
}: {
  label: string
  ariaLabel: string
  hint: string
  emptyText: string
  missingDetail: string
  selected: readonly string[]
  options: readonly CapabilityOption[]
  loading: boolean
  error: string | undefined
  disabled: boolean
  onChange: (next: string[]) => void
  /** Tile glyph, matching the shipped plugin list's per-row icon. */
  icon?: ReactNode
}): JSX.Element {
  const [query, setQuery] = useState('')
  const allRows = loading || error !== undefined
    ? []
    : capabilityRows(selected, options, missingDetail)
  // Search only narrows what is shown: a selected entry stays selected even
  // while the filter hides it, so the count above never lies.
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (needle === '') return allRows
    return allRows.filter(row => (
      row.name.toLocaleLowerCase().includes(needle)
      || row.detail.toLocaleLowerCase().includes(needle)
    ))
  }, [allRows, query])

  return (
    <div className={css.field}>
      <span className={css.label}>{label}</span>
      <label className={css.capabilitySearch}>
        <IconSearchOutlineRegular size={14} />
        <input
          type="search"
          value={query}
          aria-label={`${label}：搜索`}
          placeholder="搜索名称或描述"
          disabled={disabled}
          onChange={event => { setQuery(event.target.value) }}
        />
      </label>
      <div className={css.skillPicker} role="group" aria-label={ariaLabel}>
        {loading && <span className={css.hint}>正在读取该 Agent Preset 的目录…</span>}
        {!loading && error !== undefined && (
          <span className={css.inlineError} role="alert">读取失败：{error}</span>
        )}
        {!loading && error === undefined && allRows.length === 0 && (
          <span className={css.hint}>{emptyText}</span>
        )}
        {!loading && error === undefined && allRows.length > 0 && rows.length === 0 && (
          <span className={css.hint}>没有匹配「{query.trim()}」的条目。</span>
        )}
        {rows.map(row => (
          <div
            key={row.name}
            className={row.unavailable ? `${css.skillOption} ${css.skillOptionUnavailable}` : css.skillOption}
            data-capability-unavailable={row.unavailable ? 'true' : undefined}
          >
            <span className={css.skillOptionIcon} aria-hidden="true">{icon}</span>
            <span className={css.skillOptionText}>
              <span className={css.skillOptionTitle}>
                {row.unavailable ? `${row.name}（不可用）` : row.name}
              </span>
              <small className={row.unavailable ? css.skillOptionReason : css.skillOptionDesc}>{row.detail}</small>
            </span>
            <Switch
              checked={row.checked}
              label={row.unavailable ? `${row.name}（不可用）` : row.name}
              title={row.unavailable ? row.detail : undefined}
              disabled={disabled || row.unavailable}
              onChange={next => { onChange(toggled(selected, row.name, next)) }}
            />
          </div>
        ))}
      </div>
      <span className={css.hint}>{hint}</span>
    </div>
  )
}

const NO_SKILLS: readonly CapabilityOption[] = []
const NO_MCP_SERVERS: readonly CapabilityOption[] = []

/**
 * The live Skills and MCP Servers of one Agent Preset. An empty preset id means
 * "no question was asked yet"; a failed read is reported as `error` and offers
 * no options, which is how every caller knows the difference between "none
 * available" and "not known".
 */
export function useCapabilityCatalog(agentPresetId: string): {
  skills: readonly CapabilityOption[]
  mcpServers: readonly CapabilityOption[]
  loading: boolean
  error: string | undefined
  /** True only when this preset's catalog was read: the moment "unavailable" means something. */
  loaded: boolean
} {
  const [state, setState] = useState<{
    skills: readonly CapabilityOption[]
    mcpServers: readonly CapabilityOption[]
    loading: boolean
    error: string | undefined
    loaded: boolean
  }>({ skills: NO_SKILLS, mcpServers: NO_MCP_SERVERS, loading: false, error: undefined, loaded: false })

  useEffect(() => {
    if (agentPresetId === '') {
      setState({ skills: NO_SKILLS, mcpServers: NO_MCP_SERVERS, loading: false, error: undefined, loaded: false })
      return
    }
    let live = true
    setState({ skills: NO_SKILLS, mcpServers: NO_MCP_SERVERS, loading: true, error: undefined, loaded: false })
    void Promise.all([
      callAgentTeam('skill.catalog', { agentPresetId }),
      callAgentTeam('mcp.catalog', { agentPresetId }),
    ]).then(([skills, servers]) => {
      if (!live) return
      setState({
        skills: skills.skills.map(skill => ({
          name: skill.name,
          detail: skill.modelInvocable
            ? skill.description
            : `${skill.description}（仅斜杠调用）`,
        })),
        mcpServers: servers.servers.map(server => ({
          name: server.name,
          detail: `${server.tools.length} 个工具`,
        })),
        loading: false,
        error: undefined,
        loaded: true,
      })
    }).catch((cause: unknown) => {
      if (!live) return
      setState({
        skills: NO_SKILLS,
        mcpServers: NO_MCP_SERVERS,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
        loaded: false,
      })
    })
    return () => { live = false }
  }, [agentPresetId])

  return state
}
