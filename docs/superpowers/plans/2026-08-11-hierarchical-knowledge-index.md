# Hierarchical Knowledge Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not use subagents for this implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Project Lifecycle `0.2.0` with a v2 project-map contract, deterministic recursive knowledge locators, bounded bilingual indexes, atomic legacy-layout migration, and repository-local multi-repository shards.

**Architecture:** A pure `layout-planner.mjs` turns one validated v2 project map into a complete repository-scoped manifest. The existing index generator becomes a renderer over that manifest, while a focused layout transaction module compares and atomically publishes only changed files. Bootstrap, materialization, accepted topology changes, absorption, validation, context selection, and the internal legacy migrator all consume the same manifest.

**Tech Stack:** Node.js 22 ESM, `node:test`, AJV 2020-12, existing Project Lifecycle result/error helpers, filesystem staging/rename transactions, Markdown/YAML validators.

## Global Constraints

- Work only in `/private/tmp/project-lifecycle-hierarchical-knowledge-index` on `codex/hierarchical-knowledge-index`.
- Do not use subagents.
- Keep `project-map.json.parent_id` as the only vertical-topology source; never infer topology from directories.
- Canonical project maps use `schema_version: 2`; do not register v1 as a normal runtime schema.
- Use `paired_assets.repository_id`, where `null` means the governance repository.
- English and Chinese bodies are one atomic unit and must remain in the same repository.
- Do not create legacy redirect stubs, symlinks, duplicate bodies, or a migration-receipt file.
- Do not expose a new user-facing migration CLI.
- Require one explicit approval before migrating a real legacy project.
- Generate full expected manifests but publish only changed files; no-change runs perform zero writes.
- Preserve fact IDs, revisions, knowledge state, baseline, evidence refs, and authoritative content through path-only moves.
- Keep shared Skills authoritative and host adapters thin.
- Synchronize English and Chinese documentation in the same change.
- Target plugin version `0.2.0` without publishing npm or modifying `~/.codex/plugins/cache/`.
- Do not migrate KnowledgeVault Agent App or any real external project.
- Do not push until tests, Codex built-in review, scoped Codex Security review, remediation, and verification all pass.
- Create a ready-for-review PR targeting `develop`; do not merge it.

---

## File Structure

### New focused modules

- `scripts/knowledge/layout-planner.mjs`: pure repository ownership, graph, canonical path, directory, and index-manifest planning.
- `scripts/knowledge/layout-transaction.mjs`: bounded tree snapshot, content comparison, candidate staging, atomic publication, cleanup, and rollback shared by layout-changing operations.
- `scripts/knowledge/migrate-layout.mjs`: internal approved `0.1.0` flat-layout to v2 migration orchestration; no public CLI branch.
- `tests/knowledge/layout-planner.test.mjs`: pure path/topology/repository projection tests.
- `tests/knowledge/layout-transaction.test.mjs`: incremental publication, symlink containment, failure injection, and rollback tests.
- `tests/knowledge/layout-migration.test.mjs`: legacy flat-pair migration and idempotency tests.

### Existing modules with changed responsibilities

- `scripts/schemas/project-map.schema.json`: canonical v2 map, structured paired-assets ownership, recursive bounded references.
- `scripts/lib/validate-json.mjs`: v2 ownership, parent graph, repository locator, and migration-required diagnostics.
- `scripts/lib/bilingual-pair.mjs`: nested canonical paths and repository-aware pair validation.
- `scripts/knowledge/generate-indexes.mjs`: render lifecycle-root, Knowledge-root/shard, and direct-child domain indexes from planner output.
- `scripts/knowledge/bootstrap.mjs`: create v2 skeleton plus both root index levels.
- `scripts/knowledge/materialize.mjs`: ask the planner for canonical targets and publish through the layout transaction.
- `scripts/knowledge/apply-approved-change.mjs`: plan and atomically publish promotion, demotion, reparent, and ID-replacement consequences.
- `scripts/knowledge/apply-knowledge-diff.mjs`: use canonical v2 locators and regenerate only affected indexes.
- `scripts/knowledge/select-context.mjs`: follow bounded hierarchical indexes and repository shards.
- `scripts/validate-fixtures.mjs`: validate v2 layout equality, nested pairs, and links.
- `skills/maintain-project-knowledge/**`: describe v2 layout, parent knowledge gates, migration confirmation, and bounded routing.
- `README.md`, `README.zh-CN.md`, `RELEASE-NOTES.md`, host integration documentation, manifests, package metadata, bundle, and release tests: publish the `0.2.0` contract accurately.

