import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import { validateBilingualPair } from '../lib/bilingual-pair.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { generateIndexesFromRoot } from './generate-indexes.mjs';
import { pairForDomain, planKnowledgeLayout } from './layout-planner.mjs';
import { applyLayoutTransaction, inspectLifecycleTree } from './layout-transaction.mjs';

const LANGUAGES = ['en', 'zh-CN'];
const failure = (code, path, message) => fail([createError(code, path, message)]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const jsonContent = (value) => `${JSON.stringify(value, null, 2)}\n`;
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const inside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};

const rootsFor = async (root) => {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('absolute root required');
  const projectRoot = await realpath(resolve(root));
  const lifecycleRoot = await realpath(join(projectRoot, 'docs/project-lifecycle'));
  const state = await lstat(lifecycleRoot);
  if (!state.isDirectory() || state.isSymbolicLink() || !inside(projectRoot, lifecycleRoot)) throw new Error('bounded root required');
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

const rewriteLocalLinks = (source, oldLocator, newLocator, moves) => source.replace(
  /(\[[^\]]*\]\()([^)\s]+)((?:\s+[^)]*)?\))/gu,
  (whole, prefix, href, suffix) => {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('//') || href.startsWith('#')) return whole;
    const [path, fragment] = href.split('#');
    const normalized = posix.normalize(posix.join(posix.dirname(oldLocator), path));
    const target = moves.get(normalized);
    if (!target) return whole;
    return `${prefix}${relativeLocator(newLocator, target)}${fragment ? `#${fragment}` : ''}${suffix}`;
  },
);

const inspectV1 = async ({ projectRoot, lifecycleRoot, map, fingerprint }) => {
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
      join(lifecycleRoot, expected.en),
      join(lifecycleRoot, expected['zh-CN']),
      flatValidationMap,
    );
    if (!pair.ok) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', `/domains/${domain.id}`, `Legacy bilingual pair validation failed: ${pair.errors[0]?.code ?? 'unknown'}.`);
    const target = pairForDomain(transformed.value.layout, domain.id);
    if (expected.en !== target.en || expected['zh-CN'] !== target['zh-CN']) {
      movedPairs.push({ domain_id: domain.id, from: expected, to: target });
    }
    for (const language of LANGUAGES) moves.set(expected[language], target[language]);
  }
  for (const domain of map.domains.filter(({ domain_state: state }) => state === 'materialized')) {
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
        content: rewriteLocalLinks(source, sourcePair[language], targetPair[language], moves),
      });
    }
  }
  const overlays = Object.fromEntries(bodies.map(({ locator, content }) => [locator, content]));
  const generated = await generateIndexesFromRoot({
    map: transformed.value.map,
    lifecycleRoot,
    overlays,
  });
  if (!generated.ok) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Canonical v2 indexes cannot be generated from the legacy tree.');
  return ok({
    status: 'migration-required',
    project_root: projectRoot,
    lifecycle_root: lifecycleRoot,
    fingerprint,
    map: transformed.value.map,
    layout: transformed.value.layout,
    bodies,
    indexes: generated.value.files,
    moved_pairs: movedPairs.sort((left, right) => compareCodePoints(left.domain_id, right.domain_id)),
    changed_references: transformed.value.map.constraints
      .filter(({ knowledge_refs: refs }) => Boolean(refs))
      .map(({ id }) => `constraint:${id}`)
      .sort(compareCodePoints),
    external_link_risks: risks.sort((left, right) => compareCodePoints(`${left.locator}\0${left.href}`, `${right.locator}\0${right.href}`)),
  });
};

export const inspectLegacyKnowledgeLayout = async ({ root } = {}) => {
  try {
    const roots = await rootsFor(root);
    const [map, snapshot] = await Promise.all([
      readJson(join(roots.lifecycleRoot, 'project-map.json')),
      inspectLifecycleTree({ repositoryRoot: roots.projectRoot }),
    ]);
    if (!snapshot.ok) return snapshot;
    if (map.schema_version === 2) {
      const validation = validateJson('project-map', map);
      return validation.ok
        ? ok({ status: 'already-v2', fingerprint: snapshot.value.fingerprint, changed: [] })
        : validation;
    }
    return inspectV1({ ...roots, map, fingerprint: snapshot.value.fingerprint });
  } catch {
    return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Legacy lifecycle root could not be inspected safely.');
  }
};

