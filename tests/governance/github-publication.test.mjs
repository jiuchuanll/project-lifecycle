import assert from 'node:assert/strict';
import test from 'node:test';

import { createGitHubAdapter } from '../../scripts/adapters/github.mjs';
import { publishReviewedCandidate } from '../../scripts/governance/publish.mjs';
import { createFakeProcessRunner } from '../helpers/fake-process-runner.mjs';

const githubHost = ['github', 'com'].join('.');
const sampleOwner = ['jiuchuan', 'll'].join('');
const sampleRepository = `${sampleOwner}/project-lifecycle`;

const successResponses = () => [
  { ok: true, code: 0, stdout: '', stderr: '' },
  { ok: true, code: 0, stdout: `https://${githubHost}/${sampleRepository}/pull/1\n`, stderr: '' },
  {
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      state: 'OPEN', mergeStateStatus: 'BLOCKED', reviewDecision: '', statusCheckRollup: [],
    }),
    stderr: '',
  },
];

test('uses exact argv-only envelopes for push, draft PR creation, and status view', async () => {
  const runner = createFakeProcessRunner(successResponses());
  const adapter = createGitHubAdapter({
    owner: sampleOwner, repo: 'project-lifecycle', acceptedBranch: 'main', runner,
  });

  assert.equal((await adapter.pushCandidate('codex/project-lifecycle-v1')).ok, true);
  const created = await adapter.createDraftPullRequest({
    head: 'codex/project-lifecycle-v1',
    title: 'Project Lifecycle v0.1.0',
    bodyFile: '/private/tmp/project-lifecycle-pr-body.md',
  });
  assert.equal(created.value.number, 1);
  assert.equal((await adapter.viewPullRequest(1)).ok, true);
  assert.deepEqual(runner.calls.map(({ command, args }) => [command, args]), [
    ['git', ['push', 'origin', 'codex/project-lifecycle-v1']],
    ['gh', ['pr', 'create', '--repo', sampleRepository, '--base', 'main', '--head', 'codex/project-lifecycle-v1', '--draft', '--title', 'Project Lifecycle v0.1.0', '--body-file', '/private/tmp/project-lifecycle-pr-body.md']],
    ['gh', ['pr', 'view', '1', '--repo', sampleRepository, '--json', 'state,mergeStateStatus,reviewDecision,statusCheckRollup']],
  ]);
});

test('parameterizes safe repositories and rejects unsafe refs or merge attempts without a command', async () => {
  const runner = createFakeProcessRunner();
  const adapter = createGitHubAdapter({ owner: 'example-org', repo: 'governance-v2', acceptedBranch: 'trunk', runner });

  assert.equal((await adapter.pushCandidate('codex/release-1')).ok, true);
  assert.equal((await adapter.pushCandidate('trunk')).errors[0].code, 'GITHUB_BRANCH_INVALID');
  assert.equal((await adapter.pushCandidate('codex/release;rm')).errors[0].code, 'GITHUB_BRANCH_INVALID');
  assert.equal((await adapter.mergePullRequest(2)).errors[0].code, 'GITHUB_MERGE_FORBIDDEN');
  assert.equal(runner.calls.length, 1);
});

test('rejects credential-bearing or malformed PR output with redacted diagnostics', async () => {
  const credential = ['sec', 'ret'].join('');
  const unsafeDiagnostic = `${['tok', 'en'].join('')}=${credential}`;
  const runner = createFakeProcessRunner([
    { ok: true, code: 0, stdout: `https://user:${credential}@${githubHost}/example/repo/pull/7\n`, stderr: unsafeDiagnostic },
  ]);
  const adapter = createGitHubAdapter({ owner: 'example', repo: 'repo', acceptedBranch: 'main', runner });

  const result = await adapter.createDraftPullRequest({
    head: 'codex/candidate', title: 'Candidate', bodyFile: '/private/tmp/body.md',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'GITHUB_OUTPUT_INVALID');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

const lease = (events) => ({
  acquire: async () => { events.push('lease:acquire'); return { ok: true, value: { lease: {} }, errors: [] }; },
  release: async () => { events.push('lease:release'); return { ok: true, value: null, errors: [] }; },
});

test('publishes a validated reviewed candidate in shard-first order and always releases the lease', async () => {
  const events = [];
  const shard = { pushCandidate: async () => { events.push('push:shard'); return { ok: true, value: null, errors: [] }; } };
  const governance = {
    pushCandidate: async () => { events.push('push:governance'); return { ok: true, value: null, errors: [] }; },
    createDraftPullRequest: async () => { events.push('pr:create'); return { ok: true, value: { number: 4, url: `https://${githubHost}/example/governance/pull/4` }, errors: [] }; },
  };
  const result = await publishReviewedCandidate({
    adapter: governance,
    lease: lease(events),
    ownerId: 'publication-owner',
    expectedGovernanceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    candidateBranch: 'codex/governance-candidate',
    validationResult: { ok: true, evidence_ref: 'validation:all-green' },
    humanGate: { required: true, resolved: true, approval_ref: 'approval:governance-change' },
    refreshAcceptedRevision: async () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    reconcileCandidate: async () => ({
      ok: true,
      value: { atomic_set: { expected_governance_revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      errors: [],
    }),
    validateAtomicSet: async () => ({ ok: true, value: null, errors: [] }),
    shardCandidate: { adapter: shard, branch: 'codex/shard-candidate' },
    title: 'Governance candidate',
    bodyFile: '/private/tmp/governance-body.md',
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.current_truth_changed, false);
  assert.equal(result.value.pull_request.number, 4);
  assert.deepEqual(events, ['lease:acquire', 'push:shard', 'push:governance', 'pr:create', 'lease:release']);
});

test('blocks missing validation, unresolved human gates, and stale refresh before publication', async () => {
  for (const override of [
    { validationResult: { ok: false } },
    { humanGate: { required: true, resolved: false } },
  ]) {
    const events = [];
    const result = await publishReviewedCandidate({
      adapter: {}, lease: lease(events), ownerId: 'owner',
      expectedGovernanceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      candidateBranch: 'codex/candidate',
      validationResult: { ok: true, evidence_ref: 'validation:ok' },
      humanGate: { required: false, resolved: true },
      ...override,
    });
    assert.equal(result.ok, false);
    assert.equal(events.length, 0);
  }

  const events = [];
  const noOpAdapter = {
    pushCandidate: async () => ({ ok: true, value: null, errors: [] }),
    createDraftPullRequest: async () => ({ ok: true, value: { number: 1 }, errors: [] }),
  };
  const stale = await publishReviewedCandidate({
    adapter: noOpAdapter, lease: lease(events), ownerId: 'owner',
    expectedGovernanceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    candidateBranch: 'codex/candidate',
    validationResult: { ok: true, evidence_ref: 'validation:ok' },
    humanGate: { required: false, resolved: true },
    refreshAcceptedRevision: async () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.errors[0].code, 'PUBLICATION_BASELINE_STALE');
  assert.deepEqual(events, ['lease:acquire', 'lease:release']);
});
