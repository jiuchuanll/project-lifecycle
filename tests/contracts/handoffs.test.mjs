import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateJson } from '../../scripts/lib/validate-json.mjs';

const fixture = async (name) => JSON.parse(
  await readFile(new URL(`../fixtures/contracts/handoffs/${name}`, import.meta.url), 'utf8'),
);

for (const [kind, name] of [
  ['context-receipt', 'context-receipt.valid.json'],
  ['knowledge-diff', 'knowledge-diff.valid.json'],
  ['knowledge-diff', 'knowledge-diff.no-change.valid.json'],
  ['archive-access-receipt', 'archive-access-receipt.valid.json'],
  ['delivery-frontmatter', 'delivery-frontmatter.valid.json'],
]) {
  test(`accepts valid ${kind} fixture ${name}`, async () => {
    assert.equal(validateJson(kind, await fixture(name)).ok, true);
  });
}

test('rejects unknown Context Receipt vocabulary', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.selected_context[0].reason = 'EVERYTHING';

  const result = validateJson('context-receipt', receipt);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(({ path }) => path === '/selected_context/0/reason'));
});

test('rejects duplicate Context Receipt IDs even when selection fields differ', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.selected_context.push({ ...receipt.selected_context[0], reason: 'VALIDATION' });

  const result = validateJson('context-receipt', receipt);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'ID_DUPLICATE' && path === '/selected_context/1/id'
  )));
});

test('routes exact duplicate Context Receipt selections to the deterministic ID error', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.selected_context.push({ ...receipt.selected_context[0] });

  const result = validateJson('context-receipt', receipt);

  assert.deepEqual(result.errors[0], {
    code: 'ID_DUPLICATE',
    path: '/selected_context/1/id',
    message: 'Duplicate selected context ID: fact-wiki-layout-model',
  });
});

test('rejects Context Receipt selections that are not ID-sorted', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.selected_context = [
    { ...receipt.selected_context[0], id: 'zeta-context' },
    { ...receipt.selected_context[0], id: 'alpha-context' },
  ];

  const result = validateJson('context-receipt', receipt);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/selected_context/1/id'
  )));
});

test('rejects unsorted Context Receipt affected domain IDs at the exact item path', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.route.affected_domain_ids = ['zeta-domain', 'alpha-domain'];

  const result = validateJson('context-receipt', receipt);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/route/affected_domain_ids/1'
  )));
});

test('rejects a sufficient Context Receipt with unresolved questions', async () => {
  const receipt = await fixture('context-receipt.valid.json');
  receipt.open_questions.push('Which density preset is authoritative?');

  const result = validateJson('context-receipt', receipt);

  assert.ok(result.errors.some(({ path }) => path === '/stop/code'));
});

test('requires NO_CHANGE to have no operations and retained evidence', async () => {
  const diff = await fixture('knowledge-diff.no-change.valid.json');
  diff.operations.push({
    kind: 'ADD',
    fact_id: 'fact-new-layout-rule',
    owner_domain_id: 'wiki-workspace',
    evidence_refs: ['test-report-copy-fix'],
  });
  diff.evidence_refs = [];

  const result = validateJson('knowledge-diff', diff);

  assert.ok(result.errors.some(({ path }) => path === '/operations'));
  assert.ok(result.errors.some(({ path }) => path === '/evidence_refs'));
});

test('rejects archive globs and unbounded artifact sets', async () => {
  const receipt = await fixture('archive-access-receipt.valid.json');
  receipt.artifact_ids = Array.from({ length: 21 }, (_, index) => (
    index === 0 ? 'archive-*' : `archived-artifact-${index}`
  ));

  const result = validateJson('archive-access-receipt', receipt);

  assert.ok(result.errors.some(({ path }) => path === '/artifact_ids'));
  assert.ok(result.errors.some(({ path }) => path === '/artifact_ids/0'));
});

