# Hierarchical Knowledge Layout and Index Design

Status: Approved

Date: 2026-08-11

Repository: `jiuchuanll/project-lifecycle`

Target plugin version: `0.2.0`

Selected solution: `solution:unified-layout-planner`

Chinese mirror: [2026-08-11-hierarchical-knowledge-index-design.zh-CN.md](./2026-08-11-hierarchical-knowledge-index-design.zh-CN.md)

## Objective

Replace the flat `docs/project-lifecycle/knowledge/*.md` layout with a deterministic recursive layout derived exclusively from `project-map.json.parent_id`. Generate bilingual indexes at each level so the lifecycle-root index stays bounded as the number and depth of domains grow.

The change preserves Project Lifecycle's knowledge gates: a directory or generated index may exist for a confirmed parent without implying that the parent owns approved current knowledge.

## Confirmed Decisions

- `project-map.json` remains the only authoritative vertical topology.
- The canonical project-map schema becomes version `2`; version `1` is not retained as a normal registered runtime schema.
- The plugin version becomes `0.2.0`.
- Use one pure layout planner, one bilingual index renderer, one validator, and one transactional applier.
- Do not expose a new user-facing migration CLI. An Agent performs discovery, explanation, and confirmation while an internal `migrateKnowledgeLayout()` operation provides deterministic atomic execution.
- A real project migration requires one explicit approval, after which the complete migration runs without per-file questions.
- Do not retain old bodies, redirect stubs, or symlinks at legacy locators.
- Do not add a durable migration-receipt file. The Agent result, Git diff, commit history, and retained task evidence provide the migration audit trail.
- Compute the complete expected manifest for validation, but publish only files whose bytes or existence must change.
- Promote leaves to parent directories and demote former parents to leaves symmetrically.
- In multi-repository projects, governance and global navigation remain centralized while knowledge bodies stay in their canonical repositories.
- The local global Codex plugin marketplace remains bound to `develop`. It is upgraded only after the pull request has been merged and the user confirms that `develop` contains `0.2.0`.

## Scope

The change includes:

- v2 project-map, locator, constraint-reference, and ownership contracts;
- recursive canonical-locator planning;
- lifecycle-root, knowledge-root, repository-shard, and domain-directory indexes;
- materialization into the recursive layout;
- deterministic leaf promotion and parent demotion;
- subtree reparenting and controlled domain-ID replacement;
- explicit migration of a valid `0.1.0` flat knowledge tree;
- atomic bilingual and multi-file publication with rollback;
- repository-local knowledge shards under centralized governance;
- incremental index publication;
- validators, fixtures, natural-language behavior scenarios, release metadata, and bilingual documentation.

This change does not migrate a real external project, migrate KnowledgeVault Agent App, preserve legacy external Markdown links, create a second topology source, publish an npm package, merge the pull request, or update the installed global plugin before the pull request is merged.

## Authority and State Boundaries

`project-map.json` v2 owns domain identity, `parent_id`, lifecycle state, repository ownership, routing relationships, constraints, and canonical asset locators. Directories and indexes are derived views and never supply missing topology or knowledge facts.

Boundary confirmation does not verify facts. A generated parent directory or index does not materialize parent knowledge. A parent capability body may exist only after its boundary, at least one durable fact, authoritative evidence, canonical owner, primary dependencies, limits, unknowns, and current-fact approval satisfy the existing materialization gate.

Topology, ownership, ID, parentage, or routing-impacting changes remain subject to pending-change, impact-analysis, and explicit human-approval rules. A capable file mover cannot bypass semantic gates.

## Canonical Repository Ownership

Each domain has exactly one canonical repository:

1. A unique entry in `repositories[].domain_ids` assigns the domain to that registered repository.
2. A domain absent from every registered repository belongs to the governance repository containing the authoritative project map; this is represented as `repository_id: null`.
3. A materialized domain's `paired_assets.repository_id` must equal that canonical assignment.
4. English and Chinese assets must belong to the same repository.
5. `repositories[].domain_ids`, `repositories[].knowledge_asset_locators`, and `paired_assets` must agree or validation fails.

The v2 paired-assets shape is:

```json
{
  "paired_assets": {
    "repository_id": null,
    "en": "knowledge/runtime/loop-en.md",
    "zh-CN": "knowledge/runtime/loop.md"
  }
}
```

Map locators are relative to the owning repository's `docs/project-lifecycle/` root. Capability Frontmatter `paired_asset` remains a sibling-relative link between the two localized files.

## Canonical Locator Algorithm

