# Raft Collaboration Audit — claim, inbox, thread

> Task 1 of `docs/superpowers/plans/2026-10-23-raft-collaboration.md`. Read-only audit of current bytes; no code changed.
> Spec: `docs/RAFT-ADOPTION.md` §P1 任务 claim 与 inbox, §P1 Thread 上下文.

## 1. Task states and transitions

Internal `TeamTask.status` (`src/domain/schemas.ts:246`) — `pending | assigned | running | blocked | completed | failed | cancelled`.

| Transition | Where | Notes |
|---|---|---|
| create → `assigned` | `createTask` (`team-command-handler.ts:279`) | owner given; mints `attemptId` |
| create → `pending` | same | no owner, no `attemptId` |
| `blocked` | only an explicit model-supplied status | blocking is otherwise **`dependencyIds`**, not status |
| any → terminal | `updateTask` (`:359`) | completed/cancelled clear downstream blockers (`clearDownstreamBlockers` `:1270`), waking owners whose dependency list became empty |
| terminal → open | **unguarded** | a Leader can reopen a completed task; claim eligibility must test status explicitly |

Exposed status is lossy on purpose (`toAionTaskStatus`): `failed`/`cancelled` → `deleted`, `running`/`blocked` → `in_progress`. Terminal set `['completed','failed','cancelled']` is also the open-task guard for member removal (`dsh-team-mode-service.ts:2749`).

## 2. Owner / attempt transitions

- `attemptId` is minted **only** when a task gains or changes an owner: `createTask` with owner, and `updateTask` when `nextOwnerSlotId !== base.ownerSlotId` (`:441`). Re-sending the same owner and status-only updates never mint one.
- Clearing the owner deletes both `ownerSlotId` and `attemptId` (`:452`).
- Member update requires (a) `base.ownerSlotId === callerSlotId` and (b) `base.attemptId === presentedAttempt` when the fence exists — both re-checked **inside** the serialized `updateRuntimeTeam` closure against `base`, so a concurrent takeover cannot be outrun (`:412`). Failure raises `INVALID_REQUEST` with `details {taskId, attemptId}`.
- The Leader is exempt from both checks, and leadership is read from `current.leaderSlotId` inside the same closure (dynamic).
- Members may reassign/blockers only on tasks they own; the Leader always may.
- Removal is refused while a member owns a non-terminal task (`MEMBER_BUSY`), so owners never dangle.

## 3. Task dispatch messages

`createTaskDispatchMessage` (`team-messages.ts:63`) always sets `relatedTaskId = taskId`. Emitted on four paths in `createTask`/`updateTask`:

1. create with an owner that is not the creator and has no blockers → `instruction`, `assignmentContent` + attempt hint.
2. owner changed and new owner ≠ caller → `instruction`, `reassignmentContent`.
3. **else if** caller is not Leader → status update back to Leader, `type = taskMessageType(status)` (`result`/`question`/`warning`/`progress`).
4. each newly unblocked task owned by someone other than the caller → `instruction`, unblock notice + attempt hint.

Paths 2 and 3 are mutually exclusive (`if / else if`), so a Leader reassignment produces one message, not two. `withAttemptHint` appends the fence token so the assignee's first update is not rejected as stale.

## 4. Message / outbox flow

Two records per message:

- **Aggregate `outbox`** — transient delivery queue written in the same atomic update as the task change; entry deleted once `deliver()` succeeds.
- **Messages table** — durable projection (`deliveryState queued|delivered|read|failed`, `readBy[]`), the only source for mailbox reads and history.

`TeamMessageDispatcher.deliver` (`team-message-dispatcher.ts:45`): re-write `queued` → `resolveAgent(recipient.sessionId)` → `followup(messageFromRecord(...))`, dedupe via `sessionHasMessage` (`agent/inbox/spliced`), then `delivered` + outbox delete. Failure writes `failed` and warns; there is no backoff retry beyond `recover()`, which replays the outbox then every `queued` message (missing recipient → `failed`).

Broadcast goes to online members except the sender; the outbox entry survives until a pass delivers to ≥1 recipient with none pending.

Read path: `team_read_messages` → `readMessages` (`:799`) filters out `sender.kind === 'user'` and self-sent, keeps `recipient.kind === 'broadcast'` or own slot, returns unread first then recent, clamps 1–50 (default 20), and **marks returned messages read** (`readBy` + `deliveryState:'read'` for non-broadcast), returning `remaining_unread`. User DMs (`sendUserMessage`, `team-runtime.ts:726`) are recorded with `sender {kind:'user', id:'local-user'}` and therefore never appear in a member mailbox.

## 5. Approval sources

Approvals are **not** in the aggregate and not durable. `TeamInteractionBridge` (`team-interaction-bridge.ts`) holds in-memory `question | approval` records per member session, fed by the Harness waterfalls `user-questions/request` and `approval/request` and attached per member Agent. They surface only via `projectMemberConversation` → `interactions.list(sessionId)` as `MemberConversationView.pendingInteractions` (`team-runtime.ts:404`), and resolve through `respondToInteraction(teamId, slotId, interactionId, response)` (`:310`), which re-validates the owned `(teamId, slotId)` pair and throws `INTERACTION_NOT_FOUND` otherwise.

