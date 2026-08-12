# Knowledge Alignment Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded Feedback-only capture path for confirmed business-to-implementation divergence, plus a five-field active alignment projection that defers delivery creation and remains open through accepted knowledge writeback.

**Architecture:** Keep canonical knowledge and delivery ownership unchanged. Encode one optional machine-readable alignment marker inside the existing mutable Feedback `Marking` section, derive a bilingual activity projection from validated Feedback/owner/closure inputs, and remove the marker only through an evidence-gated alignment-resolution transition. Expose validation and projection sync through the dependency-free installed CLI; do not add a new primary route, durable owner kind, knowledge state, or history ledger.

**Tech Stack:** Node.js 22 ESM, JSON Schema 2020-12, restricted YAML, `node:test`, existing atomic-write/result/error/bilingual helpers, esbuild release bundle.

## Global Constraints

- Selected solution ID is exactly `solution-dual-truth-feedback-deferred-routing`.
- Canonical knowledge must state the accepted business decision and the verified implementation state separately; it must not claim implementation removal without delivery and verification evidence.
- Feedback capture is not PRD materialization, delivery start, worktree allocation, code modification, or test execution.
- The active knowledge task keeps `KNOWLEDGE_UPDATE`; Agent-inferred PRD or non-PRD materialization requires explicit user confirmation.
- `pending-changes.json` remains knowledge-only and must not contain remediation backlog entries.
- Every materialized Feedback and generated projection is an English/Chinese logical pair with matching machine fields, row order, and structure; `title` is localized from the corresponding Feedback H1.
- Each projection row has exactly five fields: `feedback_id`, `title`, `primary_domain_id`, `alignment_phase`, and `owner_ref`.
- `owner_ref` is a sorted unique list so the existing many-to-many Feedback/owner relationship remains intact without adding a sixth field.
- Active phases are exactly `REVIEW_REQUIRED`, `DELIVERY_OPEN`, `KNOWLEDGE_WRITEBACK`, and `DEFERRED`; there is no persisted `COMPLETED` row.
- Generated projection rows contain no evidence bodies, code paths, original narrative, risk prose, PRD scope, tests, Knowledge Diff body, chronology, Agent reasoning, or free-form notes.
- Completed work contributes zero active rows; durable history remains in Feedback and closure assets.
- Preserve the existing closed primary-route vocabulary and existing capability Frontmatter fields.
- Keep changes surgical; do not refactor unrelated delivery, knowledge, index, CLI, or release code.

## File Structure

- `scripts/schemas/alignment-marker.schema.json`: closed schema for the optional Feedback marker.
- `scripts/schemas/alignment-review.schema.json`: closed schema for the five-field generated projection.
- `scripts/schemas/alignment-resolution.schema.json`: runtime proof envelope required before an active marker can be removed.
- `scripts/delivery/alignment-marker.mjs`: marker extraction, pair validation, and transition validation.
- `scripts/delivery/alignment-review.mjs`: pure phase derivation, bilingual rendering, and atomic projection publication.
- `scripts/delivery/materialize-asset.mjs`: integrate marker validation and evidence-gated removal into existing Feedback writes.
- `scripts/knowledge/generate-indexes.mjs`: exclude the two exact generated projection filenames from delivery-asset discovery.
- `scripts/bin/project-lifecycle.mjs`: expose installed-runtime validation and projection-sync commands.
- `scripts/lib/schema-registry.mjs`: register the three new schemas.
- `skills/maintain-project-knowledge/references/bootstrap-and-calibration.md`: preserve knowledge control during Feedback-only capture.
- `skills/maintain-project-knowledge/references/materialization.md`: define dual-truth current wording and evidence limits.
- `skills/run-prd-lifecycle/references/feedback-and-prd-boundaries.md`: define alignment Feedback capture, reuse, and delayed routing.
- `skills/run-prd-lifecycle/references/delivery-assets.md`: define the sparse generated projection.
- `skills/run-prd-lifecycle/references/closure-and-retention.md`: define projection exit and marker removal gates.
- `skills/run-prd-lifecycle/assets/feedback-en.md` and `feedback.md`: show the optional controlled marker without making it mandatory for ordinary Feedback.
- `tests/delivery/alignment-marker.test.mjs`: marker and transition contracts.
- `tests/delivery/alignment-review.test.mjs`: phase derivation, rendering, scale, and atomicity.
- `tests/delivery/assets.test.mjs`: Feedback materialization integration.
- `tests/knowledge/indexes.test.mjs`: generated-file exclusion.
- `tests/cli/alignment.test.mjs`, `tests/cli/help.test.mjs`, `tests/harnesses/bundle.test.mjs`: installed CLI and bundle behavior.
- `tests/behavior/delivery/scenarios.json` and `tests/behavior/delivery/invariants.mjs`: Feedback-only capture behavior without delivery-owner creation.
- `tests/skills/maintain-project-knowledge.test.mjs` and `tests/skills/run-prd-lifecycle.test.mjs`: prose contract gates.
- `dist/project-lifecycle.mjs`: rebuilt self-contained installed runtime.

---

### Task 1: Define and validate the Feedback alignment marker

