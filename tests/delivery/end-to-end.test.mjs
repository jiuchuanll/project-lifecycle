import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  evaluateDeliveryScenario,
  validateDeliveryScenarios,
} from '../behavior/delivery/invariants.mjs';

const scenariosUrl = new URL('../behavior/delivery/scenarios.json', import.meta.url);
const scenarios = JSON.parse(await readFile(scenariosUrl, 'utf8'));

test('validates the complete bounded Phase 3 behavior matrix', () => {
  const result = validateDeliveryScenarios(scenarios);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map(({ scenario_id }) => scenario_id), [...result.value.map(({ scenario_id }) => scenario_id)].sort());
  assert.deepEqual(result.value.map(({ scenario_id }) => scenario_id), [
    'explicit-prd',
    'genuine-ambiguity',
    'inferred-prd',
    'knowledge-only',
    'main-flow-correction',
    'multi-repository-acceptance',
    'no-prd-fix',
    'normalized-typo',
    'outside-plugin',
    'parallel-conflict',
  ]);
});

test('rejects missing expected and forbidden fields or unbounded context sets', () => {
  const missing = structuredClone(scenarios[0]);
  delete missing.forbidden_outcomes;
  assert.equal(validateDeliveryScenarios([missing]).ok, false);

  const unbounded = structuredClone(scenarios[0]);
  unbounded.allowed_context_ids = Array.from({ length: 51 }, (_, index) => `domain:context-${index}`);
  assert.equal(validateDeliveryScenarios([unbounded]).errors[0].code, 'SCENARIO_CONTEXT_UNBOUNDED');
});

test('drives every explicit route and temporary stop through deterministic invariants', () => {
  for (const scenario of scenarios) {
    const result = evaluateDeliveryScenario(scenario);
    assert.equal(result.ok, true, scenario.scenario_id);
    assert.equal(result.value.primary_route, scenario.expected_primary_route, scenario.scenario_id);
    assert.equal(result.value.stop, scenario.expected_stop, scenario.scenario_id);
    assert.deepEqual(result.value.durable_asset_kinds, scenario.allowed_durable_asset_kinds, scenario.scenario_id);
    assert.deepEqual(result.value.obligation_kinds, scenario.expected_obligation_kinds, scenario.scenario_id);
    assert.equal(result.value.closure, scenario.closure_expectation, scenario.scenario_id);
    assert.equal(result.value.cleanup, scenario.expected_cleanup, scenario.scenario_id);
    assert.equal(result.value.archive_reads, scenario.expected_archive_reads, scenario.scenario_id);
    assert.equal(scenario.forbidden_outcomes.some((outcome) => result.value.outcomes.includes(outcome)), false, scenario.scenario_id);
  }
});

test('allows knowledge candidates only after delivery closure and never applies current knowledge', () => {
  for (const scenario of scenarios) {
    const result = evaluateDeliveryScenario(scenario);
    assert.equal(result.ok, true);
    if (scenario.closure_expectation === 'ALLOWED') {
      assert.equal(result.value.knowledge_candidate_owner, 'run-prd-lifecycle');
      assert.equal(result.value.knowledge_apply_authority, 'maintain-project-knowledge');
    } else {
      assert.equal(result.value.knowledge_candidate_owner, null);
    }
    assert.equal(result.value.current_knowledge_written, false);
    assert.equal(result.value.global_obligations_file, false);
  }
});

test('keeps archive retrieval at zero in ordinary delivery behavior scenarios', () => {
  for (const scenario of scenarios) {
    const result = evaluateDeliveryScenario(scenario);
    assert.equal(result.value.archive_reads, 0);
    assert.equal(result.value.allowed_context_ids.length <= 50, true);
  }
});

test('limits durable files to the exact paired delivery assets derived by the scenario', () => {
  for (const scenario of scenarios) {
    const result = evaluateDeliveryScenario(scenario);
    assert.equal(result.ok, true);
    assert.equal(result.value.allowed_files.length, result.value.durable_asset_kinds.length * 2);
    assert.equal(result.value.allowed_files.every((locator) => locator.startsWith('delivery/')), true);
    assert.equal(result.value.allowed_files.some((locator) => locator.includes('project-map') || locator.includes('obligations.json')), false);
  }
});
