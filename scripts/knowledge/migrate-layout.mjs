import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import { validateBilingualPair } from '../lib/bilingual-pair.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { generateIndexesFromRoot } from './generate-indexes.mjs';
import { pairForDomain, planKnowledgeLayout } from './layout-planner.mjs';
import {
  applyLayoutTransaction,
  finalizeRetainedLayout,
  inspectLifecycleTree,
  rollbackRetainedLayout,
} from './layout-transaction.mjs';

const LANGUAGES = ['en', 'zh-CN'];
const failure = (code, path, message) => fail([createError(code, path, message)]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const jsonContent = (value) => `${JSON.stringify(value, null, 2)}\n`;
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const inside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};

const rootsFor = async (root) => {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('absolute root required');
  const lexicalRoot = resolve(root);
  const rootState = await lstat(lexicalRoot);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw new Error('bounded root required');
  const projectRoot = await realpath(lexicalRoot);
  const docsLexical = join(projectRoot, 'docs');
  const docsState = await lstat(docsLexical);
  const docsRoot = await realpath(docsLexical);
  const lifecycleLexical = join(docsRoot, 'project-lifecycle');
  const state = await lstat(lifecycleLexical);
  const lifecycleRoot = await realpath(lifecycleLexical);
  if (!docsState.isDirectory() || docsState.isSymbolicLink() || !inside(projectRoot, docsRoot)
    || !state.isDirectory() || state.isSymbolicLink() || !inside(projectRoot, lifecycleRoot)) throw new Error('bounded root required');
  return { projectRoot, lifecycleRoot };
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const repositoryOwner = (map, domainId) => (
  map.repositories.find(({ domain_ids: ids }) => ids.includes(domainId))?.id ?? null
);
const oldPairFor = (domain) => ({
  en: `knowledge/${domain.id}-en.md`,
  'zh-CN': `knowledge/${domain.id}.md`,
});

const canonicalV2Map = (legacy) => {
  const map = clone(legacy);
  map.schema_version = 2;
  for (const domain of map.domains) {
    if (domain.domain_state === 'materialized') {
      domain.paired_assets = {
        repository_id: repositoryOwner(map, domain.id),
        ...oldPairFor(domain),
      };
    } else delete domain.paired_assets;
  }
  const provisional = planKnowledgeLayout({ map });
  if (!provisional.ok) return provisional;
  for (const domain of map.domains) {
    if (domain.domain_state === 'materialized') domain.paired_assets = pairForDomain(provisional.value, domain.id);
  }
  for (const constraint of map.constraints) {
    if (!constraint.knowledge_refs || !constraint.owner_id) continue;
    const pair = pairForDomain(provisional.value, constraint.owner_id);
    if (!pair) continue;
    constraint.knowledge_refs = {
      en: `${pair.en}#constraint-${constraint.id}`,
      'zh-CN': `${pair['zh-CN']}#constraint-${constraint.id}`,
    };
  }
  for (const repository of map.repositories) {
    repository.knowledge_asset_locators = map.domains
      .filter((domain) => domain.domain_state === 'materialized'
        && domain.paired_assets.repository_id === repository.id)
      .flatMap((domain) => [domain.paired_assets.en, domain.paired_assets['zh-CN']])
      .sort(compareCodePoints);
  }
  const validation = validateJson('project-map', map);
  return validation.ok ? ok({ map, layout: provisional.value }) : validation;
};

const externalLinks = (source, locator) => [...source.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu)]
  .map((match) => match[1])
  .filter((href) => /^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('//'))
  .map((href) => ({ locator, href }));

const relativeLocator = (from, to) => {
  const path = posix.relative(posix.dirname(from), to);
  return path.startsWith('.') ? path : `./${path}`;
};

const portableRepositoryLocator = (map, repositoryId) => repositoryId === null
  ? `project:${map.project_id}`
  : map.repositories.find(({ id }) => id === repositoryId)?.portable_locator;

const rewriteLocalLinks = (source, {
  map, oldLocator, newLocator, oldRepositoryId, newRepositoryId, moves,
}) => source.replace(
  /(\[[^\]]*\]\()([^)\s]+)((?:\s+[^)]*)?\))/gu,
  (whole, prefix, href, suffix) => {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('//') || href.startsWith('/') || href.startsWith('#')) return whole;
    const [path, fragment] = href.split('#');
    const normalized = posix.normalize(posix.join(posix.dirname(oldLocator), path));
    const target = moves.get(normalized) ?? { repository_id: oldRepositoryId, locator: normalized };
    const rewritten = target.repository_id === newRepositoryId
      ? relativeLocator(newLocator, target.locator)
      : `${portableRepositoryLocator(map, target.repository_id)}/docs/project-lifecycle/${target.locator}`;
    return `${prefix}${rewritten}${fragment ? `#${fragment}` : ''}${suffix}`;
  },
);

