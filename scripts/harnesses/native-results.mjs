import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateTrace } from './trace.mjs';

const OBSERVATION_FIELDS = [
  'archive_paths_read', 'completed_scope', 'completed_unit_ids', 'durable_files_written',
  'fact_ownership', 'history_rewritten', 'intent_materialized_without_acceptance',
  'observed_human_gates', 'route', 'selected_context_ids', 'selected_solution_id', 'stop',
  'unknowns_reported', 'used_approval_refs', 'used_evidence_refs',
];
const HOST_STATUSES = new Set(['FAILED', 'NOT_TESTED', 'SUPPORTED']);
const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value)
  && Object.keys(value).sort(compareCodePoints).join('\0') === [...keys].sort(compareCodePoints).join('\0');

const jsonObjects = (source) => {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { objects.push(JSON.parse(source.slice(start, index + 1))); } catch { /* ignore malformed candidate */ }
        start = -1;
      }
    }
  }
  return objects;
};

export function extractGoldObservation(source) {
  if (typeof source !== 'string' || source.length === 0 || source.length > 1_048_576) {
    return failure('NATIVE_OBSERVATION_INVALID', '/', 'Native output must contain one bounded observation object.');
  }
  const candidates = jsonObjects(source).filter((candidate) => exactKeys(candidate, OBSERVATION_FIELDS));
  if (candidates.length === 0) return failure('NATIVE_OBSERVATION_INVALID', '/', 'Native output does not contain a complete observation object.');
  if (candidates.length !== 1) return failure('NATIVE_OBSERVATION_AMBIGUOUS', '/', 'Native output contains more than one complete observation object.');
  return ok(candidates[0]);
}

export function validateNativeResults({ scenarios, matrix, traces } = {}) {
  if (!Array.isArray(scenarios) || scenarios.length !== 7 || !record(matrix)
    || matrix.schema_version !== 1 || !isSafeReference(matrix.plugin_version)
    || !record(matrix.hosts) || !Array.isArray(traces)) {
    return failure('NATIVE_RESULTS_INVALID', '/', 'Native result set is incomplete.');
  }
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.scenario_id));
  if (scenarioIds.size !== 7) return failure('NATIVE_RESULTS_INVALID', '/scenarios', 'Seven unique scenarios are required.');
  for (const [host, entry] of Object.entries(matrix.hosts)) {
    if (!isSafeReference(host) || !exactKeys(entry, ['evidence_refs', 'observed_version', 'status'])
      || !HOST_STATUSES.has(entry.status)
      || (entry.observed_version !== null && !isSafeReference(entry.observed_version))
      || !Array.isArray(entry.evidence_refs) || entry.evidence_refs.some((ref) => !isSafeReference(ref))) {
      return failure('NATIVE_MATRIX_INVALID', `/hosts/${host}`, 'Host support entry is invalid.');
    }
  }

  const seen = new Set();
  const byHost = new Map();
  for (const [index, candidate] of traces.entries()) {
    const result = validateTrace(candidate);
    if (!result.ok) return failure('NATIVE_TRACE_INVALID', `/traces/${index}`, 'Retained native trace is invalid.');
    if (!Object.hasOwn(matrix.hosts, candidate.host.id) || !scenarioIds.has(candidate.scenario_id)) {
      return failure('NATIVE_TRACE_SCOPE_INVALID', `/traces/${index}`, 'Trace host and scenario must exist in the release matrix.');
    }
    const key = `${candidate.host.id}\0${candidate.scenario_id}\0${candidate.run_number}`;
    if (seen.has(key)) return failure('NATIVE_TRACE_DUPLICATE', `/traces/${index}`, 'Host, scenario, and run identity must be unique.');
    seen.add(key);
    const hostTraces = byHost.get(candidate.host.id) ?? [];
    hostTraces.push(candidate);
    byHost.set(candidate.host.id, hostTraces);
  }

  const supportedHosts = [];
  for (const [host, entry] of Object.entries(matrix.hosts)) {
    const hostTraces = byHost.get(host) ?? [];
    if (entry.status !== 'SUPPORTED') {
      if (hostTraces.length > 0 && entry.evidence_refs.length === 0) {
        return failure('NATIVE_MATRIX_EVIDENCE_MISSING', `/hosts/${host}/evidence_refs`, 'Tested non-supported hosts must retain evidence refs.');
      }
      continue;
    }
    if (entry.observed_version === null || entry.evidence_refs.length === 0 || hostTraces.length !== scenarios.length * 3) {
      return failure('NATIVE_SUPPORT_UNPROVEN', `/hosts/${host}`, 'Supported hosts require an exact complete trace set.');
    }
    for (const scenario of scenarios) {
      const runs = hostTraces.filter((trace) => trace.scenario_id === scenario.scenario_id)
        .sort((left, right) => left.run_number - right.run_number);
      if (runs.length !== 3 || runs.some((trace, index) => trace.run_number !== index + 1
        || trace.plugin.version !== matrix.plugin_version
        || trace.host.version !== entry.observed_version || trace.result !== 'PASS'
        || trace.invariant_evaluation.status !== 'PASS' || trace.semantic_review.status !== 'PASS')) {
        return failure('NATIVE_SUPPORT_UNPROVEN', `/hosts/${host}`, 'Every scenario requires three independent structural and semantic passes.');
      }
    }
    supportedHosts.push(host);
  }
  supportedHosts.sort(compareCodePoints);
  return ok({ supported_hosts: supportedHosts, trace_count: traces.length });
}
