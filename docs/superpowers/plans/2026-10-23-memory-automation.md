# Memory Automation Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Make memory maintainable without user micromanagement: opt-in capture into `proposed`, recall across stored entries, and an auditable journal/undo for accepted changes.

**Architecture:** Reuse the existing `MemoryEntry` containers. Add an opt-in capture policy that writes only `proposed` entries after a completed goal/turn, a read-only recall tool across statuses/scopes, and a bounded journal stored alongside the memory container (no new domain table). Auto-capture is off by default; only Leader/user can accept.

**Spec:** `docs/MEMORY-ARCHITECTURE.md`, `docs/DECISIONS-IDENTITY-MEMORY.md` D6.

## Global Constraints

- No auto-accept: automation writes `proposed` only.
- Default off; explicit config/member opt-in.
- No cross-team or DM leakage.
- Journal is bounded and contains before/after text + actor/reason; no secrets.
- No new domain version/table unless audit proves unavoidable.
- `npm run check` passes.

## Review Focus

- Legacy memory unchanged; capture off by default.
- Captured entries are proposed, deduped, bounded, redacted.
- Recall is read-only and scoped; cannot mutate/accept.
- Journal/undo restores exact prior content, no cross-scope access.
- No auto model call storm; one bounded capture per goal/turn.

---

### Task 1: Audit memory events, model calls, journal seams

- [ ] Map assistant/team memory writes, turn/goal completion, existing model-call utilities.
- [ ] Decide capture trigger, recall surface, journal shape, caps.
- [ ] Define tests and risks.

### Task 2: Recall + journal/undo

- [ ] Add read-only recall tools and bounded journal.
- [ ] Add undo for assistant/team entries with scope checks.
- [ ] Tests.

### Task 3: Opt-in capture to proposed

- [ ] Add config/member opt-in and one bounded capture trigger.
- [ ] Redact/dedupe; write proposed only.
- [ ] Tests.

### Task 4: Verify
### Task 5: Review
