# Memory and Goal UI Implementation Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Make the new memory and Goal data visible and editable in the existing team/assistant UI without replacing the native conversation shell.

**Architecture:** Reuse existing API/transport and team pages. Add a memory panel for assistant and team scopes; add Goal cards/DAG grouping above the task board. Use `--dsw-*` tokens and existing client helpers. No new chat UI.

**Tech Stack:** React, TypeScript, CSS Modules, existing transport.

**Spec:** `docs/MEMORY-ARCHITECTURE.md`, `docs/TEAM-MODE-ROADMAP.md`, `docs/TEAM-STEWARD.md`.

## Global Constraints

- Native conversation/composer stays untouched.
- No new global store; use existing client state/API.
- Goal section hidden for legacy teams with no goals.
- Memory panel shows scope, visibility, status, revision, and pending proposals.
- No auto-capture/recall UI in this phase.
- `npm run check` passes.

## Review Focus

- Legacy team/assistant renders unchanged.
- Proposed vs active memory is visually distinct; private never appears in team UI.
- Goal card counts/dependencies match the actual board.
- No unbounded render for large histories.
- Mobile layout and keyboard/focus states remain usable.

---

### Task 1: Audit existing client surfaces and API

- [ ] Map assistant settings, team page, task board, and transport methods.
- [ ] Choose insertion points for Memory and Goals.
- [ ] Identify tests/helpers and mobile constraints.

### Task 2: Memory UI

- [ ] Assistant memory panel: core/private/team-safe entries, revision, edit/clear.
- [ ] Team memory panel: active/proposed, accept/reject for Leader, user edit.
- [ ] Show empty/legacy states.
- [ ] Add focused client tests.

### Task 3: Goal / DAG UI

- [ ] Goal cards with mode, objective, acceptance, task count/progress.
- [ ] Group/filter tasks by Goal; show dependencies.
- [ ] Hide section when no goals.
- [ ] Add focused client tests.

### Task 4: Verify

- [ ] Run client tests + npm run check.
- [ ] Check legacy, private/proposed visibility, mobile, large lists.

### Task 5: Review

- [ ] Independent review of current bytes.
