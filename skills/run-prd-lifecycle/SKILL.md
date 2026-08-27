---
name: run-prd-lifecycle
description: "Run bounded Feedback, PRD, non-PRD delivery, architecture, development guidance, testing, acceptance, closure, and knowledge-handoff work. Use for a new product or engineering intake, continuation of an active delivery owner, parallel delivery coordination, verification evidence, or closing accepted work without inflating the project knowledge base."
---

# Run PRD Lifecycle

Own the delivery-evolution line. Classify the intake before creating durable delivery state. Use the smallest durable owner and the smallest justified artifact set; do not manufacture a full document matrix for every request.

Use the fixed project-owned root `docs/project-lifecycle/` for durable delivery and handoff assets. Never create a host-specific duplicate knowledge or delivery tree.

This Skill owns Feedback, PRD and non-PRD delivery assets, architecture and guidance deltas, execution and test evidence, acceptance, closure, the runtime Context Receipt, and the candidate Knowledge Diff. `maintain-project-knowledge` owns accepted knowledge selection and accepted knowledge writeback.

## Installed Runtime

When deterministic validation is needed from an installed plugin, resolve `<plugin-root>` by ascending two directories from the directory that contains this `SKILL.md`, then execute `<plugin-root>/bin/project-lifecycle`. If the host cannot execute that wrapper, use `node <plugin-root>/dist/project-lifecycle.mjs` as the only fallback. Never invoke files under `<plugin-root>/scripts/`, run package scripts, install dependencies, or modify a plugin cache; source entry points are repository-development-only.

The installed delivery commands are `inspect-delivery-layout`, `preview-delivery-layout-migration`, `migrate-delivery-layout`, `validate-delivery-layout`, `materialize-delivery-asset`, `close-delivery`, and `generate-delivery-indexes`. Inspection and preview are read-only. Migration requires the exact preview plan hash and source fingerprint plus explicit approval and backup references. Materialization and index generation require a validated layout-v2 tree.

<!-- plugin-runtime-contract
installed_cli: bin/project-lifecycle
node_fallback: dist/project-lifecycle.mjs
source_cli: repository-development-only
cache_dependency_install: forbidden
-->

## Native Decision Contract

Keep this contract in working context before consulting a deeper routing reference.

<!-- lifecycle-decision-contract
primary_routes:
  - KNOWLEDGE_UPDATE
  - NON_PRD_DELIVERY
  - OUTSIDE_PLUGIN
  - PRD_DELIVERY
temporary_stop: NEEDS_USER
route_selection:
  accepted_knowledge_only: KNOWLEDGE_UPDATE
  feedback_prd_or_product_delivery: PRD_DELIVERY
  engineering_repair_migration_or_operations_without_prd: NON_PRD_DELIVERY
  no_durable_lifecycle_effect: OUTSIDE_PLUGIN
selected_solution_id: required-before-durable-write
intent_materialized_without_acceptance: false
-->

Return exactly one listed primary route, or return no route with the temporary `NEEDS_USER` stop. Never substitute a lifecycle state, scenario family, workflow type, document kind, or newly invented label for a primary route. Before any durable write, select one non-null solution ID from the presented acceptable range; if current evidence cannot support one, stop instead of writing. Creating a Feedback, PRD, non-PRD owner, architecture asset, or knowledge candidate records intent and scope only—it is not implementation or acceptance and must not be reported as materialized intent.

## Reference Routing

Load only the reference needed for the current state or unresolved decision. Load `intake-routing.md` only for a new intake or a material main-flow correction. For an existing durable owner, read its Frontmatter and current Context Receipt before consulting intake routing again.

| Current trigger | Load |
| --- | --- |
| New intake, no durable owner, material ambiguity, or main-flow correction | [Intake routing](references/intake-routing.md) |
| Preserve Feedback history, decide whether a PRD is justified, or connect many Feedback and PRD records | [Feedback and PRD boundaries](references/feedback-and-prd-boundaries.md) |
| Decide which delivery artifact is justified or what each artifact may own | [Delivery assets](references/delivery-assets.md) |
| Coordinate parallel PRDs, worktrees, baselines, dependencies, conflicts, or cross-repository work | [Parallel delivery](references/parallel-delivery.md) |
| Record or resolve an exceptional cross-owner requirement | [Obligations](references/obligations.md) |
| Accept, close, retain, summarize, hand off knowledge, or clean runtime state | [Closure and retention](references/closure-and-retention.md) |