test('rejects unsorted Archive Receipt artifact IDs', async () => {
  const receipt = await fixture('archive-access-receipt.valid.json');
  receipt.artifact_ids = ['prd-zeta', 'prd-alpha'];

  const result = validateJson('archive-access-receipt', receipt);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/artifact_ids/1'
  )));
});

test('rejects NEEDS_USER as a durable primary route', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.primary_route = 'NEEDS_USER';

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ path }) => path === '/primary_route'));
});

test('requires current_project_id only for active delivery', async () => {
  const active = await fixture('delivery-frontmatter.valid.json');
  delete active.current_project_id;
  const archived = { ...active, retention_tier: 'archive' };

  assert.ok(validateJson('delivery-frontmatter', active).errors.some(
    ({ path }) => path === '/current_project_id',
  ));
  assert.equal(validateJson('delivery-frontmatter', archived).ok, true);
});

test('keeps obligations owner-local and rejects a global obligation owner field', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.obligations[0].owner_ref = 'global-obligations';

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ path }) => path === '/obligations/0/owner_ref'));
});

test('rejects duplicate owner-local obligation IDs even when instance fields differ', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.obligations.push({
    ...frontmatter.obligations[0],
    responsible_refs: ['prd-another-owner'],
  });

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'ID_DUPLICATE' && path === '/obligations/1/obligation_id'
  )));
});

test('routes exact duplicate owner-local obligations to the deterministic ID error', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.obligations.push({ ...frontmatter.obligations[0] });

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.deepEqual(result.errors[0], {
    code: 'ID_DUPLICATE',
    path: '/obligations/1/obligation_id',
    message: 'Duplicate obligation ID: layout-dependency',
  });
});

test('rejects duplicate cross-reference IDs in delivery relationships', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.relationships.feedback_ids.push('feedback-wiki-density');

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ path }) => path === '/relationships/feedback_ids'));
});

test('rejects cross-reference IDs in the wrong typed relationship', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.relationships.feedback_ids = ['prd-wiki-layout-v1'];
  frontmatter.relationships.prd_ids = ['feedback-wiki-density'];

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ path }) => path === '/relationships/feedback_ids/0'));
  assert.ok(result.errors.some(({ path }) => path === '/relationships/prd_ids/0'));
});

test('uses Unicode code-point order for delivery relationship references', async () => {
  const frontmatter = await fixture('delivery-frontmatter.valid.json');
  frontmatter.relationships.legacy_artifact_refs = ['😀-artifact', '�-artifact'];

  const result = validateJson('delivery-frontmatter', frontmatter);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/relationships/legacy_artifact_refs/1'
  )));
});

test('rejects unsorted Knowledge Diff fact operations', async () => {
  const diff = await fixture('knowledge-diff.valid.json');
  diff.operations = [
    { ...diff.operations[0], fact_id: 'fact-zeta' },
    { ...diff.operations[0], fact_id: 'fact-alpha' },
  ];

  const result = validateJson('knowledge-diff', diff);

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/operations/1/fact_id'
  )));
});

test('rejects unsorted Pending Change identifiers and relationship references', () => {
  const change = {
    change_id: 'change-zeta',
    kind: 'topology',
    trigger_refs: ['trigger-zeta', 'trigger-alpha'],
    affected_refs: ['domain-alpha'],
    proposed_disposition: 'Review topology',
    risks: [],
    evidence_gaps: [],
    review_state: 'open',
    created_at: '2026-08-08T10:00:00Z',
  };
  const result = validateJson('pending-changes', {
    schema_version: 1,
    changes: [change, { ...change, change_id: 'change-alpha', trigger_refs: ['trigger-alpha'] }],
  });

  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/changes/1/change_id'
  )));
  assert.ok(result.errors.some(({ code, path }) => (
    code === 'SCHEMA_INVALID' && path === '/changes/0/trigger_refs/1'
  )));
});

