import { createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';

const METHODS = [
  'commitCandidate',
  'compareAndSwap',
  'createCandidate',
  'listAtRevision',
  'readAtRevision',
  'resolveRevision',
];

export const assertVersionedStorage = (storage) => {
  if (storage === null || typeof storage !== 'object' || Array.isArray(storage)
    || Object.keys(storage).sort().join('\0') !== METHODS.join('\0')
    || METHODS.some((method) => typeof storage[method] !== 'function')) {
    return fail([createError('VERSIONED_STORAGE_INVALID', '/', 'Versioned storage must implement the exact portable interface.')]);
  }
  return ok(storage);
};

export const createVersionedStorage = (methods) => {
  const validation = assertVersionedStorage(methods);
  if (!validation.ok) throw new TypeError('Invalid versioned storage interface.');
  return Object.freeze(Object.fromEntries(METHODS.map((method) => [method, methods[method]])));
};