**Files:**
- Create: `scripts/schemas/alignment-marker.schema.json`
- Create: `scripts/delivery/alignment-marker.mjs`
- Modify: `scripts/lib/schema-registry.mjs`
- Test: `tests/delivery/alignment-marker.test.mjs`

**Interfaces:**
- Consumes: one Feedback `Marking` section string, delivery Frontmatter, and bilingual bodies.
- Produces: `extractAlignmentMarker(marking, path) -> Result<null | AlignmentMarker>` and `validateAlignmentFeedbackPair({ frontmatter, bodies }) -> Result<{ marker, sections }>`.
- `AlignmentMarker` is exactly `{ schema_version: 1, classification: 'BUSINESS_IMPLEMENTATION_DIVERGENCE', primary_domain_id: string, routing_disposition?: 'DEFERRED' }`.

- [ ] **Step 1: Write the failing marker parser and bilingual-pair tests**

```js
test('parses one bounded business-to-implementation marker', () => {
  const result = extractAlignmentMarker(`## Marking

<!-- project-lifecycle:alignment
schema_version: 1
classification: BUSINESS_IMPLEMENTATION_DIVERGENCE
primary_domain_id: approval-flow
-->`, '/body/en/marking');
  assert.deepEqual(result.value, {
    schema_version: 1,
    classification: 'BUSINESS_IMPLEMENTATION_DIVERGENCE',
    primary_domain_id: 'approval-flow',
  });
});

test('rejects duplicate, malformed, divergent, and out-of-domain markers', () => {
  assert.equal(extractAlignmentMarker(`${marker}\n${marker}`, '/marking').errors[0].code, 'ALIGNMENT_MARKER_DUPLICATE');
  assert.equal(validateAlignmentFeedbackPair(pair({ zhDomain: 'other-domain' })).errors[0].code, 'ALIGNMENT_PAIR_MISMATCH');
  assert.equal(validateAlignmentFeedbackPair(pair({ domainIds: ['wiki-workspace'] })).errors[0].code, 'ALIGNMENT_DOMAIN_INVALID');
});
```

- [ ] **Step 2: Run the focused test and verify that the module/schema do not exist yet**

Run: `node --test tests/delivery/alignment-marker.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/delivery/alignment-marker.mjs`.

- [ ] **Step 3: Register the exact closed JSON schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "alignment-marker",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "classification", "primary_domain_id"],
  "properties": {
    "schema_version": { "const": 1 },
    "classification": { "const": "BUSINESS_IMPLEMENTATION_DIVERGENCE" },
    "primary_domain_id": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "routing_disposition": { "const": "DEFERRED" }
  }
}
```

Import and register it in `scripts/lib/schema-registry.mjs` under the exact key `alignment-marker`.

- [ ] **Step 4: Implement strict marker extraction and pair validation**

```js
const OPEN = '<!-- project-lifecycle:alignment\n';
const CLOSE = '\n-->';

export const extractAlignmentMarker = (marking, path = '/marking') => {
  const matches = [...marking.matchAll(/<!-- project-lifecycle:alignment\n([\s\S]*?)\n-->/gu)];
  if (matches.length === 0) return ok(null);
  if (matches.length !== 1) return failure('ALIGNMENT_MARKER_DUPLICATE', path, 'Feedback may contain at most one alignment marker.');
  const parsed = parseRestrictedYaml(matches[0][1], path);
  if (!parsed.ok || !validateJson('alignment-marker', parsed.value).ok) {
    return failure('ALIGNMENT_MARKER_INVALID', path, 'Alignment marker must satisfy the closed contract.');
  }
  return ok(parsed.value);
};

export const validateAlignmentFeedbackPair = ({ frontmatter, bodies }) => {
  const en = extractFromFeedbackBody(bodies.en, '/body/en');
  const zh = extractFromFeedbackBody(bodies['zh-CN'], '/body/zh-CN');
  if (!en.ok || !zh.ok) return !en.ok ? en : zh;
  if (!isDeepStrictEqual(en.value.marker, zh.value.marker)) {
    return failure('ALIGNMENT_PAIR_MISMATCH', '/body', 'Localized Feedback must share one alignment marker.');
  }
  if (en.value.marker && !frontmatter.domain_ids.includes(en.value.marker.primary_domain_id)) {
    return failure('ALIGNMENT_DOMAIN_INVALID', '/body', 'Alignment primary domain must belong to Feedback domain_ids.');
  }
  return ok({ marker: en.value.marker, sections: { en: en.value.sections, 'zh-CN': zh.value.sections } });
};
```

Use the existing restricted-YAML parser, Result helpers, and exact Feedback section delimiters. Reject marker-like text inside fenced examples and reject control characters through the shared schema/reference rules.

- [ ] **Step 5: Run the marker tests**

Run: `node --test tests/delivery/alignment-marker.test.mjs`

Expected: PASS, including absent-marker ordinary Feedback, optional `DEFERRED`, bilingual mismatch, unknown fields, duplicate marker, invalid domain, and malformed YAML cases.

- [ ] **Step 6: Commit the marker contract**

```bash
git add scripts/schemas/alignment-marker.schema.json scripts/lib/schema-registry.mjs scripts/delivery/alignment-marker.mjs tests/delivery/alignment-marker.test.mjs
git commit -m "feat: define alignment feedback marker"
```

---

### Task 2: Enforce alignment semantics during Feedback materialization

**Files:**
- Modify: `scripts/delivery/materialize-asset.mjs`
- Modify: `skills/run-prd-lifecycle/assets/feedback-en.md`
- Modify: `skills/run-prd-lifecycle/assets/feedback.md`
- Test: `tests/delivery/assets.test.mjs`

**Interfaces:**
- Consumes: `validateAlignmentFeedbackPair({ frontmatter, bodies })` from Task 1.
- Produces: existing `materializeAsset(input, operations)` behavior plus validated optional alignment capture; ordinary Feedback behavior remains unchanged.
- Preserves: immutable original-problem/scenario/expectation hashes and mutable-only Marking/Coverage updates.

- [ ] **Step 1: Add failing integration tests for Feedback-only capture**

```js
test('materializes alignment Feedback without creating a PRD owner or runtime receipt', async () => {
  const root = await rootFor();
  const result = await materializeAsset(feedbackRequest(root, { body: alignmentFeedbackBody() }));
  assert.equal(result.ok, true);
  assert.deepEqual(await readdir(join(root, 'docs/project-lifecycle/delivery')), [
    'feedback-retire-legacy-en.md',
    'feedback-retire-legacy.md',
  ]);
});

