import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const runPrivacy = (root, cwd = repositoryRoot) => spawnSync(
  process.execPath,
  ['scripts/check-privacy.mjs', ...(root ? [root] : [])],
  { cwd, encoding: 'utf8' },
);

test('reports redacted categories and line numbers for tracked private material', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-privacy-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });

  const absolutePath = ['', 'Users', 'example'].join('/');
  const secretAssignment = ['token', 'secret'].join('=');
  const privateLocator = ['github.com', 'private-owner', 'private-repo'].join('/');
  const privateSource = `${absolutePath}\n${secretAssignment}\n${privateLocator}\n`;

  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(root, '.privacy-test-tmp'), { recursive: true });
  await writeFile(join(root, 'docs', 'bad.txt'), privateSource);
  await writeFile(join(root, 'node_modules', 'ignored.txt'), privateSource);
  await writeFile(join(root, '.privacy-test-tmp', 'ignored.txt'), privateSource);
  await writeFile(join(root, '.git', 'ignored-private-material'), privateSource);
  execFileSync('git', [
    'add',
    '--force',
    'docs/bad.txt',
    'node_modules/ignored.txt',
    '.privacy-test-tmp/ignored.txt',
  ], { cwd: root });

  const result = runPrivacy(root);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.findings, [
    { code: 'PRIVACY_ABSOLUTE_PATH', path: 'docs/bad.txt', line: 1 },
    { code: 'PRIVACY_SECRET_PATTERN', path: 'docs/bad.txt', line: 2 },
    { code: 'PRIVACY_PRIVATE_LOCATOR', path: 'docs/bad.txt', line: 3 },
  ]);
  assert.equal(result.stdout.includes(absolutePath), false);
  assert.equal(result.stdout.includes(secretAssignment), false);
  assert.equal(result.stdout.includes(privateLocator), false);
});

test('passes the tracked repository scan while ignoring untracked test material', async () => {
  const result = runPrivacy();

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.ok(summary.scanned_files > 0);
  assert.deepEqual(summary.findings, []);
});
