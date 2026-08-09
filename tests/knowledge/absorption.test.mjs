import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyKnowledgeDiff,
  computeKnowledgeDiffCommitment,
} from '../../scripts/knowledge/apply-knowledge-diff.mjs';
import { parseFactBlocks } from '../../scripts/lib/fact-blocks.mjs';

const fixtureRoot = new URL('../fixtures/knowledge/topology/base/', import.meta.url);
const addFixture = new URL('../fixtures/knowledge/absorption/accepted-add.json', import.meta.url);
const lifecycle = (root) => join(root, 'docs/project-lifecycle');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (source) => `sha256:${createHash('sha256').update(source).digest('hex')}`;
const replaceLast = (source, target, replacement) => {
  const index = source.lastIndexOf(target);
  return index === -1 ? source : `${source.slice(0, index)}${replacement}${source.slice(index + target.length)}`;
};

const setup = async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-absorption-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
};

const snapshot = async (root) => {
  const entries = [];
  const visit = async (directory, prefix = '') => {
    for (const child of (await readdir(directory, { withFileTypes: true }))
      .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const locator = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) await visit(join(directory, child.name), locator);
      else entries.push([locator, (await readFile(join(directory, child.name))).toString('base64')]);
    }
  };
  await visit(root);
  return entries;
};

const replaceBaseline = (source, next) => source
  .replace('last_verified_baseline: baseline-1', `last_verified_baseline: ${next}`)
  .replaceAll('last_verified_baseline: "baseline-1"', `last_verified_baseline: "${next}"`);

const addBlock = (source, language, baseline = 'baseline-2') => {
  const block = language === 'en'
    ? `### \`desktop-theme-fact\`\n\n<!-- project-lifecycle:fact\nfact_id: desktop-theme-fact\nrevision: 1\nevidence_refs: ["repo:src/desktop", "test:desktop"]\nlast_verified_baseline: "${baseline}"\n-->\n\nDesktop theme follows the accepted shell palette.\n\n#### Known limits\n\nTheme variants remain out of scope.\n\n<!-- /project-lifecycle:fact -->\n\n`
    : `### \`desktop-theme-fact\`\n\n<!-- project-lifecycle:fact\nfact_id: desktop-theme-fact\nrevision: 1\nevidence_refs: ["repo:src/desktop", "test:desktop"]\nlast_verified_baseline: "${baseline}"\n-->\n\n桌面主题遵循已验收的外壳配色。\n\n#### 已知限制\n\n主题变体不在本次范围内。\n\n<!-- /project-lifecycle:fact -->\n\n`;
  const heading = language === 'en' ? '## System and data relationships' : '## 系统与数据关系';
  return replaceBaseline(source, baseline).replace(heading, `${block}${heading}`);
};

const rewriteBlock = (source, language, baseline = 'baseline-2') => replaceBaseline(source, baseline)
  .replace('revision: 1', 'revision: 2')
  .replace(
    language === 'en' ? 'Desktop shell owns the workspace frame.' : '桌面壳负责工作区框架。',
    language === 'en' ? 'Desktop shell owns the accepted workspace frame and rail.' : '桌面壳负责已验收的工作区框架和侧栏。',
  );

const supersedeBlock = (source, language, baseline = 'baseline-2') => replaceBaseline(source, baseline)
  .replaceAll('desktop-shell-fact', 'desktop-frame-contract')
  .replace(
    language === 'en' ? 'Desktop shell owns the workspace frame.' : '桌面壳负责工作区框架。',
    language === 'en' ? 'Desktop frame contract owns the shell and workspace rail.' : '桌面框架契约负责外壳和工作区侧栏。',
  );

const updateFor = async (root, transform) => {
  const update = { domain_id: 'desktop-experience' };
  for (const [language, name] of [['en', 'desktop-experience-en.md'], ['zh-CN', 'desktop-experience.md']]) {
    const locator = `knowledge/${name}`;
    update[language] = {
      locator,
      content: transform(await readFile(join(lifecycle(root), locator), 'utf8'), language),
    };
    update[language].content_hash = hash(update[language].content);
  }
  update.facts = parseFactBlocks(update.en.content).value.map((fact) => ({
    fact_id: fact.fact_id,
    fact_revision: fact.revision,
    knowledge_state: 'current',
  }));
  return [update];
};

