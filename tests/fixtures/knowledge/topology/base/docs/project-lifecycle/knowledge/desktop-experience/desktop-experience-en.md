---
id: desktop-experience
knowledge_state: current
paired_asset: desktop-experience.md
last_verified_baseline: baseline-1
implementation_refs: ["repo:src/desktop"]
verification_refs: ["test:desktop"]
---

# Desktop experience

## Purpose and current boundary

Owns accepted desktop interaction.

## Current facts

### `desktop-shell-fact`

<!-- project-lifecycle:fact
fact_id: desktop-shell-fact
revision: 1
evidence_refs: ["repo:src/desktop", "test:desktop"]
last_verified_baseline: "baseline-1"
-->

Desktop shell owns the workspace frame.

#### Known limits

Workspace-specific content remains domain-owned.

<!-- /project-lifecycle:fact -->

## System and data relationships

Owns the desktop boundary.

## Implementation and resource map

Desktop entry points.

## Quality state

Verified at baseline-1.

## Dependencies

No declared dependency.

## Known limits and unknowns

Runtime-specific layout remains bounded.

## Provenance

Accepted project evidence.

<a id="constraint-desktop-privacy"></a>
<!-- project-lifecycle:constraint id=desktop-privacy revision=1 -->
Desktop privacy applies to every descendant.
<!-- /project-lifecycle:constraint -->

<a id="constraint-desktop-shell"></a>
<!-- project-lifecycle:constraint id=desktop-shell revision=1 -->
Desktop shell applies only to its owner.
<!-- /project-lifecycle:constraint -->
