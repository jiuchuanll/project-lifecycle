import { assertVersionedStorage } from '../adapters/versioned-storage.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeLocator } from '../lib/reference-safety.mjs';
import { fail } from '../lib/result.mjs';

const failure = (code, path, message) => fail([createError(code, path, message)]);
const storageFrom = (storages, id) => storages instanceof Map ? storages.get(id) : storages?.[id];

export function createShardReader({ knowledgeBaseline, projectMap, shardStorages, localShard } = {}) {
  const pins = new Map((knowledgeBaseline?.shardRevisions ?? []).map((entry) => [entry.repositoryId, entry.revision]));
  const allowed = new Map((projectMap?.repositories ?? []).map((repository) => [
    repository.id,
    new Set(repository.knowledge_asset_locators),
  ]));
  if (localShard) allowed.set(localShard.repositoryId, new Set(localShard.knowledgeAssetLocators));

  return Object.freeze({
    read: async (repositoryId, relativePath, requestedRevision) => {
      const revision = pins.get(repositoryId);
      if (!revision) return failure('SHARD_NOT_PINNED', '/repositoryId', 'Repository shard is not part of this task baseline.');
      if (requestedRevision !== undefined && requestedRevision !== revision) {
        return failure('TASK_BASELINE_MIXED_REVISION', '/requestedRevision', 'A task cannot mix another shard revision into its immutable baseline.');
      }
      if (!isSafeLocator(relativePath) || !allowed.get(repositoryId)?.has(relativePath)) {
        return failure('SHARD_PATH_UNBOUNDED', '/relativePath', 'Shard reads are limited to registered knowledge asset locators.');
      }
      const storage = storageFrom(shardStorages, repositoryId);
      if (!assertVersionedStorage(storage).ok) {
        return failure('SHARD_STORAGE_UNAVAILABLE', '/repositoryId', 'Pinned shard storage is unavailable.');
      }
      return storage.readAtRevision(revision, `docs/project-lifecycle/${relativePath}`);
    },
  });
}
