# Project Lifecycle 0.5.0 candidate notes

Publication status: **PUBLIC PRE-RELEASE EVALUATION CANDIDATE**

Host support gate: **NON-RELEASE CANDIDATE**

Version `0.5.0` replaces the flat delivery namespace with a fixed owner-centric
layout. Feedback remains independent, while each PRD or non-PRD root owns one
stable directory containing its architecture, guidance, batches, test reports,
and closure evidence. Existing schema-v1 delivery trees are handled through an
explicit preview, approval-bound atomic migration, live validation, and
rollback rather than silent rearrangement. The self-contained installed runtime
introduced in `0.3.1` remains intact, so no npm dependency installation is
required inside a host cache. This version remains private npm metadata and is
published as repository source plus a deterministic release archive; the
version bump does not upgrade any native-host support claim.

## What changed

- `delivery/layout.json` identifies delivery layout v2. Active documents live
  under `delivery/feedback/`, `delivery/prds/<owner-id>/`, or
  `delivery/non-prd/<owner-id>/`; generated views live under `delivery/views/`.
- `owner_artifact_id` is the sole physical ownership field. Root owners own
  themselves, child documents have exactly one owner, and semantic PRD links do
  not create duplicate physical copies.
- Recursive inventory and bilingual root/Owner indexes are bounded by explicit
  entry, depth, and byte limits. Active and retained paths reject symlinks,
  noncanonical files, cross-kind owners, divergent pairs, and ownerless assets.
- Legacy delivery inspection is read-only and reports exact moves, generated
  writes, removals, managed-link rewrites, ambiguous ownership, and hashed
  external-link risks. Publication requires the exact selected solution, plan
  hash, source fingerprint, approval reference, and backup reference.
- Migration uses the existing retained atomic layout transaction. It validates
  the staged and published v2 tree, removes only approved legacy sources, and
  restores the previous tree if publication, validation, or finalization fails.
- Installed commands now cover layout inspection, preview, migration,
  validation, materialization, closure, and delivery-index generation without
  depending on repository `node_modules`.
- Knowledge bootstrap and later maintenance now preserve two explicit truths:
  accepted business intent in canonical knowledge and observed implementation
  state in evidence. A confirmed divergence never masquerades as completed code.
- A compact `knowledge_alignment` Feedback marker records only classification,
  primary domain, and optional deferral disposition. Capture does not itself
  authorize PRD materialization, delivery startup, a worktree, or a code change.
- Initial bootstrap batches active alignment items for its closing review;
  subsequent maintenance batches the current maintenance scope. Explicitly
  requested immediate remediation still captures Feedback first and confirms
  the smallest defensible delivery boundary.
- The generated bilingual `alignment-review` pair is a sparse activity view,
  not another backlog or history ledger. Every row has exactly five fields and
  derives one of four phases from authoritative Feedback and delivery assets.
  Publication fails closed unless the supplied active Feedback, linked owner,
  and closure proofs exactly match the bounded canonical bilingual asset
  inventory and managed closure digests on disk.
- Alignment completion fails closed until all active or retained authoritative
  linked owners have accepted closure, each closure has a persisted canonical
  bilingual summary pair whose managed digest matches the compact closure
  object, and exact externally verified Knowledge application
  or no-change evidence exists. Explicit
  no-remediation closure additionally requires human approval and retained
  residual-divergence or no-change evidence.
- `validate-alignment-feedback` and `sync-alignment-review` expose the bounded
  runtime contract without echoing Feedback prose or filesystem contents.
- Installed Agents now receive one explicit runtime contract: execute
  `bin/project-lifecycle`, use `node dist/project-lifecycle.mjs` only as a
  fallback, and never invoke source scripts or install dependencies in a plugin
  cache.
- The legacy source-looking CLI path is now a dependency-free compatibility
  wrapper over the bundle. Repository development and bundle construction use
  the separately named `scripts/bin/project-lifecycle-source.mjs` entry.
- A cache-shaped regression test runs without `node_modules` and protects the
  exact path that previously failed while resolving `yaml`.
- Candidate domains are assessed independently using boundary, dependency,
  uncertainty, risk, and extensibility signals instead of one project-wide
  depth level.
- Complexity signals only recommend a deeper mode. Brainstorming or Grill Me
  starts only after the user chooses it or explicitly requests it.
- Missing deep-thinking capabilities require separate approval before an exact
  trusted global installation. Declined, unavailable, or failed installation
  falls back to a bounded built-in equivalent.
- Calibration converges in two passes: affected domains first, then a whole-map
  consistency review. Only accepted boundaries, verified facts, concise
  rationale, and unresolved gaps become durable knowledge.
