import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { atomicWriteValidated } from '../../scripts/lib/atomic-write.mjs';
import {
  deriveAlignmentReview,
  renderAlignmentReviewPair,
  syncAlignmentReview,
} from '../../scripts/delivery/alignment-review.mjs';

const marker = (routing_disposition = undefined) => ({
  schema_version: 1,
  classification: 'BUSINESS_IMPLEMENTATION_DIVERGENCE',
  primary_domain_id: 'approval-flow',
  ...(routing_disposition ? { routing_disposition } : {}),
});

const feedback = (id, overrides = {}) => ({
  frontmatter: {
    schema_version: 1,
    artifact_id: id,
    artifact_kind: 'feedback',
    primary_route: 'KNOWLEDGE_UPDATE',
    project_id_at_creation: 'sample-project',
    current_project_id: 'sample-project',
    domain_ids: ['approval-flow'],
    knowledge_baseline: 'baseline-7',
    relationships: { feedback_ids: [], prd_ids: [], legacy_artifact_refs: [] },
    retention_tier: 'active',
    reclassified_from_refs: [],
    obligations: [],
  },
  marker: marker(),
  titles: { en: `Alignment ${id}`, 'zh-CN': `对齐 ${id}` },
  ...overrides,
});

const owner = (id, feedbackIds, overrides = {}) => ({
  schema_version: 1,
  artifact_id: id,
  artifact_kind: 'prd',
  primary_route: 'PRD_DELIVERY',
  project_id_at_creation: 'sample-project',
  current_project_id: 'sample-project',
  domain_ids: ['approval-flow'],
  knowledge_baseline: 'baseline-7',
  relationships: { feedback_ids: feedbackIds, prd_ids: [], legacy_artifact_refs: [] },
  retention_tier: 'active',
  reclassified_from_refs: [],
  obligations: [],
  ...overrides,
});

const closure = (ownerId, feedbackIds, accepted = true) => ({
  artifact_id: `closure-${ownerId}`,
  owner_artifact_id: ownerId,
  outcome: {
    status: accepted ? 'ACCEPTED' : 'REJECTED',
    ref: `outcome:${ownerId}`,
    residual_risk_refs: [],
  },
  verification: { status: accepted ? 'PASSED' : 'FAILED', ref: `verification:${ownerId}` },
  acceptance: {
    claimed: accepted,
    units: accepted
      ? [{ unit_id: 'remediation', status: 'ACCEPTED', evidence_refs: [`test:${ownerId}`] }]
      : [],
  },
  feedback_coverage: feedbackIds.map((feedbackId) => ({
    feedback_id: feedbackId,
    status: accepted ? 'COVERED' : 'NOT_COVERED',
    covering_prd_ids: [ownerId],
    evidence_refs: [`outcome:${ownerId}`],
    remaining_criteria: accepted ? [] : ['Delivery was not accepted.'],
  })),
  obligation_outcomes: [],
  conflict_disposition: { status: 'NOT_APPLICABLE', ref: `conflict:${ownerId}` },
  baseline: { starting: 'baseline-7', current: 'baseline-7' },
  knowledge_handoff: {
    diff_id: `diff-${ownerId}`,
    outcome: 'CHANGE',
    owner: 'run-prd-lifecycle',
    apply_authority: 'maintain-project-knowledge',
  },
  evidence_refs: [`verification:${ownerId}`],
  closure_ref: `outcome:${ownerId}`,
});

const row = (feedbackId, alignmentPhase, ownerRef = []) => ({
  feedback_id: feedbackId,
  title: { en: `Alignment ${feedbackId}`, 'zh-CN': `对齐 ${feedbackId}` },
  primary_domain_id: 'approval-flow',
  alignment_phase: alignmentPhase,
  owner_ref: ownerRef,
});

