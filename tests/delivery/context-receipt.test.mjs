import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readContextReceipt, writeContextReceipt } from '../../scripts/delivery/context-receipt.mjs';
import { validateJson } from '../../scripts/lib/validate-json.mjs';

const fixtureUrl = new URL('../fixtures/delivery/context-receipt/selection.json', import.meta.url);
const prdId = 'prd-wiki-layout-v2';

const withRoot = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-receipt-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
};

const selection = async (overrides = {}) => ({
  ...JSON.parse(await readFile(fixtureUrl, 'utf8')),
  ...overrides,
});

const input = async (root, overrides = {}) => ({
  root,
  writer: 'run-prd-lifecycle',
  prd_id: prdId,
  selection: await selection(),
  ...overrides,
});

test('creates one validated revision-1 receipt snapshot at the exact runtime path', async (context) => {
  const root = await withRoot(context);
  const result = await writeContextReceipt(await input(root), { now: () => '2026-08-09T08:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'created');
  assert.equal(result.value.receipt.receipt_revision, 1);
  assert.equal(validateJson('context-receipt', result.value.receipt).ok, true);
  assert.equal(result.value.locator, '.project-lifecycle/runtime/prds/prd-wiki-layout-v2/context-receipt.json');
  const files = await readFile(join(root, result.value.locator), 'utf8');
  assert.deepEqual(JSON.parse(files), result.value.receipt);
});

test('refreshes exactly one revision and sorts and deduplicates selection identifiers', async (context) => {
  const root = await withRoot(context);
  const first = await writeContextReceipt(await input(root), { now: () => '2026-08-09T08:00:00.000Z' });
  const refreshed = await writeContextReceipt(await input(root), { now: () => '2026-08-09T09:00:00.000Z' });
  assert.equal(first.ok, true);
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.value.receipt.receipt_revision, 2);
  assert.deepEqual(refreshed.value.receipt.route.affected_domain_ids, ['desktop-shell', 'wiki-workspace']);
  assert.deepEqual(
    refreshed.value.receipt.selected_context.map(({ id }) => id),
    ['desktop-shell-constraint', 'fact-wiki-layout'],
  );
});

test('rejects any writer other than the PRD lifecycle coordinator', async (context) => {
  const root = await withRoot(context);
  const result = await writeContextReceipt(await input(root, { writer: 'parallel-worker' }));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CONTEXT_WRITER_FORBIDDEN');
});

test('reports an old snapshot stale when the accepted knowledge baseline has changed', async (context) => {
  const root = await withRoot(context);
  await writeContextReceipt(await input(root), { now: () => '2026-08-09T08:00:00.000Z' });
  const stale = await readContextReceipt({
    root,
    prd_id: prdId,
    expected_knowledge_baseline: 'baseline-8',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.errors[0].code, 'CONTEXT_RECEIPT_STALE');

  const fresh = await writeContextReceipt(await input(root, {
    selection: await selection({ knowledge_baseline: 'baseline-8' }),
  }), { now: () => '2026-08-09T09:00:00.000Z' });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.value.receipt.knowledge_baseline, 'baseline-8');
});

test('regenerates a malformed runtime receipt from accepted selection inputs', async (context) => {
  const root = await withRoot(context);
  const directory = join(root, '.project-lifecycle', 'runtime', 'prds', prdId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'context-receipt.json'), '{malformed');

  const result = await writeContextReceipt(await input(root), { now: () => '2026-08-09T08:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'regenerated');
  assert.equal(result.value.receipt.receipt_revision, 1);
});

test('keeps the last valid snapshot when an atomic refresh fails', async (context) => {
  const root = await withRoot(context);
  const first = await writeContextReceipt(await input(root), { now: () => '2026-08-09T08:00:00.000Z' });
  const failed = await writeContextReceipt(await input(root, {
    selection: await selection({ intent_summary: 'Updated intent' }),
  }), {
    now: () => '2026-08-09T09:00:00.000Z',
    atomicWriteValidated: async () => { throw new Error('injected refresh failure'); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.errors[0].code, 'CONTEXT_RECEIPT_WRITE_FAILED');
  const retained = JSON.parse(await readFile(join(root, first.value.locator), 'utf8'));
  assert.deepEqual(retained, first.value.receipt);
});

test('rejects a no-op writer instead of claiming a receipt was published', async (context) => {
  const root = await withRoot(context);
  const result = await writeContextReceipt(await input(root), {
    now: () => '2026-08-09T08:00:00.000Z',
    atomicWriteValidated: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CONTEXT_RECEIPT_WRITE_FAILED');
});

test('rejects conflicting duplicate selected IDs instead of silently choosing one', async (context) => {
  const root = await withRoot(context);
  const conflicting = await selection();
  conflicting.selected_context.push({
    kind: 'fact', id: 'fact-wiki-layout', version_ref: 'revision:3', reason: 'VALIDATION',
  });
  const result = await writeContextReceipt(await input(root, { selection: conflicting }));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CONTEXT_SELECTION_CONFLICT');
});