test('rejects a one-language marker and an unowned primary domain before writing', async () => {
  assert.equal((await materializeAsset(feedbackRequest(root, { body: oneLanguageMarker() }))).errors[0].code, 'ALIGNMENT_PAIR_MISMATCH');
  assert.equal((await materializeAsset(feedbackRequest(root, { body: foreignPrimaryDomain() }))).errors[0].code, 'ALIGNMENT_DOMAIN_INVALID');
  assert.deepEqual(await readdir(deliveryRoot), []);
});
```

- [ ] **Step 2: Run the two focused integration tests and verify failure**

Run: `node --test --test-name-pattern="alignment Feedback|one-language marker" tests/delivery/assets.test.mjs`

Expected: FAIL because `materializeAsset` does not validate alignment markers.

- [ ] **Step 3: Validate the marker before any delivery write**

```js
if (input.frontmatter.artifact_kind === 'feedback') {
  const alignment = validateAlignmentFeedbackPair({
    frontmatter: input.frontmatter,
    bodies: input.body,
  });
  if (!alignment.ok) return alignment;
}
```

Place this after ordinary Feedback section validation and before path resolution or atomic writes. Do not alter `primary_route`, create another artifact, or add a Context Receipt.

- [ ] **Step 4: Add the optional marker example to both Feedback templates**

Add localized explanatory prose followed by a fenced, inert example of the exact marker syntax. The parser must ignore that fenced example, so the template remains ordinary Feedback until the Agent inserts one real marker in the mutable `Marking` section. Do not use nested HTML comments.

````markdown
> Optional: insert this marker only after the business-to-implementation divergence is confirmed.

```text
<!-- project-lifecycle:alignment
schema_version: 1
classification: BUSINESS_IMPLEMENTATION_DIVERGENCE
primary_domain_id: sample-domain
-->
```
````

Use localized explanatory prose but identical marker fields. Keep the real marker absent by default so ordinary Feedback does not become an alignment item.

- [ ] **Step 5: Run all delivery asset tests**

Run: `node --test tests/delivery/assets.test.mjs tests/delivery/alignment-marker.test.mjs`

Expected: PASS; existing history-rewrite and rollback tests remain green.

- [ ] **Step 6: Commit Feedback capture integration**

```bash
git add scripts/delivery/materialize-asset.mjs skills/run-prd-lifecycle/assets/feedback-en.md skills/run-prd-lifecycle/assets/feedback.md tests/delivery/assets.test.mjs
git commit -m "feat: validate alignment feedback capture"
```

---

### Task 3: Derive the exact five-field active alignment projection

**Files:**
- Create: `scripts/schemas/alignment-review.schema.json`
- Create: `scripts/delivery/alignment-review.mjs`
- Modify: `scripts/lib/schema-registry.mjs`
- Test: `tests/delivery/alignment-review.test.mjs`

**Interfaces:**
- Consumes: `deriveAlignmentReview({ feedbacks, owners, closures })` where Feedback records already contain validated markers, owners are validated delivery Frontmatter, and closures use the structured summary returned by `closeDelivery`.
- Produces: `Result<{ schema_version: 1, rows: AlignmentRow[] }>` and `renderAlignmentReviewPair(review) -> { en: string, 'zh-CN': string }`.
- `AlignmentRow` has exactly five keys; `title` is `{ en: string, 'zh-CN': string }`, and `owner_ref` is `string[]` sorted with `compareCodePoints`.

- [ ] **Step 1: Write failing phase, many-owner, and scale tests**

```js
test('derives all four active phases without persisting progress history', () => {
  const result = deriveAlignmentReview(fixture());
  assert.deepEqual(result.value.rows, [
    row('feedback-deferred', 'DEFERRED', []),
    row('feedback-delivering', 'DELIVERY_OPEN', ['prd-backend', 'prd-frontend']),
    row('feedback-review', 'REVIEW_REQUIRED', []),
    row('feedback-writeback', 'KNOWLEDGE_WRITEBACK', ['prd-retirement']),
  ]);
  for (const row of result.value.rows) assert.deepEqual(Object.keys(row).sort(), FIVE_FIELDS);
});

