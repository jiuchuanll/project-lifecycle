# Obligations

Use this reference only for an exceptional requirement that one durable owner owes another and that must be resolved, waived, or superseded before the relevant closure. Route ownership remains defined by [Intake routing](intake-routing.md).

## Not a Progress Board

Ordinary architecture, implementation, testing, acceptance, closure, and default knowledge handoff are lifecycle stages, not secondary obligations. Do not mirror tasks, sprint status, or every dependency into obligation instances.

## Creation Threshold

An obligation needs an allowed shared kind, owning artifact, required result, evidence references, current business-result state, and any blocking relationship. Create it only when normal owner relationships cannot reliably carry the exceptional cross-domain, dependency, conflict, knowledge-readiness, knowledge-handoff, or multi-repository coordination result.

Store a PRD obligation in PRD Frontmatter. Store a non-PRD obligation in that smallest root asset. Store a durable knowledge-only obligation in the relevant reviewed pending entry. Never create a global `obligations.json`.

Externally referenced obligation IDs use `{owner_artifact_id}#{obligation_id}`. The local obligation ID is unique within its owning asset; changing or replacing its meaning requires a reviewed successor rather than silent reuse.

## Resolution

The business-result state records whether the required result is open, resolved, waived, or superseded. It is not execution progress. Resolution cites exact durable evidence. Waiver identifies the approving authority and accepted risk. Supersession links the successor. Closure checks only obligations owned by or explicitly blocking the closing artifact.