- Capability materialization now gates purpose, boundaries, ownership,
  dependencies, evidence, and concise decision-ready content before promotion.
- `project-map.json` schema v2 makes `parent_id` the only vertical-topology
  source and adds `paired_assets.repository_id` for exact repository ownership.
- One pure planner computes recursive bilingual body locations, domain
  directories, lifecycle-root indexes, Knowledge root or shard indexes, and
  direct-child indexes.
- Bootstrap and materialization create parent navigation without inventing a
  parent body or promoting unverified knowledge.
- Approved promotion, demotion, reparenting, ID replacement, constraint
  references, and accepted Knowledge Diffs publish through one bounded atomic
  layout transaction. Unchanged files are not rewritten.
- Context routing verifies the canonical layout and reads only the root,
  Knowledge root or shard, selected ancestor indexes, exact applicable
  constraint sections, selected capability Frontmatter, and task-linked
  delivery Frontmatter.
- Multi-repository governance remains centralized while repository-owned
  implementation knowledge stays in repository-local shards connected by
  registered portable locators. Index generation is shard-scoped; routing can
  combine explicit authenticated owner roots without bouncing; migration,
  materialization, topology application, and accepted Knowledge Diffs publish
  validated repository shards before the governance map with cross-shard rollback.

## Upgrade from 0.4.0

New delivery writes require layout v2. For a coherent legacy flat tree, run the
read-only inspection and preview first. Resolve every `NEEDS_USER` owner mapping,
review the complete generated-write/removal set and external-link risks, then
execute only with the exact approved preview plus recoverable backup reference.
Do not move files manually, infer owners from filenames, keep duplicate bodies,
or edit a managed plugin cache. Repositories without delivery artifacts require
no historical migration; the v2 marker and indexes are created by the bounded
bootstrap or delivery workflow.

## Upgrade from 0.3.1

No knowledge schema or layout migration is required. Existing repositories gain
the optional alignment Feedback marker and generated review pair only when a
user-confirmed business-to-implementation divergence is captured. Refresh the
marketplace and installed plugin after this release is merged; do not install
npm packages or edit cached plugin files manually.

## Upgrade from 0.3.0

No knowledge schema or layout migration is required. The dependency-free cache
runtime introduced in `0.3.1` remains the supported candidate entry contract.

## Upgrade from 0.2.0

No schema or layout migration is required. Existing accepted maps and paired
capability assets remain authoritative. On the next bootstrap, repair, or
affected-domain recalibration, the Agent applies the new user-controlled
deepening choices and semantic gates only to the scope under review.

## Upgrade from 0.1.0

Schema-v1 flat knowledge remains recognizable only by the internal migration
inspector; it is not registered as a normal runtime schema. The Agent must show
the exact path/reference plan and external-link risks, then obtain one explicit
approval before invoking migration. A successful migration:

- moves complete English/Chinese pairs to their planned recursive locations;
- preserves accepted facts, revisions, state, baselines, evidence, and body
  content except required managed path/link substitutions;
- rewrites project-map paired assets, constraint refs, repository locators, and
  generated navigation;
- removes old canonical copies and verifies the complete v2 result atomically.
- binds every participating repository tree into the approved fingerprint and
  restores already-published shards if a later shard or governance publish fails.

There is no public migration CLI, migration receipt, schema-v1 registry,
redirect stub, symlink, or duplicate knowledge body. External Markdown links
that cannot be proven safe to rewrite are reported as compatibility risks.
Real project migration remains outside this release. Update a develop-bound
local plugin only after the release PR is merged.

## Evidence boundary

- Contract, layout, transaction, migration, routing, delivery, governance,
  bundle, fixture, privacy, and static-conformance gates are included in the
  repository phase gate.
- The Gold contract adds explicit v2 cases for progressive two-level
  materialization, approved flat-layout migration, three-level bounded routing,
  and temporary questions with no durable write.
- Codex `0.147.0-alpha.6.5` and Kimi Code `0.29.2` retained traces were produced
  for `0.1.0`. Their recorded failures and bounded remediation results remain
  historical evidence and are not relabeled as `0.5.0` runs.
- Claude Code, Cursor, and ZCode remain `NOT_TESTED` because native executables
  were unavailable. Structural passes never produce a `SUPPORTED` claim.

## Release blocker

A supported release tag still requires all five target hosts to be `SUPPORTED`
for exact tested versions, with three retained independent runs for every Gold
scenario and completed semantic review. This candidate does not meet that
support gate.

## Packaging boundary

The deterministic archive contains only the explicit release surface. It
excludes source scripts, tests and raw traces, design worktrees, Git metadata,
dependency directories, obsolete Skill copies, private product bodies, and
local absolute paths. The adjacent `.sha256` file binds the archive bytes.
