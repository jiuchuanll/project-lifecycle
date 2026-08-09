import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { isKnowledgeSet } from './knowledge-set.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40,64}$/u;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const sorted = (values) => [...new Set(values)].sort(compareCodePoints);
const clone = (value) => structuredClone(value);
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const intersect = (left, right) => left.filter((value) => right.includes(value));
const baselineValid = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [
    'completeness', 'governanceRevision', 'projectId', 'projectMapHash', 'shardRevisions',
  ].join('\0')
  && /^[a-z][a-z0-9-]*$/u.test(value.projectId ?? '')
  && REVISION.test(value.governanceRevision ?? '') && HASH.test(value.projectMapHash ?? '')
  && value.completeness === 'COMPLETE' && Array.isArray(value.shardRevisions)
  && value.shardRevisions.every((entry, index, entries) => (
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && Object.keys(entry).sort().join('\0') === 'repositoryId\0revision'
    && /^[a-z][a-z0-9-]*$/u.test(entry.repositoryId ?? '') && REVISION.test(entry.revision ?? '')
    && (index === 0 || compareCodePoints(entries[index - 1].repositoryId, entry.repositoryId) < 0)
  ));

const compatibleFact = (candidate, accepted) => candidate.valueHash === accepted.valueHash
  && (candidate.evidenceRevision === accepted.evidenceRevision
    || candidate.changeKind === 'EVIDENCE_REFRESH'
    || accepted.changeKind === 'EVIDENCE_REFRESH');

const pendingConflict = ({
  diff,
  startingBaseline,
  latestBaseline,
  candidateRef,
  latestAcceptedRef,
  createdAt,
  affectedRefs,
  evidenceRefs,
}) => ({
  change_id: `reconcile-${diff.diff_id}`,
  kind: 'material_conflict',
  trigger_refs: sorted([
    latestAcceptedRef,
    candidateRef,
    `baseline:${startingBaseline.governanceRevision}`,
    `baseline:${latestBaseline.governanceRevision}`,
    ...evidenceRefs,
  ]),
  affected_refs: sorted(affectedRefs),
  proposed_disposition: 'CONFLICT_RESOLUTION_REQUIRED',
  risks: ['Accepted governance and shard pins remain unchanged until reviewed resolution.'],
  evidence_gaps: ['A human-reviewed semantic disposition is required before replay or publication.'],
  review_state: 'open',
  created_at: createdAt,
});

