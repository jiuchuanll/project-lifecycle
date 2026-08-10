import {
  lstat,
  readFile,
  realpath,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { validateBilingualPair } from '../lib/bilingual-pair.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseFactBlocks } from '../lib/fact-blocks.mjs';
import { parseFrontmatter } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { analyzeImpact, hashProjectMap } from './impact.mjs';
import { generateIndexesFromRoot } from './generate-indexes.mjs';
import { pairForDomain, planKnowledgeLayout } from './layout-planner.mjs';
import { applyLayoutTransaction, inspectLifecycleTree } from './layout-transaction.mjs';

const applicationFailure = (code, path, message) => fail([createError(code, path, message)]);
const jsonContent = (value) => `${JSON.stringify(value, null, 2)}\n`;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const contentHash = (source) => `sha256:${createHash('sha256').update(source).digest('hex')}`;
const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

const resolveRoots = async (inputRoot) => {
  if (!isAbsolute(inputRoot)) throw Object.assign(new Error('Absolute root required.'), { code: 'CHANGE_ROOT_INVALID' });
  const lexicalRoot = resolve(inputRoot);
  const state = await lstat(lexicalRoot);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw Object.assign(new Error('Regular root required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  const projectRoot = await realpath(lexicalRoot);
  const docsRoot = await resolveInside(projectRoot, 'docs');
  const lifecycleRoot = await resolveInside(projectRoot, 'docs/project-lifecycle');
  for (const path of [docsRoot, lifecycleRoot]) {
    const pathState = await lstat(path);
    const physical = await realpath(path);
    if (!pathState.isDirectory() || pathState.isSymbolicLink() || !inside(projectRoot, physical)) {
      throw Object.assign(new Error('Bounded lifecycle root required.'), { code: 'PATH_SYMLINK_ESCAPE' });
    }
  }
  return { projectRoot, docsRoot: await realpath(docsRoot), lifecycleRoot: await realpath(lifecycleRoot) };
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const validateIndex = (source, expected, map) => (
  source === expected
  && source.endsWith('\n')
    ? ok(source)
    : applicationFailure('CHANGE_INDEX_INVALID', '/', 'Generated indexes are incomplete.')
);

const constraintMarkerPresent = (source, constraint) => {
  const anchor = `<a id="constraint-${constraint.id}"></a>`;
  const marker = `<!-- project-lifecycle:constraint id=${constraint.id} revision=${constraint.semantic_revision} -->`;
  return source.includes(anchor) && source.includes(marker)
    && source.includes('<!-- /project-lifecycle:constraint -->');
};

const validateConstraintKnowledge = async (root, map) => {
  for (const constraint of map.constraints.filter(({ knowledge_refs: refs }) => Boolean(refs))) {
    const owner = map.domains.find(({ id }) => id === constraint.owner_id);
    if (!owner?.paired_assets) {
      return applicationFailure('CONSTRAINT_KNOWLEDGE_MISSING', `/constraints/${constraint.id}/owner_id`, 'Constraint owner requires a materialized bilingual pair.');
    }
    for (const language of ['en', 'zh-CN']) {
      const [locator, fragment] = constraint.knowledge_refs[language].split('#');
      if (locator !== owner.paired_assets[language] || fragment !== `constraint-${constraint.id}`) {
        return applicationFailure('CONSTRAINT_KNOWLEDGE_MISSING', `/constraints/${constraint.id}/knowledge_refs/${language}`, 'Constraint knowledge reference must resolve to its owner pair.');
      }
      let source;
      try {
        source = await readFile(join(root, locator), 'utf8');
      } catch {
        return applicationFailure('CONSTRAINT_KNOWLEDGE_MISSING', `/constraints/${constraint.id}/knowledge_refs/${language}`, 'Constraint knowledge section is missing.');
      }
      if (!constraintMarkerPresent(source, constraint)) {
        return applicationFailure('CONSTRAINT_KNOWLEDGE_MISSING', `/constraints/${constraint.id}/knowledge_refs/${language}`, 'Constraint knowledge section revision is missing or stale.');
      }
    }
  }
  return ok(null);
};

const validateApplicationInput = (input) => {
  if (!isRecord(input)
    || typeof input.root !== 'string'
    || !isAbsolute(input.root)
    || !isNonEmptyString(input.change_id)
    || !isNonEmptyString(input.approval_ref)
    || !isRecord(input.traceability)
    || !isNonEmptyString(input.traceability.knowledge_diff_ref)
    || !isNonEmptyString(input.traceability.history_ref)
    || !isRecord(input.candidate_map)
    || !Array.isArray(input.knowledge_updates)) {
    return applicationFailure('CHANGE_APPROVAL_REQUIRED', '/approval_ref', 'Explicit approval and traceability are required before applying a governed change.');
  }
  return ok(null);
};

const validateDispositions = (entry, impact, currentMap, candidateMap) => {
  const ownerId = candidateMap.constraints.find(({ id }) => id === entry.proposed_patch.target_id)?.owner_id
    ?? currentMap.constraints.find(({ id }) => id === entry.proposed_patch.target_id)?.owner_id;
  const required = entry.proposed_patch.operation === 'MERGE_DOMAIN'
    ? currentMap.domains
      .filter(({ parent_id: parentId, domain_state: state }) => (
        parentId === entry.proposed_patch.target_id && ['confirmed', 'materialized'].includes(state)
      ))
      .map(({ id }) => id)
    : impact.affected_domain_ids.filter((id) => id !== ownerId && id !== entry.proposed_patch.target_id);
  const dispositions = new Map(entry.child_dispositions.map((item) => [item.domain_id, item]));
  if (required.some((id) => !dispositions.has(id))) {
    return applicationFailure('CHANGE_DISPOSITION_INCOMPLETE', '/child_dispositions', 'Every affected child requires a complete reviewed disposition.');
  }
  return ok(null);
};

const validateRevalidationMarkers = (entry, currentMap, candidateMap) => {
  const isConstraint = ['constraint', 'exception'].includes(entry.proposed_patch.target_type);
  const current = isConstraint
    ? currentMap.constraints.find(({ id }) => id === entry.proposed_patch.target_id)
    : null;
  const candidate = isConstraint
    ? candidateMap.constraints.find(({ id }) => id === entry.proposed_patch.target_id)
    : null;
  const hasUnresolved = entry.child_dispositions.some(({ unresolved_fact_ids: ids }) => ids.length > 0);
  if (isConstraint && hasUnresolved
    && (!current || !candidate || candidate.semantic_revision <= current.semantic_revision)) {
    return applicationFailure('CHANGE_REVALIDATION_MISMATCH', '/child_dispositions', 'Constraint-linked unresolved facts require an advancing reviewed revision.');
  }
  const expected = entry.child_dispositions.flatMap((disposition) => (
    disposition.unresolved_fact_ids.map((factId) => ({
      domain_id: disposition.domain_id,
      fact_id: factId,
      reason_ref: entry.change_id,
      ...(isConstraint ? {
        constraint_id: entry.proposed_patch.target_id,
        from_revision: current.semantic_revision,
        to_revision: candidate.semantic_revision,
      } : {}),
    }))
  ));
  const markerKey = (marker) => `${marker.domain_id}\u0000${marker.fact_id}\u0000${marker.constraint_id ?? ''}`;
  const retained = (currentMap.revalidation_required ?? [])
    .filter((marker) => !expected.some((item) => markerKey(item) === markerKey(marker)));
  const reviewed = [...retained, ...expected].sort((left, right) => compareCodePoints(markerKey(left), markerKey(right)));
  const actual = [...(candidateMap.revalidation_required ?? [])]
    .sort((left, right) => compareCodePoints(markerKey(left), markerKey(right)));
  if (JSON.stringify(reviewed) !== JSON.stringify(actual)) {
    return applicationFailure('CHANGE_REVALIDATION_MISMATCH', '/candidate_map/revalidation_required', 'Revalidation markers must exactly match reviewed unresolved facts.');
  }
  return ok(null);
};

const knowledgeSummary = (content) => {
  const frontmatter = parseFrontmatter(content);
  const facts = parseFactBlocks(content);
  if (!frontmatter.ok || !facts.ok) return null;
  return facts.value.map((fact) => ({
    fact_id: fact.fact_id,
    fact_revision: fact.revision,
    knowledge_state: frontmatter.value.data.knowledge_state,
  })).sort((left, right) => compareCodePoints(left.fact_id, right.fact_id));
};

const validateKnowledgeUpdates = (updates, map, entry) => {
  const commitments = entry.knowledge_commitments ?? [];
  if (updates.length !== commitments.length) {
    return applicationFailure('CHANGE_KNOWLEDGE_COMMITMENT_MISMATCH', '/knowledge_updates', 'Knowledge updates must exactly match reviewed commitments.');
  }
  const seen = new Set();
  for (const [index, update] of updates.entries()) {
    const domain = map.domains.find(({ id }) => id === update?.domain_id);
    if (!domain?.paired_assets || seen.has(update.domain_id)) {
      return applicationFailure('CHANGE_KNOWLEDGE_UPDATE_INVALID', `/knowledge_updates/${index}`, 'Each update must target one materialized canonical owner.');
    }
    seen.add(update.domain_id);
    const commitment = commitments.find(({ domain_id: id }) => id === update.domain_id);
    if (!commitment) {
      return applicationFailure('CHANGE_KNOWLEDGE_COMMITMENT_MISMATCH', `/knowledge_updates/${index}`, 'Unreviewed knowledge domain update is forbidden.');
    }
    for (const language of ['en', 'zh-CN']) {
      if (!isRecord(update[language])
        || update[language].locator !== domain.paired_assets[language]
        || !isNonEmptyString(update[language].content)) {
        return applicationFailure('CHANGE_KNOWLEDGE_UPDATE_INVALID', `/knowledge_updates/${index}/${language}`, 'Both canonical localized updates are required.');
      }
      if (commitment[language].locator !== update[language].locator
        || commitment[language].content_hash !== contentHash(update[language].content)
        || JSON.stringify(commitment.facts) !== JSON.stringify(knowledgeSummary(update[language].content))) {
        return applicationFailure('CHANGE_KNOWLEDGE_COMMITMENT_MISMATCH', `/knowledge_updates/${index}/${language}`, 'Knowledge content, facts, state, and locator must match the reviewed commitment.');
      }
    }
  }
  if (entry.proposed_patch.target_type === 'constraint') {
    const constraint = map.constraints.find(({ id }) => id === entry.proposed_patch.target_id)
      ?? map.constraints.find(({ successor_ids: successors }) => successors?.includes(entry.proposed_patch.target_id));
    const ownerId = constraint?.owner_id;
    if (commitments.length > 0 && (!ownerId || !seen.has(ownerId))) {
      return applicationFailure('CHANGE_KNOWLEDGE_UPDATE_INVALID', '/knowledge_updates', 'Constraint changes require their owning bilingual sections.');
    }
  }
  return ok(null);
};

const normalizedLayoutMap = (candidateMap, layout) => {
  const normalized = JSON.parse(JSON.stringify(candidateMap));
  for (const domain of normalized.domains) {
    if (domain.domain_state === 'materialized') domain.paired_assets = pairForDomain(layout, domain.id);
    else {
      delete domain.paired_assets;
      delete domain.baseline;
    }
  }
  for (const constraint of normalized.constraints) {
    if (!constraint.owner_id || !constraint.knowledge_refs) continue;
    const pair = pairForDomain(layout, constraint.owner_id);
    if (!pair) continue;
    constraint.knowledge_refs = {
      en: `${pair.en}#constraint-${constraint.id}`,
      'zh-CN': `${pair['zh-CN']}#constraint-${constraint.id}`,
    };
  }
  for (const repository of normalized.repositories) {
    repository.knowledge_asset_locators = normalized.domains
      .filter((domain) => domain.domain_state === 'materialized'
        && domain.paired_assets?.repository_id === repository.id)
      .flatMap((domain) => [domain.paired_assets.en, domain.paired_assets['zh-CN']])
      .sort(compareCodePoints);
  }
  return normalized;
};

const managedBodySource = (source, { oldId, newId, pairedAsset }) => {
  if (oldId === newId) return source;
  const closing = source.indexOf('\n---\n', 4);
  if (!source.startsWith('---\n') || closing === -1) return source;
  const frontmatter = source.slice(0, closing)
    .replace(new RegExp(`(^|\\n)id: ${oldId}(?=\\n|$)`, 'u'), `$1id: ${newId}`)
    .replace(/(^|\n)paired_asset: [^\n]+/u, `$1paired_asset: ${pairedAsset}`);
  return `${frontmatter}${source.slice(closing)}`;
};

const validatePublishedCandidate = async ({ lifecycleRoot, map, pending, indexFiles }) => {
  try {
    const [publishedMap, publishedPending] = await Promise.all([
      readJson(join(lifecycleRoot, 'project-map.json')),
      readJson(join(lifecycleRoot, 'pending-changes.json')),
    ]);
    if (JSON.stringify(publishedMap) !== JSON.stringify(map)
      || JSON.stringify(publishedPending) !== JSON.stringify(pending)) {
      return applicationFailure('CHANGE_CANDIDATE_INVALID', '/', 'Published governance files differ from the reviewed candidate.');
    }
    for (const file of indexFiles) {
      if (await readFile(join(lifecycleRoot, file.locator), 'utf8') !== file.content) {
        return applicationFailure('CHANGE_INDEX_INVALID', '/', 'Published hierarchical indexes are incomplete.');
      }
    }
    for (const domain of map.domains.filter(({ domain_state: state }) => state === 'materialized')) {
      if (domain.paired_assets.repository_id !== null) continue;
      const pair = await validateBilingualPair(
        join(lifecycleRoot, domain.paired_assets.en),
        join(lifecycleRoot, domain.paired_assets['zh-CN']),
        map,
      );
      if (!pair.ok) return pair;
    }
    return validateConstraintKnowledge(lifecycleRoot, map);
  } catch {
    return applicationFailure('CHANGE_CANDIDATE_INVALID', '/', 'Published hierarchical candidate validation failed.');
  }
};

/**
 * Applies one human-approved candidate through a root visibility swap.
 * Trust precondition: Project Lifecycle is the sole writer for the lifecycle root.
 * The caller/host owns approval and traceability authority; this function binds
 * supplied references to the reviewed candidate but does not verify an external authority.
 */
export async function applyApprovedChange(input, operations = {}) {
  const inputValidation = validateApplicationInput(input);
  if (!inputValidation.ok) return inputValidation;

  let roots;
  let currentMap;
  let pending;
  try {
    roots = await resolveRoots(input.root);
    [currentMap, pending] = await Promise.all([
      readJson(join(roots.lifecycleRoot, 'project-map.json')),
      readJson(join(roots.lifecycleRoot, 'pending-changes.json')),
    ]);
  } catch (error) {
    return applicationFailure(error?.code === 'PATH_SYMLINK_ESCAPE' ? error.code : 'CHANGE_ROOT_INVALID', '/', 'A complete bounded lifecycle root is required.');
  }
  const mapValidation = validateJson('project-map', currentMap);
  if (!mapValidation.ok) return mapValidation;
  const pendingValidation = validateJson('pending-changes', pending);
  if (!pendingValidation.ok) return pendingValidation;
  const entry = pending.changes.find(({ change_id: id }) => id === input.change_id);
  if (!entry?.proposal_version) {
    return applicationFailure('REFERENCE_MISSING', '/change_id', 'Governed pending change is missing.');
  }
  if (entry.baseline.map_hash !== hashProjectMap(currentMap)
    || entry.proposed_patch.candidate_map_hash !== hashProjectMap(input.candidate_map)) {
    return applicationFailure('CHANGE_BASELINE_STALE', '/candidate_map', 'Pending baseline or candidate no longer matches accepted truth.');
  }
  const candidateValidation = validateJson('project-map', input.candidate_map);
  if (!candidateValidation.ok) return candidateValidation;
  const impact = analyzeImpact({
    current_map: currentMap,
    candidate_map: input.candidate_map,
    change_class: entry.change_class,
    changed_fields: entry.proposed_patch.changed_fields,
    target_id: entry.proposed_patch.target_id,
    child_dispositions: entry.child_dispositions,
    operation: entry.proposed_patch.operation,
  });
  if (!impact.ok) return impact;
  const dispositions = validateDispositions(entry, impact.value, currentMap, input.candidate_map);
  if (!dispositions.ok) return dispositions;
  const markers = validateRevalidationMarkers(entry, currentMap, input.candidate_map);
  if (!markers.ok) return markers;
  const updates = validateKnowledgeUpdates(input.knowledge_updates, input.candidate_map, entry);
  if (!updates.ok) return updates;

  const candidatePending = {
    ...pending,
    changes: pending.changes.filter(({ change_id: id }) => id !== input.change_id),
  };
  const pendingCandidateValidation = validateJson('pending-changes', candidatePending);
  if (!pendingCandidateValidation.ok) return pendingCandidateValidation;

  const [currentLayout, candidateLayout] = [
    planKnowledgeLayout({ map: currentMap }),
    planKnowledgeLayout({ map: input.candidate_map }),
  ];
  if (!currentLayout.ok || !candidateLayout.ok) {
    return applicationFailure('CHANGE_INDEX_INVALID', '/', 'Current and candidate topology must have canonical layouts.');
  }
  const candidateMap = normalizedLayoutMap(input.candidate_map, candidateLayout.value);
  const normalizedValidation = validateJson('project-map', candidateMap);
  if (!normalizedValidation.ok) return normalizedValidation;

  const updatesByDomain = new Map(input.knowledge_updates.map((update) => [update.domain_id, update]));
  const bodyFiles = [];
  const overlays = {};
  try {
    for (const domain of candidateMap.domains.filter(({ domain_state: state }) => state === 'materialized')) {
      if (domain.paired_assets.repository_id !== null) continue;
      const currentDomain = currentMap.domains.find(({ id }) => id === domain.id);
      const predecessor = currentDomain ? null : currentMap.domains.find((entry) => (
        input.candidate_map.domains.find(({ id }) => id === entry.id)?.successor_id === domain.id
      ));
      const sourceDomain = currentDomain ?? predecessor;
      const reviewedUpdate = updatesByDomain.get(domain.id) ?? (predecessor ? updatesByDomain.get(predecessor.id) : null);
      for (const language of ['en', 'zh-CN']) {
        const locator = domain.paired_assets[language];
        let content = reviewedUpdate?.[language]?.content;
        if (content === undefined && sourceDomain?.paired_assets?.[language]) {
          content = await readFile(join(roots.lifecycleRoot, sourceDomain.paired_assets[language]), 'utf8');
        }
        if (typeof content !== 'string') {
          return applicationFailure('CHANGE_KNOWLEDGE_UPDATE_INVALID', `/domains/${domain.id}`, 'Every materialized candidate requires a complete localized source pair.');
        }
        content = managedBodySource(content, {
          oldId: sourceDomain?.id ?? domain.id,
          newId: domain.id,
          pairedAsset: domain.paired_assets[language === 'en' ? 'zh-CN' : 'en'].split('/').at(-1),
        });
        overlays[locator] = content;
        bodyFiles.push({
          repository_id: null,
          locator,
          content,
          validate: async (source) => source === content
            ? ok(source)
            : applicationFailure('CHANGE_KNOWLEDGE_UPDATE_INVALID', '/', 'Localized knowledge body changed during staging.'),
        });
      }
    }
  } catch {
    return applicationFailure('CHANGE_KNOWLEDGE_UPDATE_INVALID', '/', 'A canonical source body could not be loaded.');
  }
  const generatedIndexes = await generateIndexesFromRoot({
    map: candidateMap,
    lifecycleRoot: roots.lifecycleRoot,
    overlays,
  });
  if (!generatedIndexes.ok) {
    return applicationFailure('CHANGE_INDEX_INVALID', '/', 'Generated indexes cannot be regenerated.');
  }
  const indexFiles = generatedIndexes.value.files.filter(({ repository_id: repositoryId }) => repositoryId === null);
  const previousBodyLocators = currentLayout.value.bodies
    .filter(({ repository_id: repositoryId }) => repositoryId === null)
    .map(({ locator }) => locator);
  const nextBodyLocators = new Set(bodyFiles.map(({ locator }) => locator));
  const previousIndexes = new Set(currentLayout.value.indexes
    .filter(({ repository_id: repositoryId }) => repositoryId === null)
    .map(({ locator }) => locator));
  previousIndexes.add('INDEX-en.md');
  previousIndexes.add('INDEX.md');
  const nextIndexes = new Set(indexFiles.map(({ locator }) => locator));
  const inspected = await inspectLifecycleTree({ repositoryRoot: roots.projectRoot });
  if (!inspected.ok) return applicationFailure('CHANGE_ROOT_INVALID', '/', 'The lifecycle root changed before publication.');
  const candidateFiles = [
    ...bodyFiles,
    ...indexFiles.map((file) => ({
      repository_id: null,
      locator: file.locator,
      content: file.content,
      validate: async (source) => validateIndex(source, file.content, candidateMap),
    })),
    {
      repository_id: null,
      locator: 'project-map.json',
      content: jsonContent(candidateMap),
      validate: async (source) => {
        try { return validateJson('project-map', JSON.parse(source)); } catch { return applicationFailure('SCHEMA_INVALID', '/', 'Invalid candidate map.'); }
      },
    },
    {
      repository_id: null,
      locator: 'pending-changes.json',
      content: jsonContent(candidatePending),
      validate: async (source) => {
        try { return validateJson('pending-changes', JSON.parse(source)); } catch { return applicationFailure('SCHEMA_INVALID', '/', 'Invalid pending candidate.'); }
      },
    },
  ];
  let publicationRejected = null;
  const transactionOperations = {
    ...operations,
    ...(operations.rename ? {
      rename: async (...args) => {
        try {
          return await operations.rename(...args);
        } catch (error) {
          publicationRejected = error;
          throw error;
        }
      },
    } : {}),
    afterPublish: async (context) => {
      if (publicationRejected) throw publicationRejected;
      await (operations.afterPublish ?? (async () => {}))(context);
    },
  };
  const transaction = await applyLayoutTransaction({
    repositoryRoot: roots.projectRoot,
    expectedFingerprint: inspected.value.fingerprint,
    candidateDirectories: candidateLayout.value.directories
      .filter(({ repository_id: repositoryId }) => repositoryId === null)
      .map(({ locator }) => locator),
    candidateFiles,
    deleteLocators: [
      ...previousBodyLocators.filter((locator) => !nextBodyLocators.has(locator)),
      ...[...previousIndexes].filter((locator) => !nextIndexes.has(locator)),
    ],
    validateCandidate: ({ lifecycleRoot }) => validatePublishedCandidate({
      lifecycleRoot,
      map: candidateMap,
      pending: candidatePending,
      indexFiles,
    }),
  }, transactionOperations);
  if (!transaction.ok) {
    const code = transaction.errors[0]?.code === 'LAYOUT_RESTORE_FAILED'
      ? 'CHANGE_RESTORE_FAILED'
      : 'CHANGE_WRITE_FAILED';
    return applicationFailure(code, transaction.errors[0]?.path ?? '/', transaction.errors[0]?.message ?? 'Approved change could not be applied.');
  }
  return ok({
    approval_ref: input.approval_ref,
    change_id: input.change_id,
    cleanup_state: transaction.value.cleanup_pending ? 'pending' : 'complete',
    ...(transaction.value.recovery_artifacts.length > 0
      ? { recovery_artifacts: transaction.value.recovery_artifacts }
      : {}),
    changed: transaction.value.changed,
    status: 'applied',
    traceability: input.traceability,
  });
}
