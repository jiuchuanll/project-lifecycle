import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { atomicWriteValidated } from '../lib/atomic-write.mjs';
import { validateBilingualPair } from '../lib/bilingual-pair.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseFactBlocks } from '../lib/fact-blocks.mjs';
import { parseFrontmatter } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { analyzeImpact, hashProjectMap } from './impact.mjs';

const applicationFailure = (code, path, message) => fail([createError(code, path, message)]);
const jsonContent = (value) => `${JSON.stringify(value, null, 2)}\n`;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const contentHash = (source) => `sha256:${createHash('sha256').update(source).digest('hex')}`;
const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

const fileState = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
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

const indexContent = (existing, map, language) => {
  const heading = language === 'en' ? '## Confirmed domains' : '## 已确认领域';
  const headingIndex = existing.indexOf(`${heading}\n`);
  if (headingIndex === -1 || !existing.startsWith('<!--')) {
    throw Object.assign(new Error('Generated index is invalid.'), { code: 'CHANGE_INDEX_INVALID' });
  }
  const prefix = existing.slice(0, headingIndex + heading.length + 1);
  const lines = map.domains.map((domain) => {
    const description = `${domain.label[language]}: ${domain.purpose[language]}`;
    if (domain.domain_state !== 'materialized') return `- \`${domain.id}\` — ${description}`;
    return `- [\`${domain.id}\`](${domain.paired_assets[language]}) — ${description}`;
  });
  return `${prefix}\n${lines.join('\n')}\n`;
};

const validateIndex = (source, expected, map) => (
  source === expected
  && source.endsWith('\n')
  && map.domains.every(({ id }) => source.includes(`\`${id}\``))
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

const validateCandidateRoot = async ({ lifecycleRoot, expectedMap, expectedPending, expectedIndexes }) => {
  try {
    const [map, pending, englishIndex, chineseIndex] = await Promise.all([
      readJson(join(lifecycleRoot, 'project-map.json')),
      readJson(join(lifecycleRoot, 'pending-changes.json')),
      readFile(join(lifecycleRoot, 'INDEX-en.md'), 'utf8'),
      readFile(join(lifecycleRoot, 'INDEX.md'), 'utf8'),
    ]);
    if (JSON.stringify(map) !== JSON.stringify(expectedMap)
      || JSON.stringify(pending) !== JSON.stringify(expectedPending)
      || englishIndex !== expectedIndexes.en
      || chineseIndex !== expectedIndexes['zh-CN']) {
      return applicationFailure('CHANGE_CANDIDATE_INVALID', '/', 'Candidate root differs from the reviewed change.');
    }
    const mapValidation = validateJson('project-map', map);
    if (!mapValidation.ok) return mapValidation;
    const pendingValidation = validateJson('pending-changes', pending);
    if (!pendingValidation.ok) return pendingValidation;
    for (const domain of map.domains.filter(({ domain_state: state }) => state === 'materialized')) {
      const pair = await validateBilingualPair(
        join(lifecycleRoot, domain.paired_assets.en),
        join(lifecycleRoot, domain.paired_assets['zh-CN']),
        map,
      );
      if (!pair.ok) return pair;
    }
    return validateConstraintKnowledge(lifecycleRoot, map);
  } catch {
    return applicationFailure('CHANGE_CANDIDATE_INVALID', '/', 'Candidate root validation failed.');
  }
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

const cleanupOwned = async (projectRoot, path) => {
  if (!path || !await fileState(path)) return;
  const physical = await realpath(path);
  if (!inside(projectRoot, physical)) throw new Error('Transaction path escaped project root.');
  await rm(path, { recursive: true, force: true });
};

const directoryFingerprint = async (root) => {
  const entries = [];
  const visit = async (directory, prefix = '') => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      const locator = prefix ? `${prefix}/${child.name}` : child.name;
      const state = await lstat(path);
      if (state.isDirectory() && !state.isSymbolicLink()) {
        entries.push({ locator: `${locator}/`, type: 'directory' });
        await visit(path, locator);
      } else if (state.isFile()) {
        entries.push({ locator, type: 'file', hash: createHash('sha256').update(await readFile(path)).digest('hex') });
      } else if (state.isSymbolicLink()) {
        entries.push({ locator, type: 'symlink', target: await readlink(path) });
      } else {
        throw new Error('Unsupported lifecycle filesystem entry.');
      }
    }
  };
  const state = await lstat(root);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Regular lifecycle root required.');
  await visit(root);
  return JSON.stringify(entries);
};

const fingerprintMatches = async (path, expected) => {
  try { return await directoryFingerprint(path) === expected; } catch { return false; }
};

const boundedDirectory = async (projectRoot, path) => {
  try {
    const state = await lstat(path);
    const physical = await realpath(path);
    return state.isDirectory() && !state.isSymbolicLink() && inside(projectRoot, physical);
  } catch {
    return false;
  }
};