`member.lastRuntimeState` is only ever persisted as `idle | running` (`setMemberRuntimeState` `:1374`, plus startup/error paths). `waiting_approval` in the schema/contracts is a **read-time derivation** (`owned.agent.status`, and client-side `pendingInteractions.some(kind === 'approval')`) — never stored.

## 6. Member identity

- `slotId` = membership key in `team.members`; `leaderSlotId` names the Leader; `memberOrder` is presentation only.
- `sessionId` = the Agent Session. Every tool call is authorized by `assertToolIdentity` (`team-runtime.ts:1357`): the calling Agent's id must be the owned or activating session for exactly that `(teamId, slotId)` pair.
- Tools are registered per member Agent with `(teamId, member.id)` closed over (`:1144`), so a member tool cannot address another team; commands re-read the aggregate via `service.getTeam(teamId)`.
- `assistantId` = Assistant template; `assistantInstanceId` = explicit optional instance link (never inferred).
- Message sender identity is `{kind:'member', id: slotId}`; display names resolve at read time with a `retiredSessions` fallback for removed members.

## 7. Claim eligibility (definition to implement)

Claimable = a task with **all** of:

- `status === 'pending'`
- `ownerSlotId === undefined`
- `dependencyIds.length === 0` (blockers are cleared as they complete)
- the team aggregate is `active` (true by construction: the tool only exists inside a running member session)

Never claimable: `assigned | running | blocked | completed | failed | cancelled`; any task with an owner (claiming your own task is a no-op returning the current owner/attempt, not an error); any task with unresolved dependencies. Because blocking is expressed by `dependencyIds`, a task may be status `pending` **and** blocked — the dependency test is mandatory, a status test alone is wrong.

Important gap: today a member **cannot** take an unowned task. `updateTask` requires `task.ownerSlotId === callerSlotId`, and an unowned task has no owner, so a claim must be a new branch inside the serialized `updateRuntimeTeam` closure — never a relaxation of the owner check.

## 8. Proposed tool surface

Family naming follows the existing AionUI set (`team_mode_task_*`); the legacy `team_create_task`/`team_update_task` aliases exist only for pre-AionUI prompts, so a brand-new tool needs no alias. (Harness AgentTeams precedent for shape: `claim_task` → returns `attempt_id`; `update_task` → requires it.)

### `team_mode_task_claim` (primary, member-callable)

| Param | Type | Req | Meaning |
|---|---|---|---|
| `task_id` | string | yes | Task to claim. |

Returns `{ task_id, status, owner, attempt_id, delivery_state? }`. Behaviour: inside the closure, re-read the task; reject unless claimable; set `ownerSlotId = caller`, mint a fresh `attemptId`, `status = 'assigned'`, `revision + 1`, `updatedAt = now`; on rejection return/throw the **current** owner + attempt so the caller can stand down. Emit no dispatch message to itself; notify the Leader with the existing member status path (or `system` notice) so the board change is visible.

### `team_mode_inbox` (read-only, member-callable)

| Param | Type | Req | Meaning |
|---|---|---|---|
| `limit` | number | no | Per-section cap, clamped 1–50, default 20. |

Returns sections `assigned`, `ready`, `unread`, `approvals` (see §9). Must be non-mutating: reuse a read-only selector, **not** `readMessages`, which marks mail read.

### `team_send_message` extension

Add optional `thread_id`, `goal_id`, `reply_to` (and treat the existing `relatedTaskId` as the task link — see §10).

### `team_read_messages` extension

Add optional `thread_id` / `task_id` filter (applied after the recipient filter, before the cap).

New views: `TeamMessageView` gains `thread_id?`, `goal_id?`, `reply_to?` (`task_id` already exists and maps from `relatedTaskId`).

## 9. Inbox projection sources and caps

| Section | Source | Cap | Availability |
|---|---|---|---|
| `assigned` | aggregate tasks, `ownerSlotId === me && status in (assigned, running, blocked)` | 20 | always |
| `ready` | aggregate tasks, claimable per §7 | 20 | always |
| `unread` | durable messages table, recipient matches me or broadcast, sender ≠ me, `readBy` lacks me | 20 | always |
| `approvals` | runtime `interactions.list(member.sessionId)` where `kind === 'approval'` (include `question` as its own list or a `pending_interactions` section) | 20 | only while the runtime owns the session |

Caps and payloads: total ≤ 50 rows; per-section ≤ 20; reuse the existing 4 000-char preview + `truncated` flag; no attachment payloads (values only); no message body beyond the preview. Same-team scope is structural — the projection reads `team.tasks` / `service.listMessages(teamId)` only.

Not derivable and therefore **out of scope** for this cut:

