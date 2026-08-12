import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAlignmentMarker,
  validateAlignmentExit,
  validateAlignmentFeedbackPair,
} from '../../scripts/delivery/alignment-marker.mjs';

const marker = ({ domain = 'approval-flow', disposition = null, extra = '' } = {}) => `<!-- project-lifecycle:alignment
schema_version: 1
classification: BUSINESS_IMPLEMENTATION_DIVERGENCE
primary_domain_id: ${domain}${disposition ? `\nrouting_disposition: ${disposition}` : ''}${extra}
-->`;

const body = ({ language = 'en', marking = marker(), title = null } = {}) => {
  const localized = language === 'en';
  return `# ${title ?? (localized ? 'Retire legacy approval' : '废弃旧审批')}

<!-- project-lifecycle:section original_problem -->
## ${localized ? 'Original problem' : '原始问题'}

${localized ? 'Legacy approval remains implemented.' : '旧审批仍有实现。'}
<!-- /project-lifecycle:section -->

<!-- project-lifecycle:section scenario -->
## ${localized ? 'Scenario' : '场景'}

${localized ? 'Knowledge bootstrap.' : '知识首次构建。'}
<!-- /project-lifecycle:section -->

<!-- project-lifecycle:section expectation -->
## ${localized ? 'Expectation' : '期望'}

${localized ? 'Track the divergence without starting delivery.' : '记录差异但不启动交付。'}
<!-- /project-lifecycle:section -->

<!-- project-lifecycle:section marking -->
## ${localized ? 'Marking' : '标记'}

${marking}
<!-- /project-lifecycle:section -->

<!-- project-lifecycle:section coverage -->
## ${localized ? 'Coverage' : '覆盖'}

${localized ? 'Open.' : '待处理。'}
<!-- /project-lifecycle:section -->
`;
};

const frontmatter = (domainIds = ['approval-flow']) => ({
  artifact_id: 'feedback-retire-legacy',
  artifact_kind: 'feedback',
  domain_ids: domainIds,
});

const pair = (overrides = {}) => ({
  frontmatter: frontmatter(overrides.domainIds),
  bodies: {
    en: body({ marking: overrides.enMarking ?? marker() }),
    'zh-CN': body({ language: 'zh-CN', marking: overrides.zhMarking ?? marker() }),
  },
});

test('parses one bounded business-to-implementation marker', () => {
  assert.deepEqual(extractAlignmentMarker(`## Marking\n\n${marker()}`, '/marking'), {
    ok: true,
    value: {
      schema_version: 1,
      classification: 'BUSINESS_IMPLEMENTATION_DIVERGENCE',
      primary_domain_id: 'approval-flow',
    },
    errors: [],
  });
  assert.deepEqual(extractAlignmentMarker(`## Marking\n\n${marker({ disposition: 'DEFERRED' })}`, '/marking').value, {
    schema_version: 1,
    classification: 'BUSINESS_IMPLEMENTATION_DIVERGENCE',
    primary_domain_id: 'approval-flow',
    routing_disposition: 'DEFERRED',
  });
});

test('keeps ordinary Feedback and fenced marker examples inactive', () => {
  assert.equal(extractAlignmentMarker('## Marking\n\nActive.', '/marking').value, null);
  assert.equal(extractAlignmentMarker(`## Marking\n\n\`\`\`text\n${marker()}\n\`\`\``, '/marking').value, null);
});

test('validates one identical marker against the Feedback domain set', () => {
  const result = validateAlignmentFeedbackPair(pair());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.marker, {
    schema_version: 1,
    classification: 'BUSINESS_IMPLEMENTATION_DIVERGENCE',
    primary_domain_id: 'approval-flow',
  });
  assert.equal(result.value.titles.en, 'Retire legacy approval');
  assert.equal(result.value.titles['zh-CN'], '废弃旧审批');
});

test('allows localized table delimiters in titles for escaped projection rendering', () => {
  const result = validateAlignmentFeedbackPair({
    frontmatter: frontmatter(),
    bodies: {
      en: body({ title: 'Retire | legacy approval' }),
      'zh-CN': body({ language: 'zh-CN', title: '废弃 | 旧审批' }),
    },
  });
  assert.equal(result.ok, true);
});

