import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateJson } from '../../scripts/lib/validate-json.mjs';

const fixture = async (name) => JSON.parse(
  await readFile(new URL(`../fixtures/contracts/handoffs/${name}`, import.meta.url), 'utf8'),
);

for (const [kind, name] of [
  ['context-receipt', 'context-receipt.valid.json'],
  ['knowledge-diff', 'knowledge-diff.valid.json'],
  ['knowledge-diff', 'knowledge-diff.no-change.valid.json'],
  ['archive-access-receipt', 'archive-access-receipt.valid.json'],
  ['delivery-frontmatter', 'delivery-frontmatter.valid.json'],
]) {
  test(`accepts valid ${kind} fixture ${name}`, async () => {
    assert.equal(validateJson(kind, await fixture(name)).ok, true);
  });
}

test('rejects unknown Context Receipt vocabulary', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.selected_context[0].reason = 'EVERYTHING';

  const result = validateJson('context-receipt', receipt);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(({ path }) => path === '/selected_context/0/reason'));
});

test('rejects duplicate Context Receipt IDs even when selection fields differ', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.selected_context.push({ ...receipt.selected_context[0], reason: 'VALIDATION' });

  const result = validateJson('context-receipt', receipt);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'ID_DUPLICATE' && path === '/selected_context/1/id'
  )));
});

test('routes exact duplicate Context Receipt selections to the deterministic ID error', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.selected_context.push({ ...receipt.selected_context[0] });

  const result = validateJson('context-receipt', receipt);

  assert.deepEqual(result.errors[0], {
    code: 'ID_DUPLICATE',
    path: '/selected_context/1/id',
    message: 'Duplicate selected context ID: fact-wiki-layout-model',
  });
});

test('rejects Context Receipt selections that are not ID-sorted', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.selected_context = [
    { ...receipt.selected_context[0], id: 'zeta-context' },
    { ...receipt.selected_context[0], id: 'alpha-context' },
  ];

  const result = validateJson('context-receipt', receipt);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/selected_context/1/id'
  )));
});

test('rejects a sufficient Context Receipt with unresolved questions', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.open_questions.push('Which density preset is authoritative?');

  const result = validateJson('context-receipt', receipt);

  assert.ok(result.errors.some(({ path }) => path === '/stop/code'));
});

test('requires NO_CHANGE to have no operations and retained evidence', async () => {
  const diff = await fixture('knowledge-diff.no-change.valid.json');
  diff.operations.push({
    kind: 'ADD',
    fact_id: 'fact-new-layout-rule',
    owner_domain_id: 'wiki-workspace',
    evidence_refs: ['test-report-copy-fix'],
  });
  diff.evidence_refs = [];

  const result = validateJson('knowledge-diff', diff);

  assert.ok(result.errors.some(({ path }) => path === '/operations'));
  assert.ok(result.errors.some(({ path }) => path === '/evidence_refs'));
});

test('rejects archive globs and unbounded artifact sets', async () => {
  const receipt = await fixture('archive-access-receipt.valid.json');
  receipt.artifact_ids = Array.from({ length: 21 }, (_, index) => (
    index === 0 ? 'archive-*' : `archived-artifact-${index}`
  ));

  const result = validateJson('archive-access-receipt', receipt);

  assert.ok(result.errors.some(({ path }) => path === '/artifact_ids'));
  assert.ok(result.errors.some(({ path }) => path === '/artifact_ids/0'));
});

test('rejects NEEDS_USER as a durable primary route', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.primary_route = 'NEEDS_USER';

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ path }) => path === '/primary_route'));
});

test('requires current_project_id only for active delivery', async () => {
  const active = await fixture('delivery-frontmatter.valid.json');
  delete active.current_project_id;
  const archived = { ...active, retention_tier: 'archive' };

  assert.ok(validateJson('delivery-frontmatter', active).errors.some(
    ({ path }) => path === '/current_project_id',
  ));
  assert.equal(validateJson('delivery-frontmatter', archived).ok, true);
});

test('keeps obligations owner-local and rejects a global obligation owner field', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.obligations[0].owner_ref = 'global-obligations';

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ path }) => path === '/obligations/0/owner_ref'));
});

test('rejects duplicate owner-local obligation IDs even when instance fields differ', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.obligations.push({
    ...frontmatter.obligations[0],
    responsible_refs: ['prd-another-owner'],
  });

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'ID_DUPLICATE' && path === '/obligations/1/obligation_id'
  )));
});

test('routes exact duplicate owner-local obligations to the deterministic ID error', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.obligations.push({ ...frontmatter.obligations[0] });

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.deepEqual(result.errors[0], {
    code: 'ID_DUPLICATE',
    path: '/obligations/1/obligation_id',
    message: 'Duplicate obligation ID: layout-dependency',
  });
});

test('rejects duplicate cross-reference IDs in delivery relationships', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.relationships.feedback_ids.push('feedback-wiki-density');

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ path }) => path === '/relationships/feedback_ids'));
});

test('rejects cross-reference IDs in the wrong typed relationship', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.relationships.feedback_ids = ['prd-wiki-layout-v1'];
  frontmatter.relationships.prd_ids = ['feedback-wiki-density'];

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ path }) => path === '/relationships/feedback_ids/0'));
  assert.ok(result.errors.some(({ path }) => path === '/relationships/prd_ids/0'));
});