---

### Task 1: Establish the v2 Project-Map Contract

**Files:**
- Modify: `scripts/schemas/project-map.schema.json`
- Modify: `scripts/lib/errors.mjs`
- Modify: `scripts/lib/validate-json.mjs`
- Modify: `skills/maintain-project-knowledge/assets/project-map.json`
- Modify: `tests/contracts/project-map.test.mjs`
- Modify: `tests/fixtures/contracts/project-map/*.json`
- Modify: every test fixture `project-map.json` under `tests/fixtures/`

**Interfaces:**
- Produces: canonical `validateJson('project-map', map)` accepting only `schema_version: 2`.
- Produces: `KNOWLEDGE_LAYOUT_MIGRATION_REQUIRED` for otherwise object-shaped maps with `schema_version: 1`.
- Produces: `paired_assets: { repository_id: string | null, en: string, 'zh-CN': string }`.
- Consumed by: every later task.

- [ ] **Step 1: Add failing v2 schema and ownership tests**

Add cases equivalent to:

```js
test('requires schema v2 and repository-aware paired assets', () => {
  const map = validMap();
  map.schema_version = 2;
  map.domains[0].paired_assets = {
    repository_id: null,
    en: 'knowledge/runtime/runtime-en.md',
    'zh-CN': 'knowledge/runtime/runtime.md',
  };
  assert.equal(validateJson('project-map', map).ok, true);
});

test('returns a stable migration stop for schema v1', () => {
  const map = legacyMap();
  const result = validateJson('project-map', map);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'KNOWLEDGE_LAYOUT_MIGRATION_REQUIRED');
});

test('rejects a paired repository that disagrees with domain ownership', () => {
  const map = multiRepositoryMap();
  map.domains[0].paired_assets.repository_id = 'wrong-repository';
  assert.equal(validateJson('project-map', map).ok, false);
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `node --test tests/contracts/project-map.test.mjs`

Expected: failures for schema version `2`, missing `repository_id`, recursive references, and the absent migration-required error.

- [ ] **Step 3: Implement the minimal v2 schema and semantic checks**

Change the schema to `"schema_version": { "const": 2 }`, require `repository_id` in `pairedAssets`, and validate recursive paths through bounded locator semantics rather than flat-only `knowledge/<id>.md` regular expressions. In `validate-json.mjs`, special-case only the version discriminator before AJV:

```js
if (kind === 'project-map' && value?.schema_version === 1) {
  return fail([createError(
    ERROR_CODES.KNOWLEDGE_LAYOUT_MIGRATION_REQUIRED,
    '/schema_version',
    'Project knowledge layout must be migrated to schema version 2 before a durable write.',
  )]);
}
```

Add semantic checks ensuring one canonical repository per domain and exact agreement with `paired_assets.repository_id`.

- [ ] **Step 4: Upgrade canonical fixtures to v2**

Mechanically set every current canonical map fixture to version `2`; add `repository_id: null` or the registered repository ID to every materialized `paired_assets`. Update recursive constraint references to the new expected paths where the fixture topology requires them. Preserve one dedicated raw v1 flat fixture for Task 7 rather than registering it through the schema registry.

- [ ] **Step 5: Run focused contract and pair tests**

Run: `node --test tests/contracts/project-map.test.mjs tests/contracts/bilingual-pair.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the v2 contract**

```bash
git add scripts/schemas/project-map.schema.json scripts/lib/errors.mjs scripts/lib/validate-json.mjs skills/maintain-project-knowledge/assets/project-map.json tests/contracts tests/fixtures
git commit -m "feat: define project map schema v2"
```

---

### Task 2: Build the Pure Recursive Layout Planner

**Files:**
- Create: `scripts/knowledge/layout-planner.mjs`
- Create: `tests/knowledge/layout-planner.test.mjs`

**Interfaces:**
- Consumes: a v2 map already accepted by `validateJson('project-map', map)`.
- Produces: `planKnowledgeLayout({ map }) -> Result<LayoutManifest>`.
- Produces: `canonicalRepositoryId(map, domainId) -> string | null`.
- Produces: `pairForDomain(manifest, domainId) -> { repository_id, en, 'zh-CN' } | null`.
- `LayoutManifest` is JSON-safe and contains `repositories`, `domains`, `directories`, `bodies`, and `indexes` as deterministically sorted arrays.

