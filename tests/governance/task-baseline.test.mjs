import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGitLocalStorage } from '../../scripts/adapters/git-local.mjs';
import { createVersionedStorage } from '../../scripts/adapters/versioned-storage.mjs';
import { createShardReader } from '../../scripts/governance/shard-reader.mjs';
import { pinTaskBaseline } from '../../scripts/governance/task-baseline.mjs';

const fixture = JSON.parse(await readFile(
  new URL('../fixtures/governance/baselines/cases.json', import.meta.url),
  'utf8',
));
const exec = promisify(execFile);
const git = async (root, args) => (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
const commit = async (root, relativePath, content, message) => {
  await mkdir(dirname(join(root, relativePath)), { recursive: true });
  await writeFile(join(root, relativePath), content);
  await git(root, ['add', '--', relativePath]);
  await git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
};
const repository = async (context, prefix, relativePath, content) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Project Lifecycle Tests']);
  await git(root, ['config', 'user.email', 'tests@example.invalid']);
  const revision = await commit(root, relativePath, content, 'initial');
  return { root, revision, storage: createGitLocalStorage({ repositoryRoot: root }) };
};
const domain = (id) => ({
  id,
  kind: 'domain',
  label: { en: id, 'zh-CN': id },
  purpose: { en: `Owns ${id}.`, 'zh-CN': `负责 ${id}。` },
  domain_state: 'confirmed',
  scope: { includes: [id], excludes: [] },
  parent_id: null,
  relationships: [],
  evidence_refs: ['repo:README.md'],
  known_gaps: [],
});
const registry = (id, domainId, locator, revision) => ({
  id,
  purpose: { en: `Owns ${id}.`, 'zh-CN': `负责 ${id}。` },
  portable_locator: `github:example/${id}`,
  integration_ref: 'refs/heads/main',
  domain_ids: [domainId],
  knowledge_asset_locators: [locator],
  accepted_revision: revision,
});
const setup = async (context) => {
  const frontend = await repository(context, 'baseline-frontend-', `docs/project-lifecycle/${fixture.frontend_asset}`, 'frontend one\n');
  const backend = await repository(context, 'baseline-backend-', `docs/project-lifecycle/${fixture.backend_asset}`, 'backend one\n');
  const map = {
    schema_version: 2,
    project_id: 'sample-app',
    knowledge_baseline: 'baseline:governance-1',
    project_identity: {
      label: { en: 'Sample app', 'zh-CN': '示例应用' },
      purpose: { en: 'Owns the sample project.', 'zh-CN': '负责示例项目。' },
      calibration_ref: 'calibration:accepted',
    },
    identity_lineage: [],
    repositories: [
      registry('backend-repository', fixture.dependency_domain_id, fixture.backend_asset, backend.revision),
      registry('frontend-repository', fixture.local_domain_id, fixture.frontend_asset, frontend.revision),
    ],
    constraints: [],
    domains: [domain(fixture.dependency_domain_id), domain(fixture.local_domain_id)],
  };
  const mapSource = `${JSON.stringify(map, null, 2)}\n`;
  const governance = await repository(
    context,
    'baseline-governance-',
    'docs/project-lifecycle/project-map.json',
    mapSource,
  );
  return { backend, frontend, governance, map, mapSource };
};
const storages = ({ backend, frontend }) => new Map([
  ['backend-repository', backend.storage],
  ['frontend-repository', frontend.storage],
]);

