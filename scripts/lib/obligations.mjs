import { createError } from './errors.mjs';
import { fail, ok } from './result.mjs';

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
  if (!hasEvidence(obligation)) {
    return error('OBLIGATION_EVIDENCE_REQUIRED', '/evidence_refs', `${obligation.status} obligations require evidence.`);
  }
  if (obligation.status === 'WAIVED' && !obligation.human_approval_ref) {
    return error('OBLIGATION_APPROVAL_REQUIRED', '/human_approval_ref', 'WAIVED obligations require a human approval reference.');
  }
  if (obligation.status === 'SUPERSEDED' && !obligation.successor_obligation_ref) {
    return error('OBLIGATION_SUCCESSOR_REQUIRED', '/successor_obligation_ref', 'SUPERSEDED obligations require a qualified successor.');
  }
  if (!obligation.resolution_ref) {
    return error('OBLIGATION_RESOLUTION_REQUIRED', '/resolution_ref', `${obligation.status} obligations require a resolution reference.`);
  }
  return null;
};

export const validateObligationTransition = (previous, next) => {
  if (!previous) {
    if (next.status !== 'OPEN') {
      return error('OBLIGATION_CREATION_OPEN_REQUIRED', '/status', 'Obligation creation must start OPEN.');
    }
    return validateOutcomeRequirements(next) ?? ok(next);
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
