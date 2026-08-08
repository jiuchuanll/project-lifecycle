import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyApprovedChange } from '../../scripts/knowledge/apply-approved-change.mjs';
import { analyzeImpact } from '../../scripts/knowledge/impact.mjs';
import { proposeChange } from '../../scripts/knowledge/propose-change.mjs';

const fixtureRoot = new URL('../fixtures/knowledge/topology/base/', import.meta.url);
const lifecycle = (root) => join(root, 'docs/project-lifecycle');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const setup = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-constraints-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
};
const fingerprint = async (root) => {
  const entries = [];
  const visit = async (directory, prefix = '') => {
    for (const child of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const locator = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) await visit(join(directory, child.name), locator);
      else entries.push([locator, await readFile(join(directory, child.name), 'utf8')]);
    }
  };
  await visit(root);
  return JSON.stringify(entries);
};
const proposalFor = (candidate, overrides = {}) => ({
  change_id: 'change-desktop-privacy',
  kind: 'constraint_semantics',
  trigger_refs: ['feedback:privacy'],
  source_refs: ['repo:privacy-policy'],
  affected_refs: ['desktop-experience', 'desktop-privacy', 'inbox-workspace', 'source-workspace', 'wiki-workspace'],
  proposed_disposition: 'Update desktop privacy.',
  risks: [],
  evidence_gaps: [],
  created_at: '2026-08-08T11:00:00Z',
  semantic_target_key: 'constraint:desktop-privacy',
  change_class: 'SEMANTIC',
  proposed_patch: { operation: 'UPDATE_CONSTRAINT', target_type: 'constraint', target_id: 'desktop-privacy', changed_fields: ['constraint_meaning'], expected_semantic_revision: 2, new_ids: [], successor_ids: [] },
  child_dispositions: [
    { domain_id: 'inbox-workspace', disposition: 'NO_CHANGE', evidence_refs: ['repo:privacy-policy'], unresolved_fact_ids: [] },
    { domain_id: 'source-workspace', disposition: 'NO_CHANGE', evidence_refs: ['repo:privacy-policy'], unresolved_fact_ids: [] },
    { domain_id: 'wiki-workspace', disposition: 'REVALIDATE', evidence_refs: ['repo:privacy-policy'], unresolved_fact_ids: [] },
  ],
  candidate_map: candidate,
  ...overrides,
});

const revalidatingProposal = (candidate, overrides = {}) => {
  const proposal = proposalFor(candidate, overrides);
  proposal.child_dispositions[2].unresolved_fact_ids = ['wiki-storage-boundary'];
  return proposal;
};

const updateConstraintSections = async (root, oldId, newId, revision) => {
  const updates = { domain_id: 'desktop-experience' };
  for (const [language, name] of [['en', 'desktop-experience-en.md'], ['zh-CN', 'desktop-experience.md']]) {
    const source = await readFile(join(lifecycle(root), 'knowledge', name), 'utf8');
    const replaced = oldId === newId
      ? source.replaceAll(`id=${oldId} revision=1`, `id=${newId} revision=${revision}`)
      : `${source.trimEnd()}\n\n<a id="constraint-${newId}"></a>\n<!-- project-lifecycle:constraint id=${newId} revision=${revision} -->\nReplacement constraint content.\n<!-- /project-lifecycle:constraint -->\n`;
    updates[language] = { locator: `knowledge/${name}`, content: replaced };
  }
  return [updates];
};

const preparedSemanticChange = async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  candidate.revalidation_required = [{ domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', reason_ref: 'change-desktop-privacy', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 }];
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
  await proposeChange({ root, change: revalidatingProposal(candidate, { knowledge_candidates: updates }) });
  return { root, candidate, updates };
};

test('WORDING preserves semantic revision and rejects machine-routing changes', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  assert.equal(analyzeImpact({ current_map: map, candidate_map: map, change_class: 'WORDING', changed_fields: ['label'], target_id: 'desktop-privacy' }).ok, true);
  assert.equal(analyzeImpact({ current_map: map, candidate_map: map, change_class: 'WORDING', changed_fields: ['label'], target_id: 'desktop-privacy', operation: 'UPDATE_CONSTRAINT' }).ok, true);
  const candidate = clone(map);
  candidate.constraints[0].scope = 'self';
  const result = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'WORDING', changed_fields: ['constraint_scope'], target_id: 'desktop-privacy' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CONSTRAINT_CHANGE_CLASS_INVALID');
  const disguised = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'WORDING', changed_fields: ['label'], target_id: 'desktop-privacy' });
  assert.equal(disguised.ok, false);
  assert.equal(disguised.errors[0].code, 'CONSTRAINT_CHANGE_CLASS_INVALID');
});

