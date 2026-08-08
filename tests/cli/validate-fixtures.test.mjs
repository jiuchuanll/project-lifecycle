import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureRoot = join(repositoryRoot, 'tests', 'fixtures');

const runCli = (root) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    'scripts/bin/project-lifecycle.mjs',
    'validate-fixtures',
    root,
  ], { cwd: repositoryRoot });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stderr, stdout }));
});

const copyFixtures = async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'project-lifecycle-fixtures-'));
  context.after(() => rm(sandbox, { force: true, recursive: true }));
  const root = join(sandbox, 'fixtures');
  await cp(fixtureRoot, root, { recursive: true });
  return root;
};

test('validates every declared positive and negative fixture in sorted path order', async () => {
  const result = await runCli(fixtureRoot);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.ok(summary.results.some(({ expected_code: code }) => code === 'OK'));
  assert.ok(summary.results.some(({ expected_code: code }) => code !== 'OK'));
  assert.ok(summary.results.every(({ matched }) => matched === true));
  assert.deepEqual(
    summary.results.map(({ path }) => path),
    summary.results.map(({ path }) => path).toSorted(),
  );
});

test('fails when a fixture file is not listed without reading or echoing its contents', async (context) => {
  const root = await copyFixtures(context);
  const unlistedPath = join(root, 'contracts', 'project-map', 'unlisted.json');
  const privateMarker = ['not', 'for', 'output'].join('-');
  await writeFile(unlistedPath, privateMarker);

  const result = await runCli(root);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.errors, [{
    code: 'FIXTURE_UNLISTED',
    path: 'contracts/project-map/unlisted.json',
  }]);
  assert.equal(result.stdout.includes(privateMarker), false);
});

test('fails before validation when manifest fixture paths are duplicated', async (context) => {
  const root = await copyFixtures(context);
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.fixtures.push({ ...manifest.fixtures[0] });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await runCli(root);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.errors, [{
    code: 'FIXTURE_MANIFEST_DUPLICATE',
    path: manifest.fixtures[0].path,
  }]);
  assert.deepEqual(summary.results, []);
});

test('rejects a listed fixture symlink that escapes the explicit fixture root', async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'project-lifecycle-fixture-link-'));
  context.after(() => rm(sandbox, { force: true, recursive: true }));
  const root = join(sandbox, 'fixtures');
  await mkdir(root);
  const outside = join(sandbox, 'outside.json');
  await writeFile(outside, await readFile(join(
    fixtureRoot,
    'contracts',
    'project-map',
    'valid.json',
  )));
  await symlink(outside, join(root, 'linked.json'));
  await writeFile(join(root, 'manifest.json'), JSON.stringify({
    schema_version: 1,
    fixtures: [{
      path: 'linked.json',
      validator: 'json:project-map',
      expected_code: 'OK',
    }],
  }));

  const result = await runCli(root);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.results, [{
    path: 'linked.json',
    validator: 'json:project-map',
    expected_code: 'OK',
    actual_code: 'FIXTURE_PATH_INVALID',
    matched: false,
  }]);
});
