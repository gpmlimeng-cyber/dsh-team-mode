# Autonomous Ops Phase 2 Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Let a team continue operating without a user nudge: bounded goal budgets, busy park/resume, and a minimal routine trigger.

**Architecture:** Build on Team Turn Coordinator, task reminders, and Goal/Task state. Add goal budget counters, an explicit parked/waiting state for busy targets, and a single disposable routine tick that enqueues a Leader-addressed message. No external scheduler, no auto-execution of tasks.

**Spec:** `docs/COMPETITIVE-GAPS.md` Autonomous Ops, `docs/TEAM-MODE-ROADMAP.md`.

## Global Constraints

- No schema-version bump; optional fields only.
- No external cron/queue; one in-process disposable tick.
- Budget exhaustion pauses/blocks explicitly; never silent stop.
- Busy park queues one message; no spam/replay.
- Model turns still obey one-active-speaker.
- `npm run check` passes.

## Review Focus

- Budget counters survive persistence and stop at the limit with a visible state.
- Busy target parks once, resumes once; no duplicate delivery.
- Routine tick is bounded, disposable, and only enqueues a message.
- Legacy teams unchanged; archived teams skipped.
- No auto-execution/approval bypass.

---

### Task 1: Audit goal budget, busy queue, timer seams

- [ ] Map Goal/Task state, turn coordinator queue, message delivery, timers.
- [ ] Define budget fields/state, park/resume contract, routine shape, and tests.

### Task 2: Implement budget + park/resume

- [ ] Add bounded goal/task budget counters and exhausted state.
- [ ] Park busy delivery once and resume on idle.
- [ ] Add focused tests.

### Task 3: Implement minimal routine trigger

- [ ] Add one disposable routine tick that enqueues a Leader message.
- [ ] Bound frequency/duplicate runs; skip archived/inactive.
- [ ] Add focused tests.

### Task 4: Verify
### Task 5: Review
