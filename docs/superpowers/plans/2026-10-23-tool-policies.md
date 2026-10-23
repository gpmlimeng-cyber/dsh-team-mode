# Member Tool Policies Plan

> **For agentic workers:** use the AgentTeams plan. Steps use checkbox (`- [ ]`).

**Goal:** Let deployment owners declare named tool policies and let each team member select one, without exposing raw allow/deny lists to the model or widening privileges.

**Architecture:** Add a deployment-configured `toolPolicies` map (id → allowed member tool names), optional `toolPolicy` on each member slot, and filter the member tool surface at registration time. An omitted policy keeps the full member baseline; an unknown policy id fails closed. Policies are additive config only; no per-call allow/deny input.

**Tech Stack:** TypeScript, Zod, Cordis, Vitest.

**Spec:** `docs/TEAM-MODE-ROADMAP.md` P1 tool policies, AgentTeams toolPolicies precedent.

## Global Constraints

- No schema-version bump; optional member policy id.
- Model cannot pass an allow/deny list.
- Unknown policy id fails explicitly at create/update and at activation; never falls back to baseline.
- Leader tools and user UI unaffected.
- No new tool; `npm run check` passes.

## Review Focus

- Policy filtering cannot grant a tool outside the member baseline.
- Unknown policy rejected; omitted policy preserves behavior.
- Team/member isolation: a policy cannot cross teams.
- Tool count/prompt/docs remain consistent.
- No model-visible raw policy lists.

---

### Task 1: Audit tool registration and config

- [ ] Map member tool registration, config schema, transport/member create path.
- [ ] Define policy shape, baseline, and filtering point.

### Task 2: Implement tool policies

- [ ] Add config + member field + validation.
- [ ] Filter member tool registration by policy.
- [ ] Add tests for allowlist, unknown id, omitted default, no privilege widening.

### Task 3: Verify
### Task 4: Review
