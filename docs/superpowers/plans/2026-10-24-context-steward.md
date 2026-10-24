# Context Steward: Checkpoint and Team Handoff Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Keep long-running teams coherent: checkpoint before context gets unwieldy, and let the Leader hand off the Team Session to a fresh Session without changing the team, Goal, tasks, or membership.

**Architecture:** Reuse the existing assistant checkpoint/handoff model. Add an explicit team handoff that archives the current Team Session, creates a fresh Leader Session from checkpoint facts, and preserves Goal/Task/memory/epoch. Add an opt-in threshold checkpoint trigger; no automatic handoff.

**Spec:** `docs/COMPETITIVE-GAPS.md` Context Steward, `docs/MEMORY-ARCHITECTURE.md`.

## Global Constraints

- No automatic Leader change or Team Epoch bump.
- Handoff preserves team id, member sessions, Goals, tasks, attempts, memory.
- Old Team Session retired; no reparent.
- Threshold trigger off by default; only checkpoint, never handoff.
- Checkpoint facts redacted and bounded.
- `npm run check` passes.

## Review Focus

- Team handoff preserves all state except the Team Session id.
- Old Session cannot write after handoff (ownership/epoch fence).
- Threshold checkpoint is opt-in, once per window, bounded, redacted.
- No auto handoff/leader change; no cross-team leakage.
- Manual assistant handoff still works.

---

### Task 1: Audit checkpoint, team session, and threshold seams

- [ ] Map assistant checkpoint/handoff, team session ownership, epoch, goals/tasks/memory.
- [ ] Define team handoff contract, threshold config, and tests.

### Task 2: Implement team handoff

- [ ] Add explicit Leader handoff preserving team state; retire old session.
- [ ] Add focused tests and UI/tool path.

### Task 3: Implement opt-in threshold checkpoint

- [ ] Add config threshold and one bounded checkpoint trigger.
- [ ] No auto handoff; tests.

### Task 4: Verify
### Task 5: Review