The planner first validates unique domain IDs, existing parents, an acyclic parent graph, deterministic repository ownership, and safe locator inputs. It then projects the accepted global tree into each canonical repository.

For a domain `D`:

1. Start at `D.parent_id` and walk toward the root.
2. Retain only the contiguous ancestors that have the same canonical repository as `D`.
3. Stop at the first cross-repository boundary; never mirror a remote ancestor directory in `D`'s repository.
4. Use the retained ancestors, from root to parent, as directory segments.
5. If `D` has any direct child in the global map, append `D.id` as a directory and place its body inside that directory.
6. If `D` is a leaf, place its body directly under its retained same-repository parent directory.

Therefore:

```text
Top-level leaf:
knowledge/search.md
knowledge/search-en.md

Top-level parent:
knowledge/runtime/runtime.md
knowledge/runtime/runtime-en.md
knowledge/runtime/INDEX.md
knowledge/runtime/INDEX-en.md

Nested parent and leaf:
knowledge/runtime/loop/loop.md
knowledge/runtime/loop/loop-en.md
knowledge/runtime/loop/tools.md
knowledge/runtime/loop/tools-en.md
knowledge/runtime/loop/INDEX.md
knowledge/runtime/loop/INDEX-en.md
```

A cross-repository child begins a repository-local shard at that repository's `knowledge/` root. Its global parent index links to the shard through the registered portable repository locator.

For the inverse shape—a governance-owned child nested below a repository-owned parent—the shard index uses the stable `project:<project_id>` governance locator. It never emits a local relative link to a body absent from that shard.

The same validated map and repository registrations must always produce the same locator manifest. Existing directories cannot affect the result.

## Index Responsibilities

Every generated index has an English and Chinese counterpart, stable code-point ordering, and a notice that it is derived by Project Lifecycle and must not be edited manually.

### Lifecycle-root index

The governance repository's `docs/project-lifecycle/INDEX.md` and `INDEX-en.md` contain only:

- project identity and purpose;
- the current knowledge baseline;
- the Knowledge entry point;
- the Delivery entry point;
- lightweight active-change, archive, and identity-lineage entry points.

They do not enumerate domains or descendants.

A repository-shard lifecycle-root index retains project identity, baseline, and its local Knowledge entry point, but does not link to a nonexistent local Delivery directory. Delivery navigation remains governance-owned.

### Governance Knowledge index

The governance repository's `knowledge/INDEX.md` and `INDEX-en.md` list only global top-level domains, including repository-owned roots through their portable locators. Each entry contains the localized label, ID, domain state, materialized knowledge state, `remote` when the owning shard's accepted Frontmatter is intentionally unavailable locally, or `not-materialized`, plus a one-line boundary and either the domain-directory index or leaf-body link. No descendants are expanded.

### Repository-shard Knowledge index

An implementation repository's Knowledge index lists only its shard entry domains: domains whose parent is absent or belongs to another canonical repository. It does not reproduce the governance repository's complete top-level list.

### Domain-directory index

Every domain with direct children owns a directory index in its canonical repository. It contains:

- current domain label, ID, state, and short boundary;
- a link to its own body when materialized;
- an explicit `not materialized` statement when no approved body exists;
- direct children only, with state and a body, next-level index, or portable cross-repository link;
- only directly applicable `depends_on`, `governed_by`, and `coordinates_with` navigation.

It never copies capability prose, fact blocks, evidence bodies, unknowns, or all descendants.

Retired, merged, and superseded direct children remain visible in a compact historical-direct-children section with successor information. They do not appear as active entry points or expand recursively.

## Component Architecture

### Layout planner

A pure planner accepts a validated v2 project map and repository registrations. It returns a deterministic manifest containing expected directories, localized bodies, indexes, canonical locators, cross-repository links, and obsolete derived paths. It performs no filesystem reads or writes.

### Index renderer

The renderer accepts only planner output and validated localized metadata. It emits the three index classes without reconstructing topology or reading arbitrary Markdown bodies.

Filesystem-backed generation is repository-scoped. `generateIndexesFromRoot()` receives the active `repository_id`, reads only capability pairs owned by that shard, and emits only that shard's index files. The governance shard uses `null`. Metadata for another shard is never resolved against the current lifecycle root.

### Layout validator

The validator checks schema integrity, graph integrity, ownership, safe paths, bilingual pairing, Frontmatter and fact consistency, link targets, and equality between the expected manifest and the actual tree. Structural success does not assert that product facts are true.

### Transactional applier

