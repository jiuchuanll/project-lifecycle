import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { registerRepository } from '../../scripts/governance/repository-registry.mjs';
import { derivePointerRebind } from '../../scripts/governance/rebind-pointer.mjs';
import { resolveGovernanceRoot } from '../../scripts/governance/resolve-root.mjs';
import { validateJson } from '../../scripts/lib/validate-json.mjs';

const fixture = JSON.parse(await readFile(
  new URL('../fixtures/governance/pointers/cases.json', import.meta.url),
  'utf8',
));
const baseMap = () => ({
  schema_version: 2,
  project_id: 'sample-app',
  knowledge_baseline: 'baseline:accepted',
  project_identity: {
    label: { en: 'Sample app', 'zh-CN': '示例应用' },
    purpose: { en: 'Owns the sample product.', 'zh-CN': '负责示例产品。' },
    calibration_ref: 'calibration:accepted',
  },
  identity_lineage: [],
  repositories: [],
  constraints: [],
  domains: [{
    id: 'desktop-experience',
    kind: 'domain',
    label: { en: 'Desktop experience', 'zh-CN': '桌面体验' },
    purpose: { en: 'Owns desktop interaction.', 'zh-CN': '负责桌面交互。' },
    domain_state: 'confirmed',
    scope: { includes: ['desktop interaction'], excludes: [] },
    parent_id: null,
    relationships: [],
    evidence_refs: ['repo:README.md'],
    known_gaps: [],
  }],
});
const pointer = (overrides = {}) => ({
  schema_version: 1,
  project_id: 'sample-app',
  repository_id: 'sample-repository',
  governance_locator: 'github:example/sample-governance',
  ...overrides,
});

const projectRoot = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-pointer-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'project-lifecycle'), { recursive: true });
  return root;
};
const writeLifecycle = (root, name, value) => writeFile(
  join(root, 'docs', 'project-lifecycle', name),
  `${JSON.stringify(value, null, 2)}\n`,
);

test('reuses the fixed local project map without consulting a remote locator', async (context) => {
  const root = await projectRoot(context);
  await writeLifecycle(root, 'project-map.json', baseMap());
  let remoteReads = 0;

  const result = await resolveGovernanceRoot({
    repositoryRoot: root,
    resolvePortableLocator: async () => { remoteReads += 1; },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    status: 'resolved',
    source: 'local-map',
    governance_locator: 'docs/project-lifecycle/project-map.json',
    repository_id: null,
    project_map: baseMap(),
    local_read_allowed: true,
    shared_publication_allowed: true,
  });
  assert.equal(remoteReads, 0);
});

