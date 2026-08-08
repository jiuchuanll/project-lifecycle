import { createError } from './errors.mjs';
import { fail, ok } from './result.mjs';
import { validateJson } from './validate-json.mjs';

const error = (code, path, message) => fail([createError(code, path, message)]);

const hasEvidence = (obligation) => Array.isArray(obligation.evidence_refs)
  && obligation.evidence_refs.length > 0;

const hasNewTrigger = (previous, next) => Array.isArray(next.trigger_refs)
  && next.trigger_refs.some((trigger) => !previous.trigger_refs.includes(trigger));

const validateOutcomeRequirements = (obligation) => {
  if (obligation.status === 'OPEN') {
    const activeField = ['resolution_ref', 'human_approval_ref', 'successor_obligation_ref']
      .find((field) => obligation[field]);
    if (activeField) {
      return error('OBLIGATION_ACTIVE_RESOLUTION_FORBIDDEN', `/${activeField}`, 'OPEN obligations cannot retain active resolution fields.');
    }
    return null;
  }
  if (obligation.status === 'RESOLVED') {
    if (!hasEvidence(obligation)) {
      return error('OBLIGATION_EVIDENCE_REQUIRED', '/evidence_refs', 'RESOLVED obligations require evidence.');
    }
    if (!obligation.resolution_ref) {
      return error('OBLIGATION_RESOLUTION_REQUIRED', '/resolution_ref', 'RESOLVED obligations require a resolution reference.');
    }
  }
  if (obligation.status === 'WAIVED') {
    if (!hasEvidence(obligation)) {
      return error('OBLIGATION_EVIDENCE_REQUIRED', '/evidence_refs', 'WAIVED obligations require evidence.');
    }
    if (!obligation.human_approval_ref) {
      return error('OBLIGATION_APPROVAL_REQUIRED', '/human_approval_ref', 'WAIVED obligations require a human approval reference.');
    }
  }
  if (obligation.status === 'SUPERSEDED' && !obligation.successor_obligation_ref) {
    return error('OBLIGATION_SUCCESSOR_REQUIRED', '/successor_obligation_ref', 'SUPERSEDED obligations require a qualified successor.');
  }
  return null;
};

const semanticRequirementPaths = (obligation) => {
  if (obligation?.status === 'OPEN') {
    return new Set([
      '/',
      '/resolution_ref',
      '/human_approval_ref',
      '/successor_obligation_ref',
    ]);
  }
  if (obligation?.status === 'RESOLVED') return new Set(['/', '/evidence_refs', '/resolution_ref']);
  if (obligation?.status === 'WAIVED') return new Set(['/', '/evidence_refs', '/human_approval_ref']);
  if (obligation?.status === 'SUPERSEDED') return new Set(['/', '/successor_obligation_ref']);
  return new Set();
};

const isTransitionRequirementError = (obligation, allowed, { path, message }) => {
  if (path === '/') return message.endsWith('must match "then" schema');
  if (!allowed.has(path)) return false;
  if (obligation.status === 'OPEN') return message.endsWith('boolean schema is false');
  if (path === '/evidence_refs') return message.endsWith('must NOT have fewer than 1 items');
  return message.includes('must have required property');
};

const validateInstance = (label, value, allowTransitionRequirements = false) => {
  const result = validateJson('obligation-instance', value);
  if (result.ok) return null;
  if (allowTransitionRequirements) {
    const allowed = semanticRequirementPaths(value);
    const specificErrors = result.errors.filter(({ path }) => path !== '/');
    if (specificErrors.length > 0 && result.errors.every((entry) => (
      isTransitionRequirementError(value, allowed, entry)
    ))) return null;
  }
  return fail(result.errors.map(({ code, path }) => createError(
    code,
    `/${label}${path === '/' ? '' : path}`,
    `Invalid ${label} obligation instance.`,
  )));
};

export const validateObligationTransition = (previous, next) => {
  const previousValidation = previous === null ? null : validateInstance('previous', previous);
  if (previousValidation) return previousValidation;
  const nextValidation = validateInstance('next', next, true);
  if (nextValidation) return nextValidation;

  if (!previous) {
    if (next.status !== 'OPEN') {
      return error('OBLIGATION_CREATION_OPEN_REQUIRED', '/status', 'Obligation creation must start OPEN.');
    }
    return validateOutcomeRequirements(next) ?? ok(next);
  }

  if (previous.obligation_id !== next.obligation_id) {
    return error('OBLIGATION_ID_MISMATCH', '/obligation_id', 'Obligation transition must preserve obligation_id.');
  }

  if (previous.status === 'SUPERSEDED') {
    return error('OBLIGATION_TERMINAL', '/status', 'SUPERSEDED obligations are terminal.');
  }

  if (previous.status === next.status) {
    return validateOutcomeRequirements(next) ?? ok(next);
  }

  if (previous.status === 'OPEN') {
    if (!['RESOLVED', 'WAIVED', 'SUPERSEDED'].includes(next.status)) {
      return error('OBLIGATION_TRANSITION_INVALID', '/status', `Invalid obligation transition: OPEN -> ${next.status}`);
    }
    return validateOutcomeRequirements(next) ?? ok(next);
  }

  if (next.status === 'OPEN' && ['RESOLVED', 'WAIVED'].includes(previous.status)) {
    if (!hasNewTrigger(previous, next)) {
      return error('OBLIGATION_REOPEN_TRIGGER_REQUIRED', '/trigger_refs', 'Reopening requires a new trigger.');
    }
    return validateOutcomeRequirements(next) ?? ok(next);
  }

  return error(
    'OBLIGATION_TRANSITION_INVALID',
    '/status',
    `Invalid obligation transition: ${previous.status} -> ${next.status}`,
  );
};

export const validateDeliveryTransition = (previous, next) => {
  if (previous.artifact_id !== next.artifact_id) {
    return error('DELIVERY_ID_MISMATCH', '/artifact_id', 'Delivery transition must preserve artifact_id.');
  }
  if (previous.primary_route !== next.primary_route) {
    return error('PRIMARY_ROUTE_IMMUTABLE', '/primary_route', 'Durable delivery primary_route is immutable.');
  }
  return ok(next);
};
