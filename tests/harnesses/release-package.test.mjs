import assert from 'node:assert/strict';
import { lstat, readFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildReleasePackage,
  inspectReleaseZip,
  renderSupportMatrix,
} from '../../scripts/package-release.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const matrix = JSON.parse(await readFile(join(repositoryRoot, 'tests/harnesses/support-matrix.json'), 'utf8'));

test('builds a deterministic private candidate with the complete explicit release surface', async (context) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'project-lifecycle-release-'));
  context.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const options = {
    repositoryRoot,
    outputDirectory,
    allowDirty: true,
    requireTracked: false,
  };
  const first = await buildReleasePackage(options);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.release_status, 'NON_RELEASE_CANDIDATE');
  const firstBytes = await readFile(first.value.archive_path);
  assert.deepEqual(
    firstBytes,
    await readFile(join(repositoryRoot, 'dist/project-lifecycle-0.1.0.zip')),
    'checked-in archive must equal a clean deterministic rebuild',
  );
  assert.equal(
    await readFile(join(repositoryRoot, 'dist/project-lifecycle-0.1.0.zip.sha256'), 'utf8'),
    `${first.value.sha256}  project-lifecycle-0.1.0.zip\n`,
  );
  const second = await buildReleasePackage(options);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.sha256, first.value.sha256);
  assert.deepEqual(await readFile(second.value.archive_path), firstBytes);

  const archive = inspectReleaseZip(firstBytes);
  assert.equal(archive.ok, true, JSON.stringify(archive));
  const names = [...archive.value.keys()];
  const prefix = 'project-lifecycle-0.1.0/';
  for (const required of [
    'skills/maintain-project-knowledge/SKILL.md',
    'skills/run-prd-lifecycle/SKILL.md',
    '.codex-plugin/plugin.json',
    '.claude-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
    '.kimi-plugin/plugin.json',
    '.zcode-plugin/plugin.json',
    '.agents/plugins/marketplace.json',
    'bin/project-lifecycle',
    'dist/project-lifecycle.mjs',
    'integrations/codex/tool-map.md',
    'integrations/kimi/tool-map.md',
    'README.md',
    'README.zh-CN.md',
    'RELEASE-NOTES.md',
    'docs/migrations/knowledgevault-agent-app.md',
    'support-matrix.json',
    'targeted-regression.json',
  ]) assert.ok(names.includes(`${prefix}${required}`), `missing ${required}`);
  assert.equal(names.some((name) => name.endsWith('/.DS_Store')), false);
  assert.equal(names.some((name) => /(?:^|\/)(?:node_modules|\.git|legacy|tests|scripts)(?:\/|$)/u.test(name)), false);
  assert.equal(names.some((name) => name.includes('docs-workflow/SKILL.md')), false);
  for (const content of archive.value.values()) {
    assert.equal(content.includes('/Users/'), false);
  }
});

test('binds both README support tables to the retained support matrix', async () => {
  const english = await readFile(join(repositoryRoot, 'README.md'), 'utf8');
  const chinese = await readFile(join(repositoryRoot, 'README.zh-CN.md'), 'utf8');
  assert.match(english, new RegExp(renderSupportMatrix(matrix, 'en').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(chinese, new RegExp(renderSupportMatrix(matrix, 'zh').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
});

test('fails closed for dirty release trees and filename-version drift', async () => {
  const dirty = await buildReleasePackage({
    repositoryRoot,
    outputDirectory: join(tmpdir(), 'unused-release-output'),
    readDirtyPaths: async () => ['README.md'],
  });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.errors[0].code, 'RELEASE_TREE_DIRTY');

  const mismatch = await buildReleasePackage({
    repositoryRoot,
    outputDirectory: join(tmpdir(), 'unused-release-output'),
    filenameVersion: '0.2.0',
    allowDirty: true,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.errors[0].code, 'RELEASE_VERSION_MISMATCH');
});

test('rejects a release version that is not one safe path component', async () => {
  const result = await buildReleasePackage({
    repositoryRoot,
    outputDirectory: join(tmpdir(), 'unused-release-output'),
    filenameVersion: 'x/../../../victim',
    allowDirty: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'RELEASE_VERSION_INVALID');
});

test('refuses to follow an existing release output symlink', async (context) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'project-lifecycle-release-output-'));
  context.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const sentinel = join(outputDirectory, 'sentinel.txt');
  const archivePath = join(outputDirectory, 'project-lifecycle-0.1.0.zip');
  await writeFile(sentinel, 'sentinel\n');
  await symlink(sentinel, archivePath);

  const result = await buildReleasePackage({
    repositoryRoot,
    outputDirectory,
    allowDirty: true,
    requireTracked: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'RELEASE_OUTPUT_INVALID');
  assert.equal((await lstat(archivePath)).isSymbolicLink(), true);
  assert.equal(await readFile(sentinel, 'utf8'), 'sentinel\n');
});