test('SEMANTIC increments exactly one and calculates descendant impact', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  for (const revision of [1, 3]) {
    const candidate = clone(map);
    candidate.constraints[0].semantic_revision = revision;
    const result = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'SEMANTIC', changed_fields: ['constraint_meaning'], target_id: 'desktop-privacy' });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'CONSTRAINT_REVISION_INVALID');
  }
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  const accepted = analyzeImpact({ current_map: map, candidate_map: candidate, change_class: 'SEMANTIC', changed_fields: ['constraint_meaning'], target_id: 'desktop-privacy' });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.value.affected_domain_ids, ['desktop-experience', 'inbox-workspace', 'source-workspace', 'wiki-workspace']);
});

test('rejects project identity changes bundled into a domain or constraint proposal', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  candidate.project_identity.purpose.en = 'Smuggled unrelated identity purpose.';

  const result = analyzeImpact({
    current_map: map,
    candidate_map: candidate,
    change_class: 'SEMANTIC',
    changed_fields: ['constraint_meaning'],
    target_id: 'desktop-privacy',
    operation: 'UPDATE_CONSTRAINT',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
  assert.equal(result.errors[0].path, '/candidate_map/project_identity');
});

test('rejects a global knowledge baseline advance hidden inside a Task 4 proposal', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  candidate.knowledge_baseline = 'baseline-unreviewed';

  const result = analyzeImpact({
    current_map: map,
    candidate_map: candidate,
    change_class: 'SEMANTIC',
    changed_fields: ['constraint_meaning'],
    target_id: 'desktop-privacy',
    operation: 'UPDATE_CONSTRAINT',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_NOT_BOUNDED');
  assert.equal(result.errors[0].path, '/candidate_map/knowledge_baseline');
});

test('approved SEMANTIC application atomically updates map, pair, indexes, traceability, and revalidation markers', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  candidate.revalidation_required = [{ domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', reason_ref: 'change-desktop-privacy', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 }];
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
  await proposeChange({ root, change: revalidatingProposal(candidate, { knowledge_candidates: updates }) });

  const result = await applyApprovedChange({
    root,
    change_id: 'change-desktop-privacy',
    approval_ref: 'approval:desktop-privacy-v2',
    traceability: { knowledge_diff_ref: 'knowledge-diff:desktop-privacy-v2', history_ref: 'git:candidate-commit' },
    candidate_map: candidate,
    knowledge_updates: updates,
  });

  assert.equal(result.ok, true);
  const appliedMap = await readJson(join(lifecycle(root), 'project-map.json'));
  assert.equal(appliedMap.constraints[0].semantic_revision, 2);
  assert.equal(appliedMap.project_id, map.project_id);
  assert.deepEqual(appliedMap.project_identity, map.project_identity);
  assert.deepEqual((await readJson(join(lifecycle(root), 'pending-changes.json'))).changes, []);
  assert.match(await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8'), /id=desktop-privacy revision=2/);
  assert.match(await readFile(join(lifecycle(root), 'INDEX-en.md'), 'utf8'), /desktop-experience/);
  assert.match(await readFile(join(lifecycle(root), 'INDEX-en.md'), 'utf8'), /Sample app/);
  assert.match(await readFile(join(lifecycle(root), 'INDEX.md'), 'utf8'), /示例应用/);
});

test('SEMANTIC application requires approval and complete child dispositions', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  const proposal = proposalFor(candidate);
  proposal.child_dispositions.pop();
  await proposeChange({ root, change: proposal });
  const before = await fingerprint(root);
  const missingApproval = await applyApprovedChange({ root, change_id: proposal.change_id, approval_ref: '', traceability: { knowledge_diff_ref: 'diff:x', history_ref: 'git:x' }, candidate_map: candidate, knowledge_updates: [] });
  assert.equal(missingApproval.ok, false);
  assert.equal(await fingerprint(root), before);
  const incomplete = await applyApprovedChange({ root, change_id: proposal.change_id, approval_ref: 'approval:x', traceability: { knowledge_diff_ref: 'diff:x', history_ref: 'git:x' }, candidate_map: candidate, knowledge_updates: [] });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.errors[0].code, 'CHANGE_DISPOSITION_INCOMPLETE');
  assert.equal(await fingerprint(root), before);
});

test('REPLACEMENT creates approved new identity and retains historical redirect', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0] = {
    ...candidate.constraints[0],
    lifecycle_state: 'retired',
    successor_ids: ['desktop-data-privacy'],
    retirement_reason_ref: 'decision:privacy-replacement',
  };
  candidate.constraints.push({
    id: 'desktop-data-privacy',
    scope: 'descendants',
    owner_id: 'desktop-experience',
    semantic_revision: 1,
    lifecycle_state: 'current',
    knowledge_refs: {
      en: 'knowledge/desktop-experience-en.md#constraint-desktop-data-privacy',
      'zh-CN': 'knowledge/desktop-experience.md#constraint-desktop-data-privacy',
    },
    exceptions: [],
  });
  candidate.constraints.sort((a, b) => a.id < b.id ? -1 : 1);
  const proposal = proposalFor(candidate, {
    change_class: 'REPLACEMENT',
    kind: 'constraint_identity',
    proposed_patch: { operation: 'REPLACE_CONSTRAINT', target_type: 'constraint', target_id: 'desktop-privacy', changed_fields: ['constraint_meaning', 'lifecycle'], new_ids: ['desktop-data-privacy'], successor_ids: ['desktop-data-privacy'] },
  });
  const smuggled = clone(candidate);
  smuggled.constraints.find(({ id }) => id === 'desktop-privacy').owner_id = 'wiki-workspace';
  const bounded = analyzeImpact({ current_map: map, candidate_map: smuggled, change_class: 'REPLACEMENT', changed_fields: ['constraint_meaning', 'lifecycle'], target_id: 'desktop-privacy', operation: 'REPLACE_CONSTRAINT', child_dispositions: proposal.child_dispositions });
  assert.equal(bounded.ok, false);
  assert.equal(bounded.errors[0].code, 'CHANGE_NOT_BOUNDED');
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-data-privacy', 1);
  proposal.knowledge_candidates = updates;
  await proposeChange({ root, change: proposal });
  const result = await applyApprovedChange({ root, change_id: proposal.change_id, approval_ref: 'approval:privacy-replacement', traceability: { knowledge_diff_ref: 'diff:privacy-replacement', history_ref: 'git:replacement' }, candidate_map: candidate, knowledge_updates: updates });

  assert.equal(result.ok, true);
  const applied = await readJson(join(lifecycle(root), 'project-map.json'));
  assert.deepEqual(applied.constraints.find(({ id }) => id === 'desktop-privacy').successor_ids, ['desktop-data-privacy']);
  assert.equal(applied.constraints.find(({ id }) => id === 'desktop-data-privacy').lifecycle_state, 'current');
});

