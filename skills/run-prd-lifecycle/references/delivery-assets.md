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

## Creation and Indexing Workflow

1. Run `<plugin-root>/bin/project-lifecycle inspect-delivery-layout --root <absolute-project-root>`. For an existing legacy tree, use the explicit migration flow above. For an initialized v2 tree, validate it before creating assets. A brand-new delivery tree uses `delivery/layout.json` with `{"schema_version":1,"layout_version":2}`; never add this marker to disguise a legacy or mixed tree.
2. Read the matching pair of templates from this Skill's `assets/` directory: [Feedback](../assets/feedback-en.md), [PRD](../assets/prd-en.md), or [Architecture](../assets/architecture-en.md), and their `.md` Chinese mirrors. Copy their complete machine-field structure; replace placeholder IDs and baselines with grounded values. Frontmatter is a closed schema: do not add `title`, `status`, dates, or localized descriptions. Put prose in the body. Both languages share exactly the same Frontmatter, including array order. Feedback has no `owner_artifact_id`; PRDs own themselves; architecture references its existing owner.
3. Prepare a temporary JSON envelope outside `delivery/` with one `frontmatter` object, a `body` object containing Markdown strings keyed by `en` and `zh-CN` (without YAML Frontmatter), and a non-empty `reason`. Preserve template Feedback section markers. Localized bodies must have matching heading levels. For a PRD, supply `creation_origin: "explicit_user"` when the user explicitly requested it; use `"agent_inferred"` plus `creation_approval_ref` only after confirmation. For architecture, supply `changed_contract_ref` referencing the actual changed-contract declaration. These request fields belong outside Frontmatter.
4. Run `<plugin-root>/bin/project-lifecycle preview-delivery-asset --root <absolute-project-root> --input <absolute-envelope-path>`. This checks the complete request, computes canonical bilingual paths, checks the candidate inventory and index tree limits, and reports `files_changed: false`. A child requires an already saved physical owner. Preview is not approval and does not reserve the tree against other writers.
5. Run `<plugin-root>/bin/project-lifecycle materialize-delivery-asset --root <absolute-project-root> --input <absolute-envelope-path> --update-indexes`. Success reports `asset_saved: true` and `indexes: "updated"`. Exact-content retries return `status: "unchanged"` and can finish an interrupted index update; a different request never replaces an existing owner. The standalone command without the flag preserves its previous creation-only behavior.
6. If needed, run `validate-delivery-layout --root <absolute-project-root>` or `generate-delivery-indexes --root <absolute-project-root>` through the same installed entry point. Delivery indexing scans active and archived delivery assets; an invalid older asset can block a new index. Use these commands for delivery documents, not knowledge `validate-pair` or knowledge index generation. Never create or edit `INDEX.md` or `INDEX-en.md` manually.

Complete editable JSON requests are provided for [Feedback](../assets/feedback-request.json), [PRD](../assets/prd-request.json), and [Architecture](../assets/architecture-request.json). Copy a request outside `delivery/`, replace sample IDs, baselines, bodies and references with confirmed content, then preview it. The architecture example references the PRD example's owner. Sample declarations do not supply actual approval or changed-contract evidence.

Minimal PRD request shape (replace the sample values and bodies):

```json
{
  "frontmatter": {
    "schema_version": 2,
    "artifact_id": "prd-search",
    "owner_artifact_id": "prd-search",
    "artifact_kind": "prd",
    "primary_route": "PRD_DELIVERY",
    "project_id_at_creation": "sample-project",
    "current_project_id": "sample-project",
    "domain_ids": ["search"],
    "knowledge_baseline": "replace-with-accepted-baseline",
    "relationships": {"feedback_ids": [], "prd_ids": [], "legacy_artifact_refs": []},
    "retention_tier": "active",
    "reclassified_from_refs": [],
    "obligations": []
  },
  "body": {"en": "# Search PRD\n\nBounded product intent.\n", "zh-CN": "# 搜索 PRD\n\n有明确范围的产品意图。\n"},
  "reason": "Record the confirmed search requirement",
  "creation_origin": "explicit_user"
}
```

### Recovering from Validation Failures

- `DELIVERY_FRONTMATTER_INVALID` or `ASSET_FRONTMATTER_INVALID`: use the returned `reason`, `action`, and field path (`expected` also names the required type for type errors); fix missing, unsupported, invalid, or inconsistent fields in both languages. Do not move files to fix a schema error.
- `DELIVERY_FRONTMATTER_MALFORMED`: repair the YAML delimiters or restricted YAML syntax.
- `DELIVERY_INVENTORY_PATH_MISMATCH`: reconcile the filename, artifact kind, and physical owner with canonical placement.
- `DELIVERY_INVENTORY_PAIR_INVALID`: restore the missing language or matching machine fields; preserve localized body text.
- `DELIVERY_INDEX_OCCUPIED`: inspect and preserve the non-generated file before relocating it outside managed delivery paths. Do not delete it or add a generated notice just to bypass validation.
- `DELIVERY_LAYOUT_MIGRATION_REQUIRED`: inspect marker and document versions; use the approved migration flow for existing legacy assets.

Inventory diagnostics collect up to 50 independent errors. `context.truncated` means more errors were found; repair the reported set, then rerun. Unsafe traversal or invalid layout markers stop inspection immediately, and dependent owner checks wait until document pairs are valid. During preview, `origin: "existing_inventory"` identifies a blocker already present before the proposed document; `origin: "candidate"` identifies a candidate inventory problem; `"undetermined"` means the baseline diagnostic list was truncated and origin cannot be established. A valid request can still be blocked by unrelated existing assets.

If integrated creation returns `ok: false`, read `context.phase` before reporting the outcome. `files_changed: false` during preflight means nothing was written. `asset_saved: true` with `indexes: "failed"` means the pair is already saved: fix the listed cause and repeat the identical integrated request, or run index generation alone. Preserve saved content. `asset_saved: null` after a rollback failure requires inspection; do not guess or blindly recreate. Index publication is its own existing atomic transaction, not one transaction spanning document creation and indexes.

Fix the reported cause, then rerun validation and generation. Repeating generation without changing invalid inputs cannot repair them.

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
