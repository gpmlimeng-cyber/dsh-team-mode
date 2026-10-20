# Migration to DeepSeek Harness 0.2.1-rc.2

This fork keeps Agent Team's product behaviour while moving it from
**DSH 0.1.1-rc.2** to **DSH 0.2.1-rc.2**. Every change below is a compatibility
substitution; no feature was dropped except where the host removed the API.

## Why the migration was necessary

Three packages the 0.1.x plugin imported were retired before 0.2.x and never
published again, so a profile that provides 0.2.1-rc.2 can no longer resolve
them:

| 0.1.x package | 0.2.1-rc.2 replacement |
| --- | --- |
| `@deepseek-ai/dsh-client-runtime` | `@deepseek-ai/dsh-client-modules`; client plugins take `Context` from `@deepseek-ai/cordis` |
| `@deepseek-ai/dsh-host-apiproxy` | removed; human interaction moved to the `userQuestions` / `approval` seams |
| `@deepseek-ai/dsh-agent-presets` | `@deepseek-ai/dsh-agent-preset` + `@deepseek-ai/dsh-agent-preset-registry` |

## Host half

### Human interaction (`src/runtime/team-interaction-bridge.ts`)

0.1.x consumed one global transport mux stream (`ctx.apiProxy.events.mux`) and
answered by `rpcId` (`ctx.apiProxy.respond`). 0.2.x has no mux: questions and
approvals are **Agent-scoped Cordis waterfalls**.

- The bridge now attaches a listener pair per member Agent scope
  (`attachAgent(agentCtx, sessionId)`) and registers on
  `user-questions/request` and `approval/request`.
- Raising a request stores a pending record and returns the promise the
  waterfall awaits; `respond()` settles it. A session outside the team
  delegates with `next()`, so the standard UI still answers it.
- `request.signal` abort expires the pending record.
- Registration happens inside the member's Agent setup, before publication.
- `startInteractionBridge()` / `start()` are gone: there is no mux to consume.

### Session and persistence

| 0.1.x | 0.2.1-rc.2 |
| --- | --- |
| `session.events` | `session.snapshotEvents()` (full log; `surface` exposes only `nodes`) |
| `sessionPersistence.inspect(id)` | `sessionPersistence.stat(id)` for metadata; `open(id, 'read')` + `read()` + `close()` for events |
| `snapshot.id` / `snapshot.createdAt` | `snapshot.header.id` / `snapshot.header.createdAt` |

`src/runtime/session-log.ts` owns the read-only stored-log helper.

### Agent creation

`AgentSetup` now receives the unpublished Agent as its second argument, so setup
reads `agent` from the parameter instead of the removed `ctx.agent`.

### Agent presets

| 0.1.x | 0.2.1-rc.2 |
| --- | --- |
| `agentPresets.standingKeyFor(id)` | `agentPresets.acquireScope(id)` — a revision lease exposing `key`; dispose it |
| `agentCtx.agentPresets` | `agentPresets.mount(agentCtx, id)` (unchanged name, mount is still the entry point) |

A member leases the preset scope for its lifetime and releases it on Agent
scope disposal; a cold catalog read leases for the single read.

### Session events and message sources

- `assistant/chunk` no longer exists. `conversation-projector` rebuilds text,
  reasoning and reasoning timing from `assistant/attempt` (embedded stream) and
  `assistant/message`, and reads tool results from `tool/result` messages rather
  than `ContentBlock`s.
- `MessageSourceMap` lost the `plugin` variant and is merge-extensible, so the
  plugin declares its own relay source:

  ```ts
  declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
      'plugin-relay': { kind: 'plugin-relay'; plugin: string; form: 'relay' }
    }
  }
  ```

  The projector keeps a legacy fallback for already-persisted 0.1.x logs.

## Client half

- `ClientContext` is gone; client entries use `Context` from
  `@deepseek-ai/cordis`, with the service faces brought in by importing the
  provider plugins' client entries (`dsh-client-ui-renderer` for `slots`,
  `dsh-api-workspace-controller` for `workspaces`, `dsh-client-ui-workspace` for
  `uiWorkspace`).
- `ctx.workspaces.pickDirectory()` moved to `ctx.uiWorkspace.pickDirectory()`.
- `slots.register` now takes the business-face factory as an `inject` option;
  `slots.inject(key, cb)` still exists and is kept because activation order
  against `ui-settings` / `ui-layout` is not constrained.
- Icons were renamed by size: `…Outline16`/`…Outline14` → `…OutlineRegular`,
  `…Outline20` → `…OutlineMedium`.
- `MessageText` → `UserTextRun`; Markdown renderers now require a `labels`
  prop (`src/client/markdown-labels.ts`).
- `Modal`'s headless branch no longer accepts `closeLabel`.

## Installation

The package ships its restart-applied bundle layer, so the Desktop profile loads
it through `dsh.profile.bundles`:

```bash
npm run build
npm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/limeng-dsh-team-mode-0.2.0.tgz
# then add "@limeng/dsh-team-mode" to dsh.profile.bundles in the profile's package.json
```

`dsh plugin` forwards to `pnpm`, so a profile with a supply-chain
`minimumReleaseAge` policy needs `--config.minimumReleaseAge=0` for packages
published inside the window.

## Verification performed

- `npx tsc --noEmit` — 0 errors.
- `npx vitest run` — 108 tests pass.
- `node scripts/check-architecture.mjs` — passes.
- `npm run build` — host and client bundles build; the client bundle is a
  `window.__ModuleLoader__.load({id, factory})` script whose only externals are
  `react`, `react/jsx-runtime` and `@deepseek-ai/dsh-client-ui-primitives`.
- Entry import against the Desktop host closure resolves every `@deepseek-ai/*`
  import and exports `name` / `inject` / `apply` / `Config`.
- All twelve injected service names exist in the live host.


## Coexistence with the official Agent Team

0.2.1-rc.2 ships `@deepseek-ai/dsh-experimental-dsh-team-mode-profile`, which owns the
loader row id `dsh-team-mode`, the storage domain `agent_team`, and the slot entry ids
`dsh-team-mode`. A fork installed beside it must not reuse any of those, or the loader
fails on a duplicate entry id and `storageDomain.open()` rejects a domain whose spec
does not match. This fork therefore namespaces every host-global identity:

| Surface | This fork |
| --- | --- |
| loader row id (`cordis.patch.yml`) | `dsh-team-mode` |
| Cordis plugin name | `dsh-team-mode` |
| client plugin name | `dsh-team-mode-client` |
| slot entry ids | `dsh-team-mode` |
| storage domains | `dsh_team_mode`, `dsh_team_mode_assistant_builder` |
| settings label / launcher label | `Agent 团队（二开）` / `团队（二开）` |

Member tool names (`team_get_task_board`, `team_create_task`, `team_update_task`,
`team_send_message`) stay as they are: they register on each member's own Agent
scope and never on the host tool registry.

## Known limitations

- **No token-level live streaming through session events.** 0.2.1 appends
  settlements, not chunks, so a member transcript updates at attempt/step
  settlement. Restoring per-token typing needs the process-local
  `agent/assistant-stream` frames in `team-runtime` / `assistant-builder-runtime`,
  which this migration did not change.
- `session.snapshotEvents()` is marked deprecated by the host but is the only
  full-log read in 0.2.1.
- Login/turn UI is untested inside a real Desktop window; only the static and
  test-level checks above were run.
