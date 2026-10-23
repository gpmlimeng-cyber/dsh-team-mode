# Team Turn Coordinator — Design

> 2026-10-23 · 架构级设计 · Group Chat Turn Engine v1
> 上游方向: `docs/COMPETITIVE-GAPS.md` R2 / `docs/TEAM-MODE-ROADMAP.md`
> 执行约束: Superpowers + AgentTeams + dsh-plugin-guide + ponytail

## Status

Approved direction: service-side turn ordering only.
No new group-chat page, no progress broadcast, no approval capsule in v1.

## 1. Problem

The current Team Runtime delivers user and member messages directly with
`agent.followup`. Two members can be addressed while another member is still
answering, and member replies can interrupt the Leader. The result is a
workbench with per-session conversations, not a group chat with one speaker.

V1 establishes one ordered model-turn chain per team, without changing the
existing session model or building a new chat surface.

## 2. Goals

- Default user messages go to the Leader.
- Explicit `@member` routes to a current member.
- Only one model turn is active per team at a time.
- Messages received while a turn is active stay `queued` and are delivered in
  creation order after the active turn ends.
- A failed delivery stays queued and does not advance the queue.
- Queued messages survive a runtime restart.
- Ordinary chat creates no Goal or Task.

## 3. Non-goals

- New group-chat UI or a new GroupRoom entity.
- Progress broadcasts, approval capsules, group announcements, group permissions.
- Per-member turn budgets or context compaction.
- Changing `TeamMessage` schema or session parentage.
- Replacing the task board, Goal layer, or Team Epoch.

## 4. Model

### Turn state

`TeamTurnCoordinator` owns one in-memory state per team:

```ts
interface TeamTurnState {
  activeSlotId?: string;
  activeSessionId?: string;
  activeMessageId?: string;
}
```

The state is a runtime lock, not durable data. Durable queue membership is
already represented by `TeamMessage.deliveryState: 'queued'`; the message table
is the source of truth after restart.

### Ordering key

Queued messages are selected by:

```text
createdAt ASC, then id ASC
```

Only records with `deliveryState === 'queued'` participate. System outbox
notices and already delivered messages do not.

### Speaker selection

```text
explicit target (UI-selected member) wins
else one known @member in the message wins
else default to Leader
```

`@name` resolves against current member display names and slot ids. Multiple
known targets are invalid. An unknown `@name` is not a route: it remains ordinary
text and the message defaults to the Leader. `@all` is rejected unless the
sender is the Leader.

Archived members are not routable; archived teams are not routable.

## 5. Flow

### User message

1. `sendUserMessage` parses the target with the rules above.
2. Create the durable `TeamMessage` as today, initial `deliveryState: 'queued'`.
3. Submit it to `TeamTurnCoordinator`.
4. If the team has no active turn and the target is online, deliver one
   `followup`; mark delivered; record the active slot/session/message.
5. Otherwise leave it queued.

### Member message

`sendMemberMessage` uses the same submit path after validation. A member reply
to the Leader does not bypass the active turn.

### Release

On the active session's `turn/end` or transition to `idle`:

1. Verify the event belongs to the active session.
2. Clear the active turn.
3. Drain the next queued message for that team.
4. If the target is not online yet, leave the queue and retry when the member
   becomes online or recovery completes.

There is no timer-based turn stealing; a turn is released only by an event.

### Failure

If `followup` throws:

- keep the message `queued`;
- clear the active turn;
- do not skip the message;
- schedule one drain after the member is online or on the next status event.

### Restart

`recoverTeams` already restores active teams and members. After that pass, the
coordinator drains queued messages for each active team in creation order.
No new schema field is required.

## 6. UI boundary

V1 reuses the current team workbench and member conversations. It does not
render a new "who is speaking" panel. A later UI phase can read the active
speaker from a read-only runtime view.

## 7. Interfaces

New module: `src/runtime/team-turn-coordinator.ts`

```ts
class TeamTurnCoordinator {
  submit(teamId: string, messageId: string): Promise<"delivered" | "queued">;
  releaseSession(sessionId: string): Promise<void>;
  drain(teamId: string): Promise<void>;
  drainAll(teamIds: readonly string[]): Promise<void>;
  activeSlot(teamId: string): string | undefined;
}
```

Dependencies are injected, not imported globally:

- `getTeam(teamId)`
- `listMessages(teamId)`
- `putMessage(message)`
- `followup(sessionId, message)`
- `isSessionOwned(sessionId)` / `agentStatus(sessionId)`

Assignment of local member display names/slots stays in the existing team
service; routing is a pure function with a team-like input.

## 8. Error behavior

```text
TEAM_NOT_ACTIVE              no delivery
MEMBER_NOT_FOUND             explicit target is not a current member
INVALID_REQUEST              @all from a non-Leader or multiple targets
```

Delivery failures are not thrown from the background drain; they remain queued
and are reported to the runtime log.

## 9. Testing

Unit:

- default routes to Leader;
- one known `@member` routes to that member;
- multiple known targets rejected;
- unknown `@name` falls back to Leader;
- archived/unknown explicit target rejected;
- `@all` only from Leader;
- queue ordering by createdAt/id;
- one active speaker blocks a second submit;
- release drains exactly one next message;
- followup failure leaves queued and clears active;
- system outbox records are ignored.

Runtime integration:

- two user messages to different members: only first delivered;
- second delivered after first turn/end;
- member reply while Leader is active is queued;
- restart drains persisted queued messages;
- no Goal/Task is created for ordinary chat.

Verification: `npm run check`.

## 10. Deferred

- progress broadcasts / “正在思考” team messages;
- approval capsule and group-level pending approval view;
- group announcements and permissions;
- turn timeouts / cancellation policy;
- UI speaker indicator and queue view;
- per-team turn budget or concurrency > 1.