const inspectV1 = async ({ rootsByRepository, map, fingerprint, repositoryFingerprints }) => {
  const governanceRoots = rootsByRepository.get(null);
  if (map.schema_version !== 1 || !Array.isArray(map.domains)
    || !Array.isArray(map.repositories) || !Array.isArray(map.constraints)) {
    return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/project-map.json', 'A strict object-shaped schema v1 map is required.');
  }
  const transformed = canonicalV2Map(map);
  if (!transformed.ok) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Legacy topology cannot become a valid canonical v2 map.');
  const flatValidationMap = clone(map);
  flatValidationMap.schema_version = 2;
  for (const domain of flatValidationMap.domains) {
    if (domain.domain_state === 'materialized') {
      domain.paired_assets = {
        repository_id: repositoryOwner(flatValidationMap, domain.id),
        ...oldPairFor(domain),
      };
    }
  }
  for (const repository of flatValidationMap.repositories) {
    repository.knowledge_asset_locators = flatValidationMap.domains
      .filter((domain) => domain.domain_state === 'materialized'
        && domain.paired_assets.repository_id === repository.id)
      .flatMap((domain) => [domain.paired_assets.en, domain.paired_assets['zh-CN']])
      .sort(compareCodePoints);
  }
  const flatValidation = validateJson('project-map', flatValidationMap);
  if (!flatValidation.ok) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Legacy machine fields cannot satisfy the v2 contract.');
  const moves = new Map();
  const movedPairs = [];
  const bodies = [];
  const risks = [];
  for (const domain of map.domains.filter(({ domain_state: state }) => state === 'materialized')) {
    const expected = oldPairFor(domain);
    if (JSON.stringify(domain.paired_assets) !== JSON.stringify(expected)) {
      return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', `/domains/${domain.id}/paired_assets`, 'Legacy materialized pairs must use exact flat canonical locators.');
    }
    const pair = await validateBilingualPair(
      join(rootsByRepository.get(repositoryOwner(map, domain.id)).lifecycleRoot, expected.en),
      join(rootsByRepository.get(repositoryOwner(map, domain.id)).lifecycleRoot, expected['zh-CN']),
      flatValidationMap,
    );
    if (!pair.ok) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', `/domains/${domain.id}`, `Legacy bilingual pair validation failed: ${pair.errors[0]?.code ?? 'unknown'}.`);
    const target = pairForDomain(transformed.value.layout, domain.id);
    const repositoryRoots = rootsByRepository.get(repositoryOwner(map, domain.id));
    for (const language of LANGUAGES) {
      if (expected[language] === target[language]) continue;
      try {
        await lstat(join(repositoryRoots.lifecycleRoot, target[language]));
        return failure(
          'KNOWLEDGE_LAYOUT_MIGRATION_INVALID',
          `/domains/${domain.id}/paired_assets/${language}`,
          'A planned recursive target is already occupied by unapproved content.',
        );
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (expected.en !== target.en || expected['zh-CN'] !== target['zh-CN']) {
      movedPairs.push({ domain_id: domain.id, from: expected, to: target });
    }
    for (const language of LANGUAGES) moves.set(expected[language], {
      repository_id: target.repository_id,
      locator: target[language],
    });
  }
  for (const domain of map.domains.filter(({ domain_state: state }) => state === 'materialized')) {
    const repositoryId = repositoryOwner(map, domain.id);
    const lifecycleRoot = rootsByRepository.get(repositoryId).lifecycleRoot;
    const sourcePair = oldPairFor(domain);
    const targetPair = pairForDomain(transformed.value.layout, domain.id);
    for (const language of LANGUAGES) {
      const source = await readFile(join(lifecycleRoot, sourcePair[language]), 'utf8');
      risks.push(...externalLinks(source, sourcePair[language]));
      bodies.push({
        repository_id: targetPair.repository_id,
        domain_id: domain.id,
        language,
        from: sourcePair[language],
        locator: targetPair[language],
        content: rewriteLocalLinks(source, {
          map: transformed.value.map,
          oldLocator: sourcePair[language],
          newLocator: targetPair[language],
          oldRepositoryId: repositoryId,
          newRepositoryId: targetPair.repository_id,
          moves,
        }),
      });
    }
  }
  const indexes = [];
  for (const [repositoryId, roots] of rootsByRepository) {
    const overlays = Object.fromEntries(bodies
      .filter(({ repository_id: id }) => id === repositoryId)
      .map(({ locator, content }) => [locator, content]));
    const generated = await generateIndexesFromRoot({
      map: transformed.value.map,
      lifecycleRoot: roots.lifecycleRoot,
      overlays,
      repository_id: repositoryId,
    });
    if (!generated.ok) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Canonical v2 indexes cannot be generated from the legacy tree.');
    indexes.push(...generated.value.files);
  }
  return ok({
    status: 'migration-required',
    project_root: governanceRoots.projectRoot,
    lifecycle_root: governanceRoots.lifecycleRoot,
    project_roots: Object.fromEntries([...rootsByRepository].map(([id, roots]) => [id ?? '<governance>', roots.projectRoot])),
    lifecycle_roots: Object.fromEntries([...rootsByRepository].map(([id, roots]) => [id ?? '<governance>', roots.lifecycleRoot])),
    repository_fingerprints: repositoryFingerprints,
    fingerprint,
    map: transformed.value.map,
    layout: transformed.value.layout,
    bodies,
    indexes,
    moved_pairs: movedPairs.sort((left, right) => compareCodePoints(left.domain_id, right.domain_id)),
    changed_references: transformed.value.map.constraints
      .filter(({ knowledge_refs: refs }) => Boolean(refs))
      .map(({ id }) => `constraint:${id}`)
      .sort(compareCodePoints),
    external_link_risks: risks.sort((left, right) => compareCodePoints(`${left.locator}\0${left.href}`, `${right.locator}\0${right.href}`)),
  });
};

export const inspectLegacyKnowledgeLayout = async ({ root, repository_roots: repositoryRoots = {} } = {}) => {
  try {
    const governanceRoots = await rootsFor(root);
    const map = await readJson(join(governanceRoots.lifecycleRoot, 'project-map.json'));
    const rootsByRepository = new Map([[null, governanceRoots]]);
    const requiredRepositoryIds = [...new Set(map.domains
      .map((domain) => repositoryOwner(map, domain.id))
      .filter((id) => id !== null))].sort(compareCodePoints);
    for (const repositoryId of requiredRepositoryIds) {
      if (!isNonEmptyString(repositoryRoots[repositoryId])) {
        return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', `/repository_roots/${repositoryId}`, 'Every owning repository shard requires an explicit local root.');
      }
      rootsByRepository.set(repositoryId, await rootsFor(repositoryRoots[repositoryId]));
    }
    const repositoryFingerprints = {};
    for (const [repositoryId, roots] of rootsByRepository) {
      const snapshot = await inspectLifecycleTree({ repositoryRoot: roots.projectRoot });
      if (!snapshot.ok) return snapshot;
      repositoryFingerprints[repositoryId ?? '<governance>'] = snapshot.value.fingerprint;
    }
    const fingerprint = hash(JSON.stringify(Object.entries(repositoryFingerprints).sort(([left], [right]) => compareCodePoints(left, right))));
    if (map.schema_version === 2) {
      const validation = validateJson('project-map', map);
      return validation.ok
        ? ok({ status: 'already-v2', fingerprint, changed: [] })
        : validation;
    }
    return inspectV1({ rootsByRepository, map, fingerprint, repositoryFingerprints });
  } catch {
    return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Legacy lifecycle root could not be inspected safely.');
  }
};

const validateCandidate = async ({ lifecycleRoot, inspection, repositoryId }) => {
  try {
    const map = inspection.map;
    if (repositoryId === null) {
      const publishedMap = await readJson(join(lifecycleRoot, 'project-map.json'));
      const validation = validateJson('project-map', publishedMap);
      if (!validation.ok || JSON.stringify(publishedMap) !== JSON.stringify(map)) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Published v2 map differs from the inspected candidate.');
    }
    for (const body of inspection.bodies) {
      if (body.repository_id !== repositoryId) continue;
      if (await readFile(join(lifecycleRoot, body.locator), 'utf8') !== body.content) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Published v2 body differs from the inspected candidate.');
    }
    for (const file of inspection.indexes.filter(({ repository_id: id }) => id === repositoryId)) {
      if (await readFile(join(lifecycleRoot, file.locator), 'utf8') !== file.content) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Published v2 indexes are incomplete.');
    }
    for (const pair of inspection.moved_pairs.filter(({ to }) => to.repository_id === repositoryId)) {
      for (const language of LANGUAGES) {
        try {
          await lstat(join(lifecycleRoot, pair.from[language]));
          return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Legacy canonical bodies remain after migration.');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
    for (const domain of map.domains.filter(({ domain_state: state, paired_assets: pair }) => (
      state === 'materialized' && pair.repository_id === repositoryId
    ))) {
      const validPair = await validateBilingualPair(
        join(lifecycleRoot, domain.paired_assets.en),
        join(lifecycleRoot, domain.paired_assets['zh-CN']),
        map,
      );
      if (!validPair.ok) return validPair;
    }
    return ok(null);
  } catch {
    return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Published v2 candidate validation failed.');
  }
};

export const migrateKnowledgeLayout = async (input = {}, operations = {}) => {
  const inspection = await inspectLegacyKnowledgeLayout({ root: input.root, repository_roots: input.repository_roots });
  if (!inspection.ok) return inspection;
  if (inspection.value.status === 'already-v2') return inspection;
  if (!isNonEmptyString(input.approval_ref)) {
    return failure('KNOWLEDGE_LAYOUT_MIGRATION_APPROVAL_REQUIRED', '/approval_ref', 'Explicit migration approval is required before any durable write.');
  }
  if (!isNonEmptyString(input.expected_fingerprint)
    || input.expected_fingerprint !== inspection.value.fingerprint) {
    return failure('LAYOUT_FINGERPRINT_STALE', '/expected_fingerprint', 'Legacy lifecycle tree changed after inspection.');
  }
  const repositoryIds = Object.keys(inspection.value.project_roots)
    .map((id) => id === '<governance>' ? null : id)
    .sort((left, right) => left === null ? 1 : right === null ? -1 : compareCodePoints(left, right));
  const retained = [];
  const changed = [];
  let cleanupPending = false;
  const recoveryArtifacts = [];
  for (const repositoryId of repositoryIds) {
    const repositoryKey = repositoryId ?? '<governance>';
    const bodies = inspection.value.bodies.filter(({ repository_id: id }) => id === repositoryId);
    const indexFiles = inspection.value.indexes.filter(({ repository_id: id }) => id === repositoryId);
    const repositoryOperations = {
      ...operations,
      retainBackup: repositoryId !== null,
      afterPublish: async (details) => {
        await operations.afterPublish?.({ ...details, repository_id: repositoryId });
        await operations.afterRepositoryPublish?.({ ...details, repository_id: repositoryId });
      },
    };
    const transaction = await applyLayoutTransaction({
      repositoryRoot: inspection.value.project_roots[repositoryKey],
      expectedFingerprint: inspection.value.repository_fingerprints[repositoryKey],
      candidateDirectories: inspection.value.layout.directories
        .filter(({ repository_id: id }) => id === repositoryId)
        .map(({ locator }) => locator),
      candidateFiles: [
        ...bodies.map((body) => ({
          repository_id: repositoryId, locator: body.locator, content: body.content,
          validate: async (source) => source === body.content ? ok(source) : failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Staged body changed.'),
        })),
        ...indexFiles.map((file) => ({
          repository_id: repositoryId, locator: file.locator, content: file.content,
          validate: async (source) => source === file.content ? ok(source) : failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Staged index changed.'),
        })),
        ...(repositoryId === null ? [{
          repository_id: null, locator: 'project-map.json', content: jsonContent(inspection.value.map),
          validate: async (source) => {
            try { return validateJson('project-map', JSON.parse(source)); } catch { return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Staged map is invalid.'); }
          },
        }] : []),
      ],
      deleteLocators: inspection.value.moved_pairs
        .filter(({ to }) => to.repository_id === repositoryId)
        .flatMap(({ from }) => LANGUAGES.map((language) => from[language])),
      validateCandidate: ({ lifecycleRoot }) => validateCandidate({ lifecycleRoot, inspection: inspection.value, repositoryId }),
    }, repositoryOperations);
    if (!transaction.ok) {
      for (const published of retained.reverse()) {
        const restored = await rollbackRetainedLayout(published, operations);
        if (!restored.ok) return restored;
      }
      return transaction;
    }
    changed.push(...transaction.value.changed.map((locator) => ({ repository_id: repositoryId, locator })));
    if (transaction.value.retained_publication) retained.push(transaction.value);
    cleanupPending ||= transaction.value.cleanup_pending && !transaction.value.retained_publication;
    if (!transaction.value.retained_publication) {
      recoveryArtifacts.push(...transaction.value.recovery_artifacts);
    }
  }
  for (const published of retained) {
    const finalized = await finalizeRetainedLayout(published, operations);
    if (!finalized.ok) {
      cleanupPending = true;
      recoveryArtifacts.push('backup');
    }
  }
  return ok({
    status: 'migrated',
    from_schema: 1,
    to_schema: 2,
    approval_ref: input.approval_ref,
    moved_pairs: inspection.value.moved_pairs,
    changed_references: inspection.value.changed_references,
    external_link_risks: inspection.value.external_link_risks,
    verification: { schema: true, bilingual_pairs: true, hierarchical_indexes: true },
    changed,
    cleanup_state: cleanupPending ? 'pending' : 'complete',
    ...(recoveryArtifacts.length > 0
      ? { recovery_artifacts: [...new Set(recoveryArtifacts)] }
      : {}),
  });
};
