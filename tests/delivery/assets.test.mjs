import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { stringify as stringifyYaml } from 'yaml';

import { parseRestrictedYaml } from '../../scripts/lib/markdown.mjs';
import { atomicWriteValidated } from '../../scripts/lib/atomic-write.mjs';
import { materializeAsset, validateMaterializationRequest } from '../../scripts/delivery/materialize-asset.mjs';
import { validateJson } from '../../scripts/lib/validate-json.mjs';

const assetRoot = new URL('../../skills/run-prd-lifecycle/assets/', import.meta.url);
const fixtureUrl = new URL('../fixtures/delivery/assets/threshold-cases.json', import.meta.url);
const kinds = [
  ['feedback', 'feedback'],
  ['prd', 'prd'],
  ['architecture', 'architecture'],
  ['development-guidance', 'guidance'],
  ['batch', 'batch'],
  ['test-report', 'test-report'],
  ['non-prd-delivery', 'non-prd-delivery'],
  ['closure-summary', 'closure-summary'],
];

const rootFor = async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-delivery-'));
  await mkdir(join(root, 'docs', 'project-lifecycle', 'delivery'), { recursive: true });
  return root;
};

const baseFrontmatter = (overrides = {}) => ({
  schema_version: 1,
  artifact_id: 'prd-wiki-layout-v2',
  artifact_kind: 'prd',
  primary_route: 'PRD_DELIVERY',
  project_id_at_creation: 'sample-project',
  current_project_id: 'sample-project',
  domain_ids: ['wiki-workspace'],
  knowledge_baseline: 'baseline-7',
  relationships: { feedback_ids: [], prd_ids: [], legacy_artifact_refs: [] },
  retention_tier: 'active',
  reclassified_from_refs: [],
  obligations: [],
  ...overrides,
});

const ordinaryBody = {
  en: '# Wiki delivery\n\n## Scope\n\nBounded English outcome.\n\n## Evidence\n\nEvidence ref.\n',
  'zh-CN': '# Wiki 交付\n\n## 范围\n\n限定的中文结果。\n\n## 证据\n\n证据引用。\n',
};

const feedbackBody = ({ problem = 'The layout is too dense.', coverage = 'Open.' } = {}) => ({
  en: `# Wiki feedback\n\n<!-- project-lifecycle:section original_problem -->\n## Original problem\n\n${problem}\n<!-- /project-lifecycle:section -->\n\n<!-- project-lifecycle:section scenario -->\n## Scenario\n\nDaily Wiki navigation.\n<!-- /project-lifecycle:section -->\n\n<!-- project-lifecycle:section expectation -->\n## Expectation\n\nA clearer hierarchy.\n<!-- /project-lifecycle:section -->\n\n<!-- project-lifecycle:section marking -->\n## Marking\n\nActive.\n<!-- /project-lifecycle:section -->\n\n<!-- project-lifecycle:section coverage -->\n## Coverage\n\n${coverage}\n<!-- /project-lifecycle:section -->\n`,
  'zh-CN': `# Wiki 反馈\n\n<!-- project-lifecycle:section original_problem -->\n## 原始问题\n\n${problem === 'The layout is too dense.' ? '布局过于拥挤。' : '问题已被改写。'}\n<!-- /project-lifecycle:section -->\n\n<!-- project-lifecycle:section scenario -->\n## 场景\n\n日常 Wiki 导航。\n<!-- /project-lifecycle:section -->\n\n<!-- project-lifecycle:section expectation -->\n## 期望\n\n更清晰的层级。\n<!-- /project-lifecycle:section -->\n\n<!-- project-lifecycle:section marking -->\n## 标记\n\n有效。\n<!-- /project-lifecycle:section -->\n\n<!-- project-lifecycle:section coverage -->\n## 覆盖\n\n${coverage === 'Open.' ? '待处理。' : '已由 PRD 覆盖。'}\n<!-- /project-lifecycle:section -->\n`,
});

const alignmentFeedbackBody = ({ oneLanguage = false, domain = 'wiki-workspace' } = {}) => {
  const bodies = feedbackBody();
  const alignment = `<!-- project-lifecycle:alignment
schema_version: 1
classification: BUSINESS_IMPLEMENTATION_DIVERGENCE
primary_domain_id: ${domain}
-->`;
  bodies.en = bodies.en.replace('Active.', alignment);
  if (!oneLanguage) bodies['zh-CN'] = bodies['zh-CN'].replace('有效。', alignment);
  return bodies;
};

