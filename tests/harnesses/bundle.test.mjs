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