test('rejects duplicate and malformed markers with stable errors', () => {
  const duplicate = extractAlignmentMarker(`${marker()}\n${marker()}`, '/marking');
  assert.equal(duplicate.errors[0].code, 'ALIGNMENT_MARKER_DUPLICATE');

  const unknown = extractAlignmentMarker(marker({ extra: '\nowner_ref: prd-legacy' }), '/marking');
  assert.equal(unknown.errors[0].code, 'ALIGNMENT_MARKER_INVALID');

  const malformed = extractAlignmentMarker(marker().replace('schema_version: 1', 'schema_version: [1'), '/marking');
  assert.equal(malformed.errors[0].code, 'ALIGNMENT_MARKER_INVALID');
});

test('rejects one-language, divergent, and out-of-domain markers', () => {
  const oneLanguage = validateAlignmentFeedbackPair(pair({ zhMarking: 'Active.' }));
  assert.equal(oneLanguage.errors[0].code, 'ALIGNMENT_PAIR_MISMATCH');

  const divergent = validateAlignmentFeedbackPair(pair({ zhMarking: marker({ domain: 'wiki-workspace' }) }));
  assert.equal(divergent.errors[0].code, 'ALIGNMENT_PAIR_MISMATCH');

  const outOfDomain = validateAlignmentFeedbackPair(pair({ domainIds: ['wiki-workspace'] }));
  assert.equal(outOfDomain.errors[0].code, 'ALIGNMENT_DOMAIN_INVALID');
});

test('requires the complete accepted owner set and knowledge resolution before marker exit', () => {
  const owners = ['prd-backend', 'prd-frontend'].map((artifactId) => ({
    artifact_id: artifactId,
    relationships: { feedback_ids: ['feedback-retire-legacy'] },
  }));
  const closures = owners.map(({ artifact_id: ownerId }) => ({
    artifact_id: `closure-${ownerId}`,
    owner_artifact_id: ownerId,
    outcome: { status: 'ACCEPTED' },
    acceptance: { claimed: true },
    feedback_coverage: [{ feedback_id: 'feedback-retire-legacy', status: 'COVERED' }],
  }));
  const resolution = {
    schema_version: 1,
    feedback_id: 'feedback-retire-legacy',
    disposition: 'DELIVERY_ACCEPTED',
    owner_refs: ['prd-backend', 'prd-frontend'],
    closure_refs: ['closure-prd-backend', 'closure-prd-frontend'],
    knowledge_resolution_refs: ['knowledge-diff:backend-applied', 'knowledge-diff:frontend-applied'],
  };

  assert.equal(validateAlignmentExit({
    feedbackId: 'feedback-retire-legacy', resolution, owners, closures,
  }).ok, true);
  assert.equal(validateAlignmentExit({
    feedbackId: 'feedback-retire-legacy',
    resolution: { ...resolution, owner_refs: ['prd-backend'], closure_refs: ['closure-prd-backend'] },
    owners,
    closures,
  }).errors[0].code, 'ALIGNMENT_RESOLUTION_INCOMPLETE');
  assert.equal(validateAlignmentExit({
    feedbackId: 'feedback-retire-legacy',
    resolution: { ...resolution, knowledge_resolution_refs: [] },
    owners,
    closures,
  }).errors[0].code, 'ALIGNMENT_RESOLUTION_INVALID');
});

test('requires explicit approval for an accepted no-remediation exit', () => {
  const resolution = {
    schema_version: 1,
    feedback_id: 'feedback-retire-legacy',
    disposition: 'NO_REMEDIATION_ACCEPTED',
    owner_refs: [],
    closure_refs: [],
    knowledge_resolution_refs: ['knowledge:no-change-accepted'],
  };
  assert.equal(validateAlignmentExit({
    feedbackId: 'feedback-retire-legacy', resolution, owners: [], closures: [],
  }).errors[0].code, 'ALIGNMENT_RESOLUTION_INVALID');
  assert.equal(validateAlignmentExit({
    feedbackId: 'feedback-retire-legacy',
    resolution: { ...resolution, human_approval_ref: 'decision:no-remediation' },
    owners: [],
    closures: [],
  }).ok, true);
});
