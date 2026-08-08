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
]) {
  test(`rejects ${name} at its contract path`, async () => {
    const result = validateJson('project-map', await fixture(name));

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === code && error.path === path));
  });
}

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

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'scripts/bin/project-lifecycle.mjs',
      'validate-json',
      'project-pointer',
      pointerFile,
    ], { cwd: new URL('../..', import.meta.url) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr, stdout }));
  });

  assert.equal(result.stderr, '');
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).errors.some((error) => (
    error.code === 'REFERENCE_MISSING' && error.path === '/project_id'
  )));
});
