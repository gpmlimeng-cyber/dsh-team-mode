# Team Epoch Audit — Leader change, session ownership, archive

> Task 1 of `docs/superpowers/plans/2026-10-23-team-epoch.md`. Read-only audit of the bytes at `ea8baf3`; no code changed.
> Spec: `docs/DECISIONS-IDENTITY-MEMORY.md` D4. Sibling format: `docs/research/raft-collaboration-audit.md`.

## 1. Where a Leader change happens today

Three layers, no more:

| Layer | Symbol | What it does |
|---|---|---|
| Client | `changeLeader` (`src/client/teams/TeamPanel.tsx:1034`) | `team.changeLeader` with `expectedRevision`, then `onChanged()` |
| Transport | `team.changeLeader` (`src/transport/contracts.ts:457`, `src/transport/web.ts:425`) | strict payload `{teamId, successorSlotId}`, returns `TeamView` |
| Service | `AgentTeamService.changeLeader` (`src/service/dsh-team-mode-service.ts:1546`) | guards, then **one** atomic aggregate write |

The service body is a pure roster edit:

1. `requireTeam` + `assertTeamMutable` (`:2609` — only blocks `deleting`/`delete_blocked`) + `assertRevision`.
2. Reject unknown successor (`MEMBER_NOT_FOUND`) and same-as-current (`INVALID_REQUEST`).
3. `updateTeam`: every member's `role` rewritten (`leader` for the successor, `member` for everyone else), `leaderSlotId`, `memberOrder` (successor first), `revision + 1`, `updatedAt`.
4. Activity `team.leader_changed` + `publish('team', …)`.

Nothing else changes. Concretely, today a Leader change leaves:

- **The old Leader's Session running and owned** — `TeamRuntime.owned` (`team-runtime.ts:1317`) still maps its sessionId to the same `(teamId, slotId)`; its AgentHandle is never disposed, no `retiredSessions` entry, still attached to the workspace.
- **The new Leader's Session unchanged** — it keeps whatever context it had as a member; no new Team Session is created, so "the Team Session" (D4) silently changes identity without anything being archived.
- **The task board untouched** — `assigned`/`running` tasks keep their owner and their live `attemptId`; the old attempt stays valid forever.
- **Goals untouched** — `active` Goals stay `active` although nobody is driving them.
- **Queued mail untouched** — the `outbox` and `queued` messages still name members whose prompt no longer gives them Leader authority.
- **The human's open tab unchanged** — `openTeamPage` (`src/client/index.tsx:64`) resolves `members[leaderSlotId].sessionId` on each click, so the sidebar entry moves only after a reload; the already-open session is the *old* Leader's, which is still a member session, so the team tabs (`TeamViewTabs`, `index.tsx:83`) stay visible there.

That is the bug D4 names: a silent reparent in everything but name — old Sessions survive under a new Leader.

### Promotion/removal guards that already exist

- A Leader cannot be removed (`MEMBER_IS_LEADER`, `team-runtime.ts:474`) — the successor must be chosen first. So a Leader change is the only way to retire the current Leader's Session.
- A member owning an open task cannot be removed (`MEMBER_BUSY`). A Leader *change* has no such guard and needs none: tasks are retired by the transition, not blocked by it.
- `contextResetMember` refuses the Leader (`MEMBER_IS_LEADER`); `resetTeam` is the only existing path that already retires *every* Session and mints new ones.

## 2. Session ownership model

- `members[slotId].sessionId` — the only durable membership↔Session link. One Session per slot per team; never shared across teams (`docs/TEAM-MODE-ROADMAP.md`).
- `retiredSessions[sessionId] = {formerSlotId, sessionId, displayName, removedAt}` (`schemas.ts:217`) — durable tombstone, written by `removeMember` (`team-runtime.ts:520`), `clearMemberContext` (`:215`) and `resetTeam` (`:607`). Used only as a display fallback for sender names (`conversation-projector.ts:265`, `team-messages.ts:177`, `team-command-handler.ts:1090`).
- **In-memory ownership** is the authorization source: `TeamRuntime.owned: Map<sessionId, {teamId, slotId, handle, modelSelection}>` plus `activating`. Every `team_*` tool call is gated by `assertToolIdentity` (`:1360`): the calling Agent id must be the owned (or activating) entry for exactly that `(teamId, slotId)` pair; tools are registered per member with `(team.id, member.id)` closed over (`:1144`).
- **No DSH reparent API.** A Session's parent is fixed at create/resume; the only way to "move" a member to a new Leader is a new Session. `clearMemberContext` is the working proof of the pattern: cancel → whenIdle → flush → dispose → workspace detach → retire old → mint `session-${randomUUID()}` → activate.
- **There is no persisted `teamSessionId`.** The aggregate is v2 (`schemas.ts:324`); `docs/TEAM-GROUP-CHAT-ITERATION.md:111` proposed a v3 `teamSessionId` but it was never shipped. D4's "Team Session" is therefore *derived*: `members[leaderSlotId].sessionId`. The audit deliberately keeps it derived (see §5) — a stored copy would be a second source of truth for a fact the roster already carries, and would go stale on Leader context reset.

