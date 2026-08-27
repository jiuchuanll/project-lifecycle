# Owner-Centric Delivery Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat delivery namespace with the approved layout-v2 owner hierarchy, explicit migration, bounded recursive indexes, and installed-runtime support without changing lifecycle semantics.

**Architecture:** Introduce one delivery-layout resolver as the only authority for artifact and archive locators. Materialization, inventory, indexes, alignment projection, retention, migration, bootstrap, and CLI commands consume that resolver; migration reuses the existing retained layout transaction so publication is atomic and rollback is evidence-backed.

**Tech Stack:** Node.js 22 ESM, `node:test`, AJV 2020 JSON Schema, YAML, existing atomic-write and layout-transaction libraries, esbuild bundle.

**Spec:** `docs/superpowers/specs/2026-08-27-owner-centric-delivery-layout-design.md`

## Global Constraints

- Primary route is `NON_PRD_DELIVERY`; selected solution is `solution-owner-centric-delivery-layout-v2`.
- Every delivery-process asset has exactly one physical PRD or non-PRD owner; Feedback has no physical delivery owner.
- English and Chinese logical pairs remain in the same directory and change together.
- `layout_version: 2` permits only the canonical hierarchy; legacy layout is read-only except during an explicitly approved migration.
- Preview and validation are read-only. Migration publishes `layout.json` only after the candidate tree validates.
- No symlinks, redirect stubs, permanent duplicate bodies, automatic user-project migration, or indefinite dual-write compatibility.
- Preserve route vocabulary, Feedback source immutability, Knowledge Diff authority, project-map topology, obligations, and human acceptance gates.
- Installed runtime must work on Node.js `>=22` without repository or cache `node_modules`.

## File Structure

- `scripts/schemas/delivery-layout.schema.json`: validates the machine-owned `delivery/layout.json` marker.
- `skills/maintain-project-knowledge/assets/delivery-layout.json`: canonical bootstrap marker content.
- `scripts/delivery/delivery-layout.mjs`: owns layout detection, owner validation, active/archive locator calculation, and bounded managed-directory constants.
- `scripts/delivery/delivery-inventory.mjs`: recursively discovers and validates v2 delivery pairs without reading unrelated bodies into caller context.
- `scripts/delivery/delivery-indexes.mjs`: renders and publishes delivery root and owner index pairs from a validated inventory.
- `scripts/delivery/delivery-layout-migration.mjs`: produces legacy migration previews, applies approved owner mappings, builds the candidate tree, and executes or rolls back the retained transaction.
- Existing materialization, alignment, retention, bootstrap, knowledge-index, CLI, Skill, README, fixture, and bundle files integrate with those focused modules.

---

### Task 1: Establish the layout-v2 contract and bootstrap marker

**Files:**
- Create: `scripts/schemas/delivery-layout.schema.json`
- Create: `skills/maintain-project-knowledge/assets/delivery-layout.json`
- Create: `scripts/delivery/delivery-layout.mjs`
- Create: `tests/delivery/delivery-layout.test.mjs`
- Modify: `scripts/lib/schema-registry.mjs`
- Modify: `scripts/knowledge/bootstrap.mjs`
- Modify: `tests/knowledge/reconnaissance.test.mjs`

**Interfaces:**
- Produces: `DELIVERY_LAYOUT`, `deliveryLayoutContent()`, `validatePhysicalOwner(frontmatter)`, `activeDeliveryPair(frontmatter, { ownerKind })`, `archivedDeliveryPair(frontmatter, { ownerKind })`, `alignmentReviewPair()`, `resolvePhysicalOwner({ lifecycleRoot, frontmatter })`, and `detectDeliveryLayout({ root })`.
- Consumes: existing `validateJson`, safe-path helpers, deterministic ordering, and result/error helpers.

- [ ] **Step 1: Write failing resolver and bootstrap tests**

Add table-driven cases asserting the exact canonical paths and ownership rules:

```js
const cases = [
  ['feedback', 'feedback-density', undefined, null, 'delivery/feedback/feedback-density-en.md'],
  ['prd', 'prd-wiki-v1', 'prd-wiki-v1', 'prd', 'delivery/prds/prd-wiki-v1/prd-wiki-v1-en.md'],
  ['non-prd-delivery', 'repair-index', 'repair-index', 'non-prd-delivery', 'delivery/non-prd/repair-index/repair-index-en.md'],
  ['architecture', 'architecture-wiki-v1', 'prd-wiki-v1', 'prd', 'delivery/prds/prd-wiki-v1/architecture/architecture-wiki-v1-en.md'],
  ['guidance', 'guidance-wiki-v1', 'prd-wiki-v1', 'prd', 'delivery/prds/prd-wiki-v1/guidance/guidance-wiki-v1-en.md'],
  ['batch', 'batch-wiki-v1', 'prd-wiki-v1', 'prd', 'delivery/prds/prd-wiki-v1/batches/batch-wiki-v1-en.md'],
  ['test-report', 'test-wiki-v1', 'prd-wiki-v1', 'prd', 'delivery/prds/prd-wiki-v1/test-reports/test-wiki-v1-en.md'],
  ['closure-summary', 'closure-prd-wiki-v1', 'prd-wiki-v1', 'prd', 'delivery/prds/prd-wiki-v1/closure/closure-prd-wiki-v1-en.md'],
];

for (const [artifact_kind, artifact_id, owner_artifact_id, ownerKind, en] of cases) {
  assert.equal(activeDeliveryPair(
    { artifact_kind, artifact_id, owner_artifact_id },
    { ownerKind },
  ).en, en);
}
assert.equal(validatePhysicalOwner({ artifact_kind: 'feedback', artifact_id: 'feedback-density' }).ok, true);
assert.equal(validatePhysicalOwner({ artifact_kind: 'feedback', artifact_id: 'feedback-density', owner_artifact_id: 'prd-wiki-v1' }).errors[0].code, 'DELIVERY_OWNER_FORBIDDEN');
assert.equal(validatePhysicalOwner({ artifact_kind: 'batch', artifact_id: 'batch-wiki-v1' }).errors[0].code, 'DELIVERY_OWNER_REQUIRED');
```

