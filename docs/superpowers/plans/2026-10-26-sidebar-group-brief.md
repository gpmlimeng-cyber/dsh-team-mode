# Sidebar Group Brief Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Give each sidebar group a user-authored shared brief, injected into the system prompt of teams/assistants in that group, so a department shares one operating instruction.

**Architecture:** Upgrade the existing `sidebar_groups` names to records with `brief`, `memoryKey`, `updatedAt`; migrate old strings. Inject the group brief through the existing system-prompt composition seam. The agent has no write path to `brief`; only the user UI can edit it.

**Spec:** `docs/superpowers/specs/2026-10-26-mausbot-alignment-plan.md` P2.

## Global Constraints

- No agent/tool write to `brief`; user/transport only.
- Old `string[]` groups migrate to records without data loss.
- Brief length bounded (≤24 KB, target 4 KB UI).
- Only members of the group receive it; no cross-group leakage.
- No new external dependency; `npm run check` passes.

## Review Focus

- Migration preserves group order/names and is idempotent.
- Brief is injected at the next turn for group members only.
- No model tool can mutate brief.
- Empty/oversized brief handled explicitly.
- Existing sidebar group UI works.

---

### Task 1: Audit groups, prompt composition, and UI

- [ ] Map sidebar_groups storage/transport, group UI, prompt composition for teams/assistants.
- [ ] Define record shape, migration, injection point, caps, tests.
- [ ] No code edits.

### Task 2: Implement group record + migration + prompt injection

- [ ] Migrate names to `{name,brief,memoryKey,updatedAt}`; preserve order.
- [ ] User-only brief write through transport/UI; no model tool.
- [ ] Inject group brief into member/assistant prompt; bound length.
- [ ] Tests.

### Task 3: Verify
### Task 4: Review
