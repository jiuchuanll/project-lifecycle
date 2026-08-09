import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { evaluateClosureGate } from './closure-gates.mjs';
import { validateImpactDeclaration } from './impact-declaration.mjs';
import { createRetentionPlan } from './retention.mjs';

const ID = /^[a-z][a-z0-9-]*$/u;
const OUTCOMES = new Set(['ABANDONED', 'ACCEPTED', 'CANCELLED', 'REJECTED']);
const VERIFICATION = new Set(['FAILED', 'NOT_RUN', 'PASSED']);
const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeRefs = (values, { nonEmpty = false } = {}) => Array.isArray(values)
  && (!nonEmpty || values.length > 0) && new Set(values).size === values.length && values.every(isSafeReference);
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};
const sortedRecords = (values, field) => [...values].sort((left, right) => compareCodePoints(left[field], right[field]));

const validateFeedbackCoverage = (owner, coverage, accepted) => {
  if (!Array.isArray(coverage)) return failure('FEEDBACK_COVERAGE_INVALID', '/feedback_coverage', 'Feedback coverage must be explicit.');
  const byId = new Map();
  for (const [index, entry] of coverage.entries()) {
    if (!record(entry) || !/^feedback-[a-z0-9-]+$/u.test(entry.feedback_id ?? '')
      || !['COVERED', 'NOT_COVERED', 'PARTIAL'].includes(entry.status)
      || !Array.isArray(entry.covering_prd_ids) || new Set(entry.covering_prd_ids).size !== entry.covering_prd_ids.length
      || !entry.covering_prd_ids.every((id) => /^prd-[a-z0-9-]+$/u.test(id))
      || !safeRefs(entry.evidence_refs)
      || !Array.isArray(entry.remaining_criteria)
      || !entry.remaining_criteria.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 1000)) {
      return failure('FEEDBACK_COVERAGE_INVALID', `/feedback_coverage/${index}`, 'Feedback coverage is malformed.');
    }
    if (byId.has(entry.feedback_id)) return failure('FEEDBACK_COVERAGE_INVALID', `/feedback_coverage/${index}/feedback_id`, 'Feedback coverage IDs must be unique.');
    if (entry.status === 'COVERED' && (entry.covering_prd_ids.length === 0 || entry.evidence_refs.length === 0 || entry.remaining_criteria.length > 0)) {
      return failure('FEEDBACK_COVERAGE_INVALID', `/feedback_coverage/${index}`, 'Covered Feedback requires owners and evidence with no remaining criteria.');
    }
    if (entry.status !== 'COVERED' && entry.remaining_criteria.length === 0) {
      return failure('FEEDBACK_COVERAGE_INVALID', `/feedback_coverage/${index}/remaining_criteria`, 'Partial outcomes must preserve remaining criteria.');
    }
    byId.set(entry.feedback_id, entry);
  }
  const expected = owner.relationships.feedback_ids;
  if (expected.some((id) => !byId.has(id)) || [...byId.keys()].some((id) => !expected.includes(id))) {
    return failure('FEEDBACK_COVERAGE_INVALID', '/feedback_coverage', 'Coverage must exactly match the owner Feedback relationships.');
  }
  if (accepted && [...byId.values()].some(({ status }) => status !== 'COVERED')) {
    return failure('FEEDBACK_COVERAGE_INCOMPLETE', '/feedback_coverage', 'Accepted delivery requires complete Feedback coverage.');
  }
  return ok(sortedRecords(coverage, 'feedback_id'));
};

