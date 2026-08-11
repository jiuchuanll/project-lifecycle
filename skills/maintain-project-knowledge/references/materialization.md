# Materialization

Use this reference to deepen one confirmed boundary and decide whether it has enough durable retrieval value and evidence for a canonical bilingual knowledge asset.

## Materialization Threshold

Require all of the following without imposing a universal file or source count:

- user-confirmed purpose and scope;
- at least one stable fact with independent, durable retrieval value;
- traceable authoritative evidence for every fact;
- one canonical owner plus the major dependencies needed for routing;
- explicit unknowns, known limits, confidence limits, and unresolved risks.

Evidence may include code, resources, configuration, existing authoritative documentation, observed behavior, tests, or explicit user confirmation. Assess whether each source actually supports the claim. High-impact and cross-domain conclusions need corroboration or human confirmation proportional to risk. If the threshold fails, retain the confirmed skeleton and gaps without creating a placeholder asset.

## Canonical Ownership

Use schema-v2 `project-map.json` for structure and routing, generated `INDEX.md`/`INDEX-en.md` for navigation, and paired Markdown for knowledge. The map must not become a second knowledge body. Capability Frontmatter proves the asset's matching ID, state, pair, baseline, entry points, and verification evidence; the body explains current product, architecture, implementation, quality, dependencies, provenance, and owned constraints.

Canonical paths come only from the accepted topology and repository owner. A top-level leaf uses `knowledge/<id>-en.md`; a node with children owns `knowledge/<ancestor...>/<id>/<id>-en.md`; its direct children share that directory, recursively. The Chinese path follows the same rule without `-en`. `paired_assets.repository_id` is `null` for governance or the exact registered owner. Caller-chosen paths, filesystem nesting, and old flat locations never override the planner.

For a repository-owned domain, bind the registered owner to an explicit local `repository_roots` entry. Stage and validate the body plus shard indexes there, retain its rollback backup, and publish the governance map only after the shard succeeds. A failure restores any shard already published.

One independently verifiable or changeable semantic subject may receive a stable structured `fact_id`. Keep that ID when the accepted answer changes but the subject remains the same, and advance its revision. Replacement, split, merge, ownership transfer, or semantic-scope change creates a reviewed transition rather than recycling an identity. Do not add a global fact index or an exhaustive fact-ID array to Frontmatter.

## Truth and Bilingual Gates

`current` means an accepted fact integrated into the authoritative baseline. `in-progress` belongs to delivery, `proposed` remains unconfirmed, and `superseded` leaves default retrieval. A confirmed domain boundary does not imply a current fact.

Read English by default. Chinese and English files are one logical asset: their stable IDs, state, baseline, fact metadata, dependencies, section structure, and evidence relationships must align. Update the pair in one atomic change. A missing or semantically divergent mirror blocks promotion to current.

Every current fact must retain its current statement, stable ID and revision when independently addressable, evidence references, last verified baseline, and explicit known limits. Do not copy Feedback, PRD bodies, process logs, or historical narrative into current capability knowledge.

## Human and Structural Gates

Explicit human approval is required before a new fact or semantic rewrite changes durable current truth. After that decision, the same accepted write set may synchronize the bilingual pair, update the map state, and regenerate indexes without a second approval. Wording, formatting, translation repair, broken-link repair, and evidence-reference refresh may proceed without a semantic gate only when they cannot change meaning, routing, restrictions, or acceptance.

Run the relevant Phase 1 validators for project-map shape, bilingual pairing, fact blocks, IDs, evidence, references, and state. Validation cannot decide whether evidence is truthful; uncertainty stops promotion.

### Bounded example

A confirmed Wiki boundary with one tested layout rule, stable implementation entry points, an identified owner, and explicit small-window limits may materialize. A confirmed `search` boundary supported only by a folder name stays in the map with a gap and no knowledge document.
