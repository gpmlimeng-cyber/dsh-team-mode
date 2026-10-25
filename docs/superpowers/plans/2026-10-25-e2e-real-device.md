# Real-Device Team E2E Test Plan

> **For agentic workers:** use the AgentTeams plan. Test on an isolated DSH_HOME, never production data.

**Target:** `http://127.0.0.1:3099/?token=B_8zmTEyJfI3jWpV3uIxhIkxUnRTrjzw0Ht2K1XmZ9w`  
**DSH_HOME:** `/tmp/dsh-e2e-home`  
**Chromium:** `/root/.cache/ms-playwright/chromium-1208/chrome-linux/chrome`

## Goal

Verify the shipped team/assistant UI and flows in a real browser, not just unit tests. Report pass/fail with screenshots/DOM evidence; do not change product code.

## Test Matrix

1. Startup/auth and no console errors.
2. Sidebar: team group, member roster, status/current task, attention mark, collapse/mobile 390px, native session rows intact.
3. Assistant: create/open assistant DM, send a short message, status/error display.
4. Team lifecycle: create team, add member, open team page, team main agent panel.
5. Group chat/turn: user message defaults to Leader, @member routes, queued message when busy.
6. Task: create task, owner, claim, inbox, status; quality review verdict (if UI exposes).
7. Goal: create/list, progress, blocked/dependency display.
8. Memory: propose/list/accept, recall query, journal/undo (if UI exposes).
9. Reminders: due/remind fields and one reminder (if UI exposes).
10. Epoch: change Leader, old sessions/queued tasks archived/paused, no old write.
11. Handoff: team checkpoint create + handoff, old session hidden, new session receives state.
12. Global overview/attention center: counts distinct, filters don't move counts, pending approvals not hidden.
13. Mobile 390px: roster collapse, scroll, no clipping.
14. Regression: native chat/composer untouched; no custom chat shell.

## Constraints

- Only `/tmp/dsh-e2e-home`; never modify `/root/.dsh/storages` or production teams.
- Use test names prefixed `e2e-`.
- Capture screenshot or DOM evidence for each failure.
- Do not change TypeScript/client code; test reports only.
- If a flow cannot be driven via UI, record it as blocked with reason, not a pass.

## Deliverables

- `docs/testing/2026-10-25-e2e-report.md` (created by tester) with matrix, steps, evidence, failures.
- Screenshots under `/tmp/e2e-screens/`.
- Independent verification of every failure; final review verdict.