## 3. Reusable primitives (exact)

| Need | Existing code | Notes |
|---|---|---|
| Take the team lock | `exclusive(teamId, op)` (`team-runtime.ts:1504`) | FIFO per team; queued epoch op runs *after* an in-flight `startTeam` and re-reads state |
| Stop one handle | `cancel({kind:'user'}, {keepInbox})` → `whenIdle` → `sessions.flush` (warn-only) → `owned.delete` → `interactions.forget` → `handle.dispose()` | `clearMemberContext:184-199`, `removeMember:495-506`, `resetTeam:566-586` |
| Detach workspace | `workspace.detachSession(SessionId(old))` (warn-only) | `resetTeam:587-593`, `dissolveTeam:692-700` |
| Retire queued mail | `service.retireQueuedMessages(teamId)` (`dsh-team-mode-service.ts:2110`) | marks `queued` → `failed` |
| Single atomic write | `updateRuntimeTeam(teamId, update, kind, summary)` (`:2085`) over `store.updateTeam` | `KvTable.update` runs the closure inside the domain write chain (`node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js:278`) → read-modify-write is serialized, so two closures can never interleave |
| Ownership-conflict guard | `ctx.agents.get(sessionId)` live but not ours → `AGENT_HANDLE_OWNERSHIP_CONFLICT` | `resetTeam:552-560` |
| Post-crash heal | `recoverTeams` (`:771`) resumes `active \| starting \| error` teams from `members[].sessionId` | a transition interrupted after its write self-heals |
| Error marking | `markTeamError` → `state:'error'` (never overwrites `ownership_conflict`) | `:1493` |

`resetTeam` (`:540`) is the closest existing implementation of "retire every Session, mint new ones, restart": the epoch transition is that, minus the task board wipe, plus the Leader swap and the task/Goal pausing.

## 4. Active task / attempt state at change time

- Statuses: `pending | assigned | running | blocked | completed | failed | cancelled` (`schemas.ts:246`). Dispatching mail exposes a lossy view (`failed`/`cancelled` → `deleted`).
- `attemptId` is minted **only** when a task gains or changes an owner (`createTask:373`, `updateTask:510`) and deleted when the owner is cleared. Member updates must present it; the Leader is exempt.
- `team_mode_task_list` **exposes** `attempt_id` (`team-command-handler.ts:731`), so a member can re-read a rotated token — rotation alone is therefore *not* a lockout.
- Blocking is normally expressed by `dependencyIds`, not by `status:'blocked'` (`docs/raft-collaboration-audit.md §1`). The epoch transition would be the second producer of an explicit `blocked` status; downstream auto-unblock only fires on `completed`/`cancelled`, so a `blocked` task stays blocked until someone moves it.
- Claimable = `pending` **and** unowned **and** no dependencies (`claimTask:615`). A `blocked` task is never claimable, so pausing by status is a real stop, not a soft hint.

## 5. Epoch field spec

```ts
// src/domain/schemas.ts — teamAggregateSchema
/**
 * Leadership generation. Absent on teams that never changed Leader (= 1).
 * Optional on purpose: no schema-version bump, no migration, v1/v2 records
 * open unchanged (same precedent as `goals` and `memory`).
 */
epoch: z.int().positive().optional(),
```

Rules:

