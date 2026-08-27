import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { bootstrap } from '../../scripts/knowledge/bootstrap.mjs';
import { collectEvidence } from '../../scripts/knowledge/collect-evidence.mjs';
import { atomicWriteValidated } from '../../scripts/lib/atomic-write.mjs';
import { validateJson } from '../../scripts/lib/validate-json.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureRoot = fileURLToPath(new URL(
  '../fixtures/knowledge/bootstrap/sample-app',
  import.meta.url,
));
const fixturePolicyPath = fileURLToPath(new URL(
  '../fixtures/knowledge/bootstrap/fixture-policy.json',
  import.meta.url,
));
const projectMapAssetPath = fileURLToPath(new URL(
  '../../skills/maintain-project-knowledge/assets/project-map.json',
  import.meta.url,
));
const pendingChangesAssetPath = fileURLToPath(new URL(
  '../../skills/maintain-project-knowledge/assets/pending-changes.json',
  import.meta.url,
));
const deliveryLayoutAssetPath = fileURLToPath(new URL(
  '../../skills/maintain-project-knowledge/assets/delivery-layout.json',
  import.meta.url,
));

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const runCli = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/bin/project-lifecycle-source.mjs', ...args], {
    cwd: repositoryRoot,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stderr, stdout }));
});

const assertSingleEnvelope = (result) => {
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(envelope), ['ok', 'value', 'errors']);
  return envelope;
};

const absent = async (path) => {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
};

const createTemporaryRoot = async (context, prefix = 'project-lifecycle-knowledge-') => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const copyFixture = async (context) => {
  const parent = await createTemporaryRoot(context);
  const root = join(parent, 'sample-app');
  await cp(fixtureRoot, root, { recursive: true });
  return root;
};

const copyFixtureWithStressFiles = async (context) => {
  const root = await copyFixture(context);
  const sourceRoot = join(root, 'src');
  for (let index = 1; index <= 200; index += 1) {
    const suffix = String(index).padStart(3, '0');
    await writeFile(
      join(sourceRoot, `stress-${suffix}.mjs`),
      `IRRELEVANT_SOURCE_BODY_${suffix}\n`,
    );
  }
  const stressFiles = (await readdir(sourceRoot))
    .filter((name) => /^stress-[0-9]{3}\.mjs$/u.test(name));
  assert.equal(stressFiles.length, 200);
  return root;
};

const validBootstrapInput = (root) => ({
  root,
  project_id: 'sample-application',
  label: { en: 'Sample Application', 'zh-CN': '示例应用' },
  purpose: {
    en: 'Provides a deterministic bootstrap fixture.',
    'zh-CN': '提供确定性的引导测试夹具。',
  },
  calibration_ref: 'calibration:initial-user-approval',
  calibration_approved: true,
  domains: [{
    id: 'desktop-experience',
    kind: 'domain',
    label: { en: 'Desktop experience', 'zh-CN': '桌面体验' },
    purpose: { en: 'Owns desktop interaction.', 'zh-CN': '负责桌面交互。' },
    domain_state: 'confirmed',
    scope: { includes: ['desktop interaction'], excludes: [] },
    parent_id: null,
    relationships: [],
    evidence_refs: ['repo:README.md'],
    known_gaps: ['No verified capability asset yet'],
  }],
});

