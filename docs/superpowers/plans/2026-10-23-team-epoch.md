# Team Epoch Implementation Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Make Leader changes an explicit Team Epoch instead of silently keeping old leader/member Sessions under a new leader.

**Architecture:** Add a persisted `epoch` to the team aggregate (default 1). On Leader change, increment epoch, archive the old Team Session, and require new/re-created membership Sessions; active tasks are paused/blocked with attempts invalidated. No reparenting (DSH has no reparent API).

**Spec:** `docs/DECISIONS-IDENTITY-MEMORY.md` D4.

## Global Constraints

- No schema-version bump; optional epoch defaults to 1.
- No silent session reparent.
- Old epoch is read-only history; no writes through it.
- Explicit user/Leader action only; no automatic leader switch.
- `npm run check` passes.

## Review Focus

- Legacy teams without epoch behave unchanged.
- changeLeader increments epoch once and archives old sessions/tasks correctly.
- No old member Session can write into the new epoch.
- Active Goal/Task status transitions are explicit; attempts invalidated.
- UI/API shows current epoch without exposing internal session IDs.

---

### Task 1: Audit leader-change/session flow

Findings: `docs/research/team-epoch-audit.md` (exact fields, ordered transition, task/Goal table, fence layers, archive definition, files/tests/risks).

- [x] Map changeLeader, member session ownership, task/attempt state, and runtime disposal.
- [x] Define epoch fields/transition and compatibility.

### Task 2: Implement epoch transition

Implementation: `epoch` schema/helper/errors, `changeLeaderEpoch` transition, EPOCH_STALE fences (L1/L2/L3), Goal `paused` + `team_mode_goal_update` + `team.updateGoal`, client confirm/epoch tag/paused labels, docs. Verification: `npm run check` (400 tests).

- [x] Add optional epoch; increment on changeLeader.
- [x] Archive old sessions/tasks, invalidate attempts, require new membership sessions.
- [x] Add focused tests.

### Task 3: Verify
### Task 4: Review
