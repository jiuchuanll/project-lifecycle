import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeLocator, isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';

const failure = (path) => fail([createError('TRACE_INVALID', path, 'Native trace metadata is incomplete or invalid.')]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value)
  && Object.keys(value).sort(compareCodePoints).join('\0') === [...keys].sort(compareCodePoints).join('\0');
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function validateTrace(value) {
  const keys = [
    'allowed_context_ids', 'ended_at', 'fixture_hash', 'host', 'invariant_evaluation',
    'knowledge_baseline', 'model', 'parameters', 'plugin', 'raw_output_locator', 'result',
    'run_id', 'run_number', 'scenario_id', 'started_at',
  ];
  if (!exactKeys(value, keys)) return failure('/');
  if (!isSafeReference(value.run_id) || !isSafeReference(value.scenario_id)
    || !Number.isInteger(value.run_number) || value.run_number < 1 || value.run_number > 3
    || !exactKeys(value.plugin, ['commit', 'version']) || value.plugin.version !== '0.1.0'
    || !/^[0-9a-f]{40,64}$/u.test(value.plugin.commit ?? '')
    || !exactKeys(value.host, ['id', 'version']) || !isSafeReference(value.host.id) || !isSafeReference(value.host.version)
    || !exactKeys(value.model, ['identity', 'revision'])
    || !isSafeReference(value.model.identity) || !isSafeReference(value.model.revision)
    || !record(value.parameters)
    || !/^sha256:[0-9a-f]{64}$/u.test(value.fixture_hash ?? '')
    || !isSafeReference(value.knowledge_baseline)
    || !iso(value.started_at) || !iso(value.ended_at) || Date.parse(value.ended_at) < Date.parse(value.started_at)
    || !Array.isArray(value.allowed_context_ids)
    || value.allowed_context_ids.some((id) => !isSafeReference(id))
    || new Set(value.allowed_context_ids).size !== value.allowed_context_ids.length
    || !['PASS', 'FAIL', 'NEEDS_REVIEW', 'UNAVAILABLE'].includes(value.result)
    || !isSafeLocator(value.raw_output_locator)
    || !record(value.invariant_evaluation)
    || !['PASS', 'FAIL', 'PENDING'].includes(value.invariant_evaluation.status)
    || !Array.isArray(value.invariant_evaluation.evidence_refs)
    || value.invariant_evaluation.evidence_refs.some((ref) => !isSafeReference(ref))) {
    return failure('/');
  }
  return ok(Object.freeze(structuredClone(value)));
}
