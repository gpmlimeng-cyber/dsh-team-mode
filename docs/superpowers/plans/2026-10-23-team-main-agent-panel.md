# 主 Agent 团队面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible right-side team panel beside the Leader main conversation: live progress, blocker summary, member current work, and approval entry.

**Architecture:** Pure helpers derive a panel view from the existing `TeamView`; a presentational panel renders it; `index.tsx` mounts it only in team surface mode with a toggle store. No backend API, no DAG, no full inbox.

**Tech Stack:** TypeScript, React client, DSH semantic CSS tokens, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-main-agent-product-landing-design.md` and the panel section in `docs/superpowers/specs/2026-10-23-team-collaboration-overview-design.md`

## Global Constraints

- No new API; all data from `TeamView.members` and `TeamView.tasks`.
- Panel is a live execution strip, not the AgentTeams full workbench.
- No DAG, no full task detail, no inbox list in the panel.
- Default collapsed or compact; opening is explicit.
- Never render fake counts; empty team/tasks/approvals have explicit text.
- All labels Chinese.
- `npm run check` must pass.

## Review Focus

1. Empty team or no tasks must not render `undefined` or fake progress.
2. Task running with idle members must still show “执行中”.
3. Blocked task must explain the first unresolved dependency and owner.
4. Approval count must come from waiting members, not from dependency waits.
5. Panel must not open or replace the main Agent conversation.
6. 320px: panel overlays, closes, and does not trap focus or overflow.

---

### Task 1: Panel data helpers

**Files:**

- Create: `src/client/team-main-agent-data.ts`
- Test: `tests/client-team-main-agent-data.spec.ts`

**Interfaces:**

```ts
export interface PanelMember {
  id: string;
  name: string;
  role: "leader" | "member";
  model: string;
  state: string;
  currentTask?: { id: string; title: string };
  completed: number;
  total: number;
  chips: Array<{
    id: string;
    title: string;
    status: string;
    statusLabel: string;
  }>;
}

export interface PanelView {
  leaderName: string;
  memberCount: number;
  taskTotal: number;
  completed: number;
  running: number;
  waiting: number;
  error: number;
  approval: number;
  blocked: number;
  firstBlocker?: { title: string; ownerName?: string };
  members: PanelMember[];
}

export function teamPanelView(team: TeamView): PanelView;
export function panelProgressText(view: PanelView): string;
```

Rules:

- `running` counts tasks with status `running` plus members running; do not double count; use task counts for progress segments.
- `waiting` counts pending/assigned tasks whose dependencies are not completed.
- `error` counts failed/cancelled; `blocked` counts blocked tasks.
- `approval` counts members with `waiting_approval`.
- `currentTask`: first running task owned by member; otherwise first assigned task; otherwise undefined.
- `completed`/`total`: tasks owned by member; completed excludes cancelled.
- `chips`: up to 3 tasks, running first then updatedAt desc.
- `firstBlocker`: first blocked task with unresolved dependency; label dependency title + owner if present.
- No messages/API.

- [ ] **Step 1: Write failing tests** for empty team, one running task with idle member, waiting dependency, failed/cancelled, approval count, member chips/progress, missing owner/title.
- [ ] **Step 2: Run** `npx vitest run tests/client-team-main-agent-data.spec.ts`; expect fail.
- [ ] **Step 3: Implement** pure helpers.
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** `feat: add team panel data helpers`.

---

### Task 2: Panel component

**Files:**

- Create: `src/client/team-main-agent.tsx`
- Test: `tests/client-team-main-agent-panel.spec.ts`

**Interfaces:**

- `TeamMainAgentPanel({ team, open, onClose, onOpenMember, onOpenTeam })`.
- Renders: header `团队名 · 主 Agent`, current Leader, summary `已派发 N 项任务给 M 名成员`, progress segments, blocker notice, member rows, approval footer.

- [ ] **Step 1: Write failing SSR/helper tests** for header, summary, empty team, empty tasks, member current task, blocker line, approval footer, close callback.
- [ ] **Step 2: Implement** the panel using semantic tokens; default compact, no nested cards.
- [ ] **Step 3: Add CSS** for overlay, scroll, member rows, progress segments, 320px.
- [ ] **Step 4: Run tests + typecheck + build.**
- [ ] **Step 5: Commit** `feat: add team main agent panel`.

---

### Task 3: Mount and toggle

**Files:**

- Modify: `src/client/index.tsx`
- Modify: `src/client/store.ts` or add a small panel-open store
- Modify: `src/client/team-board.tsx`? no, unless header toggle lives in conversation utilities.
- Test: `tests/client-team-main-agent-panel.spec.ts`

**Interfaces:**

- A `team.panel` toggle button in the active team conversation header utilities.
- Panel renders only when `surfaceMode === 'team'` and a team member session is active.
- Panel close leaves the main conversation untouched.
- Panel open state is per session or global UI state; no business persistence.

- [ ] **Step 1: Write failing tests** for toggle visibility in team/native mode, open/close state, and no render for non-team sessions.
- [ ] **Step 2: Implement** store + header button + overlay mounting.
- [ ] **Step 3: Run tests + typecheck + build.**
- [ ] **Step 4: Commit** `feat: mount team main agent panel`.

---

### Task 4: Verification

- [ ] `npm run check`.
- [ ] 1440/390 screenshots: panel closed/open, empty team, running, blocked, approval.
- [ ] Member click opens member session; task chips do not replace main Agent.
- [ ] No extra API requests.
- [ ] Record unavailable host restart as UNKNOWN.

### Task 5: Review

- [ ] Review against spec/plan; return pass or findings with file/line.

---

## Self-Review

- Spec coverage: progress, blocker, members, approvals, collapse, no DAG/inbox.
- Types consistent: `PanelView`, `PanelMember`, `teamPanelView`, `panelProgressText`.
- Review Focus 1–6 map to Task 1 tests and Task 2/3 UI checks.
- No backend/API; no workload in panel.