test('new constraint IDs and retired-ID reuse cannot become current without approval', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints.push({ ...candidate.constraints[0], id: 'new-privacy', knowledge_refs: { en: 'knowledge/desktop-experience-en.md#constraint-new-privacy', 'zh-CN': 'knowledge/desktop-experience.md#constraint-new-privacy' } });
  candidate.constraints.sort((a, b) => a.id < b.id ? -1 : 1);
  const proposal = proposalFor(candidate, {
    change_class: 'REPLACEMENT',
    kind: 'constraint_identity',
    semantic_target_key: 'constraint:new-privacy',
    affected_refs: ['desktop-experience', 'inbox-workspace', 'new-privacy', 'source-workspace', 'wiki-workspace'],
    proposed_patch: { operation: 'ADD_CONSTRAINT', target_type: 'constraint', target_id: 'new-privacy', changed_fields: ['constraint_meaning', 'constraint_owner', 'constraint_scope'], new_ids: ['new-privacy'], successor_ids: [] },
  });
  const proposed = await proposeChange({ root, change: proposal });
  assert.equal(proposed.ok, true);
  const before = await fingerprint(root);
  const result = await applyApprovedChange({ root, change_id: proposal.change_id, traceability: { knowledge_diff_ref: 'diff:new', history_ref: 'git:new' }, candidate_map: candidate, knowledge_updates: [] });
  assert.equal(result.ok, false);
  assert.equal(await fingerprint(root), before);

  const reused = clone(map);
  reused.constraints.push(clone(reused.constraints[0]));
  assert.equal(analyzeImpact({ current_map: map, candidate_map: reused, change_class: 'REPLACEMENT', changed_fields: ['constraint_meaning'], target_id: 'desktop-privacy' }).ok, false);

  const retired = clone(map);
  retired.constraints[0].lifecycle_state = 'retired';
  retired.constraints[0].successor_ids = ['privacy-successor'];
  retired.constraints[0].retirement_reason_ref = 'decision:retired';
  retired.constraints.push({
    ...clone(retired.constraints[0]),
    id: 'privacy-successor',
    lifecycle_state: 'current',
    knowledge_refs: {
      en: 'knowledge/desktop-experience-en.md#constraint-privacy-successor',
      'zh-CN': 'knowledge/desktop-experience.md#constraint-privacy-successor',
    },
  });
  delete retired.constraints[2].successor_ids;
  delete retired.constraints[2].retirement_reason_ref;
  retired.constraints.sort((a, b) => a.id < b.id ? -1 : 1);
  const reuseCandidate = clone(retired);
  const retiredIndex = reuseCandidate.constraints.findIndex(({ id }) => id === 'desktop-privacy');
  reuseCandidate.constraints[retiredIndex].lifecycle_state = 'current';
  delete reuseCandidate.constraints[retiredIndex].successor_ids;
  delete reuseCandidate.constraints[retiredIndex].retirement_reason_ref;
  const reuseResult = analyzeImpact({ current_map: retired, candidate_map: reuseCandidate, change_class: 'REPLACEMENT', changed_fields: ['constraint_meaning'], target_id: 'desktop-privacy', operation: 'ADD_CONSTRAINT' });
  assert.equal(reuseResult.ok, false);
  assert.equal(reuseResult.errors[0].code, 'CONSTRAINT_ID_REUSE');
});