const inspectTransitionState = async ({
  phase,
  projectRoot,
  lifecycleRoot,
  stageRoot,
  backupRoot,
  originalFingerprint,
  expectedCandidate,
}) => {
  if (phase === 'backup-moved') {
    const [live, stageBounded, backupBounded, backupOriginal] = await Promise.all([
      fileState(lifecycleRoot),
      boundedDirectory(projectRoot, stageRoot),
      boundedDirectory(projectRoot, backupRoot),
      fingerprintMatches(backupRoot, originalFingerprint),
    ]);
    return { ok: live === null && stageBounded && backupBounded && backupOriginal };
  }
  if (phase === 'candidate-moved') {
    const [stage, liveBounded, backupBounded, backupOriginal, liveCandidate] = await Promise.all([
      fileState(stageRoot),
      boundedDirectory(projectRoot, lifecycleRoot),
      boundedDirectory(projectRoot, backupRoot),
      fingerprintMatches(backupRoot, originalFingerprint),
      validateCandidateRoot({ lifecycleRoot, ...expectedCandidate }),
    ]);
    return { ok: stage === null && liveBounded && backupBounded && backupOriginal && liveCandidate.ok };
  }
  return { ok: false };
};

const recoveryArtifactLabels = async ({ lifecycleRoot, stageRoot, backupRoot }) => {
  const labels = [];
  for (const [label, path] of [['backup', backupRoot], ['live', lifecycleRoot], ['stage', stageRoot]]) {
    if (!path) continue;
    try { if (await fileState(path)) labels.push(label); } catch { labels.push(label); }
  }
  return labels;
};

const restoreFailure = async (paths) => {
  const labels = await recoveryArtifactLabels(paths);
  return applicationFailure(
    'CHANGE_RESTORE_FAILED',
    '/recovery',
    `Recovery required; preserved artifacts: ${labels.length > 0 ? labels.join(', ') : 'unknown'}.`,
  );
};

