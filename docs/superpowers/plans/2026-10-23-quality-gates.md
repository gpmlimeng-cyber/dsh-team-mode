# Task Quality Gates Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Make team tasks express quality stages and prevent a review/verification task from completing without a passing verdict.

**Architecture:** Add optional `kind`, `acceptance`, `reviewedTaskId`, and `verdict` to tasks. Verification/review tasks complete only with `pass`; `needs_revision`/`reject` fail with findings. Leader-only creation/linking. No automatic repair loop in P0.

**Tech Stack:** TypeScript, Zod, Cordis, Vitest.

**Spec:** `docs/TEAM-MODE-ROADMAP.md` P1 quality gates.

## Global Constraints

- No schema-version bump; optional fields only.
- Existing tasks without kind/verdict behave unchanged.
- Review/verification authority remains owner/Leader.
- No auto-repair/auto-review scheduling in P0.
- `npm run check` passes.

## Review Focus

- Review cannot complete with needs_revision/reject or missing verdict.
- Only review owners can set verdict; others cannot.
- reviewedTaskId must exist in the same team and be implementation/repair.
- Legacy tasks and board views unchanged.
- No automatic task creation/loop.

---

### Task 1: Audit task/tool lifecycle

- [ ] Map task create/update, owner/attempt, tool surface, board views.
- [ ] Define kind/verdict/reviewedTaskId transitions and tests.

### Task 2: Implement quality fields and validation

- [ ] Add optional fields and tool params.
- [ ] Enforce review/verification verdict rules and same-team link.
- [ ] Update prompt/docs/tool count.
- [ ] Add focused tests.

### Task 3: Verify
### Task 4: Review
