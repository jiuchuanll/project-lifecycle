import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function outside(base, candidate) {
  const pathFromBase = relative(base, candidate);
  return (
    pathFromBase === '..' ||
    pathFromBase.startsWith(`..${sep}`) ||
    isAbsolute(pathFromBase)
  );
}

function pathError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRawAbsolute(candidate) {
  return (
    isAbsolute(candidate) ||
    candidate.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/u.test(candidate)
  );
}

function hasRawParentSegment(candidate) {
  return candidate.split(/[\\/]/u).includes('..');
}

/**
 * Resolves a relative target beneath an explicit governance root.
 *
 * Trust precondition: Project Lifecycle is the sole writer beneath `root`
 * during this operation. A later governance lease will serialize writers.
 * This v1 helper does not claim to resist an untrusted process concurrently
 * replacing entries in the same directory tree.
 */
export async function resolveInside(root, candidate) {
  if (isRawAbsolute(candidate) || hasRawParentSegment(candidate)) {
    throw pathError('PATH_ESCAPE', `Path must be a bounded relative target: ${candidate}`);
  }

  const rootPath = resolve(root);
  const rootRealPath = await realpath(rootPath);
  const candidatePath = resolve(rootPath, candidate);

  if (outside(rootPath, candidatePath)) {
    throw pathError('PATH_ESCAPE', `Path escapes allowed root: ${candidate}`);
  }

  const parentRealPath = await realpath(dirname(candidatePath));
  if (outside(rootRealPath, parentRealPath)) {
    throw pathError('PATH_SYMLINK_ESCAPE', `Path escapes allowed root through a symlink: ${candidate}`);
  }

  let targetStat;
  try {
    targetStat = await lstat(candidatePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (targetStat?.isSymbolicLink()) {
    let targetRealPath;
    try {
      targetRealPath = await realpath(candidatePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw pathError(
          'PATH_SYMLINK_ESCAPE',
          `Path ends at a dangling symlink: ${candidate}`,
        );
      }
      throw error;
    }
    if (outside(rootRealPath, targetRealPath)) {
      throw pathError(
        'PATH_SYMLINK_ESCAPE',
        `Path escapes allowed root through a symlink: ${candidate}`,
      );
    }
  }

  return join(parentRealPath, basename(candidatePath));
}