Extend the bootstrap assertion so a newly materialized project contains exactly `delivery/layout.json` with schema version 1 and layout version 2.

- [ ] **Step 2: Run the focused tests and verify the missing-contract failure**

Run:

```bash
node --test tests/delivery/delivery-layout.test.mjs tests/knowledge/reconnaissance.test.mjs
```

Expected: FAIL because `delivery-layout.mjs`, the schema, and bootstrap marker do not exist.

- [ ] **Step 3: Implement the schema and resolver**

Use this exact public surface:

```js
export const DELIVERY_LAYOUT = Object.freeze({ schema_version: 1, layout_version: 2 });
export const deliveryLayoutContent = () => `${JSON.stringify(DELIVERY_LAYOUT, null, 2)}\n`;
const languagePair = (directory, artifactId) => ({
  en: `${directory}/${artifactId}-en.md`,
  'zh-CN': `${directory}/${artifactId}.md`,
});
const ownerRoot = (ownerKind, ownerId) => {
  if (ownerKind === 'prd') return `delivery/prds/${ownerId}`;
  if (ownerKind === 'non-prd-delivery') return `delivery/non-prd/${ownerId}`;
  throw Object.assign(new Error('Invalid physical owner kind.'), { code: 'DELIVERY_OWNER_MISMATCH' });
};
const phaseDirectory = Object.freeze({
  architecture: 'architecture',
  guidance: 'guidance',
  batch: 'batches',
  'test-report': 'test-reports',
  'closure-summary': 'closure',
});
const activeDirectory = (frontmatter, ownerKind) => {
  if (frontmatter.artifact_kind === 'feedback') return 'delivery/feedback';
  const root = ownerRoot(ownerKind, frontmatter.owner_artifact_id);
  return phaseDirectory[frontmatter.artifact_kind]
    ? `${root}/${phaseDirectory[frontmatter.artifact_kind]}`
    : root;
};
export const validatePhysicalOwner = (frontmatter) => {
  if (frontmatter.artifact_kind === 'feedback') {
    return Object.hasOwn(frontmatter, 'owner_artifact_id')
      ? failure('DELIVERY_OWNER_FORBIDDEN', '/owner_artifact_id', 'Feedback has no physical delivery owner.')
      : ok(frontmatter);
  }
  if (typeof frontmatter.owner_artifact_id !== 'string') {
    return failure('DELIVERY_OWNER_REQUIRED', '/owner_artifact_id', 'A physical delivery owner is required.');
  }
  if (['prd', 'non-prd-delivery'].includes(frontmatter.artifact_kind)
    && frontmatter.owner_artifact_id !== frontmatter.artifact_id) {
    return failure('DELIVERY_OWNER_MISMATCH', '/owner_artifact_id', 'A root delivery owner must own itself.');
  }
  return ok(frontmatter);
};
export const activeDeliveryPair = (frontmatter, { ownerKind = null } = {}) => languagePair(
  activeDirectory(frontmatter, ownerKind),
  frontmatter.artifact_id,
);
export const archivedDeliveryPair = (frontmatter, { ownerKind = null } = {}) => languagePair(
  activeDirectory(frontmatter, ownerKind).replace(/^delivery\//u, 'archive/delivery/'),
  frontmatter.artifact_id,
);
export const alignmentReviewPair = () => languagePair('delivery/views', 'alignment-review');
export const detectDeliveryLayout = async ({ root } = {}) => ok({
  kind: layoutKind,
  marker: marker ?? null,
  evidence_locators: evidenceLocators,
});
```

`detectDeliveryLayout()` must assign `layoutKind` to exactly one of `V2`, `LEGACY_FLAT`, `EMPTY`, or `INVALID_MIXED`. The resolver must validate IDs as safe path segments, reject owner/type mismatches, resolve a child owner by validating exactly one of `delivery/prds/<owner-id>/` and `delivery/non-prd/<owner-id>/`, and mirror canonical paths beneath `archive/delivery/` without using `basename()`.

