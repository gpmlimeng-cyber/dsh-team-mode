# Context Checkpoint + Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manual Assistant DM checkpoints and handoff to a fresh main Session without losing or exposing the old Session.

**Architecture:** Persist bounded checkpoint facts in a new storage table; build facts deterministically from the existing conversation projection and active tasks; hand off by creating a fresh main Agent, injecting one durable `runtime-context` message, atomically rebinding the instance, and retiring the old main Session id. No compaction backend, no LLM summary, no team handoff.

**Tech Stack:** TypeScript, Cordis, DSH session/agent APIs, zod, React client primitives, vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-context-checkpoint-handoff-design.md`

## Global Constraints

- V1 is Assistant DM only; do not add team-Leader handoff.
- No automatic threshold detection, segmentation, or `ctx.compaction` dependency.
- Checkpoint text is deterministic facts plus a user note; never call a model.
- The handoff context must be a logged `user/message` with source `{ kind: 'runtime-context', form: 'instructions' }`; no invisible prompt-only injection.
- Do not merge checkpoint data into `assistant_memory`.
- Adding `retiredMainSessionIds` to `AssistantInstance` must not bump the record schema version; absent means `[]`.
- Never delete the old Session log.
- Handoff refuses while any queued/running/needs_input worker task exists.
- No new npm dependency.
- Every production change is test-driven; run the named test before the full `npm run check`.

## File Structure

```text
src/domain/schemas.ts                  checkpoint + retiredMainSessionIds schemas
src/domain/types.ts                    ContextCheckpoint / CheckpointFacts exports
src/runtime/checkpoint-facts.ts        bounded deterministic fact builder + handoff message
src/runtime/assistant-runtime.ts       create/list checkpoint, handoff, main setup reuse
src/service/dsh-team-mode-service.ts   checkpoint CRUD + atomic main-session advance
src/storage/domain.ts                  context_checkpoints table
src/storage/store.ts                   checkpoint table accessors
src/transport/contracts.ts             checkpoint API methods/types
src/transport/web.ts                   authenticated dispatch routes
src/client/session-rows.ts             retire old main session ids in the hidden set
src/client/api.ts                      generated method typing needs no manual edit
src/client/assistant-checkpoint.ts     note limit + validation helper
src/client/assistant-checkpoint-dialog.tsx  create/list/handoff dialog
src/client/assistant-sidebar.tsx       menu entry + dialog wiring
src/client/AgentTeam.module.css        dialog and checkpoint list styles
tests/context-checkpoint-model.spec.ts schema/store/model tests
tests/checkpoint-facts.spec.ts         fact bounds + message source
tests/agent-team-service.spec.ts       checkpoint service tests
tests/assistant-runtime.spec.ts        handoff lifecycle tests
tests/client-session-rows.spec.ts      retired session hiding
tests/client-checkpoint.spec.ts        note validation helper
```

## Review Focus

1. **Empty or nearly empty session:** checkpoint creation must return a valid empty-facts record, not throw on `.at(-1)` or index missing nodes.
2. **Active workers:** handoff must be refused before any new Agent or instance write; the DM stays usable.
3. **New-session failure:** a failed fresh Agent leaves the old `mainSessionId`, old handle, and checkpoint `ready`.
4. **Double handoff:** a consumed checkpoint cannot be handed off twice; a second click must be disabled and server-rejected.
5. **Hider race:** retired ids must remain hidden after refresh and restore the exact previous inline display only when no source hides them.

---

### Task 1: Checkpoint Model + Storage

**Files:**

- Modify: `src/domain/schemas.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/storage/domain.ts`
- Modify: `src/storage/store.ts`
- Test: `tests/context-checkpoint-model.spec.ts`
- Test: `tests/client-session-rows.spec.ts`

**Interfaces:**

- Produces:
  - `checkpointFactsSchema: z.ZodType<CheckpointFacts>`
  - `contextCheckpointSchema: z.ZodType<ContextCheckpoint>`
  - `assistantInstanceSchema` gains optional `retiredMainSessionIds: string[]`
  - `AgentTeamStore.getContextCheckpoint(id)`, `listContextCheckpoints()`, `putContextCheckpoint(value)`, `updateContextCheckpoint(id, update)`
  - `dshTeamModeDomainSpec.tables.context_checkpoints`

- [ ] **Step 1: Write the failing schema tests**

```ts
import { describe, expect, it } from "vitest";
import {
  assistantInstanceSchema,
  contextCheckpointSchema,
} from "../src/domain/schemas.js";

