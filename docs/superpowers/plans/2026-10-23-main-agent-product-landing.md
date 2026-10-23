# 主 Agent 产品形态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Team Leader the product's default main Agent surface, add a same-profile native/team mode switch, and keep members as a secondary execution panel.

**Architecture:** A client-side `SurfaceMode` gates plugin surfaces without changing data or tools; team navigation opens the Leader Session; a lightweight team panel reuses existing members/tasks/messages; the collaboration overview follows its own existing design.

**Tech Stack:** TypeScript, React client, Cordis slots, DSH native conversation, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-main-agent-product-landing-design.md`

## Global Constraints

- Same profile: native and team modes coexist; switching never reloads the plugin or writes business data.
- Mode is a surface flag, not an Agent Preset, not a new Agent entity.
- Native sessions never receive team tools; team member Sessions stay hidden in native mode.
- MVP adds no backend API and no schema field.
- Default team landing is the Leader main Session, not the parallel workbench.
- All user-facing member names, tasks, labels are Chinese.
- Run the named tests before `npm run check`.

## File Structure

```text
src/client/surface-mode.ts            mode type, storage, default resolution
src/client/sidebar.tsx                mode switch + conditional plugin groups
src/client/index.tsx                  register team views only in team mode
src/client/team-main-agent.tsx        team panel + stable header
src/client/team-parallel.tsx          parallel view gating/opt-in
src/client/team-board.tsx             existing board entry; no rewrite here
src/runtime/team-prompts.ts           main Agent direct/aggregate directive
tests/client-surface-mode.spec.ts     mode helper tests
tests/client-team-main-agent.spec.ts  panel/header helper tests
tests/team-prompts.spec.ts            prompt regression
```

## Review Focus

1. Switching native/team must not reload the plugin, duplicate Session rows, or lose the active team.
2. A team Session opened in native mode must not become a visible normal session row.
3. Native sessions must never receive team tools after switching to team mode.
4. A team with no tasks/messages must render the main Agent and empty panel without fake counts.
5. Parallel view must be opt-in; team open must not auto-overlay all member panes.
6. Mode storage failure/restricted WebView must fall back to the configured default.

---

### Task 1: SurfaceMode state and config default

**Files:**

- Modify: `src/config.ts`
- Create: `src/client/surface-mode.ts`
- Test: `tests/client-surface-mode.spec.ts`

**Interfaces:**

```ts
export type SurfaceMode = "native" | "team";
export const SURFACE_MODE_KEY = "dsh-team-mode:surface-mode";
export function readSurfaceMode(
  storage: Pick<Storage, "getItem"> | undefined,
  fallback: SurfaceMode,
): SurfaceMode;
export function writeSurfaceMode(
  storage: Pick<Storage, "setItem"> | undefined,
  mode: SurfaceMode,
): void;
export function resolveSurfaceMode(input: {
  stored?: string;
  configured?: SurfaceMode;
}): SurfaceMode;
```

- [ ] **Step 1: Write failing tests** for valid stored values, invalid/missing storage fallback, configured fallback, and storage write failure.
- [ ] **Step 2: Run** `npx vitest run tests/client-surface-mode.spec.ts`; expect fail.
- [ ] **Step 3: Implement** the helpers. With no stored value, resolve to `team`; do not add a Host config field or API in v1.
- [ ] **Step 4: Run tests + typecheck**.
- [ ] **Step 5: Commit** `feat: add surface mode state`.

### Task 2: Sidebar mode switch and native surface hiding

**Files:**

- Modify: `src/client/sidebar.tsx`
- Modify: `src/client/index.tsx`
- Test: `tests/client-surface-mode.spec.ts`

**Interfaces:**

- Consumes Task 1.
- Produces `surfaceMode` state and a `[原生] [团队]` switch in the sidebar group.

- [ ] **Step 1: Write failing helper tests** for which sidebar groups are visible in each mode.
- [ ] **Step 2: Implement** the switch, persist via Task 1, and hide team/assistant groups in native mode.
- [ ] **Step 3: In native mode, do not register team board/parallel/manage views**; keep native sessions untouched.
- [ ] **Step 4: Switching to native while a team Session is active opens the native landing; team Session remains hidden.**
- [ ] **Step 5: Run focused tests + typecheck + build.**
- [ ] **Step 6: Commit** `feat: add native/team surface switch`.

### Task 3: Team opens the Leader main Agent

**Files:**

- Modify: `src/client/index.tsx`
- Modify: `src/client/team-parallel.tsx`
- Test: `tests/client-team-main-agent.spec.ts`

**Interfaces:**

- `openTeamPage(teamId)` opens the Leader Session and selects the native conversation view, not `team-parallel`.
- Parallel host renders only when the user explicitly selects the `群聊/并行视图` tab.

- [ ] **Step 1: Write failing tests** for default target (Leader session), parallel gating, and missing leader.
- [ ] **Step 2: Implement** default navigation and explicit parallel opt-in.
- [ ] **Step 3: Run focused tests + typecheck.**
- [ ] **Step 4: Commit** `feat: open teams on the main agent`.

### Task 4: Team panel and stable header

**Files:**

- Create: `src/client/team-main-agent.tsx`
- Modify: `src/client/index.tsx`
- Modify: `src/client/AgentTeam.module.css`
- Test: `tests/client-team-main-agent.spec.ts`

**Interfaces:**

- `TeamMainAgentPanel({ team, tasks, messages, onOpenMember, onOpenTask })`
- Header text: `团队名 · 主 Agent`; operator line: `当前 Leader：<name>`.

- [ ] **Step 1: Write failing pure-helper tests** for header text, member status, task counts, empty panel.
- [ ] **Step 2: Implement** the compact panel with members, tasks, pending approvals, dependency summary; no full member conversations.
- [ ] **Step 3: Mount it as a collapsible shell overlay only in team mode; native mode unmounts it.**
- [ ] **Step 4: Run tests + typecheck + build.**
- [ ] **Step 5: Commit** `feat: add team main agent panel`.

### Task 5: Main Agent prompt and result aggregation

**Files:**

- Modify: `src/runtime/team-prompts.ts`
- Test: `tests/team-prompts.spec.ts`

**Interfaces:**

- Add a main Agent directive: answer ordinary questions directly; create one task for one deliverable; orchestrate only for 2+ streams/dependencies/verification; aggregate results; do not dump member transcripts.

- [ ] **Step 1: Write failing prompt tests** for direct answer, single task, orchestration threshold, and aggregation language.
- [ ] **Step 2: Implement the prompt section.**
- [ ] **Step 3: Run tests + typecheck.**
- [ ] **Step 4: Commit** `feat: add main agent operating prompt`.

### Task 6: Verification and screenshots

- [ ] Run `npm run check` at the final head.
- [ ] Capture 1440px and 390px screenshots of team main Agent and native mode.
- [ ] Verify mode switch does not reload plugin, duplicate rows, or write team data.
- [ ] Verify team open is main Agent, parallel view is opt-in, empty panel has no fake counts.
- [ ] Record real host restart as UNKNOWN if not performed.

### Task 7: Collaboration overview

Implement separately from `docs/superpowers/specs/2026-10-23-team-collaboration-overview-design.md`; do not duplicate its layout in this plan. The board remains a tab and is linked from the main Agent panel.

---

## Self-Review

- Spec coverage: mode, main Agent default, panel, prompt, parallel gating, overview handoff.
- Type consistency: `SurfaceMode`, `readSurfaceMode`, `resolveSurfaceMode`, `TeamMainAgentPanel`.
- Review Focus items 1–6 each have a task/test.
- P0 Turn Engine is intentionally outside this plan; it is already tracked by `team-turn-engine`.