Register `delivery-layout` in the schema registry. Update bootstrap candidate files and postcondition inspection to write and validate `delivery/layout.json` atomically with the initial lifecycle tree.

- [ ] **Step 4: Run focused tests and verify success**

Run:

```bash
node --test tests/delivery/delivery-layout.test.mjs tests/knowledge/reconnaissance.test.mjs
```

Expected: PASS, including legacy-flat, v2, empty, malformed marker, symlink, and mixed-layout detection cases.

- [ ] **Step 5: Commit the contract**

```bash
git add scripts/schemas/delivery-layout.schema.json skills/maintain-project-knowledge/assets/delivery-layout.json scripts/delivery/delivery-layout.mjs scripts/lib/schema-registry.mjs scripts/knowledge/bootstrap.mjs tests/delivery/delivery-layout.test.mjs tests/knowledge/reconnaissance.test.mjs
git commit -m "feat: define delivery layout v2"
```

### Task 2: Bind Frontmatter and materialization to one physical owner

**Files:**
- Modify: `scripts/schemas/delivery-frontmatter.schema.json`
- Modify: `skills/run-prd-lifecycle/assets/feedback-en.md`
- Modify: `skills/run-prd-lifecycle/assets/feedback.md`
- Modify: `skills/run-prd-lifecycle/assets/prd-en.md`
- Modify: `skills/run-prd-lifecycle/assets/prd.md`
- Modify: `skills/run-prd-lifecycle/assets/architecture-en.md`
- Modify: `skills/run-prd-lifecycle/assets/architecture.md`
- Modify: `skills/run-prd-lifecycle/assets/development-guidance-en.md`
- Modify: `skills/run-prd-lifecycle/assets/development-guidance.md`
- Modify: `skills/run-prd-lifecycle/assets/batch-en.md`
- Modify: `skills/run-prd-lifecycle/assets/batch.md`
- Modify: `skills/run-prd-lifecycle/assets/test-report-en.md`
- Modify: `skills/run-prd-lifecycle/assets/test-report.md`
- Modify: `skills/run-prd-lifecycle/assets/non-prd-delivery-en.md`
- Modify: `skills/run-prd-lifecycle/assets/non-prd-delivery.md`
- Modify: `skills/run-prd-lifecycle/assets/closure-summary-en.md`
- Modify: `skills/run-prd-lifecycle/assets/closure-summary.md`
- Modify: `scripts/delivery/materialize-asset.mjs`
- Modify: `tests/delivery/assets.test.mjs`
- Modify: `tests/fixtures/contracts/handoffs/delivery-frontmatter.valid.json`
- Modify: `tests/fixtures/delivery/assets/threshold-cases.json`

**Interfaces:**
- Consumes: `validatePhysicalOwner()`, `resolvePhysicalOwner()`, `activeDeliveryPair()`, and `detectDeliveryLayout()` from Task 1.
- Produces: schema-v2 delivery Frontmatter and hierarchical `materializeAsset()` locators.

- [ ] **Step 1: Add failing Frontmatter and materialization tests**

Update the shared test builder to emit schema v2 and explicit ownership:

```js
const baseFrontmatter = (overrides = {}) => ({
  schema_version: 2,
  artifact_id: 'prd-wiki-layout-v2',
  owner_artifact_id: 'prd-wiki-layout-v2',
  artifact_kind: 'prd',
  primary_route: 'PRD_DELIVERY',
  project_id_at_creation: 'sample-project',
  current_project_id: 'sample-project',
  domain_ids: ['wiki-workspace'],
  knowledge_baseline: 'baseline-7',
  relationships: { feedback_ids: [], prd_ids: [], legacy_artifact_refs: [] },
  retention_tier: 'active',
  reclassified_from_refs: [],
  obligations: [],
  ...overrides,
});
```

Assert these results:

```js
assert.deepEqual(prd.value.locators, {
  en: 'delivery/prds/prd-wiki-layout-v2/prd-wiki-layout-v2-en.md',
  'zh-CN': 'delivery/prds/prd-wiki-layout-v2/prd-wiki-layout-v2.md',
});
assert.deepEqual(batch.value.locators, {
  en: 'delivery/prds/prd-wiki-layout-v2/batches/batch-wiki-layout-en.md',
  'zh-CN': 'delivery/prds/prd-wiki-layout-v2/batches/batch-wiki-layout.md',
});
```

Also assert that schema-v1 documents remain parseable only for migration, while `materializeAsset()` returns `DELIVERY_LAYOUT_MIGRATION_REQUIRED` for legacy or absent markers and rejects missing, foreign, or contradictory owners before writing.

- [ ] **Step 2: Run the asset tests and verify the flat-path failure**

Run:

```bash
node --test tests/delivery/assets.test.mjs
```

Expected: FAIL because current materialization still emits `delivery/<artifact-id>.md` and templates use schema version 1.

- [ ] **Step 3: Implement schema-v2 owner conditions and resolver-based writes**