it("parses a bounded checkpoint and defaults status", () => {
  const parsed = contextCheckpointSchema.parse({
    schemaVersion: 1,
    id: "cp-1",
    assistantId: "a-1",
    sourceSessionId: "s-1",
    title: "Handoff",
    note: "",
    capturedThroughSeq: 12,
    facts: {
      recentMessages: [],
      activeTasks: [],
      workspacePath: "/tmp/w",
      note: "",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  expect(parsed.status).toBe("ready");
});

it("accepts a legacy instance without retired ids", () => {
  const parsed = assistantInstanceSchema.parse({
    /* complete legacy fixture from existing tests */
  });
  expect(parsed.retiredMainSessionIds).toBeUndefined();
});
```

- [ ] **Step 2: Run it and verify the failure**

Run: `npx vitest run tests/context-checkpoint-model.spec.ts`
Expected: FAIL because `contextCheckpointSchema` is not exported.

- [ ] **Step 3: Add the schemas and table**

Add `contextCheckpointSchema` with the exact fields from the spec; `note` max 4000; `facts.recentMessages` max 12 and each text max 500; `activeTasks` max 20; `status` enum with default `ready`; `targetSessionId` and `consumedAt` optional.
Add `retiredMainSessionIds: z.array(nonEmpty).max(100).optional()` to `assistantInstanceSchema`.
Export `CheckpointFacts` / `ContextCheckpoint` from `src/domain/types.ts`.
Add `context_checkpoints: domainTable<...>` to `src/storage/domain.ts` and accessors to `DomainAgentTeamStore` plus the `AgentTeamStore` interface.

- [ ] **Step 4: Run the model tests and full typecheck**

Run: `npx vitest run tests/context-checkpoint-model.spec.ts tests/client-session-rows.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/schemas.ts src/domain/types.ts src/storage/domain.ts src/storage/store.ts tests/context-checkpoint-model.spec.ts
git commit -m "feat: persist assistant context checkpoints"
```

---

### Task 2: Deterministic Facts + Create/List API

**Files:**

- Create: `src/runtime/checkpoint-facts.ts`
- Modify: `src/runtime/assistant-runtime.ts`
- Modify: `src/service/dsh-team-mode-service.ts`
- Modify: `src/transport/contracts.ts`
- Modify: `src/transport/web.ts`
- Test: `tests/checkpoint-facts.spec.ts`
- Test: `tests/agent-team-service.spec.ts`

**Interfaces:**

- Consumes: Task 1 schema/store/model.
- Produces:
  - `buildCheckpointFacts(input: { events: readonly SessionEvent[]; tasks: readonly AssistantSession[]; workspacePath: string; note: string }): { facts: CheckpointFacts; capturedThroughSeq: number }`
  - `checkpointHandoffMessage(checkpoint: ContextCheckpoint): UserMessage`
  - `AssistantRuntime.createCheckpoint(assistantId: string, note: string): Promise<ContextCheckpoint>`
  - `AssistantRuntime.listCheckpoints(assistantId: string): ContextCheckpoint[]`
  - `AgentTeamService.createAssistantCheckpoint(id, note)`
  - `AgentTeamService.listAssistantCheckpoints(id)`
  - API `assistant.checkpoint.create` / `assistant.checkpoint.list`

- [ ] **Step 1: Write failing fact-builder tests**

```ts
it('keeps only the last 12 visible messages, bounded to 500 chars', () => {
  const result = buildCheckpointFacts({ events, tasks, workspacePath: '/w', note: 'note' })
  expect(result.facts.recentMessages).toHaveLength(12)
  expect(result.facts.recentMessages.every(m => m.text.length <= 500)).toBe(true)
})

it('excludes tool nodes and keeps active tasks newest first capped at 20', () => { ... })

it('returns an empty checkpoint for a session with no visible messages', () => {
  expect(buildCheckpointFacts({ events: [], tasks: [], workspacePath: '/w', note: '' }).facts.recentMessages).toEqual([])
})
```

- [ ] **Step 2: Run it and verify failure**

Run: `npx vitest run tests/checkpoint-facts.spec.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement facts builder and handoff message**

Use `projectConversation(events, 80).nodes`; filter `kind === 'user' || kind === 'assistant'`; take last 12; collapse whitespace and truncate to 500 Unicode code units (acceptable for v1); active task statuses are `queued`, `running`, `needs_input`, newest first by `updatedAt`, cap 20.
`capturedThroughSeq` is `events.at(-1)?.seq ?? -1`.
`checkpointHandoffMessage` uses `createUserMessage({ content: [{ type: 'text', text: markdown }], source: { kind: 'runtime-context', form: 'instructions' } })`.
The Markdown labels the note as user-supplied and lists recent messages, tasks, workspace path, and the checkpoint title.

- [ ] **Step 4: Implement runtime/service/API create + list**

Runtime reads the live main Agent when available, otherwise `readStoredSessionEvents(instance.mainSessionId)`. It gets tasks from `service.listAssistantSessions(assistantId)`, builds facts, persists via `service.createContextCheckpoint(...)`.
Service validates assistant exists, note length, and persists with `status: 'ready'`.
Web dispatch validates `assistantId` and returns service results. Add contract result types.
Add service test: create/list returns only the requested assistant and note is trimmed.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/checkpoint-facts.spec.ts tests/agent-team-service.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/checkpoint-facts.ts src/runtime/assistant-runtime.ts src/service/dsh-team-mode-service.ts src/transport/contracts.ts src/transport/web.ts tests/checkpoint-facts.spec.ts tests/agent-team-service.spec.ts
git commit -m "feat: create and list assistant checkpoints"
```

---

### Task 3: Handoff Lifecycle + Retired Session Hiding

**Files:**

- Modify: `src/runtime/assistant-runtime.ts`
- Modify: `src/service/dsh-team-mode-service.ts`
- Modify: `src/transport/contracts.ts`
- Modify: `src/transport/web.ts`
- Modify: `src/client/session-rows.ts`
- Test: `tests/assistant-runtime.spec.ts`
- Test: `tests/client-session-rows.spec.ts`

**Interfaces:**

- Consumes: Task 2 `checkpointHandoffMessage`, checkpoint records.
- Produces:
  - `AssistantRuntime.handoff(checkpointId: string): Promise<{ checkpoint: ContextCheckpoint; sessionId: string }>`
  - `AgentTeamService.advanceAssistantMainSession(assistantId, mainSessionId, retiredSessionId)`
  - `AgentTeamService.handoffAssistant(checkpointId)`
  - API `assistant.checkpoint.handoff`
  - `hiddenSessionIds` includes `retiredMainSessionIds`

- [ ] **Step 1: Write failing hider test**

Add a case to `tests/client-session-rows.spec.ts`:

```ts
it("hides every retired main Session", () => {
  const ids = hiddenSessionIds(
    [],
    [{ mainSessionId: "main", retiredMainSessionIds: ["old-1", "old-2"] }],
    [],
  );
  expect([...ids].sort()).toEqual(["main", "old-1", "old-2"]);
});
```

- [ ] **Step 2: Run it and verify failure**

Run: `npx vitest run tests/client-session-rows.spec.ts`
Expected: FAIL because retired ids are not unioned.

- [ ] **Step 3: Implement retired id union**

Extend `AssistantInstanceSessionSource` with optional `retiredMainSessionIds`; add each nonblank id to the set. Keep current main and task/team sources unchanged.

- [ ] **Step 4: Write failing handoff tests**

Add tests to `tests/assistant-runtime.spec.ts`:

- refuses with `ASSISTANT_TASKS_ACTIVE` and makes no `agents.create` call when a worker is active;
- happy path creates a fresh Session, calls `followup` once with a `runtime-context` source, updates main + retired ids, marks checkpoint consumed;
- fresh-session create failure leaves the old `mainSessionId`, checkpoint `ready`, and old handle owned;
- consumed checkpoint throws `CHECKPOINT_NOT_READY`.

Run: `npx vitest run tests/assistant-runtime.spec.ts`
Expected: FAIL for the missing method.

- [ ] **Step 5: Implement handoff**

Extract the main-session setup from `start` into `mainSetup(instance): AgentSetup` and reuse it. Add `handoff`:

1. Load checkpoint and instance; require `ready`, not archived, no active tasks; reject if the current main Agent is running.
2. Create a fresh Agent with a new `session-${randomUUID()}` and the same workspace/agent options/setup.
3. `handle.agent.followup(checkpointHandoffMessage(checkpoint))`, attach workspace, flush.
4. Call `advanceAssistantMainSession` to atomically set `mainSessionId` and append the old id to `retiredMainSessionIds`.
5. Mark checkpoint consumed; add new handle to `owned`, dispose old owned handle.
6. On any failure before step 4, dispose the new handle and leave all bindings/checkpoint unchanged.

`advanceAssistantMainSession` uses `store.updateAssistantInstance` inside one update, rejects archived, increments revision, and deduplicates retired ids.

Add service/API handoff and validation.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npx vitest run tests/assistant-runtime.spec.ts tests/client-session-rows.spec.ts tests/agent-team-service.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/assistant-runtime.ts src/service/dsh-team-mode-service.ts src/transport/contracts.ts src/transport/web.ts src/client/session-rows.ts tests/assistant-runtime.spec.ts tests/client-session-rows.spec.ts
git commit -m "feat: hand off assistant context to a fresh session"
```

---

### Task 4: Checkpoint Dialog + Menu

**Files:**

- Create: `src/client/assistant-checkpoint.ts`
- Create: `src/client/assistant-checkpoint-dialog.tsx`
- Modify: `src/client/assistant-sidebar.tsx`
- Modify: `src/client/AgentTeam.module.css`
- Test: `tests/client-checkpoint.spec.ts`

**Interfaces:**

- Consumes: Task 2/3 APIs and `ContextCheckpoint`.
- Produces:
  - `CHECKPOINT_NOTE_LIMIT = 4000`
  - `checkpointNoteError(note: string): string | undefined`
  - `AssistantCheckpointDialog({ open, assistant, onClose, openSession })`

- [ ] **Step 1: Write the failing validation test**

```ts
it("accepts an empty note and rejects a note over 4000 characters", () => {
  expect(checkpointNoteError("")).toBeUndefined();
  expect(checkpointNoteError("x".repeat(4001))).toBe(
    "交接说明不能超过 4000 字",
  );
});
```

Run: `npx vitest run tests/client-checkpoint.spec.ts`
Expected: FAIL because the helper does not exist.

- [ ] **Step 2: Implement the helper**

Trim the note for validation but send the original trimmed value; return the exact error string used by the dialog.

- [ ] **Step 3: Implement the dialog**

Use `AnimatedModal` and the existing dialog CSS patterns. On open:

- load `assistant.checkpoint.list`;
- show a textarea (`maxLength=4000`) and “生成检查点” button;
- when a ready checkpoint exists, show its title/time and a “交接新会话” button;
- first click sets `confirmingId`, second click calls `assistant.checkpoint.handoff`;
- on success call `openSession(result.sessionId)` and close;
- show inline errors and a loading state.
  Empty checkpoint list must show a clear empty message, not a blank modal.

- [ ] **Step 4: Wire the assistant menu**

Add a `checkpoint` item “检查点与交接” before “助手设置”; open the dialog with the selected instance; close other menus. Do not add a second menu item for handoff.

- [ ] **Step 5: Run client tests, typecheck, and build**

Run: `npx vitest run tests/client-checkpoint.spec.ts && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/assistant-checkpoint.ts src/client/assistant-checkpoint-dialog.tsx src/client/assistant-sidebar.tsx src/client/AgentTeam.module.css tests/client-checkpoint.spec.ts
git commit -m "feat: add assistant checkpoint dialog"
```

---

### Task 5: Integration Verification

**Files:** none.

- [ ] **Step 1: Run the full gate**

Run: `npm run check`
Expected: `EXIT 0`.

- [ ] **Step 2: Verify the spec's edge cases**

- Empty Assistant with a bound but empty main Session creates a checkpoint with no recent messages.
- Active worker task blocks handoff with `ASSISTANT_TASKS_ACTIVE`.
- After handoff, old session row is hidden and new session opens.
- Second handoff of the same checkpoint is rejected.
- Restart the host and confirm the retired row stays hidden and the new main Session resolves.

- [ ] **Step 3: Commit any final fixes**

```bash
git status --short
git add -A
git commit -m "test: verify checkpoint handoff integration"
```

If no files changed, skip the commit.

---

## Self-Review

- Spec coverage: Tasks 1–4 cover model/storage, facts, create/list, handoff, hiding, API, UI, and errors. Task 5 covers full verification.
- Type consistency: `ContextCheckpoint`, `CheckpointFacts`, `retiredMainSessionIds`, `createAssistantCheckpoint`, `listAssistantCheckpoints`, `handoffAssistant` are used consistently above.
- Review Focus has a task and a test for empty sessions, active workers, create failure, double handoff, and retired hiding. UI loading/error/empty states are explicit in Task 4.