test('renders only active rows when hundreds of closed Feedback records exist', () => {
  const input = fixture({ closedCount: 500, activeCount: 3 });
  const result = deriveAlignmentReview(input);
  assert.equal(result.value.rows.length, 3);
  assert.doesNotMatch(JSON.stringify(result.value), /evidence_refs|risk|history|reasoning|code_path/u);
});
```

- [ ] **Step 2: Run the projection tests and verify module-not-found failure**

Run: `node --test tests/delivery/alignment-review.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/delivery/alignment-review.mjs`.

- [ ] **Step 3: Register the exact projection schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "alignment-review",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "rows"],
  "properties": {
    "schema_version": { "const": 1 },
    "rows": {
      "type": "array",
      "maxItems": 1000,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["feedback_id", "title", "primary_domain_id", "alignment_phase", "owner_ref"],
        "properties": {
          "feedback_id": { "type": "string", "pattern": "^feedback-[a-z0-9-]+$" },
          "title": {
            "type": "object",
            "additionalProperties": false,
            "required": ["en", "zh-CN"],
            "properties": {
              "en": { "type": "string", "minLength": 1, "maxLength": 200 },
              "zh-CN": { "type": "string", "minLength": 1, "maxLength": 200 }
            }
          },
          "primary_domain_id": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
          "alignment_phase": { "enum": ["REVIEW_REQUIRED", "DELIVERY_OPEN", "KNOWLEDGE_WRITEBACK", "DEFERRED"] },
          "owner_ref": {
            "type": "array",
            "maxItems": 20,
            "uniqueItems": true,
            "items": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Implement deterministic owner resolution and phase precedence**

```js
const phaseFor = ({ marker, requiredOwnerRefs, acceptedOwnerRefs }) => {
  const accepted = new Set(acceptedOwnerRefs);
  if (requiredOwnerRefs.some((ownerRef) => !accepted.has(ownerRef))) return 'DELIVERY_OPEN';
  if (requiredOwnerRefs.length > 0) return 'KNOWLEDGE_WRITEBACK';
  if (marker.routing_disposition === 'DEFERRED') return 'DEFERRED';
  return 'REVIEW_REQUIRED';
};

export const deriveAlignmentReview = ({ feedbacks = [], owners = [], closures = [] } = {}) => {
  // Validate every input, reverse-resolve every owner.relationships.feedback_ids,
  // require accepted closure coverage before counting an owner as closed,
  // omit Feedback whose active alignment marker has been resolved and removed,
  // sort owner_ref and rows with compareCodePoints, then validate alignment-review.
};
```

Build `requiredOwnerRefs` only from valid active or accepted linked owners; broken, rejected, and cancelled owners cannot become active references. Build `acceptedOwnerRefs` by verifying closure acceptance and Feedback coverage for each owner, then compare set membership rather than array lengths. If one of several required owners remains open, phase is `DELIVERY_OPEN`. Only when every required owner has an accepted closure that covers the Feedback is phase `KNOWLEDGE_WRITEBACK`. If no valid owner remains, the item returns to `REVIEW_REQUIRED` unless it has an explicit deferral disposition.

- [ ] **Step 5: Render bilingual generated tables with no extra row fields**

```md
<!-- Generated by Project Lifecycle from validated Feedback and delivery state; do not edit. -->
# Active alignment review

| feedback_id | title | primary_domain_id | alignment_phase | owner_ref |
| --- | --- | --- | --- | --- |
| `feedback-retire-legacy` | Retire legacy approval | `approval-flow` | `DELIVERY_OPEN` | `prd-backend`, `prd-frontend` |
```

Select `title.en` or `title['zh-CN']` for the corresponding file, escape table delimiters, render `-` for an empty `owner_ref`, and keep the other four row values and row order identical across languages.

- [ ] **Step 6: Run projection tests**

Run: `node --test tests/delivery/alignment-review.test.mjs`

Expected: PASS for the four phases, multiple owners, invalid closure coverage, unsafe titles, ordering, exact five fields, no completed rows, and 500-closed/3-active scale fixture.

- [ ] **Step 7: Commit the pure projection model**

```bash
git add scripts/schemas/alignment-review.schema.json scripts/lib/schema-registry.mjs scripts/delivery/alignment-review.mjs tests/delivery/alignment-review.test.mjs
git commit -m "feat: derive active alignment review"
```

---

### Task 4: Publish the projection atomically and gate active-row exit

**Files:**
- Create: `scripts/schemas/alignment-resolution.schema.json`
- Modify: `scripts/lib/schema-registry.mjs`
- Modify: `scripts/delivery/alignment-marker.mjs`
- Modify: `scripts/delivery/alignment-review.mjs`
- Modify: `scripts/delivery/materialize-asset.mjs`
- Modify: `scripts/knowledge/generate-indexes.mjs`
- Test: `tests/delivery/alignment-marker.test.mjs`
- Test: `tests/delivery/alignment-review.test.mjs`
- Test: `tests/delivery/assets.test.mjs`
- Test: `tests/knowledge/indexes.test.mjs`

**Interfaces:**
- Consumes: `syncAlignmentReview({ root, feedbacks, owners, closures }, operations)` and optional `input.alignment_resolution` when updating an existing Feedback pair.
- Produces: exact generated files `delivery/alignment-review-en.md` and `delivery/alignment-review.md`, or removal of both when zero active rows; `validateAlignmentExit({ feedbackId, resolution, closures })` blocks premature marker removal.
- `AlignmentResolution` has exact dispositions `DELIVERY_ACCEPTED` and `NO_REMEDIATION_ACCEPTED`.

- [ ] **Step 1: Write failing atomicity and exit-gate tests**

```js
test('keeps the active marker until accepted closure and knowledge resolution are supplied', async () => {
  const result = await materializeAsset(updateWithoutMarker(root, {
    alignment_resolution: deliveryResolution({ knowledge_resolution_refs: [] }),
  }));
  assert.equal(result.errors[0].code, 'ALIGNMENT_RESOLUTION_REQUIRED');
});