const reconcileOriginal = async ({
  projectRoot,
  lifecycleRoot,
  stageRoot,
  backupRoot,
  originalFingerprint,
  expectedCandidate,
  restoreRename,
}) => {
  try {
    if (await fingerprintMatches(lifecycleRoot, originalFingerprint)) {
      await cleanupOwned(projectRoot, stageRoot);
      return { ok: true };
    }
    if (!backupRoot || !await fingerprintMatches(backupRoot, originalFingerprint)
      || !await boundedDirectory(projectRoot, backupRoot)) {
      return { ok: false, result: await restoreFailure({ lifecycleRoot, stageRoot, backupRoot }) };
    }
    const live = await fileState(lifecycleRoot);
    if (live) {
      const liveCandidate = await validateCandidateRoot({ lifecycleRoot, ...expectedCandidate });
      if (!liveCandidate.ok || await fileState(stageRoot)) {
        return { ok: false, result: await restoreFailure({ lifecycleRoot, stageRoot, backupRoot }) };
      }
      await rename(lifecycleRoot, stageRoot);
      const preservedCandidate = await validateCandidateRoot({ lifecycleRoot: stageRoot, ...expectedCandidate });
      if (await fileState(lifecycleRoot) || !preservedCandidate.ok) {
        return { ok: false, result: await restoreFailure({ lifecycleRoot, stageRoot, backupRoot }) };
      }
    }
    try {
      await restoreRename(backupRoot, lifecycleRoot);
    } catch {
      if (!await fingerprintMatches(lifecycleRoot, originalFingerprint) || await fileState(backupRoot)) {
        return { ok: false, result: await restoreFailure({ lifecycleRoot, stageRoot, backupRoot }) };
      }
    }
    if (!await fingerprintMatches(lifecycleRoot, originalFingerprint) || await fileState(backupRoot)) {
      return { ok: false, result: await restoreFailure({ lifecycleRoot, stageRoot, backupRoot }) };
    }
    await cleanupOwned(projectRoot, stageRoot);
    return { ok: true };
  } catch {
    return { ok: false, result: await restoreFailure({ lifecycleRoot, stageRoot, backupRoot }) };
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
  let englishIndexSource;
  let chineseIndexSource;
  let originalFingerprint;
  try {
    roots = await resolveRoots(input.root);
    [currentMap, pending, englishIndexSource, chineseIndexSource] = await Promise.all([
      readJson(join(roots.lifecycleRoot, 'project-map.json')),
      readJson(join(roots.lifecycleRoot, 'pending-changes.json')),
      readFile(join(roots.lifecycleRoot, 'INDEX-en.md'), 'utf8'),
      readFile(join(roots.lifecycleRoot, 'INDEX.md'), 'utf8'),
    ]);
    originalFingerprint = await directoryFingerprint(roots.lifecycleRoot);
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
  let indexes;
  try {
    indexes = {
      en: indexContent(englishIndexSource, input.candidate_map, 'en'),
      'zh-CN': indexContent(chineseIndexSource, input.candidate_map, 'zh-CN'),
    };
  } catch {
    return applicationFailure('CHANGE_INDEX_INVALID', '/', 'Generated indexes cannot be regenerated.');
  }

  const write = operations.atomicWriteValidated ?? atomicWriteValidated;
  const publish = operations.rename ?? rename;
  const afterPublish = operations.afterPublish ?? (async () => {});
  const inspectTransition = operations.inspectTransition ?? inspectTransitionState;
  const restoreRename = operations.restoreRename ?? rename;
  const removeBackup = operations.removeBackup
    ?? ((path) => cleanupOwned(roots.projectRoot, path));
  let stageRoot;
  let backupRoot;
  const expectedCandidate = {
    expectedMap: input.candidate_map,
    expectedPending: candidatePending,
    expectedIndexes: indexes,
  };
  try {
    stageRoot = await mkdtemp(join(roots.docsRoot, '.project-lifecycle-change-stage-'));
    await cp(roots.lifecycleRoot, stageRoot, { recursive: true, force: false });
    for (const update of input.knowledge_updates) {
      for (const language of ['en', 'zh-CN']) {
        await write({
          root: stageRoot,
          target: update[language].locator,
          content: update[language].content,
          validate: async (source) => source === update[language].content
            ? ok(source)
            : applicationFailure('CHANGE_KNOWLEDGE_UPDATE_INVALID', '/', 'Localized knowledge update changed during validation.'),
        });
      }
    }
    await write({
      root: stageRoot,
      target: 'project-map.json',
      content: jsonContent(input.candidate_map),
      validate: async (source) => {
        try { return validateJson('project-map', JSON.parse(source)); } catch { return applicationFailure('SCHEMA_INVALID', '/', 'Invalid candidate map.'); }
      },
    });
    await write({
      root: stageRoot,
      target: 'pending-changes.json',
      content: jsonContent(candidatePending),
      validate: async (source) => {
        try { return validateJson('pending-changes', JSON.parse(source)); } catch { return applicationFailure('SCHEMA_INVALID', '/', 'Invalid pending candidate.'); }
      },
    });
    await write({ root: stageRoot, target: 'INDEX-en.md', content: indexes.en, validate: async (source) => validateIndex(source, indexes.en, input.candidate_map) });
    await write({ root: stageRoot, target: 'INDEX.md', content: indexes['zh-CN'], validate: async (source) => validateIndex(source, indexes['zh-CN'], input.candidate_map) });
    const staged = await validateCandidateRoot({ lifecycleRoot: stageRoot, expectedMap: input.candidate_map, expectedPending: candidatePending, expectedIndexes: indexes });
    if (!staged.ok) throw Object.assign(new Error('Staged candidate validation failed.'), { result: staged });

    backupRoot = await mkdtemp(join(roots.docsRoot, '.project-lifecycle-change-backup-'));
    await rmdir(backupRoot);
    await publish(roots.lifecycleRoot, backupRoot);
    const backupTransition = await inspectTransition({
      phase: 'backup-moved',
      projectRoot: roots.projectRoot,
      lifecycleRoot: roots.lifecycleRoot,
      stageRoot,
      backupRoot,
      originalFingerprint,
      expectedCandidate,
    });
    if (backupTransition?.ok !== true) throw new Error('Original publication transition failed.');

    await publish(stageRoot, roots.lifecycleRoot);
    const candidateTransition = await inspectTransition({
      phase: 'candidate-moved',
      projectRoot: roots.projectRoot,
      lifecycleRoot: roots.lifecycleRoot,
      stageRoot,
      backupRoot,
      originalFingerprint,
      expectedCandidate,
    });
    if (candidateTransition?.ok !== true) throw new Error('Candidate publication transition failed.');
    const live = await validateCandidateRoot({ lifecycleRoot: roots.lifecycleRoot, expectedMap: input.candidate_map, expectedPending: candidatePending, expectedIndexes: indexes });
    if (!live.ok) throw Object.assign(new Error('Published candidate validation failed.'), { result: live });
    await afterPublish({ lifecycleRoot: roots.lifecycleRoot });
    let cleanupComplete = false;
    try {
      await removeBackup(backupRoot);
    } catch {}
    try {
      cleanupComplete = await fileState(backupRoot) === null;
    } catch {}
    stageRoot = null;
    if (!cleanupComplete) {
      return ok({
        approval_ref: input.approval_ref,
        change_id: input.change_id,
        cleanup_state: 'pending',
        recovery_artifacts: ['backup'],
        status: 'applied',
        traceability: input.traceability,
      });
    }
    backupRoot = null;
    return ok({
      approval_ref: input.approval_ref,
      change_id: input.change_id,
      cleanup_state: 'complete',
      status: 'applied',
      traceability: input.traceability,
    });
  } catch (error) {
    const recovery = await reconcileOriginal({
      projectRoot: roots.projectRoot,
      lifecycleRoot: roots.lifecycleRoot,
      stageRoot,
      backupRoot,
      originalFingerprint,
      expectedCandidate,
      restoreRename,
    });
    if (!recovery.ok) return recovery.result;
    return error?.result ?? applicationFailure('CHANGE_WRITE_FAILED', '/', 'Approved change could not be applied.');
  }
}
