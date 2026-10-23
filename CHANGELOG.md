# Changelog

All notable changes to `@limeng/dsh-team-mode` are recorded here. The package
follows semantic versioning; `0.x` minors may change behaviour.

## 0.4.0 — 2026-10-23

Release-readiness release. No schema migration is required: every domain field
added in this cycle is optional and older team records load unchanged.

### Added

- **Assistant bot mode**: assistants can run as standalone chat bots with
  archive/restore, unread and attention state, per-assistant model and
  permission overrides, task workers with bounded concurrency, and recovery of
  orphaned worker sessions.
- **Team and assistant memory**: `team_memory_propose` / `team_memory_list` /
  `team_memory_accept`; `team-safe` memory is injected read-only into member
  prompts. Team memory survives `team.reset` and disappears with the team.
- **Goals and orchestration modes**: `team_mode_goal_create` / `_list` /
  `_update`; `direct` / `single` / `orchestrated` modes; `paused` goals when a
  Leader change opens a new team epoch.
- **Task claim, inbox, and thread context**: `team_mode_task_claim`,
  `team_mode_inbox`, and optional `thread_id` / `goal_id` / `reply_to` on team
  messages.
- **Task quality gates**: optional `kind`, `acceptance`, `reviewedTaskId`, and
  `verdict`; review/verification tasks need `verdict=pass` to complete, and
  `needs_revision` / `reject` must carry findings.
- **Attempt ownership fence**: task owner changes rotate `attempt_id`; member
  updates must present the current token.
- **Deployment tool policies**: `toolPolicies` in plugin config narrows the
  member tool baseline; policies can only restrict, never grant.
- **Release tooling**: `npm run release:smoke` packs the plugin, verifies the
  tarball contents, and installs it into a throwaway `DSH_HOME` without
  publishing. GitHub Actions runs guard, typecheck, tests, build, and the pack
  smoke on Node 22 and 24.

### Packaging note

- `npm pack --ignore-scripts` is the reproducible pack path.
- A default `npm pack` rebuilds `lib/`; lightningcss CSS-module key order can
  change `lib/client.js` bytes between builds even when semantics are identical.
  This is a build-determinism limitation, not an install/compatibility change.

### Changed

- Package version is now `0.4.0`; install docs, tarball names, and migration
  notes use the same pin.
- The published file whitelist ships only runtime and user documentation:
  `lib` with `!lib/*.map`, `lib/index.js`, `locale/*.json`, `icon.svg`,
  `cordis.patch.yml`,
  READMEs, CHANGELOG, `docs/*.md`, and the five `docs/assets/dsh-team-mode`
  screenshots referenced by those docs. Source maps, `src/`, `tests/`,
  `scripts/`, `.github/`, `docs/assets/ui-review/`, and internal plans are no
  longer packed.
- `zod` is a peer dependency only (plus a dev dependency); it was removed from
  `dependencies` because the Harness host already provides it.
- The client CSS virtual module id is a hash of the source path, so
  `lib/client.js` comments no longer embed absolute build paths.
- Tarball size dropped from 24.9 MB to ~7.5 MB packed (~9.2 MB unpacked).

### Release verification (2026-10-23)

- `npm run check` — architecture guard, `tsc --noEmit`, 39 test files / 434
  tests, production build: pass.
- `npm run release:smoke` — pack + required/forbidden file checks + absolute
  path/secret scan + install into a throwaway `DSH_HOME`: pass.
- `npm view @limeng/dsh-team-mode` — `404`; nothing has been published, and
  this release deliberately did not publish, deploy, or tag.

### Known `dsh-plugin-dev check` exceptions

`dsh-plugin-dev check` reports one failure and two warnings that are accepted
for 0.4.0:

1. `manifest-peers` (failure).
   - The checker reads `@deepseek-ai/*` subpath imports such as
     `@deepseek-ai/dsh-client-ui-renderer/client` as package names. The three
     `/client` subpaths are declared through their base packages and are not
     missing peers; this is a checker false positive.
   - The checker expects a broad `>=0.1.2-rc.1 <0.3.0` range and older
     `@deepseek-ai/cordis@^4.0.2` / `@deepseek-ai/schemastery@^3.18.2` pins.
     This fork is only tested against DSH `0.2.1-rc.2` with cordis `4.0.5` and
     schemastery `3.18.5`, so it deliberately keeps the narrow tested ranges
     instead of claiming untested compatibility.
2. `manifest-package-manager` (warning): builds and CI use npm with the
   committed `package-lock.json` (lockfile v3). `pnpm` is only used by
   `dsh plugin add` on the user's machine, so pinning the repo to pnpm would
   describe the wrong install path.
3. `readme-five-langs` (warning): this project intentionally ships English and
   Simplified Chinese only; the other three translations do not exist.
   `readme-consistency` is also skipped because the Chinese README is named
   `README_CN.md`, while the checker only recognizes `README-<lang>.md`.
   `redline-persona-role` and `redline-no-hardcoded-tunables` are skipped
   because the checker does not detect the plugin’s exported Config schema (src/config.ts).

## 0.3.0 — 2026-10-20

- AionUi-style Team Mode: team grouping in the session sidebar, Leader plus
  independent member sessions, and native DSH conversation reuse.
- Parallel view with one official composer per member column, board view with
  task lanes, and per-member identity colours.
- Member switcher, inline rename, and add-member flow.
- 24 registered `team_*` tools (21 primary names plus `team_create_task`,
  `team_update_task`, and `team_get_task_board` compatibility aliases).
