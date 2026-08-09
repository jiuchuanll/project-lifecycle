import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateImpactDeclaration } from '../../scripts/delivery/impact-declaration.mjs';

const casesUrl = new URL('../fixtures/delivery/parallel/overlap-cases.json', import.meta.url);
const declaration = (fixture = {}) => ({
  owner_artifact_id: 'prd-wiki-layout',
  owner_kind: 'prd',
  repository_ids: ['backend-repository', 'frontend-repository'],
  knowledge_baseline: 'baseline-7',
  current_knowledge_baseline: fixture.current_knowledge_baseline ?? 'baseline-7',
  primary_domain_id: 'wiki-workspace',
  affected_domain_ids: ['desktop-experience', 'wiki-workspace'],
  intended_fact_ids: ['fact-wiki-layout'],
  provided_contracts: [{ contract_id: 'wiki-layout-contract', revision_ref: 'revision:2' }],
  consumed_contracts: [{ contract_id: 'desktop-shell-contract', revision_ref: 'revision:4' }],
  relationships: fixture.relationship_kind ? [{
    kind: fixture.relationship_kind,
    target_owner_ref: 'delivery:prd-desktop-shell',
    evidence_refs: ['contract:shared-seam'],
  }] : [],
  overlap: {
    class: fixture.class,
    peer_owner_ref: 'delivery:prd-desktop-shell',
    evidence_refs: ['analysis:parallel-overlap'],
    shared_domain_ids: ['wiki-workspace'],
    shared_fact_ids: fixture.shared_fact_ids ?? [],
    peer_fact_ids: fixture.peer_fact_ids ?? ['fact-desktop-shell'],
    ...(fixture.joint_acceptance_seam_ref ? { joint_acceptance_seam_ref: fixture.joint_acceptance_seam_ref } : {}),
    ...(fixture.baseline_replay_ref ? { baseline_replay_ref: fixture.baseline_replay_ref } : {}),
    ...(fixture.conflict_ref ? { conflict_ref: fixture.conflict_ref } : {}),
  },
});

test('validates every explicit parallel-overlap class without classifying prose', async () => {
  const cases = JSON.parse(await readFile(casesUrl, 'utf8'));
  for (const fixture of cases) {
    const result = validateImpactDeclaration(declaration(fixture));
    assert.equal(result.ok ? 'OK' : result.errors[0].code, fixture.expected, fixture.name);
  }
  const missingClass = declaration({ class: undefined });
  delete missingClass.overlap.class;
  assert.equal(validateImpactDeclaration(missingClass).errors[0].code, 'IMPACT_CLASS_MISSING');
});

test('requires the exact relationship and joint seam for dependency and composable work', () => {
  const dependency = declaration({ class: 'DEPENDENCY' });
  assert.equal(validateImpactDeclaration(dependency).errors[0].code, 'IMPACT_RELATIONSHIP_MISSING');

  const composable = declaration({ class: 'COMPOSABLE_SEAM', relationship_kind: 'coordinates_with' });
  assert.equal(validateImpactDeclaration(composable).errors[0].code, 'JOINT_ACCEPTANCE_SEAM_MISSING');
});

test('binds same-fact conflict and disjoint-fact declarations to actual fact sets', () => {
  const noSharedFact = declaration({ class: 'SAME_FACT_CONFLICT', conflict_ref: 'conflict:wiki' });
  assert.equal(validateImpactDeclaration(noSharedFact).errors[0].code, 'SHARED_FACT_MISSING');

  const falselyDisjoint = declaration({ class: 'DISJOINT_FACTS', peer_fact_ids: ['fact-wiki-layout'] });
  assert.equal(validateImpactDeclaration(falselyDisjoint).errors[0].code, 'DISJOINT_FACT_CONFLICT');
});

test('requires stale baseline evidence only for replayable or unreplayable classes', () => {
  const replayWithoutDrift = declaration({ class: 'STALE_REPLAYABLE', baseline_replay_ref: 'replay:a' });
  assert.equal(validateImpactDeclaration(replayWithoutDrift).errors[0].code, 'BASELINE_NOT_STALE');

  const driftWithoutReplay = declaration({ class: 'STALE_REPLAYABLE', current_knowledge_baseline: 'baseline-8' });
  assert.equal(validateImpactDeclaration(driftWithoutReplay).errors[0].code, 'BASELINE_REPLAY_MISSING');

  const currentMarkedOrdinary = declaration({ class: 'INFORMATIONAL_OVERLAP', current_knowledge_baseline: 'baseline-8' });
  assert.equal(validateImpactDeclaration(currentMarkedOrdinary).errors[0].code, 'STALE_CLASS_REQUIRED');
});

test('does not invent obligations from multiple domains or repositories alone', () => {
  const result = validateImpactDeclaration(declaration({ class: 'INFORMATIONAL_OVERLAP' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.required_obligation_kinds, []);
});

test('rejects unsafe references and malformed contract revisions', () => {
  const unsafe = declaration({ class: 'INFORMATIONAL_OVERLAP' });
  unsafe.relationships = [{
    kind: 'depends_on',
    target_owner_ref: 'https://user:secret@example.com',
    evidence_refs: ['contract:a'],
  }];
  assert.equal(validateImpactDeclaration(unsafe).errors[0].code, 'IMPACT_REFERENCE_INVALID');

  const malformed = declaration({ class: 'INFORMATIONAL_OVERLAP' });
  malformed.provided_contracts[0].revision_ref = '';
  assert.equal(validateImpactDeclaration(malformed).errors[0].code, 'IMPACT_REFERENCE_INVALID');
});
