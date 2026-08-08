import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { atomicWriteValidated } from '../../scripts/lib/atomic-write.mjs';

const TEMP_PREFIX = 'project-lifecycle-atomic-write-';

async function createSandbox() {
  const root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const files = [];
  const directories = [root];

  return {
    root,
    async directory(relativePath) {
      const path = join(root, relativePath);
      await mkdir(path);
      directories.push(path);
      return path;
    },
    trackFile(path) {
      files.push(path);
      return path;
    },
    trackDirectory(path) {
      directories.push(path);
      return path;
    },
    async file(relativePath, content) {
      const path = join(root, relativePath);
      files.push(path);
      await writeFile(path, content, 'utf8');
      return path;
    },
    async link(target, relativePath) {
      const path = join(root, relativePath);
      files.push(path);
      await symlink(target, path);
      return path;
    },
    async cleanup() {
      for (const path of files.reverse()) {
        await unlink(path).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      for (const path of directories.reverse()) {
        await chmod(path, 0o700).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await rmdir(path).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
  };
}

function temporarySibling(target) {
  return join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
}

async function assertAbsent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

const acceptsContent = (expected) => async (content) => ({
  ok: content === expected,
  errors: content === expected ? [] : ['unexpected content'],
});

test('writes validated content with an atomic sibling replacement', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = sandbox.trackFile(join(allowedRoot, 'project-map.json'));
    const temp = sandbox.trackFile(temporarySibling(target));
    const content = '{"version":1}\n';

    await atomicWriteValidated({
      root: allowedRoot,
      target: 'project-map.json',
      content,
      validate: acceptsContent(content),
    });

    assert.equal(await readFile(target, 'utf8'), content);
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});

test('does not overwrite or clean a pre-existing temporary sibling', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('allowed/project-map.json', 'previous valid\n');
    const temp = await sandbox.file(
      `allowed/.project-map.json.${process.pid}.tmp`,
      'owned by another write\n',
    );

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: 'project-map.json',
        content: 'replacement\n',
        validate: acceptsContent('replacement\n'),
      }),
      { code: 'EEXIST' },
    );

    assert.equal(await readFile(target, 'utf8'), 'previous valid\n');
    assert.equal(await readFile(temp, 'utf8'), 'owned by another write\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('rejects parent traversal without changing the existing outside file', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('outside.json', 'previous\n');
    const temp = sandbox.trackFile(temporarySibling(target));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: '../outside.json',
        content: 'replacement\n',
        validate: acceptsContent('replacement\n'),
      }),
      { code: 'PATH_ESCAPE' },
    );

    assert.equal(await readFile(target, 'utf8'), 'previous\n');
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});

test('rejects an absolute path outside the allowed root without changing it', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('absolute-outside.json', 'previous\n');
    const temp = sandbox.trackFile(temporarySibling(target));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target,
        content: 'replacement\n',
        validate: acceptsContent('replacement\n'),
      }),
      { code: 'PATH_ESCAPE' },
    );

    assert.equal(await readFile(target, 'utf8'), 'previous\n');
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});

test('rejects a raw absolute target even when it is inside the allowed root', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('allowed/project-map.json', 'previous\n');
    const temp = sandbox.trackFile(temporarySibling(target));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target,
        content: 'replacement\n',
        validate: acceptsContent('replacement\n'),
      }),
      { code: 'PATH_ESCAPE' },
    );

    assert.equal(await readFile(target, 'utf8'), 'previous\n');
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});

for (const { label, candidate, existingRelativePath } of [
  {
    label: 'slash-separated',
    candidate: 'nested/../project-map.json',
    existingRelativePath: 'allowed/project-map.json',
  },
  {
    label: 'backslash-separated',
    candidate: 'nested\\..\\project-map.json',
    existingRelativePath: 'allowed/nested\\..\\project-map.json',
  },
]) {
  test(`rejects a raw ${label} parent segment before normalization`, async () => {
    const sandbox = await createSandbox();
    try {
      const allowedRoot = await sandbox.directory('allowed');
      const target = await sandbox.file(existingRelativePath, 'previous\n');
      const temp = sandbox.trackFile(temporarySibling(target));

      await assert.rejects(
        atomicWriteValidated({
          root: allowedRoot,
          target: candidate,
          content: 'replacement\n',
          validate: acceptsContent('replacement\n'),
        }),
        { code: 'PATH_ESCAPE' },
      );

      assert.equal(await readFile(target, 'utf8'), 'previous\n');
      await assertAbsent(temp);
    } finally {
      await sandbox.cleanup();
    }
  });
}

for (const { label, candidate } of [
  { label: 'Windows drive with backslashes', candidate: 'C:\\governance\\project-map.json' },
  { label: 'Windows drive with slashes', candidate: 'C:/governance/project-map.json' },
  { label: 'Windows UNC', candidate: '\\\\server\\share\\project-map.json' },
  { label: 'Windows rooted backslash', candidate: '\\governance\\project-map.json' },
]) {
  test(`rejects a raw ${label} target on POSIX`, { skip: process.platform === 'win32' }, async () => {
    const sandbox = await createSandbox();
    try {
      const allowedRoot = await sandbox.directory('allowed');
      const possibleTarget = sandbox.trackFile(join(allowedRoot, candidate));
      const possibleTemp = sandbox.trackFile(temporarySibling(possibleTarget));

      await assert.rejects(
        atomicWriteValidated({
          root: allowedRoot,
          target: candidate,
          content: 'replacement\n',
          validate: acceptsContent('replacement\n'),
        }),
        { code: 'PATH_ESCAPE' },
      );

      await assertAbsent(possibleTarget);
      await assertAbsent(possibleTemp);
    } finally {
      await sandbox.cleanup();
    }
  });
}

