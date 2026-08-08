import assert from 'node:assert/strict';
import test from 'node:test';

import { validateJson } from '../../scripts/lib/validate-json.mjs';

const obligationsModule = await import('../../scripts/lib/obligations.mjs').catch(() => ({}));
const { validateDeliveryTransition, validateObligationTransition } = obligationsModule;

const open = {
  obligation_id: 'shared-contract',
  kind: 'DEPENDENCY_RESOLUTION_REQUIRED',
  status: 'OPEN',
  trigger_refs: ['prd-runtime-v1'],
  scope_refs: ['runtime-core'],
  responsible_refs: ['prd-shared-contracts'],
  required_before: 'implementation',
  evidence_refs: [],
};

const resolved = {
  ...open,
  status: 'RESOLVED',
  evidence_refs: ['test-shared-contract'],
  resolution_ref: 'resolution-shared-contract',
};

const waived = {
  ...open,
  status: 'WAIVED',
  evidence_refs: ['risk-assessment-shared-contract'],
  human_approval_ref: 'approval-product-owner-42',
};

const superseded = {
  ...open,
  status: 'SUPERSEDED',
  successor_obligation_ref: 'prd-shared-contracts#split-contract',
};

test('exports the obligation transition validator', () => {
  assert.equal(typeof validateObligationTransition, 'function');
  assert.equal(typeof validateDeliveryTransition, 'function');
});

test('requires new obligation instances to start OPEN', () => {
  assert.equal(validateObligationTransition(null, resolved).errors[0].code, 'OBLIGATION_CREATION_OPEN_REQUIRED');
  assert.equal(validateObligationTransition(null, open).ok, true);
});

test('requires evidence to resolve an obligation', () => {
  const resolvedWithoutEvidence = { ...resolved, evidence_refs: [] };

  assert.equal(validateObligationTransition(open, resolvedWithoutEvidence).errors[0].code, 'OBLIGATION_EVIDENCE_REQUIRED');
});

test('requires a resolution reference to resolve an obligation', () => {
  const resolvedWithoutResolution = { ...resolved };
  delete resolvedWithoutResolution.resolution_ref;

  assert.equal(validateObligationTransition(open, resolvedWithoutResolution).errors[0].code, 'OBLIGATION_RESOLUTION_REQUIRED');
});

test('requires evidence to waive an obligation', () => {
  const waivedWithoutEvidence = { ...waived, evidence_refs: [] };

  assert.equal(validateObligationTransition(open, waivedWithoutEvidence).errors[0].code, 'OBLIGATION_EVIDENCE_REQUIRED');
});

test('requires human approval to waive an obligation', () => {
  const waivedWithoutApproval = { ...waived };
  delete waivedWithoutApproval.human_approval_ref;

  assert.equal(validateObligationTransition(open, waivedWithoutApproval).errors[0].code, 'OBLIGATION_APPROVAL_REQUIRED');
});

test('accepts a minimal waived obligation without a resolution reference', () => {
  assert.equal(validateJson('obligation-instance', waived).ok, true);
  assert.equal(validateObligationTransition(open, waived).ok, true);
});

test('requires a qualified successor when superseding an obligation', () => {
  const supersededWithoutSuccessor = { ...superseded };
  delete supersededWithoutSuccessor.successor_obligation_ref;

  assert.equal(validateObligationTransition(open, supersededWithoutSuccessor).errors[0].code, 'OBLIGATION_SUCCESSOR_REQUIRED');
});

test('accepts a minimal superseded obligation without evidence or resolution', () => {
  assert.equal(validateJson('obligation-instance', superseded).ok, true);
  assert.equal(validateObligationTransition(open, superseded).ok, true);
});

test('rejects an obligation transition between different obligation IDs first', () => {
  const anotherObligation = { ...open, obligation_id: 'another-obligation' };

  assert.deepEqual(validateObligationTransition(superseded, anotherObligation).errors[0], {
    code: 'OBLIGATION_ID_MISMATCH',
    path: '/obligation_id',
    message: 'Obligation transition must preserve obligation_id.',
  });
});

test('reopens a resolved or waived obligation only for a new trigger without active resolution', () => {
  const reopenedWithNewTrigger = {
    ...open,
    trigger_refs: ['evidence-invalidated-43', 'prd-runtime-v1'],
  };

  assert.equal(validateObligationTransition(resolved, reopenedWithNewTrigger).ok, true);
  assert.equal(validateObligationTransition(waived, reopenedWithNewTrigger).ok, true);
  assert.equal(validateObligationTransition(resolved, open).errors[0].code, 'OBLIGATION_REOPEN_TRIGGER_REQUIRED');
  assert.equal(validateObligationTransition(resolved, { ...reopenedWithNewTrigger, resolution_ref: 'stale' }).errors[0].code, 'OBLIGATION_ACTIVE_RESOLUTION_FORBIDDEN');
  assert.equal(validateObligationTransition(waived, { ...reopenedWithNewTrigger, human_approval_ref: 'stale' }).errors[0].code, 'OBLIGATION_ACTIVE_RESOLUTION_FORBIDDEN');
});