Make `delivery-frontmatter` accept legacy schema v1 for migration reads and schema v2 for current operations. For schema v2:

```json
{
  "if": { "properties": { "artifact_kind": { "const": "feedback" } }, "required": ["artifact_kind"] },
  "then": { "not": { "required": ["owner_artifact_id"] } },
  "else": { "required": ["owner_artifact_id"] }
}
```

Add the root-self and child-owner checks in `validateMaterializationRequest()`. Replace its literal locator construction with:

```js
const layout = await detectDeliveryLayout({ root: input.root });
if (!layout.ok || layout.value.kind !== 'V2') {
  return failure('DELIVERY_LAYOUT_MIGRATION_REQUIRED', '/root', 'Delivery layout v2 is required before durable writes.');
}
const owner = await resolvePhysicalOwner({ lifecycleRoot, frontmatter: input.frontmatter });
if (!owner.ok) return owner;
const locators = activeDeliveryPair(input.frontmatter, { ownerKind: owner.value.artifact_kind });
```

Update all eight bilingual templates with schema version 2. Root templates self-own, process-child templates use a concrete matching sample owner, and Feedback templates omit `owner_artifact_id`.

- [ ] **Step 4: Run the complete delivery asset test file**

Run:

```bash
node --test tests/delivery/assets.test.mjs
```

Expected: PASS with hierarchical pair creation, Feedback updates at the independent path, rollback after second-language failure, owner validation, and legacy-write rejection.

- [ ] **Step 5: Commit owner-bound materialization**

```bash
git add scripts/schemas/delivery-frontmatter.schema.json skills/run-prd-lifecycle/assets scripts/delivery/materialize-asset.mjs tests/delivery/assets.test.mjs tests/fixtures/contracts/handoffs/delivery-frontmatter.valid.json tests/fixtures/delivery/assets/threshold-cases.json
git commit -m "feat: materialize delivery assets by owner"
```

### Task 3: Add bounded recursive inventory and generated delivery indexes

**Files:**
- Create: `scripts/delivery/delivery-inventory.mjs`
- Create: `scripts/delivery/delivery-indexes.mjs`
- Create: `tests/delivery/delivery-indexes.test.mjs`
- Modify: `scripts/knowledge/generate-indexes.mjs`
- Modify: `tests/knowledge/indexes.test.mjs`

**Interfaces:**
- Produces: `collectDeliveryInventory({ lifecycleRoot, overlays })` and `generateDeliveryIndexes({ lifecycleRoot, inventory, overlays })`.
- Consumes: Task 1 locator resolver, existing bounded Frontmatter parsing, deterministic ordering, and atomic writer.

- [ ] **Step 1: Write failing inventory and index tests**

Build a v2 fixture containing two PRDs, one non-PRD owner, two Feedback records, one closed summary, and the generated alignment view. Assert the inventory shape:

```js
assert.deepEqual(result.value.owners.map(({ artifact_id }) => artifact_id), [
  'non-prd-index-repair',
  'prd-search-v1',
  'prd-wiki-v1',
]);
assert.deepEqual(result.value.by_owner['prd-wiki-v1'].assets.map(({ artifact_id }) => artifact_id), [
  'architecture-wiki-v1',
  'batch-wiki-v1',
  'prd-wiki-v1',
  'test-wiki-v1',
]);
assert.deepEqual(result.value.archived_by_owner['prd-wiki-v1'].assets.map(({ artifact_id }) => artifact_id), [
  'architecture-wiki-v1-retained',
]);
```

Assert generated files include `delivery/INDEX-en.md`, `delivery/INDEX.md`, and one pair under each owner root. Add rejection cases for unknown managed files, depth beyond four levels under an owner, more than 2,000 managed files, symlinks, duplicate artifact IDs, half pairs, path/Frontmatter mismatch, and an overlay that targets a noncanonical path.

- [ ] **Step 2: Run focused index tests and verify failure**

Run:

```bash
node --test tests/delivery/delivery-indexes.test.mjs tests/knowledge/indexes.test.mjs
```

Expected: FAIL because delivery discovery is flat and no delivery index renderer exists.

- [ ] **Step 3: Implement inventory and index generation**

Use this bounded inventory contract:

```js
export const collectDeliveryInventory = async ({ lifecycleRoot, overlays = {} } = {}) => ok({
  layout_version: 2,
  feedbacks: [],
  owners: [],
  closed_summaries: [],
  views: [],
  by_owner: {},
  archived_by_owner: {},
  pairs: [],
  archived_pairs: [],
});

export const generateDeliveryIndexes = async ({ lifecycleRoot, inventory, overlays = {}, operations = {} } = {}) => ok({
  files: [{ locator, language, content }],
  active_owner_ids: [],
  retained_owner_ids: [],
  feedback_ids: [],
});
```

Inventory must derive expected locators with `activeDeliveryPair()` and reject any mismatch. Index rendering must link Frontmatter metadata without copying bodies. Integrate its validated delivery pairs into `generateIndexesFromRoot()` so the project root index continues to render delivery navigation while recursive scanning belongs only to `delivery-inventory.mjs`.

