import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { atomicWriteValidated } from '../../scripts/lib/atomic-write.mjs';
import {
  applyLayoutTransaction,
  diffLayout,
  inspectLifecycleTree,
} from '../../scripts/knowledge/layout-transaction.mjs';

const createProject = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-layout-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lifecycle = join(root, 'docs/project-lifecycle');
  await mkdir(join(lifecycle, 'knowledge/runtime'), { recursive: true });
  await writeFile(join(lifecycle, 'project-map.json'), '{"schema_version":2}\n');
  await writeFile(join(lifecycle, 'knowledge/INDEX-en.md'), 'knowledge root\n');
  await writeFile(join(lifecycle, 'knowledge/runtime/INDEX-en.md'), 'runtime root\n');
  return { root, lifecycle };
};

const candidate = (locator, content, repositoryId = null) => ({
  repository_id: repositoryId,
  locator,
  content,
  validate: async (source) => ({ ok: source === content, errors: [] }),
});

const read = (lifecycle, locator) => readFile(join(lifecycle, locator), 'utf8');

test('computes content-addressed writes, moves, deletes, and unchanged files', () => {
  const current = {
    entries: [
      { locator: 'a.md', type: 'file', hash: 'same' },
      { locator: 'old.md', type: 'file', hash: 'move' },
      { locator: 'remove.md', type: 'file', hash: 'remove' },
    ],
  };
  const next = {
    entries: [
      { locator: 'a.md', type: 'file', hash: 'same' },
      { locator: 'new.md', type: 'file', hash: 'move' },
      { locator: 'write.md', type: 'file', hash: 'write' },
    ],
  };

  assert.deepEqual(diffLayout({ current, candidate: next }), {
    writes: ['write.md'],
    moves: [{ from: 'old.md', to: 'new.md' }],
    deletes: ['remove.md'],
    unchanged: ['a.md'],
  });
});

test('performs zero writes and zero renames for an identical candidate', async (context) => {
  const project = await createProject(context);
  const snapshot = await inspectLifecycleTree({ repositoryRoot: project.root });
  let writes = 0;
  let renames = 0;

  const result = await applyLayoutTransaction({
    repositoryRoot: project.root,
    expectedFingerprint: snapshot.value.fingerprint,
    candidateFiles: [candidate('knowledge/INDEX-en.md', 'knowledge root\n')],
    deleteLocators: ['missing.md'],
    validateCandidate: async () => ({ ok: true, errors: [] }),
  }, {
    atomicWriteValidated: async (...args) => { writes += 1; return atomicWriteValidated(...args); },
    rename: async (...args) => { renames += 1; return rename(...args); },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.changed, []);
  assert.equal(writes, 0);
  assert.equal(renames, 0);
});

test('initializes a complete lifecycle root through the same atomic publication boundary', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-layout-init-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  const result = await applyLayoutTransaction({
    repositoryRoot: root,
    initialize: true,
    candidateFiles: [candidate('knowledge/INDEX-en.md', 'knowledge\n')],
    deleteLocators: [],
    validateCandidate: async ({ lifecycleRoot }) => ({
      ok: await read(lifecycleRoot, 'knowledge/INDEX-en.md') === 'knowledge\n',
      errors: [],
    }),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await read(join(root, 'docs/project-lifecycle'), 'knowledge/INDEX-en.md'), 'knowledge\n');
});

test('rolls back initialization when the post-publish hook fails', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-layout-init-hook-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  const result = await applyLayoutTransaction({
    repositoryRoot: root,
    initialize: true,
    candidateFiles: [candidate('project-map.json', '{"schema_version":2}\n')],
    deleteLocators: [],
    validateCandidate: async () => ({ ok: true, errors: [] }),
  }, {
    afterPublish: async () => { throw new Error('post-publication failure'); },
  });

  assert.equal(result.ok, false);
  await assert.rejects(lstat(join(root, 'docs/project-lifecycle')), { code: 'ENOENT' });
});