- [ ] **Step 1: Write failing single-repository topology tests**

Cover a top-level leaf, a parent with two leaf children, three recursive levels, an unmaterialized parent with a materialized child, and symmetric promotion/demotion. Assert exact locators, for example:

```js
assert.deepEqual(pairForDomain(result.value, 'tools'), {
  repository_id: null,
  en: 'knowledge/runtime/loop/tools-en.md',
  'zh-CN': 'knowledge/runtime/loop/tools.md',
});
assert.equal(result.value.indexes.some(({ locator }) => (
  locator === 'knowledge/runtime/loop/INDEX-en.md'
)), true);
```

- [ ] **Step 2: Run the new planner test and verify RED**

Run: `node --test tests/knowledge/layout-planner.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement graph and same-repository ancestry planning**

Use only map data. Build `childrenByParent`, derive canonical ownership, walk contiguous same-repository ancestors, and sort every externally visible array with `compareCodePoints`. Return stable errors for missing parents, cycles, ambiguous repository ownership, unsafe IDs, and locator collisions.

- [ ] **Step 4: Add failing multi-repository shard tests**

Create a governance parent, a backend child, and a backend grandchild. Assert that the backend child starts at `knowledge/<child>/...`, that no governance ancestor directory appears in the backend manifest, and that the governance parent index still declares the backend child as a direct cross-repository entry.

- [ ] **Step 5: Implement repository projection and collision detection**

Represent each index entry with `repository_id`, `locator`, `language`, `scope`, and `domain_id`. Make the governance Knowledge root global-top-level, while non-governance Knowledge roots list only shard entries whose parent repository differs.

- [ ] **Step 6: Verify determinism and no filesystem dependency**

Run: `node --test tests/knowledge/layout-planner.test.mjs`

Expected: PASS with tests that shuffle domain/repository input order and receive deeply equal manifests.

- [ ] **Step 7: Commit the planner**

```bash
git add scripts/knowledge/layout-planner.mjs tests/knowledge/layout-planner.test.mjs
git commit -m "feat: plan recursive knowledge layouts"
```

---

### Task 3: Render Bounded Hierarchical Indexes

**Files:**
- Modify: `scripts/knowledge/generate-indexes.mjs`
- Modify: `tests/knowledge/indexes.test.mjs`
- Modify: `skills/maintain-project-knowledge/assets/INDEX.md`
- Modify: `skills/maintain-project-knowledge/assets/INDEX-en.md`
- Create: `skills/maintain-project-knowledge/assets/knowledge-INDEX.md`
- Create: `skills/maintain-project-knowledge/assets/knowledge-INDEX-en.md`

**Interfaces:**
- Consumes: `LayoutManifest` from `planKnowledgeLayout` plus validated localized Frontmatter descriptors.
- Produces: `renderKnowledgeIndexes({ map, layout, capability_frontmatters, delivery_frontmatters }) -> Result<IndexFile[]>`.
- Preserves: `generateIndexesFromRoot(...)` as the filesystem-loading boundary, now returning `{ layout, files }`.
- `IndexFile`: `{ repository_id, locator, language, content, scope, domain_id }`.

- [ ] **Step 1: Replace flat-index expectations with failing bounded-index tests**

Assert that lifecycle-root INDEX contains Knowledge and Delivery links but no domain list; governance Knowledge INDEX contains only top-level domains; repository Knowledge INDEX contains only shard roots; and a domain INDEX contains only direct children, never grandchildren.

```js
assert.equal(root.content.includes('domain:tools'), false);
assert.equal(runtime.content.includes('`loop`'), true);
assert.equal(runtime.content.includes('`tools`'), false);
```

Also cover an unmaterialized parent, direct relationships, portable cross-repository links, and retired/merged/superseded direct-child presentation.

- [ ] **Step 2: Run index tests and verify RED**

Run: `node --test tests/knowledge/indexes.test.mjs`

Expected: failures because the current generator emits only two flat lifecycle-root indexes.

- [ ] **Step 3: Refactor the generator into manifest validation and rendering**

Keep bounded Frontmatter reads and safe locator checks. Remove topology construction from the renderer. Render every file from planner scope metadata and include the generated notice in both languages. Resolve links relative to the index's directory for same-repository targets and through registered portable locators for cross-repository targets.

- [ ] **Step 4: Add deterministic and broken-target tests**

Shuffle descriptors and assert identical `IndexFile[]`; reject missing localized pairs, mismatched Frontmatter, non-owned bodies, unsafe portable targets, and an index whose target does not appear in the layout manifest.

- [ ] **Step 5: Run focused index and bundle tests**

Run: `node --test tests/knowledge/indexes.test.mjs tests/harnesses/bundle.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit hierarchical rendering**

