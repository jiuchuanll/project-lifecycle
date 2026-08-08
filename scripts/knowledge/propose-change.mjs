import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { atomicWriteValidated } from '../lib/atomic-write.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { analyzeImpact, hashProjectMap } from './impact.mjs';

const proposalFailure = (code, path, message) => fail([createError(code, path, message)]);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const jsonContent = (value) => `${JSON.stringify(value, null, 2)}\n`;
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

const canonicalChange = (change, map, candidateMap) => {
  const {
    candidate_map: _candidateMap,
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

const validateProposalMetadata = (change, candidateMap, impact) => {
  const patch = change.proposed_patch;
  const expectedTargetType = targetTypesByOperation[patch.operation];
  const targetKey = `${patch.target_type}:${patch.target_id}`;
  if (expectedTargetType !== patch.target_type
    || (change.semantic_target_key !== targetKey
      && !change.semantic_target_key.startsWith(`${targetKey}:`))) {
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

  const requiredRefs = new Set([patch.target_id, ...impact.value.affected_domain_ids]);
  if ([...requiredRefs].some((ref) => !change.affected_refs.includes(ref))) {
    return proposalFailure(
      'CHANGE_PROPOSAL_MISMATCH',
      '/affected_refs',
      'Affected references must cover the reviewed target and impact set.',
    );
  }
  return ok(null);
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
  const candidateValidation = validateJson('project-map', change.candidate_map);
  if (!candidateValidation.ok) return candidateValidation;

  const impact = analyzeImpact({
    current_map: map,
    candidate_map: change.candidate_map,
    change_class: change.change_class,
    changed_fields: change.proposed_patch.changed_fields,
    target_id: change.proposed_patch.target_id,
    child_dispositions: change.child_dispositions,
    operation: change.proposed_patch.operation,
  });
  if (!impact.ok) return impact;

  const metadata = validateProposalMetadata(change, change.candidate_map, impact);
  if (!metadata.ok) return metadata;

  const entry = canonicalChange(change, map, change.candidate_map);
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
