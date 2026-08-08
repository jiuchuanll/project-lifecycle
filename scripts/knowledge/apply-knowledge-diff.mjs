import { createHash } from 'node:crypto';
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
import { generateIndexesFromRoot } from './generate-indexes.mjs';

const LANGUAGES = ['en', 'zh-CN'];
const envelopeFields = new Set([
  'root',
  'knowledge_diff',
  'new_baseline',
  'approval_ref',
  'resolution_ref',
  'conflict_resolution',
  'knowledge_updates',
]);
const mutationKinds = new Set(['ADD', 'REWRITE', 'SUPERSEDE']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isStructuredRef = (value) => isNonEmptyString(value)
  && value.length <= 500
  && /^[a-z][a-z0-9-]*:[^\s`<>\\]+$/u.test(value)
  && !value.includes('--');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const clone = (value) => JSON.parse(JSON.stringify(value));
const jsonContent = (value) => `${JSON.stringify(value, null, 2)}\n`;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const contentHash = (source) => `sha256:${createHash('sha256').update(source).digest('hex')}`;

const fileState = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
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

const resolveRoots = async (inputRoot) => {
  if (!isAbsolute(inputRoot)) throw Object.assign(new Error('Absolute root required.'), { code: 'ABSORPTION_ROOT_INVALID' });
  const lexicalRoot = resolve(inputRoot);
  const state = await lstat(lexicalRoot);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw Object.assign(new Error('Regular project root required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  const projectRoot = await realpath(lexicalRoot);
  const docsRoot = await resolveInside(projectRoot, 'docs');
  const lifecycleRoot = await resolveInside(projectRoot, 'docs/project-lifecycle');
  for (const path of [docsRoot, lifecycleRoot]) {
    if (!await boundedDirectory(projectRoot, path)) {
      throw Object.assign(new Error('Bounded lifecycle root required.'), { code: 'PATH_SYMLINK_ESCAPE' });
    }
  }
  return {
    projectRoot,
    docsRoot: await realpath(docsRoot),
    lifecycleRoot: await realpath(lifecycleRoot),
  };
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const validateEnvelope = (input) => {
  if (!isRecord(input)
    || Object.keys(input).some((field) => !envelopeFields.has(field))
    || !isAbsolute(input.root ?? '')
    || !isRecord(input.knowledge_diff)
    || !Array.isArray(input.knowledge_updates)) {
    return failure('ABSORPTION_ENVELOPE_INVALID', '/', 'A closed privileged absorption envelope is required.');
  }
  for (const field of ['approval_ref', 'resolution_ref']) {
    if (Object.hasOwn(input, field) && !isStructuredRef(input[field])) {
      return failure('ABSORPTION_APPROVAL_INVALID', `/${field}`, 'Approval and resolution references must be structured references.');
    }
  }
  if (Object.hasOwn(input, 'conflict_resolution')
    && (!isRecord(input.conflict_resolution)
      || Object.keys(input.conflict_resolution).length !== 1
      || !/^[a-z][a-z0-9-]*$/u.test(input.conflict_resolution.change_id ?? ''))) {
    return failure('ABSORPTION_CONFLICT_MISMATCH', '/conflict_resolution', 'Conflict resolution must identify exactly one bounded pending change.');
  }
  return ok(null);
};

const parseDocument = (source, path) => {
  if (typeof source !== 'string' || source.length === 0) {
    return failure('ABSORPTION_PAIR_REQUIRED', path, 'Both exact localized capability candidates are required.');
  }
  const frontmatter = parseFrontmatter(source);
  const facts = parseFactBlocks(source);
  if (!frontmatter.ok || !facts.ok) {
    return fail([...(frontmatter.ok ? [] : frontmatter.errors), ...(facts.ok ? [] : facts.errors)]);
  }
  return ok({ source, frontmatter: frontmatter.value.data, facts: facts.value });
};

const machineFact = (fact) => ({
  fact_id: fact.fact_id,
  revision: fact.revision,
  evidence_refs: fact.evidence_refs,
  last_verified_baseline: fact.last_verified_baseline,
});

const comparableFact = (fact) => ({
  fact_id: fact.fact_id,
  revision: fact.revision,
  evidence_refs: fact.evidence_refs,
  statement: fact.statement,
  known_limits: fact.known_limits,
});

const factSummary = (document) => document.facts.map((fact) => ({
  fact_id: fact.fact_id,
  fact_revision: fact.revision,
  knowledge_state: document.frontmatter.knowledge_state,
}));

const factUnitPattern = /^#{3,6}[^\n]*\n(?:\n)*<!-- project-lifecycle:fact\n[\s\S]*?<!-- \/project-lifecycle:fact -->\n?/gmu;
const documentSkeleton = (source) => source
  .replace(factUnitPattern, '')
  .replace(/last_verified_baseline: [^\n]+/u, 'last_verified_baseline: <baseline>')
  .replace(/implementation_refs: [^\n]+/u, 'implementation_refs: <implementation-refs>')
  .replace(/\n{3,}/gu, '\n\n')
  .trim();

const validateCandidateUpdates = async ({ lifecycleRoot, map, input }) => {
  const updates = new Map();
  const currentDocuments = new Map();
  const currentFactOwners = new Map();

  for (const domain of map.domains.filter(({ domain_state: state }) => state === 'materialized')) {
    if (!domain.paired_assets || !domain.baseline) {
      return failure('ABSORPTION_OWNER_MISMATCH', `/domains/${domain.id}`, 'Every current fact owner requires one canonical bilingual asset.');
    }
    const documents = {};
    for (const language of LANGUAGES) {
      let source;
      try {
        source = await readFile(join(lifecycleRoot, domain.paired_assets[language]), 'utf8');
      } catch {
        return failure('ABSORPTION_PAIR_REQUIRED', `/domains/${domain.id}/${language}`, 'Canonical bilingual owner asset is missing.');
      }
      const parsed = parseDocument(source, `/domains/${domain.id}/${language}`);
      if (!parsed.ok) return parsed;
      documents[language] = parsed.value;
    }
    currentDocuments.set(domain.id, documents);
    for (const fact of documents.en.facts) {
      const existing = currentFactOwners.get(fact.fact_id);
      if (existing) {
        return failure('ABSORPTION_FACT_DUPLICATE', `/facts/${fact.fact_id}`, 'A stable fact identity has more than one canonical owner.');
      }
      currentFactOwners.set(fact.fact_id, { domain_id: domain.id, fact });
    }
  }

  const seenDomains = new Set();
  for (const [index, update] of input.knowledge_updates.entries()) {
    if (!isRecord(update)
      || Object.keys(update).length !== 4
      || !Object.hasOwn(update, 'facts')
      || !isNonEmptyString(update.domain_id)
      || seenDomains.has(update.domain_id)
      || !isRecord(update.en)
      || !isRecord(update['zh-CN'])
      || !Array.isArray(update.facts)) {
      return failure('ABSORPTION_PAIR_REQUIRED', `/knowledge_updates/${index}`, 'Each owner update requires exactly one complete bilingual pair.');
    }
    const domain = map.domains.find(({ id }) => id === update.domain_id);
    if (!domain || domain.domain_state !== 'materialized' || !domain.paired_assets) {
      return failure('ABSORPTION_OWNER_MISMATCH', `/knowledge_updates/${index}/domain_id`, 'Knowledge updates must target one materialized canonical owner.');
    }
    const parsed = {};
    for (const language of LANGUAGES) {
      const localized = update[language];
      if (!isRecord(localized)
        || Object.keys(localized).length !== 3
        || !Object.hasOwn(localized, 'content')
        || !/^sha256:[0-9a-f]{64}$/u.test(localized.content_hash ?? '')
        || localized.locator !== domain.paired_assets[language]) {
        return failure('ABSORPTION_PAIR_REQUIRED', `/knowledge_updates/${index}/${language}`, 'Localized update locator must match the canonical owner pair.');
      }
      const result = parseDocument(localized.content, `/knowledge_updates/${index}/${language}/content`);
      if (!result.ok) return result;
      if (localized.content_hash !== contentHash(localized.content)) {
        return failure('ABSORPTION_COMMITMENT_MISMATCH', `/knowledge_updates/${index}/${language}/content_hash`, 'Localized content hash differs from the accepted candidate.');
      }
      if (result.value.frontmatter.id !== domain.id
        || result.value.frontmatter.knowledge_state !== 'current'
        || result.value.frontmatter.last_verified_baseline !== input.new_baseline) {
        return failure('ABSORPTION_PAIR_INVALID', `/knowledge_updates/${index}/${language}`, 'Candidate must remain current at the exact new baseline.');
      }
      parsed[language] = result.value;
    }
    for (const field of ['id', 'knowledge_state', 'paired_asset', 'last_verified_baseline', 'implementation_refs', 'verification_refs']) {
      if (!same(parsed.en.frontmatter[field], parsed['zh-CN'].frontmatter[field])) {
        return failure('ABSORPTION_PAIR_INVALID', `/knowledge_updates/${index}/${field}`, 'Localized candidate Frontmatter metadata differs.');
      }
    }
    const expectedImplementationRefs = [...new Set([
      ...currentDocuments.get(domain.id).en.frontmatter.implementation_refs,
      ...input.knowledge_diff.entry_points,
    ])].sort(compareCodePoints);
    if (!same(parsed.en.frontmatter.implementation_refs, expectedImplementationRefs)
      || !same(parsed.en.frontmatter.verification_refs, currentDocuments.get(domain.id).en.frontmatter.verification_refs)) {
      return failure('ABSORPTION_CHANGE_NOT_BOUNDED', `/knowledge_updates/${index}/frontmatter`, 'Entry points must be the exact accepted additions and verification routing cannot change implicitly.');
    }
    if (!same(update.facts, factSummary(parsed.en))
      || !same(update.facts, factSummary(parsed['zh-CN']))) {
      return failure('ABSORPTION_COMMITMENT_MISMATCH', `/knowledge_updates/${index}/facts`, 'Fact summary differs from the exact bilingual candidate.');
    }
    if (parsed.en.facts.length !== parsed['zh-CN'].facts.length) {
      return failure('ABSORPTION_PAIR_INVALID', `/knowledge_updates/${index}/facts`, 'Localized candidate fact counts differ.');
    }
    for (const [factIndex, englishFact] of parsed.en.facts.entries()) {
      const chineseFact = parsed['zh-CN'].facts[factIndex];
      if (!same(machineFact(englishFact), machineFact(chineseFact))) {
        return failure('ABSORPTION_PAIR_INVALID', `/knowledge_updates/${index}/facts/${factIndex}`, 'Localized candidate fact metadata differs.');
      }
      if (englishFact.last_verified_baseline !== input.new_baseline || englishFact.evidence_refs.length === 0) {
        return failure('ABSORPTION_EVIDENCE_REQUIRED', `/knowledge_updates/${index}/facts/${factIndex}`, 'Every current candidate fact requires evidence at the new baseline.');
      }
    }
    const current = currentDocuments.get(domain.id);
    if (documentSkeleton(current.en.source) !== documentSkeleton(parsed.en.source)
      || documentSkeleton(current['zh-CN'].source) !== documentSkeleton(parsed['zh-CN'].source)) {
      return failure('ABSORPTION_CHANGE_NOT_BOUNDED', `/knowledge_updates/${index}`, 'Knowledge Diff cannot rewrite unrelated capability prose.');
    }
    seenDomains.add(domain.id);
    updates.set(domain.id, { update, parsed, current });
  }

  return ok({ updates, currentDocuments, currentFactOwners });
};

const validateOperations = ({ diff, candidateState }) => {
  const touchedOwners = new Set(diff.operations.map(({ owner_domain_id: owner }) => owner));
  if (touchedOwners.size !== candidateState.updates.size
    || [...touchedOwners].some((owner) => !candidateState.updates.has(owner))) {
    return failure('ABSORPTION_OWNER_MISMATCH', '/knowledge_updates', 'Exact bilingual updates must target every and only declared canonical owner.');
  }
  const seenTargets = new Set();
  const claimedIdentities = new Set();
  const appliedFacts = [];
  const supersededFacts = [];
  for (const [index, operation] of diff.operations.entries()) {
    const path = `/knowledge_diff/operations/${index}`;
    if (!mutationKinds.has(operation.kind) || operation.evidence_refs.length === 0
      || operation.evidence_refs.some((reference) => !diff.evidence_refs.includes(reference))) {
      return failure('ABSORPTION_EVIDENCE_REQUIRED', `${path}/evidence_refs`, 'Each supported operation requires accepted Knowledge Diff evidence.');
    }
    const ownerUpdate = candidateState.updates.get(operation.owner_domain_id);
    if (!ownerUpdate) {
      return failure('ABSORPTION_OWNER_MISMATCH', `${path}/owner_domain_id`, 'Operation owner must be the canonical materialized fact owner.');
    }
    const beforeFacts = new Map(ownerUpdate.current.en.facts.map((fact) => [fact.fact_id, fact]));
    const afterFacts = new Map(ownerUpdate.parsed.en.facts.map((fact) => [fact.fact_id, fact]));
    const canonical = candidateState.currentFactOwners.get(operation.fact_id);
    const targetKey = `${operation.kind}:${operation.fact_id}`;
    const identities = [operation.fact_id, ...(operation.successor_fact_id ? [operation.successor_fact_id] : [])];
    if (seenTargets.has(targetKey) || identities.some((identity) => claimedIdentities.has(identity))) {
      return failure('ABSORPTION_CHANGE_NOT_BOUNDED', path, 'One Knowledge Diff cannot repeat a semantic fact operation.');
    }
    seenTargets.add(targetKey);
    for (const identity of identities) claimedIdentities.add(identity);

    if (operation.kind === 'ADD') {
      const added = afterFacts.get(operation.fact_id);
      if (canonical || !added || beforeFacts.has(operation.fact_id) || added.revision !== 1) {
        return failure('ABSORPTION_FACT_IDENTITY_INVALID', `${path}/fact_id`, 'ADD requires one globally fresh fact at revision 1.');
      }
      if (added.evidence_refs.some((reference) => !diff.evidence_refs.includes(reference))) {
        return failure('ABSORPTION_EVIDENCE_REQUIRED', `${path}/evidence_refs`, 'Added fact evidence must belong to the accepted Knowledge Diff.');
      }
      appliedFacts.push({ fact_id: added.fact_id, owner_domain_id: operation.owner_domain_id, revision: 1 });
    } else if (operation.kind === 'REWRITE') {
      const rewritten = afterFacts.get(operation.fact_id);
      if (!canonical || canonical.domain_id !== operation.owner_domain_id || !rewritten) {
        return failure('ABSORPTION_OWNER_MISMATCH', `${path}/owner_domain_id`, 'REWRITE must retain the canonical fact owner and identity.');
      }
      if (rewritten.revision !== canonical.fact.revision + 1) {
        return failure('ABSORPTION_REVISION_INVALID', `${path}/fact_id`, 'REWRITE must increment fact revision exactly once.');
      }
      if (rewritten.evidence_refs.some((reference) => !diff.evidence_refs.includes(reference))) {
        return failure('ABSORPTION_EVIDENCE_REQUIRED', `${path}/evidence_refs`, 'Rewritten fact evidence must belong to the accepted Knowledge Diff.');
      }
      appliedFacts.push({ fact_id: rewritten.fact_id, owner_domain_id: operation.owner_domain_id, revision: rewritten.revision });
    } else {
      const successor = afterFacts.get(operation.successor_fact_id);
      if (!canonical || canonical.domain_id !== operation.owner_domain_id
        || afterFacts.has(operation.fact_id)
        || candidateState.currentFactOwners.has(operation.successor_fact_id)
        || !successor
        || successor.revision !== 1
        || operation.successor_fact_id === operation.fact_id) {
        return failure('ABSORPTION_FACT_IDENTITY_INVALID', `${path}/successor_fact_id`, 'SUPERSEDE requires a fresh revision-1 successor and removal of the predecessor from current retrieval.');
      }
      if (successor.evidence_refs.some((reference) => !diff.evidence_refs.includes(reference))) {
        return failure('ABSORPTION_EVIDENCE_REQUIRED', `${path}/evidence_refs`, 'Successor evidence must belong to the accepted Knowledge Diff.');
      }
      appliedFacts.push({ fact_id: successor.fact_id, owner_domain_id: operation.owner_domain_id, revision: 1 });
      supersededFacts.push({ fact_id: operation.fact_id, successor_fact_id: operation.successor_fact_id });
    }
  }

  const operatedBefore = new Set(diff.operations.flatMap((operation) => (
    operation.kind === 'ADD' ? [] : [operation.fact_id]
  )));
  const operatedAfter = new Set(diff.operations.map((operation) => (
    operation.kind === 'SUPERSEDE' ? operation.successor_fact_id : operation.fact_id
  )));
  for (const [domainId, ownerUpdate] of candidateState.updates) {
    const before = new Map(ownerUpdate.current.en.facts.map((fact) => [fact.fact_id, fact]));
    const after = new Map(ownerUpdate.parsed.en.facts.map((fact) => [fact.fact_id, fact]));
    for (const [factId, fact] of before) {
      if (operatedBefore.has(factId)) continue;
      const candidate = after.get(factId);
      if (!candidate || !same(comparableFact(fact), comparableFact(candidate))) {
        return failure('ABSORPTION_CHANGE_NOT_BOUNDED', `/knowledge_updates/${domainId}/facts/${factId}`, 'An unlisted current fact changed.');
      }
    }
    for (const factId of after.keys()) {
      if (!before.has(factId) && !operatedAfter.has(factId)) {
        return failure('ABSORPTION_CHANGE_NOT_BOUNDED', `/knowledge_updates/${domainId}/facts/${factId}`, 'An unlisted fact was added.');
      }
    }
  }
  return ok({ appliedFacts, supersededFacts });
};

const conflictId = (diffId) => `absorption-${diffId}`;

const conflictKind = (diff) => {
  if (diff.domain_changes.length > 0) return 'topology';
  if (diff.operations.some(({ kind }) => kind === 'SUPERSEDE')) return 'fact_identity';
  if (diff.operations.some(({ kind }) => kind === 'REWRITE')) return 'material_conflict';
  return 'fact_identity';
};

const pendingConflict = (diff, now) => ({
  change_id: conflictId(diff.diff_id),
  kind: conflictKind(diff),
  trigger_refs: [`knowledge-diff:${diff.diff_id}`],
  affected_refs: [
    ...diff.operations.flatMap((operation) => [
      `domain:${operation.owner_domain_id}`,
      `fact:${operation.fact_id}`,
      ...(operation.successor_fact_id ? [`fact:${operation.successor_fact_id}`] : []),
    ]),
    ...diff.domain_changes.map(({ domain_id: domainId }) => `domain:${domainId}`),
  ].filter((value, index, values) => values.indexOf(value) === index).sort(compareCodePoints),
  proposed_disposition: 'Review the referenced Knowledge Diff against the current canonical owner and baseline.',
  risks: ['Current accepted knowledge remains unchanged until explicit resolution.'],
  evidence_gaps: ['Human approval or supported conflict resolution is unresolved.'],
  review_state: 'open',
  created_at: now(),
});

const directoryFingerprint = async (root) => {
  const entries = [];
  const visit = async (directory, prefix = '') => {
    const children = (await readdir(directory, { withFileTypes: true }))
      .toSorted((left, right) => compareCodePoints(left.name, right.name));
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
      } else throw new Error('Unsupported lifecycle filesystem entry.');
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

const validateIndex = (source, expected, map) => source === expected
  && source.endsWith('\n')
  && map.domains.every(({ id }) => source.includes(`\`${id}\``))
  ? ok(source)
  : failure('ABSORPTION_INDEX_INVALID', '/', 'Generated indexes are incomplete.');

