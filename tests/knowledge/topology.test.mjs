import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyApprovedChange } from '../../scripts/knowledge/apply-approved-change.mjs';
import { analyzeImpact, hashProjectMap } from '../../scripts/knowledge/impact.mjs';
import { proposeChange } from '../../scripts/knowledge/propose-change.mjs';

const fixtureRoot = new URL('../fixtures/knowledge/topology/base/', import.meta.url);
const lifecycle = (root) => join(root, 'docs/project-lifecycle');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const mapAt = (root) => readJson(join(lifecycle(root), 'project-map.json'));
const pendingAt = (root) => readJson(join(lifecycle(root), 'pending-changes.json'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const setup = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-topology-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
};

const treeFingerprint = async (root) => {
  const entries = [];
  const visit = async (directory, prefix = '') => {
    const children = (await readdir(directory, { withFileTypes: true }))
      .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const locator = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) await visit(join(directory, child.name), locator);
      else entries.push([locator, await readFile(join(directory, child.name), 'utf8')]);
    }
  };
  await visit(root);
  return JSON.stringify(entries);
};

const semanticProposal = (candidate, overrides = {}) => ({
  change_id: 'change-desktop-privacy',
  kind: 'constraint_semantics',
  trigger_refs: ['feedback:privacy'],
  source_refs: ['repo:privacy-policy'],
  affected_refs: ['desktop-experience', 'desktop-privacy', 'inbox-workspace', 'source-workspace', 'wiki-workspace'],
  proposed_disposition: 'Narrow privacy propagation.',
  risks: ['Descendant facts may depend on the prior scope.'],
  evidence_gaps: ['Runtime fact verification remains open.'],
  created_at: '2026-08-08T11:00:00Z',
  semantic_target_key: 'constraint:desktop-privacy',
  change_class: 'SEMANTIC',
  proposed_patch: {
    operation: 'UPDATE_CONSTRAINT',
    target_type: 'constraint',
    target_id: 'desktop-privacy',
    changed_fields: ['constraint_scope'],
    expected_semantic_revision: 2,
    new_ids: [],
    successor_ids: [],
  },
  child_dispositions: [
    { domain_id: 'inbox-workspace', disposition: 'NO_CHANGE', evidence_refs: ['repo:privacy-policy'], unresolved_fact_ids: [] },
    { domain_id: 'source-workspace', disposition: 'NO_CHANGE', evidence_refs: ['repo:privacy-policy'], unresolved_fact_ids: [] },
    { domain_id: 'wiki-workspace', disposition: 'REVALIDATE', evidence_refs: ['repo:privacy-policy'], unresolved_fact_ids: ['wiki-storage-boundary'] },
  ],
  candidate_map: candidate,
  ...overrides,
});

test('keeps horizontal relationships separate from strict parent lineage', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const result = analyzeImpact({
    current_map: map,
    candidate_map: map,
    change_class: 'SEMANTIC',
    changed_fields: ['relationship'],
    target_id: 'wiki-workspace',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.lineage_descendant_ids, []);
  assert.deepEqual(result.value.horizontal_target_ids, ['source-workspace']);
  assert.deepEqual(result.value.affected_domain_ids, ['source-workspace', 'wiki-workspace']);
});

test('calculates self, descendants, and selected-descendants propagation independently', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const selfCandidate = clone(map);
  selfCandidate.constraints[1].semantic_revision = 2;
  const descendantsCandidate = clone(map);
  descendantsCandidate.constraints[0].semantic_revision = 2;
  const selectedCurrent = clone(map);
  selectedCurrent.constraints[0].scope = 'selected_descendants';
  selectedCurrent.constraints[0].selected_descendants = ['wiki-workspace'];
  const selectedCandidate = clone(selectedCurrent);
  selectedCandidate.constraints[0].semantic_revision = 2;

  assert.deepEqual(analyzeImpact({ current_map: map, candidate_map: selfCandidate, change_class: 'SEMANTIC', changed_fields: ['constraint_meaning'], target_id: 'desktop-shell' }).value.affected_domain_ids, ['desktop-experience']);
  assert.deepEqual(analyzeImpact({ current_map: map, candidate_map: descendantsCandidate, change_class: 'SEMANTIC', changed_fields: ['constraint_meaning'], target_id: 'desktop-privacy' }).value.affected_domain_ids, ['desktop-experience', 'inbox-workspace', 'source-workspace', 'wiki-workspace']);
  assert.deepEqual(analyzeImpact({ current_map: selectedCurrent, candidate_map: selectedCandidate, change_class: 'SEMANTIC', changed_fields: ['constraint_meaning'], target_id: 'desktop-privacy' }).value.affected_domain_ids, ['desktop-experience', 'wiki-workspace']);
});

