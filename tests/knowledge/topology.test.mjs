import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyApprovedChange } from '../../scripts/knowledge/apply-approved-change.mjs';
import { bootstrap } from '../../scripts/knowledge/bootstrap.mjs';
import { analyzeImpact, hashProjectMap } from '../../scripts/knowledge/impact.mjs';
import { materializeCapability } from '../../scripts/knowledge/materialize.mjs';
import { proposeChange } from '../../scripts/knowledge/propose-change.mjs';

const fixtureRoot = new URL('../fixtures/knowledge/topology/base/', import.meta.url);
const materializationFixture = new URL('../fixtures/knowledge/materialization/valid-input.json', import.meta.url);
const lifecycle = (root) => join(root, 'docs/project-lifecycle');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const mapAt = (root) => readJson(join(lifecycle(root), 'project-map.json'));
const pendingAt = (root) => readJson(join(lifecycle(root), 'pending-changes.json'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const setupMaterializedLeaf = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-topology-leaf-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  const domain = {
    id: 'runtime',
    kind: 'domain',
    label: { en: 'Runtime', 'zh-CN': '运行时' },
    purpose: { en: 'Owns runtime behavior.', 'zh-CN': '负责运行时行为。' },
    domain_state: 'confirmed',
    scope: { includes: ['runtime', 'runtime loop'], excludes: [] },
    parent_id: null,
    relationships: [],
    evidence_refs: ['repo:src/runtime'],
    known_gaps: [],
  };
  const bootstrapped = await bootstrap({
    root,
    project_id: 'topology-sample',
    label: { en: 'Topology sample', 'zh-CN': '拓扑示例' },
    purpose: { en: 'Exercises governed topology.', 'zh-CN': '用于测试受治理拓扑。' },
    calibration_ref: 'approval:topology-calibration',
    calibration_approved: true,
    domains: [domain],
  });
  assert.equal(bootstrapped.ok, true, JSON.stringify(bootstrapped));
  const input = clone(await readJson(materializationFixture));
  Object.assign(input, {
    root,
    domain_id: 'runtime',
    owner_id: 'runtime',
    baseline: 'baseline-runtime',
    approval_ref: 'approval:runtime',
    dependency_ids: [],
    authoritative_evidence_refs: ['repo:src/runtime', 'test:runtime'],
    implementation_refs: ['repo:src/runtime'],
    verification_refs: ['test:runtime'],
    targets: { en: 'knowledge/runtime-en.md', 'zh-CN': 'knowledge/runtime.md' },
  });
  for (const language of ['en', 'zh-CN']) {
    input.pair[language].facts[0].fact_id = 'fact-runtime';
    input.pair[language].facts[0].evidence_refs = ['repo:src/runtime', 'test:runtime'];
  }
  const materialized = await materializeCapability(input);
  assert.equal(materialized.ok, true, JSON.stringify(materialized));
  const lifecycleRoot = lifecycle(root);
  const map = await mapAt(root);
  map.constraints.push({
    id: 'runtime-rule',
    scope: 'self',
    owner_id: 'runtime',
    semantic_revision: 1,
    lifecycle_state: 'current',
    knowledge_refs: {
      en: 'knowledge/runtime-en.md#constraint-runtime-rule',
      'zh-CN': 'knowledge/runtime.md#constraint-runtime-rule',
    },
    exceptions: [],
  });
  await writeFile(join(lifecycleRoot, 'project-map.json'), `${JSON.stringify(map, null, 2)}\n`);
  for (const locator of ['knowledge/runtime-en.md', 'knowledge/runtime.md']) {
    const source = await readFile(join(lifecycleRoot, locator), 'utf8');
    await writeFile(join(lifecycleRoot, locator), `${source.trimEnd()}\n\n<a id="constraint-runtime-rule"></a>\n<!-- project-lifecycle:constraint id=runtime-rule revision=1 -->\nRuntime rule.\n<!-- /project-lifecycle:constraint -->\n`);
  }
  return root;
};

const updateDomainPurpose = async (root) => {
  const update = { domain_id: 'desktop-experience' };
  for (const [language, name, currentPurpose, nextPurpose] of [
    ['en', 'desktop-experience-en.md', 'Owns accepted desktop interaction.', 'Owns revised desktop interaction.'],
    ['zh-CN', 'desktop-experience.md', '负责已验收的桌面交互。', '负责修订后的桌面交互。'],
  ]) {
    const source = await readFile(join(lifecycle(root), 'knowledge/desktop-experience', name), 'utf8');
    update[language] = {
      locator: `knowledge/desktop-experience/${name}`,
      content: source.replace(currentPurpose, nextPurpose),
    };
  }
  return [update];
};

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
    { domain_id: 'wiki-workspace', disposition: 'REVALIDATE', evidence_refs: ['repo:privacy-policy'], unresolved_fact_ids: [] },
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

test('does not let WORDING bypass the declared operation validator', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const labelCandidate = clone(map);
  labelCandidate.domains[0].label.en = 'Desktop UX';
  for (const operation of ['ADD_DOMAIN', 'ADD_RELATIONSHIP', 'MERGE_DOMAIN']) {
    const result = analyzeImpact({ current_map: map, candidate_map: labelCandidate, change_class: 'WORDING', changed_fields: ['label'], target_id: 'desktop-experience', operation });
    assert.equal(result.ok, false, operation);
    assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
  }
  for (const operation of ['ADD_CONSTRAINT', 'ADD_EXCEPTION', 'REPLACE_CONSTRAINT']) {
    const result = analyzeImpact({ current_map: map, candidate_map: map, change_class: 'WORDING', changed_fields: ['label'], target_id: 'desktop-privacy', operation });
    assert.equal(result.ok, false, operation);
    assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
  }
  assert.equal(analyzeImpact({ current_map: map, candidate_map: labelCandidate, change_class: 'WORDING', changed_fields: ['label'], target_id: 'desktop-experience', operation: 'UPDATE_DOMAIN' }).ok, true);
  assert.equal(analyzeImpact({ current_map: map, candidate_map: map, change_class: 'WORDING', changed_fields: ['label'], target_id: 'desktop-privacy', operation: 'UPDATE_CONSTRAINT' }).ok, true);
});

