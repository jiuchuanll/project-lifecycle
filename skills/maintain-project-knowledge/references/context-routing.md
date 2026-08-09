# Context Routing

Use this reference to select the smallest accepted knowledge context for a task and to return a bounded selection to PRD Lifecycle. It owns selection semantics, not PRD runtime receipt creation.

## Inputs and Source Order

1. Resolve `docs/project-lifecycle/project-map.json`, or a compact project pointer whose governance locator resolves to a matching accepted map.
2. Read the English generated index and English capability assets by default. Treat the Chinese files as the user-facing mirrors.
3. Route to the most specific confirmed node matching the user's language, purpose, scope, stable aliases, and current facts.
4. Add only applicable global principles, declared dependencies, governing constraints, coordination seams touched by the task, and task-linked active delivery.
5. Stop when the selected primary domain and necessary dependencies are current enough for this task and remaining unknowns cannot change the decision.

Do not recursively read parents, children, neighbors, or delivery history. Parentage loads only applicable propagated constraints. A dependency is loaded only when the task relies on it; a coordination peer is loaded only when the shared seam is touched.

## Clarification Threshold

Normalize obvious spelling variants and attempt knowledge-grounded association before interrupting the user. Ask one focused question only when the unresolved choice would materially change context or output, current knowledge cannot support a reliable primary domain, the interpretation would change a boundary or canonical owner, or the choice is high-risk/cross-domain.

Show the plausible interpretations and their evidence. A one-off phrase stays transient. Persist an alias only when repeated use, stable project evidence, or a former official name gives it durable and unambiguous retrieval value. A collision, replacement, routing impact, or implied boundary change requires explicit human confirmation.

## Bounded Selection Result

Return the accepted `knowledge_baseline`, one `primary_domain_id`, sorted and deduplicated `affected_domain_ids`, selected stable IDs with version references, applicable constraint IDs with revisions, material exclusions, open questions, and one shared stop code. Do not add evidence bodies, dialogue, hidden reasoning, tool logs, archive content, or delivery lifecycle fields.

`run-prd-lifecycle` may use the selection to create or refresh its own Context Receipt. This Skill must not create, replace, clean up, or claim ownership of that receipt.

## Stops and Writes

- Stop as sufficient when the bounded current context supports the task.
- Stop for the user when a material route ambiguity remains.
- Stop for evidence when a selected fact or dependency lacks a valid current basis.
- Stop for a receipt before any archive-body read.
- Stop for conflict when competing current claims cannot be resolved without semantic review.

Routing is normally read-only. Only an evidence-backed, non-conflicting alias may be added without a semantic gate, and it must be reported. All boundary, ownership, topology, or routing-impacting changes enter the applicable reviewed knowledge-maintenance flow.

### Bounded example

A request to change the Wiki workspace layout selects the Wiki capability, its current layout fact, a desktop-shell constraint that actually propagates to Wiki, and a task-linked active layout delivery. It does not load the Inbox body, every desktop-shell fact, or archived layout PRDs.
