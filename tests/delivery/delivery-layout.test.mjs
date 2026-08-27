import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DELIVERY_LAYOUT,
  activeDeliveryPair,
  alignmentReviewPair,
  archivedDeliveryPair,
  deliveryLayoutContent,
  detectDeliveryLayout,
  validatePhysicalOwner,
} from '../../scripts/delivery/delivery-layout.mjs';
import { validateJson } from '../../scripts/lib/validate-json.mjs';

const layoutAsset = new URL(
  '../../skills/maintain-project-knowledge/assets/delivery-layout.json',
  import.meta.url,
);

const rootFor = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-delivery-layout-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'project-lifecycle', 'delivery'), { recursive: true });
  return root;
};

test('derives every active and archived delivery locator from one physical owner', () => {
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
    const frontmatter = { artifact_kind, artifact_id, ...(owner_artifact_id ? { owner_artifact_id } : {}) };
    assert.equal(activeDeliveryPair(frontmatter, { ownerKind }).en, en);
    assert.equal(
      archivedDeliveryPair(frontmatter, { ownerKind }).en,
      en.replace(/^delivery\//u, 'archive/delivery/'),
    );
  }
  assert.deepEqual(alignmentReviewPair(), {
    en: 'delivery/views/alignment-review-en.md',
    'zh-CN': 'delivery/views/alignment-review.md',
  });
});

test('enforces independent Feedback and self-owned delivery roots', () => {
  assert.equal(validatePhysicalOwner({
    artifact_kind: 'feedback',
    artifact_id: 'feedback-density',
  }).ok, true);
  assert.equal(validatePhysicalOwner({
    artifact_kind: 'feedback',
    artifact_id: 'feedback-density',
    owner_artifact_id: 'prd-wiki-v1',
  }).errors[0].code, 'DELIVERY_OWNER_FORBIDDEN');
  assert.equal(validatePhysicalOwner({
    artifact_kind: 'batch',
    artifact_id: 'batch-wiki-v1',
  }).errors[0].code, 'DELIVERY_OWNER_REQUIRED');
  assert.equal(validatePhysicalOwner({
    artifact_kind: 'prd',
    artifact_id: 'prd-wiki-v1',
    owner_artifact_id: 'prd-other',
  }).errors[0].code, 'DELIVERY_OWNER_MISMATCH');
});

test('ships one valid canonical layout marker', async () => {
  const asset = JSON.parse(await readFile(layoutAsset, 'utf8'));

  assert.deepEqual(DELIVERY_LAYOUT, { schema_version: 1, layout_version: 2 });
  assert.deepEqual(asset, DELIVERY_LAYOUT);
  assert.equal(deliveryLayoutContent(), `${JSON.stringify(DELIVERY_LAYOUT, null, 2)}\n`);
  assert.equal(validateJson('delivery-layout', asset).ok, true);
});

test('detects empty, legacy-flat, v2, and mixed layouts without mutating them', async (context) => {
  const empty = await rootFor(context);
  assert.equal((await detectDeliveryLayout({ root: empty })).value.kind, 'EMPTY');

  const legacy = await rootFor(context);
  await writeFile(join(legacy, 'docs/project-lifecycle/delivery/prd-wiki-v1-en.md'), '# Legacy\n');
  assert.equal((await detectDeliveryLayout({ root: legacy })).value.kind, 'LEGACY_FLAT');

  const v2 = await rootFor(context);
  await mkdir(join(v2, 'docs/project-lifecycle/delivery/feedback'));
  await writeFile(join(v2, 'docs/project-lifecycle/delivery/layout.json'), deliveryLayoutContent());
  assert.equal((await detectDeliveryLayout({ root: v2 })).value.kind, 'V2');

  const mixed = await rootFor(context);
  await mkdir(join(mixed, 'docs/project-lifecycle/delivery/prds'));
  await writeFile(join(mixed, 'docs/project-lifecycle/delivery/layout.json'), deliveryLayoutContent());
  await writeFile(join(mixed, 'docs/project-lifecycle/delivery/prd-wiki-v1.md'), '# Mixed\n');
  assert.equal((await detectDeliveryLayout({ root: mixed })).value.kind, 'INVALID_MIXED');
});

test('rejects a symlinked delivery root before layout inspection', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-delivery-layout-project-'));
  const outside = await mkdtemp(join(tmpdir(), 'project-lifecycle-delivery-layout-outside-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'project-lifecycle'), { recursive: true });
  await symlink(outside, join(root, 'docs/project-lifecycle/delivery'));

  const result = await detectDeliveryLayout({ root });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'DELIVERY_LAYOUT_PATH_INVALID');
});