```bash
git add scripts/knowledge/generate-indexes.mjs tests/knowledge/indexes.test.mjs skills/maintain-project-knowledge/assets
git commit -m "feat: generate bounded hierarchical indexes"
```

---

### Task 4: Add Incremental Atomic Layout Publication

**Files:**
- Create: `scripts/knowledge/layout-transaction.mjs`
- Create: `tests/knowledge/layout-transaction.test.mjs`
- Modify: `scripts/lib/safe-path.mjs`
- Modify: `tests/io/atomic-write.test.mjs`

**Interfaces:**
- Produces: `inspectLifecycleTree({ repositoryRoot }) -> Result<TreeSnapshot>`.
- Produces: `diffLayout({ current, candidate }) -> { writes, moves, deletes, unchanged }`.
- Produces: `applyLayoutTransaction({ repositoryRoot, expectedFingerprint, candidateFiles, deleteLocators, validateCandidate }, operations) -> Result<{ changed, unchanged }>`.
- Requires every candidate file to declare `repository_id`, bounded `locator`, `content`, and `validate`.

- [ ] **Step 1: Write failing diff and zero-write tests**

Build temporary lifecycle trees and assert that identical candidates perform no calls to injected `atomicWriteValidated` or `rename`, while one changed parent index leaves an unrelated index's bytes and `mtimeMs` unchanged.

- [ ] **Step 2: Write failing containment and rollback tests**

Cover traversal, absolute paths, backslashes, URL-like paths, lifecycle-root symlinks, nested symlink escape, bilingual first-write failure, rename-after-move rejection, candidate validation failure, publish failure, successful rollback, and restore failure with preserved recovery assets.

- [ ] **Step 3: Run transaction tests and verify RED**

Run: `node --test tests/knowledge/layout-transaction.test.mjs tests/io/atomic-write.test.mjs`

Expected: module-not-found and missing-containment failures.

- [ ] **Step 4: Implement bounded snapshots and content-addressed diffs**

Reuse `resolveInside`, `realpath`, and current directory fingerprints. Treat a bilingual pair plus map and indexes as one candidate write set. Reject unsupported filesystem entries before staging.

- [ ] **Step 5: Implement staging, validation, publish, and rollback**

Stage a complete candidate lifecycle root, validate it, fingerprint the original immediately before publish, rename original to backup, publish candidate, run the postcondition, and remove the backup only after success. Reconcile rename calls that move and then reject by inspecting postconditions, matching existing hardened materialization behavior.

- [ ] **Step 6: Run focused safety tests**

