import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { materializeDeliveryWithIndexes, previewDeliveryAsset } from '../../scripts/delivery/delivery-workflow.mjs';
import { publishDeliveryIndexes } from '../../scripts/delivery/publish-delivery-indexes.mjs';
import { deliveryLayoutContent } from '../../scripts/delivery/delivery-layout.mjs';
import { parseRestrictedYaml } from '../../scripts/lib/markdown.mjs';
import { inspectLifecycleTree } from '../../scripts/knowledge/layout-transaction.mjs';

const fixture = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-retry-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/project-lifecycle/delivery'), { recursive: true });
  await writeFile(join(root, 'docs/project-lifecycle/delivery/layout.json'), deliveryLayoutContent());
  const source = await readFile(new URL('../../skills/run-prd-lifecycle/assets/prd-en.md', import.meta.url), 'utf8');
  const end = source.indexOf('\n---\n', 4);
  return { root, frontmatter: parseRestrictedYaml(source.slice(4, end), '/').value,
    body: { en: '# Product\n', 'zh-CN': '# 产品\n' }, reason: 'Retry proof', creation_origin: 'explicit_user' };
};

test('reports saved assets on index publication failure and retries without recreating documents', async (context) => {
  const input = await fixture(context);
  const occupiedIndex = join(input.root, 'docs/project-lifecycle/delivery/INDEX.md');
  const partial = await materializeDeliveryWithIndexes(input, {
    publishDeliveryIndexes: async ({ root }) => {
      // Model another writer occupying the index after preview and pair publication.
      await writeFile(occupiedIndex, '# Manual navigation\n');
      return publishDeliveryIndexes({ root });
    },
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.context.asset_saved, true);
  assert.equal(partial.context.asset_changed, true);
  assert.equal(partial.context.indexes, 'failed');
  assert.equal(partial.context.files_changed, true);
  assert.equal(partial.errors[0].code, 'DELIVERY_INDEX_OCCUPIED');
  const path = join(input.root, 'docs/project-lifecycle', partial.context.locators.en);
  const saved = await readFile(path, 'utf8');
  await rm(occupiedIndex);
  const retry = await materializeDeliveryWithIndexes(input);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.value.status, 'unchanged');
  assert.equal(retry.value.indexes, 'updated');
  assert.equal(await readFile(path, 'utf8'), saved);
});

test('preview fails without writes on a missing physical owner or invalid request', async (context) => {
  const input = await fixture(context);
  const before = await inspectLifecycleTree({ repositoryRoot: input.root });
  input.frontmatter.artifact_kind = 'architecture';
  input.frontmatter.artifact_id = 'architecture-missing-owner';
  input.changed_contract_ref = 'decision:boundary';
  const result = await previewDeliveryAsset(input);
  assert.equal(result.ok, false);
  assert.equal(result.context.files_changed, false);
  assert.equal(result.errors[0].code, 'DELIVERY_OWNER_MISMATCH');
  assert.deepEqual(await inspectLifecycleTree({ repositoryRoot: input.root }), before);
});
