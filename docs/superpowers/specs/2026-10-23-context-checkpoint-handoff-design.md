# Context Checkpoint + Handoff — Design

> 2026-10-23 · 架构级设计 · 第一版范围：单聊助手
> 上游方向：`docs/COMPETITIVE-GAPS.md` R1 / `docs/HANDOFF.md` Context Steward
> 执行约束：Superpowers + AgentTeams + dsh-plugin-guide + ponytail（最简可用）

## Status

Approved design direction: native checkpoint + new DM session handoff.
No automatic compaction, no session segmentation, no team-Leader handoff in v1.

## 1. Problem

Long-running Assistant DM sessions eventually lose usable context. DSH's native
compaction compacts the current surface but does not provide a durable handoff
artifact or a deliberate new-session continuation. Users need a manual way to:

1. capture the essential state of an Assistant DM;
2. start a fresh DM session with that state;
3. keep the old session persisted but hidden from the sidebar.

The first version deliberately does not call `ctx.compaction`. It is a
handoff workflow, not a compaction backend.

## 2. Goals

- Create a bounded, structured checkpoint from an Assistant's current main
  Session plus its active tasks.
- Persist the checkpoint separately from long-term memory.
- Hand off to a new Assistant main Session without losing the old Session log.
- Inject the checkpoint as a durable, model-visible context message in the new
  Session.
- Keep the old main Session hidden from the native sidebar after handoff.
- Refuse handoff while worker tasks are active; allow checkpoint creation.

## 3. Non-goals

- Automatic threshold-triggered compaction or segmentation.
- Summarizing with an LLM in v1; the checkpoint is deterministic facts plus an
  optional user note.
- Team Leader handoff (reuse Team Epoch separately).
- Search UI over old sessions; native session browser/search remains the access
  path.
- Changing DSH compaction or session formats.
- Merging checkpoint data into `assistant_memory`.

## 4. Model

### AssistantInstance additions

```ts
retiredMainSessionIds?: string[]  // absent for legacy rows; deduplicated
```

`retiredMainSessionIds` records prior main Sessions that must remain hidden.
`mainSessionId` remains the single current session. No schema-version bump:
legacy rows parse unchanged and are treated as `[]`.

### ContextCheckpoint

New persisted table `context_checkpoints`, schema version 1:

```ts
interface ContextCheckpoint {
  schemaVersion: 1
  id: string
  assistantId: string
  sourceSessionId: string
  targetSessionId?: string
  title: string
  note: string                 // user-supplied, <= 4000 chars
  capturedThroughSeq: number
  facts: CheckpointFacts
  status: 'ready' | 'consumed' | 'archived'
  createdAt: string
  consumedAt?: string
}

interface CheckpointFacts {
  recentMessages: Array<{ role: 'user' | 'assistant'; text: string }> // <= 12, each <= 500 chars
  activeTasks: Array<{ id: string; title: string; status: string }>    // <= 20
  workspacePath: string
  note: string
}
```

The table is keyed by `id` and indexed by `assistantId` at read time. Stored
checkpoint content is bounded; no unbounded transcript is copied.

### Checkpoint context message

The new Session receives one `user/message` whose source is:

```ts
{ kind: 'runtime-context', form: 'instructions' }
```

This makes the checkpoint model-visible and durable in the Session log, while
the native conversation projection does not render it as a user chat bubble.
The message content is a deterministic Markdown handoff block containing the
checkpoint title, note, recent messages, active tasks, and workspace path.

This preserves the DSH rule “model-visible iff recorded”: the exact text exists
in the new Session's event log.

## 5. Checkpoint creation

Triggered manually from the Assistant row menu.

1. Require an existing `mainSessionId`.
2. Read live events if the main Agent is live, otherwise use
   `readStoredSessionEvents`.
3. Project visible user/assistant nodes with the existing
   `projectConversation(events, 80)` helper.
4. Keep the last 12 visible nodes; truncate each text to 500 characters.
5. Include active (queued/running/needs_input) Assistant tasks for this instance,
   newest first, capped at 20, with title/status.
