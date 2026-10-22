# Task Attempt Ownership Fencing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use the AgentTeams plan for execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale task updates after reassignment/takeover by requiring the current attempt token on member updates.

**Architecture:** Add an optional `attemptId` to `TeamTask`. Generate a fresh attempt whenever a task gains or changes an owner. Member updates must present the current attempt; leader reassignment rotates it. Preserve leader-only authority and legacy tasks without an attempt.

**Tech Stack:** TypeScript, Zod, Cordis, Vitest.

**Spec:** `docs/TEAM-MODE-ROADMAP.md` P0 “attempt / ownership fencing”.

## Global Constraints

- No schema version bump; `attemptId` is optional for backward compatibility.
- Members never gain leader-only permissions.
- Existing `team_mode_task_update` / `team_update_task` calls without attempt remain valid only for the leader.
- `npm run check` must pass.

## Review Focus

- Member with old attempt after reassignment: rejected.
- Member with current attempt: accepted.
- Leader reassign: new attempt, old member fenced.
- Legacy task with no attempt: defined behavior, not accidental lockout.
- Concurrent update/reassign: one winner, no lost board update.

---

### Task 1: Map task lifecycle and tests

**Files:**
- Inspect: `src/runtime/team-command-handler.ts` `createTask`/`updateTask`
- Inspect: `src/domain/schemas.ts` `teamTaskSchema`
- Inspect: `src/runtime/team-tools.ts`
- Test: existing team runtime/tools specs

**Interfaces:**
- Produces: exact places that create/reassign/rotate attempts and the existing test harness for task ownership.

- [ ] **Step 1:** Identify every task creation and owner-change path.
- [ ] **Step 2:** Identify how member/leader identity reaches `updateTask`.
- [ ] **Step 3:** Record legacy-task behavior and test seams.

### Task 2: Add attemptId and fencing

**Files:**
- Modify: `src/domain/schemas.ts`
- Modify: `src/domain/types.ts` if exports require it
- Modify: `src/runtime/team-command-handler.ts`
- Modify: `src/runtime/team-tools.ts`
- Test: team runtime/tools specs

**Interfaces:**
- `TeamTask.attemptId?: string`
- `UpdateTaskInput.attempt_id?: string` / `attemptId?: string`
- Tool output includes `attempt_id` when present.

- [ ] **Step 1: Write failing tests** for create-with-owner, member stale attempt, member current attempt, leader reassignment.
- [ ] **Step 2: Run tests** and confirm they fail for the right reason.
- [ ] **Step 3: Implement** attempt generation/rotation and authorization.
- [ ] **Step 4: Run focused tests.**
- [ ] **Step 5: Commit.**

### Task 3: Verify regressions and edge cases

- [ ] **Step 1:** Run focused team tests.
- [ ] **Step 2:** Run `npm run check`.
- [ ] **Step 3:** Check legacy task, concurrent update/reassign, and leader-only paths.
- [ ] **Step 4:** Record evidence.

### Task 4: Independent review

- [ ] **Step 1:** Review current bytes against Task 1 findings and Task 3 evidence.
- [ ] **Step 2:** Verdict pass or structured findings.
