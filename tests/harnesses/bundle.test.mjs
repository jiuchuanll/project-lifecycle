import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
const run = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: 'utf8' });
const envelope = (result) => {
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  return JSON.parse(result.stdout);
};

test('runs the bundled validator from a clean managed-plugin copy without node_modules', async (context) => {
  assert.equal(packageJson.bin['project-lifecycle'], './bin/project-lifecycle');
  const install = await mkdtemp(join(tmpdir(), 'project-lifecycle-bundle-'));
  context.after(() => rm(install, { recursive: true, force: true }));
  for (const path of ['dist/project-lifecycle.mjs', 'bin/project-lifecycle']) {
    await mkdir(dirname(join(install, path)), { recursive: true });
    await copyFile(join(repositoryRoot, path), join(install, path));
  }
  await chmod(join(install, 'bin/project-lifecycle'), 0o755);
  await cp(join(repositoryRoot, 'skills'), join(install, 'skills'), { recursive: true });
  for (const directory of ['.codex-plugin', '.claude-plugin', '.cursor-plugin', '.kimi-plugin', '.zcode-plugin']) {
    await cp(join(repositoryRoot, directory), join(install, directory), { recursive: true });
  }
  const fixtures = join(install, 'fixtures');
  await mkdir(fixtures);
  await copyFile(
    join(repositoryRoot, 'tests/fixtures/contracts/handoffs/context-receipt.valid.json'),
    join(fixtures, 'valid.json'),
  );
  await writeFile(join(fixtures, 'invalid.json'), '{}\n');
  const alignmentFrontmatter = {
    schema_version: 2,
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
  const alignmentBody = (language) => `# ${language === 'en' ? 'Retire legacy approval' : '废弃旧审批'}

<!-- project-lifecycle:section original_problem -->
## Problem
Legacy.
<!-- /project-lifecycle:section -->
<!-- project-lifecycle:section scenario -->
## Scenario
Bootstrap.
<!-- /project-lifecycle:section -->
<!-- project-lifecycle:section expectation -->
## Expectation
Retire.
<!-- /project-lifecycle:section -->
<!-- project-lifecycle:section marking -->
## Marking
<!-- project-lifecycle:alignment
schema_version: 1
classification: BUSINESS_IMPLEMENTATION_DIVERGENCE
primary_domain_id: approval-flow
-->
<!-- /project-lifecycle:section -->
<!-- project-lifecycle:section coverage -->
## Coverage
Open.
<!-- /project-lifecycle:section -->
`;
  for (const language of ['en', 'zh-CN']) {
    await writeFile(
      join(fixtures, language === 'en' ? 'alignment-en.md' : 'alignment.md'),
      `---\n${JSON.stringify(alignmentFrontmatter)}\n---\n${alignmentBody(language)}`,
    );
  }
  await writeFile(join(fixtures, 'project-map.json'), JSON.stringify({
    schema_version: 2,
    project_id: 'sample-project',
    identity_lineage: [], repositories: [], constraints: [],
    domains: [{
      id: 'approval-flow', kind: 'domain',
      label: { en: 'Approval flow', 'zh-CN': '审批流程' },
      purpose: { en: 'Owns approval.', 'zh-CN': '负责审批。' },
      domain_state: 'confirmed', scope: { includes: ['approval'], excludes: [] },
      parent_id: null, relationships: [], evidence_refs: ['repo:README.md'], known_gaps: [],
    }],
  }));
  const project = join(install, 'project');
  const projectDelivery = join(project, 'docs', 'project-lifecycle', 'delivery');
  await mkdir(join(projectDelivery, 'feedback'), { recursive: true });
  await writeFile(join(projectDelivery, 'layout.json'), '{"schema_version":1,"layout_version":2}\n');
  await copyFile(join(fixtures, 'alignment-en.md'), join(projectDelivery, 'feedback', 'feedback-retire-legacy-en.md'));
  await copyFile(join(fixtures, 'alignment.md'), join(projectDelivery, 'feedback', 'feedback-retire-legacy.md'));
  const alignmentState = join(fixtures, 'alignment-state.json');
  await writeFile(alignmentState, JSON.stringify({
    feedbacks: [{
      frontmatter: alignmentFrontmatter,
      marker: {
        schema_version: 1,
        classification: 'BUSINESS_IMPLEMENTATION_DIVERGENCE',
        primary_domain_id: 'approval-flow',
      },
      titles: { en: 'Retire legacy approval', 'zh-CN': '废弃旧审批' },
    }],
    owners: [], closures: [],
  }));
  assert.equal(await readFile(join(install, 'node_modules'), 'utf8').catch(() => null), null);

  const help = run(process.execPath, ['dist/project-lifecycle.mjs', 'help'], install);
  assert.equal(help.status, 0);
  assert.equal(envelope(help).ok, true);

  const valid = run(join(install, 'bin/project-lifecycle'), [
    'validate-json', 'context-receipt', 'fixtures/valid.json',
  ], install);
  assert.equal(valid.status, 0);
  assert.equal(envelope(valid).ok, true);

  const invalid = run(join(install, 'bin/project-lifecycle'), [
    'validate-json', 'context-receipt', 'fixtures/invalid.json',
  ], install);
  assert.equal(invalid.status, 1);
  assert.equal(envelope(invalid).errors[0].code, 'SCHEMA_INVALID');

  const alignment = run(join(install, 'bin/project-lifecycle'), [
    'validate-alignment-feedback',
    'fixtures/alignment-en.md',
    'fixtures/alignment.md',
    'fixtures/project-map.json',
  ], install);
  assert.equal(alignment.status, 0);
  assert.equal(envelope(alignment).value.feedback_id, 'feedback-retire-legacy');

  const sync = run(join(install, 'bin/project-lifecycle'), [
    'sync-alignment-review', '--root', project, '--input', alignmentState,
  ], install);
  assert.equal(sync.status, 0);
  assert.equal(envelope(sync).value.row_count, 1);
  assert.match(await readFile(join(project, 'docs', 'project-lifecycle', 'delivery', 'views', 'alignment-review-en.md'), 'utf8'), /feedback-retire-legacy/u);

  const expectedDeliveryCommands = [
    'inspect-delivery-layout',
    'preview-delivery-layout-migration',
    'migrate-delivery-layout',
    'validate-delivery-layout',
    'materialize-delivery-asset',
    'close-delivery',
    'generate-delivery-indexes',
  ];
  assert.ok(expectedDeliveryCommands.every((name) => envelope(help).value.commands.includes(name)));
  for (const [name, args] of [
    ['inspect-delivery-layout', ['--root', project]],
    ['validate-delivery-layout', ['--root', project]],
    ['generate-delivery-indexes', ['--root', project]],
  ]) {
    const result = run(join(install, 'bin/project-lifecycle'), [name, ...args], install);
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    assert.equal(envelope(result).ok, true);
  }

  const invalidEnvelope = join(fixtures, 'invalid-delivery-command.json');
  await writeFile(invalidEnvelope, '{}\n');
  for (const name of ['materialize-delivery-asset', 'close-delivery']) {
    const result = run(join(install, 'bin/project-lifecycle'), [
      name, '--root', project, '--input', invalidEnvelope,
    ], install);
    assert.equal(result.status, 1);
    assert.equal(envelope(result).ok, false);
  }

  const legacy = join(install, 'legacy-project');
  const legacyDelivery = join(legacy, 'docs/project-lifecycle/delivery');
  await mkdir(legacyDelivery, { recursive: true });
  const legacyFrontmatter = { ...alignmentFrontmatter, schema_version: 1 };
  for (const language of ['en', 'zh-CN']) {
    await writeFile(
      join(legacyDelivery, `feedback-retire-legacy${language === 'en' ? '-en' : ''}.md`),
      `---\n${JSON.stringify(legacyFrontmatter)}\n---\n# ${language}\n`,
    );
  }
  const previewInput = join(fixtures, 'delivery-preview.json');
  await writeFile(previewInput, '{"owner_mappings":[]}\n');
  const previewCommand = run(join(install, 'bin/project-lifecycle'), [
    'preview-delivery-layout-migration', '--root', legacy, '--input', previewInput,
  ], install);
  assert.equal(previewCommand.status, 0, previewCommand.stdout);
  const previewValue = envelope(previewCommand).value;
  const migrationInput = join(fixtures, 'delivery-migration.json');
  await writeFile(migrationInput, JSON.stringify({
    owner_mappings: [],
    plan_hash: previewValue.plan_hash,
    source_fingerprint: previewValue.source_fingerprint,
    approval_ref: 'approval:bundle-migration',
    backup_ref: 'backup:bundle-migration',
  }));
  const migrationCommand = run(join(install, 'bin/project-lifecycle'), [
    'migrate-delivery-layout', '--root', legacy, '--input', migrationInput,
  ], install);
  assert.equal(migrationCommand.status, 0, migrationCommand.stdout);
  assert.equal(envelope(migrationCommand).value.layout_version, 2);
});

test('keeps the legacy CLI path dependency-free in a managed-plugin cache', async (context) => {
  const install = await mkdtemp(join(tmpdir(), 'project-lifecycle-cache-entry-'));
  context.after(() => rm(install, { recursive: true, force: true }));
  await cp(join(repositoryRoot, 'scripts'), join(install, 'scripts'), { recursive: true });
  await mkdir(join(install, 'dist'), { recursive: true });
  await copyFile(
    join(repositoryRoot, 'dist/project-lifecycle.mjs'),
    join(install, 'dist/project-lifecycle.mjs'),
  );
  assert.equal(await readFile(join(install, 'node_modules'), 'utf8').catch(() => null), null);

  const version = run(join(install, 'scripts/bin/project-lifecycle.mjs'), ['version'], install);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(envelope(version).value.version, packageJson.version);
});
