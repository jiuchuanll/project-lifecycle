# Context Routing

Use this reference to select the smallest accepted knowledge context for a task and to return a bounded selection to PRD Lifecycle. It owns selection semantics, not PRD runtime receipt creation.

## Inputs and Source Order

1. Resolve `docs/project-lifecycle/project-map.json`, or a compact project pointer whose governance locator resolves to a matching accepted v2 map. A v1 map stops with migration required before any knowledge body is read.
2. Verify map-declared paired assets against the canonical layout, then read the English lifecycle-root index, repository-local Knowledge root or shard index, and only the direct-child indexes on the selected branch. Treat Chinese files as user-facing mirrors.
3. Route to the most specific confirmed node matching the user's language, purpose, scope, stable aliases, and current facts.
4. Add only applicable global principles, exact propagated constraint sections, declared dependencies, coordination seams touched by the task, and task-linked active delivery.
5. Stop when the selected primary domain and necessary dependencies are current enough for this task and remaining unknowns cannot change the decision.

Do not recursively read parents, children, neighbors, or delivery history. Parentage loads only applicable propagated constraints. A dependency is loaded only when the task relies on it; a coordination peer is loaded only when the shared seam is touched.

For a domain owned by another repository, follow its registered `portable_locator` and continue at that repository's `knowledge/INDEX-en.md` shard. Governance remains centralized in the accepted map, while implementation knowledge bodies stay in their owning repository. Never mirror the body into governance or infer a governance ancestor directory inside the shard.

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

A request to change a three-level Wiki editor selects only the lifecycle index, Knowledge root, direct-child indexes on the Wiki editor branch, the editor capability, its current fact, a desktop-shell constraint that actually propagates, and any required declared dependency. It does not load sibling bodies, every descendant, the complete desktop-shell body, or archived layout PRDs.