test('accepts one bounded governed Task 4 proposal while preserving legacy pending entries', () => {
  const legacy = {
    change_id: 'change-legacy',
    kind: 'topology',
    trigger_refs: ['feedback:legacy'],
    affected_refs: ['desktop-experience'],
    proposed_disposition: 'Review topology',
    risks: [],
    evidence_gaps: [],
    review_state: 'open',
    created_at: '2026-08-08T10:00:00Z',
  };
  const governed = {
    change_id: 'change-wiki-privacy',
    kind: 'constraint_semantics',
    trigger_refs: ['feedback:privacy'],
    source_refs: ['repo:privacy-policy'],
    affected_refs: ['desktop-privacy', 'wiki-workspace'],
    proposed_disposition: 'Narrow privacy propagation.',
    risks: ['Wiki storage facts may require revalidation.'],
    evidence_gaps: ['Runtime verification remains open.'],
    review_state: 'open',
    created_at: '2026-08-08T11:00:00Z',
    proposal_version: 1,
    semantic_target_key: 'constraint:desktop-privacy',
    baseline: {
      map_hash: `sha256:${'a'.repeat(64)}`,
    },
    change_class: 'SEMANTIC',
    proposed_patch: {
      operation: 'UPDATE_CONSTRAINT',
      target_type: 'constraint',
      target_id: 'desktop-privacy',
      changed_fields: ['constraint_scope'],
      candidate_map_hash: `sha256:${'b'.repeat(64)}`,
      expected_semantic_revision: 2,
      new_ids: [],
      successor_ids: [],
    },
    child_dispositions: [{
      domain_id: 'wiki-workspace',
      disposition: 'REVALIDATE',
      evidence_refs: ['repo:privacy-policy'],
      unresolved_fact_ids: ['wiki-storage-boundary'],
    }],
    knowledge_commitments: [],
  };

  assert.equal(validateJson('pending-changes', {
    schema_version: 1,
    changes: [legacy, governed],
  }).ok, true);
});

test('rejects incomplete and unsorted governed Task 4 proposals', () => {
  const governed = {
    change_id: 'change-wiki-privacy',
    kind: 'constraint_semantics',
    trigger_refs: ['feedback:privacy'],
    source_refs: ['repo:zeta', 'repo:alpha'],
    affected_refs: ['wiki-workspace'],
    proposed_disposition: 'Narrow privacy propagation.',
    risks: [],
    evidence_gaps: [],
    review_state: 'open',
    created_at: '2026-08-08T11:00:00Z',
    proposal_version: 1,
    semantic_target_key: 'constraint:desktop-privacy',
    baseline: { map_hash: `sha256:${'a'.repeat(64)}` },
    change_class: 'SEMANTIC',
    proposed_patch: {
      operation: 'UPDATE_CONSTRAINT',
      target_type: 'constraint',
      target_id: 'desktop-privacy',
      changed_fields: ['constraint_scope'],
      candidate_map_hash: `sha256:${'b'.repeat(64)}`,
      expected_semantic_revision: 2,
      new_ids: [],
      successor_ids: [],
    },
    knowledge_commitments: [],
  };

  const result = validateJson('pending-changes', {
    schema_version: 1,
    changes: [governed],
  });

  assert.ok(result.errors.some(({ path }) => path === '/changes/0/child_dispositions'));
  governed.child_dispositions = [];
  const orderedResult = validateJson('pending-changes', {
    schema_version: 1,
    changes: [governed],
  });
  assert.ok(orderedResult.errors.some(({ path }) => path === '/changes/0/source_refs/1'));
});

