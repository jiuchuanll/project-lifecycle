import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { validateObligationTransition } from '../lib/obligations.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const issue = (code, path, message) => fail([createError(code, path, message)]);
const sortedRefs = (values) => [...values].sort(compareCodePoints);
const normalizeObligation = (obligation) => ({
  ...structuredClone(obligation),
  trigger_refs: sortedRefs(obligation.trigger_refs ?? []),
  scope_refs: sortedRefs(obligation.scope_refs ?? []),
  responsible_refs: sortedRefs(obligation.responsible_refs ?? []),
  evidence_refs: sortedRefs(obligation.evidence_refs ?? []),
});
const duplicateId = (obligations) => {
  const seen = new Set();
  return obligations.find(({ obligation_id: id }) => seen.has(id) || !seen.add(id));
};
const upsert = (obligations, next) => {
  if (duplicateId(obligations)) return issue('OBLIGATION_ID_DUPLICATE', '/obligations', 'Owner-local obligation IDs must be unique.');
  const index = obligations.findIndex(({ obligation_id }) => obligation_id === next.obligation_id);
  const previous = index === -1 ? null : obligations[index];
  const transition = validateObligationTransition(previous, next);
  if (!transition.ok) return transition;
  const updated = structuredClone(obligations);
  if (index === -1) updated.push(next); else updated[index] = next;
  updated.sort((left, right) => compareCodePoints(left.obligation_id, right.obligation_id));
  return ok(updated);
};

export const storeObligation = ({ owner, next } = {}) => {
  if (!owner || !next) return issue('OBLIGATION_INPUT_INVALID', '/', 'Owner and next obligation are required.');
  const normalized = normalizeObligation(next);
  if (owner.kind === 'prd' || owner.kind === 'non-prd-delivery') {
    const currentValidation = validateJson('delivery-frontmatter', owner.frontmatter);
    if (!currentValidation.ok) return currentValidation;
    if (owner.frontmatter.artifact_kind !== owner.kind) {
      return issue('OBLIGATION_OWNER_MISMATCH', '/owner/kind', 'Owner kind must match delivery Frontmatter.');
    }
    const updated = upsert(owner.frontmatter.obligations, normalized);
    if (!updated.ok) return updated;
    const nextOwner = structuredClone(owner);
    nextOwner.frontmatter.obligations = updated.value;
    const validation = validateJson('delivery-frontmatter', nextOwner.frontmatter);
    if (!validation.ok) return validation;
    return ok({
      owner: nextOwner,
      qualified_id: `${nextOwner.frontmatter.artifact_id}#${normalized.obligation_id}`,
      storage: { kind: 'owner-frontmatter', locator: owner.owner_locator },
    });
  }
  if (owner.kind === 'knowledge-pending') {
    const currentValidation = validateJson('pending-changes', owner.ledger);
    if (!currentValidation.ok) return currentValidation;
    const nextOwner = structuredClone(owner);
    const change = nextOwner.ledger.changes.find(({ change_id }) => change_id === owner.change_id);
    if (!change) return issue('OBLIGATION_OWNER_MISSING', '/owner/change_id', 'Pending owner entry does not exist.');
    const updated = upsert(change.obligations ?? [], normalized);
    if (!updated.ok) return updated;
    change.obligations = updated.value;
    const validation = validateJson('pending-changes', nextOwner.ledger);
    if (!validation.ok) return validation;
    return ok({
      owner: nextOwner,
      qualified_id: `${owner.change_id}#${normalized.obligation_id}`,
      storage: { kind: 'pending-change', locator: `pending-changes.json#${owner.change_id}` },
    });
  }
  return issue('OBLIGATION_OWNER_INVALID', '/owner/kind', 'Unsupported obligation owner kind.');
};
