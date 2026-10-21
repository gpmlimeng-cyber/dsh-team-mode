# OpenMausBot — Understanding

> Commit: 1123705e · License: Apache-2.0 · 4461 files · Repo: https://github.com/milind-soni/OpenMausBot
> Method: graphify AST (34,742 nodes / 107,864 edges / 674 communities) + direct reading of runtime/store/UI/docs.
> Claims marked [VERIFIED] were read in source/docs; [INFERRED] come from graph/structure.

## 1. Thesis

OpenMausBot is a local-first Electron chat app plus a local harness server that turns Claude,
Codex, Grok and other CLI agents into persistent bot contacts. A bot is a contact with a model,
soul/persona, memory workspace, computer, connected apps and a set of task threads. Rooms and
channels group bots and people. All cross-bot work is represented by one Assignment runtime
record, with one wake lane; a small decision model only chooses which bot answers an unmentioned
room message. The client is a chat shell that renders bots as contacts, not a session browser.

## 2. Load-bearing pieces

1. `server/index.ts` — the local HTTP + SSE API surface (bots, turns, approvals, model catalog,
   computer lifecycle, connectors, config). [VERIFIED graph hub]
2. `server/store.ts` — persisted `BotRecord` / `TaskRecord` / `GroupRecord` registries. A bot has
   `threadId` (selected task) and `tasks: TaskRecord[]`; `mainThreadId` is the default standing
   thread. Tasks are threads with titles, projects, model/approval/cwd, unread/pin/snooze.
   [VERIFIED]
3. `server/runtime/types.ts` + `server/runtime/runtime.ts` — the Assignment runtime: every
   hand-off is one record with root/parent/depth, origin, requester, assignee, mode, reply,
   status, outcome, level, executions/restarts, result/evidence. [VERIFIED]
4. `server/harness/registry.ts` + `bus.ts` — driver registry (Claude/Codex/Grok/etc.) and the
   fan-in event bus every client folds. [VERIFIED]
5. `server/agents-bridge*` / `server/drivers/*` — provider adapters. [VERIFIED structure]
6. `src/components/Sidebar.tsx` + `ChatView.tsx` — contact-style bot rows; a bot expands into its
   task threads; chat view renders one selected task; group rows expand into room threads.
   [VERIFIED]
7. `server/workspace.ts` + `docs/memory.md` — per-bot workspace and Markdown memory:
   `MEMORY.md` loads first 200 lines / 24 KB each turn; topic files load on demand; daily logs;
   credential redaction; atomic owner-only writes. [VERIFIED]
8. `docs/decision-model.md` + server deciders — optional fast classifier picks a room responder
   for unmentioned messages; ≥0.6 threshold; always fails open to lead. [VERIFIED]
9. `shared/wire.ts` — canonical bot/task/group wire shapes shared by server and app. [VERIFIED]

## 3. Subsystems

### App / client
- React 19 + Electron shell; server-backed store, one reducer, no client transports.
- Sidebar: bots as contacts, each expandable into task threads; rooms/channels; search, pin,
  unread, archive, context menu; "New chat" under a bot.
- ChatView: messages, streamed reasoning, tool calls, approvals, questions, secrets, widgets,
  citations, computer panel, voice. [VERIFIED]

### Harness server
- HTTP commands + one SSE event stream; drivers are Claude/Codex/Grok CLI adapters.
- Permission broker and approval cards; computer lifecycle; Composio connectors; routines;
  schedules; webhooks; MCP server. [VERIFIED docs/readme]

### Job runtime
- Assignment tree; origin/requester/assignee; `work|consult|notify`; `resume|poll|none`.
- Status: queued/running/needs_input/waiting/resume/completed/failed/cancelled.
- One wake lane/inbox; envelope/report/resume; restart reconciliation; budgets, stall guards.
- Approval level computed at enqueue; no work state outside the runtime module. [VERIFIED]

### Bots / threads
- A bot owns multiple task threads; one is selected (`threadId`), one main thread.
- Task threads carry model/approval/cwd/project, unread, pin, snooze, archive.
- Bot profile: name/title/description/soul, color/mascot/avatar, notifications, visibility.
- Memory is a private workspace, not chat history. [VERIFIED]

### Rooms / channels
- Rooms group bots + people; room threads (one per member), lead/responder rules.
- `@mention` directs; unmentioned messages under Auto ask the decision model, else lead.
- Channels group bots and files by context; room has its own transcript/instructions/folder.
  [VERIFIED]

## 4. Representative flow (person → bot)

1. App posts a turn to the bot's selected task thread.
2. Server resolves the bot/task, chooses driver/model, builds persona + memory + tools context.
3. Driver runs a turn; events stream over SSE; approvals/questions become cards.
4. Message/turn is persisted; UI folds events into the thread; task updatedAt/unread changes.
5. If the turn hands work to another bot, an Assignment is enqueued for the assignee thread;
   the requester gets an inbox item and is woken on settlement. [VERIFIED types/docs]

## 5. Surprising connections

- **Bot = contact; task = thread**: the sidebar shows one bot, but its tasks are nested threads.
  This is exactly the "one bot entry, many sessions" shape. [VERIFIED]
- **Assignment runtime is the only work state**: rooms, routines, webhooks, peer calls and bot
  handoffs share one record/lifecycle/wake lane. This avoids the multi-clock/multi-wake mess.
  [VERIFIED]
- **Room's own thread never runs a model**: member turns run in member room threads; the room is
  a coordination surface. [VERIFIED pattern]
- **Decision model only routes, never works**; it fails open to a lead, so it cannot block a turn.
  [VERIFIED]
- **Memory is files, not a vector DB**: MEMORY.md loads every turn; topic files are recall-indexed
  and read on demand. [VERIFIED]
- **Approval level is computed once at enqueue**, not patched onto threads. [VERIFIED]

## 6. Interrogation

- Core trick: model every bot hand-off as one Assignment record with a tree and one wake lane;
  bots are contacts with task threads; decisions are separate from execution.
- Public contracts: HTTP/SSE API, `WireBot`/`WireTask`/`WireGroup`, Assignment envelope/report,
  bot package/team import format, memory file layout.
- Load-bearing deps: CLI drivers, SQLite/store, SSE, Electron, Composio, computer providers.
- Edge behavior: restart reconciliation, approval levels, budgets, stall guards, duplicate
  requests (`rework`), room hop limits, decision-model failure fallback.
- 10× risks: 34k-node codebase complexity, driver/CLI lifecycle, SSE fan-in, local computer
  sandbox, approval race conditions, room concurrency.

## 7. What we should copy vs not

Copy:
- Bot = contact + task threads; one visible bot entry, tasks nested/hidden by default.
- Assignment record: root/parent/depth, origin/requester/assignee, mode/reply, status/outcome,
  result/evidence, restart reconciliation, one wake lane.
- Decision model as a **router only**, fail-open to a lead/default.
- Memory as Markdown: MEMORY.md + topic files + daily logs, load budget, redaction.
- Approval levels computed at enqueue; cards in chat.
- Room admin + @mention + hidden member threads.

Do not copy:
- Electron/driver/computer/connectors/voice stack.
- Full chat shell replacement; we reuse DSH native conversation.
- Large 34k-node architecture; implement the minimal runtime subset.
