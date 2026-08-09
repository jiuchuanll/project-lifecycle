import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';

const CLASSES = new Set([
  'COMPOSABLE_SEAM',
  'DEPENDENCY',
  'DISJOINT_FACTS',
  'INFORMATIONAL_OVERLAP',
  'SAME_FACT_CONFLICT',
  'STALE_REPLAYABLE',
  'STALE_UNREPLAYABLE',
]);
const OWNER_KINDS = new Set(['prd', 'non-prd-delivery']);
const RELATIONSHIP_KINDS = new Set(['coordinates_with', 'depends_on', 'governed_by']);
const ID = /^[a-z][a-z0-9-]*$/u;
const TOP_LEVEL = new Set([
  'affected_domain_ids', 'consumed_contracts', 'current_knowledge_baseline', 'intended_fact_ids',
  'knowledge_baseline', 'overlap', 'owner_artifact_id', 'owner_kind', 'primary_domain_id',
  'provided_contracts', 'relationships', 'repository_ids',
]);
const OVERLAP_FIELDS = new Set([
  'baseline_replay_ref', 'class', 'conflict_ref', 'evidence_refs', 'joint_acceptance_seam_ref',
  'peer_fact_ids', 'peer_owner_ref', 'shared_domain_ids', 'shared_fact_ids',
]);

const issue = (code, path, message) => fail([createError(code, path, message)]);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sorted = (values) => [...values].sort(compareCodePoints);
const hasOnly = (value, fields) => isObject(value) && Object.keys(value).every((key) => fields.has(key));
const validIdList = (value, { nonEmpty = false } = {}) => Array.isArray(value)
  && (!nonEmpty || value.length > 0)
  && new Set(value).size === value.length
  && value.every((entry) => typeof entry === 'string' && ID.test(entry));
const validRefList = (value, { nonEmpty = false } = {}) => Array.isArray(value)
  && (!nonEmpty || value.length > 0)
  && new Set(value).size === value.length
  && value.every(isSafeReference);

const validateContracts = (contracts, path) => {
  if (!Array.isArray(contracts)) return issue('IMPACT_CONTRACT_INVALID', path, 'Contracts must be an array.');
  const ids = new Set();
  for (const [index, contract] of contracts.entries()) {
    if (!hasOnly(contract, new Set(['contract_id', 'revision_ref']))
      || !ID.test(contract.contract_id ?? '') || !isSafeReference(contract.revision_ref)) {
      return issue('IMPACT_REFERENCE_INVALID', `${path}/${index}`, 'Contract ID and revision reference must be safe.');
    }
    if (ids.has(contract.contract_id)) return issue('IMPACT_CONTRACT_DUPLICATE', `${path}/${index}/contract_id`, 'Contract IDs must be unique.');
    ids.add(contract.contract_id);
  }
  return null;
};