const validateCandidateRoot = async ({ lifecycleRoot, expectedMap, expectedPending, expectedIndexes }) => {
  try {
    const [map, pending, englishIndex, chineseIndex] = await Promise.all([
      readJson(join(lifecycleRoot, 'project-map.json')),
      readJson(join(lifecycleRoot, 'pending-changes.json')),
      readFile(join(lifecycleRoot, 'INDEX-en.md'), 'utf8'),
      readFile(join(lifecycleRoot, 'INDEX.md'), 'utf8'),
    ]);
    if (!same(map, expectedMap) || !same(pending, expectedPending)
      || englishIndex !== expectedIndexes.en || chineseIndex !== expectedIndexes['zh-CN']) {
      return failure('ABSORPTION_CANDIDATE_INVALID', '/', 'Staged root differs from the accepted absorption write set.');
    }
    const mapValidation = validateJson('project-map', map);
    if (!mapValidation.ok) return mapValidation;
    const pendingValidation = validateJson('pending-changes', pending);
    if (!pendingValidation.ok) return pendingValidation;
    const owners = new Set();
    for (const domain of map.domains.filter(({ domain_state: state }) => state === 'materialized')) {
      const pair = await validateBilingualPair(
        join(lifecycleRoot, domain.paired_assets.en),
        join(lifecycleRoot, domain.paired_assets['zh-CN']),
        map,
      );
      if (!pair.ok) return pair;
      for (const factId of pair.value.fact_ids) {
        if (owners.has(factId)) return failure('ABSORPTION_FACT_DUPLICATE', `/facts/${factId}`, 'A stable fact identity has more than one canonical owner.');
        owners.add(factId);
      }
    }
    return ok(null);
  } catch {
    return failure('ABSORPTION_CANDIDATE_INVALID', '/', 'Staged absorption root validation failed.');
  }
};

