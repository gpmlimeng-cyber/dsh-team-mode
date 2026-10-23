# 全局总览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only global overview to the team workbench default page: team/assistant counts, needs-attention list, and filtered rows.

**Architecture:** Pure helpers build a `GlobalOverviewModel` from existing `TeamView`, `AssistantInstanceView`, and assistant tasks; a presentational `GlobalOverview` renders it and calls existing `openTeam`/`openSession`; no new API.

**Tech Stack:** TypeScript, React client, DSH semantic CSS tokens, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-global-overview-design.md`

## Global Constraints

- Read-only; no global Captain, no bulk action, no approval in overview.
- No new API/schema/storage.
- Use existing `team.list`, `assistant.instance.list`, `assistant.task.list`.
- Empty/loading/error states must be explicit; no fake zeros while loading.
- 320px usable; no `overflow:hidden` clipping.
- All labels Chinese; `npm run check` must pass.

## Review Focus

1. Counts match actual team/assistant states; no fake zeros.
2. “需要你” includes team waiting approvals and assistant needs_input only.
3. Filters do not alter underlying counts; empty filter state is explicit.
4. Team/assistant clicks use existing navigation and do not mutate data.
5. Assistant without main session does not call ensure or fail.
6. 320px: rows do not overflow, numbers remain visible.

---

### Task 1: Global overview data

**Files:**

- Create: `src/client/global-overview-data.ts`
- Test: `tests/client-global-overview-data.spec.ts`

**Interfaces:**

```ts
export type GlobalFilter = "all" | "attention" | "running" | "idle";
export interface GlobalTeamItem {
  kind: "team";
  id;
  name;
  leaderName;
  members;
  running;
  approval;
  blocked;
}
export interface GlobalAssistantItem {
  kind: "assistant";
  id;
  name;
  model;
  status;
  tasks;
  needsInput;
  mainSessionId?: string;
}
export interface GlobalOverviewModel {
  teams;
  assistants;
  counts;
  attention;
}
export function globalOverviewModel(input: {
  teams;
  instances;
  tasks;
}): GlobalOverviewModel;
export function filterGlobalOverview(
  model,
  filter: GlobalFilter,
): GlobalOverviewModel;
```

Rules:

- Team item uses `isTeamExecuting`, member `waiting_approval`, blocked tasks with unresolved deps.
- Assistant item uses instance status, task counts, `needs_input`.
- Counts: running, attention, blocked, idle; unique item count, not double count.
- Attention sorted: team approval desc, assistant needsInput desc, updatedAt desc.
- Filter `attention`: items with approval/needsInput; `running`: executing/active/running tasks; `idle`: neither; `all`: all.
- Archived teams/instances excluded.

- [ ] **Step 1: Write failing tests** for empty, mixed team/assistant, attention priority, blocked, filters, archived exclusion, no main session.
- [ ] **Step 2: Run** `npx vitest run tests/client-global-overview-data.spec.ts`; expect fail.
- [ ] **Step 3: Implement** pure helpers.
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** `feat: add global overview data helpers`.

---

### Task 2: Overview UI and workbench integration

**Files:**

- Create: `src/client/global-overview.tsx`
- Modify: `src/client/teams/TeamPanel.tsx`
- Modify: `src/client/AgentTeam.module.css`
- Test: `tests/client-global-overview-panel.spec.ts`

**Interfaces:**

- `GlobalOverview({ teams, onOpenTeam, onOpenAssistant })`.
- Loads assistant instances + tasks with existing calls; errors/loading inline.
- Renders summary, needs-attention, filter buttons, team rows, assistant rows.
- Team click `openTeam(id)`; assistant click opens `mainSessionId` if present, otherwise disabled with “未创建主会话”.
- Mount above existing team list in `TeamPanel` when `selectedTeamId === undefined`; never inside a selected team.

- [ ] **Step 1: Write failing SSR/helper tests** for summary, empty, loading, filter, attention, assistant without main session, no bulk buttons.
- [ ] **Step 2: Implement** data loading and rows; use semantic tokens, single panel boundary.
- [ ] **Step 3: Integrate** in TeamPanel default page; keep existing team cards below.
- [ ] **Step 4: CSS** 320px, no overflow, visible counts.
- [ ] **Step 5: Run tests + typecheck + build.**
- [ ] **Step 6: Commit** `feat: add global overview`.

---

### Task 3: Verification

- [ ] `npm run check`.
- [ ] Empty/loading/error states.
- [ ] Team approval and assistant needs_input both appear in 需要你.
- [ ] Filters do not change summary counts.
- [ ] Team/assistant navigation does not mutate data.
- [ ] 320px screenshot/static check; record real screenshot as UNKNOWN if not run.

### Task 4: Review

- [ ] Review against spec/plan and Review Focus 1–6.
- [ ] Return pass or findings with file/line; no product edits.

## Self-Review

- Spec coverage: counts, attention, filters, navigation, read-only, 320px.
- Types consistent: `GlobalOverviewModel`, `GlobalTeamItem`, `GlobalAssistantItem`, `GlobalFilter`.
- No new API; no global controls.
