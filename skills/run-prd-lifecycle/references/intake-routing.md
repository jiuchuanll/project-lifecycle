# Intake Routing

Use this reference only for a new intake, a material ambiguity before durable ownership, or a material correction to the active main flow. It owns the closed route vocabulary and its meanings.

## Closed Primary Routes

Exactly one active primary route is required.

| Route | Use when | Durable owner |
| --- | --- | --- |
| `KNOWLEDGE_UPDATE` | The accepted project knowledge itself is the target and no delivery change is needed. | Knowledge-maintenance candidate or reviewed pending change. |
| `PRD_DELIVERY` | A bounded product outcome needs durable intent, success criteria, delivery, verification, and closure. | PRD. |
| `NON_PRD_DELIVERY` | Engineering, repair, documentation, migration, or operational work needs durable evidence but no product-requirement owner. | Small non-PRD delivery root. |
| `OUTSIDE_PLUGIN` | The request has no durable effect owned by either lifecycle Skill. | None. |

`NEEDS_USER` is a temporary stop, never a durable owner or fifth route. Use it only when accepted knowledge cannot distinguish materially different owners or scopes. Normalize an obvious spelling variation and consult the current map before asking; do not interrupt for every unfamiliar word.

## Routing Inputs

Require a bounded request summary, accepted knowledge selection or its stop, existing owner reference when present, and evidence references supporting the supplied route. The deterministic validator checks the supplied decision; it never invents one.

An explicit user request for a PRD authorizes its creation. If the Agent infers that a PRD is necessary, present a compact boundary proposal and obtain confirmation before durable creation. A small technical fix, one-off experiment, evidence-only update, or knowledge correction does not become a PRD merely because it involves code.

## Combined Effects

Choose the route that owns delivery execution. Record a knowledge effect as a later bounded handoff; do not create peer primary routes. When the intake is knowledge-only, hand it to the knowledge Skill. When delivery also changes accepted understanding, complete delivery first and produce a Knowledge Diff candidate at closure.

## Main-Flow Correction

Before durable materialization, replace the transient decision without creating history. After materialization, do not edit the existing owner's primary route in place: close, cancel, or withdraw that owner with a reason; create a successor only if the corrected flow needs durable ownership; and link the successor to the former owner.

A correction outside the Plugin closes the current owner but does not create a global correction ledger. A later lifecycle request is a new intake, not an automatic resurrection.

## Examples

- “Record the now-accepted Wiki ownership fact” is knowledge-only when no product or engineering delivery remains.
- “Redesign Wiki navigation with user-visible success criteria” normally needs a PRD owner.
- “Repair a deterministic migration script and retain test evidence” can use the non-PRD delivery owner.
- “Summarize this paragraph for the chat” stays outside the Plugin when no durable outcome is requested.
- “Wiki” pronounced or typed imprecisely should first be associated with the accepted project map; ask only if multiple material interpretations remain.