const cleanupOwned = async (projectRoot, path) => {
  if (!path || !await fileState(path)) return;
  const physical = await realpath(path);
  if (!inside(projectRoot, physical)) throw new Error('Transaction path escaped project root.');
  await rm(path, { recursive: true, force: true });
};

const inspectTransitionState = async ({ phase, projectRoot, lifecycleRoot, stageRoot, backupRoot, originalFingerprint, expectedCandidate }) => {
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

const restoreFailure = async ({ lifecycleRoot, stageRoot, backupRoot }) => {
  const labels = [];
  for (const [label, path] of [['backup', backupRoot], ['live', lifecycleRoot], ['stage', stageRoot]]) {
    if (!path) continue;
    try { if (await fileState(path)) labels.push(label); } catch { labels.push(label); }
  }
  return failure('ABSORPTION_RESTORE_FAILED', '/recovery', `Recovery required; preserved artifacts: ${labels.length > 0 ? labels.join(', ') : 'unknown'}.`);
};

const reconcileOriginal = async ({ projectRoot, lifecycleRoot, stageRoot, backupRoot, originalFingerprint, expectedCandidate, restoreRename }) => {
  try {
    if (await fingerprintMatches(lifecycleRoot, originalFingerprint)) {
      await cleanupOwned(projectRoot, stageRoot);
      return { ok: true };
    }
    if (!backupRoot || !await fingerprintMatches(backupRoot, originalFingerprint)
      || !await boundedDirectory(projectRoot, backupRoot)) {
      return { ok: false, result: await restoreFailure({ lifecycleRoot, stageRoot, backupRoot }) };
    }
    if (await fileState(lifecycleRoot)) {
      const liveCandidate = await validateCandidateRoot({ lifecycleRoot, ...expectedCandidate });
      if (!liveCandidate.ok || await fileState(stageRoot)) {
        return { ok: false, result: await restoreFailure({ lifecycleRoot, stageRoot, backupRoot }) };
      }
      await rename(lifecycleRoot, stageRoot);
      const preserved = await validateCandidateRoot({ lifecycleRoot: stageRoot, ...expectedCandidate });
      if (await fileState(lifecycleRoot) || !preserved.ok) {
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

const publishCandidate = async ({ roots, originalFingerprint, map, pending, indexes, updates, operations = {}, result }) => {
  const write = operations.atomicWriteValidated ?? atomicWriteValidated;
  const publish = operations.rename ?? rename;
  const afterPublish = operations.afterPublish ?? (async () => {});
  const inspectTransition = operations.inspectTransition ?? inspectTransitionState;
  const restoreRename = operations.restoreRename ?? rename;
  const removeBackup = operations.removeBackup ?? ((path) => cleanupOwned(roots.projectRoot, path));
  let stageRoot;
  let backupRoot;
  const expectedCandidate = { expectedMap: map, expectedPending: pending, expectedIndexes: indexes };
  try {
    stageRoot = await mkdtemp(join(roots.docsRoot, '.project-lifecycle-absorption-stage-'));
    await cp(roots.lifecycleRoot, stageRoot, { recursive: true, force: false });
    for (const update of updates) {
      for (const language of LANGUAGES) {
        await write({
          root: stageRoot,
          target: update[language].locator,
          content: update[language].content,
          validate: async (source) => source === update[language].content
            ? ok(source)
            : failure('ABSORPTION_PAIR_INVALID', '/', 'Localized candidate changed during staging.'),
        });
      }
    }
    await write({
      root: stageRoot,
      target: 'project-map.json',
      content: jsonContent(map),
      validate: async (source) => {
        try { return validateJson('project-map', JSON.parse(source)); } catch { return failure('SCHEMA_INVALID', '/', 'Invalid staged project map.'); }
      },
    });
    await write({
      root: stageRoot,
      target: 'pending-changes.json',
      content: jsonContent(pending),
      validate: async (source) => {
        try { return validateJson('pending-changes', JSON.parse(source)); } catch { return failure('SCHEMA_INVALID', '/', 'Invalid staged pending changes.'); }
      },
    });
    await write({ root: stageRoot, target: 'INDEX-en.md', content: indexes.en, validate: async (source) => validateIndex(source, indexes.en, map) });
    await write({ root: stageRoot, target: 'INDEX.md', content: indexes['zh-CN'], validate: async (source) => validateIndex(source, indexes['zh-CN'], map) });
    const staged = await validateCandidateRoot({ lifecycleRoot: stageRoot, ...expectedCandidate });
    if (!staged.ok) throw Object.assign(new Error('Staged absorption candidate invalid.'), { result: staged });

    backupRoot = await mkdtemp(join(roots.docsRoot, '.project-lifecycle-absorption-backup-'));
    await rmdir(backupRoot);
    await publish(roots.lifecycleRoot, backupRoot);
    if ((await inspectTransition({ phase: 'backup-moved', projectRoot: roots.projectRoot, lifecycleRoot: roots.lifecycleRoot, stageRoot, backupRoot, originalFingerprint, expectedCandidate }))?.ok !== true) {
      throw new Error('Original transition invalid.');
    }
    await publish(stageRoot, roots.lifecycleRoot);
    if ((await inspectTransition({ phase: 'candidate-moved', projectRoot: roots.projectRoot, lifecycleRoot: roots.lifecycleRoot, stageRoot, backupRoot, originalFingerprint, expectedCandidate }))?.ok !== true) {
      throw new Error('Candidate transition invalid.');
    }
    const live = await validateCandidateRoot({ lifecycleRoot: roots.lifecycleRoot, ...expectedCandidate });
    if (!live.ok) throw Object.assign(new Error('Published absorption candidate invalid.'), { result: live });
    await afterPublish({ lifecycleRoot: roots.lifecycleRoot });

    let cleanupComplete = false;
    try { await removeBackup(backupRoot); } catch {}
    try { cleanupComplete = await fileState(backupRoot) === null; } catch {}
    stageRoot = null;
    if (!cleanupComplete) {
      return ok({ ...result, cleanup_state: 'pending', recovery_artifacts: ['backup'] });
    }
    backupRoot = null;
    return ok({ ...result, cleanup_state: 'complete' });
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
    return error?.result ?? failure('ABSORPTION_WRITE_FAILED', '/', 'Accepted Knowledge Diff could not be applied.');
  }
};

/**
 * Applies accepted fact changes under the Project Lifecycle sole-writer trust boundary.
 * Approval references are externally authoritative host inputs; this boundary binds
 * them to one validated diff, candidate pair set, baseline, and optional conflict.
 */
export async function applyKnowledgeDiff(input, operations = {}) {
  const envelope = validateEnvelope(input);
  if (!envelope.ok) return envelope;
  const diffValidation = validateJson('knowledge-diff', input.knowledge_diff);
  if (!diffValidation.ok) return diffValidation;

  let roots;
  let map;
  let pending;
  let indexes;
  let originalFingerprint;
  try {
    roots = await resolveRoots(input.root);
    [map, pending, indexes, originalFingerprint] = await Promise.all([
      readJson(join(roots.lifecycleRoot, 'project-map.json')),
      readJson(join(roots.lifecycleRoot, 'pending-changes.json')),
      Promise.all([
        readFile(join(roots.lifecycleRoot, 'INDEX-en.md'), 'utf8'),
        readFile(join(roots.lifecycleRoot, 'INDEX.md'), 'utf8'),
      ]),
      directoryFingerprint(roots.lifecycleRoot),
    ]);
  } catch (error) {
    return failure(error?.code === 'PATH_SYMLINK_ESCAPE' ? error.code : 'ABSORPTION_ROOT_INVALID', '/', 'A complete bounded lifecycle root is required.');
  }
  const mapValidation = validateJson('project-map', map);
  if (!mapValidation.ok) return mapValidation;
  const pendingValidation = validateJson('pending-changes', pending);
  if (!pendingValidation.ok) return pendingValidation;
  if (input.knowledge_diff.knowledge_baseline !== map.knowledge_baseline) {
    return failure('ABSORPTION_BASELINE_STALE', '/knowledge_diff/knowledge_baseline', 'Knowledge Diff baseline is not the latest accepted baseline.');
  }

  if (input.knowledge_diff.outcome === 'NO_CHANGE') {
    if (input.knowledge_updates.length !== 0
      || Object.hasOwn(input, 'new_baseline')
      || Object.hasOwn(input, 'approval_ref')
      || Object.hasOwn(input, 'resolution_ref')
      || Object.hasOwn(input, 'conflict_resolution')) {
      return failure('ABSORPTION_NO_CHANGE_INVALID', '/', 'NO_CHANGE cannot carry writes, approvals, resolution, or a new baseline.');
    }
    return ok({
      diff_id: input.knowledge_diff.diff_id,
      knowledge_baseline: map.knowledge_baseline,
      status: 'no-change',
    });
  }

  const requiresResolution = input.knowledge_diff.domain_changes.length > 0
    || input.knowledge_diff.operations.some(({ kind }) => ['REWRITE', 'SUPERSEDE'].includes(kind));
  const approved = isStructuredRef(input.approval_ref)
    && (!requiresResolution || isStructuredRef(input.resolution_ref));
  const supportedMutation = input.knowledge_diff.domain_changes.length === 0;
  if (!approved || !supportedMutation) {
    const nextPending = clone(pending);
    const id = conflictId(input.knowledge_diff.diff_id);
    const existing = nextPending.changes.findIndex(({ change_id: changeId }) => changeId === id);
    const candidate = pendingConflict(input.knowledge_diff, operations.now ?? (() => new Date().toISOString()));
    if (existing !== -1
      && !nextPending.changes[existing].trigger_refs.includes(`knowledge-diff:${input.knowledge_diff.diff_id}`)) {
      return failure('ABSORPTION_CONFLICT_MISMATCH', '/knowledge_diff/diff_id', 'Derived pending identity is already owned by another change.');
    }
    if (existing === -1) nextPending.changes.push(candidate);
    else candidate.created_at = nextPending.changes[existing].created_at;
    if (existing !== -1) nextPending.changes[existing] = candidate;
    nextPending.changes.sort((left, right) => compareCodePoints(left.change_id, right.change_id));
    const nextValidation = validateJson('pending-changes', nextPending);
    if (!nextValidation.ok) return nextValidation;
    return publishCandidate({
      roots,
      originalFingerprint,
      map,
      pending: nextPending,
      indexes: { en: indexes[0], 'zh-CN': indexes[1] },
      updates: [],
      operations,
      result: {
        change_id: id,
        diff_id: input.knowledge_diff.diff_id,
        knowledge_baseline: map.knowledge_baseline,
        status: 'pending-review',
      },
    });
  }

  if (!isNonEmptyString(input.new_baseline) || input.new_baseline === map.knowledge_baseline) {
    return failure('ABSORPTION_BASELINE_INVALID', '/new_baseline', 'Accepted mutation requires one exact advancing baseline reference.');
  }
  const expectedConflictId = conflictId(input.knowledge_diff.diff_id);
  const matchingPendingIndex = pending.changes.findIndex(({ change_id: id }) => id === expectedConflictId);
  if (matchingPendingIndex !== -1 && !input.conflict_resolution) {
    return failure('ABSORPTION_CONFLICT_MISMATCH', '/conflict_resolution', 'An existing pending review requires its explicit accepted resolution link.');
  }
  let resolvedConflictIndex = -1;
  if (input.conflict_resolution) {
    resolvedConflictIndex = pending.changes.findIndex(({ change_id: id }) => id === input.conflict_resolution.change_id);
    const conflict = pending.changes[resolvedConflictIndex];
    if (input.conflict_resolution.change_id !== expectedConflictId
      || !conflict
      || !conflict.trigger_refs.includes(`knowledge-diff:${input.knowledge_diff.diff_id}`)) {
      return failure('ABSORPTION_CONFLICT_MISMATCH', '/conflict_resolution/change_id', 'Pending conflict does not match this Knowledge Diff identity.');
    }
  }

  const candidateState = await validateCandidateUpdates({ lifecycleRoot: roots.lifecycleRoot, map, input });
  if (!candidateState.ok) return candidateState;
  const operationResult = validateOperations({ diff: input.knowledge_diff, candidateState: candidateState.value });
  if (!operationResult.ok) return operationResult;

  const candidateMap = clone(map);
  candidateMap.knowledge_baseline = input.new_baseline;
  for (const [domainId] of candidateState.value.updates) {
    const domain = candidateMap.domains.find(({ id }) => id === domainId);
    domain.baseline = input.new_baseline;
    domain.evidence_refs = [...new Set([...domain.evidence_refs, ...input.knowledge_diff.evidence_refs])]
      .sort(compareCodePoints);
  }
  const candidateMapValidation = validateJson('project-map', candidateMap);
  if (!candidateMapValidation.ok) return candidateMapValidation;
  const candidatePending = clone(pending);
  if (resolvedConflictIndex !== -1) candidatePending.changes.splice(resolvedConflictIndex, 1);
  const candidatePendingValidation = validateJson('pending-changes', candidatePending);
  if (!candidatePendingValidation.ok) return candidatePendingValidation;

  const overlays = Object.fromEntries(input.knowledge_updates.flatMap((update) => (
    LANGUAGES.map((language) => [update[language].locator, update[language].content])
  )));
  const generated = await generateIndexesFromRoot({ map: candidateMap, lifecycleRoot: roots.lifecycleRoot, overlays });
  if (!generated.ok) return failure('ABSORPTION_INDEX_INVALID', '/', 'Canonical indexes cannot be regenerated from the accepted candidate.');

  return publishCandidate({
    roots,
    originalFingerprint,
    map: candidateMap,
    pending: candidatePending,
    indexes: { en: generated.value.en, 'zh-CN': generated.value['zh-CN'] },
    updates: input.knowledge_updates,
    operations,
    result: {
      applied_facts: operationResult.value.appliedFacts,
      approval_ref: input.approval_ref,
      diff_id: input.knowledge_diff.diff_id,
      knowledge_baseline: input.new_baseline,
      status: 'applied',
      superseded_facts: operationResult.value.supersededFacts,
      ...(input.resolution_ref ? { resolution_ref: input.resolution_ref } : {}),
    },
  });
}
