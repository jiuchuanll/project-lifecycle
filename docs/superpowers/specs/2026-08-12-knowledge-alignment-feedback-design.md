# Knowledge Alignment Feedback Design

Status: Review requested

Date: 2026-08-12

Repository: `jiuchuanll/project-lifecycle`

Selected solution ID: `solution-dual-truth-feedback-deferred-routing`

Chinese mirror: [2026-08-12-knowledge-alignment-feedback-design.zh-CN.md](./2026-08-12-knowledge-alignment-feedback-design.zh-CN.md)

## Objective

Let project-knowledge bootstrap and later knowledge maintenance record an accepted business decision even when the repository still contains an implementation that disagrees with that decision. Preserve the implementation evidence, capture a durable Feedback source record, continue the current knowledge flow by default, and defer PRD or non-PRD delivery creation until the user explicitly chooses a delivery route.

## Problem

During knowledge discovery, code can support a capability that the user identifies as obsolete, invalid, or outside the accepted business model. Three different claims then exist:

- the implementation is present in the inspected code baseline;
- the user has accepted a business decision that the capability is no longer supported; and
- delivery has not yet changed or verified the implementation.

Treating the code as the only truth incorrectly preserves an obsolete capability as accepted business knowledge. Treating the desired business model as already implemented incorrectly claims that runtime alignment is complete. Immediately creating a PRD interrupts knowledge construction and conflates Feedback capture with delivery authorization.

## Confirmed Principles

- Canonical knowledge records both the accepted business decision and the verified implementation state.
- A business decision such as retirement is current when explicitly confirmed; implementation removal is not current until delivery and verification prove it.
- A confirmed business-to-implementation divergence creates a durable Feedback record immediately.
- Feedback capture does not create a PRD, start delivery, allocate a worktree, or modify code.
- Initial bootstrap and later maintenance use the same model. Bootstrap normally defers delivery routing until its closing review; later maintenance closes at the current maintenance batch unless the user requests immediate delivery.
- The user controls inferred PRD or non-PRD creation.
- Active aggregation is a sparse derived projection, not a second source of truth or an append-only project log.

## Epistemic Model

The knowledge asset must use precise claims rather than the ambiguous statement “the feature is deprecated.” For example:

> The accepted business model no longer supports the legacy approval entry. The implementation remains present at baseline `abc123`; whether runtime exposure has been fully removed is not yet verified. Remediation is tracked by `feedback-legacy-approval`.

This expresses three independently defensible facts: the business decision is accepted, the implementation is observed, and alignment remains incomplete. It must not say that code or runtime behavior has already been removed.

Use the existing capability structure without adding capability Frontmatter fields or a new global knowledge state:

- **Current facts** records the accepted business disposition.
- **Implementation and resource map** retains the smallest current implementation entry points.
- **Known limits and unknowns** records the unresolved alignment and links its Feedback.
- **Provenance** cites the human decision, inspected baseline, and supporting evidence.

When an existing fact still represents the same semantic subject, retain its `fact_id` and advance `fact_revision`. A temporary implementation divergence normally belongs in known limits and does not receive another fact ID. Create a separate implementation-status fact only when that status has independent, durable retrieval value.

## Ownership and Assets

`maintain-project-knowledge` owns the knowledge candidate, bilingual capability asset, baseline, and accepted Knowledge Diff writeback. `run-prd-lifecycle` owns Feedback, PRD and non-PRD delivery assets, verification evidence, closure, and the candidate Knowledge Diff.

The durable source record is a normal bilingual Feedback pair under `docs/project-lifecycle/delivery/`. Its immutable source sections preserve the original problem, scenario, and expectation. Its mutable Marking section carries a controlled business-to-implementation alignment marker and current coverage information. The marker contains only the alignment classification, one `primary_domain_id`, and an optional explicit deferral disposition. It contains no owner progress, evidence body, or history. Existing Feedback that already represents the same original problem is reused rather than duplicated.

The bilingual active projection is generated at:

- `docs/project-lifecycle/delivery/alignment-review-en.md`
- `docs/project-lifecycle/delivery/alignment-review.md`

These files are derived views. Feedback, delivery owners, closure summaries, and accepted knowledge remain authoritative.

