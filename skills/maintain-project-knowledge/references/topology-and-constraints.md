# Topology and Constraints

Use this reference for semantic changes to domain nodes, ownership, parentage, cross-domain relationships, propagated constraints, IDs, or descendant dispositions.

## Two Routing Axes

Vertical topology uses `parent_id` for containment. A child must be user-understandable, independently retrievable or maintainable, canonically own facts, have authoritative boundary evidence, and be strictly narrower than its one parent. Folder layout, technology, screen count, document length, and symmetrical navigation are not sufficient split reasons.

Horizontal topology uses only relationships with deterministic loading meaning:

| Relationship | Meaning and loading rule |
| --- | --- |
| `depends_on` | Directional operational or knowledge dependency; load only when the task relies on it. |
| `governed_by` | A project-level owner constrains this node; load only applicable governing constraints. |
| `coordinates_with` | Independent owners share a seam; inspect both only when the task touches that seam. |

Do not create a generic relationship bucket. Horizontal links neither transfer ownership nor make another domain's full body current context. New relationship kinds change the schema and require versioning plus explicit human confirmation.

## Constraint Propagation

Each current constraint has one stable ID, canonical owner, semantic revision, paired explanatory sections, and one propagation scope:

- `self`: owner only;
- `descendants`: every descendant in the vertical branch;
- `selected_descendants`: the explicit listed descendant IDs only.

Load only the applicable constraint and source section, never the full ancestor body. A child contradiction remains unresolved until an explicit exception identifies the source constraint, affected scope, reason, evidence, and human approval.

Every new constraint ID requires explicit confirmation of meaning, ownership, and scope. IDs are immutable and never reused. Replacement, split, or merge proposes new IDs and traceable successors while the old identity remains current until approval.

## Change Classification

| Class | Boundary |
| --- | --- |
| `WORDING` | Meaning, routing, restriction, applicability, exception, and outcome are unchanged; synchronize the pair and report it without advancing the semantic revision. |
| `SEMANTIC` | Meaning, owner, propagation, applicability, or exception behavior changes under the same long-term identity; increment the proposed revision and require review plus impact analysis. |
| `REPLACEMENT` | The rule no longer has the same identity; create reviewed successor IDs and retain the old historical reference. |

If harmlessness cannot be established, classify the proposal as semantic and stop for review.

## Pending and Impact Review

Keep accepted topology in `project-map.json`. Put open topology, ownership, constraint identity/semantics/scope, and descendant-impact proposals in the single bounded `pending-changes.json`; default routing ignores unrelated pending work.

A parent boundary, kind, parentage, lifecycle, or propagated-constraint change requires scoped descendant analysis. For each affected node, propose the trigger, evidence, risk, affected facts or ownership, gaps, and a disposition such as no change, revalidate, reparent, merge, split, retire, or exception. Do not mutate a child merely because its parent changed. Parent merge or retirement cannot close with orphaned active children.

Human approval gates every structural mutation, semantic constraint change, ownership transfer, exception, and final affected-fact resolution. Apply the approved map change and child dispositions atomically; keep unresolved validations as compact affected markers. Remove the pending entry only after its outcome and evidence are durably traceable.

### Bounded example

Changing a desktop-wide privacy constraint from all descendants to only Wiki and Inbox is semantic. Record the proposed scope and affected nodes, inspect only facts that depend on that constraint, obtain approval, then update the constraint revision and scoped markers atomically. The Source branch remains usable if it is not affected.
