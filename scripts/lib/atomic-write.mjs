import { open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { resolveInside } from './safe-path.mjs';

function validationError(errors) {
  const error = new Error('Temporary content failed validation');
  error.code = 'VALIDATION_FAILED';
  error.errors = Array.isArray(errors) ? errors : [];
  return error;
}

function attachCleanupError(primaryError, cleanupError) {
  Object.defineProperty(primaryError, 'cleanupError', {
    configurable: true,
    enumerable: true,
    value: cleanupError,
  });
}

/**
 * Atomically replaces a target after validating the fsynced temporary content.
 *
 * Trust precondition: Project Lifecycle is the sole writer beneath `root`
 * during this operation. A later governance lease will serialize writers.
 * This v1 helper does not claim to resist an untrusted process concurrently
 * replacing entries in the same directory tree.
 */
export async function atomicWriteValidated({ root, target, content, validate }) {
  const targetPath = await resolveInside(root, target);
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.tmp`,
  );
  let temporaryHandle;
  let ownsTemporaryPath = false;

  try {
    temporaryHandle = await open(temporaryPath, 'wx', 0o600);
    ownsTemporaryPath = true;
    await temporaryHandle.writeFile(content);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    const temporaryContent = await readFile(temporaryPath, 'utf8');
    const result = await validate(temporaryContent);
    if (result?.ok !== true) {
      throw validationError(result?.errors);
    }

    await rename(temporaryPath, targetPath);
    ownsTemporaryPath = false;
    return targetPath;
  } catch (error) {
    if (temporaryHandle) {
      await temporaryHandle.close().catch(() => {});
    }
    if (ownsTemporaryPath) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          attachCleanupError(error, cleanupError);
        }
      }
    }
    throw error;
  }
}
