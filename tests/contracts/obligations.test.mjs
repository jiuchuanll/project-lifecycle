import assert from 'node:assert/strict';
import test from 'node:test';

const obligationsModule = await import('../../scripts/lib/obligations.mjs').catch(() => ({}));
const { validateObligationTransition } = obligationsModule;

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
  resolution_ref: 'waiver-shared-contract',
  human_approval_ref: 'approval-product-owner-42',
};

const superseded = {
  ...open,
  status: 'SUPERSEDED',
  evidence_refs: ['decision-split-shared-contract'],
  resolution_ref: 'supersession-shared-contract',
  successor_obligation_ref: 'prd-shared-contracts#split-contract',
};

test('exports the obligation transition validator', () => {
  assert.equal(typeof validateObligationTransition, 'function');
});

test('requires new obligation instances to start OPEN', () => {
  assert.equal(validateObligationTransition(null, resolved).errors[0].code, 'OBLIGATION_CREATION_OPEN_REQUIRED');
  assert.equal(validateObligationTransition(null, open).ok, true);
});

test('requires evidence and a resolution to resolve an obligation', () => {
  const resolvedWithoutEvidence = { ...resolved, evidence_refs: [] };
  delete resolvedWithoutEvidence.resolution_ref;

  assert.equal(validateObligationTransition(open, resolvedWithoutEvidence).errors[0].code, 'OBLIGATION_EVIDENCE_REQUIRED');
});

test('requires evidence and human approval to waive an obligation', () => {
  const waivedWithoutApproval = { ...waived };
  delete waivedWithoutApproval.human_approval_ref;

  assert.equal(validateObligationTransition(open, waivedWithoutApproval).errors[0].code, 'OBLIGATION_APPROVAL_REQUIRED');
});

test('requires a qualified successor when superseding an obligation', () => {
  const supersededWithoutSuccessor = { ...superseded };
  delete supersededWithoutSuccessor.successor_obligation_ref;

  assert.equal(validateObligationTransition(open, supersededWithoutSuccessor).errors[0].code, 'OBLIGATION_SUCCESSOR_REQUIRED');
});

test('reopens a resolved or waived obligation only for a new trigger without active resolution', () => {
  const reopenedWithNewTrigger = {
    ...open,
    trigger_refs: [...open.trigger_refs, 'evidence-invalidated-43'],
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