test('pins one immutable governance revision, map hash, and exact shard revisions', async (context) => {
  const state = await setup(context);
  let acceptedRefResolutions = 0;
  const methods = Object.fromEntries(Object.entries(state.governance.storage).map(([name, method]) => [
    name,
    async (...args) => {
      if (name === 'resolveRevision' && args[0] === 'refs/heads/main') acceptedRefResolutions += 1;
      return method(...args);
    },
  ]));
  const governanceStorage = createVersionedStorage(methods);

  const pinned = await pinTaskBaseline({
    governanceStorage,
    acceptedGovernanceRef: 'refs/heads/main',
    localRepositoryId: fixture.local_repository_id,
    groundedDependencyIds: [fixture.dependency_domain_id],
    shardStorages: storages(state),
  });

  assert.equal(pinned.ok, true);
  assert.equal(acceptedRefResolutions, 1);
  assert.deepEqual(pinned.value.knowledge_baseline, {
    projectId: 'sample-app',
    governanceRevision: state.governance.revision,
    projectMapHash: `sha256:${createHash('sha256').update(state.mapSource).digest('hex')}`,
    shardRevisions: [
      { repositoryId: 'backend-repository', revision: state.backend.revision },
      { repositoryId: 'frontend-repository', revision: state.frontend.revision },
    ],
    completeness: 'COMPLETE',
  });
  assert.equal(Object.isFrozen(pinned.value.knowledge_baseline), true);
  assert.equal(Object.isFrozen(pinned.value.knowledge_baseline.shardRevisions), true);
  assert.equal(Object.isFrozen(pinned.value.knowledge_baseline.shardRevisions[0]), true);

  await commit(state.governance.root, 'docs/project-lifecycle/project-map.json', `${state.mapSource}\n`, 'advance governance');
  await commit(state.frontend.root, `docs/project-lifecycle/${fixture.frontend_asset}`, 'frontend two\n', 'advance frontend');
  await commit(state.backend.root, `docs/project-lifecycle/${fixture.backend_asset}`, 'backend two\n', 'advance backend');
  const reader = createShardReader({
    knowledgeBaseline: pinned.value.knowledge_baseline,
    projectMap: pinned.value.project_map,
    shardStorages: storages(state),
  });
  assert.equal((await reader.read('frontend-repository', fixture.frontend_asset)).value.content, 'frontend one\n');
  assert.equal((await reader.read('backend-repository', fixture.backend_asset)).value.content, 'backend one\n');
});

test('loads another shard only for a grounded dependency and rejects revision mixing', async (context) => {
  const state = await setup(context);
  const local = await pinTaskBaseline({
    governanceStorage: state.governance.storage,
    acceptedGovernanceRef: 'refs/heads/main',
    localRepositoryId: fixture.local_repository_id,
    groundedDependencyIds: [],
    shardStorages: storages(state),
  });
  assert.deepEqual(local.value.knowledge_baseline.shardRevisions, [
    { repositoryId: 'frontend-repository', revision: state.frontend.revision },
  ]);
  const reader = createShardReader({
    knowledgeBaseline: local.value.knowledge_baseline,
    projectMap: local.value.project_map,
    shardStorages: storages(state),
  });
  assert.equal((await reader.read('backend-repository', fixture.backend_asset)).errors[0].code, 'SHARD_NOT_PINNED');
  assert.equal((await reader.read(
    'frontend-repository',
    fixture.frontend_asset,
    'refs/heads/main',
  )).errors[0].code, 'TASK_BASELINE_MIXED_REVISION');

  const related = await pinTaskBaseline({
    governanceStorage: state.governance.storage,
    acceptedGovernanceRef: 'refs/heads/main',
    localRepositoryId: fixture.local_repository_id,
    groundedDependencyIds: [fixture.dependency_domain_id],
    shardStorages: storages(state),
  });
  assert.deepEqual(related.value.knowledge_baseline.shardRevisions.map(({ repositoryId }) => repositoryId), [
    'backend-repository', 'frontend-repository',
  ]);
});

test('permits explicit local-only work but stops common or cross-repository decisions', async (context) => {
  const local = await repository(context, 'baseline-local-', `docs/project-lifecycle/${fixture.frontend_asset}`, 'local accepted\n');
  const fallback = {
    projectId: 'sample-app',
    repositoryId: fixture.local_repository_id,
    acceptedRevision: local.revision,
    knowledgeAssetLocators: [fixture.frontend_asset],
    storage: local.storage,
  };
  const bounded = await pinTaskBaseline({ localFallback: fallback });
  assert.deepEqual(bounded.value.knowledge_baseline, {
    projectId: 'sample-app',
    governanceRevision: null,
    projectMapHash: null,
    shardRevisions: [{ repositoryId: fixture.local_repository_id, revision: local.revision }],
    completeness: 'LOCAL_ONLY',
  });
  assert.equal(bounded.value.stop, null);

  for (const requirements of [
    { commonFactsRequired: true },
    { crossRepositoryContractsRequired: true },
  ]) {
    const stopped = await pinTaskBaseline({ localFallback: fallback, ...requirements });
    assert.deepEqual(stopped.value.stop, { code: 'NEEDS_EVIDENCE' });
    assert.equal(stopped.value.knowledge_baseline.completeness, 'LOCAL_ONLY');
  }
});
