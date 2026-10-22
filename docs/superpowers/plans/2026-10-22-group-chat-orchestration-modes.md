# Group Chat Orchestration Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use the AgentTeams plan for execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply direct / single-task / orchestrated modes and a Goal layer to the group-chat team, using the agreed complexity heuristics without over-orchestrating casual chat.

**Architecture:** Add an optional Goal record above tasks (`TeamGoal`, `Task.goalId`). The Leader classifies each new user objective and creates a Goal only when warranted; the team page groups tasks by Goal and displays the mode. Scheduling and quality gates remain follow-up phases.

**Tech Stack:** TypeScript, Zod, Cordis, Vitest, React.

**Spec:** `docs/TEAM-MODE-ROADMAP.md` and the 2026-10-22 orchestration discussion.

## Global Constraints

- No schema-version bump: Goal fields are optional/backward-compatible.
- Ordinary chat must not create Goals or tasks.
- Do not add auto-scheduling or quality-gate machinery in this phase.
- Preserve existing task board, attempt fencing, and native conversation.
- `npm run check` must pass.

## Review Focus

- A one-line question creates no Goal/Task.
- A single deliverable creates one Goal + one Task, not a DAG.
- Two independent objectives stay separate Goals.
- Shared deliverable/dependency objectives can share a Goal.
- Existing teams without Goals load unchanged.
- Mode classification is explainable and user-overridable.

---

### Task 1: Goal domain model

**Files:**
- Modify: `src/domain/schemas.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/storage/store.ts` if aggregate helpers are needed
- Test: `tests/team-command-handler.spec.ts`, `tests/domain-store.spec.ts` if present

**Interfaces:**
- `TeamGoal { id, teamId, title, objective, acceptance, mode: 'direct'|'single'|'orchestrated', status, createdAt, updatedAt }`
- `TeamTask.goalId?: string`
- Team aggregate gains optional `goals?: Record<string, TeamGoal>`.

- [ ] Write failing tests for optional/legacy loading and Goal CRUD.
- [ ] Implement schema + store/service methods.
- [ ] Run focused tests.
- [ ] Commit.

### Task 2: Leader classification and tools

**Files:**
- Modify: `src/runtime/team-command-handler.ts`
- Modify: `src/runtime/team-tools.ts`
- Modify: `src/runtime/team-prompts.ts`
- Test: `tests/team-tools.spec.ts`, `tests/team-prompts.spec.ts` if present

**Interfaces:**
- Tool `team_mode_goal_create` accepts title/objective/acceptance/mode.
- Tool `team_mode_goal_list` returns goals grouped with task ids.
- `team_mode_task_create` accepts optional `goal_id`.

- [ ] Add the fixed classification rules to the Leader prompt.
- [ ] Add Goal tools and task goal linkage.
- [ ] Test direct/single/orchestrated examples and legacy calls.
- [ ] Commit.

### Task 3: Group-chat Goal UI

**Files:**
- Modify: team page / workbench components
- Modify: `src/client/AgentTeam.module.css`
- Test: client helper tests

**Interfaces:**
- Goal cards show mode, objective, acceptance, task count, progress.
- Task list can group/filter by Goal.
- Empty goals/legacy teams hide the section.

- [ ] Render Goal cards only when goals exist.
- [ ] Show mode badge (`对话` / `单任务` / `编排`).
- [ ] Add regression coverage for grouping helpers.
- [ ] Commit.

### Task 4: Verify and review

- [ ] Run focused tests + `npm run check`.
- [ ] Check no-Goal legacy team, direct chat, single task, separate goals, shared goal.
- [ ] Independent review of classification and UI.
