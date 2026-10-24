# DSH Ecosystem Reuse Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Expose DSH profile capabilities to teams/members with a read-only inventory and policy binding, without building a plugin sandbox or duplicating connectors.

**Architecture:** Audit what DSH already exposes (tools, skills, MCP, slots, permissions). Phase 1 adds a read-only capability inventory and a design for capability groups compiled into existing `toolPolicies`. Third-party plugin side effects remain host-trusted and explicitly documented.

**Spec:** `docs/COMPETITIVE-GAPS.md` DSH Ecosystem Reuse.

## Global Constraints

- No plugin sandbox claim; only exposed tool surfaces are governed.
- No raw model allow/deny lists.
- Capability groups compile to existing tool policy allowlists.
- Leader unaffected; omitted policy preserves baseline.
- No new connector/cloud/mobile code.
- `npm run check` passes.

## Review Focus

- Inventory is read-only and source-attributed.
- Groups cannot widen beyond baseline.
- Unknown groups/policies fail closed.
- Host-trusted third-party side effects are documented, not hidden.
- No new tool unless audit proves unavoidable.

---

### Task 1: Audit DSH capability APIs and policy seams

- [ ] Map DSH tool/skill/MCP/slot registries accessible to a plugin.
- [ ] Map current `toolPolicies` resolution and member activation.
- [ ] Propose inventory shape, capability groups, risk metadata, tests.
- [ ] No code edits.

### Task 2+: Implement only after audit decisions.
