---
name: maintain-project-knowledge
description: "Bootstrap and maintain a Project Lifecycle knowledge base. Use when entering a project without an accepted project map, calibrating or repairing domain coverage, materializing verified capability knowledge, changing knowledge topology or constraints, selecting a bounded knowledge baseline for PRD Lifecycle, or absorbing an accepted Knowledge Diff."
---

# Maintain Project Knowledge

Construct and maintain the accepted project-knowledge line. Keep it separate from delivery evolution: `run-prd-lifecycle` owns Feedback, PRDs, delivery evidence, acceptance, and closure, while this Skill owns bounded knowledge selection and accepted knowledge writeback.

Use the fixed project-owned root `docs/project-lifecycle/`. If neither its authoritative `project-map.json` nor a resolvable compact project pointer exists, bootstrap from bounded project evidence; do not search the user's machine for another knowledge base. Do not use this Skill for an ephemeral action with no durable knowledge effect or to recreate the delivery lifecycle.

## Reference Routing

Load only the one reference needed for the current decision. Load another reference later only when the state or unresolved question changes; never preload the set.

| Current trigger | Load |
| --- | --- |
| Select the smallest current context, resolve a project pointer, decide task sufficiency, or return the PRD knowledge handoff | [Context routing](references/context-routing.md) |
| Enter a project without a map, survey it lightly, present candidate boundaries, or run initial/ongoing calibration | [Bootstrap and calibration](references/bootstrap-and-calibration.md) |
| Deepen a confirmed boundary, decide whether durable knowledge is justified, or create/update a bilingual capability asset | [Materialization](references/materialization.md) |
| Add or change a node, owner, relationship, propagated constraint, semantic ID, or descendant disposition | [Topology and constraints](references/topology-and-constraints.md) |
| Validate and apply an accepted delivery Knowledge Diff, record `NO_CHANGE`, or consider project-level ownership promotion | [Knowledge absorption](references/knowledge-absorption.md) |
| Current knowledge, task-linked active work, and a closed summary are insufficient for an audit, regression, incident, explicit ID, or historical comparison | [Archive retrieval](references/archive-retrieval.md) |

## Ordered Lifecycle

Follow the states in order. Resume at the earliest state invalidated by new evidence; do not skip a stop or human gate.

| State | Stop condition | Owning reference | Allowed durable write | Human gate |
| --- | --- | --- | --- | --- |
| DISCOVER | A bounded evidence pack and one-at-a-time candidate cards expose observations, inferences, and gaps; broad scanning stops. | [Bootstrap and calibration](references/bootstrap-and-calibration.md) | None. | None; discovery is provisional. |
| CALIBRATE | The user supplies corrections or explicitly continues with the candidate map. | [Bootstrap and calibration](references/bootstrap-and-calibration.md) | None before the initial response. | Initial calibration is mandatory before bulk deepening. |
| CONFIRM_BOUNDARY | Each candidate is confirmed, renamed, split, merged, rejected, or left unresolved. | [Bootstrap and calibration](references/bootstrap-and-calibration.md) | Accepted skeleton fields in `project-map.json` and derived navigation only. | Explicit confirmation for every new or changed semantic boundary. |
| DEEPEN | The confirmed boundary has sufficient authoritative evidence for every proposed fact, or an evidence gap is recorded. | [Materialization](references/materialization.md) | None; evidence collection does not create current truth. | Ask when evidence cannot settle a high-impact or cross-domain conclusion. |
| MATERIALIZE | The paired asset meets the semantic threshold and structural validators, or remains absent/proposed. | [Materialization](references/materialization.md) | One canonical bilingual asset pair, matching map state, and derived indexes. | Explicit approval before new or changed semantic truth becomes current. |
| ROUTE/MAINTAIN | The smallest context is sufficient, or one material ambiguity/change candidate has a focused stop. | [Context routing](references/context-routing.md) | Evidence-backed non-semantic maintenance, or the exact approved semantic write set. | Confirm boundary, ownership, routing-impacting alias, or other semantic change. |
| ABSORB | The candidate Knowledge Diff is accepted and applied, explicitly `NO_CHANGE`, or stopped for baseline, ownership, evidence, topology, or conflict. | [Knowledge absorption](references/knowledge-absorption.md) | Canonical fact updates and mechanically derived synchronized views in one accepted write set. | Explicit approval for semantic writeback and every material conflict disposition. |
| VERIFY | Relevant Phase 1 validators pass and durable files agree on IDs, baselines, ownership, evidence, pairing, topology, and state. | [Materialization](references/materialization.md) | Mechanical bilingual/index repair already authorized by the accepted semantic decision. | Validation never substitutes for unresolved semantic approval. |

## Non-Negotiable Gates

English is read by default; update English and Chinese pairs atomically.

Boundary confirmation is not fact verification.

Only verified facts may become current.

Do not read archive bodies without an Archive Access Receipt.

Do not apply a Knowledge Diff whose baseline or ownership is unresolved.

Structural validation proves contract integrity, not product truth. Keep observations, inferences, unknowns, and accepted facts distinct. When a proposed change can alter future routing, ownership, restriction, or decision outcomes, treat it as semantic and stop for explicit human review.

## PRD Lifecycle Handoff

Return only the bounded selection below to `run-prd-lifecycle`. Use stable IDs and version references, keep exclusions and questions concise, and use the current shared stop-code contract. This Skill does not write or mutate the PRD Context Receipt.

<!-- prd-lifecycle-handoff
knowledge_baseline: knowledge-revision-ref
primary_domain_id: primary-domain-id
affected_domain_ids: []
selected_context:
  - id: selected-fact-or-asset-id
    version_ref: version-ref
applicable_constraints:
  - id: constraint-id
    version_ref: semantic-revision-ref
exclusions: []
open_questions: []
stop_code: shared-stop-code
-->

For knowledge absorption, accept only a candidate produced by `run-prd-lifecycle` from accepted delivery evidence. A handoff proposal is never an accepted outcome, and neither Skill may bypass the other's authority.
