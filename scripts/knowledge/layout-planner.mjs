import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { ERROR_CODES, createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';

const idPattern = /^[a-z][a-z0-9-]*$/u;
const repositoryKey = (repositoryId) => repositoryId ?? '';
const byRepositoryAndLocator = (left, right) => (
  compareCodePoints(repositoryKey(left.repository_id), repositoryKey(right.repository_id))
  || compareCodePoints(left.locator, right.locator)
);
const byRepositoryId = (left, right) => (
  compareCodePoints(repositoryKey(left.repository_id), repositoryKey(right.repository_id))
);
const byDomainId = (left, right) => compareCodePoints(left.domain_id, right.domain_id);

const ownershipFor = (map) => {
  const owners = new Map();
  const errors = [];
  for (const [repositoryIndex, repository] of (map.repositories ?? []).entries()) {
    for (const [domainIndex, domainId] of (repository.domain_ids ?? []).entries()) {
      if (owners.has(domainId)) {
        errors.push(createError(
          ERROR_CODES.ID_DUPLICATE,
          `/repositories/${repositoryIndex}/domain_ids/${domainIndex}`,
          'Each domain must have exactly one canonical repository.',
        ));
      } else {
        owners.set(domainId, repository.id);
      }
    }
  }
  return { owners, errors };
};

export const canonicalRepositoryId = (map, domainId) => {
  const { owners } = ownershipFor(map);
  return owners.get(domainId) ?? null;
};

const graphFor = (map) => {
  const domainsById = new Map();
  const childrenByParent = new Map();
  const errors = [];
  for (const [index, domain] of (map.domains ?? []).entries()) {
    if (!idPattern.test(domain.id ?? '')) {
      errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `/domains/${index}/id`, 'Domain IDs must be safe path segments.'));
    }
    if (domainsById.has(domain.id)) {
      errors.push(createError(ERROR_CODES.ID_DUPLICATE, `/domains/${index}/id`, `Duplicate domain ID: ${domain.id}`));
    } else {
      domainsById.set(domain.id, domain);
    }
  }
  for (const [index, domain] of (map.domains ?? []).entries()) {
    if (domain.parent_id !== null && !domainsById.has(domain.parent_id)) {
      errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `/domains/${index}/parent_id`, `Unknown parent domain ID: ${domain.parent_id}`));
      continue;
    }
    if (domain.parent_id !== null) {
      const children = childrenByParent.get(domain.parent_id) ?? [];
      children.push(domain.id);
      childrenByParent.set(domain.parent_id, children);
    }
  }
  for (const children of childrenByParent.values()) children.sort(compareCodePoints);

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      errors.push(createError(ERROR_CODES.SCHEMA_INVALID, '/domains', 'Domain parent graph must be acyclic.'));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const parentId = domainsById.get(id)?.parent_id;
    if (parentId !== null && domainsById.has(parentId)) visit(parentId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...domainsById.keys()].sort(compareCodePoints)) visit(id);
  return { childrenByParent, domainsById, errors };
};

const retainedAncestors = (domain, repositoryId, domainsById, owners) => {
  const ancestors = [];
  const seen = new Set([domain.id]);
  let parentId = domain.parent_id;
  while (parentId !== null) {
    if (seen.has(parentId)) return null;
    seen.add(parentId);
    const parent = domainsById.get(parentId);
    if (!parent || (owners.get(parent.id) ?? null) !== repositoryId) break;
    ancestors.push(parent.id);
    parentId = parent.parent_id;
  }
  return ancestors.reverse();
};

const languagePair = (repositoryId, directory, id) => ({
  repository_id: repositoryId,
  en: `${directory}/${id}-en.md`,
  'zh-CN': `${directory}/${id}.md`,
});

const addPath = (paths, errors, entry, kind) => {
  const key = `${repositoryKey(entry.repository_id)}\0${entry.locator}`;
  const existing = paths.get(key);
  if (existing) {
    errors.push(createError(
      ERROR_CODES.ID_DUPLICATE,
      '/domains',
      `Knowledge layout locator collision between ${existing} and ${kind}.`,
    ));
  } else {
    paths.set(key, kind);
  }
};

export const pairForDomain = (manifest, domainId) => (
  manifest.domains.find(({ domain_id: id }) => id === domainId)?.pair ?? null
);