const request = (root, overrides = {}) => ({
  root,
  reason: 'delivery:wiki-layout',
  creation_origin: 'explicit_user',
  frontmatter: baseFrontmatter(),
  body: ordinaryBody,
  ...overrides,
});

const knowledgeResult = ({ feedbackId, diffId = null, ref = null, status }) => ({
  ref: ref ?? `knowledge-resolution:${diffId}`,
  verified: true,
  feedback_id: feedbackId,
  status,
  ...(diffId ? { diff_id: diffId } : {}),
});

const parseDeliveryFrontmatter = (source) => {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match);
  const parsed = parseRestrictedYaml(match[1], '/frontmatter');
  assert.equal(parsed.ok, true);
  assert.equal(validateJson('delivery-frontmatter', parsed.value).ok, true);
  return parsed.value;
};

test('ships exactly eight bilingual delivery template pairs with canonical kind markers', async () => {
  const files = (await readdir(assetRoot)).sort();
  assert.deepEqual(files, kinds.flatMap(([name]) => [`${name}-en.md`, `${name}.md`]).sort());
  for (const [name, kind] of kinds) {
    const en = await readFile(new URL(`${name}-en.md`, assetRoot), 'utf8');
    const zh = await readFile(new URL(`${name}.md`, assetRoot), 'utf8');
    assert.match(en, new RegExp(`artifact_kind: ${kind}`));
    assert.match(zh, new RegExp(`artifact_kind: ${kind}`));
    assert.equal(validateJson('delivery-frontmatter', parseDeliveryFrontmatter(en)).ok, true);
    assert.deepEqual(parseDeliveryFrontmatter(en), parseDeliveryFrontmatter(zh));
    assert.deepEqual(
      [...en.matchAll(/^(#{1,6}) /gm)].map((match) => match[1].length),
      [...zh.matchAll(/^(#{1,6}) /gm)].map((match) => match[1].length),
    );
  }
});

test('validates the complete threshold fixture matrix without choosing an artifact', async () => {
  const cases = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  for (const fixture of cases) {
    const frontmatter = baseFrontmatter({
      artifact_id: fixture.artifact_kind === 'feedback' ? 'feedback-wiki-layout' : `${fixture.artifact_kind}-wiki-layout`,
      artifact_kind: fixture.artifact_kind,
      primary_route: fixture.primary_route,
    });
    const result = validateMaterializationRequest({
      reason: `case:${fixture.name}`,
      creation_origin: fixture.creation_origin,
      creation_approval_ref: fixture.creation_approval_ref,
      changed_contract_ref: fixture.changed_contract_ref,
      canonical_purpose_satisfied: fixture.canonical_purpose_satisfied,
      frontmatter,
      body: ordinaryBody,
    });
    assert.equal(result.ok ? 'OK' : result.errors[0].code, fixture.expected, fixture.name);
  }
});

test('materializes an explicit PRD as one validated bilingual pair under the fixed delivery root', async () => {
  const root = await rootFor();
  const result = await materializeAsset(request(root));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'created');
  assert.deepEqual(result.value.locators, {
    en: 'delivery/prd-wiki-layout-v2-en.md',
    'zh-CN': 'delivery/prd-wiki-layout-v2.md',
  });
  const lifecycleRoot = join(root, 'docs', 'project-lifecycle');
  const [en, zh] = await Promise.all([
    readFile(join(lifecycleRoot, result.value.locators.en), 'utf8'),
    readFile(join(lifecycleRoot, result.value.locators['zh-CN']), 'utf8'),
  ]);
  assert.deepEqual(parseDeliveryFrontmatter(en), parseDeliveryFrontmatter(zh));
  assert.match(en, /Bounded English outcome/);
  assert.match(zh, /限定的中文结果/);
});

test('rejects a lifecycle root symlink before writing outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-delivery-project-'));
  const outside = await mkdtemp(join(tmpdir(), 'project-lifecycle-delivery-outside-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(outside, 'delivery'), { recursive: true });
  await symlink(outside, join(root, 'docs', 'project-lifecycle'));

  const result = await materializeAsset(request(root));

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ASSET_PATH_INVALID');
  assert.deepEqual(await readdir(join(outside, 'delivery')), []);
});

test('accepts a bounded human-readable materialization reason', () => {
  const result = validateMaterializationRequest(request('/tmp/example', {
    reason: 'Create the smallest PRD owner for the accepted Wiki layout request.',
  }));
  assert.equal(result.ok, true);
});

test('keeps ordinary Feedback without a document-level H1 compatible', () => {
  const body = feedbackBody();
  body.en = body.en.replace(/^# .*\n\n/u, '');
  body['zh-CN'] = body['zh-CN'].replace(/^# .*\n\n/u, '');
  const result = validateMaterializationRequest(request('/tmp/example', {
    frontmatter: baseFrontmatter({ artifact_id: 'feedback-wiki-layout', artifact_kind: 'feedback' }),
    body,
  }));
  assert.equal(result.ok, true);
});

test('rejects inferred PRD creation and architecture without their explicit gates before writing', async () => {
  const root = await rootFor();
  const inferred = await materializeAsset(request(root, { creation_origin: 'agent_inferred' }));
  assert.equal(inferred.ok, false);
  assert.equal(inferred.errors[0].code, 'PRD_APPROVAL_REQUIRED');

  const architecture = await materializeAsset(request(root, {
    frontmatter: baseFrontmatter({ artifact_id: 'architecture-wiki-layout', artifact_kind: 'architecture' }),
  }));
  assert.equal(architecture.ok, false);
  assert.equal(architecture.errors[0].code, 'ARCHITECTURE_DECLARATION_REQUIRED');
  assert.deepEqual(await readdir(join(root, 'docs', 'project-lifecycle', 'delivery')), []);
});

test('rejects redundant or route-incompatible durable assets before writing', async () => {
  const root = await rootFor();
  const redundant = await materializeAsset(request(root, { canonical_purpose_satisfied: true }));
  assert.equal(redundant.errors[0].code, 'ASSET_REDUNDANT');

  const knowledgeOnly = await materializeAsset(request(root, {
    frontmatter: baseFrontmatter({ primary_route: 'KNOWLEDGE_UPDATE' }),
  }));
  assert.equal(knowledgeOnly.errors[0].code, 'ROUTE_ASSET_MISMATCH');
  assert.deepEqual(await readdir(join(root, 'docs', 'project-lifecycle', 'delivery')), []);
});

test('materializes alignment Feedback under knowledge control without creating a delivery owner', async () => {
  const root = await rootFor();
  const frontmatter = baseFrontmatter({
    artifact_id: 'feedback-retire-wiki-density',
    artifact_kind: 'feedback',
    primary_route: 'KNOWLEDGE_UPDATE',
  });

  const result = await materializeAsset(request(root, {
    frontmatter,
    body: alignmentFeedbackBody(),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'created');
  assert.deepEqual(await readdir(join(root, 'docs', 'project-lifecycle', 'delivery')), [
    'feedback-retire-wiki-density-en.md',
    'feedback-retire-wiki-density.md',
  ]);
});

test('rejects invalid alignment Feedback before writing either language', async () => {
  for (const body of [
    alignmentFeedbackBody({ oneLanguage: true }),
    alignmentFeedbackBody({ domain: 'foreign-domain' }),
  ]) {
    const root = await rootFor();
    const frontmatter = baseFrontmatter({
      artifact_id: 'feedback-retire-wiki-density',
      artifact_kind: 'feedback',
      primary_route: 'KNOWLEDGE_UPDATE',
    });
    const result = await materializeAsset(request(root, { frontmatter, body }));
    assert.equal(result.ok, false);
    assert.match(result.errors[0].code, /^ALIGNMENT_/u);
    assert.deepEqual(await readdir(join(root, 'docs', 'project-lifecycle', 'delivery')), []);
  }
});

test('keeps an active marker until complete delivery and knowledge resolution are supplied', async () => {
  const root = await rootFor();
  const feedbackId = 'feedback-retire-wiki-density';
  const frontmatter = baseFrontmatter({
    artifact_id: feedbackId,
    artifact_kind: 'feedback',
    primary_route: 'KNOWLEDGE_UPDATE',
  });
  assert.equal((await materializeAsset(request(root, {
    frontmatter,
    body: alignmentFeedbackBody(),
  }))).ok, true);

  const withoutResolution = await materializeAsset(request(root, {
    frontmatter,
    body: feedbackBody(),
  }));
  assert.equal(withoutResolution.errors[0].code, 'ALIGNMENT_RESOLUTION_REQUIRED');

  const deliveryOwner = baseFrontmatter({
    artifact_id: 'prd-retire-wiki-density',
    relationships: { feedback_ids: [feedbackId], prd_ids: [], legacy_artifact_refs: [] },
  });
  assert.equal((await materializeAsset(request(root, {
    frontmatter: deliveryOwner,
    body: ordinaryBody,
  }))).ok, true);
  const archive = join(root, 'docs', 'project-lifecycle', 'archive', 'delivery');
  await mkdir(archive, { recursive: true });
  for (const name of ['prd-retire-wiki-density-en.md', 'prd-retire-wiki-density.md']) {
    await rename(join(root, 'docs', 'project-lifecycle', 'delivery', name), join(archive, name));
  }
  const closure = {
    artifact_id: 'closure-prd-retire-wiki-density',
    owner_artifact_id: 'prd-retire-wiki-density',
    outcome: { status: 'ACCEPTED', ref: 'acceptance:retirement', residual_risk_refs: [] },
    verification: { status: 'PASSED', ref: 'verification:retirement' },
    acceptance: {
      claimed: true,
      units: [{ unit_id: 'retirement', status: 'ACCEPTED', evidence_refs: ['test:retirement'] }],
    },
    feedback_coverage: [{
      feedback_id: feedbackId,
      status: 'COVERED',
      covering_prd_ids: ['prd-retire-wiki-density'],
      evidence_refs: ['acceptance:retirement'],
      remaining_criteria: [],
    }],
    obligation_outcomes: [],
    conflict_disposition: { status: 'NOT_APPLICABLE', ref: 'conflict:none' },
    baseline: { starting: 'baseline-7', current: 'baseline-7' },
    knowledge_handoff: {
      diff_id: 'diff-retirement',
      outcome: 'CHANGE',
      owner: 'run-prd-lifecycle',
      apply_authority: 'maintain-project-knowledge',
    },
    evidence_refs: ['verification:retirement'],
    closure_ref: 'acceptance:retirement',
  };
  const resolved = await materializeAsset(request(root, {
    frontmatter,
    body: (() => {
      const pair = feedbackBody({
        coverage: 'DELIVERY_ACCEPTED; closure-prd-retire-wiki-density; knowledge-resolution:diff-retirement',
      });
      pair['zh-CN'] = pair['zh-CN'].replace(
        '已由 PRD 覆盖。',
        'DELIVERY_ACCEPTED；closure-prd-retire-wiki-density；knowledge-resolution:diff-retirement',
      );
      return pair;
    })(),
    alignment_closures: [closure],
    alignment_resolution: {
      schema_version: 1,
      feedback_id: feedbackId,
      disposition: 'DELIVERY_ACCEPTED',
      owner_refs: ['prd-retire-wiki-density'],
      closure_refs: ['closure-prd-retire-wiki-density'],
      knowledge_resolution_refs: ['knowledge-resolution:diff-retirement'],
    },
    alignment_knowledge_results: [knowledgeResult({
      feedbackId,
      diffId: 'diff-retirement',
      status: 'APPLIED',
    })],
  }));
  assert.equal(resolved.ok, true);
  const source = await readFile(join(root, 'docs', 'project-lifecycle', 'delivery', `${feedbackId}-en.md`), 'utf8');
  assert.doesNotMatch(source, /project-lifecycle:alignment/u);

  const laterUpdate = await materializeAsset(request(root, {
    frontmatter,
    body: feedbackBody({ coverage: 'Accepted delivery remains aligned.' }),
  }));
  assert.equal(laterUpdate.ok, true);
  assert.equal(laterUpdate.value.status, 'updated');
});

test('requires no-remediation approval and knowledge evidence in retained Feedback coverage', async () => {
  const root = await rootFor();
  const feedbackId = 'feedback-retain-divergence';
  const frontmatter = baseFrontmatter({
    artifact_id: feedbackId,
    artifact_kind: 'feedback',
    primary_route: 'KNOWLEDGE_UPDATE',
  });
  assert.equal((await materializeAsset(request(root, {
    frontmatter,
    body: alignmentFeedbackBody(),
  }))).ok, true);
  const alignmentResolution = {
    schema_version: 1,
    feedback_id: feedbackId,
    disposition: 'NO_REMEDIATION_ACCEPTED',
    owner_refs: [],
    closure_refs: [],
    knowledge_resolution_refs: ['knowledge-resolution:retained-divergence'],
    human_approval_ref: 'decision:retain-divergence',
  };

  const missingEvidence = await materializeAsset(request(root, {
    frontmatter,
    body: feedbackBody(),
    alignment_resolution: alignmentResolution,
    alignment_knowledge_results: [knowledgeResult({
      feedbackId,
      ref: 'knowledge-resolution:retained-divergence',
      status: 'RESIDUAL_DIVERGENCE_ACCEPTED',
    })],
  }));
  assert.equal(missingEvidence.errors[0].code, 'ALIGNMENT_RESOLUTION_EVIDENCE_MISSING');

  const bodyWithEvidence = feedbackBody({
    coverage: 'NO_REMEDIATION_ACCEPTED; decision:retain-divergence; knowledge-resolution:retained-divergence',
  });
  bodyWithEvidence['zh-CN'] = bodyWithEvidence['zh-CN'].replace(
    '已由 PRD 覆盖。',
    'NO_REMEDIATION_ACCEPTED；decision:retain-divergence；knowledge-resolution:retained-divergence',
  );
  const resolved = await materializeAsset(request(root, {
    frontmatter,
    body: bodyWithEvidence,
    alignment_resolution: alignmentResolution,
    alignment_knowledge_results: [knowledgeResult({
      feedbackId,
      ref: 'knowledge-resolution:retained-divergence',
      status: 'RESIDUAL_DIVERGENCE_ACCEPTED',
    })],
  }));
  assert.equal(resolved.ok, true);
  for (const language of ['en', 'zh-CN']) {
    const suffix = language === 'en' ? '-en.md' : '.md';
    const source = await readFile(join(root, 'docs', 'project-lifecycle', 'delivery', `${feedbackId}${suffix}`), 'utf8');
    assert.match(source, /NO_REMEDIATION_ACCEPTED/u);
    assert.match(source, /decision:retain-divergence/u);
    assert.match(source, /knowledge-resolution:retained-divergence/u);
  }
});

test('requires exact retained resolution tokens instead of prefix matches', async () => {
  for (const [index, suffix] of ['/old', '.old', '#old', '@old'].entries()) {
    const root = await rootFor();
    const feedbackId = `feedback-prefix-evidence-${index}`;
    const frontmatter = baseFrontmatter({
      artifact_id: feedbackId,
      artifact_kind: 'feedback',
      primary_route: 'KNOWLEDGE_UPDATE',
    });
    assert.equal((await materializeAsset(request(root, {
      frontmatter,
      body: alignmentFeedbackBody(),
    }))).ok, true);
    const bodyWithPrefix = feedbackBody({
      coverage: `NO_REMEDIATION_ACCEPTED; decision:retain-prefix${suffix}; knowledge-resolution:prefix${suffix}`,
    });
    bodyWithPrefix['zh-CN'] = bodyWithPrefix['zh-CN'].replace(
      '已由 PRD 覆盖。',
      `NO_REMEDIATION_ACCEPTED；decision:retain-prefix${suffix}；knowledge-resolution:prefix${suffix}`,
    );
    const result = await materializeAsset(request(root, {
      frontmatter,
      body: bodyWithPrefix,
      alignment_resolution: {
        schema_version: 1,
        feedback_id: feedbackId,
        disposition: 'NO_REMEDIATION_ACCEPTED',
        owner_refs: [],
        closure_refs: [],
        knowledge_resolution_refs: ['knowledge-resolution:prefix'],
        human_approval_ref: 'decision:retain-prefix',
      },
      alignment_knowledge_results: [knowledgeResult({
        feedbackId,
        ref: 'knowledge-resolution:prefix',
        status: 'RESIDUAL_DIVERGENCE_ACCEPTED',
      })],
    }));
    assert.equal(result.ok, false, suffix);
    assert.equal(result.errors[0].code, 'ALIGNMENT_RESOLUTION_EVIDENCE_MISSING', suffix);
  }
});

test('reuses titleless legacy Feedback by allowing one bounded alignment title migration', async () => {
  const root = await rootFor();
  const feedbackId = 'feedback-title-migration';
  const frontmatter = baseFrontmatter({
    artifact_id: feedbackId,
    artifact_kind: 'feedback',
    primary_route: 'PRD_DELIVERY',
  });
  const titleless = feedbackBody();
  titleless.en = titleless.en.replace(/^# .*\n\n/u, '');
  titleless['zh-CN'] = titleless['zh-CN'].replace(/^# .*\n\n/u, '');
  assert.equal((await materializeAsset(request(root, { frontmatter, body: titleless }))).ok, true);

  const aligned = alignmentFeedbackBody();
  const result = await materializeAsset(request(root, {
    frontmatter,
    body: aligned,
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.status, 'updated');
});

test('normalizes one leading newline while adding the first alignment title and marker', async () => {
  const root = await rootFor();
  const feedbackId = 'feedback-title-leading-newline';
  const frontmatter = baseFrontmatter({
    artifact_id: feedbackId,
    artifact_kind: 'feedback',
    primary_route: 'PRD_DELIVERY',
  });
  const titleless = feedbackBody();
  titleless.en = titleless.en.replace(/^# .*\n\n/u, '');
  titleless['zh-CN'] = titleless['zh-CN'].replace(/^# .*\n\n/u, '');
  assert.equal((await materializeAsset(request(root, { frontmatter, body: titleless }))).ok, true);

  const aligned = alignmentFeedbackBody();
  aligned.en = `\n${aligned.en}`;
  aligned['zh-CN'] = `\n${aligned['zh-CN']}`;
  const result = await materializeAsset(request(root, { frontmatter, body: aligned }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.status, 'updated');
});

test('rejects a Feedback document that exceeds the bound after managed hashes are inserted', async () => {
  const root = await rootFor();
  const longRefs = (group) => Array.from({ length: 50 }, (_, index) => (
    `${group}-${index}-`.padEnd(500, 'x')
  )).sort();
  const obligations = Array.from({ length: 2 }, (_, index) => ({
    obligation_id: `size-bound-${index}`,
    kind: 'DEPENDENCY_RESOLUTION_REQUIRED',
    status: 'OPEN',
    trigger_refs: longRefs(`trigger-${index}`),
    scope_refs: longRefs(`scope-${index}`),
    responsible_refs: longRefs(`responsible-${index}`),
    required_before: 'closure',
    evidence_refs: longRefs(`evidence-${index}`),
  }));
  const frontmatter = baseFrontmatter({
    artifact_id: 'feedback-managed-hash-bound',
    artifact_kind: 'feedback',
    primary_route: 'PRD_DELIVERY',
    obligations,
  });
  const bodies = feedbackBody();
  const renderedPrefix = `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n`;
  const targetBytes = 262_144;
  for (const language of ['en', 'zh-CN']) {
    const paddingBytes = targetBytes - Buffer.byteLength(renderedPrefix) - Buffer.byteLength(bodies[language]);
    assert.equal(paddingBytes > 0 && paddingBytes < 131_072, true);
    bodies[language] = bodies[language].replace(
      language === 'en' ? 'Open.' : '待处理。',
      `${language === 'en' ? 'Open.' : '待处理。'}${'x'.repeat(paddingBytes)}`,
    );
  }

  const result = await materializeAsset(request(root, { frontmatter, body: bodies }));

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ASSET_BODY_INVALID');
});

test('rejects fenced source rewrites while adding the first alignment title and marker', async () => {
  const root = await rootFor();
  const feedbackId = 'feedback-title-fenced-history';
  const frontmatter = baseFrontmatter({
    artifact_id: feedbackId,
    artifact_kind: 'feedback',
    primary_route: 'PRD_DELIVERY',
  });
  const titleless = feedbackBody();
  titleless.en = titleless.en
    .replace(/^# .*\n\n/u, '')
    .replace('The layout is too dense.', '```text\nOLD\n```');
  titleless['zh-CN'] = titleless['zh-CN']
    .replace(/^# .*\n\n/u, '')
    .replace('布局过于拥挤。', '```text\n旧值\n```');
  assert.equal((await materializeAsset(request(root, { frontmatter, body: titleless }))).ok, true);

  const alignment = `<!-- project-lifecycle:alignment
schema_version: 1
classification: BUSINESS_IMPLEMENTATION_DIVERGENCE
primary_domain_id: wiki-workspace
-->`;
  const rewritten = {
    en: `# Wiki feedback\n\n${titleless.en.replace('OLD', 'NEW').replace('Active.', alignment)}`,
    'zh-CN': `# Wiki 反馈\n\n${titleless['zh-CN'].replace('旧值', '新值').replace('有效。', alignment)}`,
  };
  const result = await materializeAsset(request(root, { frontmatter, body: rewritten }));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'HISTORY_BODY_CHANGED');
});

test('discovers linked delivery owners from authoritative assets before no-remediation exit', async () => {
  const root = await rootFor();
  const feedbackId = 'feedback-owner-discovery';
  const frontmatter = baseFrontmatter({
    artifact_id: feedbackId,
    artifact_kind: 'feedback',
    primary_route: 'KNOWLEDGE_UPDATE',
  });
  assert.equal((await materializeAsset(request(root, {
    frontmatter,
    body: alignmentFeedbackBody(),
  }))).ok, true);
  assert.equal((await materializeAsset(request(root, {
    frontmatter: baseFrontmatter({
      artifact_id: 'prd-owner-discovery',
      relationships: { feedback_ids: [feedbackId], prd_ids: [], legacy_artifact_refs: [] },
    }),
    body: ordinaryBody,
  }))).ok, true);
  const bodyWithEvidence = feedbackBody({
    coverage: 'NO_REMEDIATION_ACCEPTED; decision:ignore-owner; knowledge-resolution:owner-discovery',
  });
  bodyWithEvidence['zh-CN'] = bodyWithEvidence['zh-CN'].replace(
    '已由 PRD 覆盖。',
    'NO_REMEDIATION_ACCEPTED；decision:ignore-owner；knowledge-resolution:owner-discovery',
  );

  const result = await materializeAsset(request(root, {
    frontmatter,
    body: bodyWithEvidence,
    alignment_owners: [],
    alignment_resolution: {
      schema_version: 1,
      feedback_id: feedbackId,
      disposition: 'NO_REMEDIATION_ACCEPTED',
      owner_refs: [],
      closure_refs: [],
      knowledge_resolution_refs: ['knowledge-resolution:owner-discovery'],
      human_approval_ref: 'decision:ignore-owner',
    },
    alignment_knowledge_results: [knowledgeResult({
      feedbackId,
      ref: 'knowledge-resolution:owner-discovery',
      status: 'RESIDUAL_DIVERGENCE_ACCEPTED',
    })],
  }));
  assert.equal(result.errors[0].code, 'ALIGNMENT_RESOLUTION_INCOMPLETE');
});

test('allows only Feedback marking and coverage updates without an erratum or successor', async () => {
  const root = await rootFor();
  const frontmatter = baseFrontmatter({
    artifact_id: 'feedback-wiki-density',
    artifact_kind: 'feedback',
  });
  assert.equal((await materializeAsset(request(root, { frontmatter, body: feedbackBody() }))).ok, true);

  const coverageUpdate = await materializeAsset(request(root, {
    frontmatter,
    body: feedbackBody({ coverage: 'Covered by PRD.' }),
  }));
  assert.equal(coverageUpdate.ok, true);
  assert.equal(coverageUpdate.value.status, 'updated');

  const historyRewrite = await materializeAsset(request(root, {
    frontmatter,
    body: feedbackBody({ problem: 'The problem was rewritten.' }),
  }));
  assert.equal(historyRewrite.ok, false);
  assert.equal(historyRewrite.errors[0].code, 'HISTORY_BODY_CHANGED');
});

test('removes the first new language when the paired write fails', async () => {
  const root = await rootFor();
  let writes = 0;
  const result = await materializeAsset(request(root), {
    atomicWriteValidated: async (options) => {
      writes += 1;
      if (writes === 2) throw new Error('injected second-language failure');
      return atomicWriteValidated(options);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ASSET_WRITE_FAILED');
  assert.deepEqual(await readdir(join(root, 'docs', 'project-lifecycle', 'delivery')), []);
});

test('reports rollback failure instead of leaving a silently inconsistent feedback pair', async () => {
  const root = await rootFor();
  const frontmatter = baseFrontmatter({
    artifact_id: 'feedback-wiki-density',
    artifact_kind: 'feedback',
  });
  assert.equal((await materializeAsset(request(root, { frontmatter, body: feedbackBody() }))).ok, true);

  let writes = 0;
  const result = await materializeAsset(request(root, {
    frontmatter,
    body: feedbackBody({ coverage: 'Covered by PRD.' }),
  }), {
    atomicWriteValidated: async (options) => {
      writes += 1;
      if (writes >= 2) throw new Error('injected second-language or rollback failure');
      return atomicWriteValidated(options);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ASSET_ROLLBACK_FAILED');
});
