# 团队协作总览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `总览 / 任务` switch inside the existing team board, with leader summary, progress, member task chips, dependency graph, selected task detail, and a leader inbox.

**Architecture:** Derive an overview view model from the existing `TeamView` and messages; render a dedicated `TeamOverview` beside the existing task layout; no backend/API change. The task board remains the default when there is no live work.

**Tech Stack:** TypeScript, React client, DSH semantic CSS tokens, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-team-collaboration-overview-design.md`

## Global Constraints

- No new backend/API/schema; reuse `TeamView.tasks`, `TeamView.members`, existing messages.
- No third-party graph library.
- Task detail is inline/panel; no new page, no full member transcripts.
- Inbox is read-only, latest 5; no approval actions inside it.
- Existing task board, filters, and feed must not regress.
- All labels Chinese; `npm run check` must pass.

## Review Focus

1. Empty team/tasks/messages must show explicit empty states, no fake counts.
2. Dependency layers must handle chains, splits, missing deps, and cycles without dropping tasks.
3. Selected task must be stable across refresh; deleted selection falls back safely.
4. Inbox must only include Leader-recipient, non-system messages.
5. Task view and filters must remain unchanged when switching back.
6. 320px stacks without overflow; graph is keyboard-operable.

---

### Task 1: Overview data helpers

**Files:**

- Create: `src/client/team-overview-data.ts`
- Test: `tests/client-team-overview-data.spec.ts`

**Interfaces:**

```ts
export type BoardMode = "overview" | "tasks";

export interface DependencyLayer {
  depth: number;
  tasks: TeamTask[];
}

export interface DependencyGraph {
  layers: DependencyLayer[];
  unlayered: TeamTask[];
}

export function defaultBoardMode(
  tasks: readonly TeamTask[],
  stored?: string,
): BoardMode;
export function dependencyGraph(tasks: readonly TeamTask[]): DependencyGraph;
export function leaderInbox(
  messages: readonly TeamMessage[],
  leaderSlotId: string,
  limit?: number,
): TeamMessage[];
export function pickOverviewTask(
  tasks: readonly TeamTask[],
  selectedId?: string,
): TeamTask | undefined;
```

Rules:

- `defaultBoardMode`: stored `overview|tasks` wins; otherwise overview when any task is running/blocked/failed/assigned, else tasks.
- `dependencyGraph`: Kahn-style depth by unfinished dependencies; missing deps are ignored; cycle nodes and tasks depending on them go to `unlayered`; preserve updatedAt desc/id asc within each layer.
- `leaderInbox`: recipient.kind `leader`, matching `slotId`, type not `system`, sorted createdAt desc/id; default limit 5.
- `pickOverviewTask`: selected id if still present; else first running, then first task by updatedAt desc; undefined for empty.
- Reuse `TeamTask`, `TeamMessage`; no React/CSS.

- [ ] **Step 1: Write failing tests** for empty, chain, split, missing dep, cycle, inbox filtering/order/limit, selected fallback, mode preference.
- [ ] **Step 2: Run** `npx vitest run tests/client-team-overview-data.spec.ts`; expect fail.
- [ ] **Step 3: Implement** pure helpers.
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** `feat: add team overview data helpers`.

---

### Task 2: Overview UI and board switch

**Files:**

- Create: `src/client/team-overview.tsx`
- Modify: `src/client/team-board.tsx`
- Modify: `src/client/AgentTeam.module.css`
- Test: `tests/client-team-overview-panel.spec.ts`

**Interfaces:**

```ts
export function TeamOverview(props: {
  team: TeamView;
  tasks: readonly TeamTask[];
  messages: readonly TeamMessage[];
  selectedTaskId?: string;
  onSelectTask: (taskId: string) => void;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element;
```

- [ ] **Step 1: Write failing SSR/helper tests** for summary, progress, empty tasks, empty graph, task detail, inbox, and no DAG/inbox when data empty.
- [ ] **Step 2: Add `mode` state** to `TeamBoardView`:
  - persisted key `dsh-team-mode:team-board:view`;
  - `defaultBoardMode(tasks)` fallback;
  - segmented `[总览] [任务]` with `aria-pressed`;
  - switching preserves filters.
- [ ] **Step 3: Render overview** when mode is overview: header summary, segmented progress, member chips, dependency graph, selected task detail, leader inbox. Keep existing header/toolbar; hide the member-column board only in overview.
- [ ] **Step 4: Task detail** shows title/status/owner/dependencies/unlocks/updatedAt and “打开成员会话” when owner exists; no inline edit.
- [ ] **Step 5: Graph** uses dependency layers; nodes are buttons, keyboard operable; unlayered area warns but keeps tasks; no library.
- [ ] **Step 6: Inbox** filters to Leader; shows latest 5; empty state; read-only.
- [ ] **Step 7: CSS** semantic tokens, two-column desktop, stacked 320px, `overflow-x:auto` for graph, no `overflow:hidden` clipping.
- [ ] **Step 8: Run tests + typecheck + build.**
- [ ] **Step 9: Commit** `feat: add team collaboration overview`.

---

### Task 3: Verification

- [ ] `npm run check`.
- [ ] Verify empty team/tasks/messages, chain/split/cycle graph, selected task fallback, inbox filter, task view filter preservation.
- [ ] 1440/390 visual check; record real browser screenshot as evidence or UNKNOWN.
- [ ] Confirm no new API request; only existing `team.list`/`team.message.list`.

### Task 4: Review

- [ ] Review against spec/plan and Review Focus 1–6.
- [ ] Return pass or findings with file/line; do not modify product code.

---

## Self-Review

- Spec coverage: switch, progress, member chips, graph, detail, inbox, responsive.
- Types consistent: `BoardMode`, `DependencyLayer`, `DependencyGraph`, `leaderInbox`, `pickOverviewTask`.
- Review Focus 1–6 map to Task 1 tests and Task 2 UI checks.
- No new API; no DAG library; no task editing.
