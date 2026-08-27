import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeLocator, isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { activeDeliveryPair, archivedDeliveryPair } from './delivery-layout.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[a-z][a-z0-9-]*$/u;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed) => record(value) && Object.keys(value).every((key) => allowed.has(key));
const artifactKeys = new Set([
  'artifact_id', 'artifact_kind', 'owner_artifact_id', 'owner_artifact_kind',
  'body_hashes', 'evidence_refs', 'locators',
]);

export const createRetentionPlan = ({ summary, artifacts, delete_evidence_refs: deletionRefs } = {}) => {
  if (!record(summary) || !ID.test(summary.artifact_id ?? '') || !isSafeReference(summary.closure_ref)) {
    return failure('RETENTION_SUMMARY_INVALID', '/summary', 'Retention requires one compact durable summary identity.');
  }
  if (!Array.isArray(deletionRefs) || deletionRefs.length > 0) {
    return failure('EVIDENCE_DELETE_FORBIDDEN', '/delete_evidence_refs', 'Unique delivery evidence is never automatically deleted.');
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return failure('RETENTION_ARTIFACTS_MISSING', '/artifacts', 'At least one detailed owner artifact is required.');
  }
  const ids = new Set();
  const evidence = new Set();
  const transitions = [];
  for (const [index, artifact] of artifacts.entries()) {
    if (!exactKeys(artifact, artifactKeys) || !ID.test(artifact.artifact_id ?? '')
      || typeof artifact.artifact_kind !== 'string' || artifact.artifact_kind.length === 0
      || !ID.test(artifact.owner_artifact_id ?? '')
      || !['prd', 'non-prd-delivery'].includes(artifact.owner_artifact_kind)
      || !record(artifact.locators) || !record(artifact.body_hashes)
      || Object.keys(artifact.locators).sort().join(',') !== 'en,zh-CN'
      || !isSafeLocator(artifact.locators.en) || !isSafeLocator(artifact.locators['zh-CN'])
      || !artifact.locators.en.startsWith('delivery/') || !artifact.locators['zh-CN'].startsWith('delivery/')
      || !HASH.test(artifact.body_hashes.en ?? '') || !HASH.test(artifact.body_hashes['zh-CN'] ?? '')
      || !Array.isArray(artifact.evidence_refs) || !artifact.evidence_refs.every(isSafeReference)) {
      return failure('RETENTION_ARTIFACT_INVALID', `/artifacts/${index}`, 'Detailed artifacts require safe paired locators, body hashes, and evidence references.');
    }
    if (ids.has(artifact.artifact_id)) return failure('RETENTION_ARTIFACT_DUPLICATE', `/artifacts/${index}/artifact_id`, 'Detailed artifact IDs must be unique.');
    const ownership = {
      artifact_id: artifact.artifact_id,
      artifact_kind: artifact.artifact_kind,
      owner_artifact_id: artifact.owner_artifact_id,
    };
    const expectedActive = activeDeliveryPair(ownership, { ownerKind: artifact.owner_artifact_kind });
    if (expectedActive.en !== artifact.locators.en
      || expectedActive['zh-CN'] !== artifact.locators['zh-CN']) {
      return failure('RETENTION_OWNER_MISMATCH', `/artifacts/${index}/locators`, 'Detailed artifact locators must match their declared physical owner.');
    }
    ids.add(artifact.artifact_id);
    artifact.evidence_refs.forEach((ref) => evidence.add(ref));
    transitions.push({
      artifact_id: artifact.artifact_id,
      artifact_kind: artifact.artifact_kind,
      from: structuredClone(artifact.locators),
      to: archivedDeliveryPair(ownership, { ownerKind: artifact.owner_artifact_kind }),
      body_hashes: structuredClone(artifact.body_hashes),
      retention_tier: 'archive',
    });
  }
  transitions.sort((left, right) => compareCodePoints(left.artifact_id, right.artifact_id));
  return ok({
    active_summary: { artifact_id: summary.artifact_id, retention_tier: 'closed-summary' },
    archive_transitions: transitions,
    retained_unique_evidence_refs: [...evidence].sort(compareCodePoints),
    writable_closed_body_regions: ['feedback:marking', 'feedback:coverage'],
  });
};
