# Team Turn Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one ordered model-turn chain per team: Leader-first routing, explicit @member routing, and durable queued delivery when a turn is active.

**Architecture:** A pure routing function resolves the target; a `TeamTurnCoordinator` owns one in-memory active speaker per team and drains `TeamMessage.deliveryState=queued` records in createdAt/id order; TeamRuntime routes user and member messages through the coordinator and releases on turn/end or idle.

**Tech Stack:** TypeScript, Cordis, DSH agent/session APIs, zod domain types, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-team-turn-coordinator-design.md`

## Global Constraints

- Service-side only: no new group-chat page, no progress broadcast, no approval capsule.
- One active model turn per team; system outbox notices are not queued turns.
- Queue source of truth is the existing `TeamMessage.deliveryState`; no schema field for turn state.
- `@all` is accepted only from the Leader; v1 does not fan out a broadcast, it stays a Leader-addressed message and fanout remains deferred.
- Unknown `@name` is ordinary text and defaults to the Leader; unknown explicit target/unknown member is an error.
- Do not create Goals or Tasks for ordinary chat.
- No new npm dependency.
- Run the named focused tests before `npm run check`.

## File Structure

```text
src/runtime/team-turn-routing.ts       pure target resolution + mention parsing
src/runtime/team-turn-coordinator.ts   per-team active speaker + durable queue drain
src/runtime/team-runtime.ts            wire submit, release, recovery, dispose
src/runtime/team-command-handler.ts    member message path returns queued/delivered
src/domain/errors.ts                   only if a new explicit error code is truly needed
tests/team-turn-routing.spec.ts        routing matrix
tests/team-turn-coordinator.spec.ts    queue/active/failure/recovery behavior
tests/team-turn-runtime.spec.ts        runtime submit/release wiring with fakes
```

## Review Focus

1. A user message defaults to Leader; a known `@member` routes there; explicit target beats mention.
2. Two submits cannot both become active; the second stays queued and is delivered after release.
3. Queue order is deterministic by createdAt then id, regardless of insertion timing.
4. Followup failure leaves the message queued, clears active, and does not skip it.
5. Restart drains persisted queued messages exactly once, without duplicating a delivered message.
6. No Goal/Task is created for ordinary chat; team outbox notices are ignored by the coordinator.

---

### Task 1: Pure target routing

**Files:**

- Create: `src/runtime/team-turn-routing.ts`
- Test: `tests/team-turn-routing.spec.ts`

**Interfaces:**

```ts
export interface TurnRoutingTeam {
  leaderSlotId: string;
  members: Record<
    string,
    { id: string; displayName: string; role: "leader" | "member" }
  >;
}

export function resolveTeamTarget(input: {
  team: TurnRoutingTeam;
  content: string;
  senderSlotId?: string;
  explicitSlotId?: string;
}): { slotId: string; reason: "explicit" | "mention" | "default" };
```

- [ ] **Step 1: Write failing tests**

Cover:

- no mention → `leaderSlotId`, reason `default`;
- `@Alpha` → member `a`, reason `mention`;
- explicit `b` beats `@Alpha`;
- two known mentions → `INVALID_REQUEST`;
- unknown `@Ghost` → Leader, not an error;
- unknown explicit slot → `MEMBER_NOT_FOUND`;
- `@all` from a member → `INVALID_REQUEST`;
- `@all` from Leader → Leader, reason `mention` (v1 no fanout);
- member display names that contain spaces still resolve the longest exact mention;
- whitespace/case normalization as decided: trim and compare display names case-insensitively.

Run: `npx vitest run tests/team-turn-routing.spec.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the resolver**

Use one regex pass for `@` tokens, then match each token against display names and slot ids sorted longest-first. Do not treat an email-like `x@y` as a mention: require start-of-string or whitespace before `@`. Explicit target wins before mention parsing. Validate only current team members.

- [ ] **Step 3: Run tests and typecheck**

Run: `npx vitest run tests/team-turn-routing.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/team-turn-routing.ts tests/team-turn-routing.spec.ts
git commit -m "feat: route team messages to one target"
```

---

### Task 2: TeamTurnCoordinator

**Files:**

- Create: `src/runtime/team-turn-coordinator.ts`
- Test: `tests/team-turn-coordinator.spec.ts`

**Interfaces:**

```ts
export interface TeamTurnDeps {
  getTeam(teamId: string): TeamAggregate;
  listMessages(teamId: string): TeamMessage[];
  putMessage(message: TeamMessage): Promise<void>;
  followup(sessionId: string, message: TeamMessage): void;
  sessionState(sessionId: string): "online" | "offline" | "running";
  hasMessage(sessionId: string, messageId: string): boolean;
  warn(message: string, error?: unknown): void;
}

export class TeamTurnCoordinator {
  constructor(deps: TeamTurnDeps);
  submit(teamId: string, messageId: string): Promise<"delivered" | "queued">;
  releaseSession(sessionId: string): Promise<void>;
  drain(teamId: string): Promise<void>;
  drainAll(teamIds: readonly string[]): Promise<void>;
  activeSlot(teamId: string): string | undefined;
}
```

- [ ] **Step 1: Write failing tests**