const refreshCommitment = (update) => {
  for (const language of ['en', 'zh-CN']) update[language].content_hash = hash(update[language].content);
  update.facts = parseFactBlocks(update.en.content).value.map((fact) => ({
    fact_id: fact.fact_id,
    fact_revision: fact.revision,
    knowledge_state: 'current',
  }));
};

const diffFor = async (kind, overrides = {}) => {
  const diff = clone(await readJson(addFixture));
  diff.diff_id = `diff-${kind.toLowerCase()}-desktop`;
  diff.operations[0] = {
    kind,
    fact_id: kind === 'ADD' ? 'desktop-theme-fact' : 'desktop-shell-fact',
    owner_domain_id: 'desktop-experience',
    evidence_refs: ['repo:src/desktop', 'test:desktop'],
    ...(kind === 'SUPERSEDE' ? { successor_fact_id: 'desktop-frame-contract' } : {}),
  };
  return Object.assign(diff, overrides);
};

const approvalReceipt = (envelope) => ({
  ref: 'approval:accepted-delivery',
  verified: true,
  candidate_commitment: computeKnowledgeDiffCommitment(envelope),
});

const accepted = async (root, kind, transform, overrides = {}) => {
  const envelope = {
    root,
    knowledge_diff: await diffFor(kind),
    new_baseline: 'baseline-2',
    knowledge_updates: await updateFor(root, transform),
    ...overrides,
  };
  envelope.approval_receipt = approvalReceipt(envelope);
  return envelope;
};

const resolvePending = async (envelope, pendingResult) => {
  const conflict = pendingResult.value.conflicts[0];
  envelope.resolution_receipts = [{
    ref: 'decision:accepted-knowledge-diff',
    verified: true,
    candidate_commitment: conflict.candidate_commitment,
    conflict_id: conflict.conflict_id,
    conflict_revision: conflict.conflict_revision,
  }];
  return envelope;
};

test('applies a disjoint accepted ADD and atomically advances pair, owner, map, and generated indexes', async (context) => {
  const root = await setup(context);
  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.applied_facts, [{ fact_id: 'desktop-theme-fact', owner_domain_id: 'desktop-experience', revision: 1 }]);
  assert.equal(result.value.knowledge_baseline, 'baseline-2');
  const map = await readJson(join(lifecycle(root), 'project-map.json'));
  assert.equal(map.knowledge_baseline, 'baseline-2');
  assert.equal(map.domains[0].baseline, 'baseline-2');
  const english = await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8');
  assert.deepEqual(parseFactBlocks(english).value.map(({ fact_id: id, revision }) => [id, revision]), [
    ['desktop-shell-fact', 1],
    ['desktop-theme-fact', 1],
  ]);
  assert.match(await readFile(join(lifecycle(root), 'INDEX-en.md'), 'utf8'), /baseline-2/);
});

test('accepted knowledge absorption preserves unrelated relative symlinks during root publication', async (context) => {
  const root = await setup(context);
  await writeFile(join(lifecycle(root), 'unrelated-target.md'), 'unrelated\n');
  await symlink('unrelated-target.md', join(lifecycle(root), 'unrelated-link.md'));

  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await readlink(join(lifecycle(root), 'unrelated-link.md')), 'unrelated-target.md');
});

test('applies accepted same-subject REWRITE with the same fact ID and exactly one revision increment', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'REWRITE', rewriteBlock);
  const pending = await applyKnowledgeDiff(envelope);
  assert.equal(pending.value.status, 'pending-review');
  const result = await applyKnowledgeDiff(await resolvePending(envelope, pending));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.applied_facts, [{ fact_id: 'desktop-shell-fact', owner_domain_id: 'desktop-experience', revision: 2 }]);
  const facts = parseFactBlocks(await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8'));
  assert.equal(facts.value[0].fact_id, 'desktop-shell-fact');
  assert.equal(facts.value[0].revision, 2);
  assert.match(facts.value[0].statement, /workspace frame and rail/);
});

