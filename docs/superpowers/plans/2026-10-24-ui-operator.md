# UI Operator Experience Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Bring Grok Bot-style operator clarity to the native DSH UI: a sidebar bot roster and an attention center, without replacing the native conversation, composer, or plugin slots.

**Architecture:** Extend existing sidebar/global-overview projections with bot identity, current work, status, and attention counts. Keep native Session rows and conversation untouched; use semantic tokens and existing slots. Mobile collapses the roster.

**Reference:** [GrokBot Guide](https://github.com/anightmonarch/grokbot-guide) patterns: one bot per job, status first, attention first, deliverables over chat.

## Global Constraints

- No custom chat/composer/message list.
- No replacement of native session page.
- No cloud-computer/office animation.
- Use DSH semantic tokens; no custom color system.
- Leader/member/assistant identity comes from real state; no fake status.
- `npm run check` passes.

## Review Focus

- Rows show real status/current task, not decorative fake data.
- Attention counts are derived and filterable; no duplicates.
- Native conversation/composer unchanged.
- Mobile sidebar remains usable and scrollable.
- No new tool/transport unless audit proves necessary.

---

### Task 1: Audit sidebar/status/attention data and slots

- [ ] Map current sidebar rows, team avatar, team-sidebar-data, global overview counts, mobile behavior, CSS tokens.
- [ ] Define roster row fields, attention categories/counts, empty/error/loading, tests.
- [ ] No code edits.

### Task 2: Implement sidebar bot roster

- [ ] Add avatar/name/role/current task/status/attention badge, grouped by team.
- [ ] Keep native rows and mobile collapse; test.

### Task 3: Implement attention center

- [ ] Derive attention categories and counts; add filter/section.
- [ ] No fake/duplicate counts; test.

### Task 4: Verify
### Task 5: Review