test('rejects a symlinked parent that escapes the allowed root', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const outside = await sandbox.directory('outside');
    await sandbox.link(outside, 'allowed/linked');
    const target = await sandbox.file('outside/project-map.json', 'previous\n');
    const temp = sandbox.trackFile(temporarySibling(target));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: 'linked/project-map.json',
        content: 'replacement\n',
        validate: acceptsContent('replacement\n'),
      }),
      { code: 'PATH_SYMLINK_ESCAPE' },
    );

    assert.equal(await readFile(target, 'utf8'), 'previous\n');
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});

test('rejects an existing target symlink that escapes the allowed root', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('outside-target.json', 'previous\n');
    const link = await sandbox.link(target, 'allowed/project-map.json');
    const temp = sandbox.trackFile(temporarySibling(link));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: 'project-map.json',
        content: 'replacement\n',
        validate: acceptsContent('replacement\n'),
      }),
      { code: 'PATH_SYMLINK_ESCAPE' },
    );

    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readFile(target, 'utf8'), 'previous\n');
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});

test('rejects a dangling final symlink as a symlink escape', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const missingTarget = join(sandbox.root, 'missing-target.json');
    const link = await sandbox.link(missingTarget, 'allowed/project-map.json');
    const temp = sandbox.trackFile(temporarySibling(link));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: 'project-map.json',
        content: 'replacement\n',
        validate: acceptsContent('replacement\n'),
      }),
      { code: 'PATH_SYMLINK_ESCAPE' },
    );

    assert.equal((await lstat(link)).isSymbolicLink(), true);
    await assertAbsent(missingTarget);
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});

test('rejects invalid temporary content and preserves the previous valid file', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('allowed/project-map.json', 'previous valid\n');
    const temp = sandbox.trackFile(temporarySibling(target));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: 'project-map.json',
        content: 'invalid replacement\n',
        validate: async () => ({ ok: false, errors: ['invalid project map'] }),
      }),
      (error) => {
        assert.equal(error.code, 'VALIDATION_FAILED');
        assert.deepEqual(error.errors, ['invalid project map']);
        return true;
      },
    );

    assert.equal(await readFile(target, 'utf8'), 'previous valid\n');
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});

test('rejects a malformed truthy validator result', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('allowed/project-map.json', 'previous valid\n');
    const temp = sandbox.trackFile(temporarySibling(target));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: 'project-map.json',
        content: 'replacement\n',
        validate: async () => ({ ok: 'yes', errors: [] }),
      }),
      { code: 'VALIDATION_FAILED' },
    );

    assert.equal(await readFile(target, 'utf8'), 'previous valid\n');
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});

test('cleans the temporary sibling when the validator throws', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('allowed/project-map.json', 'previous valid\n');
    const temp = sandbox.trackFile(temporarySibling(target));
    const validatorError = new Error('validator crashed');

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: 'project-map.json',
        content: 'replacement\n',
        validate: async () => {
          throw validatorError;
        },
      }),
      (error) => error === validatorError,
    );

    assert.equal(await readFile(target, 'utf8'), 'previous valid\n');
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});

test('preserves a validation error when temporary cleanup also fails', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('allowed/project-map.json', 'previous valid\n');
    const temp = sandbox.trackDirectory(temporarySibling(target));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: 'project-map.json',
        content: 'invalid replacement\n',
        validate: async () => {
          await unlink(temp);
          await mkdir(temp);
          return { ok: false, errors: ['invalid project map'] };
        },
      }),
      (error) => {
        assert.equal(error.code, 'VALIDATION_FAILED');
        assert.deepEqual(error.errors, ['invalid project map']);
        assert.equal(error.cleanupError?.syscall, 'unlink');
        return true;
      },
    );

    assert.equal(await readFile(target, 'utf8'), 'previous valid\n');
    assert.equal((await lstat(temp)).isDirectory(), true);
  } finally {
    await sandbox.cleanup();
  }
});

test('preserves a rename error when temporary cleanup also fails', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('allowed/project-map.json', 'previous valid\n');
    const temp = sandbox.trackDirectory(temporarySibling(target));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: 'project-map.json',
        content: 'replacement\n',
        validate: async () => {
          await unlink(temp);
          await mkdir(temp);
          return { ok: true, errors: [] };
        },
      }),
      (error) => {
        assert.equal(error.syscall, 'rename');
        assert.equal(error.cleanupError?.syscall, 'unlink');
        return true;
      },
    );

    assert.equal(await readFile(target, 'utf8'), 'previous valid\n');
    assert.equal((await lstat(temp)).isDirectory(), true);
  } finally {
    await sandbox.cleanup();
  }
});

test('cleans the temporary sibling and preserves the target when rename loses a race', async () => {
  const sandbox = await createSandbox();
  try {
    const allowedRoot = await sandbox.directory('allowed');
    const target = await sandbox.file('allowed/project-map.json', 'previous valid\n');
    const temp = sandbox.trackFile(temporarySibling(target));

    await assert.rejects(
      atomicWriteValidated({
        root: allowedRoot,
        target: 'project-map.json',
        content: 'replacement\n',
        validate: async (content) => {
          assert.equal(content, 'replacement\n');
          await unlink(temp);
          return { ok: true, errors: [] };
        },
      }),
      { code: 'ENOENT' },
    );

    assert.equal(await readFile(target, 'utf8'), 'previous valid\n');
    await assertAbsent(temp);
  } finally {
    await sandbox.cleanup();
  }
});
