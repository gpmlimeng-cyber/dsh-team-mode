# Task Quality Gates Audit — kinds, acceptance, reviewed task, verdict

> Task 1 of `docs/superpowers/plans/2026-10-23-quality-gates.md`. Read-only audit of the task lifecycle; no source code changed.
> Spec: `docs/TEAM-MODE-ROADMAP.md` P1 任务协议 · 质量门禁; `docs/TEAM-STEWARD.md` §6.
> Sibling format: `docs/research/team-epoch-audit.md`.

## 1. Where a task is created, owned, updated, and viewed today

| Layer | Symbol | What it does |
|---|---|---|
| Tool | `team_mode_task_create` (`src/runtime/team-tools.ts:324`), aliases `team_create_task` (`:543`) | Leader-only create; params `subject/description/owner/blocked_by/goal_id` (`:326-332`) |
| Tool | `team_mode_task_update` (`:353`), alias `team_update_task` (`:570`) | `task_id/status/owner/blocked_by/attempt_id`; the alias additionally exposes `result/error` (`:579-580`) |
| Tool | `team_mode_task_claim` (`:388`), `team_mode_task_list` (`:421`), `team_mode_inbox` (`:408`) | claim one ready task; read board / read-only inbox |
| Runtime wiring | `registerTeamTools(agentCtx, {...})` (`src/runtime/team-runtime.ts:1353`) | closes over `(team.id, member.id, epochAtStart)`; every call re-asserted by `assertToolIdentity` |
| Handler | `TeamCommandHandler.createTask` (`src/runtime/team-command-handler.ts:353`), `updateTask` (`:436`), `claimTask` (`:626`), `listTasks` (`:724`), `taskView` (`:734`), `inbox` (`:1062`) | all authority, fences, transitions, and projections live here |
| Service | `updateRuntimeTeam` (`src/service/dsh-team-mode-service.ts:2121`) | one atomic aggregate write inside `store.updateTeam`; `expectedEpoch` fence; activity + publish |
| Schema | `teamTaskSchema` (`src/domain/schemas.ts:251-277`), `.strict()` | persisted shape; store parses every team through `teamAggregateSchema` (`src/storage/domain.ts:62`) |
| Projection | `TeamView = TeamAggregate` (`src/transport/contracts.ts:103`) | no task transport methods exist; board reads tasks straight off the aggregate (`src/client/team-board.tsx:16-17`, `:1055`) |

### Create

`createTask` (`:353`) → `assertLeader` (`:1506`) → normalize title/description/owner/blockers/file scopes/goal → task limit → mint `taskId` and (owner only) `attemptId` → write task `status` `pending` (no owner) or `assigned` (owner) → optional assignment mail + `deliverMessage`. Stored fields: `id/title/description/status/ownerSlotId?/attemptId?/createdBySlotId/dependencyIds/fileScopes/goalId?/revision/createdAt/updatedAt` (`:402-416`).

### Owner / attempt

- `attemptId` is minted when the task gains an owner at create (`:381`), on claim (`:654`), and rotated only on an *actual* owner change (`:519-520`). Re-sending the current owner is a no-op; legacy tasks stay unfenced until the first owner change.
- Member writes must present the current token (`:490-510`); Leader writes skip the fence. All checks run **inside** the serialized closure against the rebased `base`, not the pre-read snapshot.
- Claim eligibility (`pending` + no owner + no `dependencyIds`) is rechecked in the same closure (`:669-700`); a re-claim by the current owner is a read.

### Update / transitions

`updateTask` (`:436`) has no transition table: any owner/Leader write may set any status. `TASK_STATUS_ALIASES` (`:305-315`) maps tool vocabulary (`in_progress`→`running`, `deleted`→`cancelled`) onto the seven internal statuses. Completing or cancelling clears downstream blockers and wakes unblocked owners (`:541-545`, `clearDownstreamBlockers:1626`). A member update also mails the Leader a status record (`:561-570`, `taskMessageType` in `src/runtime/team-messages.ts:159`).

### Other task writers (must keep working)

