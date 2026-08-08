import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { atomicWriteValidated } from '../lib/atomic-write.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseFactBlocks } from '../lib/fact-blocks.mjs';
import { parseFrontmatter } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { analyzeImpact, hashProjectMap } from './impact.mjs';

const proposalFailure = (code, path, message) => fail([createError(code, path, message)]);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const jsonContent = (value) => `${JSON.stringify(value, null, 2)}\n`;
const exactSet = (left, right) => JSON.stringify([...new Set(left)].sort(compareCodePoints))
  === JSON.stringify([...new Set(right)].sort(compareCodePoints));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const knowledgeBearingDomainKeys = new Set([
  'baseline',
  'evidence_refs',
  'known_gaps',
  'purpose',
  'scope',
]);
const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

const resolveLifecycleRoot = async (inputRoot) => {
  if (!isAbsolute(inputRoot)) throw Object.assign(new Error('Absolute root required.'), { code: 'CHANGE_ROOT_INVALID' });
  const lexicalRoot = resolve(inputRoot);
  const lexicalState = await lstat(lexicalRoot);
  if (!lexicalState.isDirectory() || lexicalState.isSymbolicLink()) {
    throw Object.assign(new Error('Regular root required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  const root = await realpath(lexicalRoot);
  const lifecycleRoot = await resolveInside(root, 'docs/project-lifecycle');
  const state = await lstat(lifecycleRoot);
  const physical = await realpath(lifecycleRoot);
  if (!state.isDirectory() || state.isSymbolicLink() || !inside(root, physical)) {
    throw Object.assign(new Error('Bounded lifecycle root required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  return physical;
};

const canonicalDisposition = (entry) => ({
  ...entry,
  evidence_refs: [...entry.evidence_refs].sort(compareCodePoints),
  unresolved_fact_ids: [...entry.unresolved_fact_ids].sort(compareCodePoints),
});

const canonicalChange = (change, map, candidateMap, knowledgeCommitments) => {
  const {
    candidate_map: _candidateMap,
    knowledge_candidates: _knowledgeCandidates,
    knowledge_commitments: _knowledgeCommitments,
    review_state: _reviewState,
    proposal_version: _proposalVersion,
    baseline: _baseline,
    ...source
  } = change;
  return {
    ...source,
    trigger_refs: [...source.trigger_refs].sort(compareCodePoints),
    source_refs: [...source.source_refs].sort(compareCodePoints),
    affected_refs: [...source.affected_refs].sort(compareCodePoints),
    risks: [...source.risks],
    evidence_gaps: [...source.evidence_gaps],
    review_state: 'open',
    proposal_version: 1,
    baseline: { map_hash: hashProjectMap(map) },
    proposed_patch: {
      ...source.proposed_patch,
      changed_fields: [...source.proposed_patch.changed_fields].sort(compareCodePoints),
      candidate_map_hash: hashProjectMap(candidateMap),
      new_ids: [...source.proposed_patch.new_ids].sort(compareCodePoints),
      successor_ids: [...source.proposed_patch.successor_ids].sort(compareCodePoints),
    },
    child_dispositions: [...source.child_dispositions]
      .map(canonicalDisposition)
      .sort((left, right) => compareCodePoints(left.domain_id, right.domain_id)),
    knowledge_commitments: knowledgeCommitments,
  };
};

const validateProposalInput = (root, change) => {
  if (typeof root !== 'string' || !isAbsolute(root) || !isRecord(change)
    || !isRecord(change.candidate_map)
    || !isRecord(change.proposed_patch)
    || !Array.isArray(change.child_dispositions)
    || !isNonEmptyString(change.semantic_target_key)
    || !isNonEmptyString(change.change_id)
    || !isNonEmptyString(change.kind)
    || !isNonEmptyString(change.change_class)
    || !isNonEmptyString(change.proposed_disposition)
    || !isNonEmptyString(change.created_at)
    || !isNonEmptyString(change.proposed_patch.operation)
    || !isNonEmptyString(change.proposed_patch.target_type)
    || !isNonEmptyString(change.proposed_patch.target_id)
    || !Array.isArray(change.proposed_patch.changed_fields)
    || !Array.isArray(change.proposed_patch.new_ids)
    || !Array.isArray(change.proposed_patch.successor_ids)
    || !Array.isArray(change.trigger_refs)
    || !Array.isArray(change.source_refs)
    || !Array.isArray(change.affected_refs)
    || !Array.isArray(change.risks)
    || !Array.isArray(change.evidence_gaps)) {
    return proposalFailure('CHANGE_INPUT_INVALID', '/arguments', 'A bounded semantic proposal and complete candidate map are required.');
  }
  if (change.knowledge_candidates !== undefined && !Array.isArray(change.knowledge_candidates)) {
    return proposalFailure('CHANGE_INPUT_INVALID', '/knowledge_candidates', 'Knowledge candidates must be a bounded array.');
  }
  return ok(null);
};

const targetTypesByOperation = {
  ADD_CONSTRAINT: 'constraint',
  ADD_DOMAIN: 'domain',
  ADD_EXCEPTION: 'exception',
  ADD_RELATIONSHIP: 'relationship',
  MERGE_DOMAIN: 'domain',
  REPLACE_CONSTRAINT: 'constraint',
  UPDATE_CONSTRAINT: 'constraint',
  UPDATE_DOMAIN: 'domain',
};

const validateProposalMetadata = (change, currentMap, candidateMap, impact) => {
  const patch = change.proposed_patch;
  const expectedTargetType = targetTypesByOperation[patch.operation];
  const targetKey = patch.target_type === 'relationship'
    ? `relationship:${patch.target_id}:${impact.value.horizontal_target_ids[0] ?? ''}`
    : `${patch.target_type}:${patch.target_id}`;
  if (expectedTargetType !== patch.target_type
    || change.semantic_target_key !== targetKey) {
    return proposalFailure(
      'CHANGE_PROPOSAL_MISMATCH',
      '/proposed_patch',
      'Proposal routing metadata must identify the reviewed candidate target.',
    );
  }

  const candidateConstraint = candidateMap.constraints.find(({ id }) => id === patch.target_id);
  if (change.change_class === 'SEMANTIC'
    && patch.operation === 'UPDATE_CONSTRAINT'
    && patch.expected_semantic_revision !== candidateConstraint?.semantic_revision) {
    return proposalFailure(
      'CHANGE_PROPOSAL_MISMATCH',
      '/proposed_patch/expected_semantic_revision',
      'The declared semantic revision must match the reviewed candidate.',
    );
  }

  const expectedNewIds = patch.operation === 'ADD_CONSTRAINT'
    ? [patch.target_id]
    : patch.operation === 'REPLACE_CONSTRAINT'
      ? [...(candidateConstraint?.successor_ids ?? [])].sort(compareCodePoints)
      : [];
  const declaredNewIds = [...patch.new_ids].sort(compareCodePoints);
  const declaredSuccessors = [...patch.successor_ids].sort(compareCodePoints);
  if (JSON.stringify(declaredNewIds) !== JSON.stringify(expectedNewIds)
    || JSON.stringify(declaredSuccessors) !== JSON.stringify(
      patch.operation === 'REPLACE_CONSTRAINT' ? expectedNewIds : [],
    )) {
    return proposalFailure(
      'CHANGE_PROPOSAL_MISMATCH',
      '/proposed_patch/new_ids',
      'New and successor identities must match the reviewed candidate.',
    );
  }

  const requiredRefs = [...new Set([patch.target_id, ...impact.value.affected_domain_ids])].sort(compareCodePoints);
  if (JSON.stringify(requiredRefs) !== JSON.stringify([...change.affected_refs].sort(compareCodePoints))) {
    return proposalFailure(
      'CHANGE_PROPOSAL_MISMATCH',
      '/affected_refs',
      'Affected references must cover the reviewed target and impact set.',
    );
  }
  const ownerId = candidateConstraint?.owner_id
    ?? currentMap.constraints.find(({ id }) => id === patch.target_id)?.owner_id;
  const requiredDispositions = patch.operation === 'MERGE_DOMAIN'
    ? currentMap.domains
      .filter(({ parent_id: parentId, domain_state: state }) => (
        parentId === patch.target_id && ['confirmed', 'materialized'].includes(state)
      ))
      .map(({ id }) => id)
    : patch.target_type === 'constraint' || patch.target_type === 'exception'
      ? impact.value.affected_domain_ids.filter((id) => id !== ownerId)
      : impact.value.requires_descendant_review
        ? impact.value.lineage_descendant_ids
        : [];
  if (change.child_dispositions.some(({ domain_id: id }) => !requiredDispositions.includes(id))) {
    return proposalFailure(
      'CHANGE_PROPOSAL_MISMATCH',
      '/child_dispositions',
      'Reviewed child dispositions cannot include domains outside the semantic impact.',
    );
  }
  return ok(null);
};

const contentHash = (source) => `sha256:${createHash('sha256').update(source).digest('hex')}`;

const deriveKnowledgeCommitments = async (change, currentMap, candidateMap, impact, lifecycleRoot) => {
  const commitments = [];
  const contentChanges = new Map();
  const seen = new Set();
  for (const [index, candidate] of (change.knowledge_candidates ?? []).entries()) {
    const domain = candidateMap.domains.find(({ id }) => id === candidate?.domain_id);
    if (!domain?.paired_assets || seen.has(candidate.domain_id)
      || !impact.value.affected_domain_ids.includes(candidate.domain_id)) {
      return proposalFailure('CHANGE_KNOWLEDGE_COMMITMENT_INVALID', `/knowledge_candidates/${index}`, 'Knowledge candidate must target one affected canonical domain.');
    }
    seen.add(candidate.domain_id);
    const parsed = {};
    for (const language of ['en', 'zh-CN']) {
      const localized = candidate[language];
      if (!isRecord(localized) || localized.locator !== domain.paired_assets[language]
        || !isNonEmptyString(localized.content)) {
        return proposalFailure('CHANGE_KNOWLEDGE_COMMITMENT_INVALID', `/knowledge_candidates/${index}/${language}`, 'Both exact canonical localized candidates are required.');
      }
      const frontmatter = parseFrontmatter(localized.content);
      const facts = parseFactBlocks(localized.content);
      if (!frontmatter.ok || !facts.ok || frontmatter.value.data.id !== candidate.domain_id) {
        return proposalFailure('CHANGE_KNOWLEDGE_COMMITMENT_INVALID', `/knowledge_candidates/${index}/${language}`, 'Knowledge candidate machine fields are invalid.');
      }
      parsed[language] = { frontmatter: frontmatter.value.data, facts: facts.value };
      let currentFacts;
      try {
        const currentPath = await resolveInside(lifecycleRoot, localized.locator);
        const currentSource = await readFile(currentPath, 'utf8');
        const current = parseFactBlocks(currentSource);
        if (!current.ok) throw new Error('invalid current facts');
        currentFacts = current.value;
        // Scripts bind bytes and bilingual structure; Agent/human review owns semantic
        // equivalence between the changed prose and the proposed map meaning.
        parsed[language].content_changed = contentHash(currentSource) !== contentHash(localized.content);
      } catch {
        return proposalFailure('CHANGE_KNOWLEDGE_COMMITMENT_INVALID', `/knowledge_candidates/${index}/${language}`, 'Current canonical knowledge is unavailable.');
      }
      if (!exactFactEvolution(currentFacts, facts.value)) {
        return proposalFailure('CHANGE_KNOWLEDGE_FACT_REVISION_STALE', `/knowledge_candidates/${index}/${language}/facts`, 'Changed facts must preserve identity and increment exactly one revision.');
      }
    }
    const summary = parsed.en.facts.map((fact) => ({
      fact_id: fact.fact_id,
      fact_revision: fact.revision,
      knowledge_state: parsed.en.frontmatter.knowledge_state,
    })).sort((left, right) => compareCodePoints(left.fact_id, right.fact_id));
    const chineseSummary = parsed['zh-CN'].facts.map((fact) => ({
      fact_id: fact.fact_id,
      fact_revision: fact.revision,
      knowledge_state: parsed['zh-CN'].frontmatter.knowledge_state,
    })).sort((left, right) => compareCodePoints(left.fact_id, right.fact_id));
    if (JSON.stringify(summary) !== JSON.stringify(chineseSummary)) {
      return proposalFailure('CHANGE_KNOWLEDGE_COMMITMENT_INVALID', `/knowledge_candidates/${index}/facts`, 'Bilingual fact identity, revision, and state must match.');
    }
    contentChanges.set(
      candidate.domain_id,
      parsed.en.content_changed && parsed['zh-CN'].content_changed,
    );
    commitments.push({
      domain_id: candidate.domain_id,
      en: { locator: candidate.en.locator, content_hash: contentHash(candidate.en.content) },
      'zh-CN': { locator: candidate['zh-CN'].locator, content_hash: contentHash(candidate['zh-CN'].content) },
      facts: summary,
    });
  }
  commitments.sort((left, right) => compareCodePoints(left.domain_id, right.domain_id));
  if (change.proposed_patch.target_type === 'domain') {
    const required = currentMap.domains.filter((currentDomain) => {
      if (currentDomain.domain_state !== 'materialized') return false;
      const candidateDomain = candidateMap.domains.find(({ id }) => id === currentDomain.id);
      if (!candidateDomain) return false;
      const keys = new Set([...Object.keys(currentDomain), ...Object.keys(candidateDomain)]);
      return [...keys].some((key) => (
        knowledgeBearingDomainKeys.has(key) && !same(currentDomain[key], candidateDomain[key])
      ));
    }).map(({ id }) => id).sort(compareCodePoints);
    if (!exactSet([...seen], required)) {
      return proposalFailure(
        'CHANGE_KNOWLEDGE_COMMITMENT_REQUIRED',
        '/knowledge_candidates',
        'Every changed materialized domain requires exactly one reviewed bilingual knowledge candidate.',
      );
    }
    for (const domainId of required) {
      const index = (change.knowledge_candidates ?? []).findIndex(({ domain_id: id }) => id === domainId);
      const candidate = change.knowledge_candidates[index];
      const commitment = commitments.find(({ domain_id: id }) => id === domainId);
      if (!candidate || !commitment
        || !contentChanges.get(domainId)) {
        return proposalFailure(
          'CHANGE_KNOWLEDGE_COMMITMENT_UNCHANGED',
          `/knowledge_candidates/${index < 0 ? 0 : index}`,
          'A semantic domain update must change both reviewed localized knowledge assets.',
        );
      }
    }
  }
  return ok(commitments);
};

const validateReviewedMarkers = (change, currentMap, candidateMap) => {
  const isConstraint = ['constraint', 'exception'].includes(change.proposed_patch.target_type);
  const current = isConstraint
    ? currentMap.constraints.find(({ id }) => id === change.proposed_patch.target_id)
    : null;
  const candidate = isConstraint
    ? candidateMap.constraints.find(({ id }) => id === change.proposed_patch.target_id)
    : null;
  const hasUnresolved = change.child_dispositions.some(({ unresolved_fact_ids: ids }) => ids.length > 0);
  if (isConstraint && hasUnresolved
    && (!current || !candidate || candidate.semantic_revision <= current.semantic_revision)) {
    return proposalFailure('CHANGE_REVALIDATION_MISMATCH', '/child_dispositions', 'Constraint-linked unresolved facts require an advancing reviewed revision.');
  }
  const expected = change.child_dispositions.flatMap((disposition) => (
    disposition.unresolved_fact_ids.map((factId) => ({
      domain_id: disposition.domain_id,
      fact_id: factId,
      reason_ref: change.change_id,
      ...(isConstraint ? {
        constraint_id: change.proposed_patch.target_id,
        from_revision: current.semantic_revision,
        to_revision: candidate.semantic_revision,
      } : {}),
    }))
  ));
  const key = (marker) => `${marker.domain_id}\u0000${marker.fact_id}\u0000${marker.constraint_id ?? ''}`;
  const retained = (currentMap.revalidation_required ?? [])
    .filter((marker) => !expected.some((item) => key(item) === key(marker)));
  const reviewed = [...retained, ...expected].sort((left, right) => compareCodePoints(key(left), key(right)));
  const actual = [...(candidateMap.revalidation_required ?? [])]
    .sort((left, right) => compareCodePoints(key(left), key(right)));
  return JSON.stringify(reviewed) === JSON.stringify(actual)
    ? ok(null)
    : proposalFailure('CHANGE_REVALIDATION_MISMATCH', '/candidate_map/revalidation_required', 'Candidate markers must exactly match reviewed unresolved facts.');
};

const exactFactEvolution = (currentFacts, candidateFacts) => {
  if (!exactSet(currentFacts.map(({ fact_id: id }) => id), candidateFacts.map(({ fact_id: id }) => id))) return false;
  for (const candidate of candidateFacts) {
    const current = currentFacts.find(({ fact_id: id }) => id === candidate.fact_id);
    const currentContent = { ...current };
    const candidateContent = { ...candidate };
    delete currentContent.revision;
    delete candidateContent.revision;
    if (JSON.stringify(currentContent) === JSON.stringify(candidateContent)) {
      if (candidate.revision !== current.revision) return false;
    } else if (candidate.revision !== current.revision + 1) {
      return false;
    }
  }
  return true;
};

/**
 * Writes or refreshes one open semantic target under the accepted sole-writer boundary.
 * The accepted map and paired knowledge are read-only during proposal creation.
 */
export async function proposeChange({ root, change }, operations = {}) {
  const inputResult = validateProposalInput(root, change);
  if (!inputResult.ok) return inputResult;

  let lifecycleRoot;
  let map;
  let pending;
  try {
    lifecycleRoot = await resolveLifecycleRoot(root);
    [map, pending] = await Promise.all([
      readFile(join(lifecycleRoot, 'project-map.json'), 'utf8').then(JSON.parse),
      readFile(join(lifecycleRoot, 'pending-changes.json'), 'utf8').then(JSON.parse),
    ]);
  } catch (error) {
    return proposalFailure(
      ['PATH_SYMLINK_ESCAPE', 'CHANGE_ROOT_INVALID'].includes(error?.code) ? error.code : 'CHANGE_ROOT_INVALID',
      '/',
      'A complete bounded lifecycle root is required.',
    );
  }

  const mapValidation = validateJson('project-map', map);
  if (!mapValidation.ok) return mapValidation;
  const pendingValidation = validateJson('pending-changes', pending);
  if (!pendingValidation.ok) return pendingValidation;
  const existing = pending.changes.find(({ semantic_target_key: key }) => (
    key === change.semantic_target_key
  ));
  const effectiveChange = existing
    ? { ...change, change_id: existing.change_id, created_at: existing.created_at }
    : change;
  const candidateValidation = validateJson('project-map', effectiveChange.candidate_map);
  if (!candidateValidation.ok) return candidateValidation;

  const impact = analyzeImpact({
    current_map: map,
    candidate_map: effectiveChange.candidate_map,
    change_class: effectiveChange.change_class,
    changed_fields: effectiveChange.proposed_patch.changed_fields,
    target_id: effectiveChange.proposed_patch.target_id,
    child_dispositions: effectiveChange.child_dispositions,
    operation: effectiveChange.proposed_patch.operation,
  });
  if (!impact.ok) return impact;

  const metadata = validateProposalMetadata(effectiveChange, map, effectiveChange.candidate_map, impact);
  if (!metadata.ok) return metadata;

  const markers = validateReviewedMarkers(effectiveChange, map, effectiveChange.candidate_map);
  if (!markers.ok) return markers;

  const commitments = await deriveKnowledgeCommitments(
    effectiveChange,
    map,
    effectiveChange.candidate_map,
    impact,
    lifecycleRoot,
  );
  if (!commitments.ok) return commitments;

  const entry = canonicalChange(
    effectiveChange,
    map,
    effectiveChange.candidate_map,
    commitments.value,
  );
  const next = JSON.parse(JSON.stringify(pending));
  const existingIndex = next.changes.findIndex(({ semantic_target_key: key }) => (
    key === entry.semantic_target_key
  ));
  if (existingIndex === -1) {
    next.changes.push(entry);
  } else {
    const existing = next.changes[existingIndex];
    next.changes[existingIndex] = {
      ...entry,
      change_id: existing.change_id,
      created_at: existing.created_at,
    };
  }
  next.changes.sort((left, right) => compareCodePoints(left.change_id, right.change_id));
  const nextValidation = validateJson('pending-changes', next);
  if (!nextValidation.ok) return nextValidation;

  try {
    const write = operations.atomicWriteValidated ?? atomicWriteValidated;
    await write({
      root: lifecycleRoot,
      target: 'pending-changes.json',
      content: jsonContent(next),
      validate: async (source) => {
        try {
          const parsed = JSON.parse(source);
          return JSON.stringify(parsed) === JSON.stringify(next)
            ? validateJson('pending-changes', parsed)
            : proposalFailure('CHANGE_WRITE_FAILED', '/', 'Pending proposal changed during validation.');
        } catch {
          return proposalFailure('CHANGE_WRITE_FAILED', '/', 'Pending proposal is not valid JSON.');
        }
      },
    });
    return ok({
      affected_domain_ids: impact.value.affected_domain_ids,
      change_id: existingIndex === -1 ? entry.change_id : next.changes[existingIndex].change_id,
      status: existingIndex === -1 ? 'created' : 'updated',
    });
  } catch (error) {
    return proposalFailure(
      error?.code === 'PATH_SYMLINK_ESCAPE' ? error.code : 'CHANGE_WRITE_FAILED',
      '/',
      'Pending proposal could not be written.',
    );
  }
}