Use an in-memory fake with teams, messages, followup calls, session states, and hasMessage:

- first submit with idle target → delivered and active;
- second submit while active → queued, no second followup;
- release active session → next queued message delivered in createdAt/id order;
- target offline → queued; after state becomes online and drain → delivered;
- followup throws → message remains queued, active cleared, warn called once;
- `hasMessage` true → skip followup, mark delivered (restart duplicate guard);
- team not active or archived → queued, no followup;
- system outbox is not in `listMessages` input, so no behavior change;
- two teams can each have one active speaker independently.

Run: `npx vitest run tests/team-turn-coordinator.spec.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the coordinator**

Serialize per team with a promise chain. Select only `deliveryState === 'queued'` records, sort createdAt/id, resolve recipient session from the team member, and skip messages whose recipient slot is archived/missing (leave queued and warn).

Set active only around the delivery attempt. Call `followup` only when `sessionState === 'online'` and `hasMessage` is false; on success persist `deliveryState: 'delivered'`, then clear active. On failure keep queued, clear active, and warn.

`releaseSession` maps session id back to team/slot through owned teams; if it matches the active session, clear and call `drain`. It must be safe when no active turn exists.

`drainAll` runs teams sequentially and is safe to call after recovery.

- [ ] **Step 3: Run tests and typecheck**

Run: `npx vitest run tests/team-turn-coordinator.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/team-turn-coordinator.ts tests/team-turn-coordinator.spec.ts
git commit -m "feat: serialize team turns with a durable queue"
```

---

### Task 3: Wire runtime submit, release, and recovery

**Files:**

- Modify: `src/runtime/team-runtime.ts`
- Modify: `src/runtime/team-command-handler.ts`
- Test: `tests/team-turn-runtime.spec.ts`

**Interfaces:**

- `TeamRuntime` constructs one `TeamTurnCoordinator` with:
  - team lookup, message list/put, owned-agent followup, session state, `sessionHasMessage`;
  - `warn` through `ctx.logger.warn`.
- `sendUserMessage(teamId, content, targetSlotId?)` resolves the target with `resolveTeamTarget`, persists the record as queued, submits, and returns the record with the resulting delivery state.
- `sendMemberMessage(...)` creates its relay/record as queued and submits instead of calling `port.followup` directly. Keep its validation and return shape compatible with callers; return `queued` when the coordinator queued it.
- On `agent/status` idle for an owned session, call `turns.releaseSession(String(agent.id))`.
- On `turn/end` for an owned session, call `turns.releaseSession(String(session.id))` before the existing error recording.
- After `recoverTeams` has ensured members online, call `turns.drainAll(activeTeamIds)`.
- On dispose, no timers are added by the coordinator; outstanding per-team chains settle naturally.

- [ ] **Step 1: Write failing runtime tests**

Use a fake service/agent port with two members and record followup calls:

- default user message targets Leader;
- `@Alpha` targets member a;
- while Leader is active, a second user message to member a stays queued;
- releasing the Leader session delivers the queued member message;
- a member `sendMemberMessage` while Leader is active is queued and delivered after release;
- recovery calls `drainAll` and delivers persisted queued messages once.

Run: `npx vitest run tests/team-turn-runtime.spec.ts`
Expected: FAIL because no coordinator is wired.

- [ ] **Step 2: Implement wiring**

Import the coordinator and routing helper. Replace direct `port.followup` calls in `sendUserMessage` and `sendMemberMessage` with queued submit. Keep `team.message.send` and member tool return shapes compatible. Add `releaseSession` calls in the existing status/session listeners. Add recovery drain after member readiness.

Do not change `TeamMessageDispatcher` delivery for system/outbox notices in this task.

- [ ] **Step 3: Run focused tests and typecheck**

Run: `npx vitest run tests/team-turn-routing.spec.ts tests/team-turn-coordinator.spec.ts tests/team-turn-runtime.spec.ts tests/team-command-handler.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full gate**

Run: `npm run check`
Expected: EXIT 0.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/team-runtime.ts src/runtime/team-command-handler.ts tests/team-turn-runtime.spec.ts
git commit -m "feat: route all team turns through the coordinator"
```

---

### Task 4: Independent verification

**Files:** none.

- [ ] Run `npm run check` on the final head.
- [ ] Confirm default Leader routing, @ routing, single active speaker, queued late reply, failure retention, restart drain, no Goal/Task creation, and system notice bypass.
- [ ] Record any unavailable edge (real host restart) as UNKNOWN, not PASS.

---

### Task 5: Independent review

- [ ] Review the final head against the spec and plan.
- [ ] Check Review Focus 1–6 with file/line evidence.
- [ ] Return `pass` or findings with required fixes; do not modify product code.

---

## Self-Review

- Spec coverage: routing, one active speaker, durable queue, failure retention, restart recovery, no UI/progress/capsule.
- Type consistency: `resolveTeamTarget`, `TeamTurnCoordinator`, `submit`, `releaseSession`, `drainAll`, `activeSlot`.
- The `@all` fanout is explicitly deferred; the plan accepts Leader-only @all without broadcast to keep v1 service-only.
- Review Focus has a test/step for each risk.
