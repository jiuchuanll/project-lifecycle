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
  const pointer = {
    schema_version: 1,
    project_id: 'sample-app',
    repository_id: 'sample-repository',
    governance_locator: './project-map.json',
  };
  const expectedError = [{
    code: 'REFERENCE_MISSING',
    path: '/governance_locator',
    message: 'Project pointer validation requires a resolved project map.',
  }];

  assert.deepEqual(validateJson('project-pointer', pointer).errors, expectedError);
  assert.deepEqual(
    validateJson('project-pointer', pointer, { allowUnresolvedProjectMap: true }).errors,
    expectedError,
  );
  assert.deepEqual(
    validateJson('project-pointer', pointer, { allowUnresolvedProjectMap: true, unrelated: 'value' }).errors,
    expectedError,
  );
});

test('validates a pointer whose locally resolved map has the same project_id', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-pointer-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(join(directory, 'project-map.json'), JSON.stringify(await fixture('valid.json')));
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
  await writeFile(mapFile, JSON.stringify({
    ...await fixture('valid.json'),
    project_id: 'another-project',
  }));
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

test('rejects an incomplete resolved map before pointer project_id comparison', () => {
  const pointer = {
    schema_version: 1,
    project_id: 'sample-app',
    repository_id: 'sample-repository',
    governance_locator: './project-map.json',
  };

  const result = validateJson('project-pointer', pointer, {
    resolvedProjectMap: { project_id: 'sample-app' },
  });

  assert.deepEqual(result.errors[0], {
    code: 'SCHEMA_INVALID',
    path: '/governance_locator/schema_version',
    message: 'Resolved governance target is not a valid project map.',
  });
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

test('rejects unsorted project-map relationship target IDs', async () => {
  const value = await fixture('valid.json');
  value.domains.push(
    {
      ...value.domains[0],
      id: 'alpha-domain',
      label: { en: 'Alpha', 'zh-CN': '甲' },
      purpose: { en: 'Owns alpha', 'zh-CN': '负责甲' },
      scope: { includes: ['alpha'], excludes: [] },
    },
    {
      ...value.domains[0],
      id: 'zeta-domain',
      label: { en: 'Zeta', 'zh-CN': '乙' },
      purpose: { en: 'Owns zeta', 'zh-CN': '负责乙' },
      scope: { includes: ['zeta'], excludes: [] },
    },
  );
  value.domains[0].relationships = [
    { kind: 'depends_on', target_id: 'zeta-domain' },
    { kind: 'coordinates_with', target_id: 'alpha-domain' },
  ];

  const result = validateJson('project-map', value);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/domains/0/relationships/1/target_id'
  )));
});

test('rejects unsorted project-map evidence references', async () => {
  const value = await fixture('valid.json');
  value.domains[0].evidence_refs = ['test:zeta', 'repo:alpha'];

  const result = validateJson('project-map', value);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/domains/0/evidence_refs/1'
  )));
});

test('rejects unsorted selected descendant IDs', async () => {
  const value = await fixture('valid.json');
  value.domains[0].scope.includes = ['alpha', 'zeta'];
  value.domains.push(
    {
      ...value.domains[0],
      id: 'alpha-domain',
      label: { en: 'Alpha', 'zh-CN': '甲' },
      purpose: { en: 'Owns alpha', 'zh-CN': '负责甲' },
      scope: { includes: ['alpha'], excludes: [] },
      parent_id: 'desktop-experience',
    },
    {
      ...value.domains[0],
      id: 'zeta-domain',
      label: { en: 'Zeta', 'zh-CN': '乙' },
      purpose: { en: 'Owns zeta', 'zh-CN': '负责乙' },
      scope: { includes: ['zeta'], excludes: [] },
      parent_id: 'desktop-experience',
    },
  );
  value.constraints.push({
    id: 'selected-children',
    scope: 'selected_descendants',
    owner_id: 'desktop-experience',
    selected_descendants: ['zeta-domain', 'alpha-domain'],
  });

  const result = validateJson('project-map', value);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/constraints/0/selected_descendants/1'
  )));
});

const mergedMap = async () => {
  const value = await fixture('valid.json');
  value.domains = [
    {
      ...value.domains[0],
      id: 'merged-domain',
      domain_state: 'merged',
      successor_id: 'successor-domain',
    },
    {
      ...value.domains[0],
      id: 'successor-domain',
      label: { en: 'Successor', 'zh-CN': '后继领域' },
      purpose: { en: 'Owns successor routing', 'zh-CN': '负责后继路由' },
    },
  ];
  return value;
};

test('accepts a merged domain with a distinct routable successor', async () => {
  assert.equal(validateJson('project-map', await mergedMap()).ok, true);
});

test('requires merged domains to declare a successor redirect', async () => {
  const value = await mergedMap();
  delete value.domains[0].successor_id;

  const result = validateJson('project-map', value);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'STATE_REQUIREMENT_MISSING' && path === '/domains/0/successor_id'
  )));
});

for (const [name, successorId, successorState, expected] of [
  ['itself', 'merged-domain', 'confirmed', {
    code: 'SCHEMA_INVALID',
    path: '/domains/0/successor_id',
    message: 'Merged domain successor must differ from its own ID.',
  }],
  ['a missing domain', 'missing-domain', 'confirmed', {
    code: 'REFERENCE_MISSING',
    path: '/domains/0/successor_id',
    message: 'Merged domain successor is absent from the project map.',
  }],
  ['a retired domain', 'successor-domain', 'retired', {
    code: 'SCHEMA_INVALID',
    path: '/domains/0/successor_id',
    message: 'Merged domain successor must be routable.',
  }],
  ['another merged domain', 'successor-domain', 'merged', {
    code: 'SCHEMA_INVALID',
    path: '/domains/0/successor_id',
    message: 'Merged domain successor must be routable.',
  }],
]) {
  test(`rejects a merged successor that targets ${name}`, async () => {
    const value = await mergedMap();
    value.domains[0].successor_id = successorId;
    value.domains[1].domain_state = successorState;
    if (successorState === 'retired') value.domains[1].retirement_reason = 'No longer routed';
    if (successorState === 'merged') value.domains[1].successor_id = 'merged-domain';

    const result = validateJson('project-map', value);

    assert.deepEqual(
      result.errors.find(({ path }) => path === '/domains/0/successor_id'),
      expected,
    );
  });
}

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
