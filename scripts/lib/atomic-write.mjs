import { open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { resolveInside } from './safe-path.mjs';

function validationError(errors) {
  const error = new Error('Temporary content failed validation');
  error.code = 'VALIDATION_FAILED';
  error.errors = Array.isArray(errors) ? errors : [];
  return error;
}

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
    if (!result?.ok) {
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
      await unlink(temporaryPath).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOENT') throw cleanupError;
      });
    }
    throw error;
  }
}