export const validateImpactDeclaration = (value) => {
  if (!hasOnly(value, TOP_LEVEL)) return issue('IMPACT_DECLARATION_INVALID', '/', 'Impact declaration has an invalid shape.');
  if (!ID.test(value.owner_artifact_id ?? '') || !OWNER_KINDS.has(value.owner_kind)) {
    return issue('IMPACT_OWNER_INVALID', '/owner_artifact_id', 'Impact declaration requires a supported owner.');
  }
  for (const [field, nonEmpty] of [['repository_ids', true], ['affected_domain_ids', true], ['intended_fact_ids', false]]) {
    if (!validIdList(value[field], { nonEmpty })) return issue('IMPACT_ID_INVALID', `/${field}`, 'Impact IDs must be unique safe IDs.');
  }
  if (!ID.test(value.primary_domain_id ?? '') || !value.affected_domain_ids.includes(value.primary_domain_id)) {
    return issue('IMPACT_PRIMARY_DOMAIN_INVALID', '/primary_domain_id', 'Primary domain must be affected.');
  }
  if (!isSafeReference(value.knowledge_baseline) || !isSafeReference(value.current_knowledge_baseline)) {
    return issue('IMPACT_REFERENCE_INVALID', '/knowledge_baseline', 'Knowledge baselines must be safe references.');
  }
  const contractError = validateContracts(value.provided_contracts, '/provided_contracts')
    ?? validateContracts(value.consumed_contracts, '/consumed_contracts');
  if (contractError) return contractError;
  if (!Array.isArray(value.relationships)) return issue('IMPACT_RELATIONSHIP_INVALID', '/relationships', 'Relationships must be an array.');
  for (const [index, relationship] of value.relationships.entries()) {
    if (!hasOnly(relationship, new Set(['evidence_refs', 'kind', 'target_owner_ref']))
      || !RELATIONSHIP_KINDS.has(relationship.kind)
      || !isSafeReference(relationship.target_owner_ref)
      || !validRefList(relationship.evidence_refs, { nonEmpty: true })) {
      return issue('IMPACT_REFERENCE_INVALID', `/relationships/${index}`, 'Relationship evidence and target must be safe.');
    }
  }
  if (!hasOnly(value.overlap, OVERLAP_FIELDS)) return issue('IMPACT_OVERLAP_INVALID', '/overlap', 'Overlap has an invalid shape.');
  const overlap = value.overlap;
  if (!overlap.class) return issue('IMPACT_CLASS_MISSING', '/overlap/class', 'Agent must supply an overlap class.');
  if (!CLASSES.has(overlap.class)) return issue('IMPACT_CLASS_INVALID', '/overlap/class', 'Unsupported overlap class.');
  if (!isSafeReference(overlap.peer_owner_ref) || !validRefList(overlap.evidence_refs, { nonEmpty: true })) {
    return issue('IMPACT_REFERENCE_INVALID', '/overlap', 'Overlap owner and evidence references must be safe.');
  }
  for (const field of ['shared_domain_ids', 'shared_fact_ids', 'peer_fact_ids']) {
    if (!validIdList(overlap[field])) return issue('IMPACT_ID_INVALID', `/overlap/${field}`, 'Overlap IDs must be unique safe IDs.');
  }
  for (const field of ['baseline_replay_ref', 'conflict_ref', 'joint_acceptance_seam_ref']) {
    if (overlap[field] !== undefined && !isSafeReference(overlap[field])) {
      return issue('IMPACT_REFERENCE_INVALID', `/overlap/${field}`, 'Overlap references must be safe.');
    }
  }
  const relationshipRequired = overlap.class === 'DEPENDENCY' ? 'depends_on'
    : overlap.class === 'COMPOSABLE_SEAM' ? 'coordinates_with' : null;
  if (relationshipRequired && !value.relationships.some((entry) => (
    entry.kind === relationshipRequired && entry.target_owner_ref === overlap.peer_owner_ref
  ))) return issue('IMPACT_RELATIONSHIP_MISSING', '/relationships', 'Declared overlap class requires an evidenced peer relationship.');
  if (overlap.class === 'COMPOSABLE_SEAM' && !overlap.joint_acceptance_seam_ref) {
    return issue('JOINT_ACCEPTANCE_SEAM_MISSING', '/overlap/joint_acceptance_seam_ref', 'Composable work requires a joint acceptance seam.');
  }
  if (overlap.class === 'SAME_FACT_CONFLICT') {
    if (overlap.shared_fact_ids.length === 0
      || overlap.shared_fact_ids.some((id) => !value.intended_fact_ids.includes(id))) {
      return issue('SHARED_FACT_MISSING', '/overlap/shared_fact_ids', 'Same-fact conflict requires a shared intended fact.');
    }
    if (!overlap.conflict_ref) return issue('IMPACT_REFERENCE_INVALID', '/overlap/conflict_ref', 'Same-fact conflict requires a conflict reference.');
  }
  if (overlap.class === 'DISJOINT_FACTS'
    && value.intended_fact_ids.some((id) => overlap.peer_fact_ids.includes(id))) {
    return issue('DISJOINT_FACT_CONFLICT', '/overlap/peer_fact_ids', 'Disjoint facts cannot overlap.');
  }
  const stale = value.knowledge_baseline !== value.current_knowledge_baseline;
  const staleClass = overlap.class === 'STALE_REPLAYABLE' || overlap.class === 'STALE_UNREPLAYABLE';
  if (staleClass && !stale) return issue('BASELINE_NOT_STALE', '/knowledge_baseline', 'Stale overlap class requires baseline drift.');
  if (stale && !staleClass) return issue('STALE_CLASS_REQUIRED', '/overlap/class', 'Baseline drift requires an explicit stale overlap class.');
  if (overlap.class === 'STALE_REPLAYABLE' && !overlap.baseline_replay_ref) {
    return issue('BASELINE_REPLAY_MISSING', '/overlap/baseline_replay_ref', 'Replayable baseline drift requires replay evidence.');
  }
  if (overlap.class === 'STALE_UNREPLAYABLE' && !overlap.conflict_ref) {
    return issue('IMPACT_REFERENCE_INVALID', '/overlap/conflict_ref', 'Unreplayable baseline drift requires a conflict reference.');
  }

  return ok({
    ...structuredClone(value),
    repository_ids: sorted(value.repository_ids),
    affected_domain_ids: sorted(value.affected_domain_ids),
    intended_fact_ids: sorted(value.intended_fact_ids),
    required_obligation_kinds: [],
  });
};