- [ ] **Step 4: Run focused index and topology tests**

Run:

```bash
node --test tests/delivery/delivery-indexes.test.mjs tests/knowledge/indexes.test.mjs tests/knowledge/topology.test.mjs
```

Expected: PASS; knowledge topology remains unchanged and delivery navigation points to `delivery/INDEX{-en,}.md`.

- [ ] **Step 5: Commit bounded inventory and indexes**

```bash
git add scripts/delivery/delivery-inventory.mjs scripts/delivery/delivery-indexes.mjs scripts/knowledge/generate-indexes.mjs tests/delivery/delivery-indexes.test.mjs tests/knowledge/indexes.test.mjs tests/knowledge/topology.test.mjs
git commit -m "feat: index owner-scoped delivery assets"
```

### Task 4: Move alignment projection and authoritative discovery onto layout v2

**Files:**
- Modify: `scripts/delivery/alignment-review.mjs`
- Modify: `scripts/delivery/materialize-asset.mjs`
- Modify: `tests/delivery/alignment-review.test.mjs`
- Modify: `tests/delivery/alignment-marker.test.mjs`
- Modify: `tests/delivery/assets.test.mjs`

**Interfaces:**
- Consumes: `collectDeliveryInventory()` from Task 3 and the Task 1 view locators.
- Produces: alignment projection only at `delivery/views/alignment-review{-en,}.md` and exact owner/closure discovery across active and archived owner trees.

- [ ] **Step 1: Write failing v2 projection tests**

Change expected locators to:

```js
assert.deepEqual(result.value.locators, {
  en: 'delivery/views/alignment-review-en.md',
  'zh-CN': 'delivery/views/alignment-review.md',
});
```

Add one Feedback linked to two owners in different owner directories, with one closure active and one archived. Assert `DELIVERY_OPEN` until both accepted closures exist, `KNOWLEDGE_WRITEBACK` afterward, and marker removal only after exact v2 inventory plus knowledge resolution. Assert a flat projection collision and a manually authored file in `views/` are rejected.

- [ ] **Step 2: Run alignment tests and verify old-locator failures**

Run:

```bash
node --test tests/delivery/alignment-review.test.mjs tests/delivery/alignment-marker.test.mjs tests/delivery/assets.test.mjs
```

Expected: FAIL on flat view locators and flat authoritative inventory discovery.

- [ ] **Step 3: Reuse the inventory instead of rescanning flat roots**

Replace literal locators with the shared view pair and replace both independent `readdir(delivery)` loops with:

```js
const inventory = await collectDeliveryInventory({ lifecycleRoot });
if (!inventory.ok) {
  return failure('ALIGNMENT_OWNER_INVENTORY_INCOMPLETE', '/delivery', 'Alignment requires a complete layout-v2 inventory.');
}
```

Select Feedback, owner, and closure records from the validated inventory. Preserve the current exact-set, closure-hash, Feedback immutability, and bilingual rollback checks.

- [ ] **Step 4: Run alignment tests and verify success**

Run:

```bash
node --test tests/delivery/alignment-review.test.mjs tests/delivery/alignment-marker.test.mjs tests/delivery/assets.test.mjs
```

Expected: PASS with no change to alignment phases or exit authority.

- [ ] **Step 5: Commit the projection migration**

```bash
git add scripts/delivery/alignment-review.mjs scripts/delivery/materialize-asset.mjs tests/delivery/alignment-review.test.mjs tests/delivery/alignment-marker.test.mjs tests/delivery/assets.test.mjs
git commit -m "feat: scope alignment views to delivery v2"
```

### Task 5: Make closure retention owner-preserving

**Files:**
- Modify: `scripts/delivery/retention.mjs`
- Modify: `scripts/delivery/close-delivery.mjs`
- Modify: `scripts/knowledge/archive-catalog.mjs`
- Modify: `scripts/knowledge/archive-resolver.mjs`
- Modify: `tests/delivery/closure.test.mjs`
- Modify: `tests/knowledge/archive-retrieval.test.mjs`
- Modify: `tests/fixtures/delivery/closure/outcome-cases.json`

**Interfaces:**
- Consumes: `activeDeliveryPair()`, `archivedDeliveryPair()`, and schema-v2 Frontmatter.
- Produces: owner-preserving `archive_transitions` and a retained closure locator under the unchanged active owner root.

- [ ] **Step 1: Write failing hierarchical retention tests**

Use hierarchical detailed locators and assert exact mirrored moves:

```js
assert.deepEqual(result.value.retention.archive_transitions[0], {
  artifact_id: 'prd-wiki-layout',
  artifact_kind: 'prd',
  from: {
    en: 'delivery/prds/prd-wiki-layout/prd-wiki-layout-en.md',
    'zh-CN': 'delivery/prds/prd-wiki-layout/prd-wiki-layout.md',
  },
  to: {
    en: 'archive/delivery/prds/prd-wiki-layout/prd-wiki-layout-en.md',
    'zh-CN': 'archive/delivery/prds/prd-wiki-layout/prd-wiki-layout.md',
  },
  body_hashes: hashes,
  retention_tier: 'archive',
});
```