export function reconcileKnowledgeCandidate({
  startingBaseline,
  latestBaseline,
  knowledgeDiff,
  candidateSet,
  latestAcceptedSet,
  candidateRef,
  latestAcceptedRef,
  createdAt,
  localShardCandidate,
} = {}) {
  if (!baselineValid(startingBaseline) || !baselineValid(latestBaseline)
    || startingBaseline.projectId !== latestBaseline.projectId
    || !isKnowledgeSet(candidateSet) || !isKnowledgeSet(latestAcceptedSet)
    || !isSafeReference(candidateRef) || !isSafeReference(latestAcceptedRef)
    || !Number.isFinite(Date.parse(createdAt))) {
    return failure('RECONCILIATION_INPUT_INVALID', '/arguments', 'Reconciliation requires exact immutable baselines, semantic sets, and references.');
  }
  const diffValidation = validateJson('knowledge-diff', knowledgeDiff);
  if (!diffValidation.ok || knowledgeDiff.knowledge_baseline !== startingBaseline.governanceRevision) {
    return failure('RECONCILIATION_BASELINE_INVALID', '/knowledgeDiff/knowledge_baseline', 'Knowledge Diff must identify the exact starting governance revision.');
  }

  const affectedRefs = [
    ...intersect(candidateSet.domains, latestAcceptedSet.domains).map((id) => `domain:${id}`),
    ...intersect(candidateSet.constraints, latestAcceptedSet.constraints).map((id) => `constraint:${id}`),
    ...intersect(candidateSet.topologyEdges, latestAcceptedSet.topologyEdges).map((id) => `topology:${id}`),
    ...intersect(candidateSet.ownerships, latestAcceptedSet.ownerships).map((id) => `owner:${id}`),
  ];
  const conflictEvidence = [...knowledgeDiff.evidence_refs];
  const acceptedFacts = new Map(latestAcceptedSet.facts.map((fact) => [fact.factId, fact]));
  const compatibleEvidence = new Map();
  for (const candidateFact of candidateSet.facts) {
    const acceptedFact = acceptedFacts.get(candidateFact.factId);
    if (!acceptedFact) continue;
    if (!compatibleFact(candidateFact, acceptedFact)) {
      affectedRefs.push(`fact:${candidateFact.factId}`);
      conflictEvidence.push(...candidateFact.evidenceRefs, ...acceptedFact.evidenceRefs);
    } else {
      compatibleEvidence.set(candidateFact.factId, sorted([
        ...candidateFact.evidenceRefs,
        ...acceptedFact.evidenceRefs,
      ]));
    }
  }

  let shardPinCandidate = null;
  if (localShardCandidate !== undefined) {
    const valid = localShardCandidate !== null && typeof localShardCandidate === 'object'
      && !Array.isArray(localShardCandidate)
      && Object.keys(localShardCandidate).sort().join('\0') === [
        'candidateRevision', 'expectedPreviousRevision', 'repositoryId',
      ].join('\0')
      && /^[a-z][a-z0-9-]*$/u.test(localShardCandidate.repositoryId ?? '')
      && REVISION.test(localShardCandidate.expectedPreviousRevision ?? '')
      && REVISION.test(localShardCandidate.candidateRevision ?? '');
    if (!valid) return failure('RECONCILIATION_SHARD_INPUT_INVALID', '/localShardCandidate', 'Local shard candidate must bind exact immutable revisions.');
    const currentPin = latestBaseline.shardRevisions.find(({ repositoryId }) => repositoryId === localShardCandidate.repositoryId);
    if (!currentPin || currentPin.revision !== localShardCandidate.expectedPreviousRevision) {
      affectedRefs.push(`owner:${localShardCandidate.repositoryId}`);
    } else {
      shardPinCandidate = clone(localShardCandidate);
    }
  }

  if (affectedRefs.length > 0) {
    const entry = pendingConflict({
      diff: knowledgeDiff,
      startingBaseline,
      latestBaseline,
      candidateRef,
      latestAcceptedRef,
      createdAt,
      affectedRefs,
      evidenceRefs: sorted(conflictEvidence),
    });
    const pendingValidation = validateJson('pending-changes', { schema_version: 1, changes: [entry] });
    if (!pendingValidation.ok) return failure('RECONCILIATION_PENDING_INVALID', '/pending_change', 'Conflict could not produce one bounded pending entry.');
    return ok({
      status: 'conflict',
      stop: { code: 'CONFLICT' },
      knowledge_diff: null,
      shard_pin_candidate: null,
      pending_change: entry,
      atomic_set: null,
    });
  }

  const replayed = clone(knowledgeDiff);
  replayed.knowledge_baseline = latestBaseline.governanceRevision;
  replayed.operations = replayed.operations.map((operation) => compatibleEvidence.has(operation.fact_id)
    ? { ...operation, evidence_refs: compatibleEvidence.get(operation.fact_id) }
    : operation);
  replayed.evidence_refs = sorted([
    ...replayed.evidence_refs,
    ...[...compatibleEvidence.values()].flat(),
  ]);
  const replayValidation = validateJson('knowledge-diff', replayed);
  if (!replayValidation.ok) return failure('RECONCILIATION_REPLAY_INVALID', '/knowledge_diff', 'Replayed Knowledge Diff violates the shared contract.');
  const atomicSet = deepFreeze({
    expected_governance_revision: latestBaseline.governanceRevision,
    knowledge_diff: replayed,
    shard_pin_candidate: shardPinCandidate,
  });
  return ok({
    status: 'replay_ready',
    stop: null,
    knowledge_diff: atomicSet.knowledge_diff,
    shard_pin_candidate: shardPinCandidate,
    pending_change: null,
    atomic_set: atomicSet,
  });
}
