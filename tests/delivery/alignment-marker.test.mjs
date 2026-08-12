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

const knowledgeResultsFor = ({ resolution, closures = [] }) => resolution.knowledge_resolution_refs.map((ref) => {
  const diffId = ref.replace(/^knowledge-resolution:/u, '');
  const closure = closures.find((candidate) => candidate.knowledge_handoff?.diff_id === diffId);
  return {
    ref,
    verified: true,
    feedback_id: resolution.feedback_id,
    status: closure?.knowledge_handoff?.outcome === 'CHANGE' ? 'APPLIED' : 'NO_CHANGE',
    ...(closure ? { diff_id: diffId } : {}),
  };
});

const validateExit = (input) => validateAlignmentExit({
  ...input,
  feedbackProjectId: input.feedbackProjectId ?? 'sample-project',
  ownerInventoryComplete: true,
  knowledgeResults: input.knowledgeResults ?? knowledgeResultsFor(input),
});

const rejectedClosure = (ownerId, feedbackIds = []) => ({
  artifact_id: `closure-${ownerId}`,
  owner_artifact_id: ownerId,
  outcome: { status: 'REJECTED', ref: `outcome:${ownerId}`, residual_risk_refs: [] },
  verification: { status: 'FAILED', ref: `verification:${ownerId}` },
  acceptance: { claimed: false, units: [] },
  feedback_coverage: feedbackIds.map((feedbackId) => ({
    feedback_id: feedbackId,
    status: 'NOT_COVERED',
    covering_prd_ids: [ownerId],
    evidence_refs: [`outcome:${ownerId}`],
    remaining_criteria: ['Delivery was rejected.'],
  })),
  obligation_outcomes: [],
  conflict_disposition: { status: 'NOT_APPLICABLE', ref: `conflict:${ownerId}` },
  baseline: { starting: 'baseline-7', current: 'baseline-7' },
  knowledge_handoff: {
    diff_id: `diff-${ownerId}`,
    outcome: 'NO_CHANGE',
    owner: 'run-prd-lifecycle',
    apply_authority: 'maintain-project-knowledge',
  },
  evidence_refs: [`verification:${ownerId}`],
  closure_ref: `outcome:${ownerId}`,
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

test('rejects an active alignment marker outside the mutable Marking section', () => {
  const extraMarker = marker();
  const result = validateAlignmentFeedbackPair({
    frontmatter: frontmatter(),
    bodies: {
      en: body().replace('Legacy approval remains implemented.', `${extraMarker}\nLegacy approval remains implemented.`),
      'zh-CN': body({ language: 'zh-CN' }).replace('旧审批仍有实现。', `${extraMarker}\n旧审批仍有实现。`),
    },
  });
  assert.equal(result.errors[0].code, 'ALIGNMENT_MARKER_INVALID');
});

test('does not treat a complete Feedback example inside one outer fence as an active document', () => {
  const fenced = `~~~markdown\n${body()}~~~\n`;
  const result = validateAlignmentFeedbackPair({
    frontmatter: frontmatter(),
    bodies: { en: fenced, 'zh-CN': fenced },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ALIGNMENT_MARKER_INVALID');
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

test('requires exactly one document-level H1 before bounded Feedback sections', () => {
  const withoutDocumentTitle = body().replace('# Retire legacy approval\n\n', '')
    .replace('## Original problem', '# Private original problem');
  const nestedH1 = body().replace('## Original problem', '# Private original problem');
  for (const en of [withoutDocumentTitle, nestedH1]) {
    const result = validateAlignmentFeedbackPair({
      frontmatter: frontmatter(),
      bodies: { en, 'zh-CN': body({ language: 'zh-CN' }) },
    });
    assert.equal(result.errors[0].code, 'ALIGNMENT_MARKER_INVALID');
    assert.equal(result.errors[0].path, '/body/en/title');
  }
});

test('does not require a document-level H1 when Feedback has no active alignment marker', () => {
  const withoutTitle = (language) => body({ language, marking: language === 'en' ? 'Active.' : '有效。' })
    .replace(/^# .*\n\n/u, '');
  const result = validateAlignmentFeedbackPair({
    frontmatter: frontmatter(),
    bodies: { en: withoutTitle('en'), 'zh-CN': withoutTitle('zh-CN') },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.titles, { en: null, 'zh-CN': null });
});

test('requires the complete accepted owner set and knowledge resolution before marker exit', () => {
  const owners = ['prd-backend', 'prd-frontend'].map((artifactId) => ({
    artifact_id: artifactId,
    current_project_id: 'sample-project',
    knowledge_baseline: 'baseline-7',
    relationships: { feedback_ids: ['feedback-retire-legacy'] },
  }));
  const closures = owners.map(({ artifact_id: ownerId }) => ({
    artifact_id: `closure-${ownerId}`,
    owner_artifact_id: ownerId,
    outcome: { status: 'ACCEPTED', ref: `acceptance:${ownerId}`, residual_risk_refs: [] },
    verification: { status: 'PASSED', ref: `verification:${ownerId}` },
    acceptance: {
      claimed: true,
      units: [{ unit_id: 'remediation', status: 'ACCEPTED', evidence_refs: [`test:${ownerId}`] }],
    },
    feedback_coverage: [{
      feedback_id: 'feedback-retire-legacy',
      status: 'COVERED',
      covering_prd_ids: [ownerId],
      evidence_refs: [`acceptance:${ownerId}`],
      remaining_criteria: [],
    }],
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
    closure_ref: `acceptance:${ownerId}`,
  }));
  const resolution = {
    schema_version: 1,
    feedback_id: 'feedback-retire-legacy',
    disposition: 'DELIVERY_ACCEPTED',
    owner_refs: ['prd-backend', 'prd-frontend'],
    closure_refs: ['closure-prd-backend', 'closure-prd-frontend'],
    knowledge_resolution_refs: [
      'knowledge-resolution:diff-prd-backend',
      'knowledge-resolution:diff-prd-frontend',
    ],
  };

  assert.equal(validateAlignmentExit({
    feedbackId: 'feedback-retire-legacy',
    feedbackProjectId: 'sample-project',
    resolution,
    owners,
    closures,
    ownerInventoryComplete: true,
  }).errors[0].code, 'ALIGNMENT_KNOWLEDGE_RESULT_INVALID');
  assert.equal(validateExit({
    feedbackId: 'feedback-retire-legacy', resolution, owners, closures,
  }).ok, true);
  const wrongBaseline = structuredClone(closures);
  wrongBaseline[0].baseline = { starting: 'baseline-other', current: 'baseline-other' };
  assert.equal(validateExit({
    feedbackId: 'feedback-retire-legacy', resolution, owners, closures: wrongBaseline,
  }).errors[0].code, 'ALIGNMENT_RESOLUTION_INVALID');
  assert.equal(validateExit({
    feedbackId: 'feedback-retire-legacy',
    resolution,
    owners,
    closures,
    knowledgeResults: knowledgeResultsFor({ resolution, closures }).map((result) => ({
      ...result,
      status: 'NO_CHANGE',
    })),
  }).errors[0].code, 'ALIGNMENT_RESOLUTION_INCOMPLETE');
  assert.equal(validateExit({
    feedbackId: 'feedback-retire-legacy',
    resolution: { ...resolution, owner_refs: ['prd-backend'], closure_refs: ['closure-prd-backend'] },
    owners,
    closures,
  }).errors[0].code, 'ALIGNMENT_RESOLUTION_INCOMPLETE');
  assert.equal(validateExit({
    feedbackId: 'feedback-retire-legacy',
    resolution: { ...resolution, knowledge_resolution_refs: [] },
    owners,
    closures,
  }).errors[0].code, 'ALIGNMENT_RESOLUTION_INVALID');
  assert.equal(validateExit({
    feedbackId: 'feedback-retire-legacy',
    resolution: {
      ...resolution,
      knowledge_resolution_refs: [
        'knowledge-resolution:diff-prd-backend',
        'knowledge-resolution:unrelated-diff',
      ],
    },
    owners,
    closures,
  }).errors[0].code, 'ALIGNMENT_RESOLUTION_INCOMPLETE');
});

test('accepts schema-valid generated references containing consecutive hyphens', () => {
  const feedbackId = 'feedback-double-hyphen';
  const ownerId = 'prd--owner';
  const diffId = 'diff--owner';
  const owner = {
    artifact_id: ownerId,
    current_project_id: 'sample-project',
    knowledge_baseline: 'baseline-7',
    relationships: { feedback_ids: [feedbackId] },
  };
  const closure = {
    artifact_id: `closure-${ownerId}`,
    owner_artifact_id: ownerId,
    outcome: { status: 'ACCEPTED', ref: 'acceptance:owner', residual_risk_refs: [] },
    verification: { status: 'PASSED', ref: 'verification:owner' },
    acceptance: {
      claimed: true,
      units: [{ unit_id: 'remediation', status: 'ACCEPTED', evidence_refs: ['test:owner'] }],
    },
    feedback_coverage: [{
      feedback_id: feedbackId,
      status: 'COVERED',
      covering_prd_ids: [ownerId],
      evidence_refs: ['acceptance:owner'],
      remaining_criteria: [],
    }],
    obligation_outcomes: [],
    conflict_disposition: { status: 'NOT_APPLICABLE', ref: 'conflict:none' },
    baseline: { starting: 'baseline-7', current: 'baseline-7' },
    knowledge_handoff: {
      diff_id: diffId,
      outcome: 'CHANGE',
      owner: 'run-prd-lifecycle',
      apply_authority: 'maintain-project-knowledge',
    },
    evidence_refs: ['verification:owner'],
    closure_ref: 'acceptance:owner',
  };
  const resolution = {
    schema_version: 1,
    feedback_id: feedbackId,
    disposition: 'DELIVERY_ACCEPTED',
    owner_refs: [ownerId],
    closure_refs: [closure.artifact_id],
    knowledge_resolution_refs: [`knowledge-resolution:${diffId}`],
  };
  assert.equal(validateExit({ feedbackId, resolution, owners: [owner], closures: [closure] }).ok, true);
});

test('requires explicit approval for an accepted no-remediation exit', () => {
  const resolution = {
    schema_version: 1,
    feedback_id: 'feedback-retire-legacy',
    disposition: 'NO_REMEDIATION_ACCEPTED',
    owner_refs: [],
    closure_refs: [],
    knowledge_resolution_refs: ['knowledge-resolution:no-remediation-accepted'],
  };
  assert.equal(validateExit({
    feedbackId: 'feedback-retire-legacy', resolution, owners: [], closures: [],
  }).errors[0].code, 'ALIGNMENT_RESOLUTION_INVALID');
  assert.equal(validateExit({
    feedbackId: 'feedback-retire-legacy',
    resolution: { ...resolution, human_approval_ref: 'decision:no-remediation' },
    owners: [],
    closures: [],
  }).ok, true);
  for (const humanApprovalRef of ['decision:committee,2026', 'decision:committee;2026']) {
    assert.equal(validateExit({
      feedbackId: 'feedback-retire-legacy',
      resolution: { ...resolution, human_approval_ref: humanApprovalRef },
      owners: [],
      closures: [],
    }).errors[0].code, 'ALIGNMENT_RESOLUTION_INVALID');
  }
});

test('requires externally verified knowledge results before marker exit', () => {
  const resolution = {
    schema_version: 1,
    feedback_id: 'feedback-retire-legacy',
    disposition: 'NO_REMEDIATION_ACCEPTED',
    owner_refs: [],
    closure_refs: [],
    knowledge_resolution_refs: ['knowledge-resolution:no-remediation-accepted'],
    human_approval_ref: 'decision:no-remediation',
  };
  const missing = validateAlignmentExit({
    feedbackId: resolution.feedback_id,
    feedbackProjectId: 'sample-project',
    resolution,
    owners: [],
    closures: [],
    ownerInventoryComplete: true,
  });
  assert.equal(missing.errors[0].code, 'ALIGNMENT_KNOWLEDGE_RESULT_INVALID');

  const unverified = validateAlignmentExit({
    feedbackId: resolution.feedback_id,
    feedbackProjectId: 'sample-project',
    resolution,
    owners: [],
    closures: [],
    ownerInventoryComplete: true,
    knowledgeResults: [{
      ref: 'knowledge-resolution:no-remediation-accepted',
      verified: false,
      feedback_id: resolution.feedback_id,
      status: 'RESIDUAL_DIVERGENCE_ACCEPTED',
    }],
  });
  assert.equal(unverified.errors[0].code, 'ALIGNMENT_KNOWLEDGE_RESULT_INVALID');
});

test('fails closed unless the owner inventory is explicitly complete', () => {
  const result = validateAlignmentExit({
    feedbackId: 'feedback-retire-legacy',
    feedbackProjectId: 'sample-project',
    resolution: {
      schema_version: 1,
      feedback_id: 'feedback-retire-legacy',
      disposition: 'NO_REMEDIATION_ACCEPTED',
      owner_refs: [],
      closure_refs: [],
      knowledge_resolution_refs: ['knowledge-resolution:no-remediation-accepted'],
      human_approval_ref: 'decision:no-remediation',
    },
    owners: [],
    closures: [],
  });
  assert.equal(result.errors[0].code, 'ALIGNMENT_OWNER_INVENTORY_INCOMPLETE');
});

test('does not exclude a rejected owner whose closure is not bound to the linked Feedback', () => {
  const feedbackId = 'feedback-retire-legacy';
  const resolution = {
    schema_version: 1,
    feedback_id: feedbackId,
    disposition: 'NO_REMEDIATION_ACCEPTED',
    owner_refs: [],
    closure_refs: [],
    knowledge_resolution_refs: ['knowledge-resolution:no-remediation-accepted'],
    human_approval_ref: 'decision:no-remediation',
  };
  const result = validateExit({
    feedbackId,
    resolution,
    owners: [{
      artifact_id: 'prd-unbound',
      current_project_id: 'sample-project',
      knowledge_baseline: 'baseline-7',
      relationships: { feedback_ids: [feedbackId] },
    }],
    closures: [rejectedClosure('prd-unbound')],
  });
  assert.equal(result.errors[0].code, 'ALIGNMENT_RESOLUTION_INVALID');
});

test('rejects a linked alignment owner from another project', () => {
  const feedbackId = 'feedback-retire-legacy';
  const result = validateExit({
    feedbackId,
    feedbackProjectId: 'sample-project',
    resolution: {
      schema_version: 1,
      feedback_id: feedbackId,
      disposition: 'NO_REMEDIATION_ACCEPTED',
      owner_refs: [],
      closure_refs: [],
      knowledge_resolution_refs: ['knowledge-resolution:no-remediation-accepted'],
      human_approval_ref: 'decision:no-remediation',
    },
    owners: [{
      artifact_id: 'prd-foreign',
      current_project_id: 'foreign-project',
      knowledge_baseline: 'baseline-7',
      relationships: { feedback_ids: [feedbackId] },
    }],
    closures: [],
  });

  assert.equal(result.errors[0].code, 'ALIGNMENT_RESOLUTION_INVALID');
});

test('ignores rejected historical owners after an accepted successor covers the Feedback', () => {
  const closure = (ownerId, accepted) => ({
    artifact_id: `closure-${ownerId}`,
    owner_artifact_id: ownerId,
    outcome: { status: accepted ? 'ACCEPTED' : 'REJECTED', ref: `outcome:${ownerId}`, residual_risk_refs: [] },
    verification: { status: accepted ? 'PASSED' : 'FAILED', ref: `verification:${ownerId}` },
    acceptance: {
      claimed: accepted,
      units: accepted ? [{ unit_id: 'remediation', status: 'ACCEPTED', evidence_refs: [`test:${ownerId}`] }] : [],
    },
    feedback_coverage: [{
      feedback_id: 'feedback-retire-legacy',
      status: accepted ? 'COVERED' : 'NOT_COVERED',
      covering_prd_ids: [ownerId],
      evidence_refs: [`outcome:${ownerId}`],
      remaining_criteria: accepted ? [] : ['Superseded by a successor.'],
    }],
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
  const owners = ['prd-old', 'prd-new'].map((artifactId) => ({
    artifact_id: artifactId,
    current_project_id: 'sample-project',
    knowledge_baseline: 'baseline-7',
    relationships: { feedback_ids: ['feedback-retire-legacy'] },
  }));
  const resolution = {
    schema_version: 1,
    feedback_id: 'feedback-retire-legacy',
    disposition: 'DELIVERY_ACCEPTED',
    owner_refs: ['prd-new'],
    closure_refs: ['closure-prd-new'],
    knowledge_resolution_refs: ['knowledge-resolution:diff-prd-new'],
  };
  assert.equal(validateExit({
    feedbackId: 'feedback-retire-legacy',
    resolution,
    owners,
    closures: [closure('prd-old', false), closure('prd-new', true)],
  }).ok, true);
});
