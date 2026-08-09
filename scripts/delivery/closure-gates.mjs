import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const issue = (code, path, message) => fail([createError(code, path, message)]);
const qualifiedId = (ownerId, obligation) => `${ownerId}#${obligation.obligation_id}`;
const terminalOutcome = (id, obligation) => ({
  qualified_id: id,
  status: obligation.status,
  evidence_refs: obligation.evidence_refs,
  ...(obligation.resolution_ref ? { resolution_ref: obligation.resolution_ref } : {}),
  ...(obligation.human_approval_ref ? { human_approval_ref: obligation.human_approval_ref } : {}),
});

export const evaluateClosureGate = ({ gate, owner_artifact_id: ownerId, obligations, qualified_obligations: external } = {}) => {
  if (typeof gate !== 'string' || gate.length === 0 || typeof ownerId !== 'string'
    || !Array.isArray(obligations) || !Array.isArray(external)) {
    return issue('CLOSURE_GATE_INPUT_INVALID', '/', 'Gate, owner, and obligation lists are required.');
  }
  const entries = [
    ...obligations.map((obligation) => ({ owner_artifact_id: ownerId, obligation })),
    ...external,
  ];
  const byId = new Map();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry.owner_artifact_id !== 'string') {
      return issue('OBLIGATION_OWNER_INVALID', `/qualified_obligations/${index}`, 'Qualified obligation owner is invalid.');
    }
    const validation = validateJson('obligation-instance', entry.obligation);
    if (!validation.ok) return validation;
    const id = qualifiedId(entry.owner_artifact_id, entry.obligation);
    if (byId.has(id)) return issue('OBLIGATION_QUALIFIED_ID_DUPLICATE', '/', `Duplicate qualified obligation: ${id}`);
    byId.set(id, entry.obligation);
  }

  const blocking = new Set();
  const outcomes = new Map();
  const visit = (id, stack = new Set()) => {
    if (stack.has(id)) return issue('OBLIGATION_SUCCESSOR_CYCLE', '/successor_obligation_ref', 'Obligation successor chain contains a cycle.');
    const obligation = byId.get(id);
    if (!obligation) return issue('OBLIGATION_SUCCESSOR_MISSING', '/successor_obligation_ref', 'Qualified successor obligation does not exist.');
    if (obligation.status === 'SUPERSEDED') {
      const nextStack = new Set(stack);
      nextStack.add(id);
      return visit(obligation.successor_obligation_ref, nextStack);
    }
    if (obligation.status === 'OPEN') {
      if (obligation.required_before === gate) blocking.add(id);
      return ok(null);
    }
    outcomes.set(id, terminalOutcome(id, obligation));
    return ok(null);
  };

  for (const obligation of obligations) {
    const result = visit(qualifiedId(ownerId, obligation));
    if (!result.ok) return result;
  }
  const value = {
    blocking_obligation_refs: [...blocking].sort(compareCodePoints),
    compact_outcomes: [...outcomes.values()].sort((left, right) => compareCodePoints(left.qualified_id, right.qualified_id)),
  };
  if (value.blocking_obligation_refs.length > 0) {
    return {
      ok: false,
      value,
      errors: [createError('CLOSURE_GATE_BLOCKED', '/obligations', 'Open obligations block this closure gate.')],
    };
  }
  return ok(value);
};
