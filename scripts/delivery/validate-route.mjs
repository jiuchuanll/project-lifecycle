import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { assertVocabularyValue } from '../lib/vocabulary.mjs';

const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowedKeys = new Set([
  'primary_route',
  'stop',
  'evidence_refs',
  'knowledge_effect_refs',
  'normalized_alias_refs',
]);
const stopKeys = new Set(['code', 'question_ref', 'ambiguity_refs']);

const normalizedRefs = (value, path, { required = false, minimum = 0 } = {}) => {
  if (!Array.isArray(value) || value.length < Math.max(required ? 1 : 0, minimum) || value.length > 50) {
    return failure(required ? 'ROUTE_EVIDENCE_MISSING' : 'ROUTE_REFERENCE_INVALID', path, 'Route references must be a bounded array.');
  }
  if (value.some((entry) => !isSafeReference(entry))) {
    return failure('ROUTE_REFERENCE_INVALID', path, 'Route references must be safe bounded references.');
  }
  return ok([...new Set(value)].sort(compareCodePoints));
};

export const validateRoute = (candidate = {}) => {
  if (!record(candidate) || Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return failure('ROUTE_INPUT_INVALID', '/', 'Route decisions accept only the closed structural fields.');
  }
  if (Array.isArray(candidate.primary_route)) {
    return failure('ROUTE_CARDINALITY_INVALID', '/primary_route', 'Exactly one peer primary route may be supplied.');
  }

  const hasRoute = candidate.primary_route !== undefined && candidate.primary_route !== null;
  const hasStop = candidate.stop !== undefined && candidate.stop !== null;
  if (!hasRoute && !hasStop) {
    return failure('ROUTE_MISSING', '/primary_route', 'The validator cannot choose a missing primary route.');
  }
  if (hasRoute && hasStop) {
    return failure('ROUTE_STOP_CONFLICT', '/stop', 'A temporary stop cannot coexist with an active primary route.');
  }

  if (hasStop) {
    if (!record(candidate.stop)
      || Object.keys(candidate.stop).some((key) => !stopKeys.has(key))
      || candidate.stop.code !== 'NEEDS_USER') {
      return failure('ROUTE_STOP_INVALID', '/stop', 'Only the temporary NEEDS_USER route stop is accepted.');
    }
    if (!isSafeReference(candidate.stop.question_ref)) {
      return failure('ROUTE_REFERENCE_INVALID', '/stop/question_ref', 'The user question must be a safe bounded reference.');
    }
    const ambiguity = normalizedRefs(candidate.stop.ambiguity_refs, '/stop/ambiguity_refs', { minimum: 2 });
    if (!ambiguity.ok) return ambiguity;
    return ok({
      primary_route: null,
      stop: { ...candidate.stop, ambiguity_refs: ambiguity.value },
      evidence_refs: [],
      knowledge_effect_refs: [],
      normalized_alias_refs: [],
    });
  }

  const vocabulary = assertVocabularyValue('primary_routes', candidate.primary_route, '/primary_route');
  if (!vocabulary.ok) {
    return failure('ROUTE_VALUE_INVALID', '/primary_route', 'Primary route must use the shared closed vocabulary.');
  }
  const evidence = normalizedRefs(candidate.evidence_refs, '/evidence_refs', { required: true });
  if (!evidence.ok) return evidence;
  const knowledgeEffects = normalizedRefs(candidate.knowledge_effect_refs ?? [], '/knowledge_effect_refs');
  if (!knowledgeEffects.ok) return knowledgeEffects;
  const aliases = normalizedRefs(candidate.normalized_alias_refs ?? [], '/normalized_alias_refs');
  if (!aliases.ok) return aliases;

  return ok({
    primary_route: candidate.primary_route,
    stop: null,
    evidence_refs: evidence.value,
    knowledge_effect_refs: knowledgeEffects.value,
    normalized_alias_refs: aliases.value,
  });
};
