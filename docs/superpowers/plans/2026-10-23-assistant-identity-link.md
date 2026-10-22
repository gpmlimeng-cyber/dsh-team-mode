# Assistant Identity Link Implementation Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give each team member an explicit link to a real assistant instance so team-safe assistant memory can be injected without guessing.

**Architecture:** Add optional `assistantInstanceId` to team member slots. Team creation/update may pass an existing instance only when it matches the same workspace/owner; unlinked members behave exactly as today. The member prompt adds team-safe assistant entries only when the link resolves. No UI picker in this phase; API/service first.

**Tech Stack:** TypeScript, Zod, Cordis, Vitest.

**Spec:** `docs/DECISIONS-IDENTITY-MEMORY.md`, `docs/RAFT-ADOPTION.md`.

## Global Constraints

- No schema-version bump; optional link only.
- Never infer an instance from a template id or workspace; only explicit links.
- Unlinked members must not read assistant memory.
- No UI, no auto-capture, no context compaction.
- `npm run check` passes.

## Review Focus

- Explicit link validates same team/workspace/owner; cross-team link rejected.
- Unlinked legacy teams unchanged.
- Team-safe entries injected; private entries never.
- Linked instance archived/unavailable degrades safely.
- No memory write from a team member.

---

### Task 1: Audit member creation and instance mapping

- [ ] Map team creation/member slot APIs and assistant instance ownership/workspace.
- [ ] Decide where an explicit instance link is accepted and how legacy members behave.
- [ ] Identify tests and UI impact (UI deferred).

### Task 2: Implement explicit link + team-safe injection

- [ ] Add optional `assistantInstanceId` to the member schema/types.
- [ ] Validate explicit links and persist them; no guessing.
- [ ] Inject linked instance's `team-safe` active entries into the member prompt.
- [ ] Keep private entries and unlinked members unchanged.
- [ ] Add focused tests and commit.

### Task 3: Verify

- [ ] Run focused tests + `npm run check`.
- [ ] Check legacy, cross-workspace, archived instance, private/team-safe filtering.

### Task 4: Review

- [ ] Independent review of current bytes.