test('publishes or removes the bilingual generated pair atomically', async () => {
  assert.deepEqual((await syncAlignmentReview(activeInput(root))).value.locators, {
    en: 'delivery/alignment-review-en.md',
    'zh-CN': 'delivery/alignment-review.md',
  });
  const failed = await syncAlignmentReview(emptyInput(root), injectedSecondWriteFailure());
  assert.equal(failed.errors[0].code, 'ALIGNMENT_REVIEW_WRITE_FAILED');
  assert.deepEqual(await priorPair(root), originalPair);
});
```

- [ ] **Step 2: Run the exit and publication tests and verify failure**

Run: `node --test --test-name-pattern="active marker|generated pair" tests/delivery/alignment-marker.test.mjs tests/delivery/alignment-review.test.mjs tests/delivery/assets.test.mjs`

Expected: FAIL because marker removal and projection publication are not gated.

- [ ] **Step 3: Register the closed alignment-resolution schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "alignment-resolution",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "feedback_id", "disposition", "owner_refs", "closure_refs", "knowledge_resolution_refs"],
  "properties": {
    "schema_version": { "const": 1 },
    "feedback_id": { "type": "string", "pattern": "^feedback-[a-z0-9-]+$" },
    "disposition": { "enum": ["DELIVERY_ACCEPTED", "NO_REMEDIATION_ACCEPTED"] },
    "owner_refs": { "type": "array", "maxItems": 20, "uniqueItems": true, "items": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" } },
    "closure_refs": { "type": "array", "maxItems": 20, "uniqueItems": true, "items": { "type": "string", "minLength": 1, "maxLength": 500 } },
    "knowledge_resolution_refs": { "type": "array", "minItems": 1, "maxItems": 20, "uniqueItems": true, "items": { "type": "string", "minLength": 1, "maxLength": 500 } },
    "human_approval_ref": { "type": "string", "minLength": 1, "maxLength": 500 }
  },
  "allOf": [
    {
      "if": { "properties": { "disposition": { "const": "DELIVERY_ACCEPTED" } }, "required": ["disposition"] },
      "then": { "properties": { "owner_refs": { "minItems": 1 }, "closure_refs": { "minItems": 1 }, "human_approval_ref": false } }
    },
    {
      "if": { "properties": { "disposition": { "const": "NO_REMEDIATION_ACCEPTED" } }, "required": ["disposition"] },
      "then": { "required": ["human_approval_ref"], "properties": { "owner_refs": { "maxItems": 0 }, "closure_refs": { "maxItems": 0 } } }
    }
  ]
}
```

- [ ] **Step 4: Require resolution evidence before removing an existing marker**

```js
if (updating && priorAlignment.marker && !nextAlignment.marker) {
  const exit = validateAlignmentExit({
    feedbackId: id,
    resolution: input.alignment_resolution,
    closures: input.alignment_closures ?? [],
  });
  if (!exit.ok) return exit;
}
```

For `DELIVERY_ACCEPTED`, require the sorted `owner_refs` to equal all required linked owners, every referenced closure to be accepted and cover the Feedback, and at least one safe knowledge-resolution reference per closure. For `NO_REMEDIATION_ACCEPTED`, require an explicit human approval and accepted knowledge no-change/writeback reference. Reject an `alignment_resolution` when no marker is being removed.

- [ ] **Step 5: Implement atomic projection write/removal**

```js
export const syncAlignmentReview = async (input, operations = {}) => {
  const review = deriveAlignmentReview(input);
  if (!review.ok) return review;
  const pair = renderAlignmentReviewPair(review.value);
  return publishGeneratedPair({
    root: input.root,
    locators: {
      en: 'delivery/alignment-review-en.md',
      'zh-CN': 'delivery/alignment-review.md',
    },
    pair,
    removeWhenEmpty: review.value.rows.length === 0,
  }, operations);
};
```

Use the existing regular-directory, symlink-escape, atomic-write, rollback, and byte-identical restoration patterns. Never remove one language independently. Removing an empty projection is allowed only for these two exact generated files.

- [ ] **Step 6: Exclude only the two generated files from delivery Frontmatter discovery**

