import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';

const REVISION = /^[0-9a-f]{40,64}$/u;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const resultOk = (value) => value?.ok === true;

const validPreflight = ({
  adapter,
  lease,
  ownerId,
  expectedGovernanceRevision,
  candidateBranch,
  validationResult,
  humanGate,
}) => adapter && typeof adapter.pushCandidate === 'function'
  && typeof adapter.createDraftPullRequest === 'function'
  && lease && typeof lease.acquire === 'function' && typeof lease.renew === 'function' && typeof lease.release === 'function'
  && /^[a-z][a-z0-9-]*$/u.test(ownerId ?? '') && REVISION.test(expectedGovernanceRevision ?? '')
  && typeof candidateBranch === 'string'
  && validationResult?.ok === true && isSafeReference(validationResult.evidence_ref)
  && REVISION.test(validationResult.candidate_revision ?? '')
  && humanGate !== null && typeof humanGate === 'object' && !Array.isArray(humanGate)
  && typeof humanGate.required === 'boolean' && typeof humanGate.resolved === 'boolean'
  && humanGate.resolved === true
  && humanGate.candidate_revision === validationResult.candidate_revision
  && (!humanGate.required || isSafeReference(humanGate.approval_ref));

export async function publishReviewedCandidate(input = {}) {
  if (!validPreflight(input)) {
    return failure('PUBLICATION_GATE_UNRESOLVED', '/arguments', 'Validated candidate and every required human gate must be resolved before publication.');
  }
  const {
    adapter,
    lease,
    ownerId,
    expectedGovernanceRevision,
    candidateBranch,
    refreshAcceptedRevision,
    reconcileCandidate,
    validateAtomicSet,
    shardCandidate,
    title,
    bodyFile,
  } = input;
  let acquired = false;
  let outcome;
  const candidateRevision = input.validationResult?.candidate_revision;
  try {
    const leaseResult = await lease.acquire({ ownerId, expectedGovernanceRevision });
    if (!resultOk(leaseResult)) return failure('PUBLICATION_LEASE_UNAVAILABLE', '/lease', 'Short governance publication lease could not be acquired.');
    acquired = true;
    if (typeof refreshAcceptedRevision !== 'function'
      || await refreshAcceptedRevision() !== expectedGovernanceRevision) {
      return failure('PUBLICATION_BASELINE_STALE', '/expectedGovernanceRevision', 'Accepted governance advanced before publication.');
    }
    if (typeof reconcileCandidate !== 'function') return failure('PUBLICATION_RECONCILIATION_INVALID', '/candidate', 'A reconciled atomic candidate is required.');
    const reconciled = await reconcileCandidate();
    const atomicSet = reconciled?.value?.atomic_set;
    if (!resultOk(reconciled) || !atomicSet
      || atomicSet.expected_governance_revision !== expectedGovernanceRevision) {
      return failure('PUBLICATION_RECONCILIATION_INVALID', '/candidate', 'Candidate reconciliation did not preserve the refreshed governance revision.');
    }
    if (atomicSet.candidate_revision !== candidateRevision
      || typeof validateAtomicSet !== 'function' || !resultOk(await validateAtomicSet(atomicSet))) {
      return failure('PUBLICATION_VALIDATION_FAILED', '/candidate', 'Atomic publication candidate failed validation.');
    }
    if (shardCandidate !== undefined) {
      const candidates = Array.isArray(shardCandidate?.candidates)
        ? shardCandidate.candidates
        : [shardCandidate];
      if (candidates.length === 0 || candidates.some((candidate) => (
        !candidate?.adapter || typeof candidate.adapter.pushCandidate !== 'function'
        || typeof candidate.branch !== 'string' || !REVISION.test(candidate.candidate_revision ?? '')
      )) || !resultOk(await lease.renew({ ownerId, expectedGovernanceRevision }))) {
        return failure('PUBLICATION_SHARD_INCOMPLETE', '/shardCandidate', 'Shard candidate push failed; governance remains unchanged.');
      }
      for (const candidate of candidates) {
        const shardPush = await candidate.adapter.pushCandidate(candidate.branch);
        if (!resultOk(shardPush) || shardPush.value?.revision !== candidate.candidate_revision) {
          return failure('PUBLICATION_SHARD_INCOMPLETE', '/shardCandidate', 'Shard candidate push failed; governance remains unchanged.');
        }
      }
    }
    if (!resultOk(await lease.renew({ ownerId, expectedGovernanceRevision }))) {
      return failure('PUBLICATION_LEASE_UNAVAILABLE', '/lease', 'Governance publication lease could not be renewed.');
    }
    const pushed = await adapter.pushCandidate(candidateBranch);
    if (!resultOk(pushed) || pushed.value?.revision !== candidateRevision) {
      return failure('PUBLICATION_CANDIDATE_MISMATCH', '/candidateBranch', 'Pushed candidate does not match the reviewed revision.');
    }
    if (!resultOk(await lease.renew({ ownerId, expectedGovernanceRevision }))) {
      return failure('PUBLICATION_LEASE_UNAVAILABLE', '/lease', 'Governance publication lease could not be renewed.');
    }
    const pullRequest = await adapter.createDraftPullRequest({
      head: candidateBranch, expectedRevision: candidateRevision, title, bodyFile,
    });
    if (!resultOk(pullRequest) || pullRequest.value?.head_revision !== candidateRevision) {
      return failure('PUBLICATION_PR_FAILED', '/pull_request', 'Draft governance review request could not be bound to the reviewed revision.');
    }
    outcome = ok({
      status: 'review_requested',
      current_truth_changed: false,
      validation_ref: input.validationResult.evidence_ref,
      approval_ref: input.humanGate.approval_ref ?? null,
      candidate_revision: candidateRevision,
      pull_request: pullRequest.value,
    });
  } catch {
    outcome = failure('PUBLICATION_INCOMPLETE', '/', 'Reviewed publication did not complete; accepted truth remains unchanged.');
  } finally {
    if (acquired) {
      const released = await lease.release({ ownerId }).catch(() => null);
      if (!resultOk(released) && outcome?.ok) {
        outcome = failure('PUBLICATION_LEASE_RELEASE_FAILED', '/lease', 'Review request exists but lease release requires recovery.');
      }
    }
  }
  return outcome;
}
