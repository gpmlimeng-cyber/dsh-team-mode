# Raft-Style Task Claim, Inbox, and Thread Context Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Let idle team members claim ready work safely, see a focused inbox, and keep task handoffs in thread context, building on attempt fencing.

**Architecture:** Add an explicit claim tool that atomically sets owner + attempt on a ready unowned task. Derive a member inbox from existing tasks/messages/approvals; no new inbox table. Add optional thread/task/goal links to messages and propagate them on task dispatch.

**Tech Stack:** TypeScript, Zod, Cordis, Vitest.

**Spec:** `docs/RAFT-ADOPTION.md`, `docs/TEAM-MODE-ROADMAP.md`.

## Global Constraints

- Claim is optional; Leader manual dispatch remains the default.
- Every claim produces a fresh attempt; stale/duplicate claims rejected.
- No auto-scheduler, no background poller, no new inbox storage.
- Thread fields optional; legacy messages unchanged.
- `npm run check` passes.

## Review Focus

- Two members claiming one ready task: exactly one succeeds.
- Member cannot claim blocked/assigned/completed/cancelled tasks.
- Inbox respects membership/approval authority and does not leak other teams.
- Thread links survive dispatch and do not break legacy messages.
- No unbounded inbox/thread payloads.

---

### Task 1: Audit task states and message flow

- [ ] Map claim-eligible states, owner/attempt transitions, task dispatch messages, inbox sources.
- [ ] Define exact tool names/params and thread propagation.
- [ ] Identify tests and caps.

### Task 2: Task claim

- [ ] Add a member claim tool and atomic owner/attempt assignment.
- [ ] Reject blocked/owned/stale/cross-team claims; return current owner/attempt.
- [ ] Keep Leader dispatch unchanged.
- [ ] Add focused tests.

### Task 3: Member inbox

- [ ] Derive assigned/ready tasks, unread messages, approvals, stale attempts.
- [ ] Add a read-only tool with bounded results.
- [ ] Enforce same-team/member scope.
- [ ] Add focused tests.

### Task 4: Thread context

- [ ] Add optional threadId/taskId/goalId/replyTo to messages.
- [ ] Propagate on task dispatch and message send.
- [ ] Keep legacy messages compatible.
- [ ] Add focused tests.

### Task 5: Verify

- [ ] Concurrent claim, inbox isolation, thread round-trip, legacy.
- [ ] `npm run check`.

### Task 6: Review

- [ ] Independent review of current bytes.
