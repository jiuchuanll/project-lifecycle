import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
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
    { domain_id: 'wiki-workspace', disposition: 'REVALIDATE', evidence_refs: ['repo:privacy-policy'], unresolved_fact_ids: ['wiki-storage-boundary'] },
  ],
  candidate_map: candidate,
  ...overrides,
});

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

test('WORDING preserves semantic revision and rejects machine-routing changes', async () => {
  const map = await readJson(new URL('../fixtures/knowledge/topology/base/docs/project-lifecycle/project-map.json', import.meta.url));
  assert.equal(analyzeImpact({ current_map: map, candidate_map: map, change_class: 'WORDING', changed_fields: ['label'], target_id: 'desktop-privacy' }).ok, true);
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

test('approved SEMANTIC application atomically updates map, pair, indexes, traceability, and revalidation markers', async (context) => {
  const root = await setup(context);
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  const candidate = clone(map);
  candidate.constraints[0].semantic_revision = 2;
  candidate.revalidation_required = [{ domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 }];
  await proposeChange({ root, change: proposalFor(candidate) });
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);

  const result = await applyApprovedChange({
    root,
    change_id: 'change-desktop-privacy',
    approval_ref: 'approval:desktop-privacy-v2',
    traceability: { knowledge_diff_ref: 'knowledge-diff:desktop-privacy-v2', history_ref: 'git:candidate-commit' },
    candidate_map: candidate,
    knowledge_updates: updates,
  });

  assert.equal(result.ok, true);
  assert.equal((await readJson(join(lifecycle(root), 'project-map.json'))).constraints[0].semantic_revision, 2);
  assert.deepEqual((await readJson(join(lifecycle(root), 'pending-changes.json'))).changes, []);
  assert.match(await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8'), /id=desktop-privacy revision=2/);
  assert.match(await readFile(join(lifecycle(root), 'INDEX-en.md'), 'utf8'), /desktop-experience/);
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
    proposed_patch: { operation: 'REPLACE_CONSTRAINT', target_type: 'constraint', target_id: 'desktop-privacy', changed_fields: ['constraint_meaning'], new_ids: ['desktop-data-privacy'], successor_ids: ['desktop-data-privacy'] },
  });
  await proposeChange({ root, change: proposal });
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-data-privacy', 1);
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
    proposed_patch: { operation: 'ADD_CONSTRAINT', target_type: 'constraint', target_id: 'new-privacy', changed_fields: ['constraint_meaning'], new_ids: ['new-privacy'], successor_ids: [] },
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
  candidate.revalidation_required = [{ domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 }];
  await proposeChange({ root, change: proposalFor(candidate) });
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
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
  candidate.revalidation_required = [{ domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 }];
  await proposeChange({ root, change: proposalFor(candidate) });
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);
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
  candidate.revalidation_required = [{ domain_id: 'wiki-workspace', fact_id: 'wiki-storage-boundary', constraint_id: 'desktop-privacy', from_revision: 1, to_revision: 2 }];
  await proposeChange({ root, change: proposalFor(candidate) });
  const updates = await updateConstraintSections(root, 'desktop-privacy', 'desktop-privacy', 2);

  const result = await applyApprovedChange({ root, change_id: 'change-desktop-privacy', approval_ref: 'approval:v2', traceability: { knowledge_diff_ref: 'diff:v2', history_ref: 'git:v2' }, candidate_map: candidate, knowledge_updates: updates }, {
    removeBackup: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.cleanup_state, 'pending');
  assert.equal((await readJson(join(lifecycle(root), 'project-map.json'))).constraints[0].semantic_revision, 2);
});
