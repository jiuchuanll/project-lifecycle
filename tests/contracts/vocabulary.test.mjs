import assert from 'node:assert/strict';
import test from 'node:test';

import { ok } from '../../scripts/lib/result.mjs';
import { assertVocabularyValue, loadCoreVocabulary } from '../../scripts/lib/vocabulary.mjs';

test('loads the exact core vocabulary used by shared validators', () => {
  assert.deepEqual(loadCoreVocabulary(), {
    primary_routes: ['KNOWLEDGE_UPDATE', 'NON_PRD_DELIVERY', 'OUTSIDE_PLUGIN', 'PRD_DELIVERY'],
    route_stops: ['NEEDS_USER'],
    secondary_obligation_kinds: [
      'CONFLICT_RESOLUTION_REQUIRED',
      'CROSS_DOMAIN_COORDINATION_REQUIRED',
      'DEPENDENCY_RESOLUTION_REQUIRED',
      'KNOWLEDGE_CHANGE_HANDOFF_REQUIRED',
      'KNOWLEDGE_READINESS_REQUIRED',
      'MULTI_REPOSITORY_COORDINATION_REQUIRED',
    ],
    obligation_statuses: ['OPEN', 'RESOLVED', 'SUPERSEDED', 'WAIVED'],
    domain_states: ['confirmed', 'materialized', 'merged', 'retired'],
    knowledge_states: ['current', 'in-progress', 'proposed', 'superseded'],
    node_kinds: ['capability', 'domain', 'project_module'],
    relationship_kinds: ['coordinates_with', 'depends_on', 'governed_by'],
    constraint_scopes: ['descendants', 'selected_descendants', 'self'],
    constraint_change_classes: ['REPLACEMENT', 'SEMANTIC', 'WORDING'],
    delivery_retention_tiers: ['active', 'archive', 'closed-summary'],
    archive_reasons: ['AUDIT', 'EXPLICIT_ID', 'HISTORICAL_COMPARISON', 'INCIDENT', 'REGRESSION'],
  });
});

test('accepts known vocabulary values', () => {
  assert.deepEqual(
    assertVocabularyValue('primary_routes', 'PRD_DELIVERY', '/primary_route'),
    ok('PRD_DELIVERY'),
  );
});

test('rejects unknown vocabulary values with a deterministic error code', () => {
  assert.deepEqual(
    assertVocabularyValue('primary_routes', 'FIFTH_ROUTE', '/primary_route').errors[0],
    {
      code: 'VOCAB_UNKNOWN_VALUE',
      path: '/primary_route',
      message: 'Unknown value for vocabulary kind "primary_routes": "FIFTH_ROUTE"',
    },
  );
  assert.equal(
    assertVocabularyValue('obligation_statuses', 'BLOCKED', '/status').errors[0].code,
    'VOCAB_UNKNOWN_VALUE',
  );
});

test('rejects unknown vocabulary kinds without throwing', () => {
  assert.doesNotThrow(() => assertVocabularyValue('future_routes', 'PRD_DELIVERY', '/primary_route'));
  assert.deepEqual(
    assertVocabularyValue('future_routes', 'PRD_DELIVERY', '/primary_route').errors[0],
    {
      code: 'VOCAB_UNKNOWN_KIND',
      path: '/primary_route',
      message: 'Unknown vocabulary kind: "future_routes"',
    },
  );
});
