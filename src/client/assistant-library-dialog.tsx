import { AnimatedModal } from './shared.js'
import { AssistantPanel } from './assistants/AssistantPanel.js'
import { useAgentTeamData } from './components.js'
import css from './AgentTeam.module.css'

/**
 * The assistant template library, reachable from the ＋ menu. It reuses the same
 * `AssistantPanel` the settings section renders — one library, two doors, no
 * second copy of the editing UI.
 */
export function AssistantLibraryDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const { catalog, assistants, load } = useAgentTeamData(false)
  return (
    <AnimatedModal
      open={open}
      onClose={onClose}
      title="模板库"
      closeLabel="关闭"
      className={css.assistantLibraryDialog ?? ''}
      contentClassName={css.assistantLibraryContent ?? ''}
    >
      <AssistantPanel catalog={catalog} assistants={assistants} onChanged={load} />
    </AnimatedModal>
  )
}