test('derives all four active phases from Feedback, owners, and accepted closure coverage', () => {
  const feedbacks = [
    feedback('feedback-deferred', { marker: marker('DEFERRED') }),
    feedback('feedback-delivering'),
    feedback('feedback-review'),
    feedback('feedback-writeback'),
  ];
  const owners = [
    owner('prd-backend', ['feedback-delivering']),
    owner('prd-frontend', ['feedback-delivering']),
    owner('prd-retirement', ['feedback-writeback']),
  ];
  const result = deriveAlignmentReview({
    feedbacks,
    owners,
    closures: [closure('prd-backend', ['feedback-delivering']), closure('prd-retirement', ['feedback-writeback'])],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.rows, [
    row('feedback-deferred', 'DEFERRED'),
    row('feedback-delivering', 'DELIVERY_OPEN', ['prd-backend', 'prd-frontend']),
    row('feedback-review', 'REVIEW_REQUIRED'),
    row('feedback-writeback', 'KNOWLEDGE_WRITEBACK', ['prd-retirement']),
  ]);
  for (const item of result.value.rows) {
    assert.deepEqual(Object.keys(item).sort(), ['alignment_phase', 'feedback_id', 'owner_ref', 'primary_domain_id', 'title']);
  }
});

test('does not advance multiple owners by comparing closure counts alone', () => {
  const result = deriveAlignmentReview({
    feedbacks: [feedback('feedback-multi-owner')],
    owners: [owner('prd-a', ['feedback-multi-owner']), owner('prd-b', ['feedback-multi-owner'])],
    closures: [closure('prd-a', ['feedback-multi-owner']), closure('prd-unrelated', ['feedback-multi-owner'])],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.rows[0].alignment_phase, 'DELIVERY_OPEN');
});

test('rejects an accepted-looking object that is not a validated closure summary', () => {
  const result = deriveAlignmentReview({
    feedbacks: [feedback('feedback-fake-closure')],
    owners: [owner('prd-fake', ['feedback-fake-closure'])],
    closures: [{
      artifact_id: 'closure-prd-fake',
      owner_artifact_id: 'prd-fake',
      outcome: { status: 'ACCEPTED' },
      acceptance: { claimed: true },
      feedback_coverage: [{ feedback_id: 'feedback-fake-closure', status: 'COVERED' }],
    }],
  });
  assert.equal(result.errors[0].code, 'ALIGNMENT_REVIEW_INPUT_INVALID');
  assert.equal(result.errors[0].path, '/closures/0');
});

test('returns rejected or cancelled ownership to review when no active owner remains', () => {
  const result = deriveAlignmentReview({
    feedbacks: [feedback('feedback-rejected')],
    owners: [owner('prd-rejected', ['feedback-rejected'])],
    closures: [closure('prd-rejected', ['feedback-rejected'], false)],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.rows[0], row('feedback-rejected', 'REVIEW_REQUIRED'));
});

test('rejects a terminal owner closure that omits its linked Feedback coverage', () => {
  const result = deriveAlignmentReview({
    feedbacks: [feedback('feedback-unbound-rejection')],
    owners: [owner('prd-unbound-rejection', ['feedback-unbound-rejection'])],
    closures: [closure('prd-unbound-rejection', [], false)],
  });
  assert.equal(result.errors[0].code, 'ALIGNMENT_REVIEW_INPUT_INVALID');
  assert.equal(result.errors[0].path, '/closures/prd-unbound-rejection');
});

test('renders localized titles and identical machine columns in the generated pair', () => {
  const review = deriveAlignmentReview({ feedbacks: [feedback('feedback-title', {
    titles: { en: 'Retire | legacy approval', 'zh-CN': '废弃 | 旧审批' },
  })] });
  assert.equal(review.ok, true);
  const rendered = renderAlignmentReviewPair(review.value);
  assert.match(rendered.en, /Retire \\| legacy approval/u);
  assert.match(rendered['zh-CN'], /废弃 \\| 旧审批/u);
  assert.match(rendered.en, /`feedback-title`.*`approval-flow`.*`REVIEW_REQUIRED`.*- \|$/mu);
  assert.doesNotMatch(rendered.en, /evidence|history|reasoning|code_path/iu);
});

test('renders only active rows when hundreds of completed Feedback records exist', () => {
  const completed = Array.from({ length: 500 }, (_, index) => feedback(`feedback-closed-${index}`, { marker: null }));
  const active = ['a', 'b', 'c'].map((suffix) => feedback(`feedback-open-${suffix}`));
  const result = deriveAlignmentReview({ feedbacks: [...completed, ...active] });
  assert.equal(result.ok, true);
  assert.equal(result.value.rows.length, 3);
  assert.doesNotMatch(JSON.stringify(result.value), /evidence_refs|risk|history|reasoning|code_path/iu);
});

test('publishes and removes the bilingual generated projection as one pair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-alignment-review-'));
  await mkdir(join(root, 'docs', 'project-lifecycle', 'delivery'), { recursive: true });
  const active = { root, feedbacks: [feedback('feedback-active')], owners: [], closures: [] };
  const published = await syncAlignmentReview(active);
  assert.equal(published.ok, true);
  assert.deepEqual(published.value.locators, {
    en: 'delivery/alignment-review-en.md',
    'zh-CN': 'delivery/alignment-review.md',
  });
  assert.match(await readFile(join(root, 'docs', 'project-lifecycle', published.value.locators.en), 'utf8'), /feedback-active/u);

  const removed = await syncAlignmentReview({ root, feedbacks: [], owners: [], closures: [] });
  assert.equal(removed.ok, true);
  assert.deepEqual(await readdir(join(root, 'docs', 'project-lifecycle', 'delivery')), []);
});