test('applies approved SUPERSEDE with a fresh successor identity and removes predecessor from default retrieval', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'SUPERSEDE', supersedeBlock);
  const pending = await applyKnowledgeDiff(envelope);
  const result = await applyKnowledgeDiff(await resolvePending(envelope, pending));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.superseded_facts, [{ fact_id: 'desktop-shell-fact', successor_fact_id: 'desktop-frame-contract' }]);
  const source = await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8');
  assert.doesNotMatch(source, /fact_id: desktop-shell-fact/);
  assert.match(source, /fact_id: desktop-frame-contract/);
});

test('NO_CHANGE validates current baseline but performs a byte-identical no-op', async (context) => {
  const root = await setup(context);
  const before = await snapshot(lifecycle(root));
  const diff = await diffFor('ADD', { outcome: 'NO_CHANGE', operations: [], domain_changes: [] });
  const result = await applyKnowledgeDiff({ root, knowledge_diff: diff, knowledge_updates: [] });
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'no-change');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('rejects credential-bearing and comment-breaking Knowledge Diff references without echoing them', async (context) => {
  const root = await setup(context);
  for (const unsafe of ['repo:https://user:secret@example.test/private', 'repo:unsafe-->comment']) {
    const diff = await diffFor('ADD', { outcome: 'NO_CHANGE', operations: [], domain_changes: [] });
    diff.evidence_refs = [unsafe];
    const before = await snapshot(lifecycle(root));
    const result = await applyKnowledgeDiff({ root, knowledge_diff: diff, knowledge_updates: [] });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'ABSORPTION_REFERENCE_INVALID');
    assert.doesNotMatch(JSON.stringify(result), /secret|unsafe-->/);
    assert.deepEqual(await snapshot(lifecycle(root)), before);
  }
});

test('rejects bare or forged approval references without changing current knowledge', async (context) => {
  const root = await setup(context);
  const before = await snapshot(lifecycle(root));
  const bare = await accepted(root, 'ADD', addBlock);
  delete bare.approval_receipt;
  bare.approval_ref = 'approval:legacy-bare-reference';
  let result = await applyKnowledgeDiff(bare);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_ENVELOPE_INVALID');

  const forged = await accepted(root, 'ADD', addBlock);
  forged.approval_receipt.candidate_commitment = `sha256:${'0'.repeat(64)}`;
  result = await applyKnowledgeDiff(forged);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_APPROVAL_INVALID');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('missing ADD approval fails without creating a pending conflict', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'ADD', addBlock);
  delete envelope.approval_receipt;
  const before = await snapshot(lifecycle(root));
  const result = await applyKnowledgeDiff(envelope);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_APPROVAL_INVALID');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
  assert.deepEqual((await readJson(join(lifecycle(root), 'pending-changes.json'))).changes, []);
});

test('computes one canonical commitment independent of JSON object key insertion order', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'ADD', addBlock);
  const reordered = clone(envelope);
  reordered.knowledge_diff = Object.fromEntries(Object.entries(reordered.knowledge_diff).reverse());
  reordered.knowledge_diff.operations = reordered.knowledge_diff.operations.map((operation) => (
    Object.fromEntries(Object.entries(operation).reverse())
  ));
  reordered.knowledge_updates = reordered.knowledge_updates.map((update) => (
    Object.fromEntries(Object.entries(update).reverse())
  ));
  assert.equal(
    computeKnowledgeDiffCommitment(envelope),
    computeKnowledgeDiffCommitment(reordered),
  );
});

test('an unresolved same-fact change writes only one deduplicated bounded pending conflict', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'REWRITE', rewriteBlock);
  delete envelope.approval_receipt;
  const beforePair = await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8');
  const first = await applyKnowledgeDiff(envelope, { now: () => '2026-08-09T00:00:00.000Z' });
  const second = await applyKnowledgeDiff(envelope, { now: () => '2026-08-10T00:00:00.000Z' });
  assert.equal(first.ok, true);
  assert.equal(first.value.status, 'pending-review');
  assert.equal(second.ok, true);
  const pending = await readJson(join(lifecycle(root), 'pending-changes.json'));
  assert.equal(pending.changes.length, 1);
  assert.equal(pending.changes[0].opened_at, '2026-08-09T00:00:00.000Z');
  assert.equal(pending.changes[0].conflict_revision, 1);
  assert.doesNotMatch(JSON.stringify(pending), /workspace frame and rail/);
  assert.equal(await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8'), beforePair);
  assert.equal((await readJson(join(lifecycle(root), 'project-map.json'))).knowledge_baseline, 'baseline-1');
});

