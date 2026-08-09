import assert from 'node:assert/strict';
import test from 'node:test';

import archiveAccessReceiptSchema from '../../scripts/schemas/archive-access-receipt.schema.json' with { type: 'json' };
import capabilityFrontmatterSchema from '../../scripts/schemas/capability-frontmatter.schema.json' with { type: 'json' };
import contextReceiptSchema from '../../scripts/schemas/context-receipt.schema.json' with { type: 'json' };
import deliveryFrontmatterSchema from '../../scripts/schemas/delivery-frontmatter.schema.json' with { type: 'json' };
import obligationInstanceSchema from '../../scripts/schemas/obligation-instance.schema.json' with { type: 'json' };
import projectMapSchema from '../../scripts/schemas/project-map.schema.json' with { type: 'json' };
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

test('rejects BigInt and cyclic unknown inputs without diagnostic serialization failures', () => {
  const cyclicKind = {};
  cyclicKind.self = cyclicKind;
  const cyclicValue = {};
  cyclicValue.self = cyclicValue;

  const cases = [
    { kind: 1n, value: 'PRD_DELIVERY', path: '/kind', code: 'VOCAB_UNKNOWN_KIND' },
    { kind: 'primary_routes', value: 1n, path: '/value', code: 'VOCAB_UNKNOWN_VALUE' },
    { kind: cyclicKind, value: 'PRD_DELIVERY', path: '/kind', code: 'VOCAB_UNKNOWN_KIND' },
    { kind: 'primary_routes', value: cyclicValue, path: '/value', code: 'VOCAB_UNKNOWN_VALUE' },
  ];

  for (const { kind, value, path, code } of cases) {
    assert.doesNotThrow(() => assertVocabularyValue(kind, value, path));
    const result = assertVocabularyValue(kind, value, path);

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, code);
    assert.equal(result.errors[0].path, path);
    assert.deepEqual(Object.keys(result.errors[0]), ['code', 'path', 'message']);
  }
});

test('rejects hostile vocabulary property keys without coercion', () => {
  const hostileKind = {
    [Symbol.toPrimitive]() {
      throw new Error('must not coerce property key');
    },
  };

  assert.doesNotThrow(() => assertVocabularyValue(hostileKind, 'PRD_DELIVERY', '/kind'));
  assert.deepEqual(assertVocabularyValue(hostileKind, 'PRD_DELIVERY', '/kind').errors[0], {
    code: 'VOCAB_UNKNOWN_KIND',
    path: '/kind',
    message: 'Unknown vocabulary kind: {}',
  });
});

test('keeps every schema-bound core vocabulary exactly aligned with core.json', () => {
  const vocabulary = loadCoreVocabulary();
  const bindings = {
    archive_reasons: archiveAccessReceiptSchema.properties.reason.enum,
    constraint_scopes: projectMapSchema.$defs.constraint.properties.scope.enum,
    delivery_retention_tiers: deliveryFrontmatterSchema.properties.retention_tier.enum,
    domain_states: projectMapSchema.$defs.domain.properties.domain_state.enum,
    knowledge_states: capabilityFrontmatterSchema.properties.knowledge_state.enum,
    node_kinds: projectMapSchema.$defs.domain.properties.kind.enum,
    obligation_statuses: obligationInstanceSchema.properties.status.enum,
    primary_routes: deliveryFrontmatterSchema.properties.primary_route.enum,
    relationship_kinds: projectMapSchema.$defs.relationship.properties.kind.enum,
    secondary_obligation_kinds: obligationInstanceSchema.properties.kind.enum,
  };

  assert.deepEqual(Object.keys(bindings), [
    'archive_reasons',
    'constraint_scopes',
    'delivery_retention_tiers',
    'domain_states',
    'knowledge_states',
    'node_kinds',
    'obligation_statuses',
    'primary_routes',
    'relationship_kinds',
    'secondary_obligation_kinds',
  ]);
  for (const [kind, values] of Object.entries(bindings)) {
    assert.deepEqual(values, vocabulary[kind], `${kind} must be sourced from core.json`);
  }

  const contextStopCodes = contextReceiptSchema.properties.stop.properties.code.enum;
  assert.deepEqual(
    contextStopCodes.filter((code) => vocabulary.route_stops.includes(code)),
    vocabulary.route_stops,
    'route_stops must remain the route-specific subset of Context Receipt stop codes',
  );

  const explicitlyUnbound = ['constraint_change_classes'];
  assert.deepEqual(
    [...Object.keys(bindings), 'route_stops', ...explicitlyUnbound].toSorted(),
    Object.keys(vocabulary).toSorted(),
    'every core vocabulary must have an exact schema binding, subset binding, or explicit no-schema status',
  );
});
