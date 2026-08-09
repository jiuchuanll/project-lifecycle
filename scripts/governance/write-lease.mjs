import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';

const LOCATOR = '.project-lifecycle/runtime/governance/write-lease.json';
const OWNER = /^[a-z][a-z0-9-]*$/u;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const outside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
};
const fileState = async (path) => {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const exactKeys = [
  'acquired_at', 'expected_governance_revision', 'expires_at', 'owner_id', 'schema_version',
];
const validLease = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === exactKeys.join('\0')
  && value.schema_version === 1 && OWNER.test(value.owner_id ?? '')
  && isSafeReference(value.expected_governance_revision)
  && typeof value.acquired_at === 'string' && typeof value.expires_at === 'string'
  && Number.isFinite(Date.parse(value.acquired_at)) && Number.isFinite(Date.parse(value.expires_at))
  && Date.parse(value.expires_at) > Date.parse(value.acquired_at);
const parseLease = (source) => {
  try { const value = JSON.parse(source); return validLease(value) ? value : null; } catch { return null; }
};

const safeDirectory = async (path, rootReal, create) => {
  let stats = await fileState(path);
  if (stats === null && create) {
    await mkdir(path, { mode: 0o700 });
    stats = await lstat(path);
  }
  if (stats === null) return null;
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Unsafe runtime directory.');
  const physical = await realpath(path);
  if (outside(rootReal, physical)) throw new Error('Runtime directory escapes the worktree.');
  return physical;
};

const resolvePaths = async (root, create) => {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Absolute worktree root required.');
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Real worktree directory required.');
  const rootReal = await realpath(root);
  let current = rootReal;
  for (const segment of ['.project-lifecycle', 'runtime', 'governance']) {
    current = join(current, segment);
    current = await safeDirectory(current, rootReal, create);
    if (current === null) return { rootReal, directory: null, leasePath: null };
  }
  return { rootReal, directory: current, leasePath: join(current, 'write-lease.json') };
};

const readCurrent = async (leasePath) => {
  if (leasePath === null) return { exists: false, source: null, lease: null };
  const stats = await fileState(leasePath);
  if (stats === null) return { exists: false, source: null, lease: null };
  if (!stats.isFile() || stats.isSymbolicLink()) return { exists: true, source: null, lease: null };
  const source = await readFile(leasePath, 'utf8');
  return { exists: true, source, lease: parseLease(source) };
};

const writeTemporary = async (directory, content) => {
  const path = join(directory, `.write-lease.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
};

const publishExclusive = async (directory, leasePath, content) => {
  const temporary = await writeTemporary(directory, content);
  try {
    await link(temporary, leasePath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
};

const replaceAtomic = async (directory, leasePath, content) => {
  const temporary = await writeTemporary(directory, content);
  try {
    await rename(temporary, leasePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
};

export function createGovernanceWriteLease({
  root,
  clock = () => Date.now(),
  ttlMs = 120_000,
  verifyGovernanceRevision,
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 120_000) {
    throw new RangeError('Governance lease TTL must be between 1 and 120000 milliseconds.');
  }
  if (typeof clock !== 'function') throw new TypeError('Governance lease clock must be callable.');
  const now = () => {
    const value = clock();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw new TypeError('Governance lease clock must return a finite time.');
    return milliseconds;
  };
  const inputValid = ({ ownerId, expectedGovernanceRevision }) => OWNER.test(ownerId ?? '')
    && isSafeReference(expectedGovernanceRevision);
  const leaseFor = (ownerId, revision, acquiredAt, currentTime) => ({
    schema_version: 1,
    owner_id: ownerId,
    acquired_at: new Date(acquiredAt).toISOString(),
    expires_at: new Date(currentTime + ttlMs).toISOString(),
    expected_governance_revision: revision,
  });
  const contentFor = (lease) => `${JSON.stringify(lease, null, 2)}\n`;
  const pathsOrFailure = async (create) => {
    try { return { ok: true, value: await resolvePaths(root, create) }; } catch {
      return failure('GOVERNANCE_LEASE_PATH_INVALID', '/root', 'Lease path must remain in the explicit worktree runtime namespace.');
    }
  };

  return Object.freeze({
    acquire: async ({ ownerId, expectedGovernanceRevision } = {}) => {
      if (!inputValid({ ownerId, expectedGovernanceRevision })) {
        return failure('GOVERNANCE_LEASE_INPUT_INVALID', '/arguments', 'Lease acquisition requires a bounded owner and governance revision.');
      }
      const paths = await pathsOrFailure(true);
      if (!paths.ok) return paths;
      let existing;
      try { existing = await readCurrent(paths.value.leasePath); } catch {
        return failure('GOVERNANCE_LEASE_INVALID', '/lease', 'Existing governance lease cannot be read safely.');
      }
      const currentTime = now();
      let status = 'acquired';
      if (existing.exists) {
        if (!existing.lease) return failure('GOVERNANCE_LEASE_INVALID', '/lease', 'Malformed governance lease requires explicit repair.');
        if (Date.parse(existing.lease.expires_at) > currentTime) {
          return failure('GOVERNANCE_LEASE_HELD', '/lease', 'Another unexpired governance lease is active.');
        }
        if (typeof verifyGovernanceRevision !== 'function'
          || await verifyGovernanceRevision(expectedGovernanceRevision) !== true) {
          return failure('GOVERNANCE_LEASE_RECOVERY_UNVERIFIED', '/expectedGovernanceRevision', 'Expired lease recovery requires current revision verification.');
        }
        const unchanged = await readCurrent(paths.value.leasePath);
        if (unchanged.source !== existing.source) {
          return failure('GOVERNANCE_LEASE_HELD', '/lease', 'Governance lease changed during recovery.');
        }
        await unlink(paths.value.leasePath);
        status = 'recovered';
      }
      const lease = leaseFor(ownerId, expectedGovernanceRevision, currentTime, currentTime);
      try {
        await publishExclusive(paths.value.directory, paths.value.leasePath, contentFor(lease));
      } catch (error) {
        return failure(
          error?.code === 'EEXIST' ? 'GOVERNANCE_LEASE_HELD' : 'GOVERNANCE_LEASE_WRITE_FAILED',
          '/lease',
          'Governance lease could not be acquired atomically.',
        );
      }
      return ok({ status, locator: LOCATOR, lease });
    },
    renew: async ({ ownerId, expectedGovernanceRevision } = {}) => {
      if (!inputValid({ ownerId, expectedGovernanceRevision })) {
        return failure('GOVERNANCE_LEASE_INPUT_INVALID', '/arguments', 'Lease renewal requires the exact owner and governance revision.');
      }
      const paths = await pathsOrFailure(false);
      if (!paths.ok) return paths;
      const existing = await readCurrent(paths.value.leasePath).catch(() => null);
      if (!existing?.lease) return failure('GOVERNANCE_LEASE_INVALID', '/lease', 'A valid governance lease is required for renewal.');
      if (existing.lease.owner_id !== ownerId) return failure('GOVERNANCE_LEASE_OWNER_MISMATCH', '/ownerId', 'Only the current lease owner may renew.');
      if (existing.lease.expected_governance_revision !== expectedGovernanceRevision) {
        return failure('GOVERNANCE_LEASE_REVISION_MISMATCH', '/expectedGovernanceRevision', 'Lease renewal cannot change the pinned governance revision.');
      }
      const currentTime = now();
      if (Date.parse(existing.lease.expires_at) <= currentTime) return failure('GOVERNANCE_LEASE_EXPIRED', '/lease', 'Expired leases must use verified recovery.');
      const lease = leaseFor(ownerId, expectedGovernanceRevision, Date.parse(existing.lease.acquired_at), currentTime);
      try { await replaceAtomic(paths.value.directory, paths.value.leasePath, contentFor(lease)); } catch {
        return failure('GOVERNANCE_LEASE_WRITE_FAILED', '/lease', 'Governance lease renewal failed.');
      }
      return ok({ status: 'renewed', locator: LOCATOR, lease });
    },
    release: async ({ ownerId } = {}) => {
      if (!OWNER.test(ownerId ?? '')) return failure('GOVERNANCE_LEASE_INPUT_INVALID', '/ownerId', 'Lease release requires the exact owner.');
      const paths = await pathsOrFailure(false);
      if (!paths.ok) return paths;
      const existing = await readCurrent(paths.value.leasePath).catch(() => null);
      if (!existing?.lease) return failure('GOVERNANCE_LEASE_INVALID', '/lease', 'A valid governance lease is required for release.');
      if (existing.lease.owner_id !== ownerId) return failure('GOVERNANCE_LEASE_OWNER_MISMATCH', '/ownerId', 'Only the current lease owner may release.');
      try { await unlink(paths.value.leasePath); } catch {
        return failure('GOVERNANCE_LEASE_WRITE_FAILED', '/lease', 'Governance lease release failed.');
      }
      return ok({ status: 'released', locator: LOCATOR });
    },
  });
}