Assert a detailed artifact outside its declared owner subtree fails with `RETENTION_OWNER_MISMATCH`, and the closure summary's `owner_artifact_id` matches the closed owner. Add an archive catalog case using `archive/delivery/prds/prd-wiki-layout/architecture/architecture-wiki-en.md`; confirm catalog construction reads only its metadata/hash and `resolveArchiveArtifacts()` returns its body only after the exact receipt authorizes that artifact ID.

- [ ] **Step 2: Run closure tests and verify basename flattening fails**

Run:

```bash
node --test tests/delivery/closure.test.mjs
```

Expected: FAIL because retention currently uses `archive/delivery/<basename>`.

- [ ] **Step 3: Calculate archive transitions through the resolver**

Extend each `detailed_artifacts` entry with `owner_artifact_id` and `owner_artifact_kind`, validate its supplied locators against `activeDeliveryPair()`, and produce `to` with `archivedDeliveryPair()`. Do not accept caller-supplied archive targets. Update the archive catalog locator contract from one flat regular expression to exact resolver validation of hierarchical English archive paths. Keep evidence hashes, receipt scope, no-delete policy, stable ordering, and closure cleanup authorization unchanged.

- [ ] **Step 4: Run closure and runtime-cleanup tests**

Run:

```bash
node --test tests/delivery/closure.test.mjs tests/delivery/runtime-cleanup.test.mjs tests/knowledge/archive-retrieval.test.mjs
```

Expected: PASS; runtime receipt cleanup remains scoped to `.project-lifecycle/runtime/prds/<prd-id>` and is not moved into the durable owner directory.

- [ ] **Step 5: Commit owner-preserving retention**

```bash
git add scripts/delivery/retention.mjs scripts/delivery/close-delivery.mjs scripts/knowledge/archive-catalog.mjs scripts/knowledge/archive-resolver.mjs tests/delivery/closure.test.mjs tests/knowledge/archive-retrieval.test.mjs tests/fixtures/delivery/closure/outcome-cases.json
git commit -m "feat: preserve delivery owners during retention"
```

### Task 6: Implement read-only legacy migration planning

**Files:**
- Create: `scripts/delivery/delivery-layout-migration.mjs`
- Create: `tests/delivery/delivery-layout-migration.test.mjs`
- Create: `tests/fixtures/delivery/layout-migration/legacy-project/`
- Modify: `scripts/lib/errors.mjs`

**Interfaces:**
- Produces: `inspectLegacyDeliveryLayout({ root, owner_mappings })` returning an immutable, content-hashed migration plan.
- Consumes: Task 1 resolver, current Markdown/Frontmatter parser, markdown-link rewriter, tree inspection, and deterministic ordering.

- [ ] **Step 1: Write failing preview tests**

Create a legacy fixture with a Feedback pair, PRD pair, PRD-owned architecture pair, non-PRD pair, closure pair, alignment view pair, archived pair, and one external Markdown link. Assert:

```js
const preview = await inspectLegacyDeliveryLayout({
  root,
  owner_mappings: [{ artifact_id: 'architecture-shared', owner_artifact_id: 'prd-wiki-v1' }],
});
assert.equal(preview.ok, true);
assert.equal(preview.value.route, 'NON_PRD_DELIVERY');
assert.equal(preview.value.selected_solution_id, 'solution-owner-centric-delivery-layout-v2');
assert.match(preview.value.plan_hash, /^sha256:[0-9a-f]{64}$/u);
assert.deepEqual(preview.value.moves.find(({ artifact_id }) => artifact_id === 'feedback-density').to.en,
  'delivery/feedback/feedback-density-en.md');
assert.deepEqual(preview.value.unresolved_external_links, [{
  source: 'delivery/prd-wiki-v1-en.md',
  href: 'https://example.test/spec',
}]);
```

Snapshot the entire lifecycle tree before and after preview and assert identical fingerprints. Add `NEEDS_USER` cases for zero/multiple PRD candidates, contradictory supplied mappings, missing pairs, duplicate IDs, invalid legacy Frontmatter, unsafe links, and mixed layout.

- [ ] **Step 2: Run the migration preview tests and verify failure**

Run:

```bash
node --test tests/delivery/delivery-layout-migration.test.mjs
```

Expected: FAIL because the migration planner does not exist.

- [ ] **Step 3: Implement deterministic preview**

Use this result shape:

```js
export const inspectLegacyDeliveryLayout = async ({ root, owner_mappings = [] } = {}) => ok({
  route: 'NON_PRD_DELIVERY',
  selected_solution_id: 'solution-owner-centric-delivery-layout-v2',
  source_fingerprint: `sha256:${sourceDigest}`,
  plan_hash: `sha256:${planDigest}`,
  moves: [{ artifact_id, artifact_kind, owner_artifact_id, from: { en, 'zh-CN': zh }, to: { en, 'zh-CN': zh2 }, body_hashes }],
  managed_reference_rewrites: [],
  unresolved_external_links: [],
  needs_user: [],
  candidate_directories: [],
});
```

