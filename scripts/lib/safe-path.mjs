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

export async function resolveInside(root, candidate) {
  const rootPath = resolve(root);
  const rootRealPath = await realpath(rootPath);
  const candidatePath = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(rootPath, candidate);

  if (outside(rootPath, candidatePath)) {
    throw pathError('PATH_ESCAPE', `Path escapes allowed root: ${candidate}`);
  }

  const parentRealPath = await realpath(dirname(candidatePath));
  if (outside(rootRealPath, parentRealPath)) {
    throw pathError('PATH_SYMLINK_ESCAPE', `Path escapes allowed root through a symlink: ${candidate}`);
  }

  try {
    const targetStat = await lstat(candidatePath);
    if (targetStat.isSymbolicLink()) {
      const targetRealPath = await realpath(candidatePath);
      if (outside(rootRealPath, targetRealPath)) {
        throw pathError(
          'PATH_SYMLINK_ESCAPE',
          `Path escapes allowed root through a symlink: ${candidate}`,
        );
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return join(parentRealPath, basename(candidatePath));
}
