import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { reclassifyRoute } from '../../scripts/delivery/reclassify-route.mjs';
import { validateRoute } from '../../scripts/delivery/validate-route.mjs';

const casesUrl = new URL('../fixtures/delivery/routing/route-cases.json', import.meta.url);
const route = (primaryRoute, overrides = {}) => ({
  primary_route: primaryRoute,
  evidence_refs: [`decision:${String(primaryRoute).toLowerCase()}`],
  knowledge_effect_refs: [],
  normalized_alias_refs: [],
  ...overrides,
});

test('validates all four primary routes and never invents a missing route', async () => {
  const cases = JSON.parse(await readFile(casesUrl, 'utf8'));
  for (const fixture of cases) {
    const result = validateRoute({
      primary_route: fixture.primary_route,
      evidence_refs: fixture.evidence_refs,
      knowledge_effect_refs: [],
      normalized_alias_refs: [],
    });
    assert.equal(result.ok ? 'OK' : result.errors[0].code, fixture.expected, fixture.name);
  }
});

test('keeps NEEDS_USER temporary and mutually exclusive with a primary route', () => {
  const paused = validateRoute({
    evidence_refs: [],
    knowledge_effect_refs: [],
    normalized_alias_refs: [],
    stop: {
      code: 'NEEDS_USER',
      question_ref: 'question:wiki-or-source',
      ambiguity_refs: ['domain-candidate:source', 'domain-candidate:wiki'],
    },
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.value.primary_route, null);
  assert.equal(paused.value.stop.code, 'NEEDS_USER');

  const conflict = validateRoute({
    ...route('PRD_DELIVERY'),
    stop: { code: 'NEEDS_USER', question_ref: 'question:route', ambiguity_refs: ['route:a', 'route:b'] },
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.errors[0].code, 'ROUTE_STOP_CONFLICT');
});

test('preserves one delivery route with a separate knowledge effect', () => {
  const result = validateRoute(route('PRD_DELIVERY', {
    evidence_refs: ['request:wiki-redesign'],
    knowledge_effect_refs: ['knowledge-effect:wiki-layout-fact'],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.value.primary_route, 'PRD_DELIVERY');
  assert.deepEqual(result.value.knowledge_effect_refs, ['knowledge-effect:wiki-layout-fact']);
});

test('accepts a grounded harmless typo normalization but pauses for genuine domain ambiguity', () => {
  const typo = validateRoute(route('PRD_DELIVERY', {
    evidence_refs: ['map:wiki-workspace', 'request:wkii-layout'],
    normalized_alias_refs: ['alias:wkii-to-wiki'],
  }));
  assert.equal(typo.ok, true);

  const ambiguous = validateRoute({
    evidence_refs: [],
    knowledge_effect_refs: [],
    normalized_alias_refs: [],
    stop: {
      code: 'NEEDS_USER',
      question_ref: 'question:workspace-owner',
      ambiguity_refs: ['domain-candidate:inbox', 'domain-candidate:wiki'],
    },
  });
  assert.equal(ambiguous.ok, true);
});

test('rejects missing evidence, unsafe references, unknown fields, and non-user stops', () => {
  for (const [candidate, code] of [
    [route('PRD_DELIVERY', { evidence_refs: [] }), 'ROUTE_EVIDENCE_MISSING'],
    [route('PRD_DELIVERY', { evidence_refs: ['https://user:secret@example.com'] }), 'ROUTE_REFERENCE_INVALID'],
    [{ ...route('PRD_DELIVERY'), selected_by_script: true }, 'ROUTE_INPUT_INVALID'],
    [{ evidence_refs: [], knowledge_effect_refs: [], normalized_alias_refs: [], stop: { code: 'NEEDS_EVIDENCE', question_ref: 'q:a', ambiguity_refs: ['a:b'] } }, 'ROUTE_STOP_INVALID'],
  ]) {
    const result = validateRoute(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, code);
  }
});

test('replaces a pre-materialization decision transiently with no correction history', () => {
  const result = reclassifyRoute({
    current: { materialized: false, primary_route: 'NON_PRD_DELIVERY' },
    replacement: route('PRD_DELIVERY'),
    correction_ref: 'clarification:product-scope',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    status: 'transient-replacement',
    decision: validateRoute(route('PRD_DELIVERY')).value,
  });
});

test('requires confirmation when inferred non-PRD work becomes a durable PRD successor', () => {
  const base = {
    current: {
      materialized: true,
      primary_route: 'NON_PRD_DELIVERY',
      owner_ref: 'delivery:non-prd-wiki-repair',
    },
    replacement: route('PRD_DELIVERY'),
    correction_ref: 'clarification:product-outcome',
    former_owner_outcome: { status: 'CANCELLED', outcome_ref: 'closure:non-prd-wiki-repair' },
    successor: { artifact_id: 'prd-wiki-redesign', primary_route: 'PRD_DELIVERY' },
    prd_creation_origin: 'agent_inferred',
  };
  const { prd_creation_origin: ignoredOrigin, ...withoutOrigin } = base;
  assert.equal(reclassifyRoute(withoutOrigin).errors[0].code, 'PRD_ORIGIN_REQUIRED');
  const blocked = reclassifyRoute(base);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errors[0].code, 'PRD_APPROVAL_REQUIRED');

  const approved = reclassifyRoute({ ...base, creation_approval_ref: 'approval:user-prd-upgrade' });
  assert.equal(approved.ok, true);
  assert.deepEqual(approved.value.successor.reclassified_from_refs, ['delivery:non-prd-wiki-repair']);
});

test('retains a closed PRD when correction moves delivery to a non-PRD successor', () => {
  const result = reclassifyRoute({
    current: { materialized: true, primary_route: 'PRD_DELIVERY', owner_ref: 'delivery:prd-wiki-layout' },
    replacement: route('NON_PRD_DELIVERY'),
    correction_ref: 'clarification:technical-repair-only',
    former_owner_outcome: { status: 'WITHDRAWN', outcome_ref: 'closure:prd-wiki-layout' },
    successor: { artifact_id: 'wiki-layout-repair', primary_route: 'NON_PRD_DELIVERY' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.former_owner.retention, 'closed-summary');
  assert.equal(result.value.successor.primary_route, 'NON_PRD_DELIVERY');
});

test('hands closed delivery to knowledge without copying a delivery body', () => {
  const result = reclassifyRoute({
    current: { materialized: true, primary_route: 'PRD_DELIVERY', owner_ref: 'delivery:prd-wiki-layout' },
    replacement: route('KNOWLEDGE_UPDATE'),
    correction_ref: 'clarification:accepted-fact-only',
    former_owner_outcome: { status: 'CLOSED', outcome_ref: 'closure:prd-wiki-layout' },
    knowledge_handoff_refs: ['fact-candidate:wiki-layout'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.successor, null);
  assert.deepEqual(result.value.handoff, {
    target_skill: 'maintain-project-knowledge',
    evidence_refs: ['fact-candidate:wiki-layout'],
  });

  const bodyCopy = reclassifyRoute({
    current: { materialized: true, primary_route: 'PRD_DELIVERY', owner_ref: 'delivery:prd-wiki-layout' },
    replacement: route('KNOWLEDGE_UPDATE'),
    correction_ref: 'clarification:accepted-fact-only',
    former_owner_outcome: { status: 'CLOSED', outcome_ref: 'closure:prd-wiki-layout' },
    knowledge_handoff_refs: ['fact-candidate:wiki-layout'],
    copied_body: 'PRD prose',
  });
  assert.equal(bodyCopy.ok, false);
  assert.equal(bodyCopy.errors[0].code, 'RECLASSIFICATION_INPUT_INVALID');
});

test('closes correction to outside the Plugin and requires later Plugin work to start as new intake', () => {
  const result = reclassifyRoute({
    current: { materialized: true, primary_route: 'NON_PRD_DELIVERY', owner_ref: 'delivery:temporary-repair' },
    replacement: route('OUTSIDE_PLUGIN'),
    correction_ref: 'clarification:no-durable-effect',
    former_owner_outcome: { status: 'CANCELLED', outcome_ref: 'closure:temporary-repair' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.successor, null);
  assert.equal(result.value.handoff, null);

  const resumed = reclassifyRoute({
    current: { materialized: true, primary_route: 'OUTSIDE_PLUGIN', owner_ref: 'closure:temporary-repair' },
    replacement: route('PRD_DELIVERY'),
    correction_ref: 'request:later-plugin-work',
    later_plugin_request: true,
  });
  assert.equal(resumed.ok, false);
  assert.equal(resumed.errors[0].code, 'NEW_INTAKE_REQUIRED');
});

test('rejects in-place durable route edits and any global correction ledger', () => {
  const base = {
    current: { materialized: true, primary_route: 'PRD_DELIVERY', owner_ref: 'delivery:prd-wiki-layout', artifact_id: 'prd-wiki-layout' },
    replacement: route('NON_PRD_DELIVERY'),
    correction_ref: 'clarification:technical-only',
    former_owner_outcome: { status: 'WITHDRAWN', outcome_ref: 'closure:prd-wiki-layout' },
    successor: { artifact_id: 'prd-wiki-layout', primary_route: 'NON_PRD_DELIVERY' },
  };
  assert.equal(reclassifyRoute(base).errors[0].code, 'IN_PLACE_ROUTE_EDIT_FORBIDDEN');
  assert.equal(reclassifyRoute({ ...base, correction_ledger: [] }).errors[0].code, 'RECLASSIFICATION_INPUT_INVALID');
});
