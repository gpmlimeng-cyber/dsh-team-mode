# Assistant Creation Parity Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Bring 新建助手 closer to OpenMausBot's creation experience without inventing unsupported capabilities: sectioned identity/persona/model/permissions, starting roles, group placement, and clear unsupported areas.

**Architecture:** Restructure the existing `AssistantCreateDialog` into sections. Reuse existing assistant-instance fields (name/avatar/instructions/provider/model/reasoning/agentPreset/permissionPreset/group/mascot) and existing create/update transports. Hide Access/Routines/Voice/Skills sections that DSH or this plugin cannot really configure per assistant; document why instead of faking controls.

**Reference:** OpenMausBot `src/components/NewBotDialog.tsx` (Identity/Soul/Skills/Memory/Routines/Access/Model/Permissions/Voice), `src/components/bot-settings/*`.

## Global Constraints

- Keep native DSH conversation and the current create→ensure→open flow.
- No new backend feature merely to fill a tab; unsupported sections are omitted with an explicit note.
- No fake sharing/voice/routine controls.
- Existing direct-create tests keep passing.
- `npm run check` passes.

## Review Focus

- Sections map to real fields; nothing decorative writes.
- Group selection persists and appears in the sidebar.
- Starting roles fill real instructions/model defaults, not fake templates.
- Memory/skills/routines/access/voice are omitted or explicitly read-only.
- Create remains one confirmation; no duplicate assistant.

---

### Task 1: Audit MausBot parity and our fields

- [ ] Compare NewBotDialog sections/fields with our schema/transports.
- [ ] Define supported sections, role presets, group write, unsupported notes, tests.
- [ ] No code edits.

### Task 2: Implement sectioned create dialog

- [ ] Identity (name/avatar/group), Persona (instructions + role), Model, Permissions.
- [ ] Real field values; no unsupported controls.
- [ ] Create/ensure/open flow unchanged; tests.

### Task 3: Verify
### Task 4: Review
