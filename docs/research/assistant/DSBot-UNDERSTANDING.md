# DS Bot / DeepSeek-Bot — Understanding

> Commit: ae63b45c · License: Apache-2.0 · 390 files · Repo: https://github.com/Fei2411/DeepSeek-Bot
> Method: graphify AST (3387 nodes / 8917 edges) + direct reading of host/client modules.
> Claims marked [VERIFIED] were read in source; [INFERRED] come from structure/tests.

## 1. Thesis

DS Bot is a DSH plugin that turns Harness into a messaging app: bots and group chats are
long-lived contacts backed by ordinary DSH root Sessions, while one JSON state file under
`DSH_HOME/bot/` stores the roster, rooms, sessions, exchanges and memory indexes. The host half
routes messages, tracks turns, injects them into Sessions, recovers after restart, and exposes
one `/api/bot` channel; the client half shadows DSH sidebar/conversation slots to render the bot
surface, and can withdraw back to native Agent mode.

## 2. Load-bearing pieces

1. `ds-bot/index.js` — plugin entry, dependency injection, module ordering, runtime object `rt`.
   Every module installs against `rt` and calls others lazily. [VERIFIED]
2. `src/host/store.js` — one `state.json` (`bots`, `rooms`, `agents`, `exchanges`, `segments`,
   `capabilities`, `revision`), home lock, atomic replace, Session→bot/room indexes, read-only
   host when another DSH owns the lock. [VERIFIED]
3. `src/host/channel.js` — `/api/bot` command/view channel and DSH client route; the UI's only
   data plane. It projects bots with `sessionId` + `parts`, rooms with hidden member Sessions,
   models, permissions, secrets, memory flags. [VERIFIED]
4. `src/host/delivery.js` + `turns.js` — message injection into a bot/room Session, turn
   tracking, waiters, handoffs, completion routing. [VERIFIED]
5. `src/host/groups.js` + `handoffs.js` — room admin, @mention, rounds, member turns, handoff
   retries, group log. [VERIFIED]
6. `src/host/memory.js` — per-bot/room memory files and prompt injection; memory panel API.
   [VERIFIED]
7. `src/host/resume.js` — restart recovery: running turns and undelivered inbox messages are
   noted durably and re-driven. [VERIFIED]
8. `src/client/index.js` — shadow slots for sidebar, header, composer, conversation cells;
   `surface.mode` switches Bot mode vs native Agent mode. [VERIFIED]

## 3. Subsystems

### Host runtime
Ordered modules: diagnostics, store, models, providers, permissions, turns, handoffs, delivery,
roster, folders, agents, prompt, time-context, tools, chat-index, groups, approvals, resume,
memory, parts, images, secrets, connectors, capabilities, schedules, browser, usage, update,
dsh-update, thinking, feed, channel. [VERIFIED]

- **Bots**: one root Session per bot; `bot.sessionId` is the current chat part; `parts` are
  earlier segments after context reset/compaction. [VERIFIED]
- **Rooms**: group has an admin and hidden member Sessions; room log is separate from member
  chats; group Session never reaches a model. [VERIFIED]
- **Agents**: plain DSH Agent Sessions, restricted from team tools, shown separately. [VERIFIED]
- **Chat index**: SQLite FTS5 over Session logs with BM25; trigram tokenizer for Chinese.
  [VERIFIED]
- **Store lock**: one writer per DSH home; other host becomes read-only. [VERIFIED]

### Client surface
- Shadows sidebar workspaces, brand, footer actions, conversation header/cells/composer.
- `surface.mode = bot | agent`; Bot mode paints team UI, Agent mode withdraws slots/styles.
- Approvals, questions, secret requests, widgets are custom cells in the conversation.
- Uses DSH primitives (`@deepseek-ai/dsh-client-ui-primitives`) and native Session APIs.
  [VERIFIED]

## 4. Representative flow (bot direct message)

1. UI posts a message to `/api/bot` (channel command). [VERIFIED]
2. Host resolves/creates the bot's root Session; delivers a user-role message with a source
   describing sender/chat. [VERIFIED `delivery.js`]
3. DSH Agent runs the turn; host listens to Session events, tracks turn state, streams updates
   over the client channel. [VERIFIED]
4. Reply is projected into the bot chat; memory/usage/turn status update. [VERIFIED]
5. If the bot hands work to another bot/room, `handoffs/turns` creates waiters and routes the
   result back; group rounds track each member's status (speaking/posted/working/waiting). [VERIFIED]

## 5. Surprising connections

- **Segments/parts are the multi-session mechanism**: a bot keeps one identity/session, but
  context can be segmented (after reset/compaction) without creating a new bot. [VERIFIED]
- **Room Session is a control shell, not a model context**: the room's snapshot is attached to
  the member message that answers. [VERIFIED `turns.js`]
- **State lock beats distributed coordination**: second host becomes read-only rather than
  merging writes. [VERIFIED]
- **The client can flip back to native DSH UI** by withdrawing all shadow slots; bot mode is a
  surface, not a fork. [VERIFIED]
- **No new Session event types**: bots/rooms are indexed outside Session logs. [VERIFIED]

## 6. Interrogation

- **Core trick**: treat bot DMs and rooms as views over ordinary DSH root Sessions; keep all
  product state in one versioned JSON with a single writer; use the `/api/bot` channel as the
  only data plane.
- **Public contracts**: `/api/bot` commands/views, `state.json` schema, bot/room Session
  headers/sources, client slot surface.
- **Load-bearing deps**: DSH `sessions`, `sessionController`, `agents`, `agentPresets`,
  `workspaceRegistry`, `connection`, `tools`, `systemPrompt`, `llm`.
- **Edge behavior**: host lock/read-only, restart resume, message delivery retry, turn waiters,
  group hop limits, context segmentation.
- **10× risks**: state.json size/write contention (lock/atomic replace), large room logs,
  Session catalogue growth, SSE payload size.

## 7. What we should copy vs not

Copy:
- One root Session per bot + segment/part model for context reset.
- State/index module with one writer and read-only fallback.
- Delivery/turn/waiter separation; restart resume.
- Room admin + @mention + hidden member Sessions.
- Client slot shadows but **do not** shadow the native conversation for our assistant mode.
- `/api` view/command channel.

Do not copy:
- Full sidebar replacement / custom chat cells (we want native DSH conversation).
- Room-specific complexity in phase 1.
- Chat index / capabilities / connectors until needed.