```js
const GENERATED_DELIVERY_VIEWS = new Set([
  'alignment-review-en.md',
  'alignment-review.md',
]);

names = (await readdir(realDeliveryRoot))
  .filter((name) => name.endsWith('.md') && !GENERATED_DELIVERY_VIEWS.has(name))
  .sort(compareCodePoints);
```

Add a regression showing `generateIndexesFromRoot` succeeds with the projection present but still rejects any other non-delivery Markdown file in `delivery/`.

- [ ] **Step 7: Run transition, projection, asset, and index tests**

Run: `node --test tests/delivery/alignment-marker.test.mjs tests/delivery/alignment-review.test.mjs tests/delivery/assets.test.mjs tests/knowledge/indexes.test.mjs`

Expected: PASS, including second-language failure rollback, empty-pair removal, premature-exit rejection, accepted delivery exit, accepted no-remediation exit, and exact filename exclusion.

- [ ] **Step 8: Commit atomic publication and closure gating**

```bash
git add scripts/schemas/alignment-resolution.schema.json scripts/lib/schema-registry.mjs scripts/delivery/alignment-marker.mjs scripts/delivery/alignment-review.mjs scripts/delivery/materialize-asset.mjs scripts/knowledge/generate-indexes.mjs tests/delivery/alignment-marker.test.mjs tests/delivery/alignment-review.test.mjs tests/delivery/assets.test.mjs tests/knowledge/indexes.test.mjs
git commit -m "feat: close alignment review only after writeback"
```

---

### Task 5: Expose installed-runtime validation and projection synchronization

**Files:**
- Modify: `scripts/bin/project-lifecycle.mjs`
- Create: `tests/cli/alignment.test.mjs`
- Modify: `tests/cli/help.test.mjs`
- Modify: `tests/harnesses/bundle.test.mjs`

**Interfaces:**
- Consumes: `validate-alignment-feedback <en-path> <zh-path> <project-map>` and `sync-alignment-review --root <absolute-project-root> --input <absolute-json-envelope>`.
- Produces: one redacted JSON Result envelope and exit status `0`, `1`, or usage status `2`; sync writes only the two exact generated projection paths.
- The sync input is ephemeral normalized state with keys `feedbacks`, `owners`, and `closures`; it is not copied into project knowledge.

- [ ] **Step 1: Write failing CLI tests**

```js
test('validates a bilingual alignment Feedback pair', () => {
  const result = runCli(['validate-alignment-feedback', en, zh, map]);
  assert.equal(result.status, 0);
  assert.deepEqual(envelope(result).value, {
    feedback_id: 'feedback-retire-legacy',
    primary_domain_id: 'approval-flow',
    routing_disposition: null,
  });
});

test('syncs one bounded active projection and redacts invalid input', () => {
  const result = runCli(['sync-alignment-review', '--root', root, '--input', state]);
  assert.equal(result.status, 0);
  assert.equal(envelope(result).value.row_count, 1);
  assert.equal(result.stderr, '');
});
```

- [ ] **Step 2: Run CLI tests and verify unknown-command failure**

Run: `node --test tests/cli/alignment.test.mjs tests/cli/help.test.mjs`

Expected: FAIL because both commands are absent from help and dispatch.

- [ ] **Step 3: Add the two commands with existing path and redaction rules**

```js
commands: [
  'collect-evidence',
  'parse-facts',
  'sync-alignment-review',
  'validate-alignment-feedback',
  'validate-fixtures',
  'validate-json',
  'validate-pair',
]
```

`validate-alignment-feedback` reads both complete bounded Feedback files plus the map, validates delivery Frontmatter, marker equality, and domain membership, and emits only IDs/disposition. `sync-alignment-review` requires absolute paths, rejects an input envelope larger than 1 MiB before JSON parsing, delegates to `syncAlignmentReview`, and emits only row count, phases, and generated locators. Never echo Feedback prose, evidence, or filesystem bodies in diagnostics.

- [ ] **Step 4: Extend the clean installed-bundle test**

```js
const alignment = run(join(install, 'bin/project-lifecycle'), [
  'validate-alignment-feedback',
  'fixtures/feedback-en.md',
  'fixtures/feedback.md',
  'fixtures/project-map.json',
], install);
assert.equal(alignment.status, 0);
assert.equal(envelope(alignment).ok, true);
assert.equal(await readFile(join(install, 'node_modules'), 'utf8').catch(() => null), null);
```

- [ ] **Step 5: Run CLI tests and bundle check**

Run: `node --test tests/cli/alignment.test.mjs tests/cli/help.test.mjs`

Expected: PASS.

Run: `npm run check:bundle`

Expected: PASS from a copied install containing no `node_modules`.

- [ ] **Step 6: Commit installed-runtime support**

```bash
git add scripts/bin/project-lifecycle.mjs tests/cli/alignment.test.mjs tests/cli/help.test.mjs tests/harnesses/bundle.test.mjs dist/project-lifecycle.mjs
git commit -m "feat: expose alignment review runtime commands"
```

---

### Task 6: Connect both Skills and behavior contracts without changing route ownership

