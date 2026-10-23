# Task Reminders and Follow-up Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Let tasks carry a due time and reminder time, and have the team surface at most one bounded reminder instead of silently forgetting follow-up.

**Architecture:** Add optional `dueAt`/`remindAt`/`remindedAt` to tasks. A single, disposable runtime tick scans open tasks, emits a team message/notification to the owner or Leader, and stamps `remindedAt` once. No new scheduler service, no auto-execution.

**Spec:** `docs/COMPETITIVE-GAPS.md` Autonomous Ops, `docs/TEAM-MODE-ROADMAP.md` P2.

## Global Constraints

- No schema-version bump; optional fields only.
- Reminder does not change task status or auto-start work.
- At most one reminder per task per `remindAt`; no repeated spam.
- Timer is cleaned up on runtime dispose; no global process leak.
- `npm run check` passes.

## Review Focus

- Legacy tasks unchanged; no reminder without `remindAt`.
- Due/remind timestamps validate and survive round-trip.
- One reminder, delivered once, bounded; no loop or duplicate.
- Archived/completed/cancelled tasks never remind.
- Timer disposal and multiple teams are safe.

---

### Task 1: Audit task/timer/message seams

- [ ] Map task update, runtime dispose, message/outbox, and owner/Leader routing.
- [ ] Define exact fields, tick interval, reminded stamp, and tests.

### Task 2: Implement reminders

- [ ] Add optional fields and tool params.
- [ ] Add a disposable reminder tick; emit one bounded notification and stamp `remindedAt`.
- [ ] Add focused tests for legacy, due/remind, one-shot, terminal, dispose.

### Task 3: Verify
### Task 4: Review
