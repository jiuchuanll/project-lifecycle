# Project Lifecycle 0.3.0 candidate notes

Publication status: **PUBLIC PRE-RELEASE EVALUATION CANDIDATE**

Host support gate: **NON-RELEASE CANDIDATE**

Version `0.3.0` builds on the deterministic schema-v2 hierarchy and adds
user-controlled deep domain calibration plus stronger semantic quality gates
for durable capability knowledge. It remains private npm metadata and is
published as repository source plus a deterministic release archive; the
version bump does not upgrade any native-host support claim.

## What changed

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
Real project migration and local global-plugin installation are deliberately
outside this release branch; update the develop-bound local plugin only after
the PR is merged.

## Evidence boundary

- Contract, layout, transaction, migration, routing, delivery, governance,
  bundle, fixture, privacy, and static-conformance gates are included in the
  repository phase gate.
- The Gold contract adds explicit v2 cases for progressive two-level
  materialization, approved flat-layout migration, three-level bounded routing,
  and temporary questions with no durable write.
- Codex `0.147.0-alpha.6.5` and Kimi Code `0.29.2` retained traces were produced
  for `0.1.0`. Their recorded failures and bounded remediation results remain
  historical evidence and are not relabeled as `0.3.0` runs.
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