export const planKnowledgeLayout = ({ map }) => {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return fail([createError(ERROR_CODES.SCHEMA_INVALID, '/', 'Project map must be an object.')]);
  }
  const graph = graphFor(map);
  const ownership = ownershipFor(map);
  const errors = [...graph.errors, ...ownership.errors];
  const knownRepositories = new Map((map.repositories ?? []).map((entry) => [entry.id, entry]));
  const knownDomainIds = new Set(graph.domainsById.keys());
  for (const [repositoryIndex, repository] of (map.repositories ?? []).entries()) {
    if (!idPattern.test(repository.id ?? '')) {
      errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `/repositories/${repositoryIndex}/id`, 'Repository IDs must be safe identifiers.'));
    }
    for (const [domainIndex, domainId] of (repository.domain_ids ?? []).entries()) {
      if (!knownDomainIds.has(domainId)) {
        errors.push(createError(
          ERROR_CODES.REFERENCE_MISSING,
          `/repositories/${repositoryIndex}/domain_ids/${domainIndex}`,
          `Unknown repository domain ID: ${domainId}`,
        ));
      }
    }
  }
  if (errors.length > 0) return fail(errors);

  const directories = [];
  const directoryKeys = new Set();
  const indexes = [];
  const bodies = [];
  const domains = [];
  const occupiedPaths = new Map();
  const repositoryIds = [null, ...knownRepositories.keys()]
    .sort((left, right) => compareCodePoints(repositoryKey(left), repositoryKey(right)));
  const addDirectory = (repositoryId, locator, domainId = null) => {
    const key = `${repositoryKey(repositoryId)}\0${locator}`;
    if (directoryKeys.has(key)) return;
    directoryKeys.add(key);
    directories.push({ repository_id: repositoryId, locator, domain_id: domainId });
  };
  const addIndexPair = (repositoryId, directory, scope, domainId = null) => {
    for (const [language, filename] of [['en', 'INDEX-en.md'], ['zh-CN', 'INDEX.md']]) {
      const entry = {
        repository_id: repositoryId,
        locator: `${directory}/${filename}`,
        language,
        scope,
        domain_id: domainId,
      };
      addPath(occupiedPaths, errors, entry, `index:${scope}:${domainId ?? 'root'}:${language}`);
      indexes.push(entry);
    }
  };

  for (const repositoryId of repositoryIds) {
    addDirectory(repositoryId, 'knowledge');
    addIndexPair(repositoryId, 'knowledge', repositoryId === null ? 'governance-root' : 'repository-shard');
  }

  for (const domain of [...graph.domainsById.values()].sort((left, right) => compareCodePoints(left.id, right.id))) {
    const repositoryId = ownership.owners.get(domain.id) ?? null;
    const ancestors = retainedAncestors(domain, repositoryId, graph.domainsById, ownership.owners);
    if (ancestors === null) {
      errors.push(createError(ERROR_CODES.SCHEMA_INVALID, '/domains', 'Domain parent graph must be acyclic.'));
      continue;
    }
    const hasChildren = (graph.childrenByParent.get(domain.id)?.length ?? 0) > 0;
    const ancestorDirectory = ['knowledge', ...ancestors].join('/');
    const directory = hasChildren ? `${ancestorDirectory}/${domain.id}` : ancestorDirectory;
    if (hasChildren) {
      addDirectory(repositoryId, directory, domain.id);
      addIndexPair(repositoryId, directory, 'domain', domain.id);
    }
    const pair = domain.domain_state === 'materialized'
      ? languagePair(repositoryId, directory, domain.id)
      : null;
    if (pair) {
      for (const [language, locator] of [['en', pair.en], ['zh-CN', pair['zh-CN']]]) {
        const entry = { repository_id: repositoryId, domain_id: domain.id, language, locator };
        addPath(occupiedPaths, errors, entry, `body:${domain.id}:${language}`);
        bodies.push(entry);
      }
    }
    const directChildren = (graph.childrenByParent.get(domain.id) ?? []).map((childId) => {
      const childRepositoryId = ownership.owners.get(childId) ?? null;
      return {
        domain_id: childId,
        repository_id: childRepositoryId,
        portable_locator: childRepositoryId === repositoryId
          ? null
          : (childRepositoryId === null
            ? `project:${map.project_id}`
            : (knownRepositories.get(childRepositoryId)?.portable_locator ?? null)),
      };
    });
    domains.push({
      domain_id: domain.id,
      repository_id: repositoryId,
      parent_id: domain.parent_id,
      directory,
      has_children: hasChildren,
      pair,
      direct_children: directChildren,
    });
  }
  if (errors.length > 0) return fail(errors);

  const repositories = repositoryIds.map((repositoryId) => {
    const ownedDomainIds = domains
      .filter(({ repository_id: id }) => id === repositoryId)
      .map(({ domain_id: id }) => id)
      .sort(compareCodePoints);
    const shardEntryIds = domains
      .filter((entry) => {
        if (repositoryId === null) return entry.parent_id === null;
        if (entry.repository_id !== repositoryId) return false;
        if (entry.parent_id === null) return true;
        return (ownership.owners.get(entry.parent_id) ?? null) !== repositoryId;
      })
      .map(({ domain_id: id }) => id)
      .sort(compareCodePoints);
    return {
      repository_id: repositoryId,
      portable_locator: repositoryId === null ? null : knownRepositories.get(repositoryId).portable_locator,
      domain_ids: ownedDomainIds,
      shard_entry_ids: shardEntryIds,
    };
  });

  directories.sort(byRepositoryAndLocator);
  bodies.sort(byRepositoryAndLocator);
  indexes.sort(byRepositoryAndLocator);
  domains.sort(byDomainId);
  repositories.sort(byRepositoryId);
  return ok({ repositories, domains, directories, bodies, indexes, obsolete_paths: [] });
};
