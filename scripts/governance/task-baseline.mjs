import { createHash } from 'node:crypto';

import { assertVersionedStorage } from '../adapters/versioned-storage.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeLocator, isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const MAP_PATH = 'docs/project-lifecycle/project-map.json';
const failure = (code, path, message) => fail([createError(code, path, message)]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const baseline = ({ projectId, governanceRevision, projectMapHash, shards, completeness }) => deepFreeze({
  projectId,
  governanceRevision,
  projectMapHash,
  shardRevisions: shards
    .map(({ repositoryId, revision }) => ({ repositoryId, revision }))
    .sort((left, right) => compareCodePoints(left.repositoryId, right.repositoryId)),
  completeness,
});
const needsEvidence = (value) => ok({
  status: 'needs_evidence',
  knowledge_baseline: value,
  project_map: null,
  stop: { code: 'NEEDS_EVIDENCE' },
});
const storageFrom = (storages, id) => storages instanceof Map ? storages.get(id) : storages?.[id];

const pinLocalOnly = async ({ localFallback, commonFactsRequired, crossRepositoryContractsRequired }) => {
  if (!localFallback || !isSafeReference(localFallback.projectId)
    || !isSafeReference(localFallback.repositoryId)
    || !isSafeReference(localFallback.acceptedRevision)
    || !Array.isArray(localFallback.knowledgeAssetLocators)
    || localFallback.knowledgeAssetLocators.some((locator) => !isSafeLocator(locator))
    || !assertVersionedStorage(localFallback.storage).ok) {
    return failure('LOCAL_SHARD_INVALID', '/localFallback', 'Local-only work requires one explicit accepted shard.');
  }
  const resolved = await localFallback.storage.resolveRevision(localFallback.acceptedRevision);
  if (!resolved.ok || resolved.value !== localFallback.acceptedRevision) {
    return failure('LOCAL_SHARD_UNAVAILABLE', '/localFallback/acceptedRevision', 'Local shard revision must be one exact immutable revision.');
  }
  const pinned = baseline({
    projectId: localFallback.projectId,
    governanceRevision: null,
    projectMapHash: null,
    shards: [{ repositoryId: localFallback.repositoryId, revision: resolved.value }],
    completeness: 'LOCAL_ONLY',
  });
  if (commonFactsRequired || crossRepositoryContractsRequired) return needsEvidence(pinned);
  return ok({
    status: 'local_only',
    knowledge_baseline: pinned,
    project_map: null,
    local_shard: deepFreeze({
      repositoryId: localFallback.repositoryId,
      knowledgeAssetLocators: [...localFallback.knowledgeAssetLocators].sort(compareCodePoints),
    }),
    stop: null,
  });
};

export async function pinTaskBaseline({
  governanceStorage,
  acceptedGovernanceRef,
  localRepositoryId,
  groundedDependencyIds = [],
  shardStorages,
  localFallback,
  commonFactsRequired = false,
  crossRepositoryContractsRequired = false,
} = {}) {
  if (!governanceStorage) {
    return pinLocalOnly({ localFallback, commonFactsRequired, crossRepositoryContractsRequired });
  }
  if (!assertVersionedStorage(governanceStorage).ok
    || !isSafeReference(acceptedGovernanceRef)
    || !isSafeReference(localRepositoryId)
    || !Array.isArray(groundedDependencyIds)
    || new Set(groundedDependencyIds).size !== groundedDependencyIds.length
    || groundedDependencyIds.some((id) => !/^[a-z][a-z0-9-]*$/u.test(id))) {
    return failure('TASK_BASELINE_INPUT_INVALID', '/arguments', 'Task baseline inputs must be explicit portable references.');
  }

  const governance = await governanceStorage.resolveRevision(acceptedGovernanceRef);
  if (!governance.ok) return failure('GOVERNANCE_REVISION_UNAVAILABLE', '/acceptedGovernanceRef', 'Accepted governance revision could not be pinned.');
  const mapRead = await governanceStorage.readAtRevision(governance.value, MAP_PATH);
  if (!mapRead.ok) return failure('GOVERNANCE_MAP_UNAVAILABLE', '/project-map', 'Pinned governance map could not be read.');
  let map;
  try { map = JSON.parse(mapRead.value.content); } catch {
    return failure('GOVERNANCE_MAP_INVALID', '/project-map', 'Pinned governance map is not valid JSON.');
  }
  const validation = validateJson('project-map', map);
  if (!validation.ok) return failure('GOVERNANCE_MAP_INVALID', '/project-map', 'Pinned governance map does not satisfy the accepted contract.');

  const local = map.repositories.find(({ id }) => id === localRepositoryId);
  if (!local) return failure('LOCAL_REPOSITORY_UNREGISTERED', '/localRepositoryId', 'Local repository must be registered by the pinned governance map.');
  const selected = new Map([[local.id, local]]);
  for (const dependencyId of groundedDependencyIds) {
    const owners = map.repositories.filter(({ domain_ids: ids }) => ids.includes(dependencyId));
    if (owners.length === 0) {
      const incomplete = baseline({
        projectId: map.project_id,
        governanceRevision: governance.value,
        projectMapHash: `sha256:${createHash('sha256').update(mapRead.value.content).digest('hex')}`,
        shards: [],
        completeness: 'LOCAL_ONLY',
      });
      return needsEvidence(incomplete);
    }
    for (const owner of owners) selected.set(owner.id, owner);
  }
  if (crossRepositoryContractsRequired && groundedDependencyIds.length === 0) {
    const incomplete = baseline({
      projectId: map.project_id,
      governanceRevision: governance.value,
      projectMapHash: `sha256:${createHash('sha256').update(mapRead.value.content).digest('hex')}`,
      shards: [],
      completeness: 'LOCAL_ONLY',
    });
    return needsEvidence(incomplete);
  }

  const shards = [];
  for (const repository of [...selected.values()].sort((left, right) => compareCodePoints(left.id, right.id))) {
    const storage = storageFrom(shardStorages, repository.id);
    if (!assertVersionedStorage(storage).ok) {
      const incomplete = baseline({
        projectId: map.project_id,
        governanceRevision: governance.value,
        projectMapHash: `sha256:${createHash('sha256').update(mapRead.value.content).digest('hex')}`,
        shards,
        completeness: 'LOCAL_ONLY',
      });
      return needsEvidence(incomplete);
    }
    const resolved = await storage.resolveRevision(repository.accepted_revision);
    if (!resolved.ok || resolved.value !== repository.accepted_revision) {
      const incomplete = baseline({
        projectId: map.project_id,
        governanceRevision: governance.value,
        projectMapHash: `sha256:${createHash('sha256').update(mapRead.value.content).digest('hex')}`,
        shards,
        completeness: 'LOCAL_ONLY',
      });
      return needsEvidence(incomplete);
    }
    shards.push({ repositoryId: repository.id, revision: resolved.value });
  }

  return ok({
    status: 'pinned',
    knowledge_baseline: baseline({
      projectId: map.project_id,
      governanceRevision: governance.value,
      projectMapHash: `sha256:${createHash('sha256').update(mapRead.value.content).digest('hex')}`,
      shards,
      completeness: 'COMPLETE',
    }),
    project_map: deepFreeze(clone(map)),
    stop: null,
  });
}
