# Assistant mode research

Research artifacts for the DSH assistant mode (Grok Bot shape), produced with deepfork on two
Apache-2.0 repositories.

## Scope

- **OpenMausBot** — open-source Grok Bot alternative; bot roster, task threads, Assignment
  runtime, decision model, memory, approval UX.
- **DS Bot / DeepSeek-Bot** — DSH-native bot plugin; Bot↔Session mapping, group chats, memory,
  restart recovery, client surface.

Both licenses are Apache-2.0. Only behavioral/architectural notes are stored here; no source
code was copied. Rebuilds, if any, must be clean-room and include attribution.

## Artifacts

- [OpenMausBot understanding](OpenMausBot-UNDERSTANDING.md)
- [DS Bot understanding](DSBot-UNDERSTANDING.md)
- [Landing plan](../../ASSISTANT-LANDING-PLAN.md)
- [Competitor landscape](../../ASSISTANT-COMPETITORS.md)
- [Feasibility study](../../ASSISTANT-FEASIBILITY.md)

## Method and evidence

- Repositories cloned shallow; graphify AST used for structure:
  - OpenMausBot: 34,742 nodes / 107,864 edges / 674 communities.
  - DS Bot: 3,387 nodes / 8,917 edges / 134 communities.
- Load-bearing claims were verified by reading the actual files; each understanding document
  marks VERIFIED vs INFERRED.
- Analyzed commits:
  - OpenMausBot `1123705e`
  - DS Bot `ae63b45c`
- The original deepfork workspace (including cloned source) is outside the repo at
  `research/deepfork-out/`; do not commit it.

## REA status

REA was attempted against the locally installed OpenMausBot app bundle. The REA MCP provider
could not see host paths (`ENOENT`) and its Ghidra provider failed on the local Swift toolchain.
The landing plan therefore relies on deepfork static analysis plus the public app/runtime
documentation. Re-run REA on the next machine if deeper native protocol analysis is needed.
