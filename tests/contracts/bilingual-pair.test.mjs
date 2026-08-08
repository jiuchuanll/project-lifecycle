import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  relativeAssetLocator,
  validateBilingualPair,
} from '../../scripts/lib/bilingual-pair.mjs';

const fixtureUrl = (name) => new URL(`../fixtures/contracts/knowledge-pairs/valid/${name}`, import.meta.url);
const readMap = async () => JSON.parse(await readFile(fixtureUrl('project-map.json'), 'utf8'));

const hasError = (result, code, path) => result.errors.some((error) => (
  error.code === code && error.path === path
));

const withPair = async (context, editEn = (value) => value, editZh = (value) => value) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-pair-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const enPath = join(directory, 'wiki-workspace-en.md');
  const zhPath = join(directory, 'wiki-workspace.md');
  await writeFile(enPath, editEn(await readFile(fixtureUrl('wiki-workspace-en.md'), 'utf8')));
  await writeFile(zhPath, editZh(await readFile(fixtureUrl('wiki-workspace.md'), 'utf8')));
  return { directory, enPath, map: await readMap(), zhPath };
};

const runCli = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/bin/project-lifecycle.mjs', ...args], {
    cwd: new URL('../..', import.meta.url),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stderr, stdout }));
});

test('accepts a valid bilingual capability pair with localized prose', async () => {
  const result = await validateBilingualPair(
    fixtureUrl('wiki-workspace-en.md'),
    fixtureUrl('wiki-workspace.md'),
    await readMap(),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value.fact_ids, ['fact-wiki-layout-model']);
});

