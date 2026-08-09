import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGitLocalStorage } from '../../scripts/adapters/git-local.mjs';
import { createProcessRunner } from '../../scripts/adapters/process-runner.mjs';
import { assertVersionedStorage } from '../../scripts/adapters/versioned-storage.mjs';

const exec = promisify(execFile);
const git = async (root, args) => (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
const repository = async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-git-'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Project Lifecycle Tests']);
  await git(root, ['config', 'user.email', 'tests@example.invalid']);
  await writeFile(join(root, 'knowledge.md'), 'revision one\n');
  await git(root, ['add', '--', 'knowledge.md']);
  await git(root, ['commit', '-m', 'first']);
  const first = await git(root, ['rev-parse', 'HEAD']);
  await writeFile(join(root, 'knowledge.md'), 'revision two\n');
  await writeFile(join(root, 'other.md'), 'other\n');
  await git(root, ['add', '--', 'knowledge.md', 'other.md']);
  await git(root, ['commit', '-m', 'second']);
  const second = await git(root, ['rev-parse', 'HEAD']);
  return { root, first, second };
};

test('exports the exact portable asynchronous versioned-storage interface', async () => {
  const { root } = await repository();
  const storage = createGitLocalStorage({ repositoryRoot: root });
  assert.equal(assertVersionedStorage(storage).ok, true);
  assert.deepEqual(Object.keys(storage).sort(), [
    'commitCandidate', 'compareAndSwap', 'createCandidate', 'listAtRevision', 'readAtRevision', 'resolveRevision',
  ]);
  for (const method of Object.values(storage)) assert.equal(method.constructor.name, 'AsyncFunction');
  assert.equal(typeof createProcessRunner().runProcess, 'function');
});

test('pins immutable reads and listings after the accepted branch advances', async () => {
  const { root, first, second } = await repository();
  const storage = createGitLocalStorage({ repositoryRoot: root });
  assert.equal((await storage.resolveRevision('refs/heads/main')).value, second);
  assert.equal((await storage.readAtRevision(first, 'knowledge.md')).value.content, 'revision one\n');
  assert.deepEqual((await storage.listAtRevision(first, '.')).value.paths, ['knowledge.md']);
  assert.deepEqual((await storage.listAtRevision(second, '.')).value.paths, ['knowledge.md', 'other.md']);
});

test('returns stable failures for a missing ref and unsafe repository paths', async () => {
  const { root, first } = await repository();
  const storage = createGitLocalStorage({ repositoryRoot: root });
  assert.equal((await storage.resolveRevision('refs/heads/missing')).errors[0].code, 'GIT_REVISION_MISSING');
  assert.equal((await storage.readAtRevision(first, '../secret')).errors[0].code, 'GIT_PATH_INVALID');
  assert.equal((await storage.listAtRevision(first, '/absolute')).errors[0].code, 'GIT_PATH_INVALID');
});

test('rejects symlink entries and dirty source worktrees', async () => {
  const { root, second } = await repository();
  await symlink('knowledge.md', join(root, 'knowledge-link'));
  await git(root, ['add', '--', 'knowledge-link']);
  await git(root, ['commit', '-m', 'symlink']);
  const linked = await git(root, ['rev-parse', 'HEAD']);
  const storage = createGitLocalStorage({ repositoryRoot: root });
  assert.equal((await storage.readAtRevision(linked, 'knowledge-link')).errors[0].code, 'GIT_SYMLINK_FORBIDDEN');
  await writeFile(join(root, 'dirty.txt'), 'dirty\n');
  assert.equal((await storage.createCandidate({ baseRevision: second, branchName: 'codex/dirty-candidate' })).errors[0].code, 'GIT_WORKTREE_DIRTY');
});

test('creates an isolated candidate and commits only explicitly supplied regular files', async () => {
  const { root, second } = await repository();
  const storage = createGitLocalStorage({ repositoryRoot: root });
  const created = await storage.createCandidate({ baseRevision: second, branchName: 'codex/wiki-candidate' });
  assert.equal(created.ok, true);
  await writeFile(join(created.value.candidateRoot, 'knowledge.md'), 'candidate\n');
  await writeFile(join(created.value.candidateRoot, 'other.md'), 'uncommitted\n');
  const committed = await storage.commitCandidate({
    candidateRoot: created.value.candidateRoot,
    paths: ['knowledge.md'],
    message: 'update knowledge',
  });
  assert.equal(committed.ok, true);
  assert.equal(await git(created.value.candidateRoot, ['show', 'HEAD:knowledge.md']), 'candidate');
  assert.equal(await git(created.value.candidateRoot, ['show', 'HEAD:other.md']), 'other');
  assert.match(await readFile(join(created.value.candidateRoot, 'other.md'), 'utf8'), /uncommitted/);
});

test('rejects unsafe branch names, undeclared staged files, and candidate symlink escapes', async () => {
  const { root, second } = await repository();
  const storage = createGitLocalStorage({ repositoryRoot: root });
  assert.equal((await storage.createCandidate({ baseRevision: second, branchName: 'main' })).errors[0].code, 'GIT_BRANCH_INVALID');
  const created = await storage.createCandidate({ baseRevision: second, branchName: 'codex/safe-candidate' });
  await writeFile(join(created.value.candidateRoot, 'knowledge.md'), 'candidate\n');
  await writeFile(join(created.value.candidateRoot, 'other.md'), 'pre-staged\n');
  await git(created.value.candidateRoot, ['add', '--', 'other.md']);
  assert.equal((await storage.commitCandidate({
    candidateRoot: created.value.candidateRoot, paths: ['knowledge.md'], message: 'scoped',
  })).errors[0].code, 'GIT_STAGED_SCOPE_INVALID');

  await git(created.value.candidateRoot, ['reset']);
  const outside = await mkdtemp(join(tmpdir(), 'project-lifecycle-outside-'));
  await writeFile(join(outside, 'secret.md'), 'secret\n');
  await symlink(outside, join(created.value.candidateRoot, 'escape'));
  assert.equal((await storage.commitCandidate({
    candidateRoot: created.value.candidateRoot, paths: ['escape/secret.md'], message: 'escape',
  })).errors[0].code, 'GIT_SYMLINK_FORBIDDEN');
});

test('compare-and-swap publishes only when the accepted ref still matches', async () => {
  const { root, first, second } = await repository();
  const storage = createGitLocalStorage({ repositoryRoot: root });
  const created = await storage.createCandidate({ baseRevision: first, branchName: 'codex/cas-candidate' });
  await writeFile(join(created.value.candidateRoot, 'knowledge.md'), 'candidate\n');
  const committed = await storage.commitCandidate({
    candidateRoot: created.value.candidateRoot, paths: ['knowledge.md'], message: 'candidate',
  });
  const stale = await storage.compareAndSwap({
    acceptedRef: 'refs/heads/main', expectedRevision: first, candidateRevision: committed.value.revision,
  });
  assert.equal(stale.errors[0].code, 'GIT_COMPARE_AND_SWAP_FAILED');
  assert.equal(await git(root, ['rev-parse', 'refs/heads/main']), second);

  const published = await storage.compareAndSwap({
    acceptedRef: 'refs/heads/main', expectedRevision: second, candidateRevision: committed.value.revision,
  });
  assert.equal(published.ok, true);
  assert.equal(await git(root, ['rev-parse', 'refs/heads/main']), committed.value.revision);
});