- **`stale attempts`** — a member cannot learn from the aggregate that its token is stale; that fact only exists when an update is rejected (`details.attemptId`). Deriving it needs state the "no new inbox storage" constraint forbids. Either drop the section or redefine it as an advisory "fence risk": tasks I own, status `running`, `updatedAt` older than a threshold. Decide before implementing.
- **`reminders`** — `Task.dueAt/remindAt` and the reminder events are P2 and absent from the schema; nothing to project.

## 10. Thread propagation

`TeamMessage.relatedTaskId` already is the task link; `task_id` is already exposed in `TeamMessageView` and set on every dispatch message. Therefore:

- **Do not add a second `taskId` field.** The plan's `taskId` and the existing `relatedTaskId` would be two sources of truth for one fact. Keep `relatedTaskId` as the storage/wire field and define the task thread as "all messages with `relatedTaskId === taskId`".
- Add only `threadId?`, `goalId?`, `replyTo?` (optional, `.strict()` schema, legacy rows parse unchanged because the fields are absent).
- Propagation on dispatch: `createTaskDispatchMessage` sets `relatedTaskId` (already) and inherits `goalId` from `task.goalId`; `threadId` is left unset unless the Leader supplied one, so task threads need no extra identity. `replyTo = <dispatch message id>` on the assignee's first reply is optional and can wait.
- Legacy compatibility: `createTeamMessage` keeps its defaults, `messageFromRecord` text is unchanged, no migration is needed (optional fields).

## 11. Files

Audited (read-only): `src/domain/schemas.ts`, `src/domain/types.ts`, `src/runtime/team-command-handler.ts`, `src/runtime/team-messages.ts`, `src/runtime/team-message-dispatcher.ts`, `src/runtime/team-tools.ts`, `src/runtime/team-runtime.ts`, `src/runtime/team-prompts.ts`, `src/runtime/team-interaction-bridge.ts`, `src/service/dsh-team-mode-service.ts`, `src/config.ts`.

Expected to change in tasks 2–4: `src/domain/schemas.ts` (message thread fields), `src/runtime/team-command-handler.ts` (claim + inbox selectors + thread args), `src/runtime/team-tools.ts` (two tools, one param extension), `src/runtime/team-runtime.ts` (handler wiring), `src/runtime/team-prompts.ts` (tool list line 11, inbox guidance), tests below.

## 12. Tests

Existing seams to extend:

- `tests/team-command-handler.spec.ts` — `makeTeam()`/`makeOtherTeam()` fixture; attempt tests at :344, :371, :402; mailbox tests at :614. Add claim and inbox cases here.
- `tests/team-tools.spec.ts` — handler stub object and the exact registry assertions: `expect(tools.size).toBe(21)` **must be updated** when tools are added, and new names added to the primary list.
- `tests/team-runtime-support.spec.ts:41` — roster prompt must list the new tool names, or members will not discover them.
- `tests/transport-contracts.spec.ts` — view-shape assertions for any new message/inbox fields.

New coverage: two members claiming one ready task (exactly one wins, atomically, via the serialized closure); claim rejected for owned/blocked/terminal/unresolved-dependency tasks; claim returns the current owner+attempt on rejection; claim mints a fresh attempt and fences the previous owner; inbox excludes another team's tasks/messages and another member's mail; inbox caps and truncation; inbox does not mark messages read; thread round-trip through dispatch; legacy message without thread fields parses.

## 13. Risks

1. **No claim path exists at all** — `updateTask`'s owner check makes an unowned task unreachable for members. Claim must be a new branch, not a relaxed guard.
2. **`stale attempts` needs state that must not be stored** — resolve the contradiction before writing code (drop it, or ship a clearly-labelled advisory heuristic).
3. **Approvals are memory-only** — an inbox loses pending approvals on restart and on a member that is not owned by the runtime. The section must be optional and degrade to empty rather than throw (`TEAM_NOT_ACTIVE`).
4. **`readMessages` marks mail read** — building the inbox on it would silently clear the member's unread queue. Extract a non-mutating selector.
5. **`taskId` vs `relatedTaskId` duplication** — a second field will drift; pick the existing one.
6. **`team.outbox` and the messages table are unbounded per team** (`listMessages` returns everything, filtering in memory; no retention). Cap at the projection and sorting layer now; retention is a separate concern.
7. **`TeamAggregate.leases` is dead scaffolding** — initialised `{}` on every creation path and never written; `fileScopes` are advisory text in the dispatch message only. Do not build claim exclusion on leases.
8. **Terminal states can be reopened** — eligibility must enumerate allowed states (`pending`), never "not terminal".
9. **Silent discoverability failure** — the tool-count assertion and the prompt tool list are the only places a new tool is announced; missing one means members never call it.
10. **Leader exemption asymmetry** — a Leader takeover must still mint a fresh attempt, or the previous owner's stale token keeps working.
11. **`if / else if` dispatch** — if claim reuses this path to notify, verify it does not suppress the Leader's status update or produce self-addressed traffic.