test('accepts an ordinary strictly valid JSON-parsed project map', async () => {
  const result = await validateBilingualPair(
    fixtureUrl('wiki-workspace-en.md'),
    fixtureUrl('wiki-workspace.md'),
    await readMap(),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('canonicalizes Windows relative paths to slash-separated map locators', () => {
  const locator = relativeAssetLocator(
    'C:\\project',
    'C:\\project\\knowledge\\wiki-workspace-en.md',
    win32,
  );

  assert.equal(locator, 'knowledge/wiki-workspace-en.md');
});

test('accepts a raw map whose authoritative assets use nested knowledge locators', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-nested-pair-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const knowledgeDirectory = join(directory, 'knowledge');
  await mkdir(knowledgeDirectory);
  const enPath = join(knowledgeDirectory, 'wiki-workspace-en.md');
  const zhPath = join(knowledgeDirectory, 'wiki-workspace.md');
  await writeFile(enPath, await readFile(fixtureUrl('wiki-workspace-en.md'), 'utf8'));
  await writeFile(zhPath, await readFile(fixtureUrl('wiki-workspace.md'), 'utf8'));
  const map = await readMap();
  map.domains[0].paired_assets.en = 'knowledge/wiki-workspace-en.md';
  map.domains[0].paired_assets['zh-CN'] = 'knowledge/wiki-workspace.md';

  const result = await validateBilingualPair(enPath, zhPath, map);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('rejects relocated assets that no longer match nested authoritative locators', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-relocated-pair-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const enPath = join(directory, 'wiki-workspace-en.md');
  const zhPath = join(directory, 'wiki-workspace.md');
  await writeFile(enPath, await readFile(fixtureUrl('wiki-workspace-en.md'), 'utf8'));
  await writeFile(zhPath, await readFile(fixtureUrl('wiki-workspace.md'), 'utf8'));
  const map = await readMap();
  map.domains[0].paired_assets.en = 'knowledge/wiki-workspace-en.md';
  map.domains[0].paired_assets['zh-CN'] = 'knowledge/wiki-workspace.md';

  const result = await validateBilingualPair(enPath, zhPath, map);

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/paths'), true);
});

test('library rejects unknown project-map fields before reading pair assets', async () => {
  const map = { ...await readMap(), unexpected: true };
  const result = await validateBilingualPair('/missing/en.md', '/missing/zh.md', map);

  assert.equal(hasError(result, 'SCHEMA_INVALID', '/unexpected'), true);
  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset'), false);
});

test('library rejects missing project-map fields before reading pair assets', async () => {
  const map = await readMap();
  delete map.domains;
  const result = await validateBilingualPair('/missing/en.md', '/missing/zh.md', map);

  assert.equal(hasError(result, 'SCHEMA_INVALID', '/domains'), true);
  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset'), false);
});

test('CLI rejects an invalid project map instead of validating raw domains', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-map-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const mapPath = join(directory, 'project-map.json');
  await writeFile(mapPath, JSON.stringify({ ...await readMap(), unexpected: true }));
  const result = await runCli([
    'validate-pair',
    fixtureUrl('wiki-workspace-en.md').pathname,
    fixtureUrl('wiki-workspace.md').pathname,
    mapPath,
  ]);

  assert.equal(result.stderr, '');
  assert.equal(result.status, 1);
  assert.equal(hasError(JSON.parse(result.stdout), 'SCHEMA_INVALID', '/unexpected'), true);
});

test('CLI rejects a project map with missing required fields', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-map-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const map = await readMap();
  delete map.domains;
  const mapPath = join(directory, 'project-map.json');
  await writeFile(mapPath, JSON.stringify(map));
  const result = await runCli([
    'validate-pair',
    fixtureUrl('wiki-workspace-en.md').pathname,
    fixtureUrl('wiki-workspace.md').pathname,
    mapPath,
  ]);

  assert.equal(result.stderr, '');
  assert.equal(result.status, 1);
  assert.equal(hasError(JSON.parse(result.stdout), 'SCHEMA_INVALID', '/domains'), true);
});

test('rejects mismatched language-neutral Frontmatter fields', async (context) => {
  const { enPath, map, zhPath } = await withPair(
    context,
    (value) => value,
    (value) => value.replace('last_verified_baseline: abc123', 'last_verified_baseline: def456'),
  );
  const result = await validateBilingualPair(enPath, zhPath, map);

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/frontmatter/last_verified_baseline'), true);
});

test('rejects missing paired assets', async () => {
  const directory = new URL('../fixtures/contracts/knowledge-pairs/missing-pair/', import.meta.url);
  const result = await validateBilingualPair(
    new URL('wiki-workspace-en.md', directory),
    new URL('wiki-workspace.md', directory),
    await readMap(),
  );

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset'), true);
});

test('rejects a current fact without evidence', async (context) => {
  const removeEvidence = (value) => value.replace(
    'evidence_refs:\n  - code-ref\n  - test-ref',
    'evidence_refs: []',
  );
  const removeZhEvidence = (value) => value.replace(
    'evidence_refs:\n  - code-ref\n  - test-ref',
    'evidence_refs: []',
  );
  const { enPath, map, zhPath } = await withPair(context, removeEvidence, removeZhEvidence);
  const result = await validateBilingualPair(enPath, zhPath, map);

  assert.equal(hasError(result, 'CURRENT_EVIDENCE_MISSING', '/facts/0/evidence_refs'), true);
});

test('rejects a current fact when only the Chinese mirror lacks evidence', async (context) => {
  const removeEvidence = (value) => value.replace(
    'evidence_refs:\n  - code-ref\n  - test-ref',
    'evidence_refs: []',
  );
  const { enPath, map, zhPath } = await withPair(context, (value) => value, removeEvidence);
  const result = await validateBilingualPair(enPath, zhPath, map);

  assert.equal(hasError(result, 'CURRENT_EVIDENCE_MISSING', '/facts/0/evidence_refs'), true);
});

test('rejects differing heading-level sequences while allowing localized headings', async (context) => {
  const { enPath, map, zhPath } = await withPair(
    context,
    (value) => value,
    (value) => value.replace('### Wiki 工作区布局', '## Wiki 工作区布局'),
  );
  const result = await validateBilingualPair(enPath, zhPath, map);

  assert.equal(hasError(result, 'PAIR_SECTION_MISMATCH', '/sections'), true);
});

test('rejects differing fact machine fields', async (context) => {
  const { enPath, map, zhPath } = await withPair(
    context,
    (value) => value,
    (value) => value.replace('revision: 4', 'revision: 5'),
  );
  const result = await validateBilingualPair(enPath, zhPath, map);

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/facts/0/revision'), true);
});

test('rejects a fact baseline that differs from its owning current document', async (context) => {
  const changeFactBaseline = (value) => value.replace(
    'last_verified_baseline: abc123\n-->',
    'last_verified_baseline: def456\n-->',
  );
  const { enPath, map, zhPath } = await withPair(context, changeFactBaseline, changeFactBaseline);
  const result = await validateBilingualPair(enPath, zhPath, map);

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/facts/0/last_verified_baseline'), true);
});

test('rejects paired_asset traversal outside the knowledge root', async (context) => {
  const escape = (value) => value.replace('paired_asset: wiki-workspace.md', 'paired_asset: ../outside.md');
  const { enPath, map, zhPath } = await withPair(context, escape, escape);
  const result = await validateBilingualPair(enPath, zhPath, map);

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset'), true);
});

test('rejects EN and ZH assets from different roots before reading them', async (context) => {
  const enDirectory = await mkdtemp(join(tmpdir(), 'project-lifecycle-en-root-'));
  const zhDirectory = await mkdtemp(join(tmpdir(), 'project-lifecycle-zh-root-'));
  context.after(() => Promise.all([
    rm(enDirectory, { force: true, recursive: true }),
    rm(zhDirectory, { force: true, recursive: true }),
  ]));
  const enPath = join(enDirectory, 'wiki-workspace-en.md');
  const zhPath = join(zhDirectory, 'wiki-workspace.md');
  await writeFile(enPath, 'invalid markdown');
  await writeFile(zhPath, 'invalid markdown');

  const result = await validateBilingualPair(enPath, zhPath, await readMap());

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/paths'), true);
  assert.equal(hasError(result, 'FACT_BLOCK_MALFORMED', '/frontmatter'), false);
});

test('rejects traversing authoritative map asset locators before reading assets', async () => {
  const map = await readMap();
  map.domains[0].paired_assets.en = '../outside/wiki-workspace-en.md';

  const result = await validateBilingualPair('/missing/en.md', '/missing/zh.md', map);

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/map/paired_assets/en'), true);
  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset'), false);
});

for (const locator of [
  '/absolute/wiki-workspace-en.md',
  'C:\\absolute\\wiki-workspace-en.md',
  'https://example.test/wiki-workspace-en.md',
  'knowledge/../wiki-workspace-en.md',
]) {
  test(`rejects unsafe authoritative map asset locator ${locator}`, async () => {
    const map = await readMap();
    map.domains[0].paired_assets.en = locator;

    const result = await validateBilingualPair('/missing/en.md', '/missing/zh.md', map);

    assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/map/paired_assets/en'), true);
    assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset'), false);
  });
}

test('derives the knowledge root from authoritative map assets, not the map directory', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-knowledge-root-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const knowledgeDirectory = join(directory, 'knowledge');
  await mkdir(knowledgeDirectory);
  const enPath = join(knowledgeDirectory, 'wiki-workspace-en.md');
  const zhPath = join(knowledgeDirectory, 'wiki-workspace.md');
  const escapeToMap = (value) => value.replace(
    'paired_asset: wiki-workspace.md',
    'paired_asset: ../project-map.json',
  );
  await writeFile(enPath, escapeToMap(await readFile(fixtureUrl('wiki-workspace-en.md'), 'utf8')));
  await writeFile(zhPath, escapeToMap(await readFile(fixtureUrl('wiki-workspace.md'), 'utf8')));
  const rawMap = JSON.parse(await readFile(fixtureUrl('project-map.json'), 'utf8'));
  rawMap.domains[0].paired_assets.en = 'knowledge/wiki-workspace-en.md';
  rawMap.domains[0].paired_assets['zh-CN'] = 'knowledge/wiki-workspace.md';
  const mapPath = join(directory, 'project-map.json');
  await writeFile(mapPath, JSON.stringify(rawMap));

  const result = await validateBilingualPair(enPath, zhPath, JSON.parse(await readFile(mapPath, 'utf8')));

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset'), true);
});