test('treats a label-only parent wording edit as non-propagating', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.domains[0].label.en = 'Desktop UX';

  const result = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'WORDING', changed_fields: ['label'], target_id: 'desktop-experience' });

  assert.equal(result.ok, true);
  assert.equal(result.value.requires_descendant_review, false);
  assert.deepEqual(result.value.affected_domain_ids, ['desktop-experience']);
});

test('requires evidence before proposing a new narrower child', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.domains.push({
    ...clone(map.domains[1]),
    id: 'search-workspace',
    label: { en: 'Search workspace', 'zh-CN': '搜索工作区' },
    purpose: { en: 'Owns search interaction', 'zh-CN': '负责搜索交互' },
    scope: { includes: ['search'], excludes: [] },
    evidence_refs: [],
  });
  candidate.domains[0].scope.includes.push('search');
  candidate.domains.sort((left, right) => left.id < right.id ? -1 : 1);

  const result = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'SEMANTIC', changed_fields: ['boundary', 'parentage'], target_id: 'search-workspace' });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'TOPOLOGY_EVIDENCE_REQUIRED');
});

test('writes or updates one pending semantic target without changing current map or knowledge', async (context) => {
  const root = await setup(context);
  const map = await mapAt(root);
  const candidate = clone(map);
  candidate.constraints[0].scope = 'selected_descendants';
  candidate.constraints[0].selected_descendants = ['wiki-workspace'];
  candidate.constraints[0].semantic_revision = 2;
  const beforeMap = await readFile(join(lifecycle(root), 'project-map.json'), 'utf8');
  const beforeKnowledge = await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8');

  const first = await proposeChange({ root, change: semanticProposal(candidate) });
  const second = await proposeChange({ root, change: semanticProposal(candidate, { proposed_disposition: 'Updated review summary.' }) });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const pending = await pendingAt(root);
  assert.equal(pending.changes.length, 1);
  assert.equal(pending.changes[0].change_id, 'change-desktop-privacy');
  assert.equal(pending.changes[0].proposed_disposition, 'Updated review summary.');
  assert.equal(pending.changes[0].baseline.map_hash, hashProjectMap(map));
  assert.equal(await readFile(join(lifecycle(root), 'project-map.json'), 'utf8'), beforeMap);
  assert.equal(await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8'), beforeKnowledge);
});

test('rejects parent merge until every active child has a reviewed disposition', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.domains[0].domain_state = 'merged';
  candidate.domains[0].successor_id = 'source-workspace';
  const result = analyzeImpact({
    current_map: map,
    candidate_map: candidate,
    change_class: 'SEMANTIC',
    changed_fields: ['lifecycle'],
    target_id: 'desktop-experience',
    child_dispositions: [{ domain_id: 'wiki-workspace', disposition: 'REPARENT', target_id: 'source-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'TOPOLOGY_CHILD_DISPOSITION_REQUIRED');
});

test('accepts a parent merge only when candidate topology matches all child dispositions', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.domains[0].domain_state = 'merged';
  candidate.domains[0].successor_id = 'source-workspace';
  candidate.domains[1].parent_id = null;
  candidate.domains[2].parent_id = null;
  candidate.domains[3].parent_id = 'source-workspace';
  candidate.domains[2].scope.includes = ['source', 'wiki'];
  const dispositions = [
    { domain_id: 'inbox-workspace', disposition: 'REPARENT', target_id: 'inbox-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
    { domain_id: 'source-workspace', disposition: 'REPARENT', target_id: 'source-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
    { domain_id: 'wiki-workspace', disposition: 'REPARENT', target_id: 'source-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
  ];

  const result = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'SEMANTIC', changed_fields: ['lifecycle'], target_id: 'desktop-experience', child_dispositions: dispositions });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.lineage_descendant_ids, ['inbox-workspace', 'source-workspace', 'wiki-workspace']);
});

test('rejects a parent closure that removes a reviewed child instead of disposing it', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.domains[0].domain_state = 'merged';
  candidate.domains[0].successor_id = 'source-workspace';
  candidate.domains = candidate.domains.filter(({ id }) => id !== 'inbox-workspace');
  const dispositions = [
    { domain_id: 'inbox-workspace', disposition: 'RETIRE', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
    { domain_id: 'source-workspace', disposition: 'NO_CHANGE', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
    { domain_id: 'wiki-workspace', disposition: 'NO_CHANGE', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
  ];

  const result = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'SEMANTIC', changed_fields: ['lifecycle'], target_id: 'desktop-experience', child_dispositions: dispositions });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'TOPOLOGY_ORPHAN_REJECTED');
});

test('requires confirmed approval metadata for a constraint exception', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.constraints[0].exceptions.push({ domain_id: 'wiki-workspace', reason_ref: 'decision:wiki-exception', approval_ref: 'approval:wiki-exception' });
  candidate.constraints[0].semantic_revision = 2;

  const result = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'SEMANTIC', changed_fields: ['exception'], target_id: 'desktop-privacy', child_dispositions: [{ domain_id: 'wiki-workspace', disposition: 'EXCEPTION', exception_ref: 'decision:wiki-exception', evidence_refs: ['decision:wiki-exception'], unresolved_fact_ids: [] }] });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.affected_domain_ids, ['desktop-experience', 'wiki-workspace']);
});