const listTree = async (root, prefix = '') => {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    paths.push(`${relativePath}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory()) paths.push(...await listTree(root, relativePath));
  }
  return paths;
};

test('collects exactly the fixture-approved evidence without reading noisy source bodies', async () => {
  const policy = await readJson(fixturePolicyPath);
  const pack = await collectEvidence({ root: fixtureRoot, limits: policy.limits });

  assert.deepEqual(Object.keys(pack), ['schema_version', 'entries']);
  assert.equal(pack.schema_version, 1);
  assert.deepEqual(
    pack.entries.map(({ kind, locator }) => `${kind}:${locator}`),
    policy.allowed_entries,
  );

  const serialized = JSON.stringify(pack);
  for (const marker of policy.forbidden_markers) {
    assert.equal(serialized.includes(marker), false, `must exclude ${marker}`);
  }
  assert.equal(serialized.includes('Approved architecture index marker.'), true);
  assert.equal(serialized.includes('Use the bounded fixture contract.'), true);
  assert.equal(serialized.includes('domain_name'), false);
  assert.equal(serialized.includes('confidence'), false);
  assert.equal(serialized.includes('conclusion'), false);
});

test('returns deterministic ordering and hashes from observed evidence only', async () => {
  const policy = await readJson(fixturePolicyPath);
  const first = await collectEvidence({ root: fixtureRoot, limits: policy.limits });
  const second = await collectEvidence({ root: fixtureRoot, limits: policy.limits });

  assert.deepEqual(second, first);
  for (const entry of first.entries) {
    const expected = `sha256:${createHash('sha256')
      .update(JSON.stringify(entry.observed))
      .digest('hex')}`;
    assert.equal(entry.content_hash, expected);
    assert.match(entry.content_hash, /^sha256:[0-9a-f]{64}$/u);
  }
  const instruction = first.entries.find(({ locator }) => locator === 'repo:AGENTS.md');
  assert.equal(
    instruction.content_hash,
    'sha256:d76982816c9ea42b4f7113228075ab55e61ad025da45c006f3da0cf71c0c9395',
  );
});

test('caps recent evolution and topology entries with explicit caller limits', async (context) => {
  const root = await copyFixture(context);
  await rm(join(root, 'src'), { recursive: true });
  await rm(join(root, 'test'), { recursive: true });
  for (const directory of ['apps', 'core', 'modules', 'packages']) {
    await mkdir(join(root, directory));
  }
  const pack = await collectEvidence({
    root,
    limits: {
      maxFileBytes: 48,
      maxTopologyEntries: 3,
      maxRecentEvolutionEntries: 1,
    },
  });

  assert.deepEqual(
    pack.entries.filter(({ kind }) => kind === 'recent_evolution').map(({ locator }) => locator),
    ['repo:CHANGELOG.md#2.0.0'],
  );
  assert.equal(pack.entries.filter(({ kind }) => kind === 'topology').length, 3);
  for (const entry of pack.entries.filter(({ observed }) => 'content' in observed)) {
    assert.equal(Buffer.byteLength(entry.observed.content) <= 48, true);
  }
});

test('fails deterministically when direct topology metadata exceeds the scan budget', async (context) => {
  const root = await copyFixtureWithStressFiles(context);

  await assert.rejects(
    collectEvidence({
      root,
      limits: {
        maxFileBytes: 4096,
        maxTopologyEntries: 20,
        maxRecentEvolutionEntries: 2,
      },
    }),
    (error) => {
      assert.equal(error.code, 'EVIDENCE_SCAN_LIMIT_EXCEEDED');
      assert.equal(error.message, 'Topology metadata scan limit exceeded.');
      assert.equal(error.message.includes(root), false);
      return true;
    },
  );
});

test('fails when topology metadata exceeds the global budget across bounded directories', async (context) => {
  const root = await createTemporaryRoot(context);
  for (const relativePath of ['apps/alpha', 'apps/beta', 'core/gamma', 'core/delta']) {
    await mkdir(join(root, relativePath), { recursive: true });
  }

  await assert.rejects(
    collectEvidence({ root, limits: { maxTopologyEntries: 3 } }),
    { code: 'EVIDENCE_SCAN_LIMIT_EXCEEDED' },
  );
});

test('skips file and directory symlinks instead of reading outside the repository', async (context) => {
  const root = await copyFixture(context);
  const outside = await createTemporaryRoot(context, 'project-lifecycle-outside-');
  await writeFile(join(outside, 'README.md'), 'OUTSIDE_SYMLINK_BODY_MARKER\n');
  await mkdir(join(outside, 'product'));
  await writeFile(join(outside, 'product', 'INDEX.md'), 'OUTSIDE_INDEX_MARKER\n');
  await rm(join(root, 'README.md'));
  await rm(join(root, 'docs', 'product'), { recursive: true });
  await symlink(join(outside, 'README.md'), join(root, 'README.md'));
  await symlink(join(outside, 'product'), join(root, 'docs', 'product'));

  const pack = await collectEvidence({ root });
  const serialized = JSON.stringify(pack);
  assert.equal(pack.entries.some(({ locator }) => locator === 'repo:README.md'), false);
  assert.equal(pack.entries.some(({ locator }) => locator === 'repo:docs/product/INDEX.md'), false);
  assert.equal(serialized.includes('OUTSIDE_SYMLINK_BODY_MARKER'), false);
  assert.equal(serialized.includes('OUTSIDE_INDEX_MARKER'), false);
});

test('rejects a relative reconnaissance root before reading it', async () => {
  await assert.rejects(
    collectEvidence({ root: 'tests/fixtures/knowledge/bootstrap/sample-app' }),
    { code: 'EVIDENCE_ROOT_ABSOLUTE_REQUIRED' },
  );
});

test('collect-evidence CLI writes one deterministic pack and emits one redacted envelope', async (context) => {
  const outputDirectory = await createTemporaryRoot(context);
  const output = join(outputDirectory, 'evidence-pack.json');
  const args = ['collect-evidence', '--root', fixtureRoot, '--output', output];

  const first = await runCli(args);
  const firstEnvelope = assertSingleEnvelope(first);
  const firstOutput = await readFile(output, 'utf8');
  const second = await runCli(args);
  const secondEnvelope = assertSingleEnvelope(second);
  const secondOutput = await readFile(output, 'utf8');

  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.deepEqual(secondEnvelope, firstEnvelope);
  assert.equal(secondOutput, firstOutput);
  assert.equal(firstOutput.endsWith('\n'), true);
  assert.equal(JSON.parse(firstOutput).schema_version, 1);
  assert.equal(first.stdout.includes(fixtureRoot), false);
  assert.equal(first.stdout.includes(output), false);
});

test('collect-evidence CLI validates required, absolute, and bounded output options', async (context) => {
  const root = await copyFixture(context);
  const forbiddenOutput = join(root, 'docs', 'project-lifecycle', 'evidence.json');
  const cases = [
    {
      args: ['collect-evidence', '--root', fixtureRoot],
      code: 'CLI_USAGE',
    },
    {
      args: ['collect-evidence', '--root', 'relative-root', '--output', join(tmpdir(), 'pack.json')],
      code: 'CLI_PATH_INVALID',
    },
    {
      args: ['collect-evidence', '--root', root, '--output', forbiddenOutput],
      code: 'CLI_OUTPUT_FORBIDDEN',
    },
    {
      args: ['collect-evidence', '--root', fixtureRoot, '--output', join(tmpdir(), 'pack.json'), '--extra'],
      code: 'CLI_USAGE',
    },
  ];

  for (const entry of cases) {
    const result = await runCli(entry.args);
    const envelope = assertSingleEnvelope(result);
    assert.equal(result.status, 2);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.errors[0].code, entry.code);
    assert.equal(result.stdout.includes(fixtureRoot), false);
    assert.equal(result.stdout.includes(forbiddenOutput), false);
  }
  await absent(forbiddenOutput);
});

test('collect-evidence CLI rejects output through a symlinked lifecycle root', async (context) => {
  const root = await copyFixture(context);
  const outside = await createTemporaryRoot(context, 'project-lifecycle-outside-');
  const lifecycleRoot = join(root, 'docs', 'project-lifecycle');
  await rm(lifecycleRoot, { recursive: true });
  await symlink(outside, lifecycleRoot);
  const output = join(lifecycleRoot, 'evidence.json');

  const result = await runCli(['collect-evidence', '--root', root, '--output', output]);
  const envelope = assertSingleEnvelope(result);

  assert.equal(result.status, 2);
  assert.equal(envelope.errors[0].code, 'CLI_OUTPUT_FORBIDDEN');
  await absent(join(outside, 'evidence.json'));
});

test('collect-evidence CLI rejects a lexical lifecycle output through an inner symlink', async (context) => {
  const root = await copyFixture(context);
  const outside = await createTemporaryRoot(context, 'project-lifecycle-outside-');
  const lifecycleRoot = join(root, 'docs', 'project-lifecycle');
  const link = join(lifecycleRoot, 'link');
  await symlink(outside, link);
  const output = join(link, 'private-output-marker.json');

  const result = await runCli(['collect-evidence', '--root', root, '--output', output]);
  const envelope = assertSingleEnvelope(result);

  assert.equal(result.status, 2);
  assert.equal(envelope.errors[0].code, 'CLI_OUTPUT_FORBIDDEN');
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes(outside), false);
  assert.equal(result.stdout.includes('private-output-marker'), false);
  await absent(join(outside, 'private-output-marker.json'));
});

test('collect-evidence CLI independently rejects a physical output inside the lifecycle root', async (context) => {
  const root = await copyFixture(context);
  const outside = await createTemporaryRoot(context, 'project-lifecycle-outside-');
  const lifecycleRoot = join(root, 'docs', 'project-lifecycle');
  const alias = join(outside, 'lifecycle-alias');
  await symlink(lifecycleRoot, alias);
  const output = join(alias, 'physical-output-marker.json');

  const result = await runCli(['collect-evidence', '--root', root, '--output', output]);
  const envelope = assertSingleEnvelope(result);

  assert.equal(result.status, 2);
  assert.equal(envelope.errors[0].code, 'CLI_OUTPUT_FORBIDDEN');
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes(outside), false);
  assert.equal(result.stdout.includes('physical-output-marker'), false);
  await absent(join(lifecycleRoot, 'physical-output-marker.json'));
});

test('collect-evidence CLI reports scan overflow without leaking paths or writing output', async (context) => {
  const root = await copyFixtureWithStressFiles(context);
  const outputDirectory = await createTemporaryRoot(context);
  const output = join(outputDirectory, 'overflow-output-marker.json');

  const result = await runCli(['collect-evidence', '--root', root, '--output', output]);
  const envelope = assertSingleEnvelope(result);

  assert.equal(result.status, 2);
  assert.equal(envelope.errors[0].code, 'EVIDENCE_SCAN_LIMIT_EXCEEDED');
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes(output), false);
  assert.equal(result.stdout.includes('IRRELEVANT_SOURCE_BODY_'), false);
  await absent(output);
});

test('bootstrap assets are valid inert Phase 1 bases', async () => {
  const map = await readJson(projectMapAssetPath);
  const pending = await readJson(pendingChangesAssetPath);
  const deliveryLayout = await readJson(deliveryLayoutAssetPath);

  assert.equal(validateJson('project-map', map).ok, true);
  assert.equal(validateJson('pending-changes', pending).ok, true);
  assert.equal(validateJson('delivery-layout', deliveryLayout).ok, true);
  assert.deepEqual(map.domains, []);
  assert.deepEqual(pending.changes, []);
  assert.deepEqual(deliveryLayout, { schema_version: 1, layout_version: 2 });
});

test('bootstrap requires a calibration reference and explicit approval before writing', async (context) => {
  for (const override of [
    { calibration_ref: '' },
    { calibration_approved: false },
  ]) {
    const root = await createTemporaryRoot(context);
    const result = await bootstrap({ ...validBootstrapInput(root), ...override });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'BOOTSTRAP_CALIBRATION_REQUIRED');
    await absent(join(root, 'docs', 'project-lifecycle'));
  }
});

test('bootstrap rejects incomplete bilingual identity and unconfirmed domain skeletons', async (context) => {
  const identityRoot = await createTemporaryRoot(context);
  const identityInput = validBootstrapInput(identityRoot);
  identityInput.label = { en: 'English only' };
  const identityResult = await bootstrap(identityInput);
  assert.equal(identityResult.ok, false);
  assert.equal(identityResult.errors[0].code, 'BOOTSTRAP_INPUT_INVALID');
  await absent(join(identityRoot, 'docs', 'project-lifecycle'));

  const domainRoot = await createTemporaryRoot(context);
  const domainInput = validBootstrapInput(domainRoot);
  domainInput.domains[0].domain_state = 'materialized';
  const domainResult = await bootstrap(domainInput);
  assert.equal(domainResult.ok, false);
  assert.equal(domainResult.errors[0].code, 'BOOTSTRAP_DOMAIN_NOT_CONFIRMED');
  await absent(join(domainRoot, 'docs', 'project-lifecycle'));
});

test('bootstrap creates only the calibrated fixed-root skeleton and paired indexes', async (context) => {
  const root = await createTemporaryRoot(context);
  const input = validBootstrapInput(root);
  const result = await bootstrap(input);
  const lifecycleRoot = join(root, 'docs', 'project-lifecycle');

  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'created');
  assert.deepEqual(await listTree(lifecycleRoot), [
    'delivery/',
    'delivery/INDEX-en.md',
    'delivery/INDEX.md',
    'delivery/layout.json',
    'INDEX-en.md',
    'INDEX.md',
    'knowledge/',
    'knowledge/INDEX-en.md',
    'knowledge/INDEX.md',
    'pending-changes.json',
    'project-map.json',
  ]);

  const map = await readJson(join(lifecycleRoot, 'project-map.json'));
  const pending = await readJson(join(lifecycleRoot, 'pending-changes.json'));
  const deliveryLayout = await readJson(join(lifecycleRoot, 'delivery/layout.json'));
  const englishDeliveryIndex = await readFile(join(lifecycleRoot, 'delivery/INDEX-en.md'), 'utf8');
  const chineseDeliveryIndex = await readFile(join(lifecycleRoot, 'delivery/INDEX.md'), 'utf8');
  const englishIndex = await readFile(join(lifecycleRoot, 'INDEX-en.md'), 'utf8');
  const chineseIndex = await readFile(join(lifecycleRoot, 'INDEX.md'), 'utf8');
  const englishKnowledgeIndex = await readFile(join(lifecycleRoot, 'knowledge/INDEX-en.md'), 'utf8');
  const chineseKnowledgeIndex = await readFile(join(lifecycleRoot, 'knowledge/INDEX.md'), 'utf8');
  assert.equal(validateJson('project-map', map).ok, true);
  assert.equal(validateJson('pending-changes', pending).ok, true);
  assert.equal(validateJson('delivery-layout', deliveryLayout).ok, true);
  assert.equal(map.project_id, input.project_id);
  assert.equal(map.knowledge_baseline, input.calibration_ref);
  assert.deepEqual(map.project_identity, {
    label: input.label,
    purpose: input.purpose,
    calibration_ref: input.calibration_ref,
  });
  assert.deepEqual(map.domains[0].evidence_refs, [
    'calibration:initial-user-approval',
    'repo:README.md',
  ]);
  assert.deepEqual(pending, { schema_version: 1, changes: [] });
  assert.deepEqual(deliveryLayout, { schema_version: 1, layout_version: 2 });
  assert.match(englishDeliveryIndex, /Generated by Project Lifecycle/);
  assert.match(englishDeliveryIndex, /# Delivery/);
  assert.match(chineseDeliveryIndex, /# 交付/);
  for (const [index, language] of [[englishIndex, 'Sample Application'], [chineseIndex, '示例应用']]) {
    assert.equal(index.includes(language), true);
    assert.equal(index.includes(language === 'Sample Application' ? input.purpose.en : input.purpose['zh-CN']), true);
    assert.equal(index.includes(input.calibration_ref), true);
    assert.equal(index.includes('desktop-experience'), false);
  }
  assert.equal(englishKnowledgeIndex.includes('domain:desktop-experience'), true);
  assert.equal(chineseKnowledgeIndex.includes('domain:desktop-experience'), true);
});

test('bootstrap creates confirmed parent navigation without fabricating parent knowledge', async (context) => {
  const root = await createTemporaryRoot(context);
  const input = validBootstrapInput(root);
  input.domains = [
    {
      ...input.domains[0],
      id: 'runtime',
      label: { en: 'Runtime', 'zh-CN': '运行时' },
      purpose: { en: 'Owns runtime.', 'zh-CN': '负责运行时。' },
      scope: { includes: ['runtime', 'tools'], excludes: [] },
    },
    {
      ...input.domains[0],
      id: 'tools',
      label: { en: 'Tools', 'zh-CN': '工具' },
      purpose: { en: 'Owns tools.', 'zh-CN': '负责工具。' },
      scope: { includes: ['tools'], excludes: [] },
      parent_id: 'runtime',
    },
  ];

  const result = await bootstrap(input);

  assert.equal(result.ok, true, JSON.stringify(result));
  const lifecycleRoot = join(root, 'docs/project-lifecycle');
  const tree = await listTree(lifecycleRoot);
  assert.ok(tree.includes('knowledge/runtime/INDEX-en.md'));
  assert.ok(tree.includes('knowledge/runtime/INDEX.md'));
  assert.equal(tree.some((path) => /runtime(?:-en)?\.md$/u.test(path)), false);
  assert.equal(tree.some((path) => /tools(?:-en)?\.md$/u.test(path)), false);
  const runtimeIndex = await readFile(join(lifecycleRoot, 'knowledge/runtime/INDEX-en.md'), 'utf8');
  assert.match(runtimeIndex, /Not materialized\./);
  assert.match(runtimeIndex, /domain:tools/);
});

test('bootstrap is idempotent for an identical map and rejects a conflicting map', async (context) => {
  const root = await createTemporaryRoot(context);
  const input = validBootstrapInput(root);
  const first = await bootstrap(input);
  const lifecycleRoot = join(root, 'docs', 'project-lifecycle');
  const before = await Promise.all([
    readFile(join(lifecycleRoot, 'project-map.json'), 'utf8'),
    readFile(join(lifecycleRoot, 'pending-changes.json'), 'utf8'),
    readFile(join(lifecycleRoot, 'INDEX-en.md'), 'utf8'),
    readFile(join(lifecycleRoot, 'INDEX.md'), 'utf8'),
  ]);
  await writeFile(join(lifecycleRoot, 'knowledge', 'later-knowledge.md'), 'later knowledge\n');
  await writeFile(join(lifecycleRoot, 'delivery', 'later-delivery.md'), 'later delivery\n');

  const second = await bootstrap(input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.value.status, 'existing');
  assert.deepEqual(await Promise.all([
    readFile(join(lifecycleRoot, 'project-map.json'), 'utf8'),
    readFile(join(lifecycleRoot, 'pending-changes.json'), 'utf8'),
    readFile(join(lifecycleRoot, 'INDEX-en.md'), 'utf8'),
    readFile(join(lifecycleRoot, 'INDEX.md'), 'utf8'),
  ]), before);

  const conflicting = await bootstrap({ ...input, project_id: 'different-project' });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.errors[0].code, 'BOOTSTRAP_EXISTING_PROJECT');
  assert.deepEqual(await readJson(join(lifecycleRoot, 'project-map.json')), JSON.parse(before[0]));
});

test('bootstrap treats changed identity prose or calibration as an existing-project conflict', async (context) => {
  const overrides = [
    { label: { en: 'Changed label', 'zh-CN': '变更标签' } },
    {
      purpose: {
        en: 'Changed purpose.',
        'zh-CN': '变更用途。',
      },
    },
    { calibration_ref: 'calibration:different-approval' },
  ];

  for (const override of overrides) {
    const root = await createTemporaryRoot(context);
    const input = validBootstrapInput(root);
    assert.equal((await bootstrap(input)).ok, true);

    const result = await bootstrap({ ...input, ...override });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'BOOTSTRAP_EXISTING_PROJECT');
  }
});

test('bootstrap requires every existing bootstrap artifact to remain complete and valid', async (context) => {
  const cases = [
    {
      name: 'missing knowledge directory',
      mutate: async (root) => rm(join(root, 'knowledge'), { recursive: true }),
    },
    {
      name: 'symlinked delivery directory',
      mutate: async (root, outside) => {
        await rm(join(root, 'delivery'), { recursive: true });
        await symlink(outside, join(root, 'delivery'));
      },
    },
    {
      name: 'missing project map',
      mutate: async (root) => rm(join(root, 'project-map.json')),
    },
    {
      name: 'corrupt pending ledger',
      mutate: async (root) => writeFile(join(root, 'pending-changes.json'), '{}\n'),
    },
    {
      name: 'missing English index',
      mutate: async (root) => rm(join(root, 'INDEX-en.md')),
    },
    {
      name: 'missing delivery English index',
      mutate: async (root) => rm(join(root, 'delivery/INDEX-en.md')),
    },
    {
      name: 'symlinked Chinese index',
      mutate: async (root, outside) => {
        await rm(join(root, 'INDEX.md'));
        await symlink(join(outside, 'INDEX.md'), join(root, 'INDEX.md'));
      },
    },
  ];

  for (const entry of cases) {
    const projectRoot = await createTemporaryRoot(context);
    const outside = await createTemporaryRoot(context, 'project-lifecycle-outside-');
    await writeFile(join(outside, 'INDEX.md'), 'outside index\n');
    const input = validBootstrapInput(projectRoot);
    assert.equal((await bootstrap(input)).ok, true);
    const lifecycleRoot = join(projectRoot, 'docs', 'project-lifecycle');
    await entry.mutate(lifecycleRoot, outside);

    const result = await bootstrap(input);

    assert.equal(result.ok, false, entry.name);
    assert.equal(result.errors[0].code, 'BOOTSTRAP_EXISTING_PROJECT', entry.name);
  }
});

test('bootstrap rejects an existing non-directory lifecycle path with a stable conflict', async (context) => {
  const root = await createTemporaryRoot(context);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'project-lifecycle'), 'not a directory\n');

  const result = await bootstrap(validBootstrapInput(root));

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'BOOTSTRAP_EXISTING_PROJECT');
});

test('bootstrap rejects a symlinked lifecycle root with a stable conflict', async (context) => {
  const root = await createTemporaryRoot(context);
  const outside = await createTemporaryRoot(context, 'project-lifecycle-outside-');
  await mkdir(join(root, 'docs'));
  await symlink(outside, join(root, 'docs', 'project-lifecycle'));

  const result = await bootstrap(validBootstrapInput(root));

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'BOOTSTRAP_EXISTING_PROJECT');
  assert.deepEqual(await readdir(outside), []);
});

test('bootstrap validates every artifact before exposing the lifecycle root', async (context) => {
  const root = await createTemporaryRoot(context);
  const input = validBootstrapInput(root);
  input.domains[0].scope.includes = [];

  const result = await bootstrap(input);

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'SCHEMA_INVALID');
  await absent(join(root, 'docs', 'project-lifecycle'));
  assert.deepEqual(await readdir(root), []);
});

test('bootstrap rejects a symlinked docs parent without writing outside the repository', async (context) => {
  const root = await createTemporaryRoot(context);
  const outside = await createTemporaryRoot(context, 'project-lifecycle-outside-');
  await symlink(outside, join(root, 'docs'));

  const result = await bootstrap(validBootstrapInput(root));

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'PATH_SYMLINK_ESCAPE');
  assert.deepEqual(await readdir(outside), []);
});

test('bootstrap leaves no visible lifecycle root after a controlled late artifact-write failure', async (context) => {
  const root = await createTemporaryRoot(context);
  let writeCount = 0;

  const result = await bootstrap(validBootstrapInput(root), {
    atomicWriteValidated: async (options) => {
      writeCount += 1;
      if (writeCount === 4) {
        const error = new Error('controlled late write failure');
        error.code = 'EACCES';
        throw error;
      }
      return atomicWriteValidated(options);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'BOOTSTRAP_WRITE_FAILED');
  assert.equal(writeCount, 4);
  await absent(join(root, 'docs', 'project-lifecycle'));
  assert.deepEqual(await readdir(root), []);
});

test('bootstrap publishes no partial lifecycle root when the final rename fails', async (context) => {
  const root = await createTemporaryRoot(context);
  const result = await bootstrap(validBootstrapInput(root), {
    rename: async () => {
      const error = new Error('controlled final rename failure');
      error.code = 'EXDEV';
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'BOOTSTRAP_WRITE_FAILED');
  await absent(join(root, 'docs', 'project-lifecycle'));
  assert.deepEqual(await readdir(root), []);
});

test('bootstrap rejects a no-op injected writer and cleans its owned staging root', async (context) => {
  const root = await createTemporaryRoot(context);

  const result = await bootstrap(validBootstrapInput(root), {
    atomicWriteValidated: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'BOOTSTRAP_WRITE_FAILED');
  await absent(join(root, 'docs', 'project-lifecycle'));
  assert.deepEqual(await readdir(root), []);
});

test('bootstrap rejects a no-op injected rename and cleans its owned staging root', async (context) => {
  const root = await createTemporaryRoot(context);

  const result = await bootstrap(validBootstrapInput(root), {
    rename: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'BOOTSTRAP_WRITE_FAILED');
  await absent(join(root, 'docs', 'project-lifecycle'));
  assert.deepEqual(await readdir(root), []);
});
