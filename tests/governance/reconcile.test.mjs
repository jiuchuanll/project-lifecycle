import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createKnowledgeSet, knowledgeSetFromDiff } from '../../scripts/governance/knowledge-set.mjs';
import { reconcileKnowledgeCandidate } from '../../scripts/governance/reconcile.mjs';
import { validateJson } from '../../scripts/lib/validate-json.mjs';

const fixture = JSON.parse(await readFile(
  new URL('../fixtures/governance/reconcile/cases.json', import.meta.url),
  'utf8',
));
const baseline = (revision, shardRevision = fixture.frontend_revision) => Object.freeze({
  projectId: 'sample-app',
  governanceRevision: revision,
  projectMapHash: `sha256:${revision.padEnd(64, revision[0]).slice(0, 64)}`,
  shardRevisions: Object.freeze([Object.freeze({ repositoryId: 'frontend-repository', revision: shardRevision })]),
  completeness: 'COMPLETE',
});
const diff = (operations = []) => ({
  schema_version: 1,
  diff_id: 'knowledge-diff-wiki-v2',
  owner_delivery_id: 'prd-wiki-v2',
  knowledge_baseline: fixture.starting_revision,
  operations,
  domain_changes: [],
  entry_points: ['client/wiki'],
  evidence_refs: ['test:wiki-v2'],
  remaining_limits: [],
  outcome: 'CHANGE',
});
const operation = (factId, evidence = 'test:wiki-v2') => ({
  kind: 'REWRITE',
  fact_id: factId,
  owner_domain_id: 'wiki-workspace',
  evidence_refs: [evidence],
});
const fact = (factId, valueHash, overrides = {}) => ({
  factId,
  ownerDomainId: 'wiki-workspace',
  valueHash,
  evidenceRevision: 'evidence:1',
  evidenceRefs: ['test:wiki-v2'],
  changeKind: 'VALUE',
  ...overrides,
});
const input = ({ candidateSet, acceptedSet, knowledgeDiff = diff([operation('wiki-layout')]), latest = baseline(fixture.latest_revision), ...rest }) => ({
  startingBaseline: baseline(fixture.starting_revision),
  latestBaseline: latest,
  knowledgeDiff,
  candidateSet,
  latestAcceptedSet: acceptedSet,
  candidateRef: 'candidate:prd-wiki-v2',
  latestAcceptedRef: 'accepted:governance-main',
  createdAt: '2026-08-09T00:00:00.000Z',
  ...rest,
});

test('replays disjoint facts in one domain onto the latest governance baseline', () => {
  const knowledgeDiff = diff([operation('wiki-layout')]);
  const candidateSet = knowledgeSetFromDiff(knowledgeDiff, {
    facts: [fact('wiki-layout', fixture.layout_hash)],
  });
  const acceptedSet = createKnowledgeSet({
    facts: [fact('wiki-search', fixture.search_hash, { evidenceRefs: ['test:search-v2'] })],
  });

  const result = reconcileKnowledgeCandidate(input({ candidateSet, acceptedSet, knowledgeDiff }));

  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'replay_ready');
  assert.equal(result.value.knowledge_diff.knowledge_baseline, fixture.latest_revision);
  assert.equal(result.value.atomic_set.expected_governance_revision, fixture.latest_revision);
  assert.deepEqual(result.value.atomic_set.knowledge_diff, result.value.knowledge_diff);
  assert.deepEqual(result.value.knowledge_diff.operations.map(({ fact_id: id }) => id), ['wiki-layout']);
  assert.equal(result.value.pending_change, null);
});

test('merges a compatible evidence refresh for an identical fact value', () => {
  const knowledgeDiff = diff([operation('wiki-layout')]);
  const candidateSet = knowledgeSetFromDiff(knowledgeDiff, {
    facts: [fact('wiki-layout', fixture.layout_hash, {
      changeKind: 'EVIDENCE_REFRESH', evidenceRevision: 'evidence:2', evidenceRefs: ['test:candidate'],
    })],
  });
  const acceptedSet = createKnowledgeSet({
    facts: [fact('wiki-layout', fixture.layout_hash, {
      changeKind: 'EVIDENCE_REFRESH', evidenceRevision: 'evidence:3', evidenceRefs: ['test:accepted'],
    })],
  });

  const result = reconcileKnowledgeCandidate(input({ candidateSet, acceptedSet, knowledgeDiff }));

  assert.equal(result.value.status, 'replay_ready');
  assert.deepEqual(result.value.knowledge_diff.operations[0].evidence_refs, [
    'test:accepted', 'test:candidate',
  ]);
  assert.deepEqual(result.value.knowledge_diff.evidence_refs, [
    'test:accepted', 'test:candidate', 'test:wiki-v2',
  ]);
});