`pending-changes.json` remains limited to open knowledge topology, ownership, constraint, relationship, and semantic-fact proposals. It must not become a code-remediation or product-delivery backlog.

## Feedback-Only Capture

The active knowledge task keeps `KNOWLEDGE_UPDATE` as its primary route. When the user explicitly confirms a material business-to-implementation divergence, the knowledge flow performs one bounded handoff to `run-prd-lifecycle`:

1. Preserve or create the bilingual Feedback source record.
2. Mark it as an active alignment divergence.
3. Return control to knowledge construction.

The bounded handoff must not materialize a PRD, non-PRD delivery owner, Context Receipt, batch, worktree, code change, or test run. The contract is:

```text
Feedback captured != PRD materialized != delivery started
```

If the user explicitly requests immediate remediation, Feedback is still captured first, after which the Agent presents the smallest defensible PRD or non-PRD boundary. An Agent-inferred delivery owner requires user confirmation before materialization.

## Active Alignment Projection

Each active row contains exactly five fields:

| Field | Meaning |
| --- | --- |
| `feedback_id` | Stable link to the authoritative Feedback pair. |
| `title` | One bounded line identifying the divergence. |
| `primary_domain_id` | Canonical domain used for grouping. |
| `alignment_phase` | One of the four active projection phases. |
| `owner_ref` | Linked PRD or non-PRD owner, or empty before routing. |

The only active projection phases are:

- `REVIEW_REQUIRED`: Feedback exists and user routing review is still required.
- `DELIVERY_OPEN`: a confirmed delivery owner exists, but accepted delivery is incomplete.
- `KNOWLEDGE_WRITEBACK`: delivery is accepted, but the Knowledge Diff has not been resolved and applied.
- `DEFERRED`: the user explicitly postponed routing or delivery.

There is no `COMPLETED` row. A completed item leaves the active projection. Durable history remains in Feedback and closure assets.

Projection values are deterministic. `feedback_id`, the bounded H1 title, and `primary_domain_id` come from the validated Feedback pair and its controlled marker. `owner_ref` is reverse-resolved from an accepted PRD or non-PRD owner whose relationships cover the Feedback. `alignment_phase` is computed from that owner, its accepted closure, the Feedback disposition, and the Knowledge Diff resolution. It is not an independently editable progress field.

The projection must never contain code paths, evidence bodies, the original user narrative, risks, PRD scope, acceptance criteria, test results, Knowledge Diff bodies, status history, Agent reasoning, or free-form notes. Those belong to their authoritative assets.

## Projection Lifecycle

During bootstrap or maintenance, a newly captured alignment Feedback appears as `REVIEW_REQUIRED`. At the closing review, the Agent may propose deduplication, grouping, splitting, dependency order, and one of these user-controlled dispositions:

- link to an existing PRD;
- create a new PRD;
- create a bounded non-PRD delivery owner;
- defer;
- accept no remediation and close with a reason.

Confirmed routing changes the derived row to `DELIVERY_OPEN` and supplies `owner_ref`. Creating a delivery owner does not complete the row. Accepted delivery moves it to `KNOWLEDGE_WRITEBACK` until the candidate Knowledge Diff is resolved by `maintain-project-knowledge`.

An item exits the active projection only when:

1. Feedback coverage has an explicit disposition;
2. implementation remediation or an explicit no-remediation decision is accepted;
3. delivery verification and residual-risk handling are complete where delivery occurred;
4. the Knowledge Diff or explicit no-change result is resolved; and
5. canonical knowledge accurately represents the final business and implementation alignment, including any consciously accepted residual divergence.

PRD creation, code merge, or PRD closure alone is not an exit condition.

## Bootstrap and Ongoing Maintenance

Initial bootstrap uses a batch-deferred policy: capture Feedback and continue knowledge calibration unless immediate risk or an explicit user request requires a stop. When initial knowledge construction finishes, present one bounded routing review of all `REVIEW_REQUIRED` items. Initial knowledge may become current with open alignment Feedback because its dual-truth wording accurately records the unresolved implementation state.

Ongoing maintenance uses the same artifacts and phases. It normally presents unresolved items at the end of the current maintenance batch. Only affected facts, limits, relationships, and domains reopen; unrelated current knowledge remains usable. An explicit “fix now” request routes immediately after Feedback capture.