export const closeDelivery = (input = {}) => {
  if (!record(input)) return failure('CLOSURE_INPUT_INVALID', '/', 'Closure input must be structured.');
  if (Object.hasOwn(input, 'current_knowledge_write')) {
    return failure('CURRENT_KNOWLEDGE_WRITE_FORBIDDEN', '/current_knowledge_write', 'Delivery closure cannot write current capability knowledge.');
  }
  const ownerValidation = validateJson('delivery-frontmatter', input.owner);
  if (!ownerValidation.ok || input.owner.retention_tier !== 'active') {
    return failure('CLOSURE_OWNER_INVALID', '/owner', 'Closure requires one active valid delivery owner.');
  }
  if (!record(input.outcome) || !OUTCOMES.has(input.outcome.status)
    || !isSafeReference(input.outcome.ref) || !safeRefs(input.outcome.residual_risk_refs)) {
    return failure('CLOSURE_OUTCOME_INVALID', '/outcome', 'A durable bounded owner outcome is required.');
  }
  if (!record(input.verification) || !VERIFICATION.has(input.verification.status) || !isSafeReference(input.verification.ref)) {
    return failure('VERIFICATION_REQUIRED', '/verification', 'Closure requires a durable verification result.');
  }
  const accepted = input.outcome.status === 'ACCEPTED';
  if (accepted && input.verification.status !== 'PASSED') {
    return failure('VERIFICATION_REQUIRED', '/verification/status', 'Accepted delivery requires passed verification.');
  }
  const gate = evaluateClosureGate({
    gate: 'closure',
    owner_artifact_id: input.owner.artifact_id,
    obligations: input.obligations,
    qualified_obligations: input.qualified_obligations,
  });
  if (!gate.ok) return gate;
  if (!record(input.conflict_disposition)
    || !['NOT_APPLICABLE', 'RESOLVED'].includes(input.conflict_disposition.status)
    || !isSafeReference(input.conflict_disposition.ref)) {
    return failure('CONFLICT_DISPOSITION_REQUIRED', '/conflict_disposition', 'Closure requires an explicit conflict disposition.');
  }
  if (input.impact?.overlap?.class === 'SAME_FACT_CONFLICT' && input.conflict_disposition.status !== 'RESOLVED') {
    return failure('CONFLICT_DISPOSITION_REQUIRED', '/conflict_disposition/status', 'Same-fact conflict must be resolved before closure.');
  }
  if (!Array.isArray(input.acceptance_units)) return failure('ACCEPTANCE_INCOMPLETE', '/acceptance_units', 'Acceptance units must be explicit.');
  for (const [index, unit] of input.acceptance_units.entries()) {
    if (!record(unit) || !ID.test(unit.unit_id ?? '') || !['ACCEPTED', 'OPEN', 'REJECTED'].includes(unit.status)
      || !safeRefs(unit.evidence_refs)) {
      return failure('ACCEPTANCE_INCOMPLETE', `/acceptance_units/${index}`, 'Acceptance unit is malformed.');
    }
  }
  if (accepted && (input.acceptance_units.length === 0
    || input.acceptance_units.some(({ status, evidence_refs: evidence }) => status !== 'ACCEPTED' || evidence.length === 0))) {
    return failure('ACCEPTANCE_INCOMPLETE', '/acceptance_units', 'Every accepted delivery unit requires acceptance evidence.');
  }
  if (!record(input.baseline) || !isSafeReference(input.baseline.starting) || !isSafeReference(input.baseline.current)) {
    return failure('BASELINE_INVALID', '/baseline', 'Starting and current baselines are required.');
  }
  if (input.baseline.starting !== input.baseline.current && !isSafeReference(input.baseline.reconciliation_ref)) {
    return failure('BASELINE_RECONCILIATION_REQUIRED', '/baseline/reconciliation_ref', 'Stale baseline must be reconciled before closure.');
  }
  const impact = validateImpactDeclaration(input.impact);
  if (!impact.ok) return failure('IMPACT_DECLARATION_INVALID', '/impact', 'Closure requires one validated impact declaration.');
  if (input.impact.owner_artifact_id !== input.owner.artifact_id
    || input.impact.owner_kind !== input.owner.artifact_kind
    || input.impact.knowledge_baseline !== input.baseline.starting
    || input.impact.current_knowledge_baseline !== input.baseline.current) {
    return failure('IMPACT_DECLARATION_MISMATCH', '/impact', 'Impact owner and baselines must match the closing delivery.');
  }
  const coverage = validateFeedbackCoverage(input.owner, input.feedback_coverage, accepted);
  if (!coverage.ok) return coverage;
  if (!record(input.knowledge_handoff)
    || input.knowledge_handoff.candidate_owner !== 'run-prd-lifecycle'
    || input.knowledge_handoff.apply_authority !== 'maintain-project-knowledge'
    || input.knowledge_handoff.current_knowledge_written !== false
    || !record(input.knowledge_handoff.diff)) {
    return failure('KNOWLEDGE_HANDOFF_REQUIRED', '/knowledge_handoff', 'Closure requires one bounded Knowledge Diff or NO_CHANGE candidate.');
  }
  const diff = validateJson('knowledge-diff', input.knowledge_handoff.diff);
  if (!diff.ok || input.knowledge_handoff.diff.owner_delivery_id !== input.owner.artifact_id
    || input.knowledge_handoff.diff.knowledge_baseline !== input.baseline.starting) {
    return failure('KNOWLEDGE_HANDOFF_REQUIRED', '/knowledge_handoff/diff', 'Knowledge handoff must bind the closing owner and starting baseline.');
  }
  if (!safeRefs(input.evidence_refs, { nonEmpty: true })) {
    return failure('CLOSURE_EVIDENCE_REQUIRED', '/evidence_refs', 'Closure requires bounded durable evidence references.');
  }
  const acceptedEvidence = new Set(input.evidence_refs);
  const diffEvidence = [
    ...input.knowledge_handoff.diff.evidence_refs,
    ...input.knowledge_handoff.diff.operations.flatMap((operation) => operation.evidence_refs),
    ...input.knowledge_handoff.diff.domain_changes.flatMap((change) => change.evidence_refs),
  ];
  if (diffEvidence.some((reference) => !acceptedEvidence.has(reference))) {
    return failure('KNOWLEDGE_EVIDENCE_UNACCEPTED', '/knowledge_handoff/diff/evidence_refs', 'Knowledge Diff evidence must be accepted closure evidence.');
  }

  const closureId = `closure-${input.owner.artifact_id}`;
  const summary = freeze({
    artifact_id: closureId,
    owner_artifact_id: input.owner.artifact_id,
    outcome: structuredClone(input.outcome),
    verification: structuredClone(input.verification),
    acceptance: {
      claimed: accepted,
      units: sortedRecords(input.acceptance_units, 'unit_id'),
    },
    feedback_coverage: coverage.value,
    obligation_outcomes: gate.value.compact_outcomes,
    conflict_disposition: structuredClone(input.conflict_disposition),
    baseline: structuredClone(input.baseline),
    knowledge_handoff: {
      diff_id: input.knowledge_handoff.diff.diff_id,
      outcome: input.knowledge_handoff.diff.outcome,
      owner: input.knowledge_handoff.candidate_owner,
      apply_authority: input.knowledge_handoff.apply_authority,
    },
    evidence_refs: [...input.evidence_refs].sort(compareCodePoints),
    closure_ref: input.outcome.ref,
  });
  const retention = createRetentionPlan({
    summary,
    artifacts: input.detailed_artifacts,
    delete_evidence_refs: [],
  });
  if (!retention.ok) return retention;
  const cleanupStatus = {
    ACCEPTED: 'CLOSED',
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED',
    ABANDONED: 'WITHDRAWN',
  }[input.outcome.status];
  return ok({
    summary,
    retention: retention.value,
    cleanup_authorization: {
      owner_status: cleanupStatus,
      closure_ref: input.outcome.ref,
      verification_result_ref: input.verification.ref,
      knowledge_handoff: {
        kind: input.knowledge_handoff.diff.outcome === 'NO_CHANGE' ? 'NO_CHANGE' : 'KNOWLEDGE_DIFF',
        ref: `knowledge-diff:${input.knowledge_handoff.diff.diff_id}`,
      },
      conflict_disposition_ref: input.conflict_disposition.ref,
    },
  });
};