## Ordered Lifecycle

Resume at the earliest state invalidated by new evidence. Do not skip a stop, acceptance result, or human gate.

| State | Entry evidence | Minimum next output | Stop condition | Human gate | Owning reference |
| --- | --- | --- | --- | --- | --- |
| INTAKE | User request, Feedback, or active-owner reference. | One bounded intake record or continuation target. | Intent is too ambiguous to identify a plausible owner. | Ask only when the ambiguity changes durable ownership or scope. | [Intake routing](references/intake-routing.md) |
| GROUND | Intake plus accepted project-knowledge selection. | Current baseline, affected domains, constraints, exclusions, and open questions. | Required knowledge is missing, conflicting, or archive-gated. | Respect the knowledge Skill's evidence, conflict, and archive stops. | [Feedback and PRD boundaries](references/feedback-and-prd-boundaries.md) |
| ROUTE | Grounded intake and any existing owner Frontmatter. | Exactly one primary route or the temporary user stop. | No supplied route is defensible from current evidence. | Confirm Agent-inferred PRD creation and material main-flow correction. | [Intake routing](references/intake-routing.md) |
| MATERIALIZE_MINIMUM | Valid route, owner decision, IDs, and starting baseline. | Smallest justified bilingual durable owner and optional threshold assets. | Required approval or asset-specific declaration is absent. | Explicit PRD requests authorize creation; inferred PRDs require confirmation. | [Delivery assets](references/delivery-assets.md) |
| DELIVER | Durable owner, scoped worktree, current receipt, and delivery plan. | Referenced implementation, design, coordination, and evidence outcomes. | Same-fact conflict, unreplayable baseline, or unresolved cross-owner seam. | Obtain decisions only for material conflicts or exceptional obligations. | [Parallel delivery](references/parallel-delivery.md) |
| VERIFY | Implemented outcome and declared success criteria. | Test evidence, residual risks, and an acceptance recommendation. | Required evidence is missing or contradicts the claimed outcome. | The user or designated authority accepts material residual risk. | [Delivery assets](references/delivery-assets.md) |
| ACCEPT/CLOSE | Verification result and coverage assessment. | Accepted, rejected, cancelled, withdrawn, or partially closed durable outcome. | Feedback coverage, obligations, conflict disposition, or acceptance remains open. | Explicit acceptance is required for semantic product outcomes. | [Closure and retention](references/closure-and-retention.md) |
| HANDOFF_KNOWLEDGE | Durable closure plus final evidence references. | One bounded Knowledge Diff candidate or explicit no-change result. | Baseline, ownership, evidence, or conflict is unresolved. | Candidate creation does not authorize accepted knowledge writeback. | [Closure and retention](references/closure-and-retention.md) |
| CLEAN_RUNTIME | Durable closure, verification, conflict disposition, and knowledge handoff result. | Exact removal of the PRD runtime receipt and empty owner directory. | Any durable closure prerequisite is missing or cleanup cannot be verified. | Never delete another PRD, worktree, or durable delivery asset. | [Closure and retention](references/closure-and-retention.md) |

## Non-Negotiable Boundaries

Do not require a PRD for every change.

Delivery intent and evidence cannot be promoted directly into current project knowledge.

Ordinary architecture, implementation, testing, acceptance, and closure stages are not secondary obligations.

English delivery assets are Agent-default reads; English and Chinese logical pairs change together.

Feedback preserves the original problem, scenario, expectation, and source. A PRD closes only the Feedback coverage it actually satisfies.

The Skill is the sole Context Receipt writer and the sole Knowledge Diff candidate producer. It cannot apply current project knowledge. Human approval, structural validity, and accepted product truth are separate gates.

## Knowledge Boundary

Consume only the bounded selection returned by `maintain-project-knowledge`. Keep the current Context Receipt uncommitted under the scoped worktree runtime root. At closure, return only a schema-valid candidate Knowledge Diff with evidence references or an explicit no-change result; never copy PRD prose, chat logs, or hidden reasoning into current knowledge.
