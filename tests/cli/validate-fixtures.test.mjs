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

const validPointerEntry = (overrides = {}) => ({
  path: 'pointer.json',
  validator: 'json:project-pointer',
  expected_code: 'OK',
  inputs: { resolved_project_map: 'project-map.json' },
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

test('allows inventory files only beneath explicitly declared auxiliary roots', async (context) => {
  const root = await createFixtureRoot(context);
  await mkdir(join(root, 'knowledge', 'bootstrap'), { recursive: true });
  await writeFile(join(root, 'knowledge', 'bootstrap', 'policy.json'), '{}\n');
  await writeFile(join(root, 'knowledge', 'bootstrap', 'source.mjs'), 'fixture body\n');
  await writeManifest(root, {
    schema_version: 1,
    auxiliary_roots: ['knowledge/bootstrap'],
    fixtures: [],
  });

  const result = await runCli(root);

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, results: [], errors: [] });

  await writeFile(join(root, 'unlisted.txt'), 'must remain inventoried\n');
  const withOutsideFile = await runCli(root);
  assert.equal(withOutsideFile.status, 1);
  assert.deepEqual(JSON.parse(withOutsideFile.stdout).errors, [{
    code: 'FIXTURE_UNLISTED',
    path: 'unlisted.txt',
  }]);
});

for (const [name, roots, expectedPath] of [
  ['a non-array declaration', 'knowledge/bootstrap', '/auxiliary_roots'],
  ['an empty locator', [''], '/auxiliary_roots/0'],
  ['a parent traversal', ['../bootstrap'], '/auxiliary_roots/0'],
  ['an absolute locator', ['/bootstrap'], '/auxiliary_roots/0'],
  ['a Windows drive locator', ['C:/bootstrap'], '/auxiliary_roots/0'],
  ['a backslash locator', ['knowledge\\bootstrap'], '/auxiliary_roots/0'],
  ['a non-canonical alias', ['knowledge/./bootstrap'], '/auxiliary_roots/0'],
  ['a trailing-slash alias', ['knowledge/bootstrap/'], '/auxiliary_roots/0'],
  ['duplicate roots', ['knowledge/bootstrap', 'knowledge/bootstrap'], '/auxiliary_roots/1'],
  ['roots outside code-point order', ['zeta', 'alpha'], '/auxiliary_roots/1'],
  ['overlapping roots', ['knowledge', 'knowledge/bootstrap'], '/auxiliary_roots/1'],
]) {
  test(`rejects auxiliary roots with ${name}`, async (context) => {
    await assertManifestError(context, {
      schema_version: 1,
      auxiliary_roots: roots,
      fixtures: [],
    }, expectedPath);
  });
}

test('rejects missing, non-directory, and symlink auxiliary roots', async (context) => {
  for (const setup of [
    async () => 'missing',
    async (root) => {
      await writeFile(join(root, 'file.txt'), 'not a directory\n');
      return 'file.txt';
    },
    async (root) => {
      await mkdir(join(root, 'real'));
      await symlink(join(root, 'real'), join(root, 'linked'));
      return 'linked';
    },
  ]) {
    const root = await createFixtureRoot(context);
    const locator = await setup(root);
    await writeManifest(root, {
      schema_version: 1,
      auxiliary_roots: [locator],
      fixtures: [],
    });

    const result = await runCli(root);

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).errors, [{
      code: 'FIXTURE_AUXILIARY_ROOT_INVALID',
      path: locator,
    }]);
  }
});

test('rejects an auxiliary root that resolves physically outside the fixture root', async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'project-lifecycle-auxiliary-link-'));
  context.after(() => rm(sandbox, { force: true, recursive: true }));
  const root = join(sandbox, 'fixtures');
  const outside = join(sandbox, 'private-outside');
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, 'linked-parent'));
  await writeManifest(root, {
    schema_version: 1,
    auxiliary_roots: ['linked-parent'],
    fixtures: [],
  });

  const result = await runCli(root);

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).errors, [{
    code: 'FIXTURE_AUXILIARY_ROOT_INVALID',
    path: 'linked-parent',
  }]);
  assert.equal(result.stdout.includes(outside), false);
});

test('rejects auxiliary roots that would hide a declared contract fixture', async (context) => {
  const root = await createFixtureRoot(context);
  await mkdir(join(root, 'auxiliary'));
  await writeFile(
    join(root, 'auxiliary', 'project-map.json'),
    await readFile(join(fixtureRoot, 'contracts', 'project-map', 'valid.json')),
  );
  await writeManifest(root, {
    schema_version: 1,
    auxiliary_roots: ['auxiliary'],
    fixtures: [{
      path: 'auxiliary/project-map.json',
      validator: 'json:project-map',
      expected_code: 'OK',
    }],
  });

  const result = await runCli(root);

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    results: [],
    errors: [{ code: 'FIXTURE_MANIFEST_INVALID', path: '/auxiliary_roots/0' }],
  });
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
  ['inputs on non-pointer JSON validators', { schema_version: 1, fixtures: [validJsonEntry({ inputs: {} })] }, '/fixtures/0/inputs'],
  ['missing pointer map input', { schema_version: 1, fixtures: [validPointerEntry({ inputs: {} })] }, '/fixtures/0/inputs/resolved_project_map'],
  ['extra pointer map input', { schema_version: 1, fixtures: [validPointerEntry({ inputs: { resolved_project_map: 'project-map.json', extra: 'extra.json' } })] }, '/fixtures/0/inputs/extra'],
  ['missing bilingual inputs', { schema_version: 1, fixtures: [validPairEntry({ inputs: { en: 'capability-en.md', project_map: 'project-map.json' } })] }, '/fixtures/0/inputs/zh-CN'],
  ['extra bilingual inputs', { schema_version: 1, fixtures: [validPairEntry({ inputs: { ...validPairEntry().inputs, extra: 'extra.md' } })] }, '/fixtures/0/inputs/extra'],
  ['non-string bilingual inputs', { schema_version: 1, fixtures: [validPairEntry({ inputs: { ...validPairEntry().inputs, en: 42 } })] }, '/fixtures/0/inputs/en'],
]) {
  test(`rejects ${name} before inventory or fixture execution`, async (context) => {
    await assertManifestError(context, manifest, expectedPath);
  });
}

test('validates a project-pointer fixture with its declared resolved project map', async (context) => {
  const root = await createFixtureRoot(context);
  const map = await readFile(join(fixtureRoot, 'contracts', 'project-map', 'valid.json'));
  await writeFile(join(root, 'project-map.json'), map);
  await writeFile(join(root, 'pointer.json'), JSON.stringify({
    schema_version: 1,
    project_id: 'sample-app',
    repository_id: 'sample-repository',
    governance_locator: './project-map.json',
  }));
  await writeManifest(root, {
    schema_version: 1,
    fixtures: [validPointerEntry()],
  });

  const result = await runCli(root);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).results, [{
    path: 'pointer.json',
    validator: 'json:project-pointer',
    expected_code: 'OK',
    actual_code: 'OK',
    matched: true,
  }]);
});

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
