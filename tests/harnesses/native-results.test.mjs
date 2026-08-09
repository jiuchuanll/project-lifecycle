import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import {
  extractGoldObservation,
  validateNativeResults,
} from '../../scripts/harnesses/native-results.mjs';
import { validateTrace } from '../../scripts/harnesses/trace.mjs';

const scenarios = JSON.parse(await readFile(new URL('../behavior/gold/scenarios.json', import.meta.url), 'utf8'));
const matrix = JSON.parse(await readFile(new URL('./support-matrix.json', import.meta.url), 'utf8'));

const observation = scenarios[0].positive_path.observation;
const trace = (host, scenarioId, runNumber, semanticStatus = 'PASS') => ({
  run_id: `${host}-${scenarioId}-${runNumber}`,
  scenario_id: scenarioId,
  run_number: runNumber,
  plugin: { version: '0.1.0', commit: 'a'.repeat(40) },
  host: { id: host, version: '1.0.0' },
  model: { identity: 'test-model', revision: 'test-model-1' },
  parameters: { temperature: 0 },
  fixture_hash: `sha256:${'b'.repeat(64)}`,
  knowledge_baseline: 'baseline:test',
  started_at: '2026-08-09T00:00:00.000Z',
  ended_at: '2026-08-09T00:01:00.000Z',
  allowed_context_ids: [],
  result: semanticStatus === 'PASS' ? 'PASS' : 'NEEDS_REVIEW',
  raw_output_locator: `traces/${host}/${scenarioId}/${runNumber}.raw.json`,
  invariant_evaluation: { status: 'PASS', evidence_refs: [`invariant:${scenarioId}:${runNumber}`] },
  semantic_review: {
    status: semanticStatus,
    reviewer_ref: semanticStatus === 'PENDING' ? null : 'reviewer:human',
    reason_ref: semanticStatus === 'PENDING' ? null : `review:${scenarioId}:${runNumber}`,
    evidence_refs: semanticStatus === 'PENDING' ? [] : [`raw:${scenarioId}:${runNumber}`],
  },
});

test('extracts one observation from Codex JSON and Kimi fenced output', () => {
  assert.deepEqual(extractGoldObservation(JSON.stringify(observation)).value, observation);
  const kimi = `analysis text\n\n\`\`\`json\n${JSON.stringify(observation, null, 2)}\n\`\`\`\nresume text`;
  assert.deepEqual(extractGoldObservation(kimi).value, observation);
});

test('rejects ambiguous or missing native observations', () => {
  assert.equal(extractGoldObservation('no json result').errors[0].code, 'NATIVE_OBSERVATION_INVALID');
  const doubled = `${JSON.stringify(observation)}\n${JSON.stringify(observation)}`;
  assert.equal(extractGoldObservation(doubled).errors[0].code, 'NATIVE_OBSERVATION_AMBIGUOUS');
});

test('requires semantic review metadata in every retained trace', () => {
  assert.equal(validateTrace(trace('codex', scenarios[0].scenario_id, 1)).ok, true);
  const missing = trace('codex', scenarios[0].scenario_id, 1);
  delete missing.semantic_review;
  assert.equal(validateTrace(missing).ok, false);
});

test('requires three independently reviewed passes for every scenario before support', () => {
  const traces = scenarios.flatMap((scenario) => [1, 2, 3].map((run) => trace('codex', scenario.scenario_id, run)));
  const supported = {
    schema_version: 1,
    plugin_version: '0.1.0',
    hosts: { codex: { status: 'SUPPORTED', observed_version: '1.0.0', evidence_refs: ['trace-set:codex'] } },
  };
  assert.equal(validateNativeResults({ scenarios, matrix: supported, traces }).ok, true);

  assert.equal(validateNativeResults({ scenarios, matrix: supported, traces: traces.slice(1) }).ok, false);
  const pending = structuredClone(traces);
  pending[0] = trace('codex', scenarios[0].scenario_id, 1, 'PENDING');
  assert.equal(validateNativeResults({ scenarios, matrix: supported, traces: pending }).ok, false);
});

test('keeps the current honest non-supported matrix valid without inventing support', () => {
  const result = validateNativeResults({ scenarios, matrix, traces: [] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.supported_hosts, []);
});

test('records the retained native run set without claiming unsupported hosts', async () => {
  const traceRoot = new URL('./traces/', import.meta.url);
  const traces = [];
  for (const host of await readdir(traceRoot)) {
    for (const scenario of await readdir(new URL(`${host}/`, traceRoot))) {
      const scenarioRoot = new URL(`${host}/${scenario}/`, traceRoot);
      for (const file of (await readdir(scenarioRoot)).filter((name) => name.endsWith('.jsonl'))) {
        traces.push(JSON.parse(await readFile(new URL(file, scenarioRoot), 'utf8')));
      }
    }
  }
  const result = validateNativeResults({ scenarios, matrix, traces });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.trace_count, 42);
  assert.deepEqual(result.value.supported_hosts, []);
  assert.equal(matrix.hosts.codex.status, 'FAILED');
  assert.equal(matrix.hosts.kimi.status, 'FAILED');
});