The applier compares the expected manifest with the bounded current tree, stages only required changes, validates the complete candidate, and publishes through the existing staging/backup lifecycle-root transaction. It supports failure injection and rollback.

### Operation integrations

Bootstrap, materialization, accepted topology application, knowledge absorption, index generation, and migration all consume planner output. None implements an independent locator algorithm.

## Materialization and Topology Changes

Materializing a child may create required ancestor directories and indexes, but never an unapproved ancestor body.

When a leaf gains its first child, its localized body moves from the parent directory to `<domain-id>/<domain-id>.md` and `<domain-id>/<domain-id>-en.md`. When a parent loses its last child, the inverse move occurs and obsolete indexes and empty derived directories are removed. Both transformations preserve facts, revisions, baselines, evidence, and knowledge state.

Subtree reparenting requires an accepted pending change and descendant impact analysis. The transaction moves the canonical localized bodies, updates the old and new ancestor chains, rebases local Markdown links (using portable repository locators across ownership boundaries), updates every locator and exact managed reference affected by the path change, and leaves unrelated branches byte-identical.

Localized label changes do not affect paths. A domain-ID replacement creates a new path and requires explicit predecessor/successor handling. Fact IDs remain unchanged unless the facts themselves undergo an independently approved replacement, split, or merge.

## Legacy `0.1.0` Migration

Version `1` is a legacy migration input, not a registered normal runtime schema. A v2 write operation encountering `schema_version: 1` returns `KNOWLEDGE_LAYOUT_MIGRATION_REQUIRED`.

The Skill instructs the Agent to detect the legacy layout, inspect it without writing, explain the complete impact, and request one approval. After approval, the internal `migrateKnowledgeLayout()` operation:

1. accepts only the exact valid `0.1.0` flat shape;
2. verifies complete English/Chinese pairs and unchanged machine fields;
3. rejects mixed old/new layouts, duplicate bodies, missing languages, invalid parents, cycles, unsafe paths, and ambiguous ownership;
4. computes the complete v2 manifest from `parent_id` and canonical repositories;
5. migrates localized bodies as one unit;
6. upgrades the map to schema version `2`;
7. updates paired assets, Frontmatter, constraint refs, repository locators, exact managed Markdown links, and all derived indexes;
8. validates the complete v2 candidate before publication; and
9. returns the old-to-new locator mapping, changed paths, external-link risks, and verification result.

The migration does not add redirect stubs, symlinks, duplicate bodies, or a migration-receipt file. It does not broadly rewrite arbitrary repository Markdown or source files. Git diff, commits, and retained Agent results provide the audit trail.

A second run returns `already-v2` with no writes or differences.

## Multi-Repository Transaction

For a multi-repository migration, topology change, materialization, or accepted Knowledge Diff, each participating repository prepares and validates a staged candidate under its accepted baseline and write lease. Publication begins only after every shard and the governance candidate pass validation. Repository-owned bodies and indexes publish first; the governance map publishes last.

The internal migration call supplies an explicit `repository_roots` mapping for every non-governance owner. Inspection fingerprints every participating lifecycle tree as one approved input. Repository shards retain rollback backups until governance publication succeeds; a shard or governance failure restores every shard already published.

If any repository fails, every already-published shard is restored. If restoration itself fails, the operation returns a blocking recovery error and preserves clearly identified recovery assets; it does not advance the governance schema or claim success.

## Safe-Path and Recovery Boundary

Every planned path must be a normalized relative path under the owning repository's lifecycle root. Reject absolute paths, drive-qualified paths, backslashes, URLs used as paths, `..`, symlink targets, and realpath escape.

English and Chinese files are one publication unit. The map, bodies, managed references, and affected indexes form one accepted write set. Any write, rename, validation, or publication failure restores the original complete tree. Successful operations leave no stage, backup, duplicate body, obsolete generated index, or empty derived directory.

## Incremental Index Publication

The planner always computes and validates the complete expected manifest. The applier compares expected bytes and existence with disk state and publishes only changes.

A body-only update that does not alter navigation does not rewrite indexes. Materialization normally affects the current directory, required ancestor chain, repository Knowledge index, and any lightweight lifecycle-root metadata that actually changed. Reparenting affects the old ancestor chain, new ancestor chain, moved subtree locators, and no unrelated branch.

No-change runs perform zero writes. Tests verify both byte equality and unchanged modification times for unaffected indexes.

## Skill and Context-Routing Behavior

New projects bootstrap directly into v2. Reading a legacy project does not itself cause migration. A durable-write request against legacy layout triggers automatic planning and one human confirmation before the Agent invokes the internal migration operation.

