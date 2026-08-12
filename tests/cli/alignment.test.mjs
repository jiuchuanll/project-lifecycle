import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const runCli = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/bin/project-lifecycle.mjs', ...args], { cwd: repositoryRoot });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stderr, stdout }));
});
const envelope = (result) => {
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  return JSON.parse(result.stdout);
};

const map = {
  schema_version: 2,
  project_id: 'sample-project',
  identity_lineage: [],
  repositories: [],
  constraints: [],
  domains: [{
    id: 'approval-flow', kind: 'domain',
    label: { en: 'Approval flow', 'zh-CN': '审批流程' },
    purpose: { en: 'Owns approval.', 'zh-CN': '负责审批。' },
    domain_state: 'confirmed',
    scope: { includes: ['approval'], excludes: [] }, parent_id: null,
    relationships: [], evidence_refs: ['repo:README.md'], known_gaps: [],
  }],
};
const frontmatter = {
  schema_version: 1,
  artifact_id: 'feedback-retire-legacy',
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
};
const body = (language) => {
  const en = language === 'en';
  return `# ${en ? 'Retire legacy approval' : '废弃旧审批'}

<!-- project-lifecycle:section original_problem -->
## ${en ? 'Original problem' : '原始问题'}
Legacy.
<!-- /project-lifecycle:section -->
<!-- project-lifecycle:section scenario -->
## ${en ? 'Scenario' : '场景'}
Bootstrap.
<!-- /project-lifecycle:section -->
<!-- project-lifecycle:section expectation -->
## ${en ? 'Expectation' : '期望'}
Retire.
<!-- /project-lifecycle:section -->
<!-- project-lifecycle:section marking -->
## ${en ? 'Marking' : '标记'}
<!-- project-lifecycle:alignment
schema_version: 1
classification: BUSINESS_IMPLEMENTATION_DIVERGENCE
primary_domain_id: approval-flow
-->
<!-- /project-lifecycle:section -->
<!-- project-lifecycle:section coverage -->
## ${en ? 'Coverage' : '覆盖'}
Open.
<!-- /project-lifecycle:section -->
`;
};
const document = (language) => `---\n${JSON.stringify(frontmatter)}\n---\n${body(language)}`;

test('validates a bilingual alignment Feedback pair without returning its prose', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-alignment-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const en = join(root, 'feedback-en.md');
  const zh = join(root, 'feedback.md');
  const projectMap = join(root, 'project-map.json');
  await writeFile(en, document('en'));
  await writeFile(zh, document('zh-CN'));
  await writeFile(projectMap, JSON.stringify(map));

  const result = await runCli(['validate-alignment-feedback', en, zh, projectMap]);
  assert.equal(result.status, 0);
  assert.deepEqual(envelope(result).value, {
    feedback_id: 'feedback-retire-legacy',
    primary_domain_id: 'approval-flow',
    routing_disposition: null,
  });
  assert.doesNotMatch(result.stdout, /Retire legacy approval|废弃旧审批/u);
});

test('rejects an incomplete Feedback document instead of validating only its marker', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-alignment-incomplete-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const en = join(root, 'feedback-en.md');
  const zh = join(root, 'feedback.md');
  const projectMap = join(root, 'project-map.json');
  await writeFile(en, document('en'));
  await writeFile(zh, document('zh-CN').replace(/<!-- project-lifecycle:section coverage -->[\s\S]*$/u, ''));
  await writeFile(projectMap, JSON.stringify(map));

  const result = await runCli(['validate-alignment-feedback', en, zh, projectMap]);
  assert.equal(result.status, 1);
  assert.equal(envelope(result).errors[0].code, 'ALIGNMENT_MARKER_INVALID');
});

test('syncs one bounded active projection from an ephemeral absolute input', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-alignment-sync-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'project-lifecycle', 'delivery'), { recursive: true });
  const state = join(root, 'alignment-state.json');
  await writeFile(state, JSON.stringify({
    feedbacks: [{
      frontmatter,
      marker: {
        schema_version: 1,
        classification: 'BUSINESS_IMPLEMENTATION_DIVERGENCE',
        primary_domain_id: 'approval-flow',
      },
      titles: { en: 'Retire legacy approval', 'zh-CN': '废弃旧审批' },
    }],
    owners: [],
    closures: [],
  }));

  const result = await runCli(['sync-alignment-review', '--root', root, '--input', state]);
  assert.equal(result.status, 0);
  assert.deepEqual(envelope(result).value, {
    row_count: 1,
    phases: ['REVIEW_REQUIRED'],
    locators: { en: 'delivery/alignment-review-en.md', 'zh-CN': 'delivery/alignment-review.md' },
  });
  assert.match(await readFile(join(root, 'docs', 'project-lifecycle', 'delivery', 'alignment-review-en.md'), 'utf8'), /feedback-retire-legacy/u);
});

test('rejects an oversized sync envelope without echoing private input', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-alignment-size-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'project-lifecycle', 'delivery'), { recursive: true });
  const state = join(root, 'private-state.json');
  await writeFile(state, JSON.stringify({ private_marker: 'x'.repeat(1_048_577) }));
  const result = await runCli(['sync-alignment-review', '--root', root, '--input', state]);
  assert.equal(result.status, 2);
  assert.equal(envelope(result).errors[0].code, 'CLI_INPUT_TOO_LARGE');
  assert.doesNotMatch(result.stdout, /private_marker/u);
});

test('rejects a structurally incomplete sync envelope instead of treating it as an empty review', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-alignment-shape-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'project-lifecycle', 'delivery'), { recursive: true });
  const projection = join(root, 'docs', 'project-lifecycle', 'delivery', 'alignment-review-en.md');
  await writeFile(projection, 'must remain\n');
  await writeFile(join(root, 'docs', 'project-lifecycle', 'delivery', 'alignment-review.md'), '必须保留\n');
  const state = join(root, 'incomplete-state.json');
  await writeFile(state, '{}\n');

  const result = await runCli(['sync-alignment-review', '--root', root, '--input', state]);
  assert.equal(result.status, 2);
  assert.equal(envelope(result).errors[0].code, 'CLI_INPUT_INVALID');
  assert.equal(await readFile(projection, 'utf8'), 'must remain\n');
});