Run: `node --test tests/knowledge/layout-transaction.test.mjs tests/io/atomic-write.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the shared transaction**

```bash
git add scripts/knowledge/layout-transaction.mjs scripts/lib/safe-path.mjs tests/knowledge/layout-transaction.test.mjs tests/io/atomic-write.test.mjs
git commit -m "feat: publish knowledge layouts atomically"
```

---

### Task 5: Integrate Bootstrap and Materialization

**Files:**
- Modify: `scripts/knowledge/bootstrap.mjs`
- Modify: `scripts/knowledge/materialize.mjs`
- Modify: `scripts/lib/bilingual-pair.mjs`
- Modify: `tests/knowledge/reconnaissance.test.mjs`
- Modify: `tests/knowledge/materialization.test.mjs`
- Modify: `tests/contracts/bilingual-pair.test.mjs`
- Modify: `tests/fixtures/knowledge/materialization/valid-input.json`

**Interfaces:**
- Bootstrap consumes `planKnowledgeLayout({ map })` and writes lifecycle-root plus Knowledge-root index pairs.
- Materialization no longer trusts caller-chosen targets; it compares supplied targets, if retained for compatibility, with `pairForDomain(layout, domainId)` and rejects any mismatch.
- Both publish through `applyLayoutTransaction`.

- [ ] **Step 1: Add failing v2 bootstrap tests**

Assert creation of `knowledge/INDEX.md` and `INDEX-en.md`, lightweight lifecycle-root indexes, confirmed-parent directories/indexes without parent bodies, and exact idempotent second-run status.

- [ ] **Step 2: Add failing recursive materialization tests**

Cover top-level leaf, child under parent, three-level leaf, unmaterialized parent, materialized parent, and automatic affected-index reconstruction. Assert exact nested map locators and Frontmatter sibling pairing.

- [ ] **Step 3: Run bootstrap/materialization tests and verify RED**

Run: `node --test tests/knowledge/reconnaissance.test.mjs tests/knowledge/materialization.test.mjs tests/contracts/bilingual-pair.test.mjs`

Expected: failures on flat canonical targets and missing Knowledge indexes.

- [ ] **Step 4: Integrate planner, renderer, and transaction**

Delete the hard-coded `knowledge/${domainId}.md` target calculation. Build the candidate map first, plan it, render all expected indexes, overlay localized candidate bodies, and publish only after pair, fact, map, and full-manifest validation.

- [ ] **Step 5: Preserve parent knowledge gates**

Keep the existing fact/evidence/owner/dependency/unknown/approval threshold. Add assertions that directory and INDEX creation never fabricate a parent body or `current` state.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test tests/knowledge/reconnaissance.test.mjs tests/knowledge/materialization.test.mjs tests/contracts/bilingual-pair.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit integration**

```bash
git add scripts/knowledge/bootstrap.mjs scripts/knowledge/materialize.mjs scripts/lib/bilingual-pair.mjs tests/knowledge/reconnaissance.test.mjs tests/knowledge/materialization.test.mjs tests/contracts/bilingual-pair.test.mjs tests/fixtures/knowledge/materialization
git commit -m "feat: materialize recursive knowledge assets"
```

---

### Task 6: Apply Approved Topology and Knowledge Changes Through the Planner

**Files:**
- Modify: `scripts/knowledge/apply-approved-change.mjs`
- Modify: `scripts/knowledge/apply-knowledge-diff.mjs`
- Modify: `scripts/knowledge/impact.mjs`
- Modify: `tests/knowledge/topology.test.mjs`
- Modify: `tests/knowledge/absorption.test.mjs`
- Modify: `tests/knowledge/constraints.test.mjs`

**Interfaces:**
- Consumes: reviewed `candidate_map`, approval refs, child dispositions, and exact bilingual knowledge commitments.
- Produces: an accepted v2 candidate layout applied through `applyLayoutTransaction`.
- Preserves semantic gates before computing mechanical moves.

- [ ] **Step 1: Add failing promotion, demotion, and reparent tests**

Assert that a first child moves the parent's pair into its directory; removal/reparent of the last child moves it back; subtree reparent moves every body whose canonical path changes; old/new ancestor indexes update; unrelated indexes retain bytes and mtimes.

- [ ] **Step 2: Add failing ID replacement and constraint-ref tests**

Require predecessor/successor approval, move bodies to the replacement path, update map/Frontmatter/constraint locators, preserve fact IDs unless the reviewed change explicitly replaces them, and reject incomplete child dispositions.

- [ ] **Step 3: Run topology and absorption tests and verify RED**

Run: `node --test tests/knowledge/topology.test.mjs tests/knowledge/absorption.test.mjs tests/knowledge/constraints.test.mjs`

Expected: flat-path and stale-index failures.

- [ ] **Step 4: Replace direct locator writes with before/after layout plans**

Compute current and candidate manifests only after existing semantic and commitment checks pass. Derive moves and affected indexes from manifest differences; do not infer semantic dispositions from filesystem changes.

- [ ] **Step 5: Integrate knowledge absorption**

Validate candidate Knowledge Diff ownership against `paired_assets.repository_id`, overlay accepted localized bodies at planned paths, regenerate affected indexes, and reject stale baseline or unresolved ownership before staging.

- [ ] **Step 6: Run focused topology suites**

Run: `node --test tests/knowledge/topology.test.mjs tests/knowledge/absorption.test.mjs tests/knowledge/constraints.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit governed topology integration**

