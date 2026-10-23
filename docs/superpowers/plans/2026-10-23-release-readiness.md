# Release Readiness Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Make the plugin installable and reproducible without publishing or deploying externally.

**Architecture:** Harden package metadata, build artifacts, CI, migration/upgrade docs, and a local pack/install smoke. No npm publish, no external deployment.

**Spec:** `docs/TEAM-MODE-ROADMAP.md` P2 release, `dsh-plugin-guide` checks.

## Global Constraints

- Do NOT run `npm publish`, deploy, or push tags.
- No runtime behavior changes unless a release blocker requires it.
- `dsh-plugin-dev check` and `npm run check` must pass; remaining guide warnings must be explained.
- Package files whitelist must include all runtime assets.
- `npm pack --dry-run` and local pack smoke only.

## Review Focus

- Fresh install from tarball works in a clean profile.
- Package contains lib/locale/icon/docs needed at runtime.
- No secrets, dev files, or absolute paths in the tarball.
- CI runs guard/typecheck/tests/build.
- Version/migration notes match behavior.
- No publish/deploy commands.

---

### Task 1: Audit package/CI/release gaps

- [ ] Run guide check, pack dry-run, inspect metadata/files/scripts.
- [ ] Identify install/smoke requirements and guide warnings.
- [ ] Produce exact fix list.

### Task 2: Implement release readiness

- [ ] Fix package metadata/files, CI, docs, changelog/migration.
- [ ] Add local pack/install smoke where feasible.
- [ ] No publish/deploy.

### Task 3: Verify
### Task 4: Review