| Writer | Effect on quality fields |
|---|---|
| `retireOpenTasks` (`src/runtime/team-runtime.ts:1785`) | epoch change: `assigned/running/blocked` → `blocked`, drops owner + attempt, **spreads the rest** (kind/acceptance/reviewedTaskId survive) |
| `linkTaskToGoal` (`src/service/dsh-team-mode-service.ts:1228`) | touches `goalId` only |
| `resetTeam` (`:1937` → `team-runtime.ts:552`) | `tasks: {}` |
| `cloneTeam` (`:1507`) | copies configuration only, no tasks |

### Views

- `TeamTaskView` (`:76-97`) is the model-facing projection for `team_mode_task_list` / `team_mode_inbox`; built by `taskView` (`:734-758`) with present-only optional keys.
- Board (`team-board.tsx`) and manage page (`TeamPanel.tsx:368/459`) consume `TeamTask` from the aggregate; both already render `description`, `error` (`team-board.tsx:1094`) and `result` (`:1097`).
- There is **no** `team.task.*` client API despite `docs/tools.md:109`; tasks reach the UI only through `TeamView`.

## 2. Where the gate must live

One place: inside `updateTask`'s serialized closure (`team-command-handler.ts:481-601`), after the owner/attempt fence and before the write. Reasons:

- The closure re-reads `base` from the aggregate being written, so the gate sees the task's *current* kind and owner even if a reassignment/claim landed since the caller read the board (same argument as `:484-510`).
- A check before `updateRuntimeTeam` could be raced: Leader reassigns a review task, an old owner completes it with `pass` — the fence and the verdict authority check must both run against `base`.
- No other write path can reach `completed`, so no duplicate gate is needed in `claimTask`, `linkTaskToGoal`, epoch retirement, or `resetTeam`.

Creation-time validation (kind enum, acceptance bounds, `reviewedTaskId` target) lives in `createTask` before the write, matching how `goal_id` is validated once at create (`:366-367`).

## 3. Field contract

Four optional fields on `teamTaskSchema`, no `schemaVersion` bump, no migration. Legacy rows lack all four and parse unchanged.

```ts
// src/domain/schemas.ts, next to teamTaskSchema
export const teamTaskKindSchema = z.enum([
  'work',            // default; ordinary task, no verdict gate
  'implementation',  // reviewable deliverable
  'repair',          // reviewable fix of a previous failure
  'verification',    // quality gate: completes only with verdict=pass
  'review',          // quality gate: completes only with verdict=pass
])
export const teamTaskVerdictSchema = z.enum(['pass', 'needs_revision', 'reject'])

// teamTaskSchema additions
kind: teamTaskKindSchema.optional(),
acceptance: z.string().optional(),
reviewedTaskId: nonEmpty.optional(),
verdict: teamTaskVerdictSchema.optional(),
```

| Field | Shape | Default | Bounds / normalization | Mutability |
|---|---|---|---|---|
| `kind` | enum above | stored as `'work'` on create when omitted | reject unknown values (`INVALID_REQUEST`) | create-only; no update param exists |
| `acceptance` | `string` | absent | trim; blank → absent; max 2,000 chars (same bound as `Goal.objective`) | create-only |
| `reviewedTaskId` | task id in the same team | absent | trim; non-empty, ≤200; same team; not the task itself; target kind `implementation`/`repair` (or absent, see §11 D3); only on `review`/`verification` | create-only |
| `verdict` | enum above | absent | only on `review`/`verification`; only by the task owner; `pass` only with `completed`; `needs_revision`/`reject` only with `failed` and non-empty findings | written on the terminal update; deleted when the task leaves a terminal status |

Readers: follow the `epochOf` precedent (`src/domain/types.ts:82`) — one exported helper, no inline `?? 'work'`:

```ts
export type TeamTaskKind = z.infer<typeof teamTaskKindSchema>
export type TeamTaskVerdict = z.infer<typeof teamTaskVerdictSchema>
export function taskKindOf(task: Pick<TeamTask, 'kind'>): TeamTaskKind {
  return task.kind ?? 'work'
}
```

Newly created tasks always persist `kind` (including `'work'`); `taskKindOf` exists for the legacy rows that carry none, and is the only reader that maps absent → `work`.

### Findings