After portable-locator discovery, context selection receives the accepted governance map, an authenticated `currentRepositoryId`, and explicit authenticated `repositoryRoots` for any other selected owners. It reads each locator only against its canonical owner root. If a required owner root is absent, it returns that owner's portable locator; when all required roots are supplied, one bounded call produces the complete receipt without repository-required bouncing.

Context selection starts from the lightweight lifecycle-root index, enters the relevant Knowledge or repository-shard index, and loads only the target domain, applicable ancestor constraints, and required direct dependencies. It does not use the root index to preload every domain.

Natural-language requests must trigger the Skill without requiring an explicit `$maintain-project-knowledge` name. Ephemeral questions with no durable knowledge effect must not plan or execute migration.

The shared Skill and scripts remain authoritative for Codex, Claude Code, Cursor, Kimi Code, and ZCode. Host adapters remain thin and do not implement host-specific layouts.

## Schema and Version Changes

The canonical project-map schema requires `schema_version: 2`. `paired_assets` requires `repository_id`, `en`, and `zh-CN`. Recursive constraint refs and repository knowledge locators use the shared bounded-locator validator instead of flat-layout-only patterns.

No directory-path or ancestor-list field is added to the map. Parentage remains represented only by `parent_id`.

Version `0.2.0` must be synchronized across `package.json`, the lockfile, all host manifests, integration guidance, English and Chinese README files, release notes, build outputs, checksums, and version assertions.

## TDD and Verification

Implementation begins with failing tests. Coverage includes:

1. one top-level leaf;
2. one parent with multiple leaf children;
3. three or more recursive levels;
4. a materialized child under an unmaterialized parent;
5. leaf promotion;
6. parent demotion;
7. subtree reparenting;
8. controlled domain-ID replacement;
9. valid `0.1.0` flat migration;
10. atomic bilingual migration;
11. root index bounded to lightweight entry points;
12. governance and repository Knowledge indexes bounded to their entry domains;
13. domain indexes limited to direct children;
14. deterministic sorting and repeated-run zero diff;
15. automatic affected-index reconstruction after materialization;
16. no rewrites for unrelated indexes;
17. exact agreement between paired assets and actual paths;
18. rejection of missing languages, machine-field mismatch, invalid parents, cycles, duplicate ownership, and mixed layouts;
19. rejection of traversal, absolute paths, backslashes, URL paths, and symlink escape;
20. complete rollback after injected write, rename, validation, and publication failures;
21. multi-repository pointer and repository-local locator resolution;
22. complete schema, pair, fact, link, and index validation after migration;
23. bootstrap and materialization idempotency; and
24. promotion/demotion and reparent preservation of fact IDs, revisions, baseline, and evidence refs.

Tests inspect topology, actual paths, link targets, machine fields, retained facts, and recovery trees. String snapshots alone are insufficient.

Behavior validation includes at least these natural-language scenarios:

- bootstrap a new two-level knowledge map and progressively materialize it;
- migrate an existing flat knowledge base into the recursive layout;
- route context within a three-level hierarchy without loading the entire root index; and
- reject migration or durable writes for an ordinary temporary question.

## Acceptance and Review Gates

Before publication work, all of the following must pass:

```text
npm test
npm run validate:fixtures
npm run check:privacy
npm run check:bundle
npm run conformance:static
git diff --check
```

Also required:

- fixture validation;
- Skill structural validation;
- retained behavior-scenario evidence;
- bilingual documentation consistency;
- no changes outside this task;
- no cache or external-project edits;
- no temporary, backup, generated-junk, or duplicate-body residue;
- Codex built-in review of the current diff;
- a narrowly scoped Codex Security diff review for filesystem movement, symlink containment, repository boundaries, and rollback; and
- remediation of valid findings followed by relevant and full-gate reruns.

Historical test counts or support claims are not current evidence. Host support status changes only when retained native evidence justifies it.

## Push, Pull Request, and Local Installation

After implementation, verification, review, and remediation are complete, commit the scoped change, push `codex/hierarchical-knowledge-index` using the confirmed review gate, and create a ready-for-review pull request targeting `develop`. Do not merge it automatically.

Do not update the globally installed plugin when the pull request is created. After the user confirms that the pull request has been merged into `develop`, refresh the existing `project-lifecycle` marketplace while it remains bound to `develop`, install `0.2.0` through native Codex plugin commands, and verify the installed version, CLI, and both Skill discoveries. Never edit `~/.codex/plugins/cache/` directly.
