import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyKnowledgeDiff } from '../../scripts/knowledge/apply-knowledge-diff.mjs';
import { parseFactBlocks } from '../../scripts/lib/fact-blocks.mjs';

const fixtureRoot = new URL('../fixtures/knowledge/topology/base/', import.meta.url);
const addFixture = new URL('../fixtures/knowledge/absorption/accepted-add.json', import.meta.url);
const lifecycle = (root) => join(root, 'docs/project-lifecycle');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (source) => `sha256:${createHash('sha256').update(source).digest('hex')}`;

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

const accepted = async (root, kind, transform, overrides = {}) => ({
  root,
  knowledge_diff: await diffFor(kind),
  new_baseline: 'baseline-2',
  approval_ref: 'approval:accepted-delivery',
  ...(['REWRITE', 'SUPERSEDE'].includes(kind)
    ? { resolution_ref: 'decision:accepted-knowledge-diff' }
    : {}),
  knowledge_updates: await updateFor(root, transform),
  ...overrides,
});

test('applies a disjoint accepted ADD and atomically advances pair, owner, map, and generated indexes', async (context) => {
  const root = await setup(context);
  const result = await applyKnowledgeDiff(await accepted(root, 'ADD', addBlock));

  assert.equal(result.ok, true);
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

test('applies accepted same-subject REWRITE with the same fact ID and exactly one revision increment', async (context) => {
  const root = await setup(context);
  const result = await applyKnowledgeDiff(await accepted(root, 'REWRITE', rewriteBlock));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.applied_facts, [{ fact_id: 'desktop-shell-fact', owner_domain_id: 'desktop-experience', revision: 2 }]);
  const facts = parseFactBlocks(await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8'));
  assert.equal(facts.value[0].fact_id, 'desktop-shell-fact');
  assert.equal(facts.value[0].revision, 2);
  assert.match(facts.value[0].statement, /workspace frame and rail/);
});

test('applies approved SUPERSEDE with a fresh successor identity and removes predecessor from default retrieval', async (context) => {
  const root = await setup(context);
  const result = await applyKnowledgeDiff(await accepted(root, 'SUPERSEDE', supersedeBlock));
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

test('an unresolved same-fact change writes only one deduplicated bounded pending conflict', async (context) => {
  const root = await setup(context);
  const envelope = await accepted(root, 'REWRITE', rewriteBlock);
  delete envelope.approval_ref;
  delete envelope.resolution_ref;
  const beforePair = await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8');
  const first = await applyKnowledgeDiff(envelope, { now: () => '2026-08-09T00:00:00.000Z' });
  const second = await applyKnowledgeDiff(envelope, { now: () => '2026-08-10T00:00:00.000Z' });
  assert.equal(first.ok, true);
  assert.equal(first.value.status, 'pending-review');
  assert.equal(second.ok, true);
  const pending = await readJson(join(lifecycle(root), 'pending-changes.json'));
  assert.equal(pending.changes.length, 1);
  assert.equal(pending.changes[0].created_at, '2026-08-09T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(pending), /workspace frame and rail/);
  assert.equal(await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8'), beforePair);
  assert.equal((await readJson(join(lifecycle(root), 'project-map.json'))).knowledge_baseline, 'baseline-1');
});

test('an approved pending conflict applies only when its link matches the diff identity', async (context) => {
  const root = await setup(context);
  const unresolved = await accepted(root, 'REWRITE', rewriteBlock);
  delete unresolved.approval_ref;
  delete unresolved.resolution_ref;
  const pendingResult = await applyKnowledgeDiff(unresolved, { now: () => '2026-08-09T00:00:00.000Z' });
  const changeId = pendingResult.value.change_id;

  const wrong = await applyKnowledgeDiff(await accepted(root, 'REWRITE', rewriteBlock, {
    conflict_resolution: { change_id: 'absorption-other-diff' },
  }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.errors[0].code, 'ABSORPTION_CONFLICT_MISMATCH');

  const applied = await applyKnowledgeDiff(await accepted(root, 'REWRITE', rewriteBlock, {
    conflict_resolution: { change_id: changeId },
  }));
  assert.equal(applied.ok, true);
  assert.deepEqual((await readJson(join(lifecycle(root), 'pending-changes.json'))).changes, []);
});

test('does not overwrite an unrelated pending record that collides with the derived conflict ID', async (context) => {
  const root = await setup(context);
  const pendingPath = join(lifecycle(root), 'pending-changes.json');
  const pending = await readJson(pendingPath);
  pending.changes.push({
    change_id: 'absorption-diff-rewrite-desktop',
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
  delete envelope.approval_ref;
  delete envelope.resolution_ref;
  const before = await snapshot(lifecycle(root));
  const result = await applyKnowledgeDiff(envelope);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_CONFLICT_MISMATCH');
  assert.deepEqual(await snapshot(lifecycle(root)), before);
});

test('requires the explicit conflict link when an accepted diff already has a pending review record', async (context) => {
  const root = await setup(context);
  const unresolved = await accepted(root, 'REWRITE', rewriteBlock);
  delete unresolved.approval_ref;
  delete unresolved.resolution_ref;
  await applyKnowledgeDiff(unresolved, { now: () => '2026-08-09T00:00:00.000Z' });
  const result = await applyKnowledgeDiff(await accepted(root, 'REWRITE', rewriteBlock));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ABSORPTION_CONFLICT_MISMATCH');
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
  const result = await applyKnowledgeDiff({ root, knowledge_diff: diff, knowledge_updates: [] }, { now: () => '2026-08-09T00:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'pending-review');
  const pending = await readJson(join(lifecycle(root), 'pending-changes.json'));
  assert.equal(pending.changes[0].kind, 'topology');
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
  const result = await applyKnowledgeDiff(envelope);
  assert.equal(result.ok, true);
  const source = await readFile(join(lifecycle(root), 'knowledge/desktop-experience-en.md'), 'utf8');
  assert.doesNotMatch(source, /internal chronology/);
  assert.doesNotMatch(source, /prd-desktop-theme/);
});
