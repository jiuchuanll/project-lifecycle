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
import { isSafeLocator, isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { generateIndexesFromRoot } from './generate-indexes.mjs';

const LANGUAGES = ['en', 'zh-CN'];
const envelopeFields = new Set([
  'root',
  'knowledge_diff',
  'new_baseline',
  'approval_receipt',
  'resolution_receipts',
  'knowledge_updates',
]);
const mutationKinds = new Set(['ADD', 'REWRITE', 'SUPERSEDE']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const clone = (value) => JSON.parse(JSON.stringify(value));
const jsonContent = (value) => `${JSON.stringify(value, null, 2)}\n`;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const contentHash = (source) => `sha256:${createHash('sha256').update(source).digest('hex')}`;
const sorted = (values) => [...new Set(values)].sort(compareCodePoints);
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : isRecord(value)
    ? Object.fromEntries(Object.keys(value).sort(compareCodePoints).map((key) => [key, canonicalize(value[key])]))
    : value;
const receiptFields = new Set(['ref', 'verified', 'candidate_commitment']);
const resolutionReceiptFields = new Set([...receiptFields, 'conflict_id', 'conflict_revision']);

const knowledgeUpdateCommitments = (updates) => updates.map((update) => ({
  domain_id: update.domain_id,
  en: { locator: update.en.locator, content_hash: update.en.content_hash },
  'zh-CN': { locator: update['zh-CN'].locator, content_hash: update['zh-CN'].content_hash },
  facts: update.facts,
})).sort((left, right) => compareCodePoints(left.domain_id, right.domain_id));

export const computeKnowledgeDiffCommitment = (input, conflicts = []) => contentHash(JSON.stringify(canonicalize({
  commitment_version: 1,
  knowledge_diff: input.knowledge_diff,
  current_baseline: input.knowledge_diff.knowledge_baseline,
  new_baseline: input.new_baseline,
  knowledge_updates: knowledgeUpdateCommitments(input.knowledge_updates),
  conflicts: conflicts.map(({ conflict_id, conflict_revision }) => ({ conflict_id, conflict_revision }))
    .sort((left, right) => compareCodePoints(left.conflict_id, right.conflict_id)),
})));

const validReceipt = (receipt, fields = receiptFields) => isRecord(receipt)
  && Object.keys(receipt).length === fields.size
  && Object.keys(receipt).every((field) => fields.has(field))
  && isSafeReference(receipt.ref)
  && /^[a-z][a-z0-9-]*:/u.test(receipt.ref)
  && receipt.verified === true
  && /^sha256:[0-9a-f]{64}$/u.test(receipt.candidate_commitment ?? '');

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
  if (Object.hasOwn(input, 'approval_receipt') && !validReceipt(input.approval_receipt)) {
    return failure('ABSORPTION_APPROVAL_INVALID', '/approval_receipt', 'Approval receipt must be a closed externally verified candidate binding.');
  }
  if (Object.hasOwn(input, 'resolution_receipts')
    && (!Array.isArray(input.resolution_receipts)
      || input.resolution_receipts.length === 0
      || input.resolution_receipts.some((receipt) => !validReceipt(receipt, resolutionReceiptFields)
        || !/^[a-z][a-z0-9-]*$/u.test(receipt.conflict_id ?? '')
        || !Number.isInteger(receipt.conflict_revision)
        || receipt.conflict_revision < 1))) {
    return failure('ABSORPTION_CONFLICT_MISMATCH', '/resolution_receipts', 'Resolution receipts must bind exact pending conflict identities and revisions.');
  }
  return ok(null);
};

const validateSafeInputs = (input) => {
  const refs = [
    input.knowledge_diff.knowledge_baseline,
    ...(Object.hasOwn(input, 'new_baseline') ? [input.new_baseline] : []),
    ...input.knowledge_diff.entry_points,
    ...input.knowledge_diff.evidence_refs,
    ...input.knowledge_diff.operations.flatMap(({ evidence_refs: evidence }) => evidence),
    ...input.knowledge_diff.domain_changes.flatMap((change) => [
      ...change.evidence_refs,
      ...(change.relationship_refs ?? []),
    ]),
  ];
  if (refs.some((reference) => !isSafeReference(reference))) {
    return failure('ABSORPTION_REFERENCE_INVALID', '/', 'Knowledge absorption contains an unsafe reference value.');
  }
  for (const update of input.knowledge_updates) {
    for (const language of LANGUAGES) {
      if (update?.[language]?.locator !== undefined && !isSafeLocator(update[language].locator)) {
        return failure('ABSORPTION_REFERENCE_INVALID', '/knowledge_updates', 'Knowledge absorption contains an unsafe locator.');
      }
    }
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

const factUnitPattern = /^### `([^`\n]+)`\n(?:\n)*<!-- project-lifecycle:fact\n[\s\S]*?<!-- \/project-lifecycle:fact -->(?:\n)*/gmu;
const factUnits = (document) => {
  const units = new Map();
  for (const match of document.source.matchAll(factUnitPattern)) units.set(match[1], match[0]);
  return units.size === document.facts.length ? ok(units) : failure(
    'ABSORPTION_CHANGE_NOT_BOUNDED',
    '/',
    'Every fact block must have one exact fact identity heading.',
  );
};
const normalizeMachine = (source) => source
  .replace(/last_verified_baseline: [^\n]+/u, 'last_verified_baseline: <baseline>')
  .replace(/implementation_refs: [^\n]+/u, 'implementation_refs: <implementation-refs>');
const documentFrame = (document, identityMap = new Map(), omitted = new Set()) => normalizeMachine(document.source.replace(
  factUnitPattern,
  (_unit, factId) => omitted.has(factId) ? '' : `<!-- fact-unit:${identityMap.get(factId) ?? factId} -->\n`,
));

const validateCandidateUpdates = async ({ lifecycleRoot, map, input }) => {
  const updates = new Map();
  const currentDocuments = new Map();
  const currentFactOwners = new Map();

  for (const domain of map.domains.filter(({ domain_state: state }) => state === 'materialized')) {
    if (!domain.paired_assets || !domain.baseline) {
      return failure('ABSORPTION_OWNER_MISMATCH', `/domains/${domain.id}`, 'Every current fact owner requires one canonical bilingual asset.');
    }
    const currentPair = await validateBilingualPair(
      join(lifecycleRoot, domain.paired_assets.en),
      join(lifecycleRoot, domain.paired_assets['zh-CN']),
      map,
    );
    if (!currentPair.ok) return currentPair;
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
    seenDomains.add(domain.id);
    updates.set(domain.id, { update, parsed, current });
  }

  return ok({ updates, currentDocuments, currentFactOwners });
};

const validateOperations = ({ diff, candidateState }) => {
  const evidenceUnion = sorted([
    ...diff.operations.flatMap(({ evidence_refs: refs }) => refs),
    ...diff.domain_changes.flatMap(({ evidence_refs: refs }) => refs),
  ]);
  if (!same(diff.evidence_refs, evidenceUnion)) {
    return failure('ABSORPTION_EVIDENCE_REQUIRED', '/knowledge_diff/evidence_refs', 'Knowledge Diff evidence must equal the deterministic union of declared change evidence.');
  }
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
      if (!same(added.evidence_refs, operation.evidence_refs)) {
        return failure('ABSORPTION_EVIDENCE_REQUIRED', `${path}/evidence_refs`, 'Added fact evidence must exactly match its declared operation evidence.');
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
      if (!same(rewritten.evidence_refs, operation.evidence_refs)) {
        return failure('ABSORPTION_EVIDENCE_REQUIRED', `${path}/evidence_refs`, 'Rewritten fact evidence must exactly match its declared operation evidence.');
      }
      if (same(
        { statement: canonical.fact.statement, known_limits: canonical.fact.known_limits },
        { statement: rewritten.statement, known_limits: rewritten.known_limits },
      )) {
        return failure('ABSORPTION_CHANGE_NOT_BOUNDED', `${path}/fact_id`, 'REWRITE requires a substantive fact payload change.');
      }
      for (const language of LANGUAGES) {
        const localizedBefore = ownerUpdate.current[language].facts.find(({ fact_id: id }) => id === operation.fact_id);
        const localizedAfter = ownerUpdate.parsed[language].facts.find(({ fact_id: id }) => id === operation.fact_id);
        if (same(
          { statement: localizedBefore?.statement, known_limits: localizedBefore?.known_limits },
          { statement: localizedAfter?.statement, known_limits: localizedAfter?.known_limits },
        )) {
          return failure('ABSORPTION_CHANGE_NOT_BOUNDED', `${path}/fact_id`, 'Every localized REWRITE requires a substantive fact payload change.');
        }
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
      if (!same(successor.evidence_refs, operation.evidence_refs)) {
        return failure('ABSORPTION_EVIDENCE_REQUIRED', `${path}/evidence_refs`, 'Successor evidence must exactly match its declared operation evidence.');
      }
      if (same(
        { statement: canonical.fact.statement, known_limits: canonical.fact.known_limits },
        { statement: successor.statement, known_limits: successor.known_limits },
      )) {
        return failure('ABSORPTION_CHANGE_NOT_BOUNDED', `${path}/successor_fact_id`, 'SUPERSEDE requires a substantive successor payload.');
      }
      for (const language of LANGUAGES) {
        const localizedBefore = ownerUpdate.current[language].facts.find(({ fact_id: id }) => id === operation.fact_id);
        const localizedAfter = ownerUpdate.parsed[language].facts.find(({ fact_id: id }) => id === operation.successor_fact_id);
        if (same(
          { statement: localizedBefore?.statement, known_limits: localizedBefore?.known_limits },
          { statement: localizedAfter?.statement, known_limits: localizedAfter?.known_limits },
        )) {
          return failure('ABSORPTION_CHANGE_NOT_BOUNDED', `${path}/successor_fact_id`, 'Every localized SUPERSEDE requires a substantive successor payload.');
        }
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
    const domainOperations = diff.operations.filter(({ owner_domain_id: owner }) => owner === domainId);
    for (const language of LANGUAGES) {
      const beforeUnits = factUnits(ownerUpdate.current[language]);
      const afterUnits = factUnits(ownerUpdate.parsed[language]);
      if (!beforeUnits.ok || !afterUnits.ok) return beforeUnits.ok ? afterUnits : beforeUnits;
      const additions = new Set(domainOperations.filter(({ kind }) => kind === 'ADD').map(({ fact_id: id }) => id));
      const identityMap = new Map(domainOperations
        .filter(({ kind }) => kind === 'SUPERSEDE')
        .map(({ fact_id: id, successor_fact_id: successor }) => [successor, id]));
      if (documentFrame(ownerUpdate.current[language])
        !== documentFrame(ownerUpdate.parsed[language], identityMap, additions)) {
        return failure('ABSORPTION_CHANGE_NOT_BOUNDED', `/knowledge_updates/${domainId}/${language}`, 'Knowledge Diff changed document structure or unrelated prose.');
      }
      for (const [factId, unit] of beforeUnits.value) {
        if (operatedBefore.has(factId)) continue;
        if (normalizeMachine(unit) !== normalizeMachine(afterUnits.value.get(factId) ?? '')) {
          return failure('ABSORPTION_CHANGE_NOT_BOUNDED', `/knowledge_updates/${domainId}/${language}/${factId}`, 'An undeclared fact unit changed.');
        }
      }
    }
  }
  return ok({ appliedFacts, supersededFacts });
};

const footprintForDiff = (diff) => ({
  domains: new Set([
    ...diff.operations.map(({ owner_domain_id: id }) => id),
    ...diff.domain_changes.map(({ domain_id: id }) => id),
  ]),
  facts: new Set(diff.operations.flatMap(({ fact_id: id, successor_fact_id: successor }) => [id, ...(successor ? [successor] : [])])),
  owners: new Set(diff.operations.map(({ owner_domain_id: id }) => id)),
  constraints: new Set(diff.domain_changes.flatMap(({ relationship_refs: refs = [] }) => refs.filter((ref) => ref.startsWith('constraint:')))),
  relationships: new Set(diff.domain_changes.flatMap(({ relationship_refs: refs = [] }) => refs)),
  topology: new Set(diff.domain_changes.map(({ domain_id: id }) => id)),
});

const targetKeysForDiff = (diff) => sorted([
  ...diff.operations.map(({ fact_id: id }) => `fact:${id}`),
  ...diff.domain_changes.map(({ domain_id: id }) => `topology:${id}`),
]);
const conflictIdForTarget = (target) => `absorption-${target.replace(':', '-')}`;
const intersects = (left, right) => [...left].some((value) => right.has(value));

const footprintForPending = (change, map) => {
  if (change.absorption_version === 1) return {
    domains: new Set(change.affected_domain_ids),
    facts: new Set(change.affected_fact_ids),
    owners: new Set(change.affected_owner_ids),
    constraints: new Set(change.constraint_refs),
    relationships: new Set(change.relationship_refs),
    topology: new Set(change.topology_target_ids),
  };
  const footprint = {
    domains: new Set(),
    facts: new Set(),
    owners: new Set(),
    constraints: new Set(),
    relationships: new Set(),
    topology: new Set(),
  };
  const domainIds = new Set(map.domains.map(({ id }) => id));
  const constraintIds = new Set(map.constraints.map(({ id }) => id));
  const addRawId = (id) => {
    // Legacy and governed Task 4 records use raw IDs in affected_refs. Treat an
    // untyped raw ID conservatively as a possible fact, then enrich it from the
    // accepted map so ownership/topology and constraint conflicts cannot hide.
    footprint.facts.add(id);
    if (domainIds.has(id)) {
      footprint.domains.add(id);
      footprint.owners.add(id);
      footprint.topology.add(id);
    }
    if (constraintIds.has(id)) footprint.constraints.add(`constraint:${id}`);
  };
  const addRef = (ref) => {
    const separator = ref.indexOf(':');
    if (separator === -1) {
      addRawId(ref);
      return;
    }
    const kind = ref.slice(0, separator);
    const id = ref.slice(separator + 1);
    if (kind === 'domain') footprint.domains.add(id);
    else if (kind === 'fact') footprint.facts.add(id);
    else if (kind === 'owner') footprint.owners.add(id);
    else if (kind === 'constraint') footprint.constraints.add(ref);
    else if (kind === 'relationship') footprint.relationships.add(ref);
    else if (kind === 'topology') footprint.topology.add(id);
  };

  for (const ref of change.affected_refs ?? []) addRef(ref);
  if (change.semantic_target_key) addRef(change.semantic_target_key);

  const patch = change.proposed_patch;
  if (patch?.target_type === 'domain') {
    footprint.domains.add(patch.target_id);
    footprint.topology.add(patch.target_id);
  } else if (patch?.target_type === 'constraint' || patch?.target_type === 'exception') {
    footprint.constraints.add(`constraint:${patch.target_id}`);
  } else if (patch?.target_type === 'relationship') {
    footprint.relationships.add(change.semantic_target_key ?? `relationship:${patch.target_id}`);
  }

  for (const disposition of change.child_dispositions ?? []) {
    footprint.domains.add(disposition.domain_id);
    footprint.topology.add(disposition.domain_id);
    for (const factId of disposition.unresolved_fact_ids ?? []) footprint.facts.add(factId);
  }
  for (const commitment of change.knowledge_commitments ?? []) {
    footprint.domains.add(commitment.domain_id);
    footprint.owners.add(commitment.domain_id);
    for (const fact of commitment.facts ?? []) footprint.facts.add(fact.fact_id);
  }
  return footprint;
};

const footprintsOverlap = (left, right) => ['domains', 'facts', 'owners', 'constraints', 'relationships', 'topology']
  .some((field) => intersects(left[field], right[field]));

const pendingEntry = ({ diff, newBaseline, target, revision, commitment, openedAt }) => {
  const footprint = footprintForDiff(diff);
  const relationships = sorted([...footprint.relationships]);
  return {
    absorption_version: 1,
    change_id: conflictIdForTarget(target),
    semantic_target_key: target,
    conflict_revision: revision,
    candidate_commitment: commitment,
    diff_id: diff.diff_id,
    owner_delivery_id: diff.owner_delivery_id,
    knowledge_baseline: diff.knowledge_baseline,
    new_baseline: newBaseline,
    operations: clone(diff.operations),
    affected_domain_ids: sorted([...footprint.domains]),
    affected_fact_ids: sorted([...footprint.facts]),
    affected_owner_ids: sorted([...footprint.owners]),
    constraint_refs: sorted([...footprint.constraints]),
    relationship_refs: relationships,
    topology_target_ids: sorted([...footprint.topology]),
    evidence_refs: clone(diff.evidence_refs),
    risks: ['Current accepted knowledge remains unchanged until explicit resolution.'],
    evidence_gaps: ['Exact externally verified conflict resolution is unresolved.'],
    review_state: 'open',
    opened_at: openedAt,
  };
};

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
    await cp(roots.lifecycleRoot, stageRoot, { recursive: true, force: false, verbatimSymlinks: true });
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
 * The host authenticates receipt refs and the `verified` authority precondition.
 * This local boundary proves only that each receipt binds the exact validated diff,
 * bilingual candidate hashes/summaries, baselines, and conflict revision(s); it does
 * not authenticate a human identity or infer approval from delivery completion.
 */
export async function applyKnowledgeDiff(input, operations = {}) {
  const envelope = validateEnvelope(input);
  if (!envelope.ok) return envelope;
  const diffValidation = validateJson('knowledge-diff', input.knowledge_diff);
  if (!diffValidation.ok) return diffValidation;
  const safeInputs = validateSafeInputs(input);
  if (!safeInputs.ok) return safeInputs;

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
      || Object.hasOwn(input, 'approval_receipt')
      || Object.hasOwn(input, 'resolution_receipts')) {
      return failure('ABSORPTION_NO_CHANGE_INVALID', '/', 'NO_CHANGE cannot carry writes, approvals, resolution, or a new baseline.');
    }
    return ok({
      diff_id: input.knowledge_diff.diff_id,
      knowledge_baseline: map.knowledge_baseline,
      status: 'no-change',
    });
  }

  if (!isNonEmptyString(input.new_baseline) || input.new_baseline === map.knowledge_baseline) {
    return failure('ABSORPTION_BASELINE_INVALID', '/new_baseline', 'Accepted mutation requires one exact advancing baseline reference.');
  }

  const candidateState = await validateCandidateUpdates({ lifecycleRoot: roots.lifecycleRoot, map, input });
  if (!candidateState.ok) return candidateState;
  const operationResult = validateOperations({ diff: input.knowledge_diff, candidateState: candidateState.value });
  if (!operationResult.ok) return operationResult;

  const incomingFootprint = footprintForDiff(input.knowledge_diff);
  const overlappingPending = pending.changes.filter((change) => footprintsOverlap(incomingFootprint, footprintForPending(change, map)));
  const revalidationOverlap = (map.revalidation_required ?? []).some((marker) => (
    incomingFootprint.domains.has(marker.domain_id)
      || (marker.fact_id && incomingFootprint.facts.has(marker.fact_id))
      || (marker.constraint_id && incomingFootprint.constraints.has(`constraint:${marker.constraint_id}`))
  ));
  const requiresResolution = input.knowledge_diff.domain_changes.length > 0
    || input.knowledge_diff.operations.some(({ kind }) => ['REWRITE', 'SUPERSEDE'].includes(kind))
    || overlappingPending.length > 0
    || revalidationOverlap;
  const targetKeys = targetKeysForDiff(input.knowledge_diff);
  const existingByTarget = new Map(pending.changes
    .filter(({ absorption_version: version }) => version === 1)
    .map((change) => [change.semantic_target_key, change]));
  const existingTargets = targetKeys.map((target) => existingByTarget.get(target)).filter(Boolean);
  const bindings = existingTargets.map((change) => ({
    conflict_id: change.change_id,
    conflict_revision: change.conflict_revision,
  }));
  const existingCommitment = bindings.length === targetKeys.length
    ? computeKnowledgeDiffCommitment(input, bindings)
    : null;
  const exactExisting = existingTargets.length === targetKeys.length
    && existingTargets.every((change) => change.diff_id === input.knowledge_diff.diff_id
      && change.knowledge_baseline === map.knowledge_baseline
      && change.new_baseline === input.new_baseline
      && change.candidate_commitment === existingCommitment);

  if (requiresResolution && !exactExisting) {
    if ((input.resolution_receipts ?? []).length > 0) {
      return failure('ABSORPTION_CONFLICT_MISMATCH', '/resolution_receipts', 'A stale resolution receipt cannot refresh or resolve a changed candidate.');
    }
    const nextPending = clone(pending);
    const nextBindings = [];
    const candidates = [];
    const openedAt = (operations.now ?? (() => new Date().toISOString()))();
    for (const target of targetKeys) {
      const id = conflictIdForTarget(target);
      const index = nextPending.changes.findIndex(({ change_id: changeId }) => changeId === id);
      const prior = index === -1 ? null : nextPending.changes[index];
      if (prior && prior.absorption_version !== 1) {
        return failure('ABSORPTION_CONFLICT_MISMATCH', '/knowledge_diff', 'Derived absorption conflict identity is already owned by another pending contract.');
      }
      const revision = (prior?.conflict_revision ?? 0) + 1;
      nextBindings.push({ conflict_id: id, conflict_revision: revision });
      candidates.push({ target, id, index, prior, revision });
    }
    const commitment = computeKnowledgeDiffCommitment(input, nextBindings);
    for (const candidate of candidates) {
      const entry = pendingEntry({
        diff: input.knowledge_diff,
        newBaseline: input.new_baseline,
        target: candidate.target,
        revision: candidate.revision,
        commitment,
        openedAt: candidate.prior?.opened_at ?? openedAt,
      });
      if (candidate.index === -1) nextPending.changes.push(entry);
      else nextPending.changes[candidate.index] = entry;
    }
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
        conflicts: nextBindings.map((binding) => ({ ...binding, candidate_commitment: commitment })),
        diff_id: input.knowledge_diff.diff_id,
        knowledge_baseline: map.knowledge_baseline,
        status: 'pending-review',
      },
    });
  }

  if (requiresResolution) {
    const receipts = input.resolution_receipts ?? [];
    const exactReceipts = bindings.length === receipts.length && bindings.every((binding) => receipts.some((receipt) => (
      receipt.conflict_id === binding.conflict_id
        && receipt.conflict_revision === binding.conflict_revision
        && receipt.candidate_commitment === existingCommitment
        && receipt.verified === true
    )));
    const externalOverlap = overlappingPending.some(({ absorption_version: version, semantic_target_key: target }) => (
      version !== 1 || !targetKeys.includes(target)
    ));
    if (!exactReceipts || externalOverlap || revalidationOverlap) {
      if (receipts.length > 0) {
        return failure('ABSORPTION_CONFLICT_MISMATCH', '/resolution_receipts', 'Resolution receipt does not bind every exact current pending conflict.');
      }
      return ok({
        conflicts: bindings.map((binding) => ({ ...binding, candidate_commitment: existingCommitment })),
        diff_id: input.knowledge_diff.diff_id,
        knowledge_baseline: map.knowledge_baseline,
        status: 'pending-review',
      });
    }
  } else {
    const directCommitment = computeKnowledgeDiffCommitment(input);
    if (!input.approval_receipt
      || input.approval_receipt.candidate_commitment !== directCommitment
      || input.approval_receipt.verified !== true) {
      return failure('ABSORPTION_APPROVAL_INVALID', '/approval_receipt', 'Current knowledge creation requires an exact externally verified candidate receipt.');
    }
  }

  if (input.knowledge_diff.domain_changes.length > 0) {
    return failure('ABSORPTION_CONFLICT_MISMATCH', '/knowledge_diff/domain_changes', 'Topology and ownership changes require the governed topology applier.');
  }

  const candidateMap = clone(map);
  candidateMap.knowledge_baseline = input.new_baseline;
  for (const [domainId] of candidateState.value.updates) {
    const domain = candidateMap.domains.find(({ id }) => id === domainId);
    domain.baseline = input.new_baseline;
    const attributed = input.knowledge_diff.operations
      .filter(({ owner_domain_id: owner }) => owner === domainId)
      .flatMap(({ evidence_refs: refs }) => refs);
    domain.evidence_refs = sorted([...domain.evidence_refs, ...attributed]);
  }
  const candidateMapValidation = validateJson('project-map', candidateMap);
  if (!candidateMapValidation.ok) return candidateMapValidation;
  const candidatePending = clone(pending);
  if (requiresResolution) {
    candidatePending.changes = candidatePending.changes.filter(({ semantic_target_key: target }) => !targetKeys.includes(target));
  }
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
      diff_id: input.knowledge_diff.diff_id,
      knowledge_baseline: input.new_baseline,
      status: 'applied',
      superseded_facts: operationResult.value.supersededFacts,
      ...(requiresResolution
        ? { resolution_refs: input.resolution_receipts.map(({ ref }) => ref) }
        : { approval_ref: input.approval_receipt.ref }),
    },
  });
}
