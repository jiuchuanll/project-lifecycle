import assert from 'node:assert/strict';
import {
  cp,
  chmod,
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

const createFixtureRoot = async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'project-lifecycle-fixture-contract-'));
  context.after(() => rm(sandbox, { force: true, recursive: true }));
  const root = join(sandbox, 'fixtures');
  await mkdir(root);
  return root;
};

const validJsonEntry = (overrides = {}) => ({
  path: 'valid.json',
  validator: 'json:project-map',
  expected_code: 'OK',
  ...overrides,
});

const validPairEntry = (overrides = {}) => ({
  path: 'pair',
  validator: 'bilingual-pair',
  expected_code: 'OK',
  inputs: {
    en: 'capability-en.md',
    'zh-CN': 'capability.md',
    project_map: 'project-map.json',
  },
  ...overrides,
});

const writeManifest = (root, manifest) => writeFile(
  join(root, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const assertManifestError = async (context, manifest, expectedPath) => {
  const root = await createFixtureRoot(context);
  await writeManifest(root, manifest);
  const result = await runCli(root);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.results, []);
  assert.ok(summary.errors.some(({ code, path }) => (
    code === 'FIXTURE_MANIFEST_INVALID' && path === expectedPath
  )));
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

for (const [name, manifest, expectedPath] of [
  ['unknown manifest fields', { schema_version: 1, fixtures: [], unexpected: true }, '/unexpected'],
  ['schema versions other than one', { schema_version: 2, fixtures: [] }, '/schema_version'],
  ['a non-array fixture list', { schema_version: 1, fixtures: 'invalid' }, '/fixtures'],
  ['non-object fixture entries', { schema_version: 1, fixtures: [null] }, '/fixtures/0'],
  ['missing fixture paths', { schema_version: 1, fixtures: [{ validator: 'json:project-map', expected_code: 'OK' }] }, '/fixtures/0/path'],
  ['unknown fixture entry fields', { schema_version: 1, fixtures: [validJsonEntry({ unexpected: true })] }, '/fixtures/0/unexpected'],
  ['non-string validator kinds', { schema_version: 1, fixtures: [validJsonEntry({ validator: 42 })] }, '/fixtures/0/validator'],
  ['unknown expected result codes', { schema_version: 1, fixtures: [validJsonEntry({ expected_code: 'SUCCESS' })] }, '/fixtures/0/expected_code'],
  ['inputs on JSON validators', { schema_version: 1, fixtures: [validJsonEntry({ inputs: {} })] }, '/fixtures/0/inputs'],
  ['missing bilingual inputs', { schema_version: 1, fixtures: [validPairEntry({ inputs: { en: 'capability-en.md', project_map: 'project-map.json' } })] }, '/fixtures/0/inputs/zh-CN'],
  ['extra bilingual inputs', { schema_version: 1, fixtures: [validPairEntry({ inputs: { ...validPairEntry().inputs, extra: 'extra.md' } })] }, '/fixtures/0/inputs/extra'],
  ['non-string bilingual inputs', { schema_version: 1, fixtures: [validPairEntry({ inputs: { ...validPairEntry().inputs, en: 42 } })] }, '/fixtures/0/inputs/en'],
]) {
  test(`rejects ${name} before inventory or fixture execution`, async (context) => {
    await assertManifestError(context, manifest, expectedPath);
  });
}

test('rejects an unknown JSON validator before it can satisfy SCHEMA_INVALID', async (context) => {
  const root = await createFixtureRoot(context);
  await writeFile(
    join(root, 'valid.json'),
    await readFile(join(fixtureRoot, 'contracts', 'project-map', 'valid.json')),
  );
  await writeManifest(root, {
    schema_version: 1,
    fixtures: [validJsonEntry({
      validator: 'json:project-mpa',
      expected_code: 'SCHEMA_INVALID',
    })],
  });

  const result = await runCli(root);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    results: [],
    errors: [{ code: 'FIXTURE_MANIFEST_INVALID', path: '/fixtures/0/validator' }],
  });
});

for (const path of [
  '../escape.json',
  '/absolute.json',
  'C:/absolute.json',
  'C:\\absolute.json',
  '\\\\server\\share\\fixture.json',
]) {
  test(`rejects non-portable or escaping fixture path ${JSON.stringify(path)}`, async (context) => {
    await assertManifestError(
      context,
      { schema_version: 1, fixtures: [validJsonEntry({ path })] },
      '/fixtures/0/path',
    );
  });
}

test('detects duplicate fixture paths after canonical alias normalization', async (context) => {
  const root = await createFixtureRoot(context);
  await writeManifest(root, {
    schema_version: 1,
    fixtures: [
      validJsonEntry(),
      validJsonEntry({ path: './nested/../valid.json' }),
    ],
  });

  const result = await runCli(root);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    results: [],
    errors: [{ code: 'FIXTURE_MANIFEST_DUPLICATE', path: 'valid.json' }],
  });
});

test('uses canonical paths for coverage, execution, and result output', async (context) => {
  const root = await createFixtureRoot(context);
  await writeFile(
    join(root, 'valid.json'),
    await readFile(join(fixtureRoot, 'contracts', 'project-map', 'valid.json')),
  );
  await writeManifest(root, {
    schema_version: 1,
    fixtures: [validJsonEntry({ path: './nested/../valid.json' })],
  });

  const result = await runCli(root);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).results, [{
    path: 'valid.json',
    validator: 'json:project-map',
    expected_code: 'OK',
    actual_code: 'OK',
    matched: true,
  }]);
});

test('sorts fixture results by locale-independent code-point order', async (context) => {
  const root = await createFixtureRoot(context);
  const source = await readFile(join(fixtureRoot, 'contracts', 'project-map', 'valid.json'));
  const paths = ['a.json', 'é.json', '_punct.json', 'B.json', '😀.json', '�.json'];
  for (const path of paths) await writeFile(join(root, path), source);
  await writeManifest(root, {
    schema_version: 1,
    fixtures: paths.map((path) => validJsonEntry({ path })),
  });

  const result = await runCli(root);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(
    JSON.parse(result.stdout).results.map(({ path }) => path),
    ['B.json', '_punct.json', 'a.json', 'é.json', '�.json', '😀.json'],
  );
});

test('wraps inventory failures in one deterministic JSON summary', async (context) => {
  const root = await createFixtureRoot(context);
  const blocked = join(root, 'blocked');
  await mkdir(blocked);
  await writeManifest(root, { schema_version: 1, fixtures: [] });
  await chmod(blocked, 0o000);

  let result;
  try {
    result = await runCli(root);
  } finally {
    await chmod(blocked, 0o700);
  }

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    results: [],
    errors: [{ code: 'FIXTURE_SUITE_ERROR', path: '/' }],
  });
});
