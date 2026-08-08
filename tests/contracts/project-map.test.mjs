import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { validateJson } from '../../scripts/lib/validate-json.mjs';

const fixture = async (name) => JSON.parse(
  await readFile(new URL(`../fixtures/contracts/project-map/${name}`, import.meta.url), 'utf8'),
);

const run = (command, args, { timeoutMs = 5_000, ...options } = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, options);
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status, signal) => {
    clearTimeout(timer);
    resolve({ signal, status, stderr, stdout, timedOut });
  });
});

const runCli = (args) => run(process.execPath, [
  'scripts/bin/project-lifecycle.mjs',
  'validate-json',
  ...args,
], { cwd: new URL('../..', import.meta.url) });

test('accepts the minimal valid project map', async () => {
  const result = validateJson('project-map', await fixture('valid.json'));

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

for (const [name, code, path] of [
  ['id-with-parent-path.json', 'SCHEMA_INVALID', '/domains/0/id'],
  ['missing-zh.json', 'SCHEMA_INVALID', '/domains/0/label/zh-CN'],
  ['materialized-without-assets.json', 'STATE_REQUIREMENT_MISSING', '/domains/0/paired_assets'],
  ['retired-without-reason.json', 'STATE_REQUIREMENT_MISSING', '/domains/0/retirement_reason'],
  ['broken-parent.json', 'REFERENCE_MISSING', '/domains/0/parent_id'],
  ['duplicate-domain-id.json', 'ID_DUPLICATE', '/domains/1/id'],
  ['generic-related-to.json', 'SCHEMA_INVALID', '/domains/0/relationships/0/kind'],
  ['unknown-field.json', 'SCHEMA_INVALID', '/unexpected'],
  ['non-empty-identity-lineage.json', 'SCHEMA_INVALID', '/identity_lineage'],
  ['non-empty-repositories.json', 'SCHEMA_INVALID', '/repositories'],
]) {
  test(`rejects ${name} at its contract path`, async () => {
    const result = validateJson('project-map', await fixture(name));

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === code && error.path === path));
  });
}

test('rejects a pointer without resolved project-map context', () => {
  const result = validateJson('project-pointer', {
    schema_version: 1,
    project_id: 'sample-app',
    repository_id: 'sample-repository',
    governance_locator: './project-map.json',
  });

  assert.deepEqual(result.errors, [{
    code: 'REFERENCE_MISSING',
    path: '/governance_locator',
    message: 'Project pointer validation requires a resolved project map.',
  }]);
});

test('validates a pointer whose locally resolved map has the same project_id', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-pointer-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(join(directory, 'project-map.json'), JSON.stringify({ project_id: 'sample-app' }));
  const pointerFile = join(directory, 'project-pointer.json');
  await writeFile(pointerFile, JSON.stringify({
    schema_version: 1,
    project_id: 'sample-app',
    repository_id: 'sample-repository',
    governance_locator: './project-map.json',
  }));

  const result = await runCli(['project-pointer', pointerFile]);

  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('CLI rejects a pointer whose resolved map has another project_id', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-pointer-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const mapFile = join(directory, 'project-map.json');
  const pointerFile = join(directory, 'project-pointer.json');
  await writeFile(mapFile, JSON.stringify({ project_id: 'another-project' }));
  await writeFile(pointerFile, JSON.stringify({
    schema_version: 1,
    project_id: 'sample-app',
    repository_id: 'sample-repository',
    governance_locator: './project-map.json',
  }));

  const result = await runCli(['project-pointer', pointerFile]);

  assert.equal(result.stderr, '');
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).errors.some((error) => (
    error.code === 'REFERENCE_MISSING' && error.path === '/project_id'
  )));
});

