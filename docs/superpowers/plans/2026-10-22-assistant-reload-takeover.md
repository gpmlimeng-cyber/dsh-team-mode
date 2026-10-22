# Assistant Reload Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use the AgentTeams plan for execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a single-chat assistant's tools and memory after a plugin reload or host restart instead of silently opening a passive, tool-less main Session.

**Architecture:** Audit the Agent ownership surface first. The runtime must either adopt/reattach to a live unowned main Agent, or fail with a typed, recoverable error that explicitly asks for a restart. Never dispose another lifecycle's Agent without ownership.

**Tech Stack:** TypeScript, Cordis, DSH Agent/Session/Workspace APIs, Vitest.

**Spec:** Current `docs/assistant.md` limitations and the P0 item in the 2026-10-22 backlog.

## Global Constraints

- Do not modify DSH source or `node_modules`.
- Preserve native conversation/composer; no new chat UI.
- Use `--dsw-*` tokens for any UI.
- No silent data loss; no silent `passive` main Session with missing `assistant_task_*` tools.
- `npm run check` must pass.

## Review Focus

- Reload while the main Agent is running: do not cancel or duplicate its current turn.
- Reload while a worker is running: worker ownership stays with the old lifecycle.
- Archived assistant: no takeover and no new worker.
- Missing/renamed DSH Agent APIs: fail clearly, not silently.
- Two rapid `ensure` calls: exactly one owner/tool registration.

---

### Task 1: Audit ownership and reproduce passive main

**Files:**
- Inspect: `src/runtime/assistant-runtime.ts` (`start`, `owned`, `dispose`)
- Inspect: DSH Agent/Session APIs via inspection
- Test: `tests/assistant-runtime.spec.ts`

**Interfaces:**
- Produces: a written finding naming the exact API that can attach tools/prompt sections to a live Agent, or an explicit statement that no supported API exists.

- [ ] **Step 1: Reproduce** a bound main Session live without this runtime's handle.
- [ ] **Step 2: Inspect** `ctx.agents.get(sessionId)` / Agent context and determine whether tools/system-prompt sections can be added safely.
- [ ] **Step 3: Decide** adopt vs restart-with-error; record the exact method and ownership rules.
- [ ] **Step 4: Commit** the finding in the task output, not code.

### Task 2: Implement takeover or explicit recovery

**Files:**
- Modify: `src/runtime/assistant-runtime.ts`
- Modify if required: `src/service/dsh-team-mode-service.ts`
- Test: `tests/assistant-runtime.spec.ts`

**Interfaces:**
- Consumes Task 1's chosen API.
- Produces: `ensure` on an unowned live main either reattaches the assistant surface or throws a typed error.

- [ ] **Step 1: Write the failing test** for reload-with-live-main.
- [ ] **Step 2: Run it** and confirm the current passive-open behavior fails the contract.
- [ ] **Step 3: Implement** the minimal takeover/recovery path.
- [ ] **Step 4: Run** the focused test.
- [ ] **Step 5: Commit.**

### Task 3: Verify reload, worker, archive, and duplicate ensure

- [ ] **Step 1:** Run focused runtime tests.
- [ ] **Step 2:** Run `npm run check`.
- [ ] **Step 3:** Reload the plugin in the live GUI and create a task from an existing assistant.
- [ ] **Step 4:** Record evidence in the verification task.

### Task 4: Independent review

- [ ] **Step 1:** Review the implementation against Task 1 findings and Task 3 evidence.
- [ ] **Step 2:** Verdict pass or findings; no self-approval.