```bash
git add scripts/knowledge/apply-approved-change.mjs scripts/knowledge/apply-knowledge-diff.mjs scripts/knowledge/impact.mjs tests/knowledge/topology.test.mjs tests/knowledge/absorption.test.mjs tests/knowledge/constraints.test.mjs
git commit -m "feat: reconcile approved knowledge topology"
```

---

### Task 7: Implement Internal Legacy Layout Migration

**Files:**
- Create: `scripts/knowledge/migrate-layout.mjs`
- Create: `tests/knowledge/layout-migration.test.mjs`
- Create: `tests/fixtures/knowledge/layout-migration/v1-flat/project-map.json`
- Create: valid bilingual flat assets under `tests/fixtures/knowledge/layout-migration/v1-flat/knowledge/`
- Modify: `scripts/validate-fixtures.mjs`

**Interfaces:**
- Produces: `inspectLegacyKnowledgeLayout({ root }) -> Result<LegacyInspection>` with no writes.
- Produces: `migrateKnowledgeLayout({ root, approval_ref, expected_fingerprint }, operations) -> Result<MigrationSummary>`.
- `MigrationSummary`: `{ status, from_schema, to_schema, moved_pairs, changed_references, external_link_risks, verification }`.
- Not exported through `scripts/bin/project-lifecycle.mjs` help or command dispatch.

- [ ] **Step 1: Create a strict valid legacy fixture and failing migration test**

Use schema version `1` with flat `knowledge/<id>.md` and `knowledge/<id>-en.md` pairs, nested `parent_id`, facts, constraints, baselines, evidence, and repository locators. Assert the exact recursive v2 result and unchanged machine fields.

- [ ] **Step 2: Add failing rejection tests**

Reject missing language, mixed old/new bodies, duplicate canonical bodies, invalid/cyclic parents after v2 transformation, unsafe old locators, symlink escape, mismatched machine fields, ambiguous repository ownership, and a missing approval ref for a write.

- [ ] **Step 3: Add failing rollback and idempotency tests**

Inject failures after the first localized write, candidate validation, publish rename, and one multi-repository shard publication. Assert the original complete tree or explicit recovery artifacts. Assert a second successful run returns `already-v2` with zero writes.

- [ ] **Step 4: Run migration tests and verify RED**