Hash canonical JSON with code-point-sorted arrays. Infer only the mappings allowed by the spec. Report ambiguity instead of choosing by filename. Read no archive body outside `archive/delivery/`, and apply the same count, size, realpath, and symlink limits as the v2 inventory.

- [ ] **Step 4: Run preview and safety tests**

Run:

```bash
node --test tests/delivery/delivery-layout-migration.test.mjs tests/knowledge/markdown-links.test.mjs
```

Expected: PASS with byte-identical preview behavior.

- [ ] **Step 5: Commit the preview planner**

```bash
git add scripts/delivery/delivery-layout-migration.mjs scripts/lib/errors.mjs tests/delivery/delivery-layout-migration.test.mjs tests/fixtures/delivery/layout-migration/legacy-project
git commit -m "feat: preview delivery layout migration"
```

### Task 7: Execute migration atomically and expose installed-runtime commands

**Files:**
- Modify: `scripts/delivery/delivery-layout-migration.mjs`
- Modify: `scripts/bin/project-lifecycle-source.mjs`
- Modify: `tests/delivery/delivery-layout-migration.test.mjs`
- Modify: `tests/harnesses/bundle.test.mjs`

**Interfaces:**
- Produces: `buildDeliveryMigrationCandidate({ root, preview })`, `validatePublishedDeliveryV2({ root, preview })`, and `migrateDeliveryLayout({ root, plan_hash, source_fingerprint, owner_mappings, approval_ref, backup_ref })`.
- Produces CLI commands: `inspect-delivery-layout`, `preview-delivery-layout-migration`, `migrate-delivery-layout`, `validate-delivery-layout`, `materialize-delivery-asset`, `close-delivery`, and `generate-delivery-indexes`.
- Consumes: `applyLayoutTransaction()`, `finalizeRetainedLayout()`, `rollbackRetainedLayout()`, Task 3 indexes, materializer, and closure functions.

- [ ] **Step 1: Write failing execution, rollback, and bundle tests**

Assert migration refuses missing approval and backup references:

```js
assert.equal((await migrateDeliveryLayout({
  root, plan_hash, source_fingerprint, owner_mappings,
})).errors[0].code, 'DELIVERY_MIGRATION_APPROVAL_REQUIRED');
```

Inject a failure after candidate publication but before finalization and assert the pre-migration fingerprint is restored, no `delivery/layout.json` remains, and no v2 path remains. Assert successful migration publishes layout v2, generates root/owner indexes, removes flat canonical copies, preserves body hashes, and returns exact moved locators plus `backup_ref`.

Extend the clean-cache bundle test to invoke all seven commands from `bin/project-lifecycle` without `node_modules`. Use absolute temporary-project and envelope paths; assert each command emits exactly one redacted JSON object.

- [ ] **Step 2: Run focused migration and bundle tests and verify failure**

Run:

```bash
node --test tests/delivery/delivery-layout-migration.test.mjs tests/harnesses/bundle.test.mjs
```

Expected: FAIL because execution and CLI dispatch do not exist.

- [ ] **Step 3: Implement retained atomic migration**

Require exact preview replay:

```js
export const migrateDeliveryLayout = async (input = {}, operations = {}) => {
  if (!isSafeReference(input.approval_ref) || !isSafeReference(input.backup_ref)) {
    return failure('DELIVERY_MIGRATION_APPROVAL_REQUIRED', '/approval_ref', 'Migration requires explicit approval and a recoverable backup reference.');
  }
  const preview = await inspectLegacyDeliveryLayout(input);
  if (!preview.ok) return preview;
  if (preview.value.plan_hash !== input.plan_hash
    || preview.value.source_fingerprint !== input.source_fingerprint) {
    return failure('DELIVERY_MIGRATION_STALE', '/plan_hash', 'Migration preview no longer matches the source tree.');
  }
  const candidate = await buildDeliveryMigrationCandidate({ root: input.root, preview: preview.value });
  if (!candidate.ok) return candidate;
  const publication = await applyLayoutTransaction(candidate.value.transaction, {
    ...operations,
    retainBackup: true,
  });
  if (!publication.ok) return publication;
  const validation = await validatePublishedDeliveryV2({ root: input.root, preview: preview.value });
  if (!validation.ok) {
    const rollback = await rollbackRetainedLayout(publication.value, operations);
    return rollback.ok ? validation : rollback;
  }
  const finalized = await finalizeRetainedLayout(publication.value, operations);
  if (!finalized.ok) {
    const rollback = await rollbackRetainedLayout(publication.value, operations);
    return rollback.ok ? finalized : rollback;
  }
  return ok({
    layout_version: 2,
    backup_ref: input.backup_ref,
    moved_locators: preview.value.moves,
    validation_ref: validation.value.validation_ref,
  });
};
```

The candidate includes rewritten schema-v2 Frontmatter with `owner_artifact_id`, preserved bodies and managed hashes, mirrored active/archive paths, generated indexes, and `delivery/layout.json`. Use existing transaction APIs; do not create a second filesystem swap implementation.