test('rejects malformed, duplicate-ID, and cyclic candidate maps without touching current root', async (context) => {
  const root = await setup(context);
  const map = await mapAt(root);
  const candidates = [];
  const duplicate = clone(map);
  duplicate.domains.push(clone(duplicate.domains[0]));
  candidates.push(duplicate);
  const cyclic = clone(map);
  cyclic.domains[0].parent_id = 'wiki-workspace';
  candidates.push(cyclic);
  candidates.push({ schema_version: 1 });
  const before = await treeFingerprint(root);

  for (const candidate of candidates) {
    const result = await proposeChange({ root, change: semanticProposal(candidate) });
    assert.equal(result.ok, false);
  }
  assert.equal(await treeFingerprint(root), before);
});

test('returns a stable failure for an incomplete proposal without mutating the root', async (context) => {
  const root = await setup(context);
  const before = await treeFingerprint(root);

  const result = await proposeChange({
    root,
    change: {
      candidate_map: await mapAt(root),
      semantic_target_key: 'domain:wiki-workspace',
      proposed_patch: {},
      child_dispositions: [],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_INPUT_INVALID');
  assert.equal(await treeFingerprint(root), before);
});

test('keeps unrelated Source routing current while the Wiki branch is pending', async (context) => {
  const root = await setup(context);
  const map = await mapAt(root);
  const candidate = clone(map);
  candidate.domains[3].purpose.en = 'Owns accepted wiki editing';
  await proposeChange({ root, change: semanticProposal(candidate, {
    kind: 'topology',
    semantic_target_key: 'domain:wiki-workspace',
    affected_refs: ['wiki-workspace'],
    proposed_patch: { operation: 'UPDATE_DOMAIN', target_type: 'domain', target_id: 'wiki-workspace', changed_fields: ['boundary'], new_ids: [], successor_ids: [] },
    child_dispositions: [],
  }) });

  const current = await mapAt(root);
  assert.equal(current.domains.find(({ id }) => id === 'source-workspace').domain_state, 'confirmed');
  assert.equal((await pendingAt(root)).changes[0].affected_refs.includes('source-workspace'), false);
});

test('rejects a candidate that bundles an unrelated branch mutation', async (context) => {
  const root = await setup(context);
  const map = await mapAt(root);
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  candidate.domains[2].purpose.en = 'Unreviewed Source mutation';
  const before = await treeFingerprint(root);

  const result = await proposeChange({ root, change: semanticProposal(candidate) });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
  assert.equal(await treeFingerprint(root), before);
});

test('rejects proposal metadata that disagrees with the reviewed candidate', async (context) => {
  const root = await setup(context);
  const map = await mapAt(root);
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  const proposal = semanticProposal(candidate);
  proposal.proposed_patch.expected_semantic_revision = 9;
  const before = await treeFingerprint(root);

  const result = await proposeChange({ root, change: proposal });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_PROPOSAL_MISMATCH');
  assert.equal(await treeFingerprint(root), before);
});