test('resolves a matching remote pointer and bootstraps only when neither fixed asset exists', async (context) => {
  const root = await projectRoot(context);
  const empty = await resolveGovernanceRoot({ repositoryRoot: root });
  assert.deepEqual(empty.value, {
    status: 'bootstrap_required',
    local_read_allowed: false,
    shared_publication_allowed: false,
  });

  await writeLifecycle(root, 'project-pointer.json', pointer());
  const resolved = await resolveGovernanceRoot({
    repositoryRoot: root,
    resolvePortableLocator: async (locator) => ({
      governance_locator: `${locator}#docs/project-lifecycle/project-map.json`,
      project_map: baseMap(),
    }),
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.value.status, 'resolved');
  assert.equal(resolved.value.source, 'project-pointer');
  assert.equal(resolved.value.repository_id, 'sample-repository');
  assert.equal(resolved.value.shared_publication_allowed, true);
});

test('keeps local work available but refuses publication when the remote root is unavailable', async (context) => {
  const root = await projectRoot(context);
  await writeLifecycle(root, 'project-pointer.json', pointer());

  const result = await resolveGovernanceRoot({
    repositoryRoot: root,
    resolvePortableLocator: async () => null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    status: 'unavailable',
    stop: { code: 'NEEDS_EVIDENCE' },
    repository_id: 'sample-repository',
    local_read_allowed: true,
    shared_publication_allowed: false,
  });
});

test('derives one reviewed stale-pointer rebind through a unique successor', () => {
  const map = { ...baseMap(), identity_lineage: fixture.unique_successor };

  const result = derivePointerRebind({
    pointer: pointer({ project_id: 'sample-app-v1' }),
    governanceMap: map,
    governanceLocator: 'github:example/sample-governance-v2',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    status: 'rebind_required',
    review_required: true,
    local_read_allowed: true,
    shared_publication_allowed: false,
    candidate_pointer: {
      schema_version: 1,
      project_id: 'sample-app',
      repository_id: 'sample-repository',
      governance_locator: 'github:example/sample-governance-v2',
      identity_migration_ref: 'approval:identity-v2',
    },
  });
});

for (const relationship of ['split', 'merge']) {
  test(`stops for the user instead of choosing an ambiguous ${relationship} identity`, () => {
    const result = derivePointerRebind({
      pointer: pointer({ project_id: 'sample-app-v1' }),
      governanceMap: { ...baseMap(), identity_lineage: fixture[relationship] },
      governanceLocator: 'github:example/sample-governance-v2',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      status: 'needs_user',
      stop: { code: 'NEEDS_USER' },
      local_read_allowed: true,
      shared_publication_allowed: false,
    });
  });
}

test('returns the stale-pointer rebind state from root resolution without publishing it', async (context) => {
  const root = await projectRoot(context);
  await writeLifecycle(root, 'project-pointer.json', pointer({ project_id: 'sample-app-v1' }));

  const result = await resolveGovernanceRoot({
    repositoryRoot: root,
    resolvePortableLocator: async () => ({
      governance_locator: 'github:example/sample-governance-v2',
      project_map: { ...baseMap(), identity_lineage: fixture.unique_successor },
    }),
  });

  assert.equal(result.value.status, 'rebind_required');
  assert.equal(result.value.local_read_allowed, true);
  assert.equal(result.value.shared_publication_allowed, false);
  assert.equal(result.value.candidate_pointer.repository_id, 'sample-repository');
});

test('creates sorted reviewed repository registrations while locking stable repository IDs', () => {
  const accepted = registerRepository({
    projectMap: baseMap(),
    registration: fixture.repository,
    approvalRef: 'approval:repository-registration',
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.review_required, true);
  assert.equal(accepted.value.approval_ref, 'approval:repository-registration');
  assert.deepEqual(accepted.value.candidate_map.repositories, [fixture.repository]);
  assert.equal(validateJson('project-map', accepted.value.candidate_map).ok, true);

  const sharedDomain = registerRepository({
    projectMap: {
      ...baseMap(),
      repositories: [{ ...fixture.repository, id: 'existing-repository' }],
      domains: [{
        ...baseMap().domains[0],
        id: 'backend-service',
        label: { en: 'Backend service', 'zh-CN': '后端服务' },
        purpose: { en: 'Owns backend behavior.', 'zh-CN': '负责后端行为。' },
        scope: { includes: ['backend behavior'], excludes: [] },
      }, ...baseMap().domains],
    },
    registration: {
      ...fixture.repository,
      id: 'backend-repository',
      domain_ids: ['backend-service'],
      knowledge_asset_locators: ['knowledge/backend-en.md', 'knowledge/backend.md'],
    },
    approvalRef: 'approval:repository-registration',
  });
  assert.equal(sharedDomain.ok, true);
  assert.deepEqual(
    sharedDomain.value.candidate_map.repositories.map(({ id }) => id),
    ['backend-repository', 'existing-repository'],
  );

  const conflict = registerRepository({
    projectMap: { ...baseMap(), repositories: [fixture.repository] },
    registration: { ...fixture.repository, portable_locator: 'github:example/different-repository' },
    approvalRef: 'approval:repository-registration',
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.errors[0].code, 'REPOSITORY_ID_CONFLICT');

  const assetConflict = registerRepository({
    projectMap: { ...baseMap(), repositories: [fixture.repository] },
    registration: { ...fixture.repository, id: 'duplicate-asset-repository' },
    approvalRef: 'approval:repository-registration',
  });
  assert.equal(assetConflict.ok, false);
  assert.equal(assetConflict.errors[0].code, 'REPOSITORY_ASSET_OWNERSHIP_CONFLICT');
});

test('validates strict non-empty lineage, repository, and migration pointer contracts', () => {
  const map = {
    ...baseMap(),
    identity_lineage: fixture.unique_successor,
    repositories: [fixture.repository],
  };
  const candidate = pointer({ identity_migration_ref: 'approval:identity-v2' });

  assert.equal(validateJson('project-map', map).ok, true);
  assert.equal(validateJson('project-pointer', candidate, { resolvedProjectMap: map }).ok, true);
});
