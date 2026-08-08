# Knowledge Absorption

Use this reference when PRD Lifecycle returns a candidate Knowledge Diff from accepted delivery evidence, or when an accepted knowledge-only change needs canonical writeback.

## Authority Boundary

`run-prd-lifecycle` owns creation of the candidate, its delivery evidence, and explicit `NO_CHANGE`. It cannot promote the candidate to current knowledge. This Skill is the only Skill authorized to validate and perform accepted project-knowledge writeback. Neither a structurally valid diff nor accepted delivery automatically approves semantic truth.

Before applying, resolve and compare:

- the candidate `knowledge_baseline` against the latest accepted baseline;
- every fact and domain operation against one canonical owner;
- evidence references against the claimed accepted outcome;
- bilingual targets and aligned fact metadata;
- dependency, topology, propagated-constraint, pending-review, and conflict impact;
- required human approval for semantic truth or material conflict disposition.

Stop without writeback when the baseline is stale, ownership is absent or competing, evidence is insufficient, a pair is incomplete, an applicable constraint conflicts, topology is pending, or approval is unresolved. Do not silently replay a stale diff onto a new baseline.

## Durable Operations

| Operation | Use |
| --- | --- |
| `ADD` | A newly accepted independently addressable fact has one canonical owner. |
| `REWRITE` | The accepted answer changed while the stable semantic subject and owner remain the same. |
| `SUPERSEDE` | The former fact no longer answers the same question or has an accepted successor transition. |
| `NO_CHANGE` | Accepted delivery evidence changed no durable project fact; write no capability-body change. |

Rewrite the current state instead of appending iteration narratives. Link to a canonical fact from other domains rather than copying it. Superseded facts leave default retrieval while their identity and transition remain traceable through versioned knowledge and delivery outcomes.

## Project-Level Promotion

Broad relevance or repeated links do not move a domain fact. Propose a project-level module only when it has an independently explainable project-wide responsibility, its own lifecycle and validation boundary, direct retrieval needs outside the source domain, and a transferable canonical owner with identifiable references. Explicit user confirmation is mandatory. An accepted promotion moves ownership and replaces source copies with links.

## Apply and Verify

One approved semantic decision authorizes only its declared atomic write set: paired capability updates, matching map metadata or markers, and regenerated bilingual indexes. Validate every changed contract before replacing the accepted files. If any write or validation fails, do not claim absorption complete; preserve or restore the last accepted set using the repository adapter's bounded transaction behavior.

Report the applied fact IDs and revisions, owner domains, new knowledge baseline, evidence references, derived view updates, `NO_CHANGE` when applicable, and any remaining limits. Do not copy the PRD, test report, process log, or evidence body into capability knowledge.

### Bounded examples

- A tested Wiki layout change rewrites the existing layout fact at its Wiki owner and advances its revision; it does not create a new fact for each PRD.
- A refactor with unchanged user behavior, contract, dependencies, and entry points records `NO_CHANGE`; it does not manufacture knowledge churn.