test('an approved pending conflict applies only when its link matches the diff identity', async (context) => {
  const root = await setup(context);
  const unresolved = await accepted(root, 'REWRITE', rewriteBlock);
  delete unresolved.approval_receipt;
  const pendingResult = await applyKnowledgeDiff(unresolved, { now: () => '2026-08-09T00:00:00.000Z' });
  const conflict = pendingResult.value.conflicts[0];

  const wrong = await applyKnowledgeDiff(await accepted(root, 'REWRITE', rewriteBlock, {
    resolution_receipts: [{
      ref: 'decision:wrong', verified: true, candidate_commitment: conflict.candidate_commitment,
      conflict_id: 'absorption-fact-other', conflict_revision: conflict.conflict_revision,
    }],
  }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.errors[0].code, 'ABSORPTION_CONFLICT_MISMATCH');

  const envelope = await accepted(root, 'REWRITE', rewriteBlock);
  const applied = await applyKnowledgeDiff(await resolvePending(envelope, pendingResult));
  assert.equal(applied.ok, true);
  assert.deepEqual((await readJson(join(lifecycle(root), 'pending-changes.json'))).changes, []);
});

test('does not overwrite an unrelated pending record that collides with the derived conflict ID', async (context) => {
  const root = await setup(context);
  const pendingPath = join(lifecycle(root), 'pending-changes.json');
  const pending = await readJson(pendingPath);
  pending.changes.push({
    change_id: 'absorption-fact-desktop-shell-fact',
    kind: 'ownership',
    trigger_refs: ['feedback:unrelated'],
    affected_refs: ['domain:wiki-workspace'],
    proposed_disposition: 'Review unrelated ownership.',
    risks: [],
    evidence_gaps: [],
    review_state: 'open',
    created_at: '2026-08-09T00:00:00.000Z',
  });
  await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`);
  const envelope = await accepted(root, 'REWRITE', rewriteBlock);
  delete envelope.approval_receipt;
  const before = await snapshot(lifecycle(root));
  const result = await applyKnowledgeDiff(envelope);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_CONFLICT_MISMATCH');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('requires an exact conflict resolution receipt when an accepted diff already has a pending review record', async (context) => {
  const root = await setup(context);
  const unresolved = await accepted(root, 'REWRITE', rewriteBlock);
  delete unresolved.approval_receipt;
  await applyKnowledgeDiff(unresolved, { now: () => '2026-08-09T00:00:00.000Z' });
  const result = await applyKnowledgeDiff(await accepted(root, 'REWRITE', rewriteBlock));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'pending-review');
});

test('refreshes one semantic conflict revision for a different diff and rejects the stale receipt', async (context) => {
  const root = await setup(context);
  const firstEnvelope = await accepted(root, 'REWRITE', rewriteBlock);
  const first = await applyKnowledgeDiff(firstEnvelope, { now: () => '2026-08-09T00:00:00.000Z' });
  const firstConflict = first.value.conflicts[0];

  const secondEnvelope = await accepted(root, 'REWRITE', rewriteBlock);
  secondEnvelope.knowledge_diff.diff_id = 'diff-rewrite-desktop-v2';
  secondEnvelope.approval_receipt = approvalReceipt(secondEnvelope);
  const second = await applyKnowledgeDiff(secondEnvelope, { now: () => '2026-08-10T00:00:00.000Z' });
  const secondConflict = second.value.conflicts[0];
  assert.equal(secondConflict.conflict_id, firstConflict.conflict_id);
  assert.equal(secondConflict.conflict_revision, firstConflict.conflict_revision + 1);
  assert.notEqual(secondConflict.candidate_commitment, firstConflict.candidate_commitment);

  secondEnvelope.resolution_receipts = [{
    ref: 'decision:stale',
    verified: true,
    candidate_commitment: firstConflict.candidate_commitment,
    conflict_id: firstConflict.conflict_id,
    conflict_revision: firstConflict.conflict_revision,
  }];
  const before = await snapshot(lifecycle(root));
  const stale = await applyKnowledgeDiff(secondEnvelope);
  assert.equal(stale.ok, false);
  assert.equal(stale.errors[0].code, 'ABSORPTION_CONFLICT_MISMATCH');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('blocks a disjoint ADD when an open pending record overlaps its owner domain', async (context) => {
  const root = await setup(context);
  const pendingPath = join(lifecycle(root), 'pending-changes.json');
  const pending = await readJson(pendingPath);
  pending.changes.push({
    change_id: 'review-desktop-ownership',
    kind: 'ownership',
    trigger_refs: ['feedback:desktop-owner'],
    affected_refs: ['domain:desktop-experience'],
    proposed_disposition: 'Review owner.',
    risks: [],
    evidence_gaps: [],
    review_state: 'open',
    created_at: '2026-08-09T00:00:00.000Z',
  });
  await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`);
  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'pending-review');
  assert.equal((await readJson(join(lifecycle(root), 'project-map.json'))).knowledge_baseline, 'baseline-1');
});