6. Include `workspacePath` and the optional user note.
7. Persist `status: 'ready'`; `capturedThroughSeq` is the last read event seq.
8. Return the checkpoint record.

No model call. No tool result or reasoning text is included. The note is
explicitly labeled as user-written in the generated handoff block.

## 6. Handoff lifecycle

`assistant.checkpoint.handoff(checkpointId)`:

1. Load checkpoint; require `status === 'ready'` and matching instance.
2. Reject if any active worker task exists for the assistant
   (`ASSISTANT_TASKS_ACTIVE`).
3. Reject archived instances.
4. Create a fresh main Agent Session with the same Assistant snapshot,
   workspace, model selection, permission preset, memory and identity prompt
   sections as normal main-session startup.
5. Deliver the checkpoint context message to the new Agent with `followup()`.
6. On success, update the instance atomically:
   - `mainSessionId = newSessionId`
   - `retiredMainSessionIds = unique([...old, previousMainSessionId])`
   - `updatedAt = now`
7. Mark checkpoint `consumed`, set `targetSessionId`, `consumedAt`.
8. Dispose the runtime's owned previous main handle after the instance update;
   the old session stays persisted.
9. Return the new session id and checkpoint.

On failure before the instance update, dispose the new handle and leave the old
binding unchanged. A failure after the instance update is reported, but the new
binding is not rolled back blindly; the checkpoint message remains in the new
Session log and the operation is recoverable.

The handoff is user-initiated and requires an idle DM. No old session content is
deleted.

## 7. Sidebar hiding

`hiddenSessionIds` includes:

- current `mainSessionId`;
- every `retiredMainSessionIds` entry;
- existing team member and worker sessions.

The hider already owns and restores inline `display` values; it only adds the
new ids to the hidden set. Retired sessions remain reachable through native
session search/history, not the sidebar.

## 8. API and UI

New host API methods:

```text
assistant.checkpoint.create  { assistantId, note? } -> ContextCheckpoint
assistant.checkpoint.list    { assistantId }        -> ContextCheckpoint[]
assistant.checkpoint.handoff { checkpointId }       -> { checkpoint, sessionId }
```

UI:

- Assistant row “更多” menu adds “生成检查点”.
- A compact dialog collects an optional note (max 4000), shows the fact
  summary, and creates the checkpoint.
- After a checkpoint exists, menu adds “交接新会话”; it confirms once, then
  opens the returned session.
- Handoff failure is shown as an inline error; the old DM remains selected.
- The dialog is not a new page and does not replace the native conversation.

## 9. Errors

```text
ASSISTANT_SESSION_NOT_READY      no main session yet
CHECKPOINT_NOT_FOUND             unknown id
CHECKPOINT_NOT_READY             already consumed/archived
ASSISTANT_TASKS_ACTIVE           active workers prevent handoff
ASSISTANT_INSTANCE_ARCHIVED      archived instance
SESSION_CREATE_FAILED            new Agent could not start
```

All errors keep the previous instance binding intact except an
already-committed post-update failure, which is reported explicitly.

## 10. Testing

Unit:

- checkpoint builder keeps bounded message/task counts and excludes tools.
- note is trimmed and bounded.
- checkpoint schema rejects malformed facts.
- instance addition accepts absent `retiredMainSessionIds`.
- hidden session set unions retired main sessions.

Service/runtime:

- create/list checkpoint.
- handoff rejects active tasks.
- handoff creates a new session, injects the context message, updates the
  instance, retires the old session.
- failed new-session creation leaves the old binding.
- consumed checkpoint cannot be handed off twice.

UI:

- menu items appear only when valid.
- dialog creates checkpoint and exposes handoff.
- failure message renders.

Verification:

```text
npm run check
```

No external deployment, npm publish, or release tag in this scope.

## 11. Deferred

- LLM-generated semantic summaries.
- Automatic threshold detection and segmentation.
- Team Leader handoff (new Team Epoch).
- Checkpoint search UI and cross-assistant reuse.
- Compaction backend integration.
