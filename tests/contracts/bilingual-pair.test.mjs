import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { validateBilingualPair } from '../../scripts/lib/bilingual-pair.mjs';

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
  return { directory, enPath, zhPath };
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

test('rejects mismatched language-neutral Frontmatter fields', async (context) => {
  const { enPath, zhPath } = await withPair(
    context,
    (value) => value,
    (value) => value.replace('last_verified_baseline: abc123', 'last_verified_baseline: def456'),
  );
  const result = await validateBilingualPair(enPath, zhPath, await readMap());

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
  const { enPath, zhPath } = await withPair(context, removeEvidence, removeZhEvidence);
  const result = await validateBilingualPair(enPath, zhPath, await readMap());

  assert.equal(hasError(result, 'CURRENT_EVIDENCE_MISSING', '/facts/0/evidence_refs'), true);
});

test('rejects a current fact when only the Chinese mirror lacks evidence', async (context) => {
  const removeEvidence = (value) => value.replace(
    'evidence_refs:\n  - code-ref\n  - test-ref',
    'evidence_refs: []',
  );
  const { enPath, zhPath } = await withPair(context, (value) => value, removeEvidence);
  const result = await validateBilingualPair(enPath, zhPath, await readMap());

  assert.equal(hasError(result, 'CURRENT_EVIDENCE_MISSING', '/facts/0/evidence_refs'), true);
});

test('rejects differing heading-level sequences while allowing localized headings', async (context) => {
  const { enPath, zhPath } = await withPair(
    context,
    (value) => value,
    (value) => value.replace('### Wiki 工作区布局', '## Wiki 工作区布局'),
  );
  const result = await validateBilingualPair(enPath, zhPath, await readMap());

  assert.equal(hasError(result, 'PAIR_SECTION_MISMATCH', '/sections'), true);
});

test('rejects differing fact machine fields', async (context) => {
  const { enPath, zhPath } = await withPair(
    context,
    (value) => value,
    (value) => value.replace('revision: 4', 'revision: 5'),
  );
  const result = await validateBilingualPair(enPath, zhPath, await readMap());

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/facts/0/revision'), true);
});

test('rejects a fact baseline that differs from its owning current document', async (context) => {
  const changeFactBaseline = (value) => value.replace(
    'last_verified_baseline: abc123\n-->',
    'last_verified_baseline: def456\n-->',
  );
  const { enPath, zhPath } = await withPair(context, changeFactBaseline, changeFactBaseline);
  const result = await validateBilingualPair(enPath, zhPath, await readMap());

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/facts/0/last_verified_baseline'), true);
});

test('rejects paired_asset traversal outside the knowledge root', async (context) => {
  const escape = (value) => value.replace('paired_asset: wiki-workspace.md', 'paired_asset: ../outside.md');
  const { enPath, zhPath } = await withPair(context, escape, escape);
  const result = await validateBilingualPair(enPath, zhPath, await readMap());

  assert.equal(hasError(result, 'PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset'), true);
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
