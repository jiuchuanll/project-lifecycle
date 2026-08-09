import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cleanupPrdRuntime } from '../../scripts/delivery/cleanup-runtime.mjs';
import { writeContextReceipt } from '../../scripts/delivery/context-receipt.mjs';

const fixtureUrl = new URL('../fixtures/delivery/context-receipt/selection.json', import.meta.url);
const prdId = 'prd-wiki-layout-v2';
const withRoot = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-cleanup-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
};
const createReceipt = async (root, id = prdId) => writeContextReceipt({
  root,
  writer: 'run-prd-lifecycle',
  prd_id: id,
  selection: JSON.parse(await readFile(fixtureUrl, 'utf8')),
}, { now: () => '2026-08-09T08:00:00.000Z' });
const closure = (overrides = {}) => ({
  owner_status: 'CLOSED',
  closure_ref: 'closure:prd-wiki-layout-v2',
  verification_result_ref: 'test-report:prd-wiki-layout-v2',
  knowledge_handoff: { kind: 'NO_CHANGE', ref: 'knowledge-diff:no-change-wiki-layout' },
  conflict_disposition_ref: 'conflict:none',
  ...overrides,
});

test('refuses cleanup for an active PRD or incomplete durable closure', async (context) => {
  const root = await withRoot(context);
  await createReceipt(root);
  const active = await cleanupPrdRuntime({ root, prd_id: prdId, closure: closure({ owner_status: 'ACTIVE' }) });
  assert.equal(active.errors[0].code, 'PRD_RUNTIME_ACTIVE');
  const incomplete = await cleanupPrdRuntime({ root, prd_id: prdId, closure: { owner_status: 'CLOSED' } });
  assert.equal(incomplete.errors[0].code, 'CLEANUP_PREREQUISITE_MISSING');
});

test('removes only the exact receipt and its empty PRD directory', async (context) => {
  const root = await withRoot(context);
  await createReceipt(root);
  await createReceipt(root, 'prd-source-search-v1');
  const result = await cleanupPrdRuntime({ root, prd_id: prdId, closure: closure() });
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'cleaned');
  assert.deepEqual(await readdir(join(root, '.project-lifecycle', 'runtime', 'prds')), ['prd-source-search-v1']);
});

test('rejects traversal IDs and a symlinked PRD runtime directory without touching the target', async (context) => {
  const root = await withRoot(context);
  const traversal = await cleanupPrdRuntime({ root, prd_id: '../../', closure: closure() });
  assert.equal(traversal.errors[0].code, 'PRD_ID_INVALID');

  const outside = await mkdtemp(join(tmpdir(), 'project-lifecycle-cleanup-outside-'));
  context.after(() => rm(outside, { force: true, recursive: true }));
  const prds = join(root, '.project-lifecycle', 'runtime', 'prds');
  await mkdir(prds, { recursive: true });
  await symlink(outside, join(prds, prdId));
  const escaped = await cleanupPrdRuntime({ root, prd_id: prdId, closure: closure() });
  assert.equal(escaped.errors[0].code, 'PRD_RUNTIME_PATH_INVALID');
  assert.deepEqual(await readdir(outside), []);
});

test('is immediately retryable after successful cleanup', async (context) => {
  const root = await withRoot(context);
  await createReceipt(root);
  assert.equal((await cleanupPrdRuntime({ root, prd_id: prdId, closure: closure() })).ok, true);
  const repeated = await cleanupPrdRuntime({ root, prd_id: prdId, closure: closure() });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.value.status, 'already-clean');
});

test('retains only a cleanup_pending directory when empty-directory removal fails twice', async (context) => {
  const root = await withRoot(context);
  await createReceipt(root);
  let attempts = 0;
  const result = await cleanupPrdRuntime({ root, prd_id: prdId, closure: closure() }, {
    removeDirectory: async () => {
      attempts += 1;
      throw Object.assign(new Error('injected rmdir failure'), { code: 'EIO' });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CLEANUP_PENDING');
  assert.equal(attempts, 2);
  const directory = join(root, '.project-lifecycle', 'runtime', 'prds', prdId);
  assert.deepEqual(await readdir(directory), ['cleanup_pending']);
  assert.equal((await lstat(join(directory, 'cleanup_pending'))).isDirectory(), true);
});

test('treats a no-op directory remover as cleanup pending rather than success', async (context) => {
  const root = await withRoot(context);
  await createReceipt(root);
  const result = await cleanupPrdRuntime({ root, prd_id: prdId, closure: closure() }, {
    removeDirectory: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CLEANUP_PENDING');
  assert.deepEqual(
    await readdir(join(root, '.project-lifecycle', 'runtime', 'prds', prdId)),
    ['cleanup_pending'],
  );
});