- `epochOf(team) = team.epoch ?? 1` — one helper, defined next to `requireTeam` (`dsh-team-mode-service.ts:2572`), used by every reader. Never write `?? 1` inline twice.
- Written **only** by `changeLeader`. `resetTeam`, `clearMemberContext`, `reconnectMember`, removal, archive: untouched. Epoch = leadership generation; session churn inside one leadership generation is not an epoch event.
- `changeLeader` always writes `epochOf(current) + 1`, including on a `draft` team. One rule, no "did anything exist?" branch in the epoch itself.
- **Draft teams rotate nothing** (see §6, step 4): no draft session has ever been activated (`addMember` keeps `offline` until `startTeam`/`activateMember`), so there is nothing to archive. Pre-allocated draft `sessionId`s are left as they are; `startTeam` materializes them.
- Invariants (the ones tests assert):
  1. `members` and `retiredSessions` are disjoint by sessionId — no retired Session is ever a current member Session.
  2. A Session is owned (in memory) only under the epoch that activated it; ownership carries the epoch.
  3. `epoch` is monotonic, `>= 1`, and only `changeLeader` increments it.
- **Not added:** `teamSessionId`. It is derived from `members[leaderSlotId].sessionId`; a stored copy duplicates the roster, needs its own consistency rule, and buys nothing (the UI resolves the Leader Session per click already, `index.tsx:64`). D4's diagram is satisfied by `epoch` + `memberships` + `retiredSessions`.
- **Not added:** per-session epoch in `retiredSessions`. `removedAt` plus the `team.epoch_changed` activity answers "when and under which epoch was this archived"; a second epoch copy would drift.
- Downgrade hazard: `teamAggregateSchema` is `.strict()`, so a plugin downgrade after any epoch write fails to parse that record — identical to the existing `goals`/`memory` situation, i.e. no new class of risk, but it must be stated in the PR.

## 6. Exact transition (Task 2 contract)

`AgentTeamService.changeLeader` keeps its current guards, then branches:

```
successor exists · successor !== current leader          (existing)
if state === 'draft'  → roster swap + epoch + 1, single write, done (no runtime)
else                  → runtime.changeLeaderEpoch(teamId, successorSlotId, { expectedRevision })
```

`TeamRuntime.changeLeaderEpoch` runs inside `exclusive(teamId, …)`:

