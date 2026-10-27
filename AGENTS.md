# Repository Guidelines

## Project Structure & Module Organization

This repository is a DeepSeek Harness Web plugin written in TypeScript and React.

- `src/client/` contains the injected React UI, client API, state, and CSS Module styles.
- `src/domain/` defines Zod schemas, domain types, and errors.
- `src/service/`, `src/runtime/`, `src/storage/`, and `src/transport/` implement team operations, Agent lifecycle, persistence, and Web transport.
- `tests/*.spec.ts` contains Vitest unit and integration-style tests.
- `docs/` records requirements, architecture decisions, feasibility constraints, and implementation status.
- `scripts/check-architecture.mjs` enforces plugin boundaries. Build output is generated in `lib/`.

Do not modify DeepSeek Harness source code. Integrate only through its documented plugin APIs, Slots, services, and semantic design tokens.

## Build, Test, and Development Commands

- `npm install` installs dependencies and runs the package preparation build.
- `npm run build` bundles server and client entries with `tsdown`.
- `npm run typecheck` runs TypeScript without emitting files.
- `npm test` runs all Vitest tests once.
- `npm run test:watch` reruns tests during development.
- `npm run guard:architecture` checks prohibited cross-boundary access.
- `npm run check` runs the architecture guard, typecheck, tests, and production build; run it before every commit.
- `npx @deepseek-ai/dsh web` starts Harness locally after this plugin is installed or linked into the active Web profile.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, and no semicolons, matching existing TypeScript. Prefer explicit return types on exported or asynchronous APIs. Use `PascalCase` for React components and types, `camelCase` for functions and variables, and descriptive CSS Module names such as `memberTileLeader`. Use Harness `--dsw-*` semantic variables instead of custom color systems.

## Testing Guidelines

Vitest is the test framework. Name tests `*.spec.ts` and place them in `tests/`. Add regression coverage for service mutations, persistence migrations, event projection, and client request behavior. No numeric coverage threshold is configured; changed behavior must have focused assertions. Always finish with `npm run check`.

## 多人共用工作区规矩（AgentTeams）

同一个检出上可能同时有多个人/智能体在改不同任务。以下动作会**伤到别人正在写的代码**，一律禁止：

- ❌ `git stash` / `git stash pop`——会把队友的在飞改动整批收走；
- ❌ `git checkout -- <path>` / `git restore`——同上，且更难恢复；
- ❌ `git commit --amend`——会改写已落地提交，可能覆盖别人刚提交的内容（本项目已发生过一次）；
- ❌ `git reset --mixed/--hard` 到公共分支历史——会重建/丢弃别人的提交。

应做的事：

- ✅ 提交用**路径限定**：`git add <你自己的文件> && git commit -- <你自己的文件>`；共享文件（`AgentTeam.module.css`、`sidebar.tsx`、`schemas.ts`、`service`）默认**不要整文件 `git add`**；
- ✅ 需要单独验证时，用 `git worktree add` 建**独立 worktree**，而不是在主工作区挪 HEAD；
- ✅ 提交前 `git status` 确认暂存区里只有自己的文件；
- ✅ 报告里写清「我改了哪些文件」，让别人能核对提交内容。

## Commit & Pull Request Guidelines

Follow the repository’s Conventional Commit style: `feat:`, `fix:`, `refactor:`, `style:`, `test:`, or `docs:` followed by an imperative summary. Keep commits scoped and avoid generated or unrelated changes. Pull requests should explain user-visible behavior, architecture impact, and verification performed; link relevant issues and include before/after screenshots for UI changes. Call out schema migrations, Harness API assumptions, and known limitations explicitly.
