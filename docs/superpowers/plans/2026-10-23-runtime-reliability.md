# Runtime Reliability Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Close the remaining assistant/team runtime races: archive-vs-create, stale worker release/recover, and cold-start recovery ownership.

**Architecture:** Use the existing per-assistant locks and attempt fences; add generation tokens only where a released worker can still attach. Archive must block new work under the same lock before status is persisted. Cold recovery must fail explicitly when ownership cannot be proven.

**Tech Stack:** TypeScript, Cordis, Vitest.

**Spec:** `docs/TEAM-MODE-ROADMAP.md` P0 reliability.

## Global Constraints

- No new persistence version.
- Never dispose an Agent this runtime does not own.
- No silent task loss; blocked/cancelled must be explicit.
- `npm run check` passes.

## Review Focus

- Archive concurrent with createTask: no worker starts after archive wins.
- Two rapid recover calls: exactly one worker/handle.
- Release during recover: stale recovery cannot reattach.
- Cold start with live unowned worker: explicit conflict, no adoption.
- Existing owned/worker behavior unchanged.

---

### Task 1: Audit race windows

- [ ] Reproduce/describe archive/create, release/recover, and cold-start windows.
- [ ] Identify locks/generation insertion points and tests.

### Task 2: Archive barrier

- [ ] Block new worker creation under the assistant lock; persist archived before release.
- [ ] Add concurrent archive/create regression.

### Task 3: Recovery generation and cold-start ownership

- [ ] Add generation/token so an in-flight recover cannot reattach after release.
- [ ] Cold-start unowned worker returns typed conflict; no passive success.
- [ ] Add focused tests.

### Task 4: Verify

### Task 5: Review