test('rejects a WORDING ADD_DOMAIN bypass before writing pending state', async (context) => {
  const root = await setup(context);
  const map = await mapAt(root);
  const candidate = clone(map);
  candidate.domains[0].label.en = 'Desktop UX';
  const proposal = semanticProposal(candidate, {
    change_id: 'change-desktop-wording',
    kind: 'topology',
    semantic_target_key: 'domain:desktop-experience',
    change_class: 'WORDING',
    affected_refs: ['desktop-experience'],
    proposed_patch: { operation: 'ADD_DOMAIN', target_type: 'domain', target_id: 'desktop-experience', changed_fields: ['label'], new_ids: [], successor_ids: [] },
    child_dispositions: [],
  });
  const before = await treeFingerprint(root);
  const result = await proposeChange({ root, change: proposal });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
  assert.equal(await treeFingerprint(root), before);
});

test('rejects a persisted WORDING operation bypass before approved apply', async (context) => {
  const root = await setup(context);
  const map = await mapAt(root);
  const candidate = clone(map);
  candidate.domains[0].label.en = 'Desktop UX';
  const proposal = semanticProposal(candidate, {
    change_id: 'change-desktop-wording',
    kind: 'topology',
    semantic_target_key: 'domain:desktop-experience',
    change_class: 'WORDING',
    affected_refs: ['desktop-experience'],
    proposed_patch: { operation: 'UPDATE_DOMAIN', target_type: 'domain', target_id: 'desktop-experience', changed_fields: ['label'], new_ids: [], successor_ids: [] },
    child_dispositions: [],
  });
  const proposed = await proposeChange({ root, change: proposal });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const pending = await pendingAt(root);
  pending.changes[0].proposed_patch.operation = 'ADD_DOMAIN';
  await writeFile(join(lifecycle(root), 'pending-changes.json'), `${JSON.stringify(pending, null, 2)}\n`);
  const before = await treeFingerprint(root);
  const result = await applyApprovedChange({
    root,
    change_id: proposal.change_id,
    approval_ref: 'approval:wording',
    traceability: { knowledge_diff_ref: 'diff:wording', history_ref: 'git:wording' },
    candidate_map: candidate,
    knowledge_updates: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
  assert.equal(await treeFingerprint(root), before);
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
  const beforeKnowledge = await readFile(join(lifecycle(root), 'knowledge/desktop-experience/desktop-experience-en.md'), 'utf8');

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
  assert.equal(await readFile(join(lifecycle(root), 'knowledge/desktop-experience/desktop-experience-en.md'), 'utf8'), beforeKnowledge);
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
  candidate.domains[3].parent_id = null;
  const dispositions = [
    { domain_id: 'inbox-workspace', disposition: 'REPARENT', target_id: 'inbox-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
    { domain_id: 'source-workspace', disposition: 'REPARENT', target_id: 'source-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
    { domain_id: 'wiki-workspace', disposition: 'REPARENT', target_id: 'wiki-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
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

test('updates exactly one reviewed constraint exception without routing metadata changes', async () => {
  const current = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  current.constraints[0].exceptions.push({ domain_id: 'wiki-workspace', reason_ref: 'decision:old-exception', approval_ref: 'approval:old-exception' });
  const unchangedRevision = clone(current);
  unchangedRevision.constraints[0].exceptions[0] = { domain_id: 'wiki-workspace', reason_ref: 'decision:new-exception', approval_ref: 'approval:new-exception' };
  const stale = analyzeImpact({
    current_map: current,
    candidate_map: unchangedRevision,
    change_class: 'SEMANTIC',
    changed_fields: ['exception'],
    target_id: 'desktop-privacy',
    operation: 'ADD_EXCEPTION',
    child_dispositions: [{ domain_id: 'wiki-workspace', disposition: 'EXCEPTION', exception_ref: 'decision:new-exception', evidence_refs: ['decision:new-exception'], unresolved_fact_ids: [] }],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.errors[0].code, 'CONSTRAINT_REVISION_INVALID');

  const candidate = clone(unchangedRevision);
  candidate.constraints[0].semantic_revision = 2;
  const accepted = analyzeImpact({
    current_map: current,
    candidate_map: candidate,
    change_class: 'SEMANTIC',
    changed_fields: ['exception'],
    target_id: 'desktop-privacy',
    operation: 'ADD_EXCEPTION',
    child_dispositions: [{ domain_id: 'wiki-workspace', disposition: 'EXCEPTION', exception_ref: 'decision:new-exception', evidence_refs: ['decision:new-exception'], unresolved_fact_ids: [] }],
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.value.affected_domain_ids, ['desktop-experience', 'wiki-workspace']);
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
  candidate.constraints[0].scope = 'selected_descendants';
  candidate.constraints[0].selected_descendants = ['wiki-workspace'];
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
  candidate.constraints[0].scope = 'selected_descendants';
  candidate.constraints[0].selected_descendants = ['wiki-workspace'];
  candidate.constraints[0].semantic_revision = 2;
  const proposal = semanticProposal(candidate);
  proposal.proposed_patch.expected_semantic_revision = 9;
  const before = await treeFingerprint(root);

  const result = await proposeChange({ root, change: proposal });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_PROPOSAL_MISMATCH');
  assert.equal(await treeFingerprint(root), before);
});

test('binds ADD_RELATIONSHIP to one declared horizontal edge', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.domains[1].relationships.push({ kind: 'depends_on', target_id: 'source-workspace' });
  candidate.domains[1].parent_id = null;
  const result = analyzeImpact({
    current_map: map,
    candidate_map: candidate,
    change_class: 'SEMANTIC',
    changed_fields: ['relationship'],
    target_id: 'inbox-workspace',
    operation: 'ADD_RELATIONSHIP',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
});

test('binds a relationship proposal key and affected refs to the added edge', async (context) => {
  const root = await setup(context);
  const map = await mapAt(root);
  const candidate = clone(map);
  candidate.domains[1].relationships.push({ kind: 'depends_on', target_id: 'source-workspace' });
  const proposal = semanticProposal(candidate, {
    change_id: 'change-inbox-source-edge',
    kind: 'topology',
    semantic_target_key: 'relationship:inbox-workspace:source-workspace',
    affected_refs: ['inbox-workspace', 'source-workspace'],
    proposed_patch: { operation: 'ADD_RELATIONSHIP', target_type: 'relationship', target_id: 'inbox-workspace', changed_fields: ['relationship'], new_ids: [], successor_ids: [] },
    child_dispositions: [],
  });
  assert.equal((await proposeChange({ root, change: proposal })).ok, true);
  assert.equal((await pendingAt(root)).changes[0].semantic_target_key, proposal.semantic_target_key);
});

test('binds ADD_DOMAIN to exactly one evidenced child without parent mutation', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.domains.push({
    ...clone(map.domains[1]),
    id: 'inbox-search',
    label: { en: 'Inbox search', 'zh-CN': '收件箱搜索' },
    purpose: { en: 'Owns inbox search', 'zh-CN': '负责收件箱搜索' },
    evidence_refs: ['repo:inbox-search'],
  });
  candidate.domains.sort((left, right) => left.id < right.id ? -1 : 1);
  const accepted = analyzeImpact({
    current_map: map,
    candidate_map: candidate,
    change_class: 'SEMANTIC',
    changed_fields: ['boundary', 'kind', 'lifecycle', 'parentage'],
    target_id: 'inbox-search',
    operation: 'ADD_DOMAIN',
  });
  assert.equal(accepted.ok, true);
  candidate.domains[0].purpose.en = 'Smuggled parent rewrite';
  const result = analyzeImpact({
    current_map: map,
    candidate_map: candidate,
    change_class: 'SEMANTIC',
    changed_fields: ['boundary', 'parentage'],
    target_id: 'inbox-search',
    operation: 'ADD_DOMAIN',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
});

test('rejects merge dispositions that leave active children under a merged parent', async () => {
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
    operation: 'MERGE_DOMAIN',
    child_dispositions: map.domains.slice(1).map(({ id }) => ({
      domain_id: id,
      disposition: 'NO_CHANGE',
      evidence_refs: ['decision:merge'],
      unresolved_fact_ids: [],
    })),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'TOPOLOGY_DISPOSITION_MISMATCH');
});

test('rejects a MERGE_DOMAIN candidate that rewrites undeclared parent fields', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.domains[0].domain_state = 'merged';
  candidate.domains[0].successor_id = 'source-workspace';
  candidate.domains[0].purpose.en = 'Smuggled parent rewrite';
  candidate.domains[1].parent_id = null;
  candidate.domains[2].parent_id = null;
  candidate.domains[3].parent_id = 'source-workspace';
  candidate.domains[2].scope.includes = ['source', 'wiki'];
  const dispositions = [
    { domain_id: 'inbox-workspace', disposition: 'REPARENT', target_id: 'inbox-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
    { domain_id: 'source-workspace', disposition: 'REPARENT', target_id: 'source-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
    { domain_id: 'wiki-workspace', disposition: 'REPARENT', target_id: 'source-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
  ];
  const result = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'SEMANTIC', changed_fields: ['lifecycle'], target_id: 'desktop-experience', operation: 'MERGE_DOMAIN', child_dispositions: dispositions });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
});

test('applies an exact topology-only revalidation marker without constraint revisions', async (context) => {
  const root = await setup(context);
  const map = await mapAt(root);
  const candidate = clone(map);
  candidate.domains[0].purpose = { en: 'Owns revised desktop interaction', 'zh-CN': '负责修订后的桌面交互' };
  candidate.revalidation_required = [{
    domain_id: 'wiki-workspace',
    fact_id: 'wiki-storage-boundary',
    reason_ref: 'change-desktop-boundary',
  }];
  const updates = await updateDomainPurpose(root);
  const proposal = semanticProposal(candidate, {
    change_id: 'change-desktop-boundary',
    kind: 'topology',
    semantic_target_key: 'domain:desktop-experience',
    affected_refs: ['desktop-experience', 'inbox-workspace', 'source-workspace', 'wiki-workspace'],
    proposed_patch: { operation: 'UPDATE_DOMAIN', target_type: 'domain', target_id: 'desktop-experience', changed_fields: ['boundary'], new_ids: [], successor_ids: [] },
    child_dispositions: [
      { domain_id: 'inbox-workspace', disposition: 'NO_CHANGE', evidence_refs: ['decision:desktop-boundary'], unresolved_fact_ids: [] },
      { domain_id: 'source-workspace', disposition: 'NO_CHANGE', evidence_refs: ['decision:desktop-boundary'], unresolved_fact_ids: [] },
      { domain_id: 'wiki-workspace', disposition: 'REVALIDATE', evidence_refs: ['decision:desktop-boundary'], unresolved_fact_ids: ['wiki-storage-boundary'] },
    ],
    knowledge_candidates: updates,
  });
  const proposed = await proposeChange({ root, change: proposal });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const result = await applyApprovedChange({
    root,
    change_id: proposal.change_id,
    approval_ref: 'approval:desktop-boundary',
    traceability: { knowledge_diff_ref: 'diff:desktop-boundary', history_ref: 'git:desktop-boundary' },
    candidate_map: candidate,
    knowledge_updates: updates,
  });
  assert.equal(result.ok, true);
  assert.deepEqual((await mapAt(root)).revalidation_required, candidate.revalidation_required);
});

test('rejects ADD_DOMAIN declarations that masquerade as label or relationship changes', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.domains.push({
    ...clone(map.domains[1]),
    id: 'inbox-search',
    label: { en: 'Inbox search', 'zh-CN': '收件箱搜索' },
    purpose: { en: 'Owns inbox search', 'zh-CN': '负责收件箱搜索' },
    evidence_refs: ['repo:inbox-search'],
  });
  candidate.domains.sort((left, right) => left.id < right.id ? -1 : 1);
  const result = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'SEMANTIC', changed_fields: ['label', 'relationship'], target_id: 'inbox-search', operation: 'ADD_DOMAIN' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
});

test('rejects MERGE child label rewrites and SPLIT without a successor redirect', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const merged = clone(map);
  merged.domains[0].domain_state = 'merged';
  merged.domains[0].successor_id = 'source-workspace';
  for (const domain of merged.domains.slice(1)) domain.parent_id = null;
  merged.domains[1].label.en = 'Smuggled child label';
  const reparent = map.domains.slice(1).map(({ id }) => ({ domain_id: id, disposition: 'REPARENT', target_id: id, evidence_refs: ['decision:merge'], unresolved_fact_ids: [] }));
  const labelResult = analyzeImpact({ current_map: map, candidate_map: merged, change_class: 'SEMANTIC', changed_fields: ['lifecycle'], target_id: 'desktop-experience', operation: 'MERGE_DOMAIN', child_dispositions: reparent });
  assert.equal(labelResult.ok, false);
  assert.equal(labelResult.errors[0].code, 'CHANGE_NOT_BOUNDED');

  const split = clone(map);
  split.domains[0].domain_state = 'merged';
  split.domains[0].successor_id = 'source-workspace';
  split.domains[1].domain_state = 'retired';
  split.domains[1].retirement_reason = 'Split into successor';
  split.domains[2].parent_id = null;
  split.domains[3].parent_id = null;
  const dispositions = [
    { domain_id: 'inbox-workspace', disposition: 'SPLIT', target_id: 'source-workspace', evidence_refs: ['decision:split'], unresolved_fact_ids: [] },
    { domain_id: 'source-workspace', disposition: 'REPARENT', target_id: 'source-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
    { domain_id: 'wiki-workspace', disposition: 'REPARENT', target_id: 'wiki-workspace', evidence_refs: ['decision:merge'], unresolved_fact_ids: [] },
  ];
  const splitResult = analyzeImpact({ current_map: map, candidate_map: split, change_class: 'SEMANTIC', changed_fields: ['lifecycle'], target_id: 'desktop-experience', operation: 'MERGE_DOMAIN', child_dispositions: dispositions });
  assert.equal(splitResult.ok, false);
  assert.equal(splitResult.errors[0].code, 'TOPOLOGY_DISPOSITION_MISMATCH');
});

test('requires a changed bilingual commitment for materialized domain boundary updates', async (context) => {
  const root = await setup(context);
  const map = await mapAt(root);
  const candidate = clone(map);
  candidate.domains[0].purpose = { en: 'Owns revised desktop interaction', 'zh-CN': '负责修订后的桌面交互' };
  const proposal = semanticProposal(candidate, {
    change_id: 'change-desktop-purpose',
    kind: 'topology',
    semantic_target_key: 'domain:desktop-experience',
    affected_refs: ['desktop-experience', 'inbox-workspace', 'source-workspace', 'wiki-workspace'],
    proposed_patch: { operation: 'UPDATE_DOMAIN', target_type: 'domain', target_id: 'desktop-experience', changed_fields: ['boundary'], new_ids: [], successor_ids: [] },
    child_dispositions: map.domains.slice(1).map(({ id }) => ({ domain_id: id, disposition: 'NO_CHANGE', evidence_refs: ['decision:purpose'], unresolved_fact_ids: [] })),
  });
  const before = await treeFingerprint(root);
  const result = await proposeChange({ root, change: proposal });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_KNOWLEDGE_COMMITMENT_REQUIRED');
  assert.equal(await treeFingerprint(root), before);

  const unchangedRoot = await setup(context);
  const unchangedMap = await mapAt(unchangedRoot);
  const unchangedCandidate = clone(unchangedMap);
  unchangedCandidate.domains[0].purpose = { en: 'Owns revised desktop interaction', 'zh-CN': '负责修订后的桌面交互' };
  const unchangedPair = { domain_id: 'desktop-experience' };
  for (const [language, name] of [['en', 'desktop-experience-en.md'], ['zh-CN', 'desktop-experience.md']]) {
    unchangedPair[language] = {
      locator: `knowledge/desktop-experience/${name}`,
      content: await readFile(join(lifecycle(unchangedRoot), 'knowledge/desktop-experience', name), 'utf8'),
    };
  }
  const unchangedProposal = semanticProposal(unchangedCandidate, {
    change_id: 'change-desktop-purpose',
    kind: 'topology',
    semantic_target_key: 'domain:desktop-experience',
    affected_refs: ['desktop-experience', 'inbox-workspace', 'source-workspace', 'wiki-workspace'],
    proposed_patch: { operation: 'UPDATE_DOMAIN', target_type: 'domain', target_id: 'desktop-experience', changed_fields: ['boundary'], new_ids: [], successor_ids: [] },
    child_dispositions: unchangedMap.domains.slice(1).map(({ id }) => ({ domain_id: id, disposition: 'NO_CHANGE', evidence_refs: ['decision:purpose'], unresolved_fact_ids: [] })),
    knowledge_candidates: [unchangedPair],
  });
  const unchanged = await proposeChange({ root: unchangedRoot, change: unchangedProposal });
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.errors[0].code, 'CHANGE_KNOWLEDGE_COMMITMENT_UNCHANGED');

  const duplicateProposal = clone(unchangedProposal);
  duplicateProposal.knowledge_candidates.push(clone(unchangedPair));
  const duplicate = await proposeChange({ root: unchangedRoot, change: duplicateProposal });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.errors[0].code, 'CHANGE_KNOWLEDGE_COMMITMENT_INVALID');
});

test('planner-derived promotion and demotion move a parent pair symmetrically', async (context) => {
  const root = await setupMaterializedLeaf(context);
  const rootIndexPath = join(lifecycle(root), 'INDEX-en.md');
  const rootIndexBefore = await readFile(rootIndexPath, 'utf8');
  const rootIndexTime = (await stat(rootIndexPath)).mtimeMs;
  const current = await mapAt(root);
  const promotedCandidate = clone(current);
  promotedCandidate.domains.push({
    id: 'loop',
    kind: 'capability',
    label: { en: 'Loop', 'zh-CN': '循环' },
    purpose: { en: 'Owns the runtime loop.', 'zh-CN': '负责运行循环。' },
    domain_state: 'confirmed',
    scope: { includes: ['runtime loop'], excludes: [] },
    parent_id: 'runtime',
    relationships: [],
    evidence_refs: ['repo:src/loop'],
    known_gaps: [],
  });
  promotedCandidate.domains.sort((left, right) => left.id < right.id ? -1 : 1);
  const promotion = semanticProposal(promotedCandidate, {
    change_id: 'change-add-loop',
    kind: 'topology',
    trigger_refs: ['decision:add-loop'],
    source_refs: ['repo:src/loop'],
    affected_refs: ['loop'],
    semantic_target_key: 'domain:loop',
    proposed_patch: {
      operation: 'ADD_DOMAIN',
      target_type: 'domain',
      target_id: 'loop',
      changed_fields: ['boundary', 'kind', 'lifecycle', 'parentage'],
      new_ids: [],
      successor_ids: [],
    },
    child_dispositions: [],
  });
  const proposedPromotion = await proposeChange({ root, change: promotion });
  assert.equal(proposedPromotion.ok, true, JSON.stringify(proposedPromotion));
  const promoted = await applyApprovedChange({
    root,
    change_id: promotion.change_id,
    approval_ref: 'approval:add-loop',
    traceability: { knowledge_diff_ref: 'diff:add-loop', history_ref: 'git:add-loop' },
    candidate_map: promotedCandidate,
    knowledge_updates: [],
  });
  assert.equal(promoted.ok, true, JSON.stringify(promoted));
  const promotedMap = await mapAt(root);
  assert.equal(promotedMap.domains.find(({ id }) => id === 'runtime').paired_assets.en,
    'knowledge/runtime/runtime-en.md');
  assert.equal(promotedMap.constraints[0].knowledge_refs.en,
    'knowledge/runtime/runtime-en.md#constraint-runtime-rule');
  assert.equal(await readFile(join(lifecycle(root), 'knowledge/runtime/runtime-en.md'), 'utf8')
    .then(() => true, () => false), true);
  assert.equal(await readFile(join(lifecycle(root), 'knowledge/runtime-en.md'), 'utf8')
    .then(() => true, () => false), false);
  assert.equal(await readFile(rootIndexPath, 'utf8'), rootIndexBefore);
  assert.equal(Math.abs((await stat(rootIndexPath)).mtimeMs - rootIndexTime) < 0.001, true);

  const demotedCandidate = clone(promotedMap);
  demotedCandidate.domains.find(({ id }) => id === 'loop').parent_id = null;
  const demotion = semanticProposal(demotedCandidate, {
    change_id: 'change-reparent-loop',
    kind: 'topology',
    trigger_refs: ['decision:reparent-loop'],
    source_refs: ['repo:src/loop'],
    affected_refs: ['loop'],
    semantic_target_key: 'domain:loop',
    proposed_patch: {
      operation: 'UPDATE_DOMAIN',
      target_type: 'domain',
      target_id: 'loop',
      changed_fields: ['parentage'],
      new_ids: [],
      successor_ids: [],
    },
    child_dispositions: [],
  });
  const proposedDemotion = await proposeChange({ root, change: demotion });
  assert.equal(proposedDemotion.ok, true, JSON.stringify(proposedDemotion));
  const demoted = await applyApprovedChange({
    root,
    change_id: demotion.change_id,
    approval_ref: 'approval:reparent-loop',
    traceability: { knowledge_diff_ref: 'diff:reparent-loop', history_ref: 'git:reparent-loop' },
    candidate_map: demotedCandidate,
    knowledge_updates: [],
  });
  assert.equal(demoted.ok, true, JSON.stringify(demoted));
  const demotedMap = await mapAt(root);
  assert.equal(demotedMap.domains.find(({ id }) => id === 'runtime').paired_assets.en,
    'knowledge/runtime-en.md');
  assert.equal(demotedMap.constraints[0].knowledge_refs.en,
    'knowledge/runtime-en.md#constraint-runtime-rule');
  assert.equal(await readFile(join(lifecycle(root), 'knowledge/runtime-en.md'), 'utf8')
    .then(() => true, () => false), true);
  assert.equal(await readFile(join(lifecycle(root), 'knowledge/runtime/runtime-en.md'), 'utf8')
    .then(() => true, () => false), false);
});
