---
id: wiki-workspace
knowledge_state: current
paired_asset: wiki-workspace.md
last_verified_baseline: abc123
implementation_refs:
  - repo:src/wiki
verification_refs:
  - test:wiki-layout
---

# Wiki workspace

### Wiki workspace layout

<!-- project-lifecycle:fact
fact_id: fact-wiki-layout-model
revision: 4
evidence_refs:
  - code-ref
  - test-ref
last_verified_baseline: abc123
-->

Wiki workspace currently uses a three-column layout.

#### Known limits

- Small-window mode still falls back to two columns.

<!-- /project-lifecycle:fact -->

## Verification

The layout is covered by the desktop integration suite.
