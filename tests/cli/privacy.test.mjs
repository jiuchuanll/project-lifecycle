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

const createGitRoot = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-privacy-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
};

test('reports redacted categories and line numbers for tracked private material', async (context) => {
  const root = await createGitRoot(context);

  const absolutePath = ['', 'Users', 'example'].join('/');
  const secretAssignment = ['token', 'secret'].join('=');
  const privateLocator = ['github.com', 'private-owner', 'private-repo'].join('/');
  const quotedToken = ['token', '"secret"'].join('=');
  const quotedApiKey = ['api_key', "'secret'"].join(': ');
  const jsonToken = ['"token"', '"secret"'].join(': ');
  const privateSource = [
    absolutePath,
    secretAssignment,
    privateLocator,
    quotedToken,
    quotedApiKey,
    jsonToken,
    '',
  ].join('\n');

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
    { code: 'PRIVACY_SECRET_PATTERN', path: 'docs/bad.txt', line: 4 },
    { code: 'PRIVACY_SECRET_PATTERN', path: 'docs/bad.txt', line: 5 },
    { code: 'PRIVACY_SECRET_PATTERN', path: 'docs/bad.txt', line: 6 },
  ]);
  for (const privateValue of [
    absolutePath,
    secretAssignment,
    privateLocator,
    quotedToken,
    quotedApiKey,
    jsonToken,
  ]) {
    assert.equal(result.stdout.includes(privateValue), false);
  }
});

test('scans a tracked basename beginning with two dots inside the explicit root', async (context) => {
  const root = await createGitRoot(context);
  const secretAssignment = ['token', 'secret'].join('=');
  await writeFile(join(root, '..credentials'), `${secretAssignment}\n`);
  execFileSync('git', ['add', '--force', '--', '..credentials'], { cwd: root });

  const result = runPrivacy(root);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).findings, [{
    code: 'PRIVACY_SECRET_PATTERN',
    path: '..credentials',
    line: 1,
  }]);
  assert.equal(result.stdout.includes(secretAssignment), false);
});

test('allows only the declared canonical plugin repository locator', async (context) => {
  const root = await createGitRoot(context);
  const host = ['github', 'com'].join('.');
  const owner = ['jiuchuan', 'll'].join('');
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify({
    repository: `https://${host}/${owner}/project-lifecycle`,
    website: `https://${host}/${owner}/project-lifecycle`,
  })}\n`);
  execFileSync('git', ['add', '--', 'manifest.json'], { cwd: root });

  const result = runPrivacy(root);

  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('sorts privacy findings by locale-independent code-point order', async (context) => {
  const root = await createGitRoot(context);
  const secretAssignment = ['token', 'secret'].join('=');
  const paths = ['a.txt', 'é.txt', '_punct.txt', 'B.txt', '😀.txt', '�.txt'];
  for (const path of paths) await writeFile(join(root, path), `${secretAssignment}\n`);
  execFileSync('git', ['add', '--force', '--', ...paths], { cwd: root });

  const result = runPrivacy(root);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(
    JSON.parse(result.stdout).findings.map(({ path }) => path),
    ['B.txt', '_punct.txt', 'a.txt', 'é.txt', '�.txt', '😀.txt'],
  );
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
