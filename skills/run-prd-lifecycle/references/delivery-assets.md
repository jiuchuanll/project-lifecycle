# Delivery Assets

Use this reference to choose the smallest justified durable artifact set and keep ownership boundaries clear. Primary route meanings remain in [Intake routing](intake-routing.md).

## Threshold Rule

Create an artifact only when it has a distinct durable job, a stable owner, and information that cannot be represented safely by the current owner Frontmatter or evidence references. The Agent proposes `asset_kind` and reason; deterministic validation checks the required declaration and evidence but does not choose the artifact.

Every materialized delivery asset is an English/Chinese logical pair. English is the Agent-default read. Language-neutral IDs, routes, baselines, relationships, state, retention, and evidence references must match; prose is localized.

## Physical Layout and Ownership

The fixed delivery schema is identified by `delivery/layout.json`. Every PRD or non-PRD delivery root is exactly one physical owner: its own stable artifact ID is also its `owner_artifact_id`. A child architecture, guidance, batch, test-report, or closure-summary pair declares the same `owner_artifact_id` and lives only beneath that owner. Semantic relationships such as `relationships.prd_ids` do not create a second physical copy.

Use these canonical locations:

- Feedback remains independent at `delivery/feedback/<feedback-id>-en.md` and its Chinese mirror.
- A PRD owner is at `delivery/prds/<prd-id>/<prd-id>-en.md`; its children use `architecture/`, `guidance/`, `batches/`, `test-reports/`, or `closure/` beneath that owner.
- A non-PRD owner uses the same shape beneath `delivery/non-prd/<owner-id>/`.
- Generated root and owner `INDEX` pairs are navigation only. Generated alignment views live under `delivery/views/`.

Never write new flat delivery documents. If a coherent legacy flat tree is found, first run a read-only inspection and migration preview. The preview must resolve every child to one owner or pause for user mapping, report external-link risks through scheme, authority, and a target hash without echoing raw URLs, and bind the selected solution ID, plan hash, and source fingerprint. Durable migration additionally requires explicit approval and backup references, exact preview replay, atomic publication, live v2 validation, and rollback on failure.

## Canonical Jobs

- Feedback: original problem, scenario, expectation, source, and coverage.
- PRD: product intent, bounded scope, success criteria, non-goals, starting baseline, affected domains/facts/constraints, and Feedback links.
- Architecture: only changed contracts, system boundaries, data flow, or material tradeoffs.
- Development guidance: WHAT/WHY implementation guardrails, not batch chronology or a copied plan.
- Batch: execution chronology and exact code/tool evidence references.
- Test report: verification matrix, observed results, and residual risk.
- Non-PRD delivery: smallest durable root for scoped work without a PRD owner.
- Closure summary: compact immutable outcome, acceptance, retention, Feedback coverage, and knowledge-handoff reference.

## Creation Gates

An architecture asset requires an actual changed-contract or boundary declaration. Guidance is unnecessary for pure wiring already governed by accepted constraints. A test report is justified by durable verification evidence, not by a template checklist. Post-completion repair attaches to the smallest existing owner or a bounded successor rather than reopening every phase asset.

Do not duplicate content across artifacts. Link to authoritative evidence. Delivery documents may reference code, tests, decisions, and accepted knowledge IDs, but must not embed raw tool logs, secrets, source bodies, or full knowledge documents.

## Active Alignment Projection

`delivery/views/alignment-review-en.md` and `delivery/views/alignment-review.md` are generated bilingual activity views, not delivery owners or history ledgers. Regenerate them from validated active Feedback, linked owners, and closure summaries. Each row has exactly five fields: `feedback_id`, localized `title`, `primary_domain_id`, derived `alignment_phase`, and sorted unique `owner_ref` list.

The only active phases are `REVIEW_REQUIRED`, `DELIVERY_OPEN`, `KNOWLEDGE_WRITEBACK`, and `DEFERRED`. `DEFERRED` applies only while no required linked owner exists; once one is linked, linked owner state takes precedence. A row remains `DELIVERY_OPEN` while any required linked owner is open. It reaches `KNOWLEDGE_WRITEBACK` only after every required linked owner has accepted closure and Feedback coverage. Completed items contribute no row. Never place evidence bodies, code paths, original narrative, risk prose, scope, tests, Knowledge Diff bodies, chronology, reasoning, or free-form notes in this projection.

## Verification

Before acceptance, confirm paired machine fields, declared success criteria, exact evidence references, residual risks, and owner state. Test evidence proves observed behavior; it does not itself approve product meaning or accepted knowledge.
