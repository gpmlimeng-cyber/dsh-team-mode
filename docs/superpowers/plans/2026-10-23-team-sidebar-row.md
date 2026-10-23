# 侧栏团队行增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each sidebar team row into a compact status summary with attention-first ordering, an explicit active/history scope, and an expandable recent-task list.

**Architecture:** Pure helpers derive counts, ordering, and recent tasks from the existing `TeamView`; `SidebarTeamSection` renders a two-line row and a collapsed task expansion; no backend API or schema changes.

**Tech Stack:** TypeScript, React client, DSH semantic CSS tokens, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-team-sidebar-row-design.md`

## Global Constraints

- No new API, no message fetch, no N+1.
- Use existing `TeamView.members` and `TeamView.tasks`; do not add fields.
- Do not turn the sidebar into a second team page: no member roster, DAG, or full conversations.
- All user-facing labels are Chinese.
- One row click opens the team; expansion is a separate button.
- Hover actions must not reappear on touch devices without focus.
- Run the named tests before `npm run check`.

## File Structure

```text
src/client/team-sidebar-data.ts        counts, attention rank, status text, recent tasks
src/client/sidebar.tsx                 two-line row, attention sort, scope, expansion
src/client/AgentTeam.module.css        scope toggle, subtitle, badge, task list, narrow width
tests/client-team-sidebar-data.spec.ts pure helper tests
```

## Review Focus

1. Team with zero tasks/members must not render `undefined` or fake counts.
2. Waiting approval must rank above running, pinned must rank above both.
3. Archived teams stay out of the active list and appear only in history.
4. Expansion must not open the team; row click must not toggle expansion.
5. Recent tasks must be the newest three, stable by updatedAt then id.
6. 320px: name truncates, subtitle/badge do not overflow, actions remain reachable.

---

### Task 1: Sidebar data helpers

**Files:**

- Create: `src/client/team-sidebar-data.ts`
- Test: `tests/client-team-sidebar-data.spec.ts`

**Interfaces:**

```ts
export interface TeamSidebarSummary {
  members: number;
  running: number;
  waiting: number;
}

export interface TeamSidebarTask {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  updatedAt: string;
}