**Files:**
- Modify: `skills/maintain-project-knowledge/references/bootstrap-and-calibration.md`
- Modify: `skills/maintain-project-knowledge/references/materialization.md`
- Modify: `skills/run-prd-lifecycle/references/feedback-and-prd-boundaries.md`
- Modify: `skills/run-prd-lifecycle/references/delivery-assets.md`
- Modify: `skills/run-prd-lifecycle/references/closure-and-retention.md`
- Modify: `tests/skills/maintain-project-knowledge.test.mjs`
- Modify: `tests/skills/run-prd-lifecycle.test.mjs`
- Modify: `tests/behavior/delivery/scenarios.json`
- Modify: `tests/behavior/delivery/invariants.mjs`
- Modify: `tests/delivery/end-to-end.test.mjs`

**Interfaces:**
- Consumes: installed CLI commands and marker/projection contracts from Tasks 1-5.
- Produces: explicit Skill instructions for Feedback-only capture and one deterministic delivery behavior scenario whose main route stays `KNOWLEDGE_UPDATE` while only a Feedback pair and derived projection are written.
- Preserves: exactly seven knowledge references, six delivery references, four primary routes, and `NEEDS_USER` as the only temporary stop.

- [ ] **Step 1: Add failing prose-contract tests**

```js
test('keeps knowledge control during bounded alignment Feedback capture', async () => {
  const bootstrap = await readFile(reference('bootstrap-and-calibration.md'), 'utf8');
  const materialization = await readFile(reference('materialization.md'), 'utf8');
  assert.match(bootstrap, /Feedback captured.*PRD materialized.*delivery started/is);
  assert.match(bootstrap, /return control to knowledge construction/i);
  assert.match(materialization, /business decision.*implementation state/is);
  assert.match(materialization, /must not claim.*implementation.*removed/is);
});

test('keeps the alignment projection sparse and exit-gated', async () => {
  const assets = await readFile(deliveryReference('delivery-assets.md'), 'utf8');
  const closure = await readFile(deliveryReference('closure-and-retention.md'), 'utf8');
  for (const field of FIVE_FIELDS) assert.match(assets, new RegExp(`\\b${field}\\b`));
  assert.match(closure, /every required linked owner.*Knowledge Diff/is);
});
```

- [ ] **Step 2: Add a failing Feedback-only behavior scenario**

```json
{
  "scenario_id": "knowledge-alignment-feedback-capture",
  "input_summary": "User retires an implemented capability while initial knowledge construction continues.",
  "allowed_context_ids": ["domain:approval-flow"],
  "expected_primary_route": "KNOWLEDGE_UPDATE",
  "expected_stop": null,
  "allowed_durable_asset_kinds": ["feedback"],
  "required_human_gate": "BUSINESS_DISPOSITION_CONFIRMATION",
  "expected_obligation_kinds": [],
  "closure_expectation": "OUTSIDE_DELIVERY",
  "forbidden_outcomes": ["CODE_CHANGED", "IMPLEMENTATION_REMOVAL_CLAIMED", "PRD_CREATED", "WORKTREE_CREATED"],
  "route_candidate": {
    "primary_route": "KNOWLEDGE_UPDATE",
    "evidence_refs": ["decision:retire-legacy-approval"],
    "knowledge_effect_refs": ["fact:legacy-approval"]
  },
  "proposed_artifact_kind": "feedback",
  "prd_creation_origin": null,
  "human_gate_satisfied": true,
  "expected_cleanup": "NOT_APPLICABLE",
  "expected_archive_reads": 0
}
```

Extend the closed behavior vocabulary with `feedback` and `BUSINESS_DISPOSITION_CONFIRMATION`. Special-case only the combination `KNOWLEDGE_UPDATE + feedback + confirmed business disposition`: it permits one Feedback source record, produces no closure candidate, creates no owner, and leaves cleanup outside delivery. All other knowledge-only scenarios still permit no delivery asset.

- [ ] **Step 3: Run the Skill and behavior tests and verify failure**

Run: `node --test tests/skills/maintain-project-knowledge.test.mjs tests/skills/run-prd-lifecycle.test.mjs tests/delivery/end-to-end.test.mjs`

Expected: FAIL on missing prose contracts and the unsupported Feedback-only behavior case.

- [ ] **Step 4: Update the existing focused references**

Add these exact semantic rules without introducing another reference file:

```text
During bootstrap or maintenance, an explicitly confirmed business-to-implementation divergence keeps KNOWLEDGE_UPDATE as the controlling route. Capture one Feedback pair, synchronize the active projection, and return control to knowledge construction. Feedback captured is not PRD materialized and is not delivery started.
```

```text
Current knowledge may record the accepted business disposition only when it also states the verified implementation baseline and unresolved alignment limit. It must not claim implementation or runtime removal before accepted delivery evidence.
```

```text
An alignment row exits only after every required linked owner has accepted closure, every corresponding Knowledge Diff or no-change result is resolved, Feedback coverage is disposed, and canonical knowledge represents the final state.
```

Document initial-bootstrap batch review, later-maintenance batch review, immediate user-request routing, high-risk immediate attention, semantic reuse of existing Feedback, and `NEEDS_USER` on uncertain equivalence.

- [ ] **Step 5: Implement the narrow behavior exception**