for (const locator of ['./missing-project-map.json', 'https://example.test/project-map.json']) {
  test(`CLI reports a stable missing-locator error for ${locator}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-pointer-'));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const pointerFile = join(directory, 'project-pointer.json');
    await writeFile(pointerFile, JSON.stringify({
      schema_version: 1,
      project_id: 'sample-app',
      repository_id: 'sample-repository',
      governance_locator: locator,
    }));

    const result = await runCli(['project-pointer', pointerFile]);

    assert.equal(result.stderr, '');
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).errors, [{
      code: 'REFERENCE_MISSING',
      path: '/governance_locator',
      message: 'Unable to resolve governance locator.',
    }]);
  });
}

test('rejects relationship targets that are absent from the map', async () => {
  const value = await fixture('valid.json');
  value.domains[0].relationships.push({ kind: 'depends_on', target_id: 'missing-domain' });

  const result = validateJson('project-map', value);

  assert.ok(result.errors.some((error) => (
    error.code === 'REFERENCE_MISSING' && error.path === '/domains/0/relationships/0/target_id'
  )));
});

test('rejects a child scope that is not a strict subset of its parent', async () => {
  const value = await fixture('valid.json');
  value.domains.push({
    ...value.domains[0],
    id: 'desktop-child',
    label: { en: 'Desktop child', 'zh-CN': '桌面子项' },
    purpose: { en: 'Owns desktop interaction', 'zh-CN': '负责桌面交互' },
    parent_id: 'desktop-experience',
  });

  const result = validateJson('project-map', value);

  assert.ok(result.errors.some((error) => (
    error.code === 'SCHEMA_INVALID' && error.path === '/domains/1/scope/includes'
  )));
});

test('rejects selected descendants outside the constraint owner subtree', async () => {
  const value = await fixture('valid.json');
  value.domains.push({
    ...value.domains[0],
    id: 'other-domain',
    label: { en: 'Other domain', 'zh-CN': '其他领域' },
    purpose: { en: 'Owns other interaction', 'zh-CN': '负责其他交互' },
    scope: { includes: ['other interaction'], excludes: [] },
  });
  value.constraints.push({
    id: 'desktop-selection',
    scope: 'selected_descendants',
    owner_id: 'desktop-experience',
    selected_descendants: ['other-domain'],
  });

  const result = validateJson('project-map', value);

  assert.ok(result.errors.some((error) => (
    error.code === 'SCHEMA_INVALID' && error.path === '/constraints/0/selected_descendants/0'
  )));
});

test('rejects unknown fields in specified constraint objects', async () => {
  const value = await fixture('valid.json');
  value.constraints.push({
    id: 'desktop-selection',
    scope: 'self',
    unexpected: true,
  });

  const result = validateJson('project-map', value);

  assert.ok(result.errors.some((error) => (
    error.code === 'SCHEMA_INVALID' && error.path === '/constraints/0/unexpected'
  )));
});

test('terminates and rejects cyclic parent graphs during selected-descendant validation', async () => {
  const cyclicFixture = new URL('../fixtures/contracts/project-map/cyclic-parents.json', import.meta.url);
  const script = [
    "import { readFileSync } from 'node:fs';",
    "import { validateJson } from './scripts/lib/validate-json.mjs';",
    "console.log(JSON.stringify(validateJson('project-map', JSON.parse(readFileSync(process.argv[1], 'utf8')))));",
  ].join(' ');
  const result = await run(process.execPath, ['--input-type=module', '--eval', script, cyclicFixture.pathname], {
    cwd: new URL('../..', import.meta.url),
    timeoutMs: 250,
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.status, 0);
  assert.ok(JSON.parse(result.stdout).errors.some((error) => (
    error.code === 'SCHEMA_INVALID' && error.path === '/constraints/0/selected_descendants/0'
  )));
});

test('validates project extension IDs in current-project sorted order', () => {
  const result = validateJson('project-extensions', {
    schema_version: 1,
    project_id: 'sample-app',
    registry_revision: 1,
    secondary_obligation_kinds: [
      'PROJECT::sample-app::ALPHA_REQUIRED',
      'PROJECT::sample-app::BETA_REQUIRED',
    ],
  });

  assert.equal(result.ok, true);
});

for (const [entry, path] of [
  ['PROJECT::another-app::ALPHA_REQUIRED', '/secondary_obligation_kinds/0'],
  ['PROJECT::sample-app::ALPHA_OPTIONAL', '/secondary_obligation_kinds/0'],
  ['PROJECT::sample-app::ALPHA_REQUIRED', '/secondary_obligation_kinds/1'],
]) {
  test(`rejects invalid project extension entry ${entry}`, () => {
    const extensions = entry === 'PROJECT::sample-app::ALPHA_REQUIRED'
      ? ['PROJECT::sample-app::BETA_REQUIRED', entry]
      : [entry];
    const result = validateJson('project-extensions', {
      schema_version: 1,
      project_id: 'sample-app',
      registry_revision: 1,
      secondary_obligation_kinds: extensions,
    });

    assert.ok(result.errors.some((error) => error.code === 'SCHEMA_INVALID' && error.path === path));
  });
}
