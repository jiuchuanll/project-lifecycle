import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGovernanceWriteLease } from '../../scripts/governance/write-lease.mjs';

const exec = promisify(execFile);

const root = async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'governance-write-lease-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const missing = async (path) => {
  try { await access(path); return false; } catch (error) { return error.code === 'ENOENT'; }
};

test('acquires one atomically published short lease with the exact contract', async (context) => {
  const worktree = await root(context);
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  const lease = createGovernanceWriteLease({ root: worktree, clock: () => now, ttlMs: 30_000 });

  const acquired = await lease.acquire({ ownerId: 'prd-wiki-v1', expectedGovernanceRevision: 'revision:abc123' });

  assert.equal(acquired.ok, true);
  assert.equal(acquired.value.locator, '.project-lifecycle/runtime/governance/write-lease.json');
  assert.deepEqual(acquired.value.lease, {
    schema_version: 1,
    owner_id: 'prd-wiki-v1',
    acquired_at: '2026-08-09T00:00:00.000Z',
    expires_at: '2026-08-09T00:00:30.000Z',
    expected_governance_revision: 'revision:abc123',
  });
  assert.deepEqual(JSON.parse(await readFile(join(worktree, acquired.value.locator), 'utf8')), acquired.value.lease);
  now += 1;
});

test('rejects contention and permits only owner renewal and release', async (context) => {
  const worktree = await root(context);
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  const lease = createGovernanceWriteLease({ root: worktree, clock: () => now, ttlMs: 20_000 });
  await lease.acquire({ ownerId: 'owner-a', expectedGovernanceRevision: 'revision:one' });

  assert.equal((await lease.acquire({ ownerId: 'owner-b', expectedGovernanceRevision: 'revision:one' })).errors[0].code, 'GOVERNANCE_LEASE_HELD');
  assert.equal((await lease.renew({ ownerId: 'owner-b', expectedGovernanceRevision: 'revision:one' })).errors[0].code, 'GOVERNANCE_LEASE_OWNER_MISMATCH');
  assert.equal((await lease.release({ ownerId: 'owner-b' })).errors[0].code, 'GOVERNANCE_LEASE_OWNER_MISMATCH');

  now += 10_000;
  const renewed = await lease.renew({ ownerId: 'owner-a', expectedGovernanceRevision: 'revision:one' });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.value.lease.acquired_at, '2026-08-09T00:00:00.000Z');
  assert.equal(renewed.value.lease.expires_at, '2026-08-09T00:00:30.000Z');
  const released = await lease.release({ ownerId: 'owner-a' });
  assert.equal(released.ok, true);
  assert.equal(await missing(join(worktree, released.value.locator)), true);
});

test('recovers an expired lease only after current governance revision verification', async (context) => {
  const worktree = await root(context);
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  let verified = false;
  const lease = createGovernanceWriteLease({
    root: worktree,
    clock: () => now,
    ttlMs: 10_000,
    verifyGovernanceRevision: async (revision) => verified && revision === 'revision:two',
  });
  await lease.acquire({ ownerId: 'owner-a', expectedGovernanceRevision: 'revision:one' });
  now += 10_001;

  const blocked = await lease.acquire({ ownerId: 'owner-b', expectedGovernanceRevision: 'revision:two' });
  assert.equal(blocked.errors[0].code, 'GOVERNANCE_LEASE_RECOVERY_UNVERIFIED');
  verified = true;
  const recovered = await lease.acquire({ ownerId: 'owner-b', expectedGovernanceRevision: 'revision:two' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.value.status, 'recovered');
  assert.equal(recovered.value.lease.owner_id, 'owner-b');
  assert.equal(recovered.value.lease.expected_governance_revision, 'revision:two');
});

test('refuses malformed lease state and never repairs it implicitly', async (context) => {
  const worktree = await root(context);
  const lease = createGovernanceWriteLease({ root: worktree, clock: () => 0, ttlMs: 1_000 });
  const first = await lease.acquire({ ownerId: 'owner-a', expectedGovernanceRevision: 'revision:one' });
  const path = join(worktree, first.value.locator);
  await writeFile(path, '{ malformed');

  assert.equal((await lease.acquire({ ownerId: 'owner-b', expectedGovernanceRevision: 'revision:two' })).errors[0].code, 'GOVERNANCE_LEASE_INVALID');
  assert.equal(await readFile(path, 'utf8'), '{ malformed');
});

test('caps leases at 120 seconds and rejects revision drift during renewal', async (context) => {
  const worktree = await root(context);
  assert.throws(
    () => createGovernanceWriteLease({ root: worktree, ttlMs: 120_001 }),
    /TTL/,
  );
  const lease = createGovernanceWriteLease({ root: worktree, clock: () => 0 });
  await lease.acquire({ ownerId: 'owner-a', expectedGovernanceRevision: 'revision:one' });
  assert.equal((await lease.renew({
    ownerId: 'owner-a', expectedGovernanceRevision: 'revision:two',
  })).errors[0].code, 'GOVERNANCE_LEASE_REVISION_MISMATCH');
});

test('keeps runtime lease state outside docs and ignored by Git', async (context) => {
  const worktree = await root(context);
  await writeFile(join(worktree, '.gitignore'), '.project-lifecycle/runtime/\n');
  await exec('git', ['init', '-b', 'main'], { cwd: worktree });
  const lease = createGovernanceWriteLease({ root: worktree, clock: () => 0 });
  const acquired = await lease.acquire({ ownerId: 'owner-a', expectedGovernanceRevision: 'revision:one' });

  assert.equal(acquired.value.locator.startsWith('docs/'), false);
  assert.equal(acquired.value.locator, '.project-lifecycle/runtime/governance/write-lease.json');
  const ignored = await exec('git', ['check-ignore', acquired.value.locator], { cwd: worktree });
  assert.equal(ignored.stdout.trim(), acquired.value.locator);
});
