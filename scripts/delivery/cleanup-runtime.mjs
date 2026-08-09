import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';

const ID = /^prd-[a-z0-9-]+$/u;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const closureKeys = new Set([
  'owner_status',
  'closure_ref',
  'verification_result_ref',
  'knowledge_handoff',
  'conflict_disposition_ref',
]);
const handoffKeys = new Set(['kind', 'ref']);

const outside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
};

const validateClosure = (closure) => {
  if (!record(closure) || Object.keys(closure).some((key) => !closureKeys.has(key))) {
    return failure('CLEANUP_PREREQUISITE_MISSING', '/closure', 'A closed durable outcome is required before runtime cleanup.');
  }
  if (closure.owner_status === 'ACTIVE') {
    return failure('PRD_RUNTIME_ACTIVE', '/closure/owner_status', 'Active PRD runtime state cannot be cleaned.');
  }
  if (!['CLOSED', 'CANCELLED', 'WITHDRAWN', 'REJECTED'].includes(closure.owner_status)
    || !isSafeReference(closure.closure_ref)
    || !isSafeReference(closure.verification_result_ref)
    || !isSafeReference(closure.conflict_disposition_ref)
    || !record(closure.knowledge_handoff)
    || Object.keys(closure.knowledge_handoff).some((key) => !handoffKeys.has(key))
    || !['KNOWLEDGE_DIFF', 'NO_CHANGE'].includes(closure.knowledge_handoff.kind)
    || !isSafeReference(closure.knowledge_handoff.ref)) {
    return failure('CLEANUP_PREREQUISITE_MISSING', '/closure', 'Closure, verification, conflict, and knowledge handoff evidence are all required.');
  }
  return ok(closure);
};

const resolveExistingPrdDirectory = async (root, prdId) => {
  if (typeof root !== 'string' || !isAbsolute(root)) throw Object.assign(new Error('Invalid root.'), { code: 'PATH' });
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw Object.assign(new Error('Invalid root.'), { code: 'PATH' });
  const rootReal = await realpath(root);
  let current = rootReal;
  for (const segment of ['.project-lifecycle', 'runtime', 'prds', prdId]) {
    current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw Object.assign(new Error('Unsafe runtime path.'), { code: 'PATH' });
    current = await realpath(current);
    if (outside(rootReal, current)) throw Object.assign(new Error('Escaping runtime path.'), { code: 'PATH' });
  }
  return current;
};

const retryTwice = async (operation) => {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await operation();
      return null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      lastError = error;
    }
  }
  return lastError;
};

const pathState = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

export async function cleanupPrdRuntime(input = {}, operations = {}) {
  if (!record(input) || !ID.test(input.prd_id ?? '')) {
    return failure('PRD_ID_INVALID', '/prd_id', 'Runtime cleanup requires one canonical PRD ID.');
  }
  const closure = validateClosure(input.closure);
  if (!closure.ok) return closure;

  let directory;
  try {
    directory = await resolveExistingPrdDirectory(input.root, input.prd_id);
  } catch {
    return failure('PRD_RUNTIME_PATH_INVALID', '/root', 'PRD runtime cleanup cannot traverse symlinks or leave the worktree.');
  }
  if (!directory) return ok({ status: 'already-clean' });

  let entries = await readdir(directory);
  if (entries.some((entry) => !['cleanup_pending', 'context-receipt.json'].includes(entry))) {
    return failure('CLEANUP_SCOPE_NOT_EMPTY', '/runtime', 'PRD runtime contains files outside the exact cleanup scope.');
  }

  const receiptPath = join(directory, 'context-receipt.json');
  if (entries.includes('context-receipt.json')) {
    const stats = await lstat(receiptPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return failure('PRD_RUNTIME_PATH_INVALID', '/receipt', 'The runtime receipt must be one regular file.');
    }
    const removeFile = operations.removeFile ?? unlink;
    const error = await retryTwice(() => removeFile(receiptPath));
    if (error) return failure('CLEANUP_FAILED', '/receipt', 'The exact runtime receipt could not be removed.');
    if (await pathState(receiptPath)) {
      return failure('CLEANUP_FAILED', '/receipt', 'Runtime receipt removal could not be verified.');
    }
  }

  const pendingPath = join(directory, 'cleanup_pending');
  entries = await readdir(directory);
  if (entries.includes('cleanup_pending')) {
    const stats = await lstat(pendingPath);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (await readdir(pendingPath)).length > 0) {
      return failure('PRD_RUNTIME_PATH_INVALID', '/cleanup_pending', 'Cleanup pending must be one empty local directory.');
    }
    const pendingRemovalError = await retryTwice(() => (operations.removeDirectory ?? rmdir)(pendingPath));
    if (pendingRemovalError || await pathState(pendingPath)) {
      return failure('CLEANUP_PENDING', '/runtime', 'Exact cleanup is pending a later bounded retry.');
    }
  }

  const removeDirectory = operations.removeDirectory ?? rmdir;
  let removalError = await retryTwice(() => removeDirectory(directory));
  const remainingDirectory = await pathState(directory);
  if (!remainingDirectory) return ok({ status: 'cleaned' });
  if (remainingDirectory.isSymbolicLink() || !remainingDirectory.isDirectory()) {
    return failure('PRD_RUNTIME_PATH_INVALID', '/runtime', 'Runtime cleanup postcondition found an unsafe path.');
  }
  if (!removalError) removalError = new Error('Directory removal postcondition failed.');
  if ((await readdir(directory)).length > 0) {
    return failure('CLEANUP_FAILED', '/runtime', 'Runtime directory is not empty after exact receipt cleanup.');
  }

  try {
    await mkdir(pendingPath);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      return failure('CLEANUP_FAILED', '/runtime', 'Runtime cleanup failed without a bounded retry marker.');
    }
  }
  return failure('CLEANUP_PENDING', '/runtime', 'Exact cleanup is pending a later bounded retry.');
}