test('refuses to overwrite or remove a non-generated asset at the projection locators', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-alignment-collision-'));
  const delivery = join(root, 'docs', 'project-lifecycle', 'delivery');
  await mkdir(delivery, { recursive: true });
  const originals = {
    en: '---\nartifact_id: alignment-review\n---\nExisting English asset.\n',
    'zh-CN': '---\nartifact_id: alignment-review\n---\n现有中文资产。\n',
  };
  await writeFile(join(delivery, 'alignment-review-en.md'), originals.en);
  await writeFile(join(delivery, 'alignment-review.md'), originals['zh-CN']);

  for (const feedbacks of [[feedback('feedback-active')], []]) {
    const result = await syncAlignmentReview({ root, feedbacks, owners: [], closures: [] });
    assert.equal(result.errors[0].code, 'ALIGNMENT_REVIEW_COLLISION');
    assert.equal(await readFile(join(delivery, 'alignment-review-en.md'), 'utf8'), originals.en);
    assert.equal(await readFile(join(delivery, 'alignment-review.md'), 'utf8'), originals['zh-CN']);
  }
});

test('restores the prior English projection when the Chinese write fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-alignment-rollback-'));
  await mkdir(join(root, 'docs', 'project-lifecycle', 'delivery'), { recursive: true });
  const initial = { root, feedbacks: [feedback('feedback-active')], owners: [], closures: [] };
  assert.equal((await syncAlignmentReview(initial)).ok, true);
  const path = join(root, 'docs', 'project-lifecycle', 'delivery', 'alignment-review-en.md');
  const original = await readFile(path, 'utf8');
  let writes = 0;
  const failed = await syncAlignmentReview({
    ...initial,
    feedbacks: [feedback('feedback-active', { titles: { en: 'Changed', 'zh-CN': '已更改' } })],
  }, {
    atomicWriteValidated: async (options) => {
      writes += 1;
      if (writes === 2) throw new Error('injected Chinese write failure');
      return atomicWriteValidated(options);
    },
  });
  assert.equal(failed.errors[0].code, 'ALIGNMENT_REVIEW_WRITE_FAILED');
  assert.equal(await readFile(path, 'utf8'), original);
});

test('reports manual recovery when the second write and rollback both fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-alignment-recovery-'));
  await mkdir(join(root, 'docs', 'project-lifecycle', 'delivery'), { recursive: true });
  const initial = { root, feedbacks: [feedback('feedback-active')], owners: [], closures: [] };
  assert.equal((await syncAlignmentReview(initial)).ok, true);
  let writes = 0;
  const failed = await syncAlignmentReview({
    ...initial,
    feedbacks: [feedback('feedback-active', { titles: { en: 'Changed', 'zh-CN': '已更改' } })],
  }, {
    atomicWriteValidated: async (options) => {
      writes += 1;
      if (writes >= 2) throw new Error('injected publication and recovery failure');
      return atomicWriteValidated(options);
    },
  });
  assert.equal(failed.errors[0].code, 'ALIGNMENT_REVIEW_RECOVERY_REQUIRED');
  assert.match(failed.errors[0].message, /manual recovery/iu);
});