No fifth field. `needs_revision`/`reject` require non-empty `findings`, stored in the existing `task.error` (`schemas.ts:273`). This reuses the field the board already renders (`team-board.tsx:1094`) and that the status mail already forwards as `Error:` (`team-messages.ts:155`), so findings surface with zero projection changes. `verdict=pass` clears a stale `error` from an earlier failed round.

## 4. Tool surface diff (24 tools unchanged)

Primary tools gain optional params; **aliases stay frozen** at their current shape (documented as legacy, `team-tools.ts:529-530`).

`team_mode_task_create` (`team-tools.ts:326-332`):

| Param | Type | Notes |
|---|---|---|
| `kind` | string enum `work/implementation/repair/verification/review` | omit = `work` |
| `acceptance` | string | done-when statement |
| `reviewed_task_id` | string | `review`/`verification` only; forwarded as `reviewedTaskId` |

`team_mode_task_update` (`:355-366`):

| Param | Type | Notes |
|---|---|---|
| `verdict` | string enum `pass/needs_revision/reject` | review/verification only; owner only |
| `findings` | string | required with `needs_revision`/`reject`; stored as `error` |

Results:

- `create` adds `kind` (and `reviewed_task_id` when present).
- `update` adds `verdict` when one was recorded, and keeps returning `attempt_id`.
- `team_mode_task_list` / `team_mode_inbox` `TeamTaskView` adds present-only `kind`, `acceptance`, `reviewed_task_id`, `verdict`.

Handler input types (`team-command-handler.ts:143-155`, `:225-238`) gain `kind?`, `acceptance?`, `reviewedTaskId?`/`reviewed_task_id?`, `verdict?`, `findings?`. Update intentionally has **no** kind/acceptance/reviewedTaskId input: immutability is structural, not a guard that can be forgotten.

## 5. Transitions and authority

Open = `pending | assigned | running | blocked`; terminal = `completed | failed | cancelled`. Aliases: `in_progress`→`running`, `deleted`→`cancelled`.

| Current | Next | Kind scope | Verdict requirement |
|---|---|---|---|
| any | any open | any | none |
| open / failed / cancelled | `completed` | `review`/`verification` | `verdict=pass` mandatory; `findings` forbidden |
| any | `completed` | other kinds | verdict forbidden; `findings` forbidden |
| open / failed / cancelled | `failed` | `review`/`verification` | allowed without verdict (infra failure); `needs_revision`/`reject` require non-empty findings; `pass` rejected |
| open / completed | `failed` | other kinds | verdict forbidden |
| any | `cancelled` | any | no verdict; a stored verdict is deleted (cancelled is not a decision) |
| completed (pass) | any open | `review`/`verification` | reopen allowed (existing rules); stored verdict deleted, so the next completion needs a fresh one |