test('creates one bounded pending entry for a conflicting value of the same fact', () => {
  const knowledgeDiff = diff([operation('wiki-layout')]);
  const candidateSet = knowledgeSetFromDiff(knowledgeDiff, {
    facts: [fact('wiki-layout', fixture.layout_hash)],
  });
  const acceptedSet = createKnowledgeSet({
    facts: [fact('wiki-layout', fixture.layout_other_hash, { evidenceRefs: ['test:accepted'] })],
  });
  const originalDiff = structuredClone(knowledgeDiff);

  const result = reconcileKnowledgeCandidate(input({ candidateSet, acceptedSet, knowledgeDiff }));

  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'conflict');
  assert.equal(result.value.stop.code, 'CONFLICT');
  assert.equal(result.value.pending_change.proposed_disposition, 'CONFLICT_RESOLUTION_REQUIRED');
  assert.deepEqual(result.value.pending_change.affected_refs, ['fact:wiki-layout']);
  assert.equal(result.value.pending_change.trigger_refs.includes('test:accepted'), true);
  assert.equal(result.value.pending_change.trigger_refs.includes('test:wiki-v2'), true);
  assert.equal(validateJson('pending-changes', {
    schema_version: 1, changes: [result.value.pending_change],
  }).ok, true);
  assert.deepEqual(knowledgeDiff, originalDiff);
  assert.equal(result.value.knowledge_diff, null);
  assert.equal(result.value.atomic_set, null);
});

for (const [field, value, expectedRef] of [
  ['domains', 'wiki-workspace', 'domain:wiki-workspace'],
  ['constraints', 'desktop-shell', 'constraint:desktop-shell'],
  ['topologyEdges', 'wiki-parent-edge', 'topology:wiki-parent-edge'],
  ['ownerships', 'wiki-layout-owner', 'owner:wiki-layout-owner'],
]) {
  test(`stops concurrent ${field} changes for human conflict review`, () => {
    const candidateSet = createKnowledgeSet({ [field]: [value] });
    const acceptedSet = createKnowledgeSet({ [field]: [value] });
    const knowledgeDiff = {
      ...diff([]),
      domain_changes: [{
        domain_id: 'wiki-workspace',
        change: 'Bounded governed change.',
        evidence_refs: ['test:wiki-v2'],
      }],
    };
    const result = reconcileKnowledgeCandidate(input({ candidateSet, acceptedSet, knowledgeDiff }));

    assert.equal(result.value.status, 'conflict');
    assert.deepEqual(result.value.pending_change.affected_refs, [expectedRef]);
  });
}

test('keeps an unpinned local shard candidate non-current when governance advanced its pin', () => {
  const knowledgeDiff = diff([operation('wiki-layout')]);
  const candidateSet = knowledgeSetFromDiff(knowledgeDiff, {
    facts: [fact('wiki-layout', fixture.layout_hash)],
  });
  const acceptedSet = createKnowledgeSet({ facts: [] });
  const result = reconcileKnowledgeCandidate(input({
    candidateSet,
    acceptedSet,
    knowledgeDiff,
    latest: baseline(fixture.latest_revision, fixture.frontend_advanced_revision),
    localShardCandidate: {
      repositoryId: 'frontend-repository',
      expectedPreviousRevision: fixture.frontend_revision,
      candidateRevision: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    },
  }));

  assert.equal(result.value.status, 'conflict');
  assert.equal(result.value.shard_pin_candidate, null);
  assert.deepEqual(result.value.pending_change.affected_refs, ['owner:frontend-repository']);
});

test('rejects an obsolete or foreign baseline that cannot identify the starting project', () => {
  const knowledgeDiff = diff([operation('wiki-layout')]);
  knowledgeDiff.knowledge_baseline = 'unrelated-revision';
  const result = reconcileKnowledgeCandidate(input({
    candidateSet: createKnowledgeSet({ facts: [fact('wiki-layout', fixture.layout_hash)] }),
    acceptedSet: createKnowledgeSet({}),
    knowledgeDiff,
  }));

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'RECONCILIATION_BASELINE_INVALID');
});