for (const [label, pendingChange] of [
  ['legacy raw affected IDs', {
    change_id: 'review-desktop-ownership-raw',
    kind: 'ownership',
    trigger_refs: ['feedback:desktop-owner'],
    affected_refs: ['desktop-experience'],
    proposed_disposition: 'Review owner.',
    risks: [],
    evidence_gaps: [],
    review_state: 'open',
    created_at: '2026-08-09T00:00:00.000Z',
  }],
  ['governed raw IDs and child facts', {
    change_id: 'review-desktop-privacy-raw',
    kind: 'constraint_semantics',
    trigger_refs: ['feedback:desktop-privacy'],
    affected_refs: ['desktop-experience', 'desktop-privacy'],
    proposed_disposition: 'Review privacy propagation.',
    risks: [],
    evidence_gaps: [],
    review_state: 'open',
    created_at: '2026-08-09T00:00:00.000Z',
    proposal_version: 1,
    semantic_target_key: 'constraint:desktop-privacy',
    source_refs: ['repo:privacy-policy'],
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
    child_dispositions: [{
      domain_id: 'desktop-experience',
      disposition: 'REVALIDATE',
      evidence_refs: ['repo:privacy-policy'],
      unresolved_fact_ids: ['desktop-theme-fact'],
    }],
    knowledge_commitments: [],
  }],
]) {
  test(`blocks ADD overlap from ${label}`, async (context) => {
    const root = await setup(context);
    const pendingPath = join(lifecycle(root), 'pending-changes.json');
    const pending = await readJson(pendingPath);
    pending.changes.push(pendingChange);
    await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`);

    const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock));

    assert.equal(result.ok, true);
    assert.equal(result.value.status, 'pending-review');
    assert.equal((await readJson(join(lifecycle(root), 'project-map.json'))).knowledge_baseline, 'baseline-1');
  });
}

test('blocks current mutation while the project map requires overlapping fact revalidation', async (context) => {
  const root = await setup(context);
  const mapPath = join(lifecycle(root), 'project-map.json');
  const map = await readJson(mapPath);
  map.revalidation_required = [{
    domain_id: 'desktop-experience',
    fact_id: 'desktop-theme-fact',
    reason_ref: 'change:desktop-validation',
  }];
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock));
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'pending-review');
  assert.equal((await readJson(mapPath)).knowledge_baseline, 'baseline-1');
});

const negativeCases = [
  ['stale knowledge baseline', async (envelope) => { envelope.knowledge_diff.knowledge_baseline = 'baseline-stale'; }, 'ABSORPTION_BASELINE_STALE'],
  ['wrong canonical owner', async (envelope) => { envelope.knowledge_diff.operations[0].owner_domain_id = 'wiki-workspace'; }, 'ABSORPTION_OWNER_MISMATCH'],
  ['missing operation evidence', async (envelope) => { envelope.knowledge_diff.operations[0].evidence_refs = []; }, 'ABSORPTION_EVIDENCE_REQUIRED'],
  ['partial bilingual update', async (envelope) => { delete envelope.knowledge_updates[0]['zh-CN']; }, 'ABSORPTION_PAIR_REQUIRED'],
  ['rewrite that skips a revision', async (envelope) => { envelope.knowledge_updates[0].en.content = envelope.knowledge_updates[0].en.content.replace('revision: 2', 'revision: 3'); envelope.knowledge_updates[0]['zh-CN'].content = envelope.knowledge_updates[0]['zh-CN'].content.replace('revision: 2', 'revision: 3'); refreshCommitment(envelope.knowledge_updates[0]); }, 'ABSORPTION_REVISION_INVALID'],
];

for (const [name, mutate, code] of negativeCases) {
  test(`rejects ${name} without mutating accepted knowledge`, async (context) => {
    const root = await setup(context);
    const envelope = await accepted(root, 'REWRITE', rewriteBlock);
    await mutate(envelope);
    const before = await snapshot(lifecycle(root));
    const result = await applyKnowledgeDiff(envelope);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, code);
    assert.deepEqual(await snapshot(lifecycle(root)), before);
  });
}

test('rejects duplicate fact identity across canonical domains without mutation', async (context) => {
  const root = await setup(context);
  const mapPath = join(lifecycle(root), 'project-map.json');
  const map = await readJson(mapPath);
  const duplicate = map.domains.find(({ id }) => id === 'wiki-workspace');
  duplicate.domain_state = 'materialized';
  duplicate.paired_assets = { en: 'knowledge/wiki-workspace-en.md', 'zh-CN': 'knowledge/wiki-workspace.md' };
  duplicate.baseline = 'baseline-1';
  for (const [language, name] of [['en', 'desktop-experience-en.md'], ['zh-CN', 'desktop-experience.md']]) {
    const source = await readFile(join(lifecycle(root), 'knowledge', name), 'utf8');
    const localized = source
      .replaceAll('desktop-experience', 'wiki-workspace')
      .replaceAll(language === 'en' ? 'Desktop experience' : '桌面体验', language === 'en' ? 'Wiki workspace' : 'Wiki 工作区');
    await writeFile(join(lifecycle(root), 'knowledge', language === 'en' ? 'wiki-workspace-en.md' : 'wiki-workspace.md'), localized);
  }
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  const before = await snapshot(lifecycle(root));
  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_FACT_DUPLICATE');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('domain, topology, ownership, and constraint changes stop at one bounded pending record', async (context) => {
  const root = await setup(context);
  const diff = await diffFor('ADD');
  diff.operations = [];
  diff.domain_changes = [{ domain_id: 'desktop-experience', change: 'Change parent topology.', relationship_refs: ['domain:wiki-workspace'], evidence_refs: ['repo:src/desktop'] }];
  diff.evidence_refs = ['repo:src/desktop'];
  const result = await applyKnowledgeDiff({ root, knowledge_diff: diff, new_baseline: 'baseline-2', knowledge_updates: [] }, { now: () => '2026-08-09T00:00:00.000Z' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.status, 'pending-review');
  const pending = await readJson(join(lifecycle(root), 'pending-changes.json'));
  assert.equal(pending.changes[0].semantic_target_key, 'topology:desktop-experience');
  assert.deepEqual(pending.changes[0].relationship_refs, ['domain:wiki-workspace']);
  assert.doesNotMatch(JSON.stringify(pending), /Change parent topology/);
});

test('rejects unrelated fact edits hidden in a targeted rewrite', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'REWRITE', rewriteBlock);
  for (const language of ['en', 'zh-CN']) {
    envelope.knowledge_updates[0][language].content = addBlock(
      envelope.knowledge_updates[0][language].content,
      language,
    );
  }
  refreshCommitment(envelope.knowledge_updates[0]);
  const before = await snapshot(lifecycle(root));
  const result = await applyKnowledgeDiff(envelope);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_CHANGE_NOT_BOUNDED');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('rejects existing fact heading changes and unrelated section edits during ADD', async (context) => {
  for (const mutate of [
    (source) => source.replace('### `desktop-shell-fact`', '### `renamed-shell-heading`'),
    (source, language) => source.replace(
      language === 'en' ? '## System and data relationships' : '## 系统与数据关系',
      language === 'en' ? '## Altered unrelated heading' : '## 被修改的无关标题',
    ),
  ]) {
    const root = await setup(context);
    const envelope = await accepted(root, 'ADD', addBlock);
    for (const language of ['en', 'zh-CN']) {
      envelope.knowledge_updates[0][language].content = mutate(envelope.knowledge_updates[0][language].content, language);
    }
    refreshCommitment(envelope.knowledge_updates[0]);
    envelope.approval_receipt = approvalReceipt(envelope);
    const before = await snapshot(lifecycle(root));
    const result = await applyKnowledgeDiff(envelope);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'ABSORPTION_CHANGE_NOT_BOUNDED');
    assert.deepEqual(await snapshot(lifecycle(root)), before);
  }
});

test('rejects operation label mismatch and metadata-only REWRITE', async (context) => {
  const root = await setup(context);
  const mismatch = await accepted(root, 'REWRITE', rewriteBlock);
  for (const language of ['en', 'zh-CN']) {
    mismatch.knowledge_updates[0][language].content = mismatch.knowledge_updates[0][language].content
      .replace('### `desktop-shell-fact`', '### `other-fact-label`');
  }
  refreshCommitment(mismatch.knowledge_updates[0]);
  let result = await applyKnowledgeDiff(mismatch);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_CHANGE_NOT_BOUNDED');

  const metadataOnly = await accepted(root, 'REWRITE', (source) => replaceBaseline(source, 'baseline-2')
    .replace('revision: 1', 'revision: 2'));
  result = await applyKnowledgeDiff(metadataOnly);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_CHANGE_NOT_BOUNDED');
});

test('requires substantive payload change in both localized REWRITE candidates', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'REWRITE', rewriteBlock);
  envelope.knowledge_updates[0]['zh-CN'].content = replaceBaseline(
    await readFile(join(lifecycle(root), 'knowledge/desktop-experience.md'), 'utf8'),
    'baseline-2',
  ).replace('revision: 1', 'revision: 2');
  refreshCommitment(envelope.knowledge_updates[0]);
  const result = await applyKnowledgeDiff(envelope);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_CHANGE_NOT_BOUNDED');
});

test('requires exact operation evidence and exact global evidence union', async (context) => {
  const root = await setup(context);
  const extraGlobal = await accepted(root, 'ADD', addBlock);
  extraGlobal.knowledge_diff.evidence_refs.push('test:unattributed');
  extraGlobal.approval_receipt = approvalReceipt(extraGlobal);
  let result = await applyKnowledgeDiff(extraGlobal);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_EVIDENCE_REQUIRED');

  const extraFact = await accepted(root, 'ADD', addBlock);
  for (const language of ['en', 'zh-CN']) {
    extraFact.knowledge_updates[0][language].content = replaceLast(
      extraFact.knowledge_updates[0][language].content,
      'evidence_refs: ["repo:src/desktop", "test:desktop"]',
      'evidence_refs: ["repo:src/desktop", "test:desktop", "test:unattributed"]',
    );
  }
  refreshCommitment(extraFact.knowledge_updates[0]);
  extraFact.approval_receipt = approvalReceipt(extraFact);
  result = await applyKnowledgeDiff(extraFact);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_EVIDENCE_REQUIRED');
});

test('rejects two operations that claim the same successor identity', async (context) => {
  const root = await setup(context);
  const transform = (source, language) => supersedeBlock(source, language)
    .replaceAll('desktop-frame-contract', 'desktop-theme-fact');
  const envelope = await accepted(root, 'SUPERSEDE', transform);
  envelope.knowledge_diff.operations[0].successor_fact_id = 'desktop-theme-fact';
  envelope.knowledge_diff.operations.push({
    kind: 'ADD',
    fact_id: 'desktop-theme-fact',
    owner_domain_id: 'desktop-experience',
    evidence_refs: ['repo:src/desktop', 'test:desktop'],
  });
  const result = await applyKnowledgeDiff(envelope);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_CHANGE_NOT_BOUNDED');
});

test('rejects a candidate whose content hash or fact summary differs from the approved commitment', async (context) => {
  const root = await setup(context);
  const hashMismatch = await accepted(root, 'ADD', addBlock);
  hashMismatch.knowledge_updates[0].en.content_hash = `sha256:${'0'.repeat(64)}`;
  let result = await applyKnowledgeDiff(hashMismatch);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_COMMITMENT_MISMATCH');

  const summaryMismatch = await accepted(root, 'ADD', addBlock);
  summaryMismatch.knowledge_updates[0].facts[1].fact_revision = 2;
  result = await applyKnowledgeDiff(summaryMismatch);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_COMMITMENT_MISMATCH');
});

test('binds accepted implementation entry-point additions to the Knowledge Diff', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'ADD', addBlock);
  envelope.knowledge_diff.entry_points = ['repo:src/desktop', 'repo:src/theme'];
  for (const language of ['en', 'zh-CN']) {
    envelope.knowledge_updates[0][language].content = envelope.knowledge_updates[0][language].content
      .replace('implementation_refs: ["repo:src/desktop"]', 'implementation_refs: ["repo:src/desktop", "repo:src/theme"]');
  }
  refreshCommitment(envelope.knowledge_updates[0]);
  envelope.approval_receipt = approvalReceipt(envelope);
  const result = await applyKnowledgeDiff(envelope);
  assert.equal(result.ok, true);
  assert.match(await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8'), /repo:src\/theme/);
});

test('rejects an implementation entry point absent from the accepted Knowledge Diff', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'ADD', addBlock);
  for (const language of ['en', 'zh-CN']) {
    envelope.knowledge_updates[0][language].content = envelope.knowledge_updates[0][language].content
      .replace('implementation_refs: ["repo:src/desktop"]', 'implementation_refs: ["repo:src/desktop", "repo:src/unreviewed"]');
  }
  refreshCommitment(envelope.knowledge_updates[0]);
  const result = await applyKnowledgeDiff(envelope);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_CHANGE_NOT_BOUNDED');
});

test('rolls back the root byte-for-byte after a late publication failure', async (context) => {
  const root = await setup(context);
  const before = await snapshot(lifecycle(root));
  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock), {
    afterPublish: async () => { throw new Error('controlled late failure'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_WRITE_FAILED');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('rolls back a pending-only conflict update after a late publication failure', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'REWRITE', rewriteBlock);
  delete envelope.approval_receipt;
  const before = await snapshot(lifecycle(root));
  const result = await applyKnowledgeDiff(envelope, {
    afterPublish: async () => { throw new Error('controlled pending failure'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_WRITE_FAILED');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('recovers when rename moves the candidate and then rejects', async (context) => {
  const root = await setup(context);
  const before = await snapshot(lifecycle(root));
  let calls = 0;
  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock), {
    rename: async (from, to) => {
      calls += 1;
      await rename(from, to);
      if (calls === 2) throw new Error('moved then rejected');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_WRITE_FAILED');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('restores the original after a rejected partial publication transition', async (context) => {
  const root = await setup(context);
  const before = await snapshot(lifecycle(root));
  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock), {
    inspectTransition: async ({ phase }) => ({ ok: phase !== 'candidate-moved' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_WRITE_FAILED');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('fails closed and preserves recovery artifacts when the original backup is corrupted', async (context) => {
  const root = await setup(context);
  let calls = 0;
  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock), {
    rename: async (from, to) => {
      calls += 1;
      await rename(from, to);
      if (calls === 1) await writeFile(join(to, 'project-map.json'), '{}\n');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_RESTORE_FAILED');
  assert.match(result.errors[0].message, /backup/);
});

test('reports cleanup pending only after the candidate is verified live', async (context) => {
  const root = await setup(context);
  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock), {
    removeBackup: async () => { throw new Error('controlled cleanup failure'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'applied');
  assert.equal(result.value.cleanup_state, 'pending');
  assert.deepEqual(result.value.recovery_artifacts, ['backup']);
  assert.equal((await readJson(join(lifecycle(root), 'project-map.json'))).knowledge_baseline, 'baseline-2');
});

test('does not copy delivery prose or test logs from the Knowledge Diff into capability knowledge', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'ADD', addBlock);
  envelope.knowledge_diff.remaining_limits = ['Delivery log: internal chronology must remain a reference only.'];
  envelope.approval_receipt = approvalReceipt(envelope);
  const result = await applyKnowledgeDiff(envelope);
  assert.equal(result.ok, true);
  const source = await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8');
  assert.doesNotMatch(source, /internal chronology/);
  assert.doesNotMatch(source, /prd-desktop-theme/);
});