```js
const feedbackOnlyCapture = scenario.expected_primary_route === 'KNOWLEDGE_UPDATE'
  && scenario.proposed_artifact_kind === 'feedback'
  && scenario.required_human_gate === 'BUSINESS_DISPOSITION_CONFIRMATION'
  && scenario.human_gate_satisfied;

if (feedbackOnlyCapture) {
  durableKinds = ['feedback'];
  closure = 'OUTSIDE_DELIVERY';
}
```

Assert the result has `current_knowledge_written: false`, `knowledge_candidate_owner: null`, `cleanup: 'NOT_APPLICABLE'`, and no `prd` or `non-prd-delivery` file.

- [ ] **Step 6: Run Skill and behavior tests**

Run: `node --test tests/skills/maintain-project-knowledge.test.mjs tests/skills/run-prd-lifecycle.test.mjs tests/delivery/end-to-end.test.mjs`

Expected: PASS; reference counts and route vocabulary tests remain unchanged.

- [ ] **Step 7: Commit Skill and behavior integration**

```bash
git add skills/maintain-project-knowledge/references/bootstrap-and-calibration.md skills/maintain-project-knowledge/references/materialization.md skills/run-prd-lifecycle/references/feedback-and-prd-boundaries.md skills/run-prd-lifecycle/references/delivery-assets.md skills/run-prd-lifecycle/references/closure-and-retention.md tests/skills/maintain-project-knowledge.test.mjs tests/skills/run-prd-lifecycle.test.mjs tests/behavior/delivery/scenarios.json tests/behavior/delivery/invariants.mjs tests/delivery/end-to-end.test.mjs
git commit -m "feat: defer delivery during knowledge alignment"
```

---

### Task 7: Run the complete release gate and settle implementation documentation

**Files:**
- Modify if generated by build: `dist/project-lifecycle.mjs`
- Modify: `docs/superpowers/specs/2026-08-12-knowledge-alignment-feedback-design.md` only if implementation reveals a true contract correction
- Modify: `docs/superpowers/specs/2026-08-12-knowledge-alignment-feedback-design.zh-CN.md` atomically with any English contract correction

**Interfaces:**
- Consumes: all Task 1-6 commits.
- Produces: one clean, self-contained branch with passing repository checks and an installed runtime that works without repository `node_modules`.

- [ ] **Step 1: Restore declared dependencies without changing versions**

Run: `npm ci`

Expected: installs the exact `package-lock.json` graph, including `mdast-util-from-markdown@2.0.3`; no manifest or lockfile diff.

- [ ] **Step 2: Run the focused regression suite**

Run:

```bash
node --test \
  tests/delivery/alignment-marker.test.mjs \
  tests/delivery/alignment-review.test.mjs \
  tests/delivery/assets.test.mjs \
  tests/delivery/closure.test.mjs \
  tests/knowledge/indexes.test.mjs \
  tests/cli/alignment.test.mjs \
  tests/cli/help.test.mjs \
  tests/skills/maintain-project-knowledge.test.mjs \
  tests/skills/run-prd-lifecycle.test.mjs \
  tests/delivery/end-to-end.test.mjs
```

Expected: PASS with zero skipped or cancelled tests.

- [ ] **Step 3: Run structural, fixture, privacy, and bundle gates**

Run: `git diff --check`

Expected: no output.

Run: `npm run validate:fixtures`

Expected: JSON envelope with `"ok":true`.

Run: `npm run check:privacy`

Expected: JSON envelope with `"ok":true` and no findings.

Run: `npm run check:bundle`

Expected: build succeeds and the clean copied installed runtime passes without `node_modules`.

- [ ] **Step 4: Run the complete repository test gate**

Run: `npm run check`

Expected: all tests, fixtures, and privacy checks pass. Do not accept the prior checkout's `ERR_MODULE_NOT_FOUND`; `npm ci` must have restored the declared dependency first.

- [ ] **Step 5: Self-review the final diff against the approved design**

Run:

```bash
rg -n "T[B]D|T[O]DO|F[I]XME|COMPLETED|alignment_phase|owner_ref|pending-changes" \
  scripts skills tests docs/superpowers/specs/2026-08-12-knowledge-alignment-feedback-design*.md
git diff --stat origin/develop...HEAD
git diff --check origin/develop...HEAD
```

Expected: no placeholders; no `COMPLETED` projection phase; every row schema has exactly five fields; no remediation backlog added to `pending-changes.json`; only task-scoped files changed.

- [ ] **Step 6: Commit any final generated bundle or paired contract correction**

```bash
git add dist/project-lifecycle.mjs docs/superpowers/specs/2026-08-12-knowledge-alignment-feedback-design.md docs/superpowers/specs/2026-08-12-knowledge-alignment-feedback-design.zh-CN.md
git diff --cached --quiet || git commit -m "build: finalize alignment feedback runtime"
```

- [ ] **Step 7: Stop before push and run the repository review workflow**

Run Codex built-in review on `origin/develop...HEAD`. If review finds valid issues, fix them surgically, rerun the focused suite and `npm run check`, and commit the remediation. Run Codex Security only if the final diff touches local file access, CLI write boundaries, or another security-sensitive surface; this plan does touch bounded local-file writes, so use the narrowest diff-scoped security review before any push.

Expected: no unresolved blocking review or security findings. Do not push unless the user separately asks for it.