test('treats SUPERSEDED as terminal', () => {
  assert.equal(validateObligationTransition(superseded, open).errors[0].code, 'OBLIGATION_TERMINAL');
});

test('rejects direct transitions between result states', () => {
  assert.equal(validateObligationTransition(resolved, waived).errors[0].code, 'OBLIGATION_TRANSITION_INVALID');
});

test('rejects unsorted obligation relationship references before transition logic', () => {
  const unsorted = { ...open, scope_refs: ['zeta-domain', 'alpha-domain'] };

  const result = validateObligationTransition(null, unsorted);

  assert.deepEqual(result.errors[0], {
    code: 'SCHEMA_INVALID',
    path: '/next/scope_refs/1',
    message: 'Invalid next obligation instance.',
  });
});

test('schema-validates both transition inputs before transition logic', () => {
  const malformedPrevious = { ...open, trigger_refs: 'not-an-array' };
  const malformedNext = { ...open, status: 'UNKNOWN' };

  assert.doesNotThrow(() => validateObligationTransition(malformedPrevious, open));
  assert.doesNotThrow(() => validateObligationTransition(open, malformedNext));
  assert.deepEqual(validateObligationTransition(malformedPrevious, open).errors[0], {
    code: 'SCHEMA_INVALID',
    path: '/previous/trigger_refs',
    message: 'Invalid previous obligation instance.',
  });
  assert.deepEqual(validateObligationTransition(open, malformedNext).errors[0], {
    code: 'SCHEMA_INVALID',
    path: '/next/status',
    message: 'Invalid next obligation instance.',
  });
});

test('never throws or accepts malformed reopen candidates', () => {
  const malformedPrevious = { ...resolved, trigger_refs: null };
  const malformedNext = null;

  assert.doesNotThrow(() => validateObligationTransition(malformedPrevious, open));
  assert.doesNotThrow(() => validateObligationTransition(resolved, malformedNext));
  assert.equal(validateObligationTransition(malformedPrevious, open).ok, false);
  assert.equal(validateObligationTransition(resolved, malformedNext).ok, false);
});

test('does not treat malformed terminal evidence as a missing outcome requirement', () => {
  const malformedNext = { ...resolved, evidence_refs: 'not-an-array' };

  assert.doesNotThrow(() => validateObligationTransition(open, malformedNext));
  assert.deepEqual(validateObligationTransition(open, malformedNext).errors[0], {
    code: 'SCHEMA_INVALID',
    path: '/next/evidence_refs',
    message: 'Invalid next obligation instance.',
  });
});

for (const [status, base, conflictingField] of [
  ['RESOLVED', resolved, 'human_approval_ref'],
  ['RESOLVED', resolved, 'successor_obligation_ref'],
  ['WAIVED', waived, 'resolution_ref'],
  ['WAIVED', waived, 'successor_obligation_ref'],
  ['SUPERSEDED', superseded, 'resolution_ref'],
  ['SUPERSEDED', superseded, 'human_approval_ref'],
]) {
  test(`rejects ${status} with conflicting ${conflictingField}`, () => {
    const value = {
      ...base,
      [conflictingField]: conflictingField === 'successor_obligation_ref'
        ? 'prd-shared-contracts#replacement'
        : 'conflicting-result-marker',
    };

    const schemaResult = validateJson('obligation-instance', value);
    const transitionResult = validateObligationTransition(open, value);

    assert.ok(schemaResult.errors.some(({ code, path }) => (
      code === 'SCHEMA_INVALID' && path === `/${conflictingField}`
    )));
    assert.ok(transitionResult.errors.some(({ code, path }) => (
      code === 'SCHEMA_INVALID' && path === `/next/${conflictingField}`
    )));
  });
}

test('accepts a delivery update that preserves identity and primary route', () => {
  const previous = { artifact_id: 'prd-wiki-layout-v2', primary_route: 'PRD_DELIVERY' };
  const next = { ...previous, knowledge_baseline: 'knowledge-revision-43' };

  assert.equal(validateDeliveryTransition(previous, next).ok, true);
});

test('rejects a delivery update that changes durable primary_route', () => {
  const previous = { artifact_id: 'prd-wiki-layout-v2', primary_route: 'PRD_DELIVERY' };
  const next = { ...previous, primary_route: 'NON_PRD_DELIVERY' };

  assert.deepEqual(validateDeliveryTransition(previous, next).errors[0], {
    code: 'PRIMARY_ROUTE_IMMUTABLE',
    path: '/primary_route',
    message: 'Durable delivery primary_route is immutable.',
  });
});

test('rejects a delivery transition between different artifact IDs', () => {
  const previous = { artifact_id: 'prd-wiki-layout-v2', primary_route: 'PRD_DELIVERY' };
  const next = { ...previous, artifact_id: 'prd-wiki-layout-v3' };

  assert.deepEqual(validateDeliveryTransition(previous, next).errors[0], {
    code: 'DELIVERY_ID_MISMATCH',
    path: '/artifact_id',
    message: 'Delivery transition must preserve artifact_id.',
  });
});
