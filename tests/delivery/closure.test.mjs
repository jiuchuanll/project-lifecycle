import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { closeDelivery, validateClosureSummary } from '../../scripts/delivery/close-delivery.mjs';
import { createKnowledgeDiffCandidate } from '../../scripts/delivery/create-knowledge-diff.mjs';
import { createRetentionPlan } from '../../scripts/delivery/retention.mjs';
import { validateJson } from '../../scripts/lib/validate-json.mjs';

const casesUrl = new URL('../fixtures/delivery/closure/outcome-cases.json', import.meta.url);
const owner = (overrides = {}) => ({
  schema_version: 1,
  artifact_id: 'prd-wiki-layout',
  artifact_kind: 'prd',
  primary_route: 'PRD_DELIVERY',
  project_id_at_creation: 'sample-project',
  current_project_id: 'sample-project',
  domain_ids: ['wiki-workspace'],
  knowledge_baseline: 'baseline-7',
  relationships: {
    feedback_ids: ['feedback-wiki-density'],
    prd_ids: [],
    legacy_artifact_refs: [],
  },
  retention_tier: 'active',
  reclassified_from_refs: [],
  obligations: [],
  ...overrides,
});
const noChange = (overrides = {}) => ({
  schema_version: 1,
  diff_id: 'diff-prd-wiki-layout',
  owner_delivery_id: 'prd-wiki-layout',
  knowledge_baseline: 'baseline-7',
  operations: [],
  domain_changes: [],
  entry_points: ['delivery:prd-wiki-layout'],
  evidence_refs: ['verification:wiki-layout'],
  remaining_limits: [],
  outcome: 'NO_CHANGE',
  ...overrides,
});
const change = () => ({
  ...noChange(),
  operations: [{
    kind: 'REWRITE',
    fact_id: 'fact-wiki-layout',
    owner_domain_id: 'wiki-workspace',
    evidence_refs: ['verification:wiki-layout'],
  }],
  outcome: 'CHANGE',
});
const candidate = (diff = noChange()) => createKnowledgeDiffCandidate({ diff }).value;
const openObligation = {
  obligation_id: 'shared-seam',
  kind: 'DEPENDENCY_RESOLUTION_REQUIRED',
  status: 'OPEN',
  trigger_refs: ['impact:wiki-shell'],
  scope_refs: ['wiki-workspace'],
  responsible_refs: ['delivery:prd-shell'],
  required_before: 'closure',
  evidence_refs: [],
};
const impact = (overrides = {}) => ({
  owner_artifact_id: 'prd-wiki-layout',
  owner_kind: 'prd',
  repository_ids: ['sample-repository'],
  knowledge_baseline: 'baseline-7',
  current_knowledge_baseline: 'baseline-7',
  primary_domain_id: 'wiki-workspace',
  affected_domain_ids: ['wiki-workspace'],
  intended_fact_ids: ['fact-wiki-layout'],
  provided_contracts: [],
  consumed_contracts: [],
  relationships: [],
  overlap: {
    class: 'INFORMATIONAL_OVERLAP',
    peer_owner_ref: 'delivery:prd-desktop-shell',
    evidence_refs: ['analysis:parallel-overlap'],
    shared_domain_ids: ['wiki-workspace'],
    shared_fact_ids: [],
    peer_fact_ids: ['fact-desktop-shell'],
  },
  ...overrides,
});
const closure = (overrides = {}) => ({
  owner: owner(),
  outcome: { status: 'ACCEPTED', ref: 'acceptance:prd-wiki-layout', residual_risk_refs: [] },
  verification: { status: 'PASSED', ref: 'verification:wiki-layout' },
  acceptance_units: [{ unit_id: 'frontend', status: 'ACCEPTED', evidence_refs: ['test:frontend'] }],
  feedback_coverage: [{
    feedback_id: 'feedback-wiki-density',
    status: 'COVERED',
    covering_prd_ids: ['prd-wiki-layout'],
    evidence_refs: ['acceptance:wiki-density'],
    remaining_criteria: [],
  }],
  obligations: [],
  qualified_obligations: [],
  conflict_disposition: { status: 'NOT_APPLICABLE', ref: 'conflict:none' },
  baseline: { starting: 'baseline-7', current: 'baseline-7' },
  impact: impact(),
  knowledge_handoff: candidate(),
  evidence_refs: ['verification:wiki-layout'],
  detailed_artifacts: [{
    artifact_id: 'prd-wiki-layout',
    artifact_kind: 'prd',
    locators: { en: 'delivery/prd-wiki-layout-en.md', 'zh-CN': 'delivery/prd-wiki-layout.md' },
    body_hashes: { en: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'zh-CN': 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    evidence_refs: ['verification:wiki-layout'],
  }],
  ...overrides,
});

test('creates only Phase 2-owned Knowledge Diff or explicit NO_CHANGE candidates', () => {
  for (const diff of [change(), noChange()]) {
    const result = createKnowledgeDiffCandidate({ diff });
    assert.equal(result.ok, true);
    assert.equal(validateJson('knowledge-diff', result.value.diff).ok, true);
    assert.equal(result.value.candidate_owner, 'run-prd-lifecycle');
    assert.equal(result.value.apply_authority, 'maintain-project-knowledge');
    assert.equal(result.value.current_knowledge_written, false);
  }
  assert.equal(createKnowledgeDiffCandidate({ diff: noChange(), current_knowledge: {} }).errors[0].code, 'CURRENT_KNOWLEDGE_WRITE_FORBIDDEN');
  assert.equal(createKnowledgeDiffCandidate({ diff: { ...noChange(), evidence_refs: [] } }).ok, false);
});

test('rejects each material closure gap before producing durable results', () => {
  const cases = [
    [closure({ verification: undefined }), 'VERIFICATION_REQUIRED'],
    [closure({ obligations: [openObligation] }), 'CLOSURE_GATE_BLOCKED'],
    [closure({
      impact: impact({
        overlap: {
          ...impact().overlap,
          class: 'SAME_FACT_CONFLICT',
          shared_fact_ids: ['fact-wiki-layout'],
          conflict_ref: 'conflict:wiki-layout',
        },
      }),
    }), 'CONFLICT_DISPOSITION_REQUIRED'],
    [closure({ acceptance_units: [{ unit_id: 'backend', status: 'OPEN', evidence_refs: [] }] }), 'ACCEPTANCE_INCOMPLETE'],
    [closure({
      baseline: { starting: 'baseline-7', current: 'baseline-8' },
      impact: impact({
        current_knowledge_baseline: 'baseline-8',
        overlap: {
          ...impact().overlap,
          class: 'STALE_REPLAYABLE',
          baseline_replay_ref: 'replay:baseline-7-to-8',
        },
      }),
    }), 'BASELINE_RECONCILIATION_REQUIRED'],
    [closure({ feedback_coverage: [{ ...closure().feedback_coverage[0], status: 'PARTIAL', remaining_criteria: ['Mobile acceptance.'] }] }), 'FEEDBACK_COVERAGE_INCOMPLETE'],
    [closure({ knowledge_handoff: undefined }), 'KNOWLEDGE_HANDOFF_REQUIRED'],
    [closure({ current_knowledge_write: { fact_id: 'fact-wiki-layout' } }), 'CURRENT_KNOWLEDGE_WRITE_FORBIDDEN'],
  ];
  for (const [input, code] of cases) assert.equal(closeDelivery(input).errors[0].code, code);
});

test('closes accepted PRD work with a change and an accepted no-change repair', () => {
  const changed = closeDelivery(closure({ knowledge_handoff: candidate(change()) }));
  assert.equal(changed.ok, true);
  assert.equal(changed.value.summary.knowledge_handoff.outcome, 'CHANGE');

  const repairOwner = owner({ artifact_id: 'wiki-layout-repair', artifact_kind: 'non-prd-delivery', primary_route: 'NON_PRD_DELIVERY' });
  const repairDiff = noChange({ diff_id: 'diff-wiki-layout-repair', owner_delivery_id: 'wiki-layout-repair' });
  const repairInput = closure({
    owner: repairOwner,
    impact: impact({ owner_artifact_id: 'wiki-layout-repair', owner_kind: 'non-prd-delivery' }),
    knowledge_handoff: candidate(repairDiff),
  });
  assert.equal(closeDelivery(repairInput).errors[0].code, 'FEEDBACK_COVERAGE_INVALID');
  repairInput.feedback_coverage[0].covering_prd_ids = ['wiki-layout-repair'];
  const repair = closeDelivery(repairInput);
  assert.equal(repair.ok, true);
  assert.equal(repair.value.summary.knowledge_handoff.outcome, 'NO_CHANGE');
  assert.deepEqual(repair.value.summary.feedback_coverage[0].covering_prd_ids, ['wiki-layout-repair']);
});

test('normalizes successful closure summaries to their closed consumer contract', () => {
  const result = closeDelivery(closure({
    outcome: { ...closure().outcome, private_note: 'ignored' },
    verification: { ...closure().verification, runner: 'local' },
    acceptance_units: [{ ...closure().acceptance_units[0], note: 'ignored' }],
    feedback_coverage: [{ ...closure().feedback_coverage[0], note: 'ignored' }],
    conflict_disposition: { ...closure().conflict_disposition, note: 'ignored' },
    baseline: { ...closure().baseline, note: 'ignored' },
  }));
  assert.equal(result.ok, true);
  assert.equal(validateClosureSummary(result.value.summary).ok, true);
  assert.equal(JSON.stringify(result.value.summary).includes('ignored'), false);
  assert.equal(JSON.stringify(result.value.summary).includes('local'), false);
});

test('binds the validated impact owner, baselines, and accepted evidence to closure', () => {
  assert.equal(closeDelivery(closure({ impact: impact({ owner_artifact_id: 'prd-other' }) })).errors[0].code, 'IMPACT_DECLARATION_MISMATCH');
  const diff = change();
  diff.operations[0].evidence_refs = ['verification:unaccepted'];
  diff.evidence_refs = ['verification:unaccepted'];
  assert.equal(closeDelivery(closure({ knowledge_handoff: candidate(diff) })).errors[0].code, 'KNOWLEDGE_EVIDENCE_UNACCEPTED');
});

test('records rejected, cancelled, and abandoned outcomes without claiming acceptance', async () => {
  const fixtures = JSON.parse(await readFile(casesUrl, 'utf8'));
  for (const fixture of fixtures) {
    const input = closure({
      outcome: { status: fixture.status, ref: `outcome:${fixture.name}`, residual_risk_refs: [] },
      verification: { status: fixture.verification_status, ref: `verification:${fixture.name}` },
      acceptance_units: fixture.status === 'ACCEPTED' ? closure().acceptance_units : [],
      feedback_coverage: fixture.status === 'ACCEPTED' ? closure().feedback_coverage : [{
        ...closure().feedback_coverage[0], status: 'NOT_COVERED', remaining_criteria: ['Work stopped.'],
      }],
    });
    const result = closeDelivery(input);
    assert.equal(result.ok ? 'OK' : result.errors[0].code, fixture.expected, fixture.name);
    assert.equal(result.value.summary.acceptance.claimed, fixture.status === 'ACCEPTED');
  }
});

test('supports one Feedback split across PRDs and one PRD covering multiple Feedback records', () => {
  const split = closure().feedback_coverage[0];
  split.covering_prd_ids = ['prd-wiki-backend', 'prd-wiki-layout', 'prd-wiki-shell'];
  const multi = {
    ...split,
    feedback_id: 'feedback-wiki-navigation',
    covering_prd_ids: ['prd-wiki-layout'],
  };
  const result = closeDelivery(closure({
    owner: owner({ relationships: { feedback_ids: ['feedback-wiki-density', 'feedback-wiki-navigation'], prd_ids: [], legacy_artifact_refs: [] } }),
    feedback_coverage: [split, multi],
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.summary.feedback_coverage.map(({ feedback_id }) => feedback_id), [
    'feedback-wiki-density', 'feedback-wiki-navigation',
  ]);
});

test('creates an immutable compact summary, archive transitions, and exact cleanup authorization', () => {
  const result = closeDelivery(closure());
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.value.summary), true);
  assert.equal(result.value.retention.archive_transitions[0].to.en, 'archive/delivery/prd-wiki-layout-en.md');
  assert.deepEqual(result.value.retention.retained_unique_evidence_refs, ['verification:wiki-layout']);
  assert.equal(result.value.cleanup_authorization.owner_status, 'CLOSED');
  assert.equal(result.value.cleanup_authorization.knowledge_handoff.kind, 'NO_CHANGE');
  assert.doesNotMatch(JSON.stringify(result.value.summary), /Bounded English outcome|hidden reasoning|chat log/i);
});

test('retention rejects bodyless identity, unsafe locators, and evidence deletion requests', () => {
  const base = closure();
  const summary = { artifact_id: 'closure-prd-wiki-layout', closure_ref: 'closure:prd-wiki-layout' };
  assert.equal(createRetentionPlan({ summary, artifacts: base.detailed_artifacts, delete_evidence_refs: [] }).ok, true);
  assert.equal(createRetentionPlan({ summary, artifacts: base.detailed_artifacts, delete_evidence_refs: ['verification:wiki-layout'] }).errors[0].code, 'EVIDENCE_DELETE_FORBIDDEN');
  const unsafe = structuredClone(base.detailed_artifacts);
  unsafe[0].locators.en = '../escape.md';
  assert.equal(createRetentionPlan({ summary, artifacts: unsafe, delete_evidence_refs: [] }).ok, false);
});