Run: `node --test tests/knowledge/layout-migration.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 5: Implement inspection without a registered v1 schema**

Require `schema_version === 1`, exact flat map locators, complete bilingual pairs, and safe lifecycle-relative paths. Clone the raw map, add repository IDs to paired assets, set version `2`, derive recursive locators with the planner, then validate the transformed candidate through the canonical v2 validator. This avoids a second registered runtime schema.

- [ ] **Step 6: Implement approved atomic migration**

Read and preserve exact localized body bytes except managed Frontmatter/link substitutions. Rewrite only project map, paired assets, constraint refs, repository knowledge locators, generated indexes, and exact links within validated capability bodies. Publish through the layout transaction and return the in-memory old/new mapping; write no receipt or legacy stub.

- [ ] **Step 7: Implement multi-repository prepare/validate/commit behavior**

Use accepted baselines/write leases, prepare every repository candidate before publishing any, publish governance last, and restore already-published shards on failure. Test with existing fake/versioned storage patterns rather than real repositories.

- [ ] **Step 8: Run migration and fixture validation tests**

Run: `node --test tests/knowledge/layout-migration.test.mjs tests/governance/multi-repository.test.mjs tests/cli/validate-fixtures.test.mjs`

Expected: PASS.

- [ ] **Step 9: Commit migration support**

```bash
git add scripts/knowledge/migrate-layout.mjs scripts/validate-fixtures.mjs tests/knowledge/layout-migration.test.mjs tests/fixtures/knowledge/layout-migration tests/governance/multi-repository.test.mjs tests/cli/validate-fixtures.test.mjs
git commit -m "feat: migrate legacy knowledge layouts"
```

---

### Task 8: Update Context Routing, Skill Contracts, and Behavior Scenarios

**Files:**
- Modify: `scripts/knowledge/select-context.mjs`
- Modify: `tests/knowledge/context-selection.test.mjs`
- Modify: `skills/maintain-project-knowledge/SKILL.md`
- Modify: `skills/maintain-project-knowledge/references/context-routing.md`
- Modify: `skills/maintain-project-knowledge/references/bootstrap-and-calibration.md`
- Modify: `skills/maintain-project-knowledge/references/materialization.md`
- Modify: `skills/maintain-project-knowledge/references/topology-and-constraints.md`
- Modify: `tests/skills/maintain-project-knowledge.test.mjs`
- Modify: `tests/behavior/gold/scenarios.json`
- Modify: `tests/behavior/gold/invariants.mjs`
- Modify: `tests/behavior/gold/reviewer-checklist.md`
- Modify or add retained traces only when produced by the repository's approved behavior harness.

**Interfaces:**
- Context selection consumes v2 map and planned hierarchical indexes, returning the same bounded knowledge handoff contract.
- Skill migration behavior calls the internal operation only after explicit approval and never for ephemeral questions.

- [ ] **Step 1: Add failing bounded-routing tests**

Build a three-level domain tree and assert selection loads the target body, applicable ancestor constraints, and required direct dependencies, while excluding unrelated siblings, grandchildren, and the complete domain list.

- [ ] **Step 2: Run context tests and verify RED**

Run: `node --test tests/knowledge/context-selection.test.mjs`

Expected: failures on flat locators or overly broad root navigation.

- [ ] **Step 3: Implement hierarchical selection**

Resolve the target through the planner manifest and repository pointer, load only necessary index levels, use exact constraint propagation, and preserve current task-sufficiency and archive-access gates.

- [ ] **Step 4: Update Skill and references atomically**

Document v2 canonical paths, three index classes, unmaterialized-parent behavior, one-confirmation legacy migration, promotion/demotion, reparenting, multi-repository shards, and the prohibition on filesystem-derived topology. Keep English as the authoritative Agent text; update paired user-facing Chinese documentation in Task 9.

- [ ] **Step 5: Add natural-language behavior scenarios**

Cover:

1. a new two-level map with progressive materialization;
2. an existing flat tree migrated after one approval;
3. three-level bounded context routing; and
4. an ordinary temporary question that performs no migration or durable write.

Each scenario must assert selected route, selected context IDs, durable files, archive paths read, human gates, and forbidden writes rather than only matching prose.

- [ ] **Step 6: Run Skill and behavior tests**

Run: `node --test tests/skills/maintain-project-knowledge.test.mjs tests/knowledge/context-selection.test.mjs tests/behavior/gold.test.mjs`

Expected: PASS with retained evidence that matches current host-support claims.

- [ ] **Step 7: Commit Skill and routing behavior**

```bash
git add scripts/knowledge/select-context.mjs tests/knowledge/context-selection.test.mjs skills/maintain-project-knowledge tests/skills/maintain-project-knowledge.test.mjs tests/behavior/gold
git commit -m "feat: route hierarchical project knowledge"
```

---

### Task 9: Synchronize `0.2.0` Documentation, Manifests, and Release Artifacts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.cursor-plugin/plugin.json`
- Modify: `.kimi-plugin/plugin.json`
- Modify: `.zcode-plugin/plugin.json`
- Modify: `.agents/plugins/marketplace.json`
- Modify: `scripts/bin/project-lifecycle.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `RELEASE-NOTES.md`
- Modify: `integrations/*/README.md`
- Modify: `tests/harnesses/manifests.test.mjs`
- Modify: `tests/harnesses/release-package.test.mjs`
- Modify: other version assertions found by `rg '0\.1\.0'` only when they describe the current plugin rather than retained historical evidence.
- Regenerate: `dist/project-lifecycle.mjs`
- Regenerate: `dist/project-lifecycle-0.2.0.zip`
- Regenerate: `dist/project-lifecycle-0.2.0.zip.sha256`
- Remove through Git: tracked obsolete `dist/project-lifecycle-0.1.0.zip` and checksum only after the `0.2.0` package verifies.

**Interfaces:**
- `bin/project-lifecycle version` reports `0.2.0`.
- All host manifests and marketplace metadata agree on `0.2.0`.
- Support statuses remain evidence-based and are not upgraded merely because packaging succeeds.

- [ ] **Step 1: Update failing manifest/version expectations first**

Change tests to expect `0.2.0`, the recursive Knowledge layout, required v2 assets, and package names. Run them before metadata changes.

Run: `node --test tests/harnesses/manifests.test.mjs tests/harnesses/release-package.test.mjs tests/cli/help.test.mjs`

Expected: FAIL with `0.1.0` version mismatches.

- [ ] **Step 2: Synchronize metadata and bilingual documentation**

Update package/lock/manifests, README examples and directory trees, explicit v1 migration guidance, three INDEX responsibilities, multi-repository behavior, and `0.2.0` release notes. Keep historical trace versions unchanged and label them historical where necessary.

- [ ] **Step 3: Build and verify release artifacts**

Run: `npm run build && node scripts/package-release.mjs`

Expected: a deterministic `project-lifecycle-0.2.0.zip`, checksum, bundled CLI, shared Skills, and no ignored macOS metadata.

- [ ] **Step 4: Run release-focused tests**

Run: `node --test tests/harnesses/manifests.test.mjs tests/harnesses/bundle.test.mjs tests/harnesses/release-package.test.mjs tests/cli/help.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit version and documentation**

```bash
git add package.json package-lock.json .codex-plugin .claude-plugin .cursor-plugin .kimi-plugin .zcode-plugin .agents scripts/bin/project-lifecycle.mjs README.md README.zh-CN.md RELEASE-NOTES.md integrations tests/harnesses dist
git commit -m "chore: prepare project lifecycle 0.2.0"
```

---

### Task 10: Full Verification, Review, Remediation, Push, and Pull Request

**Files:**
- Modify: only files required to fix validated test, review, or security findings.
- Verify: no files under `~/.codex/plugins/cache/`, KnowledgeVault Agent App, or any real project knowledge base changed.

**Interfaces:**
- Produces: a reviewed branch with no unresolved blocking findings and a ready-for-review PR targeting `develop`.

- [ ] **Step 1: Run the complete local gate**

```bash
npm test
npm run validate:fixtures
npm run check:privacy
npm run check:bundle
npm run conformance:static
git diff --check
```

Expected: every command exits `0`. Record exact counts and durations as current evidence.

- [ ] **Step 2: Run Skill structural and behavior evidence checks**

Run the repository's structural conformance and Gold scenario checks for the updated natural-language scenarios. Confirm that retained evidence contains the Skill/model/parameter/baseline trace required by the existing harness and that host support statuses have not been overstated.

- [ ] **Step 3: Audit repository scope and generated residue**

Run:

```bash
git status --short
git diff --stat origin/develop...HEAD
git diff --name-status origin/develop...HEAD
find . -name '.DS_Store' -o -name '*.tmp' -o -name '*.bak'
```

Expected: only task files, no temporary/backup residue, no duplicate old/new package, and no unexpected `.DS_Store` in the change set.

- [ ] **Step 4: Run Codex built-in review on the narrow current branch diff**

Review `origin/develop...HEAD`. Classify every finding with evidence. For each valid finding, add a failing regression test, make the smallest fix, rerun the focused test, and rerun the complete local gate.

- [ ] **Step 5: Run scoped Codex Security diff review**

Scope the security review to layout planning, path containment, symlink handling, multi-repository boundaries, staging/backup publication, rollback, and migration. Treat validated findings as blocking. Repair through RED → GREEN and rerun focused plus full verification.

- [ ] **Step 6: Perform final clean-state verification**

Run:

```bash
git status --short --branch
git diff --check origin/develop...HEAD
npm run check
```

Expected: clean worktree, branch ahead only by reviewed commits, all checks green.

- [ ] **Step 7: Push through the confirmed review gate**

```bash
CODEX_REVIEW_GATE_CONFIRMED=1 git push -u origin codex/hierarchical-knowledge-index
```

Expected: remote branch updated successfully.

- [ ] **Step 8: Create a ready-for-review pull request**

Create a PR targeting `develop`. The body must summarize the recursive locator contract, migration behavior, v2/`0.2.0` change, tests and current results, security review, external-link compatibility boundary, and explicitly unperformed real-project/global-plugin migrations.

- [ ] **Step 9: Verify the PR and CI**

Read back the PR URL, head/base, changed-file scope, and checks. Watch the retriggered GitHub checks to completion. If CI fails, diagnose the actual failing job, make the smallest tested repair, repeat review when the diff changes materially, push with the gate only after review remains satisfied, and watch again.

- [ ] **Step 10: Stop before merge and global installation**

Report the PR URL and exact status. Do not merge. Do not change the local global plugin. After the user later confirms the PR is merged into `develop`, refresh the existing develop-bound marketplace, install `0.2.0` with native Codex plugin commands, and verify version/CLI/Skill discovery in that later step.