Security, compliance, destructive-data, or task-blocking divergence must be surfaced immediately. It may not be silently deferred, but the user still chooses the authorized next action.

## Deduplication and Baseline Drift

Do not create another Feedback when an active or retained Feedback already preserves the same original problem and semantic target. Attach new current evidence through the allowed mutable marking or coverage path and reuse the existing projection row. If equivalence is uncertain, keep the records separate and request a user decision rather than merging source history.

If the code baseline changes before routing or closure, preserve the immutable Feedback source sections, refresh the current implementation evidence, and recompute the projection phase. If another change has already resolved the implementation divergence, verification and knowledge writeback are still required before the row exits. A changed business decision uses an erratum or successor relationship rather than rewriting the original narrative.

## Write Ordering and Failure Handling

Use this safe durable-write order:

1. create or preserve the bilingual Feedback pair;
2. update the bilingual knowledge candidate with precise dual-truth wording;
3. regenerate the bilingual active projection;
4. validate identifiers, baselines, links, phases, and bilingual consistency.

Feedback capture failure blocks the corresponding dual-truth promotion because the delivery gap would otherwise be untracked. A knowledge update failure leaves the Feedback intact for retry and must not report current knowledge as updated. Projection generation failure does not delete or rewrite authoritative Feedback or knowledge, but the operation remains incomplete and must report the failed derived view.

A broken or unaccepted owner reference cannot advance a row to `DELIVERY_OPEN`. Delivery closure without a resolved Knowledge Diff remains `KNOWLEDGE_WRITEBACK`. Duplicate detection uncertainty, ambiguous meanings of “deprecated,” or materially different routing candidates use `NEEDS_USER` rather than silent inference.

## Bounded Scale and Retention

The projection is regenerated from active authoritative records rather than appended to. Rendering-time grouping and routing suggestions are transient and are not persisted as prose. Default retrieval includes only active rows; closed history is available through Feedback, closure summaries, and receipt-gated archive retrieval when justified.

Its size therefore depends on the number of unresolved divergences, not on the total number of historical iterations. Every row has constant bounded shape, and completed work contributes zero rows.

## Non-Goals

This design does not:

- make user intent prove that code or runtime behavior has changed;
- force every Feedback into a PRD;
- create a new primary route, global obligation store, or general task tracker;
- place delivery backlog content in `pending-changes.json`;
- duplicate Feedback, PRD, tests, or Knowledge Diff prose in the projection;
- automatically modify code during knowledge construction; or
- keep completed projection rows as an active history log.

## Validation and Acceptance

Implementation must cover at least these deterministic and behavior scenarios:

1. A user retires an important capability whose code still exists: Feedback is created, no PRD or worktree is created, dual-truth knowledge is produced, the row is `REVIEW_REQUIRED`, and bootstrap continues.
2. The user asks for immediate remediation: Feedback is created first and an inferred PRD or non-PRD owner is not materialized before confirmation.
3. The same divergence is discovered again: the existing Feedback and projection row are reused.
4. Delivery is open: the row is `DELIVERY_OPEN` and links the accepted owner.
5. Delivery is accepted but knowledge is not written back: the row is `KNOWLEDGE_WRITEBACK` and cannot exit.
6. Feedback coverage, delivery acceptance, and knowledge absorption complete: the row exits while Feedback and closure history remain.
7. The user defers the item: the row remains `DEFERRED` without accumulating chronology.
8. English and Chinese Feedback, knowledge, and projection pairs have matching IDs, baselines, phases, links, and heading structure.
9. No evidence of removal exists: current knowledge never claims implementation or runtime removal.
10. A scale fixture contains many closed Feedback records and a small active set: only the active set renders, every row has exactly five fields, and no evidence or free-form history enters the projection.
11. Feedback, knowledge, or projection writes fail independently: the operation reports the exact incomplete stage and preserves authoritative prior state.
12. A high-risk divergence is discovered: immediate user attention is required instead of default batch deferral.

## Implementation Boundary

The future implementation should remain surgical. It may extend the two Skill references, Feedback marking validation, one bounded alignment-projection generator and schema, paired generated assets, and focused contract/behavior tests. It should reuse existing Feedback source immutability, delivery relationships, bilingual validation, route vocabulary, Knowledge Diff handoff, and index-generation conventions rather than introduce another delivery lifecycle.