- [ ] **Step 4: Add bounded CLI envelopes**

Use existing `parseNamedOptions()`, `readInput()`, `emit()`, absolute-path validation, and redaction. Complex commands consume a maximum 1 MiB JSON envelope. `help` lists the seven new commands. Mutation commands return exact locators and evidence refs but never echo document bodies, hidden reasoning, or filesystem errors.

- [ ] **Step 5: Run bundle and delivery suites**

Run:

```bash
npm run check:bundle
npm run test:delivery
```

Expected: PASS, including clean-cache execution without `node_modules`.

- [ ] **Step 6: Commit migration execution and installed runtime**

```bash
git add scripts/delivery/delivery-layout-migration.mjs scripts/bin/project-lifecycle-source.mjs tests/delivery/delivery-layout-migration.test.mjs tests/harnesses/bundle.test.mjs dist/project-lifecycle.mjs
git commit -m "feat: migrate delivery layout atomically"
```

### Task 8: Align Skills, documentation, behavior fixtures, and full verification

**Files:**
- Modify: `skills/run-prd-lifecycle/SKILL.md`
- Modify: `skills/run-prd-lifecycle/references/delivery-assets.md`
- Modify: `skills/run-prd-lifecycle/references/closure-and-retention.md`
- Modify: `skills/maintain-project-knowledge/references/bootstrap-and-calibration.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `tests/skills/run-prd-lifecycle.test.mjs`
- Modify: `tests/skills/maintain-project-knowledge.test.mjs`
- Modify: `tests/behavior/delivery/scenarios.json`
- Modify: `tests/behavior/delivery/invariants.mjs`
- Modify: any remaining delivery fixture whose canonical locator is still flat

**Interfaces:**
- Consumes: all previous tasks' finalized names and behavior.
- Produces: synchronized human and Agent contracts plus full regression evidence.

- [ ] **Step 1: Write failing Skill and behavior assertions**

Assert both Skills name the fixed v2 root, explicit migration gate, unique physical owner, independent Feedback path, generated views path, retained closure behavior, and installed CLI commands. Add behavior scenarios for:

```json
[
  { "scenario_id": "owner-scoped-prd-continuation", "expected_route": "PRD_DELIVERY" },
  { "scenario_id": "legacy-delivery-layout-preview", "expected_route": "NON_PRD_DELIVERY" },
  { "scenario_id": "ambiguous-legacy-owner", "expected_stop": "NEEDS_USER" },
  { "scenario_id": "closed-owner-default-retrieval", "expected_archive_body_reads": 0 }
]
```

Require selected solution ID before durable migration and keep `intent_materialized_without_acceptance: false`.

- [ ] **Step 2: Run Skill and behavior tests and verify stale-contract failures**

Run:

```bash
node --test tests/skills/run-prd-lifecycle.test.mjs tests/skills/maintain-project-knowledge.test.mjs tests/behavior/gold.test.mjs
```

Expected: FAIL because current Skills and fixtures still describe the flat delivery root.

- [ ] **Step 3: Update synchronized contracts and README trees**

Document the canonical hierarchy, owner field, explicit preview/approval/migration sequence, close-and-archive behavior, and recovery contract. Update English and Chinese documents together. Keep English Skill assets Agent-default and do not duplicate the complete design body into the Skills.

- [ ] **Step 4: Replace every remaining flat canonical test locator**

Run:

```bash
rg -n "delivery/(alignment-review|prd-|feedback-|architecture-|guidance-|batch-|test-|closure-)" scripts skills tests README.md README.zh-CN.md --glob '!tests/fixtures/delivery/layout-migration/**'
```

Expected: only explicit legacy-migration fixtures, negative tests, and historical explanatory text remain. Review every match; do not bulk-rewrite semantic legacy cases.

- [ ] **Step 5: Run complete verification**

Run:

```bash
npm test
npm run validate:fixtures
npm run check:privacy
npm run check:bundle
git diff --check
```

Expected: all tests and validators pass; privacy scan finds no new private data; bundled runtime succeeds without `node_modules`; diff check is clean.

- [ ] **Step 6: Run the required review gates**

Run Codex built-in review against the implementation branch with the narrowest complete diff. Because migration changes local file access, recursive scanning, archive movement, and installed mutation commands, also run Codex Security diff review. Fix valid findings, rerun the affected tests, then rerun the complete verification commands from Step 5.

- [ ] **Step 7: Commit documentation and verification updates**

```bash
git add skills/run-prd-lifecycle skills/maintain-project-knowledge/references README.md README.zh-CN.md tests/skills tests/behavior tests/fixtures
git commit -m "docs: adopt owner-centric delivery layout"
```

Do not push, release, or update the locally installed plugin in this task unless the user separately authorizes those actions after review and verification. If a future authorized release is merged, follow the repository instruction to upgrade through native plugin management, verify the installed version and dependency-free cache entrypoint, and tell the user to start a fresh session for the new Skill snapshot.