0. **Re-read under the lock.** Require `state ∈ {active, error}`; otherwise `TEAM_NOT_ACTIVE` (`starting` is fine — the queued op runs after start finished; `ownership_conflict`/`deleting`/`delete_blocked` refuse). Re-check `expectedRevision` inside the lock when given (`TEAM_REVISION_CONFLICT`).
1. `predecessor = leaderSlotId`; re-validate the successor against the fresh record.
2. **Dispose every owned handle** (old Leader first, then members, deterministic order by `slotId`): `cancel({kind:'user'}, {keepInbox:false})` for all, `whenIdle()` for all, then per entry flush (warn-only) → `owned.delete` → `interactions.forget` → `handle.dispose()`. Any live-but-not-owned session aborts first with `AGENT_HANDLE_OWNERSHIP_CONFLICT` (same pre-check as `resetTeam:552-560`).
3. **Detach every old Session** from the workspace (warn-only).
4. **One atomic write** via `updateRuntimeTeam` — this is the commit point and must stay a single closure:
   - `epoch: epochOf(current) + 1`
   - `leaderSlotId: successor`, role swap (`leader`/`member`), `memberOrder` successor-first
   - `members`: every slot gets `sessionId: session-${randomUUID()}`, `desiredState:'online'`, `lastRuntimeState:'starting'`, `lastError` cleared
   - `retiredSessions`: `+` every old sessionId (old Leader included) `{formerSlotId, sessionId, displayName, removedAt}`
   - `tasks`: retire open owned work (see §7)
   - `goals`: `active → paused` (see §7)
   - `leases: {}`, `outbox: { [notice.id]: notice }` (retire queue, then queue exactly the new Leader's handoff notice)
   - `state: 'starting'`, `warmup: {phase:'starting', startedAt, failedSlotIds: []}`
   - activity kind **`team.epoch_changed`**, summary `Team X: Leader changed to Y, epoch N (K tasks blocked, M goals paused)` — no session ids in any user-visible string
   - keep publishing `team.leader_changed` as the change-event kind for the existing client reload path
5. **Start the new epoch**: `ensureWorkspaceReady` → `ensureMemberOnline(next, next.members[successor], false)` (fresh session, so `persisted=false`) → write `state:'active'` + `warmup.phase='leader-ready'` → `void warmupRemaining(teamId)` → `messages.recover` (delivers the handoff notice).
6. **No rollback after step 4.** On activation failure: `markTeamError` (state `error`, epoch stays bumped, sessions stay rotated, tasks stay retired) and rethrow. `recoverTeams` retries from `error` after a restart; a manual `team.warmup.retry` or `reconnectMember` works in between.

Ordering rationale (this is what makes "no old-epoch writes" true): handles are disposed **before** the epoch write, and every aggregate write lands in the same serialized chain as the epoch write. A member write that started before the transition therefore commits *before* the epoch write and is folded into the task retirement; after the epoch write no old AgentHandle exists to produce one. The residual window — a tool call already awaiting inside a handler while the flip runs — is closed by §8 L3.

The handoff notice is a `system` message to `recipient {kind:'leader'}` with: `Team epoch N: you are the Leader. Every previous member Session was archived. K task(s) are blocked and M Goal(s) paused; inspect with team_mode_task_list / team_mode_goal_list, resume a Goal with team_mode_goal_update, then re-dispatch with team_mode_task_update.` It carries no session ids.

## 7. Task and Goal transitions

| Record | Before | After | Next mover |
|---|---|---|---|
| Task `assigned` / `running` | owner + `attemptId` | `status:'blocked'`, **`ownerSlotId` and `attemptId` deleted**, `revision+1`, `updatedAt` | Leader re-dispatch (`owner` + `status:'assigned'` mints a fresh attempt and dispatch mail) |
| Task `blocked` | maybe owner + attempt | same as above | same |
| Task `pending` (unowned) | — | untouched (still claimable) | member `team_mode_task_claim` |
| Task `completed` / `failed` / `cancelled` | — | untouched (history) | Leader only |
| Task `dependencyIds` | — | **untouched** — the graph is new-epoch-neutral and the Leader must not have to rebuild it | — |
| Goal `active` | — | `status:'paused'` | Leader `team_mode_goal_update {status:'active'}` |
| Goal `completed` / `cancelled` | — | untouched | — |

Why drop the owner instead of rotating the attempt and keeping it: a kept owner with a fresh token is readable by that member from `team_mode_task_list` and invites the member to resume on its own, which contradicts D4's "new Leader explicitly resumes or re-dispatches". Dropping the owner makes the pause real: the task leaves every member inbox (`assigned` needs `ownerSlotId=me`), is not claimable (`blocked`), and stays visible in the board and in `team_mode_goal_list`'s `task_ids`. Re-dispatch is a single `team_mode_task_update` call that mints the token and sends the attempt hint, so no lockout.

**Required companion change — Goal resume has no surface today.** `service.updateGoal` (`:1188`) has **no** transport method and **no** tool (`AGENT_TEAM_METHODS`, `src/runtime/team-tools.ts` — only `team_mode_goal_create` / `team_mode_goal_list`). Without a write path, a `paused` Goal is permanently stuck and D4 step 7 is unimplementable. Add, in the same task:

- `teamGoalStatusSchema` (`schemas.ts:227`) gains `'paused'`; `updateTeamGoalInputSchema` (`:546`) reuses it, so `paused → active` is expressible.
- `team.updateGoal` transport method: `{teamId, goalId, value: UpdateTeamGoalInput}` → `TeamGoal` (`web.ts` case + `AGENT_TEAM_METHODS`).
- Tool `team_mode_goal_update` `{goal_id, status}` — Leader-only (`assertLeader`), calls `service.updateGoal`. Add the name to the `SHARED_RULES` tool list (`team-prompts.ts:11`), to `team-tools.spec.ts` (`expect(tools.size).toBe(23)` → **24**), and to `docs/tools.md`.
- UI: `GOAL_STATUS_LABELS` (`src/client/labels.ts:90`) gains `paused: '已暂停'`; the badge in `TeamPanel.tsx:1605` already renders any non-`active` status, so it needs only a style branch (reuse `goalStatusBadgeMuted`, or add a warning tone).

## 8. Write fencing (three layers, one new error code)

New error code in `src/domain/errors.ts`: **`EPOCH_STALE`**, details `{teamId, epoch, expectedEpoch}`. Message must be model-actionable: `Team epoch changed to N; this Session belongs to epoch M and is read-only. Wait for the Leader to re-dispatch or ask the user to reopen the team.`

**L1 — identity gate (all tool calls).** `TeamRuntime.assertToolIdentity` (`:1360`) additionally verifies (a) the live mapping's session equals the session the tool closure was registered for — pass `member.sessionId` into the closure and compare, not just `slotId` — and (b) `epochOf(service.getTeam(teamId)) === owned.epoch`. `owned`/`activating` entries gain `epoch` (set in `ensureMemberOnline:1317` / `:1092`). This is one place and it covers every `team_*` tool, because each `execute` already starts with `handlers.assertIdentity(exec.agent)`.

**L2 — activation re-check (closes the warmup race).** `warmupRemaining` (`:903`) runs outside `exclusive`, so an activation can be in flight during the flip. Immediately before `owned.set(...)`, re-read the aggregate: if `members[slotId]?.sessionId !== member.sessionId` or `epochOf(current) !== epochAtStart`, then flush → dispose → `interactions.forget` → throw `EPOCH_STALE` (do **not** register the handle). This is the only durable defence against a resurrected old Session.

**L3 — serialized write fence.** `updateRuntimeTeam` gains an optional `{ expectedEpoch?: number }`; inside the `store.updateTeam` closure compare `epochOf(current)` and throw `EPOCH_STALE` on mismatch. Member-authored mutations pass the caller's epoch: `updateTask`, `claimTask`, `sendMessage`, `createGoal`, plus Leader-only `createTask` / `memory` decides. Closes the "handler awaited across the flip" window: read-modify-write is serialized (`KvTable.update`), so the mismatch is detected before anything is written.

Application-level consequence: an old-epoch Session's transcript stays readable, but every team tool it could still reach refuses with `EPOCH_STALE` instead of writing.

## 9. Session archive behaviour (definition)

Archive means, for every member Session of the old epoch **including the old Leader's**:

1. Cancelled (`{kind:'user'}`, `keepInbox:false`) and awaited, so no turn is left running.
2. Flushed to durable storage (best-effort; a flush failure is logged, never fatal).
3. Disposed — the AgentHandle is gone, so DSH will not run it and the plugin cannot deliver to it.
4. Detached from the workspace, so it cannot touch files through the session attachment.
5. Tombstoned in `retiredSessions` (durable, display-only fallback for sender names).
6. Removed from `members`, so no team tool, no mailbox recipient, and no `openSession` resolution can address it.
7. Its pending mail retired (`queued → failed`), and the aggregate `outbox` cleared, so a recovery pass cannot replay old-epoch instructions.
8. Its transcript kept: the DSH session log on disk is **never deleted**; team messages keep their `sender.id = slotId`, so history still renders with the correct display name.

Read-only is therefore structural (no handle, no membership, no mail, no workspace attachment), not a flag. The aggregate keeps no "archived epoch" directory: the current `retiredSessions` set is the archive, and `team.epoch_changed` activity rows are the timeline.

`docs/team-management.md` §更换 Leader must be rewritten from "原 Leader 变为普通成员" to this behaviour.

## 10. UI / API

- `TeamView = TeamAggregate` (`contracts.ts:100`), so `epoch` reaches the client with no wire change. No new read method.
- **Show, don't leak:** a small `Epoch N` tag in `TeamCard`'s header, rendered only when `epochOf(team) > 1`; never show session ids in labels, activities, or messages.
- **Confirmation dialog** (new, `AnimatedModal`, pattern of `resetOpen`): changing Leader now stops every member Session. Body: old Leader's conversation is archived, every member gets a fresh Session, open tasks are blocked, active Goals are paused; the page will switch to the new Leader Session. This is required — the operation is no longer a one-field roster edit.
- **Follow the new Leader:** the change response is the new `TeamView`; call `openSession(view.members[view.leaderSlotId].sessionId)` after success. Thread an optional `onOpenSession?: (sessionId: string) => void` from `TeamManageView` (`src/client/team-manage.tsx:17`, it already receives `uiWorkspace.openSession`) into `TeamCard`; the sidebar path (`openTeamPage`) already resolves the current Leader.
- **Old tab:** once rotated, the old Session is no longer a member Session, so `TeamViewTabs` (`index.tsx:83`) and `teamForSession` (`team-manage.tsx:9`) stop matching and the team views disappear from it. Verify the sidebar row for a now-retired Session (was hidden by `SessionRowHider` while a member) either stays hidden or reads as history; decide in Task 2 and test it.
- i18n: `src/client/team-i18n.ts` (zh + en) gains `leaderChange.title` / `leaderChange.body` / `leaderChange.confirm` / `epoch.tag`.

## 11. Files

Audited (read-only): `src/domain/schemas.ts`, `src/domain/types.ts`, `src/domain/errors.ts`, `src/service/dsh-team-mode-service.ts`, `src/runtime/team-runtime.ts`, `src/runtime/team-command-handler.ts`, `src/runtime/team-tools.ts`, `src/runtime/team-prompts.ts`, `src/runtime/team-message-dispatcher.ts`, `src/runtime/conversation-projector.ts`, `src/storage/{domain,store,migration}.ts`, `src/transport/{contracts,web}.ts`, `src/client/{index.tsx,team-manage.tsx,labels.ts,team-i18n.ts,AgentTeam.module.css}`, `src/client/teams/TeamPanel.tsx`, `docs/DECISIONS-IDENTITY-MEMORY.md`, `docs/TEAM-MODE-ROADMAP.md`, `docs/TEAM-GROUP-CHAT-ITERATION.md`, `docs/team-management.md`, `docs/tools.md`, `tests/*.spec.ts`.

Expected to change in Task 2: `schemas.ts` (epoch + `paused`), `errors.ts` (`EPOCH_STALE`), `dsh-team-mode-service.ts` (epoch helper, `changeLeader` branch, `updateRuntimeTeam` `expectedEpoch`), `team-runtime.ts` (`changeLeaderEpoch`, ownership `epoch`/`sessionId` binding, `assertToolIdentity`, `ensureMemberOnline` re-check), `team-command-handler.ts` (epoch on member writes), `team-tools.ts` (epoch args + `team_mode_goal_update`), `team-prompts.ts` (tool list + Leader epoch line), `contracts.ts` + `web.ts` (`team.updateGoal`), client files in §10, the docs listed in §9/§7/§12. **No change** to `migration.ts`, `storage/domain.ts`, `schemaVersion`; no new backend version.

## 12. Tests

Existing seams:

- `tests/agent-team-service.spec.ts:828` — draft promote/remove; the legacy regression that must still pass (assert `epoch` becomes 2, no `retiredSessions` written, no runtime call). Harness: `createHarness`, `runtimeInternals`, `fakeAgent`, `fakeOwned` (`:1988`, `:2213`).
- `tests/team-runtime-support.spec.ts:75` — aggregate parses with/without optional fields; extend for `epoch`.
- `tests/team-command-handler.spec.ts` — `makeTeam()` fixture at epoch 1; add member-write fence cases.
- `tests/team-tools.spec.ts:120` — `expect(tools.size).toBe(23)` → 24, plus the new tool name in `primary`.
- `tests/team-runtime-support.spec.ts:41-80` — prompt assertions: new tool name in `SHARED_RULES`, epoch line in `memberPrompt`.
- `tests/client-labels.spec.ts` / `tests/client-goal-ui.spec.ts` — paused label + badge.
- `tests/transport-contracts.spec.ts` — `team.updateGoal` payload/result types; method list uniqueness already covered.

New coverage (one case each, no framework beyond Vitest):

1. **Schema**: `epoch: 2` parses; absent epoch + `epochOf` → 1; `epoch: 0` and `epoch: 1.5` rejected.
2. **Draft**: promote → epoch 1→2, revision +1, roles swapped, `retiredSessions` still `{}`, sessionIds unchanged, runtime never called.
3. **Active transition**: with a fake owned handle per member — old Leader **and** every member: `cancel({kind:'user'},{keepInbox:false})`, `whenIdle`, `flush`, `dispose` called once; `owned` empty; every old sessionId in `retiredSessions` with its `formerSlotId`; every `members[].sessionId` changed; `epoch === 2`; `leaderSlotId === successor`; state `active`; `workspace.detachSession` called per old session.
4. **Task retirement**: `assigned`/`running`/`blocked` → `blocked` with no `ownerSlotId`/`attemptId`, `revision+1`; `pending`, `completed`, `failed`, `cancelled` untouched; `dependencyIds` preserved; the board count unchanged.
5. **Goal retirement**: `active → paused`; `completed`/`cancelled` untouched; `task_ids` still group under the paused Goal.
6. **Mail**: a `queued` message becomes `failed`; `outbox` holds exactly the new handoff notice; after the leader is online it is `delivered` to the **new** session.
7. **Failure path**: `ensureMemberOnline` throws → state `error`, epoch stays bumped, sessions stay rotated, `retiredSessions` recorded, no rollback.
8. **Fence L1**: owned entry epoch 1 + team epoch 2 → any `team_*` tool throws `EPOCH_STALE` and the aggregate `revision` is unchanged.
9. **Fence L2**: activation completes while the epoch flips → handle disposed, `owned` empty, `EPOCH_STALE`.
10. **Fence L3**: `updateTask` with `expectedEpoch` 1 against epoch 2 → `EPOCH_STALE`, task byte-identical.
11. **No stale revival**: after a transition, `recoverTeams` resumes only the new sessionIds (old ones stay retired).
12. **Goal update tool**: Leader-only (`INVALID_REQUEST` for a member), `paused → active` round-trip, unknown goal → `INVALID_REQUEST`.
13. **Client**: epoch tag hidden at 1 / shown at 2; paused label; confirm dialog calls the API once and calls `openSession` with the new Leader Session.

Verification: `npm run check` (guard + typecheck + tests + build) — the repo's required gate.

## 13. Risks

1. **Old-Session resurrection after a plugin reload.** `owned` is in memory; a retired Session that survives a failed dispose is caught only when it was still in `members`. A retired Session resumed out-of-band has no team tools (registered per Agent scope), so the fence holds — but this is an argument from construction, not a test. Add the `retiredSessions` disjointness assertion (L2/test 11) and treat "live session id ∈ retiredSessions" as `EPOCH_STALE` if it is ever observed.
2. **`changeLeader` becomes destructive and long.** It can take seconds (N × cancel/flush/dispose/activate). The transport call has no progress channel; the UI must show a busy state and the confirm dialog must warn. Timeouts must not be retried blindly — a retried transition would bump the epoch twice.
3. **Two concurrent transitions.** `exclusive` serializes them, but `expectedRevision` is checked before queueing today (§4 of the service). Re-check it inside the lock or a second click can stack a second epoch bump. This is the one guard the current code shape does not already give you.
4. **Crash between disposal and the epoch write** leaves `members[].sessionId` pointing at dead Sessions. Recoverable (`recoverTeams` resumes by sessionId, and the retired-tombstone write happens in the same later write), but it means the write must stay a *single* closure — splitting the epoch bump from the roster rotation reintroduces a half-transitioned state.
5. **Paused Goals had no resume path** before this plan; shipping `paused` without `team_mode_goal_update` would strand every paused Goal. The two must land together (§7).
6. **Client UX gap:** the human's currently open Session becomes a dead end (team views vanish, no redirect). Without the `openSession` hand-off in §10 this reads as "the app lost my team".
7. **Strict-schema downgrade:** any record written with `epoch` (or `paused`) fails to parse under an older plugin build. Same precedent as `goals`/`memory`; call it out in the PR and in `docs/migration-*.md` if a release note is cut.
8. **Activity/message strings leak session ids.** `updateRuntimeTeam`'s `summary` is user-visible; every new summary must be built from slot/display names and counts only. The review focus explicitly asks for "epoch without internal session ids".
9. **`retiredSessions` growth** is unbounded (now +N per epoch change, on top of context resets). Records are tiny and reads are `Object.values` over a handful of entries; retention is a separate concern — do not build a cap into this task.
10. **`team_clear_agent_context` / `contextResetMember` rotate a Session without an epoch bump.** That is correct by design (same leadership generation), but it means "the Session changed" alone can never be the staleness test — only the epoch is. Keep L1 comparing *both* session and epoch, and keep the invariant doc explicit, or a future refactor will conflate them.
11. **Tool-count and prompt-list coupling** (`team-tools.spec.ts:120`, `team-prompts.ts:11`) is the only place a new tool is announced; missing either means the model never calls `team_mode_goal_update` and paused Goals silently stay paused.
12. **`ownership_conflict` is terminal for this operation.** The transition refuses it rather than guessing; the UI must surface that state instead of a generic failure, and the user must clear it via the existing conflict path.
