import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateClosureGate } from '../../scripts/delivery/closure-gates.mjs';
import { storeObligation } from '../../scripts/delivery/obligation-store.mjs';
import { validateJson } from '../../scripts/lib/validate-json.mjs';

const frontmatter = (kind = 'prd') => ({
  schema_version: 1,
  artifact_id: kind === 'prd' ? 'prd-wiki-layout' : 'wiki-layout-repair',
  artifact_kind: kind,
  primary_route: kind === 'prd' ? 'PRD_DELIVERY' : 'NON_PRD_DELIVERY',
  project_id_at_creation: 'sample-project',
  current_project_id: 'sample-project',
  domain_ids: ['wiki-workspace'],
  knowledge_baseline: 'baseline-7',
  relationships: { feedback_ids: [], prd_ids: [], legacy_artifact_refs: [] },
  retention_tier: 'active',
  reclassified_from_refs: [],
  obligations: [],
});
const open = (overrides = {}) => ({
  obligation_id: 'shared-seam',
  kind: 'DEPENDENCY_RESOLUTION_REQUIRED',
  status: 'OPEN',
  trigger_refs: ['impact:wiki-desktop'],
  scope_refs: ['wiki-workspace'],
  responsible_refs: ['delivery:prd-desktop-shell'],
  required_before: 'acceptance',
  evidence_refs: [],
  ...overrides,
});
const legacyLedger = () => ({
  schema_version: 1,
  changes: [{
    change_id: 'wiki-knowledge-readiness',
    kind: 'material_conflict',
    trigger_refs: ['delivery:prd-wiki-layout'],
    affected_refs: ['wiki-workspace'],
    proposed_disposition: 'Resolve before knowledge absorption.',
    risks: [],
    evidence_gaps: [],
    review_state: 'open',
    created_at: '2026-08-09T08:00:00.000Z',
  }],
});

test('stores PRD and non-PRD obligations only in their owning Frontmatter', () => {
  for (const kind of ['prd', 'non-prd-delivery']) {
    const owner = { kind, frontmatter: frontmatter(kind), owner_locator: `delivery/${kind}-owner-en.md` };
    const result = storeObligation({ owner, next: open() });
    assert.equal(result.ok, true);
    assert.equal(validateJson('delivery-frontmatter', result.value.owner.frontmatter).ok, true);
    assert.equal(result.value.owner.frontmatter.obligations.length, 1);
    assert.equal(result.value.qualified_id, `${owner.frontmatter.artifact_id}#shared-seam`);
    assert.equal(result.value.storage.locator, owner.owner_locator);
    assert.doesNotMatch(JSON.stringify(result.value), /obligations\.json/);
  }
});

test('stores a durable knowledge-only obligation on the relevant pending entry', () => {
  const result = storeObligation({
    owner: { kind: 'knowledge-pending', ledger: legacyLedger(), change_id: 'wiki-knowledge-readiness' },
    next: open({ kind: 'KNOWLEDGE_READINESS_REQUIRED' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.owner.ledger.changes[0].obligations.length, 1);
  assert.equal(validateJson('pending-changes', result.value.owner.ledger).ok, true);
  assert.equal(result.value.qualified_id, 'wiki-knowledge-readiness#shared-seam');
  assert.equal(result.value.storage.locator, 'pending-changes.json#wiki-knowledge-readiness');
});

test('uses the Phase 1 transition validator for resolution and waiver', () => {
  const owner = { kind: 'prd', frontmatter: frontmatter(), owner_locator: 'delivery/prds/prd-wiki-layout/prd-wiki-layout-en.md' };
  const created = storeObligation({ owner, next: open() });
  const resolved = storeObligation({
    owner: created.value.owner,
    next: open({
      status: 'RESOLVED',
      evidence_refs: ['test:shared-seam'],
      resolution_ref: 'resolution:shared-seam',
    }),
  });
  assert.equal(resolved.ok, true);

  const invalidWaiver = storeObligation({
    owner: created.value.owner,
    next: open({ status: 'WAIVED', evidence_refs: ['risk:shared-seam'] }),
  });
  assert.equal(invalidWaiver.ok, false);
  assert.equal(invalidWaiver.errors[0].code, 'OBLIGATION_APPROVAL_REQUIRED');
});

test('an OPEN obligation blocks only its named gate', () => {
  const acceptance = evaluateClosureGate({
    gate: 'acceptance', owner_artifact_id: 'prd-wiki-layout', obligations: [open()], qualified_obligations: [],
  });
  assert.equal(acceptance.ok, false);
  assert.deepEqual(acceptance.value.blocking_obligation_refs, ['prd-wiki-layout#shared-seam']);

  const implementation = evaluateClosureGate({
    gate: 'implementation', owner_artifact_id: 'prd-wiki-layout', obligations: [open()], qualified_obligations: [],
  });
  assert.equal(implementation.ok, true);
});

test('RESOLVED and valid WAIVED outcomes satisfy the named gate and compact safely', () => {
  const obligations = [
    open({ status: 'RESOLVED', evidence_refs: ['test:seam'], resolution_ref: 'resolution:seam' }),
    open({
      obligation_id: 'accepted-risk',
      status: 'WAIVED',
      evidence_refs: ['risk:accepted'],
      human_approval_ref: 'approval:product-owner',
    }),
  ];
  const result = evaluateClosureGate({
    gate: 'acceptance', owner_artifact_id: 'prd-wiki-layout', obligations, qualified_obligations: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.compact_outcomes.map(({ status }) => status), ['WAIVED', 'RESOLVED']);
  assert.doesNotMatch(JSON.stringify(result.value.compact_outcomes), /trigger_refs|scope_refs|responsible_refs/);
});

test('SUPERSEDED delegates its gate result to the qualified successor', () => {
  const superseded = open({
    status: 'SUPERSEDED',
    successor_obligation_ref: 'prd-desktop-shell#replacement-seam',
  });
  const successor = {
    owner_artifact_id: 'prd-desktop-shell',
    obligation: open({ obligation_id: 'replacement-seam' }),
  };
  const blocked = evaluateClosureGate({
    gate: 'acceptance', owner_artifact_id: 'prd-wiki-layout', obligations: [superseded], qualified_obligations: [successor],
  });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.value.blocking_obligation_refs, ['prd-desktop-shell#replacement-seam']);

  successor.obligation = open({
    obligation_id: 'replacement-seam',
    status: 'RESOLVED',
    evidence_refs: ['test:replacement'],
    resolution_ref: 'resolution:replacement',
  });
  assert.equal(evaluateClosureGate({
    gate: 'acceptance', owner_artifact_id: 'prd-wiki-layout', obligations: [superseded], qualified_obligations: [successor],
  }).ok, true);
});

test('rejects duplicate local IDs and malformed qualified successor ownership', () => {
  const duplicate = frontmatter();
  duplicate.obligations = [open(), open()];
  const result = storeObligation({
    owner: { kind: 'prd', frontmatter: duplicate, owner_locator: 'delivery/prds/prd-wiki-layout/prd-wiki-layout-en.md' },
    next: open(),
  });
  assert.equal(result.ok, false);

  const missingSuccessor = evaluateClosureGate({
    gate: 'acceptance',
    owner_artifact_id: 'prd-wiki-layout',
    obligations: [open({ status: 'SUPERSEDED', successor_obligation_ref: 'prd-other#unknown' })],
    qualified_obligations: [],
  });
  assert.equal(missingSuccessor.ok, false);
  assert.equal(missingSuccessor.errors[0].code, 'OBLIGATION_SUCCESSOR_MISSING');
});
