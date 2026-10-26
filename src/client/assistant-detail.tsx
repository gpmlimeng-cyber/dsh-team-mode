import { useEffect, useState } from 'react'
import {
  DisclosureRow,
  IconInfoOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconShieldOutlineRegular,
  IconSlidersTwoOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { callAgentTeam, subscribeAgentTeam } from './api.js'
import {
  assistantAvatarSource,
  assistantInstanceName,
} from './assistant-instances.js'
import { assistantInstanceStatusLabel, PERMISSION_LABELS } from './labels.js'
import { MemberAvatar } from './member-avatar.js'
import { selectAssistant, useAgentTeamUi } from './store.js'
import css from './AgentTeam.module.css'
import type { AssistantInstanceView } from '../transport/contracts.js'

/**
 * The page type this plugin owns on the host's right Sidebar.
 *
 * Both constants are chosen against the contract note
 * `docs/superpowers/notes/2026-10-26-sidebar-right.md`: `kind` is an open string
 * that no shipped type uses, and `id` is a package name because it is also the
 * key the body registers under in `sidebar.right.pane.tab`.
 */
export const DETAIL_TAB_KIND = 'team-mode'
export const DETAIL_TAB_ID = '@limeng/dsh-team-mode/detail'
export const DETAIL_TAB_TITLE = '助手详情'

/** The one instruction the pane shows before a helper is chosen on the left. */
export const DETAIL_EMPTY_TEXT = '从左侧选择一个助手'

export type AssistantDetailSectionId = 'overview' | 'identity' | 'model' | 'permission'

export interface AssistantDetailFact {
  label: string
  value: string
}

export interface AssistantDetailSection {
  id: AssistantDetailSectionId
  title: string
  facts: AssistantDetailFact[]
}

/**
 * Sessions the row can open: the main Session plus every visible thread. Retired
 * ids are history, so they are deliberately not counted.
 */
export function assistantBoundSessionCount(
  instance: Pick<AssistantInstanceView, 'mainSessionId' | 'threadSessionIds'>,
): number {
  return (instance.mainSessionId === undefined ? 0 : 1) + (instance.threadSessionIds?.length ?? 0)
}

/**
 * The four read-only blocks of the panel, as plain data.
 *
 * Everything here is a field of one `assistant.instance.list` row — no second
 * read, no model-catalog lookup, no inferred copy. Keeping it pure is what lets
 * a test pin the panel's content without a DOM or a fetch.
 */
export function assistantDetailSections(instance: AssistantInstanceView): AssistantDetailSection[] {
  const snapshot = instance.assistantSnapshot
  return [
    {
      id: 'overview',
      title: '概览',
      facts: [
        { label: '名称', value: assistantInstanceName(instance) },
        { label: '状态', value: assistantInstanceStatusLabel(instance.status) },
        { label: '所属分组', value: instance.group ?? '未分组' },
        { label: '绑定会话数', value: String(assistantBoundSessionCount(instance)) },
      ],
    },
    {
      id: 'identity',
      title: '身份',
      facts: [
        { label: '名称', value: assistantInstanceName(instance) },
        {
          label: '头像',
          value: assistantAvatarSource(instance) === undefined ? '首字头像' : '自定义头像',
        },
      ],
    },
    {
      id: 'model',
      title: '模型',
      facts: [
        { label: 'Provider', value: snapshot.provider },
        { label: 'Model', value: snapshot.model },
        { label: '推理强度', value: snapshot.reasoningEffort ?? '模型默认' },
      ],
    },
    {
      id: 'permission',
      title: '权限',
      facts: [
        {
          label: '权限预设',
          value: PERMISSION_LABELS[snapshot.permissionPresetId] ?? snapshot.permissionPresetId,
        },
      ],
    },
  ]
}

const SECTION_ICONS: Record<AssistantDetailSectionId, JSX.Element> = {
  overview: <IconInfoOutlineRegular size={14} />,
  identity: <IconPersonalizationOutlineRegular size={14} />,
  model: <IconSlidersTwoOutlineRegular size={14} />,
  permission: <IconShieldOutlineRegular size={14} />,
}

function AssistantDetailFacts({
  section,
}: {
  section: AssistantDetailSection
}): JSX.Element {
  return (
    <dl className={css.assistantDetailFacts} data-dsh-assistant-detail-section={section.id}>
      {section.facts.map(fact => (
        <div key={fact.label} className={css.assistantDetailFact}>
          <dt className={css.assistantDetailFactLabel}>{fact.label}</dt>
          <dd className={css.assistantDetailFactValue}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The panel body. Sections default open and are collapsible, which is also what
 * makes the whole panel keyboard reachable: `DisclosureRow` renders the row as a
 * focusable, Enter/Space-operable target.
 *
 * Closing the pane itself is the host's Esc shortcut — no key handler here.
 */
export function AssistantDetailPanel({
  instance,
  notice,
  expanded,
}: {
  instance?: AssistantInstanceView | undefined
  /** Shown instead of the empty instruction while the list is loading or failed. */
  notice?: string | undefined
  expanded?: boolean | undefined
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
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
  const sections = assistantDetailSections(instance)
  const avatar = assistantAvatarSource(instance)
  return (
    <div className={css.assistantDetail} data-dsh-assistant-detail data-expanded={expanded}>
      {sections.map(section => {
        const open = collapsed[section.id] !== true
        return (
          <DisclosureRow
            key={section.id}
            icon={SECTION_ICONS[section.id]}
            title={section.title}
            open={open}
            expandable
            expandOnRowClick
            onToggle={() => {
              setCollapsed(current => ({ ...current, [section.id]: open }))
            }}
          >
            {section.id === 'identity' && (
              <div className={css.assistantDetailIdentity}>
                <MemberAvatar
                  name={assistantInstanceName(instance)}
                  avatar={avatar}
                  size={40}
                  className={css.assistantDetailAvatar ?? ''}
                />
                {avatar === undefined && (
                  <span className={css.assistantDetailAvatarNote}>未设置头像，用名称首字</span>
                )}
              </div>
            )}
            <AssistantDetailFacts section={section} />
          </DisclosureRow>
        )
      })}
    </div>
  )
}

interface InstancesState {
  instances: AssistantInstanceView[]
  loading: boolean
  error?: string
}

/** Read the one row this panel shows through the existing list transport. */
function useAssistantInstances(enabled: boolean): InstancesState {
  const [state, setState] = useState<InstancesState>({ instances: [], loading: enabled })
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
  }, [enabled])
  return state
}

/**
 * The `sidebar.right.pane.tab` entry: the framework hands it `useTabInfo`, and
 * the row it describes is whichever helper the sidebar has selected.
 *
 * The tab record is not needed beyond the shell's own state, so the only thing
 * read from it is whether the pane is expanded; the selection itself lives in
 * the plugin's UI store, which the row menu writes before opening this tab.
 */
export function AssistantDetailBody({
  useTabInfo,
}: PropsRuntime<'sidebar.right.pane.tab'>): JSX.Element {
  const { sidebar } = useTabInfo()
  const { selectedAssistantId } = useAgentTeamUi()
  const { instances, loading, error } = useAssistantInstances(selectedAssistantId !== undefined)
  const instance = instances.find(candidate => candidate.id === selectedAssistantId)
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
    />
  )
}

/** The services the open action needs; the host's face, narrowed to two reads. */
export interface DetailSidebar {
  mounted: { getSnapshot(): string | undefined }
  openTab(kind: string): void
}

/**
 * Open (or focus) the detail tab for one helper.
 *
 * Selection is written first so the body — mounted in the same module graph —
 * renders this row on its first paint. The guard is the contract note's: every
 * write throws while no Session surface is mounted, so a hero screen gets `false`
 * and the row can say why instead of appearing dead.
 */
export function openAssistantDetail(
  sidebar: DetailSidebar | undefined,
  assistantId: string,
): boolean {
  selectAssistant(assistantId)
  if (sidebar === undefined || sidebar.mounted.getSnapshot() === undefined) return false
  try {
    sidebar.openTab(DETAIL_TAB_KIND)
    return true
  } catch {
    return false
  }
}