const validateCandidate = async ({ lifecycleRoot, inspection }) => {
  try {
    const map = await readJson(join(lifecycleRoot, 'project-map.json'));
    const validation = validateJson('project-map', map);
    if (!validation.ok || JSON.stringify(map) !== JSON.stringify(inspection.map)) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Published v2 map differs from the inspected candidate.');
    for (const body of inspection.bodies) {
      if (body.repository_id !== null) continue;
      if (await readFile(join(lifecycleRoot, body.locator), 'utf8') !== body.content) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Published v2 body differs from the inspected candidate.');
    }
    for (const file of inspection.indexes.filter(({ repository_id: repositoryId }) => repositoryId === null)) {
      if (await readFile(join(lifecycleRoot, file.locator), 'utf8') !== file.content) return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Published v2 indexes are incomplete.');
    }
    for (const pair of inspection.moved_pairs.filter(({ to }) => to.repository_id === null)) {
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
      state === 'materialized' && pair.repository_id === null
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
  const inspection = await inspectLegacyKnowledgeLayout({ root: input.root });
  if (!inspection.ok) return inspection;
  if (inspection.value.status === 'already-v2') return inspection;
  if (!isNonEmptyString(input.approval_ref)) {
    return failure('KNOWLEDGE_LAYOUT_MIGRATION_APPROVAL_REQUIRED', '/approval_ref', 'Explicit migration approval is required before any durable write.');
  }
  if (!isNonEmptyString(input.expected_fingerprint)
    || input.expected_fingerprint !== inspection.value.fingerprint) {
    return failure('LAYOUT_FINGERPRINT_STALE', '/expected_fingerprint', 'Legacy lifecycle tree changed after inspection.');
  }
  const localBodies = inspection.value.bodies.filter(({ repository_id: repositoryId }) => repositoryId === null);
  if (localBodies.length !== inspection.value.bodies.length) {
    return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/repositories', 'Every repository shard must be migrated from its own local lifecycle root.');
  }
  const indexFiles = inspection.value.indexes.filter(({ repository_id: repositoryId }) => repositoryId === null);
  const transaction = await applyLayoutTransaction({
    repositoryRoot: inspection.value.project_root,
    expectedFingerprint: input.expected_fingerprint,
    candidateDirectories: inspection.value.layout.directories
      .filter(({ repository_id: repositoryId }) => repositoryId === null)
      .map(({ locator }) => locator),
    candidateFiles: [
      ...localBodies.map((body) => ({
        repository_id: null,
        locator: body.locator,
        content: body.content,
        validate: async (source) => source === body.content ? ok(source) : failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Staged body changed.'),
      })),
      ...indexFiles.map((file) => ({
        repository_id: null,
        locator: file.locator,
        content: file.content,
        validate: async (source) => source === file.content ? ok(source) : failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Staged index changed.'),
      })),
      {
        repository_id: null,
        locator: 'project-map.json',
        content: jsonContent(inspection.value.map),
        validate: async (source) => {
          try { return validateJson('project-map', JSON.parse(source)); } catch { return failure('KNOWLEDGE_LAYOUT_MIGRATION_INVALID', '/', 'Staged map is invalid.'); }
        },
      },
    ],
    deleteLocators: inspection.value.moved_pairs.flatMap(({ from }) => LANGUAGES.map((language) => from[language])),
    validateCandidate: ({ lifecycleRoot }) => validateCandidate({ lifecycleRoot, inspection: inspection.value }),
  }, operations);
  if (!transaction.ok) return transaction;
  return ok({
    status: 'migrated',
    from_schema: 1,
    to_schema: 2,
    approval_ref: input.approval_ref,
    moved_pairs: inspection.value.moved_pairs,
    changed_references: inspection.value.changed_references,
    external_link_risks: inspection.value.external_link_risks,
    verification: { schema: true, bilingual_pairs: true, hierarchical_indexes: true },
    changed: transaction.value.changed,
    cleanup_state: transaction.value.cleanup_pending ? 'pending' : 'complete',
    ...(transaction.value.recovery_artifacts.length > 0
      ? { recovery_artifacts: transaction.value.recovery_artifacts }
      : {}),
  });
};