export function teamSidebarSummary(team: TeamView): TeamSidebarSummary;
export function teamSidebarStatusText(summary: TeamSidebarSummary): string;
export function compareTeamSidebar(
  left: TeamView,
  right: TeamView,
  sort: "updated" | "name",
): number;
export function recentTeamTasks(
  team: TeamView,
  limit?: number,
): TeamSidebarTask[];
```

Rules:

- `members` = all current member slots.
- `running` = `lastRuntimeState === 'running'`.
- `waiting` = `lastRuntimeState === 'waiting_approval'`.
- Status text:
  - waiting > 0: `N 人 · M 运行 · K 待审批`
  - running > 0: `N 人 · M 运行`
  - else: `N 人 · 空闲`
- `compareTeamSidebar`:
  - pinned first;
  - in `updated` mode: waiting desc, running desc, updatedAt desc, id asc;
  - in `name` mode: `localeCompare('zh-CN')`.
- `recentTeamTasks`: sort tasks by `updatedAt` desc then id asc, cap at 3 by default; map status labels:
  `pending=待处理`, `assigned=已分配`, `running=进行中`, `blocked=已阻塞`, `completed=已完成`, `failed=失败`, `cancelled=已取消`.

- [ ] **Step 1: Write the failing tests**

Cover: empty team, zero/one/many members, waiting+ running, status text branches, pinned/waiting/running/updated order, name order, task sort/cap, missing title fallback.

Run: `npx vitest run tests/client-team-sidebar-data.spec.ts`
Expected: FAIL because module missing.

- [ ] **Step 2: Implement the helpers**

Use only `TeamView` fields. Do not import React or CSS. Keep functions pure.

- [ ] **Step 3: Run tests + typecheck**

Run: `npx vitest run tests/client-team-sidebar-data.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/client/team-sidebar-data.ts tests/client-team-sidebar-data.spec.ts
git commit -m "feat: add team sidebar status helpers"
```

---

### Task 2: Two-line row, attention sort, active/history scope

**Files:**

- Modify: `src/client/sidebar.tsx`
- Modify: `src/client/AgentTeam.module.css`
- Test: `tests/client-team-sidebar-data.spec.ts`

**Interfaces:**

- Consumes Task 1 helpers.
- Produces the rendered row structure:

```text
团队名                         2分钟
N 人 · M 运行 · K 待审批        [K]
```

- [ ] **Step 1: Add helper assertions for scope counts**

Add a test for `activeCount` / `archivedCount` derived from `teams`, or export a tiny `teamScopeCounts(teams)` helper from Task 1 if the sidebar needs it. Do not duplicate counting logic in JSX.

- [ ] **Step 2: Render the second line**

- Keep team name on line 1 with ellipsis and title.
- Add `sidebarTeamSubtitle` with `teamSidebarStatusText`.
- Move waiting badge to the right; keep time.
- For waiting > 0, badge shows count; for running only, show a small dot.
- Keep avatar/icon.

- [ ] **Step 3: Replace the sort comparator**

In `visibleTeams`, use `compareTeamSidebar(a, b, sortMode)` after filtering. Remove the old inline pinned/updated comparator. Keep `onlyPending` filter.

- [ ] **Step 4: Add explicit scope**

- Add a compact `sidebarTeamScope` row under the header when any archived team exists.
- Buttons: `团队 (activeCount)` and `历史 (archivedCount)`, with `aria-pressed`.
- Remove the `show-archived` menu item to avoid duplicate controls; keep filter/sort menu.
- Default `showArchived=false`.

- [ ] **Step 5: Collapse row actions**

- Keep pin visible.
- Replace manage + archive icons with one ellipsis menu containing “管理团队” and “归档团队”.
- Archive remains disabled unless `team.state !== 'active' && team.state !== 'starting'`.
- Ensure the menu does not trigger row open.

- [ ] **Step 6: Add CSS**

Use existing semantic tokens. Required classes: subtitle, scope, scope button, badge, action menu anchor, 320px rules. No hard-coded colors.

- [ ] **Step 7: Run tests, typecheck, build**

Run: `npx vitest run tests/client-team-sidebar-data.spec.ts && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/client/sidebar.tsx src/client/AgentTeam.module.css
git commit -m "feat: show team status and scope in sidebar"
```

---

### Task 3: Expandable recent tasks

**Files:**

- Modify: `src/client/sidebar.tsx`
- Modify: `src/client/AgentTeam.module.css`
- Test: `tests/client-team-sidebar-data.spec.ts`

**Interfaces:**

- Consumes `recentTeamTasks(team, 3)`.
- Adds per-team expansion state keyed by team id.

- [ ] **Step 1: Write failing helper test for expansion defaults**

Add `expandedTeamIds` helper tests if extracted; otherwise test `recentTeamTasks` empty/task output and the pure default `new Set()` behavior in a small helper.

- [ ] **Step 2: Add expansion button**

- Separate `<button>` outside the row button, with chevron, `aria-expanded`, `aria-controls`.
- Clicking it toggles only expansion; clicking the row opens the team.
- Do not nest buttons.
- Default collapsed; state persists for the session only.

- [ ] **Step 3: Render recent tasks**

- Expanded area shows `recentTeamTasks(team)`.
- Each task row is a button that opens the team page (same `openTeam`), not a task action.
- Show title + status label; title ellipsis with title attr.
- Empty: “暂无任务”.
- Keep maximum 3 rows; no member list.

- [ ] **Step 4: CSS and narrow width**

- Indent task list under the row.
- 320px: hide time, keep badge; subtitle truncates; expand chevron remains 24px tap target.
- No horizontal overflow.

- [ ] **Step 5: Run tests, typecheck, build**

Run: `npx vitest run tests/client-team-sidebar-data.spec.ts && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/sidebar.tsx src/client/AgentTeam.module.css
git commit -m "feat: expand recent tasks in team sidebar"
```

---

### Task 4: Verification

- [ ] Run `npm run check`.
- [ ] Check 320px and 1440px rows.
- [ ] Verify active/history, waiting badge, pin order, row click vs expand click, empty recent tasks.
- [ ] Confirm no new network request beyond existing `team.list`.
- [ ] Record screenshot or visual check as evidence.

### Task 5: Review

- [ ] Review the latest head against spec/plan and Review Focus.
- [ ] Return pass or findings with file/line.

---

## Self-Review

- Spec coverage: subtitle, attention sort, active/history, hover collapse, recent tasks, responsive, no new API.
- Types consistent: `TeamSidebarSummary`, `TeamSidebarTask`, `teamSidebarStatusText`, `compareTeamSidebar`, `recentTeamTasks`.
- Review Focus 1–6 map to Task 1 tests and Task 2/3 UI checks.
- No new backend/API; no message preview.