test('CLI rejects pair paths that do not match authoritative locator structure', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-far-pair-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const enPath = join(directory, 'wiki-workspace-en.md');
  const zhPath = join(directory, 'wiki-workspace.md');
  await writeFile(enPath, await readFile(fixtureUrl('wiki-workspace-en.md'), 'utf8'));
  await writeFile(zhPath, await readFile(fixtureUrl('wiki-workspace.md'), 'utf8'));
  const map = await readMap();
  map.domains[0].paired_assets.en = 'knowledge/wiki-workspace-en.md';
  map.domains[0].paired_assets['zh-CN'] = 'knowledge/wiki-workspace.md';
  const mapPath = join(directory, 'project-map.json');
  await writeFile(mapPath, JSON.stringify(map));

  const result = await runCli([
    'validate-pair',
    enPath,
    zhPath,
    mapPath,
  ]);

  assert.equal(result.stderr, '');
  assert.equal(result.status, 1);
  assert.equal(hasError(JSON.parse(result.stdout), 'PAIR_MACHINE_MISMATCH', '/paths'), true);
});

test('CLI validates the valid pair and emits the result model', async () => {
  const result = await runCli([
    'validate-pair',
    fixtureUrl('wiki-workspace-en.md').pathname,
    fixtureUrl('wiki-workspace.md').pathname,
    fixtureUrl('project-map.json').pathname,
  ]);

  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).ok, true);
});
