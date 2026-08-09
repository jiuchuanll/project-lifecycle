import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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

const request = (root, overrides = {}) => ({
  root,
  reason: 'delivery:wiki-layout',
  creation_origin: 'explicit_user',
  frontmatter: baseFrontmatter(),
  body: ordinaryBody,
  ...overrides,
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

test('accepts a bounded human-readable materialization reason', () => {
  const result = validateMaterializationRequest(request('/tmp/example', {
    reason: 'Create the smallest PRD owner for the accepted Wiki layout request.',
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
