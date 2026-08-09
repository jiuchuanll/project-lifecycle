import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { assertVocabularyValue } from '../lib/vocabulary.mjs';
import { validateRoute } from './validate-route.mjs';

const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ID = /^[a-z][a-z0-9-]*$/u;
const topKeys = new Set([
  'current',
  'replacement',
  'correction_ref',
  'former_owner_outcome',
  'successor',
  'prd_creation_origin',
  'creation_approval_ref',
  'knowledge_handoff_refs',
  'later_plugin_request',
]);
const currentKeys = new Set(['materialized', 'primary_route', 'owner_ref', 'artifact_id']);
const outcomeKeys = new Set(['status', 'outcome_ref']);
const successorKeys = new Set(['artifact_id', 'primary_route']);

const safeRefs = (value, path, { required = false } = {}) => {
  if (!Array.isArray(value) || value.length > 50 || (required && value.length === 0)
    || value.some((entry) => !isSafeReference(entry))) {
    return failure('RECLASSIFICATION_REFERENCE_INVALID', path, 'Reclassification references must be safe and bounded.');
  }
  return ok([...new Set(value)].sort(compareCodePoints));
};

const validateCurrent = (current) => {
  if (!record(current) || Object.keys(current).some((key) => !currentKeys.has(key))
    || typeof current.materialized !== 'boolean') {
    return failure('RECLASSIFICATION_INPUT_INVALID', '/current', 'Current route state is malformed.');
  }
  const route = assertVocabularyValue('primary_routes', current.primary_route, '/current/primary_route');
  if (!route.ok) return failure('RECLASSIFICATION_INPUT_INVALID', '/current/primary_route', 'Current route is invalid.');
  if (current.materialized && !isSafeReference(current.owner_ref)) {
    return failure('RECLASSIFICATION_REFERENCE_INVALID', '/current/owner_ref', 'A durable owner reference is required.');
  }
  if (current.artifact_id !== undefined && !ID.test(current.artifact_id)) {
    return failure('RECLASSIFICATION_INPUT_INVALID', '/current/artifact_id', 'Current artifact ID is invalid.');
  }
  return ok(current);
};

export const reclassifyRoute = (input = {}) => {
  if (!record(input) || Object.keys(input).some((key) => !topKeys.has(key))) {
    return failure('RECLASSIFICATION_INPUT_INVALID', '/', 'Reclassification accepts only bounded transition fields.');
  }
  const current = validateCurrent(input.current);
  if (!current.ok) return current;
  if (!isSafeReference(input.correction_ref)) {
    return failure('RECLASSIFICATION_REFERENCE_INVALID', '/correction_ref', 'A safe clarification or evidence reference is required.');
  }
  if (input.later_plugin_request === true && input.current.primary_route === 'OUTSIDE_PLUGIN') {
    return failure('NEW_INTAKE_REQUIRED', '/', 'Later Plugin work after an outside correction must begin as a new intake.');
  }

  const replacement = validateRoute(input.replacement);
  if (!replacement.ok) return replacement;
  if (!replacement.value.primary_route) {
    return failure('RECLASSIFICATION_INPUT_INVALID', '/replacement', 'A correction must supply one replacement primary route.');
  }
  if (replacement.value.primary_route === input.current.primary_route) {
    return failure('ROUTE_UNCHANGED', '/replacement/primary_route', 'Reclassification requires a different primary route.');
  }

  if (!input.current.materialized) {
    return ok({ status: 'transient-replacement', decision: replacement.value });
  }

  const outcome = input.former_owner_outcome;
  if (!record(outcome) || Object.keys(outcome).some((key) => !outcomeKeys.has(key))
    || !['CLOSED', 'CANCELLED', 'WITHDRAWN'].includes(outcome.status)
    || !isSafeReference(outcome.outcome_ref)) {
    return failure('FORMER_OWNER_CLOSURE_REQUIRED', '/former_owner_outcome', 'Durable reclassification requires an exact former-owner closure outcome.');
  }

  const targetRoute = replacement.value.primary_route;
  const needsDeliverySuccessor = ['PRD_DELIVERY', 'NON_PRD_DELIVERY'].includes(targetRoute);
  let successor = null;
  let handoff = null;

  if (needsDeliverySuccessor) {
    if (!record(input.successor) || Object.keys(input.successor).some((key) => !successorKeys.has(key))
      || !ID.test(input.successor.artifact_id) || input.successor.primary_route !== targetRoute) {
      return failure('SUCCESSOR_REQUIRED', '/successor', 'Corrected delivery requires one matching durable successor.');
    }
    if (input.current.artifact_id && input.successor.artifact_id === input.current.artifact_id) {
      return failure('IN_PLACE_ROUTE_EDIT_FORBIDDEN', '/successor/artifact_id', 'A durable owner route cannot be edited in place.');
    }
    if (targetRoute === 'PRD_DELIVERY') {
      if (!['explicit_user', 'agent_inferred'].includes(input.prd_creation_origin)) {
        return failure('PRD_ORIGIN_REQUIRED', '/prd_creation_origin', 'A PRD successor requires an explicit creation origin.');
      }
      if (input.prd_creation_origin === 'agent_inferred'
        && !isSafeReference(input.creation_approval_ref)) {
        return failure('PRD_APPROVAL_REQUIRED', '/creation_approval_ref', 'An inferred PRD successor requires explicit user confirmation.');
      }
      if (!input.successor.artifact_id.startsWith('prd-')) {
        return failure('SUCCESSOR_REQUIRED', '/successor/artifact_id', 'A PRD successor requires a canonical PRD artifact ID.');
      }
    } else if (input.prd_creation_origin !== undefined || input.creation_approval_ref !== undefined) {
      return failure('RECLASSIFICATION_INPUT_INVALID', '/prd_creation_origin', 'PRD creation metadata is only valid for a PRD successor.');
    }
    successor = {
      artifact_id: input.successor.artifact_id,
      primary_route: targetRoute,
      reclassified_from_refs: [input.current.owner_ref],
    };
  } else if (input.successor !== undefined) {
    return failure('RECLASSIFICATION_INPUT_INVALID', '/successor', 'A non-delivery correction cannot create a delivery successor.');
  }

  if (targetRoute === 'KNOWLEDGE_UPDATE') {
    const refs = safeRefs(input.knowledge_handoff_refs, '/knowledge_handoff_refs', { required: true });
    if (!refs.ok) return refs;
    handoff = { target_skill: 'maintain-project-knowledge', evidence_refs: refs.value };
  } else if (input.knowledge_handoff_refs !== undefined) {
    return failure('RECLASSIFICATION_INPUT_INVALID', '/knowledge_handoff_refs', 'Knowledge handoff references are only valid for a knowledge correction.');
  }

  return ok({
    status: 'durable-reclassification',
    former_owner: {
      owner_ref: input.current.owner_ref,
      outcome: { ...outcome },
      retention: 'closed-summary',
    },
    decision: replacement.value,
    successor,
    handoff,
  });
};