Idempotence: re-sending `completed` + `verdict=pass` on an already-completed review is accepted (same as today's repeated status writes) and rewrites the same fields.

| Action | Authority |
|---|---|
| create task, set `kind`/`acceptance`/`reviewedTaskId` | Leader only (`assertLeader`, `:1506`) |
| open-status moves, owner reassignment, blockers | task owner or Leader (unchanged, `:452-475`) |
| complete / fail / cancel | task owner or Leader (unchanged) |
| record `verdict` | **task owner only**, even when the caller is the Leader; a non-owner Leader must reassign the task first (mints a fresh `attemptId`, `:519-520`) |
| claim | any member, unchanged eligibility (`:669-700`) |

The owner-only rule resolves the plan's internal tension (§11 D1). It also makes "Leader cannot pass its own review unless it is the review owner" explicit, matching `docs/TEAM-STEWARD.md` §6 ("不把成员说完成当成完成").

## 6. Errors (all `INVALID_REQUEST`, existing code)

| Situation | Message (stable prefix) | `details` |
|---|---|---|
| review/verification completes without verdict | `Review or verification task '<title>' can complete only with verdict=pass.` | `{taskId, kind}` |
| verdict on a non-quality kind | `Task '<title>' is kind '<kind>'; a verdict applies only to review and verification tasks.` | `{taskId, kind}` |
| non-owner records a verdict | `Only the task owner may record a verdict.` | `{taskId, owner}` |
| `pass` without `completed` | `verdict=pass requires status=completed.` | `{taskId, status}` |
| `needs_revision`/`reject` without `failed` | `verdict=<verdict> requires status=failed.` | `{taskId, status}` |
| failing verdict without findings | `verdict=<verdict> requires findings; the task fails with them.` | `{taskId, verdict}` |
| findings without a failing verdict | `findings are accepted only with verdict=needs_revision or reject.` | `{taskId}` |
| unknown / foreign / wrong-kind review target | `reviewed_task_id must name an implementation or repair task of this team.` | `{taskId: reviewedTaskId}` |
| `reviewed_task_id` on another kind | `reviewed_task_id applies only to review and verification tasks.` | `{kind}` |
| bad enum / over-long acceptance | `Unknown task kind '<value>'…` / `Task acceptance is too long` (mirror `requireShortText`, `:1674`) | — |

## 7. Legacy behavior (must stay byte-for-byte in behavior)

1. Rows without the four fields parse (`optional()`), and `parse → serialize` does not introduce keys.
2. `taskKindOf(legacy) === 'work'`, so completing an old task demands no verdict.
3. `TeamTaskView` omits absent fields instead of emitting `undefined`/`null` (same pattern as `goal_id`, `:746`).
4. Aliases `team_create_task` / `team_update_task` / `team_get_task_board` keep their exact parameter objects; old prompts cannot hit the gate except by trying to complete a kinded task, which fails closed with an actionable message.
5. Board/manage UI code, CSS, and transport contracts are untouched (`TeamView = TeamAggregate`; extra keys ride along and are ignored).
6. Epoch retirement keeps `kind/acceptance/reviewedTaskId`; `failed`+`needs_revision` review tasks are terminal, so retirement never silently re-opens one.
7. `team.reset` still clears every task; `cloneTeam` still creates none.

## 8. Docs and prompt surface

- `docs/tools.md`: update rows 14-17 (params), add a `## 任务质量门禁（P0）` section after the attempt/claim sections, and retire `docs/tools.md:44` ("本轮不包含 … 质量门禁"). Fix or drop the stale `team.task.*` API row (`:109`).
- `src/runtime/team-prompts.ts`:
  - `SHARED_RULES` (`:11-15`): one sentence — "A review or verification task completes only with verdict=pass; to fail it, pass verdict=needs_revision or reject together with findings." Tool list stays at 24 names.
  - `rosterPrompt` (`:134`): extend the board-status line with the kind/verdict rule so members see it on every turn.
- `docs/TEAM-STEWARD.md` already asks for verification/review gating; no change required.

## 9. Implementation map for Task 2

| File | Change |
|---|---|
| `src/domain/schemas.ts` | add `teamTaskKindSchema`, `teamTaskVerdictSchema`; four optional fields on `teamTaskSchema` (`:251-277`) |
| `src/domain/types.ts` | export `TeamTaskKind`, `TeamTaskVerdict`, `taskKindOf` (`:67-83`) |
| `src/runtime/team-command-handler.ts` | `CreateTaskInput`/`UpdateTaskInput`/`TeamTaskView`; create validation (`:353-434`); gate in the update closure after the fence (`:510`, before building `updated` at `:521`); persist verdict/clear stale error; `taskView` (`:734`); helpers near `normalizeGoalId` (`:1690`) |
| `src/runtime/team-tools.ts` | params + forwarding on `team_mode_task_create` (`:324`) and `team_mode_task_update` (`:353`); echo `kind`/`verdict`; aliases untouched |
| `src/runtime/team-prompts.ts` | shared rule + roster line |
| `docs/tools.md` | table + new section |
| tests | see §10 |

Order: schema/types → handler (gate + views) → tools → prompt/docs → tests. No client, transport, storage, or migration files.

## 10. Focused tests

`tests/team-command-handler.spec.ts` (existing harness at `:88`; adds behavior coverage):

1. `stores kind, acceptance and the reviewed task on a Leader-created review task`
2. `refuses an unknown, cross-team or non-implementation reviewed task` (cross-team: `makeOtherTeam` id from `:86`)
3. `requires verdict=pass before a review task can complete` — status stays unchanged, revision not bumped
4. `fails a review task with needs_revision findings and stores them as the error`
5. `refuses needs_revision or reject without findings and does not mutate the board`
6. `refuses a verdict from a member who does not own the task, including the Leader`
7. `lets a Leader who owns the review task record a verdict`
8. `applies the same gate to verification tasks`
9. `rejects verdict and findings on an ordinary work task`
10. `requires a fresh verdict after a completed review is reopened`
11. `clears stale findings when a later pass completes the review`
12. `lets the claiming member complete a claimed review task with a verdict` (attempt fence + verdict together)
13. `keeps a legacy task claimable and completable without a verdict`
14. `exposes the quality fields on the board view only when present`

`tests/team-tools.spec.ts` (`:18-33` harness):

15. `declares the quality parameters and their enums on task create and update`
16. `forwards kind, acceptance and reviewed_task_id from create and omits absent defaults`
17. `forwards verdict and findings from update and leaves the legacy aliases without them`

`tests/agent-team-service.spec.ts`:

18. extend `loads teams and tasks written before Goals existed` (`:431`, `seedTask:2632`) or add `loads task rows written before quality fields existed`: undefined fields, `taskKindOf === 'work'`, no new keys after re-serialize
19. `persists kind, acceptance, reviewedTaskId and verdict through the aggregate` (parse the stored record, not just the returned view)

`tests/team-runtime-support.spec.ts`:

20. `documents the verdict gate for review and verification tasks` (prompt contains the sentence; tool-name list unchanged)

Not needed: `tests/client-task-progress.spec.ts`, board/UI tests, transport tests — no projection or wire changes.

## 11. Risks and decisions

- **D1 — Leader vs owner authority (plan contradiction).** Plan Global Constraints say "Review/verification authority remains owner/Leader"; Review Focus says "Only review owners can set verdict". Decision: owner-only; a Leader may reassign to itself (fresh attempt) and then record the verdict. If the captain prefers the looser reading, the only change is one predicate; the tests in §10.6 must flip.
- **D2 — Findings field.** No fifth task field; findings reuse `error`. Tradeoff: `error` is untyped text. Acceptable in P0 because the board and status mail already render it; structured findings belong to the future repair loop.
- **D3 — Reviewing a legacy task.** Plan says the target must be `implementation`/`repair`; a pre-vocabulary task has no kind. Decision: allow an absent kind as a target (it predates the enum and cannot be relabeled otherwise); everything else is rejected. Cost: one extra condition; keeps old boards usable without a migration.
- **D4 — Kinds deliberately omitted.** The roadmap names requirements → implementation → verification → review → integration, but only `implementation`/`repair` (link targets) and `review`/`verification` (gate) carry a rule today. `requirements`/`integration` would be labels with no enforcement; adding them later is a one-line enum change with no migration. Flag if the captain wants the full five now.
- **D5 — Self-review is not prevented.** Nothing stops the implementer from being assigned the review of its own implementation; only the Leader's assignment discipline does. Out of P0 (needs authorship/ownership rules); note in `docs/tools.md`.
- **D6 — No repair loop.** `needs_revision` fails the review task and mails findings; re-dispatch is a manual Leader task. Auto-creating the repair task is explicitly out of P0 (plan Global Constraints).
- **D7 — Downgrade compatibility.** `.strict()` schemas mean an older plugin build cannot parse a record that contains the new fields. Same precedent as `goals`, `memory`, `epoch`; acceptable, but rollback after a team wrote a kinded task is not supported.
- **D8 — Stale verdict visibility if reopen is done by `delete` semantics.** Handled by the rule "delete verdict whenever the next status is not `completed`/`failed`", so the board never shows a `pass` on an open task.
- **D9 — Docs drift already present.** `docs/tools.md:109` advertises `team.task.*` client APIs that do not exist; the same pass should fix or remove it so Task 2 does not inherit a false claim.
- **D10 — Tool-count claims.** No new tool, so `docs/tools.md:3` ("24 个") and `team-prompts.ts:11` stay valid; tests assert the list unchanged.

## 12. Out of scope (unchanged by this plan)

Board badges/filters for kind or verdict, structured acceptance results, `changedPaths`/`commandsRun` per task, auto-repair or auto-review scheduling, timeout reminders, and any client/transport/API addition.