test('rejects stale proposal baseline or candidate map and leaves current root byte-identical', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  await proposeChange({ root, change: proposalFor(candidate) });
  const staleCandidate = clone(candidate);
  staleCandidate.domains[3].purpose.en = 'Different candidate';
  const before = await fingerprint(root);
  const result = await applyApprovedChange({ root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: staleCandidate, knowledge_updates: [] });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_BASELINE_STALE');
  assert.equal(await fingerprint(root), before);
});

test('restores the original root after a controlled late transaction failure', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  candidate.revalidation_required = [{ domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', reason_ref: 'change-desktop-privacy', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 }];
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
  await proposeChange({ root, change: revalidatingProposal(candidate, { knowledge_candidates: updates }) });
  const before = await fingerprint(root);
  const result = await applyApprovedChange({ root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: candidate, knowledge_updates: updates }, { afterPublish: async () => { throw new Error('controlled late failure'); } });
  assert.equal(result.ok, false);
  assert.equal(await fingerprint(root), before);
});

test('restores the original when the candidate publisher moves the stage and then rejects', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  candidate.revalidation_required = [{ domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', reason_ref: 'change-desktop-privacy', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 }];
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
  await proposeChange({ root, change: revalidatingProposal(candidate, { knowledge_candidates: updates }) });
  const before = await fingerprint(root);
  let publishCalls = 0;
  const result = await applyApprovedChange({ root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: candidate, knowledge_updates: updates }, {
    rename: async (from, to) => {
      publishCalls += 1;
      await rename(from, to);
      if (publishCalls === 2) throw new Error('moved then rejected');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(await fingerprint(root), before);
});

test('keeps a verified live candidate authoritative when backup cleanup remains pending', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  candidate.revalidation_required = [{ domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', reason_ref: 'change-desktop-privacy', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 }];
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
  await proposeChange({ root, change: revalidatingProposal(candidate, { knowledge_candidates: updates }) });

  const result = await applyApprovedChange({ root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: candidate, knowledge_updates: updates }, {
    removeBackup: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.cleanup_state, 'pending');
  assert.equal((await readJson(join(lifecycle(root), 'project-map.json'))).constraints[0].semantic_revision, 2);
});

test('rejects unreviewed knowledge rewrites and map-only knowledge updates byte-identically', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  const reviewed = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
  const proposal = proposalFor(candidate, { knowledge_candidates: reviewed });
  proposal.child_dispositions.forEach((item) => { item.unresolved_fact_ids = []; });
  await proposeChange({ root, change: proposal });
  const smuggled = clone(reviewed);
  smuggled[0].en.content = smuggled[0].en.content.replace(
    'Desktop shell owns the workspace frame.',
    'Unreviewed rewrite of a current fact.',
  );
  const before = await fingerprint(root);
  const changed = await applyApprovedChange({ root, change_id: proposal.change_id, approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: candidate, knowledge_updates: smuggled });
  assert.equal(changed.ok, false);
  assert.equal(changed.errors[0].code, 'CHANGE_KNOWLEDGE_COMMITMENT_MISMATCH');
  assert.equal(await fingerprint(root), before);
  const missing = await applyApprovedChange({ root, change_id: proposal.change_id, approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: candidate, knowledge_updates: [] });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].code, 'CHANGE_KNOWLEDGE_COMMITMENT_MISMATCH');
  assert.equal(await fingerprint(root), before);

  const secondRoot = await setup(context);
  const secondMap = await readJson(join(lifecycle(secondRoot), 'project-map.json'));
  const secondCandidate = clone(secondMap);
  secondCandidate.constraints[0].semantic_revision = 2;
  const mapOnly = proposalFor(secondCandidate);
  mapOnly.child_dispositions.forEach((item) => { item.unresolved_fact_ids = []; });
  await proposeChange({ root: secondRoot, change: mapOnly });
  const unexpected = await updateConstraintSections(secondRoot, 'desktop-privacy', 'desktop-privacy', 2);
  const secondBefore = await fingerprint(secondRoot);
  const extra = await applyApprovedChange({ root: secondRoot, change_id: mapOnly.change_id, approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: secondCandidate, knowledge_updates: unexpected });
  assert.equal(extra.ok, false);
  assert.equal(extra.errors[0].code, 'CHANGE_KNOWLEDGE_COMMITMENT_MISMATCH');
  assert.equal(await fingerprint(secondRoot), secondBefore);
});

test('rejects a reviewed fact rewrite without an exact revision increment', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
  updates[0].en.content = updates[0].en.content.replace(
    'Desktop shell owns the workspace frame.',
    'Changed without advancing the fact revision.',
  );
  const before = await fingerprint(root);
  const result = await proposeChange({ root, change: proposalFor(candidate, { knowledge_candidates: updates }) });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_KNOWLEDGE_FACT_REVISION_STALE');
  assert.equal(await fingerprint(root), before);
});

test('rejects a structurally mismatched bilingual proposal before pending write', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
  updates[0].en.content = updates[0].en.content.replace(
    '## Purpose and current boundary',
    '### Purpose and current boundary',
  );
  const before = await fingerprint(root);
  const result = await proposeChange({ root, change: proposalFor(candidate, { knowledge_candidates: updates }) });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'PAIR_SECTION_MISMATCH');
  assert.equal(await fingerprint(root), before);
});

test('applies an approved semantic exception with revision and revalidation impact', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].exceptions.push({ domain_id: 'wiki-workspace', reason_ref: 'decision:wiki-exception', approval_ref: 'approval:wiki-exception' });
  candidate.constraints[0].semantic_revision = 2;
  candidate.revalidation_required = [{ domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', reason_ref: 'change-wiki-exception', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 }];
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
  const proposal = proposalFor(candidate, {
    change_id: 'change-wiki-exception',
    semantic_target_key: 'exception:desktop-privacy',
    affected_refs: ['desktop-experience', 'desktop-privacy', 'wiki-workspace'],
    proposed_patch: { operation: 'ADD_EXCEPTION', target_type: 'exception', target_id: 'desktop-privacy', changed_fields: ['exception'], expected_semantic_revision: 2, new_ids: [], successor_ids: [] },
    child_dispositions: [{ domain_id: 'wiki-workspace', disposition: 'EXCEPTION', exception_ref: 'decision:wiki-exception', evidence_refs: ['decision:wiki-exception'], unresolved_fact_ids: ['wiki-storage-boundary'] }],
    knowledge_candidates: updates,
  });
  assert.equal((await proposeChange({ root, change: proposal })).ok, true);
  const before = await fingerprint(root);
  const denied = await applyApprovedChange({ root, change_id: proposal.change_id, approval_ref: '', traceability: { knowledge_diff_ref: 'diff:exception', history_ref: 'git:exception' }, candidate_map: candidate, knowledge_updates: updates });
  assert.equal(denied.ok, false);
  assert.equal(await fingerprint(root), before);
  const applied = await applyApprovedChange({ root, change_id: proposal.change_id, approval_ref: 'approval:exception-v2', traceability: { knowledge_diff_ref: 'diff:exception', history_ref: 'git:exception' }, candidate_map: candidate, knowledge_updates: updates });
  assert.equal(applied.ok, true);
  assert.equal((await readJson(join(lifecycle(root), 'project-map.json'))).constraints[0].semantic_revision, 2);
});

test('rejects unrelated or extra revalidation markers before pending write', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  candidate.revalidation_required = [
    { domain_id: 'inbox-workspace', fact_id: 'inbox-unrelated-fact', reason_ref: 'change-desktop-privacy', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 },
    { domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', reason_ref: 'change-desktop-privacy', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 },
  ];
  const before = await fingerprint(root);
  const result = await proposeChange({ root, change: revalidatingProposal(candidate) });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CHANGE_REVALIDATION_MISMATCH');
  assert.equal(await fingerprint(root), before);
});

test('reconciles first rename move-then-reject and trusted transition inspection failures', async (context) => {
  const first = await preparedSemanticChange(context);
  const firstBefore = await fingerprint(first.root);
  let calls = 0;
  const moved = await applyApprovedChange({ root: first.root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: first.candidate, knowledge_updates: first.updates }, {
    rename: async (from, to) => {
      calls += 1;
      await rename(from, to);
      if (calls === 1) throw new Error('first move then reject');
    },
  });
  assert.equal(moved.ok, false);
  assert.equal(await fingerprint(first.root), firstBefore);

  const inspected = await preparedSemanticChange(context);
  const inspectedBefore = await fingerprint(inspected.root);
  const transition = await applyApprovedChange({ root: inspected.root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: inspected.candidate, knowledge_updates: inspected.updates }, {
    inspectTransition: async ({ phase }) => {
      if (phase === 'backup-moved') throw new Error('controlled inspection failure');
      return { ok: true };
    },
  });
  assert.equal(transition.ok, false);
  assert.equal(await fingerprint(inspected.root), inspectedBefore);
});

test('preserves bounded recovery artifacts when the original backup is corrupt or restore fails', async (context) => {
  const corrupt = await preparedSemanticChange(context);
  let calls = 0;
  const corrupted = await applyApprovedChange({ root: corrupt.root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: corrupt.candidate, knowledge_updates: corrupt.updates }, {
    rename: async (from, to) => {
      calls += 1;
      await rename(from, to);
      if (calls === 1) await writeFile(join(to, 'INDEX.md'), 'corrupt backup\n');
    },
  });
  assert.equal(corrupted.ok, false);
  assert.equal(corrupted.errors[0].code, 'CHANGE_RESTORE_FAILED');
  const corruptArtifacts = await readdir(join(corrupt.root, 'docs'));
  assert.equal(corruptArtifacts.some((name) => name.startsWith('.project-lifecycle-change-backup-')), true);
  assert.equal(corruptArtifacts.some((name) => name.startsWith('.project-lifecycle-change-stage-')), true);

  const restore = await preparedSemanticChange(context);
  const failedRestore = await applyApprovedChange({ root: restore.root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: restore.candidate, knowledge_updates: restore.updates }, {
    afterPublish: async () => { throw new Error('late failure'); },
    restoreRename: async () => { throw new Error('restore denied'); },
  });
  assert.equal(failedRestore.ok, false);
  assert.equal(failedRestore.errors[0].code, 'CHANGE_RESTORE_FAILED');
  const restoreArtifacts = await readdir(join(restore.root, 'docs'));
  assert.equal(restoreArtifacts.some((name) => name.startsWith('.project-lifecycle-change-backup-')), true);
  assert.equal(restoreArtifacts.some((name) => name.startsWith('.project-lifecycle-change-stage-')), true);
});

test('treats partial backup cleanup as pending and completed cleanup as complete even on rejection', async (context) => {
  const partial = await preparedSemanticChange(context);
  const partialResult = await applyApprovedChange({ root: partial.root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: partial.candidate, knowledge_updates: partial.updates }, {
    removeBackup: async (backupRoot) => {
      await rm(join(backupRoot, 'INDEX.md'));
      throw new Error('partial cleanup');
    },
  });
  assert.equal(partialResult.ok, true);
  assert.equal(partialResult.value.cleanup_state, 'pending');

  const complete = await preparedSemanticChange(context);
  const completeResult = await applyApprovedChange({ root: complete.root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: complete.candidate, knowledge_updates: complete.updates }, {
    removeBackup: async (backupRoot) => {
      await rm(backupRoot, { recursive: true, force: true });
      throw new Error('deleted then rejected');
    },
  });
  assert.equal(completeResult.ok, true);
  assert.equal(completeResult.value.cleanup_state, 'complete');
});

test('rejects label declarations for constraint add/replacement and scope-only ADD_EXCEPTION', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  const added = clone(map);
  added.constraints.push({
    ...clone(map.constraints[1]),
    id: 'desktop-new-rule',
    knowledge_refs: {
      en: 'knowledge/desktop-experience-en.md#constraint-desktop-new-rule',
      'zh-CN': 'knowledge/desktop-experience.md#constraint-desktop-new-rule',
    },
  });
  added.constraints.sort((left, right) => left.id < right.id ? -1 : 1);
  const addResult = analyzeImpact({ current_map: map, candidate_map: added, change_class: 'REPLACEMENT', changed_fields: ['label'], target_id: 'desktop-new-rule', operation: 'ADD_CONSTRAINT' });
  assert.equal(addResult.ok, false);
  assert.equal(addResult.errors[0].code, 'CHANGE_NOT_BOUNDED');

  const replacement = clone(map);
  replacement.constraints[0] = { ...replacement.constraints[0], lifecycle_state: 'retired', successor_ids: ['desktop-new-privacy'], retirement_reason_ref: 'decision:replace' };
  replacement.constraints.push({ ...clone(map.constraints[0]), id: 'desktop-new-privacy', knowledge_refs: { en: 'knowledge/desktop-experience-en.md#constraint-desktop-new-privacy', 'zh-CN': 'knowledge/desktop-experience.md#constraint-desktop-new-privacy' } });
  replacement.constraints.sort((left, right) => left.id < right.id ? -1 : 1);
  const replaceResult = analyzeImpact({ current_map: map, candidate_map: replacement, change_class: 'REPLACEMENT', changed_fields: ['label'], target_id: 'desktop-privacy', operation: 'REPLACE_CONSTRAINT' });
  assert.equal(replaceResult.ok, false);
  assert.equal(replaceResult.errors[0].code, 'CHANGE_NOT_BOUNDED');

  const exception = clone(map);
  exception.constraints[0].scope = 'self';
  exception.constraints[0].semantic_revision = 2;
  const exceptionResult = analyzeImpact({ current_map: map, candidate_map: exception, change_class: 'SEMANTIC', changed_fields: ['constraint_scope'], target_id: 'desktop-privacy', operation: 'ADD_EXCEPTION', child_dispositions: [] });
  assert.equal(exceptionResult.ok, false);
  assert.equal(exceptionResult.errors[0].code, 'CHANGE_NOT_BOUNDED');
});