test('publishes one changed index while preserving unrelated bytes and mtime', async (context) => {
  const project = await createProject(context);
  const unrelated = join(project.lifecycle, 'knowledge/runtime/INDEX-en.md');
  const before = await stat(unrelated);

  const result = await applyLayoutTransaction({
    repositoryRoot: project.root,
    candidateFiles: [candidate('knowledge/INDEX-en.md', 'changed\n')],
    deleteLocators: [],
    validateCandidate: async ({ lifecycleRoot }) => ({
      ok: await read(lifecycleRoot, 'knowledge/INDEX-en.md') === 'changed\n',
      errors: [],
    }),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await read(project.lifecycle, 'knowledge/INDEX-en.md'), 'changed\n');
  assert.equal(await read(project.lifecycle, 'knowledge/runtime/INDEX-en.md'), 'runtime root\n');
  assert.ok(Math.abs((await stat(unrelated)).mtimeMs - before.mtimeMs) < 0.001);
});

test('creates bounded parent directories, deletes obsolete paths, and rejects a stale fingerprint', async (context) => {
  const project = await createProject(context);
  const stale = await applyLayoutTransaction({
    repositoryRoot: project.root,
    expectedFingerprint: 'stale',
    candidateFiles: [candidate('knowledge/new/child-en.md', 'new\n')],
    deleteLocators: ['knowledge/runtime'],
    validateCandidate: async () => ({ ok: true, errors: [] }),
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.errors[0].code, 'LAYOUT_FINGERPRINT_STALE');

  const result = await applyLayoutTransaction({
    repositoryRoot: project.root,
    candidateFiles: [candidate('knowledge/new/child-en.md', 'new\n')],
    deleteLocators: ['knowledge/runtime'],
    validateCandidate: async ({ lifecycleRoot }) => ({
      ok: await read(lifecycleRoot, 'knowledge/new/child-en.md') === 'new\n',
      errors: [],
    }),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await read(project.lifecycle, 'knowledge/new/child-en.md'), 'new\n');
  await assert.rejects(lstat(join(project.lifecycle, 'knowledge/runtime')), { code: 'ENOENT' });
});

for (const locator of ['../escape.md', '/absolute.md', 'C:\\escape.md', 'knowledge\\escape.md', 'https://example.test/file.md']) {
  test(`rejects unsafe candidate locator ${JSON.stringify(locator)} before staging`, async (context) => {
    const project = await createProject(context);
    const before = await inspectLifecycleTree({ repositoryRoot: project.root });
    const result = await applyLayoutTransaction({
      repositoryRoot: project.root,
      candidateFiles: [candidate(locator, 'unsafe\n')],
      deleteLocators: [],
      validateCandidate: async () => ({ ok: true, errors: [] }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'PATH_ESCAPE');
    assert.deepEqual(await inspectLifecycleTree({ repositoryRoot: project.root }), before);
  });
}

test('rejects a symlinked lifecycle root and a nested escaping symlink', async (context) => {
  const project = await createProject(context);
  const outside = await mkdtemp(join(tmpdir(), 'project-lifecycle-layout-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(project.lifecycle, 'escape'));
  const nested = await inspectLifecycleTree({ repositoryRoot: project.root });
  assert.equal(nested.ok, false);
  assert.equal(nested.errors[0].code, 'PATH_SYMLINK_ESCAPE');

  await rm(join(project.lifecycle, 'escape'));
  const realLifecycle = `${project.lifecycle}-real`;
  await rename(project.lifecycle, realLifecycle);
  await symlink(realLifecycle, project.lifecycle);
  const rootLink = await inspectLifecycleTree({ repositoryRoot: project.root });
  assert.equal(rootLink.ok, false);
  assert.equal(rootLink.errors[0].code, 'PATH_SYMLINK_ESCAPE');
});

test('rejects lifecycle snapshots whose files exceed the bounded fingerprint budget', async (context) => {
  const project = await createProject(context);
  await writeFile(join(project.lifecycle, 'oversized.bin'), Buffer.alloc(4_194_305));

  const result = await inspectLifecycleTree({ repositoryRoot: project.root });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'LAYOUT_TREE_LIMIT_EXCEEDED');
});

test('stops lazy snapshot traversal at the entry limit without consuming the rest of a directory', async (context) => {
  const project = await createProject(context);
  let yielded = 0;
  const result = await inspectLifecycleTree({
    repositoryRoot: project.root,
    snapshotOperations: {
      opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          while (true) {
            yielded += 1;
            yield {
              name: `entry-${yielded}.md`,
              isDirectory: () => false,
              isFile: () => true,
              isSymbolicLink: () => false,
            };
          }
        },
      }),
      lstat: async () => ({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 0,
      }),
      open: async () => ({
        read: async () => ({ bytesRead: 0 }),
        close: async () => {},
      }),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'LAYOUT_TREE_LIMIT_EXCEEDED');
  assert.equal(yielded, 10_001);
});

test('bounds snapshot hashing by bytes actually read instead of stale file metadata', async (context) => {
  const project = await createProject(context);
  let emitted = false;
  const result = await inspectLifecycleTree({
    repositoryRoot: project.root,
    snapshotOperations: {
      opendir: async () => ({
        async *[Symbol.asyncIterator]() {
          if (!emitted) {
            emitted = true;
            yield {
              name: 'growing.md',
              isDirectory: () => false,
              isFile: () => true,
              isSymbolicLink: () => false,
            };
          }
        },
      }),
      lstat: async () => ({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 1,
      }),
      open: async () => ({
        read: async (buffer) => {
          buffer.fill(0x61);
          return { bytesRead: buffer.length };
        },
        close: async () => {},
      }),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'LAYOUT_TREE_LIMIT_EXCEEDED');
});

test('cleans the stage and preserves the original after a bilingual first-write failure', async (context) => {
  const project = await createProject(context);
  let calls = 0;
  const result = await applyLayoutTransaction({
    repositoryRoot: project.root,
    candidateFiles: [
      candidate('knowledge/runtime-en.md', 'English\n'),
      candidate('knowledge/runtime.md', '中文\n'),
    ],
    deleteLocators: [],
    validateCandidate: async () => ({ ok: true, errors: [] }),
  }, {
    atomicWriteValidated: async (input) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('injected'), { code: 'EIO' });
      return atomicWriteValidated(input);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(await read(project.lifecycle, 'knowledge/INDEX-en.md'), 'knowledge root\n');
  assert.equal((await readdir(join(project.root, 'docs'))).some((name) => name.includes('layout-stage')), false);
});

test('does not publish a candidate that fails complete validation', async (context) => {
  const project = await createProject(context);
  const result = await applyLayoutTransaction({
    repositoryRoot: project.root,
    candidateFiles: [candidate('knowledge/INDEX-en.md', 'changed\n')],
    deleteLocators: [],
    validateCandidate: async () => ({ ok: false, errors: [{ code: 'INVALID' }] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'LAYOUT_CANDIDATE_INVALID');
  assert.equal(await read(project.lifecycle, 'knowledge/INDEX-en.md'), 'knowledge root\n');
});

test('accepts rename operations that move and then reject when postconditions hold', async (context) => {
  const project = await createProject(context);
  const result = await applyLayoutTransaction({
    repositoryRoot: project.root,
    candidateFiles: [candidate('knowledge/INDEX-en.md', 'changed\n')],
    deleteLocators: [],
    validateCandidate: async () => ({ ok: true, errors: [] }),
  }, {
    rename: async (from, to) => {
      await rename(from, to);
      throw Object.assign(new Error('moved then rejected'), { code: 'EIO' });
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await read(project.lifecycle, 'knowledge/INDEX-en.md'), 'changed\n');
});

test('rolls back a publish failure to the byte-identical original', async (context) => {
  const project = await createProject(context);
  const before = await inspectLifecycleTree({ repositoryRoot: project.root });
  let calls = 0;
  const result = await applyLayoutTransaction({
    repositoryRoot: project.root,
    candidateFiles: [candidate('knowledge/INDEX-en.md', 'changed\n')],
    deleteLocators: [],
    validateCandidate: async () => ({ ok: true, errors: [] }),
  }, {
    rename: async (from, to) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('publish failed'), { code: 'EIO' });
      return rename(from, to);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'LAYOUT_TRANSACTION_FAILED');
  assert.deepEqual(await inspectLifecycleTree({ repositoryRoot: project.root }), before);
});

test('preserves recovery assets and reports a blocking restore failure', async (context) => {
  const project = await createProject(context);
  let calls = 0;
  const result = await applyLayoutTransaction({
    repositoryRoot: project.root,
    candidateFiles: [candidate('knowledge/INDEX-en.md', 'changed\n')],
    deleteLocators: [],
    validateCandidate: async () => ({ ok: true, errors: [] }),
  }, {
    rename: async (from, to) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('publish failed'), { code: 'EIO' });
      return rename(from, to);
    },
    restoreRename: async () => { throw Object.assign(new Error('restore failed'), { code: 'EIO' }); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'LAYOUT_RESTORE_FAILED');
  const docsEntries = await readdir(join(project.root, 'docs'));
  assert.equal(docsEntries.some((name) => name.includes('layout-backup')), true);
  assert.equal(docsEntries.some((name) => name.includes('layout-stage')), true);
  await assert.rejects(lstat(project.lifecycle), { code: 'ENOENT' });
});
