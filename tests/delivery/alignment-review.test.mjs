import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveAlignmentReview,
  renderAlignmentReviewPair,
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
  outcome: { status: accepted ? 'ACCEPTED' : 'REJECTED' },
  acceptance: { claimed: accepted },
  feedback_coverage: feedbackIds.map((feedbackId) => ({
    feedback_id: feedbackId,
    status: accepted ? 'COVERED' : 'NOT_COVERED',
  })),
  knowledge_handoff: { diff_id: `diff-${ownerId}`, outcome: 'CHANGE' },
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

test('returns rejected or cancelled ownership to review when no active owner remains', () => {
  const result = deriveAlignmentReview({
    feedbacks: [feedback('feedback-rejected')],
    owners: [owner('prd-rejected', ['feedback-rejected'])],
    closures: [closure('prd-rejected', ['feedback-rejected'], false)],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.rows[0], row('feedback-rejected', 'REVIEW_REQUIRED'));
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