test('rejects duplicate child disposition IDs even when their outcomes differ', () => {
  const change = {
    change_id: 'change-wiki-privacy',
    kind: 'constraint_semantics',
    trigger_refs: ['feedback:privacy'],
    source_refs: ['repo:privacy'],
    affected_refs: ['wiki-workspace'],
    proposed_disposition: 'Review Wiki impact.',
    risks: [],
    evidence_gaps: [],
    review_state: 'open',
    created_at: '2026-08-08T11:00:00Z',
    proposal_version: 1,
    semantic_target_key: 'constraint:desktop-privacy',
    baseline: { map_hash: `sha256:${'a'.repeat(64)}` },
    change_class: 'SEMANTIC',
    proposed_patch: {
      operation: 'UPDATE_CONSTRAINT',
      target_type: 'constraint',
      target_id: 'desktop-privacy',
      changed_fields: ['constraint_meaning'],
      candidate_map_hash: `sha256:${'b'.repeat(64)}`,
      expected_semantic_revision: 2,
      new_ids: [],
      successor_ids: [],
    },
    child_dispositions: [
      { domain_id: 'wiki-workspace', disposition: 'NO_CHANGE', evidence_refs: ['repo:privacy'], unresolved_fact_ids: [] },
      { domain_id: 'wiki-workspace', disposition: 'REVALIDATE', evidence_refs: ['repo:privacy'], unresolved_fact_ids: ['wiki-storage'] },
    ],
    knowledge_commitments: [],
  };

  const result = validateJson('pending-changes', { schema_version: 1, changes: [change] });

  assert.ok(result.errors.some(({ code, path }) => code === 'ID_DUPLICATE' && path === '/changes/0/child_dispositions/1/domain_id'));
});

test('separates legacy and governed pending entries and rejects duplicate change IDs', () => {
  const legacy = {
    change_id: 'change-legacy',
    kind: 'topology',
    trigger_refs: ['feedback:legacy'],
    affected_refs: ['desktop-experience'],
    proposed_disposition: 'Review topology',
    risks: [],
    evidence_gaps: [],
    review_state: 'open',
    created_at: '2026-08-08T10:00:00Z',
  };
  const governedFieldWithoutVersion = { ...legacy, source_refs: ['repo:source'] };
  const discriminated = validateJson('pending-changes', {
    schema_version: 1,
    changes: [governedFieldWithoutVersion],
  });
  assert.ok(discriminated.errors.some(({ path }) => path === '/changes/0'));

  const duplicated = validateJson('pending-changes', {
    schema_version: 1,
    changes: [legacy, { ...legacy }],
  });
  assert.ok(duplicated.errors.some(({ code, path }) => (
    code === 'ID_DUPLICATE' && path === '/changes/1/change_id'
  )));
});

test('accepts a strictly discriminated absorption pending entry and rejects incomplete lookalikes', () => {
  const absorption = {
    absorption_version: 1,
    change_id: 'absorption-fact-desktop-shell-fact',
    semantic_target_key: 'fact:desktop-shell-fact',
    conflict_revision: 2,
    candidate_commitment: `sha256:${'c'.repeat(64)}`,
    diff_id: 'diff-rewrite-desktop',
    owner_delivery_id: 'prd-desktop-theme',
    knowledge_baseline: 'baseline-1',
    new_baseline: 'baseline-2',
    operations: [{
      kind: 'REWRITE',
      fact_id: 'desktop-shell-fact',
      owner_domain_id: 'desktop-experience',
      evidence_refs: ['repo:src/desktop', 'test:desktop'],
    }],
    affected_domain_ids: ['desktop-experience'],
    affected_fact_ids: ['desktop-shell-fact'],
    affected_owner_ids: ['desktop-experience'],
    constraint_refs: [],
    relationship_refs: [],
    topology_target_ids: [],
    evidence_refs: ['repo:src/desktop', 'test:desktop'],
    risks: ['Current accepted knowledge remains unchanged until exact resolution.'],
    evidence_gaps: ['Externally verified resolution is required.'],
    review_state: 'open',
    opened_at: '2026-08-09T00:00:00.000Z',
  };

  assert.equal(validateJson('pending-changes', { schema_version: 1, changes: [absorption] }).ok, true);
  for (const candidate of [
    { ...absorption, absorption_version: undefined },
    { ...absorption, conflict_revision: 0 },
    { ...absorption, candidate_commitment: 'sha256:short' },
    { ...absorption, proposed_disposition: 'Legacy prose must not overlap.' },
  ]) {
    const result = validateJson('pending-changes', {
      schema_version: 1,
      changes: [Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined))],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(({ path }) => path === '/changes/0' || path.startsWith('/changes/0/')));
  }
});
