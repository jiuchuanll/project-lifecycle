import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  evaluateGoldObservation,
  validateGoldScenarios,
} from './gold/invariants.mjs';

const scenariosUrl = new URL('./gold/scenarios.json', import.meta.url);
const scenarios = JSON.parse(await readFile(scenariosUrl, 'utf8'));

const FAMILY_IDS = [
  'CLOSURE_MIGRATION_ARCHIVE',
  'CROSS_DOMAIN_FEEDBACK_PRD',
  'NOISY_INTENT_ROUTING',
  'PARALLEL_MULTI_REPOSITORY_DELIVERY',
  'PROFESSIONAL_DOMAIN_MATERIALIZATION',
  'RECONNAISSANCE_CALIBRATION',
  'TOPOLOGY_CONSTRAINT_EVOLUTION',
];

test('defines exactly seven complete host-neutral gold scenario families', () => {
  const result = validateGoldScenarios(scenarios);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.map((scenario) => scenario.family).sort(), FAMILY_IDS);
  assert.deepEqual(
    [...new Set(result.value.map((scenario) => scenario.workflow_type))].sort(),
    ['ASSET_MODEL_WORKFLOW', 'CODE_SERVICE', 'FRONTEND_APPLICATION'],
  );
});

test('keeps every fixture bounded and every scenario positive plus adversarial', () => {
  const result = validateGoldScenarios(scenarios);
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const scenario of result.value) {
    assert.ok(scenario.fixture.files.length > 0, scenario.scenario_id);
    assert.ok(scenario.fixture.files.length <= scenario.fixture.max_entries, scenario.scenario_id);
    assert.equal(scenario.positive_path.expected_result, 'PASS');
    assert.equal(scenario.adversarial_path.expected_result, 'FAIL');
  }
});

test('accepts the declared positive observation for every scenario', () => {
  for (const scenario of scenarios) {
    const result = evaluateGoldObservation(scenario, scenario.positive_path.observation);
    assert.equal(result.ok, true, `${scenario.scenario_id}: ${JSON.stringify(result)}`);
    assert.equal(result.value.status, 'PASS');
  }
});

test('rejects every declared adversarial observation with its critical error', () => {
  for (const scenario of scenarios) {
    const observation = {
      ...structuredClone(scenario.positive_path.observation),
      ...structuredClone(scenario.adversarial_path.observation),
    };
    const result = evaluateGoldObservation(scenario, observation);
    assert.equal(result.ok, true, `${scenario.scenario_id}: ${JSON.stringify(result)}`);
    assert.equal(result.value.status, 'FAIL');
    assert.ok(
      result.value.critical_errors.includes(scenario.adversarial_path.critical_error),
      `${scenario.scenario_id}: ${JSON.stringify(result.value)}`,
    );
  }
});

test('fails closed for all six release-blocking semantic errors', () => {
  const base = structuredClone(scenarios[0]);
  const cases = [
    ['INVENTED_EVIDENCE_OR_APPROVAL', { used_evidence_refs: ['evidence:invented'] }],
    ['INVENTED_EVIDENCE_OR_APPROVAL', { used_approval_refs: ['approval:invented'] }],
    ['WRONG_FACT_OWNER', { fact_ownership: [{ fact_id: 'fact:repo-shape', owner_id: 'domain:wrong' }] }],
    ['MISSING_HUMAN_GATE', { observed_human_gates: [] }],
    ['HISTORY_REWRITE', { history_rewritten: true }],
    ['INTENT_AS_IMPLEMENTATION', { intent_materialized_without_acceptance: true }],
    ['PARTIAL_AS_WHOLE_COMPLETION', { completed_scope: 'WHOLE', completed_unit_ids: [] }],
  ];

  for (const [expected, override] of cases) {
    const observation = { ...structuredClone(base.positive_path.observation), ...override };
    const result = evaluateGoldObservation(base, observation);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.status, 'FAIL');
    assert.ok(result.value.critical_errors.includes(expected), JSON.stringify(result.value));
  }
});

test('rejects unbounded fixtures and incomplete semantic contracts', () => {
  const unbounded = structuredClone(scenarios);
  unbounded[0].fixture.max_entries = 1;
  assert.equal(validateGoldScenarios(unbounded).errors[0].code, 'GOLD_FIXTURE_UNBOUNDED');

  const incomplete = structuredClone(scenarios);
  delete incomplete[0].explicit_unknowns;
  assert.equal(validateGoldScenarios(incomplete).errors[0].code, 'GOLD_FIELD_MISSING');
});
