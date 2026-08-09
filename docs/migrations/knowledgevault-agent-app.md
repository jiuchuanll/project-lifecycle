# KnowledgeVault Agent App migration recipe

This recipe prepares, but does not perform, the consumer migration from the two
project-local `docs-workflow` Skill copies to the shared `project-lifecycle`
Plugin. The audit is read-only. Product documents, historical delivery assets,
and unrelated dirty files are never deletion candidates.

## Current gate

Migration is blocked until at least one native host is recorded as `SUPPORTED`
and that host discovers both `maintain-project-knowledge` and
`run-prd-lifecycle` from the accepted Plugin candidate. A structural model run,
a copied Skill directory, or one discovered Skill is insufficient evidence.

The current Phase 5 support matrix contains only `FAILED` and `NOT_TESTED`
hosts. Therefore the current expected audit status is
`BLOCKED_UPSTREAM_SUPPORT`, with an empty `deletion_candidates` array.

## Read-only audit contract

Call `auditConsumer` from `scripts/migrations/audit-consumer.mjs` with:

- one explicit absolute consumer-repository root;
- the accepted native support matrix;
- native discovery results for both Plugin Skills; and
- a read-only dirty-path provider, or the default local Git status reader.

The auditor scans a bounded file inventory, does not follow symlinks, and reads
only the known instruction files needed to locate `docs-workflow` directives.
It inventories product-document locators without reading product bodies. Its
report includes legacy Skill copies, instruction call sites, product indexes,
bilingual pair locators, unpaired English assets, Superpowers work assets,
unrelated dirty paths, and the fixed `docs/project-lifecycle/` bootstrap
candidate.

## Migration order after the gates pass

1. Install the accepted `project-lifecycle` Plugin candidate without modifying
   global host configuration as part of the consumer PR.
2. Prove that the consumer host discovers both `maintain-project-knowledge` and
   `run-prd-lifecycle` from that installed candidate.
3. Bootstrap and calibrate the fixed `docs/project-lifecycle/` knowledge root.
   Do not treat the legacy product documents as current knowledge automatically.
4. Inventory the existing feedback, PRD, architecture, development-guidance,
   test, changelog, bilingual, and `docs/superpowers` assets. Preserve their
   bodies and history; backfill associations incrementally after the new map is
   accepted.
5. Update `AGENTS.md` and `docs/product/README.md` so project knowledge routes to
   the Plugin Skills while the delivery-document line retains its existing
   product-document obligations.
6. Remove `.agents/skills/docs-workflow/` and
   `.zcode/skills/docs-workflow/` only in a separate reviewed consumer PR, and
   only when the auditor returns `READY_FOR_SEPARATE_CONSUMER_PR`.
7. Run consumer bilingual-pair, index, link, and behavior checks. Verify that
   unrelated dirty files are byte-identical and are absent from the PR.
8. Retain historical delivery documents. Add project-map and knowledge
   associations progressively; do not bulk rewrite their prose.

## Review boundary

This repository ships the audit tool, redacted fixture, and migration recipe.
It does not mutate KnowledgeVault Agent App. The actual consumer changes require
a separate plan, diff review, verification, and consumer-repository PR after the
upstream support and discovery gates are satisfied.