test('refreshes one semantic target with its persisted change ID and remains applyable', async (context) => {
  const { root, candidate, updates } = await preparedSemanticChange(context);
  const inconsistentCandidate = clone(candidate);
  inconsistentCandidate.revalidation_required[0].reason_ref = 'change-new-caller-id';
  const inconsistent = await proposeChange({ root, change: revalidatingProposal(inconsistentCandidate, {
    change_id: 'change-new-caller-id',
    created_at: '2026-08-09T12:00:00Z',
    knowledge_candidates: updates,
  }) });
  assert.equal(inconsistent.ok, false);
  assert.equal(inconsistent.errors[0].code, 'CHANGE_REVALIDATION_MISMATCH');
  const refreshed = revalidatingProposal(candidate, {
    change_id: 'change-new-caller-id',
    created_at: '2026-08-09T12:00:00Z',
    proposed_disposition: 'Refreshed review summary.',
    knowledge_candidates: updates,
  });
  const refreshResult = await proposeChange({ root, change: refreshed });
  assert.equal(refreshResult.ok, true);
  const pending = await readJson(join(lifecycle(root), 'pending-changes.json'));
  assert.equal(pending.changes.length, 1);
  assert.equal(pending.changes[0].change_id, 'change-desktop-privacy');
  assert.equal(pending.changes[0].created_at, '2026-08-08T11:00:00Z');
  const applied = await applyApprovedChange({ root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: candidate, knowledge_updates: updates });
  assert.equal(applied.ok, true);
});
