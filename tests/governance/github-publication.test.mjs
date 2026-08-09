import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGitHubAdapter } from '../../scripts/adapters/github.mjs';
import { publishReviewedCandidate } from '../../scripts/governance/publish.mjs';
import { createFakeProcessRunner } from '../helpers/fake-process-runner.mjs';

const githubHost = ['github', 'com'].join('.');
const sampleOwner = ['jiuchuan', 'll'].join('');
const sampleRepository = `${sampleOwner}/project-lifecycle`;

const adapterRoots = async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'project-lifecycle-github-repo-'));
  const bodyRoot = join(repositoryRoot, '.project-lifecycle', 'runtime', 'publication');
  await mkdir(bodyRoot, { recursive: true });
  return { repositoryRoot, bodyRoot };
};

const successResponses = (revision = 'b'.repeat(40)) => [
  { ok: true, code: 0, stdout: `https://${githubHost}/${sampleRepository}.git\n`, stderr: '' },
  { ok: true, code: 0, stdout: `${revision}\n`, stderr: '' },
  { ok: true, code: 0, stdout: '', stderr: '' },
  { ok: true, code: 0, stdout: `https://${githubHost}/${sampleRepository}/pull/1\n`, stderr: '' },
  { ok: true, code: 0, stdout: `${JSON.stringify({ headRefOid: revision })}\n`, stderr: '' },
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
  const roots = await adapterRoots();
  const bodyFile = join(roots.bodyRoot, 'project-lifecycle-pr-body.md');
  await writeFile(bodyFile, 'Reviewed candidate\n');
  const runner = createFakeProcessRunner(successResponses());
  const adapter = createGitHubAdapter({
    owner: sampleOwner, repo: 'project-lifecycle', acceptedBranch: 'main', runner, ...roots,
  });

  assert.equal((await adapter.pushCandidate('codex/project-lifecycle-v1')).ok, true);
  const created = await adapter.createDraftPullRequest({
    head: 'codex/project-lifecycle-v1',
    expectedRevision: 'b'.repeat(40),
    title: 'Project Lifecycle v0.1.0',
    bodyFile,
  });
  const physicalBodyFile = await realpath(bodyFile);
  assert.equal(created.value.number, 1);
  assert.equal((await adapter.viewPullRequest(1)).ok, true);
  assert.deepEqual(runner.calls.map(({ command, args }) => [command, args]), [
    ['git', ['remote', 'get-url', '--push', '--all', 'origin']],
    ['git', ['rev-parse', '--verify', 'codex/project-lifecycle-v1^{commit}']],
    ['git', ['push', 'origin', `${'b'.repeat(40)}:refs/heads/codex/project-lifecycle-v1`]],
    ['gh', ['pr', 'create', '--repo', sampleRepository, '--base', 'main', '--head', 'codex/project-lifecycle-v1', '--draft', '--title', 'Project Lifecycle v0.1.0', '--body-file', physicalBodyFile]],
    ['gh', ['pr', 'view', '1', '--repo', sampleRepository, '--json', 'headRefOid']],
    ['gh', ['pr', 'view', '1', '--repo', sampleRepository, '--json', 'state,mergeStateStatus,reviewDecision,statusCheckRollup']],
  ]);
});

test('parameterizes safe repositories and rejects unsafe refs or merge attempts without a command', async () => {
  const roots = await adapterRoots();
  const runner = createFakeProcessRunner([
    { ok: true, code: 0, stdout: `https://${githubHost}/example-org/governance-v2.git\n`, stderr: '' },
    { ok: true, code: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' },
    { ok: true, code: 0, stdout: '', stderr: '' },
  ]);
  const adapter = createGitHubAdapter({ owner: 'example-org', repo: 'governance-v2', acceptedBranch: 'trunk', runner, ...roots });

  assert.equal((await adapter.pushCandidate('codex/release-1')).ok, true);
  assert.equal((await adapter.pushCandidate('trunk')).errors[0].code, 'GITHUB_BRANCH_INVALID');
  assert.equal((await adapter.pushCandidate('codex/release;rm')).errors[0].code, 'GITHUB_BRANCH_INVALID');
  assert.equal((await adapter.mergePullRequest(2)).errors[0].code, 'GITHUB_MERGE_FORBIDDEN');
  assert.equal(runner.calls.length, 3);
});

test('rejects credential-bearing or malformed PR output with redacted diagnostics', async () => {
  const roots = await adapterRoots();
  const bodyFile = join(roots.bodyRoot, 'body.md');
  await writeFile(bodyFile, 'Candidate\n');
  const credential = ['sec', 'ret'].join('');
  const unsafeDiagnostic = `${['tok', 'en'].join('')}=${credential}`;
  const runner = createFakeProcessRunner([
    { ok: true, code: 0, stdout: `https://user:${credential}@${githubHost}/example/repo/pull/7\n`, stderr: unsafeDiagnostic },
  ]);
  const adapter = createGitHubAdapter({ owner: 'example', repo: 'repo', acceptedBranch: 'main', runner, ...roots });

  const result = await adapter.createDraftPullRequest({
    head: 'codex/candidate', expectedRevision: 'b'.repeat(40), title: 'Candidate', bodyFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'GITHUB_OUTPUT_INVALID');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('rejects a draft pull request whose immutable head differs from the reviewed revision', async () => {
  const roots = await adapterRoots();
  const bodyFile = join(roots.bodyRoot, 'body.md');
  await writeFile(bodyFile, 'Candidate\n');
  const runner = createFakeProcessRunner([
    { ok: true, code: 0, stdout: `https://${githubHost}/${sampleRepository}/pull/2\n`, stderr: '' },
    { ok: true, code: 0, stdout: `${JSON.stringify({ headRefOid: 'd'.repeat(40) })}\n`, stderr: '' },
  ]);
  const adapter = createGitHubAdapter({
    owner: sampleOwner, repo: 'project-lifecycle', acceptedBranch: 'main', runner, ...roots,
  });

  const result = await adapter.createDraftPullRequest({
    head: 'codex/project-lifecycle-v1', expectedRevision: 'c'.repeat(40), title: 'Candidate', bodyFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'GITHUB_PR_HEAD_MISMATCH');
});

test('pushes the exact resolved commit from the configured repository with a bounded timeout', async () => {
  const roots = await adapterRoots();
  const revision = 'b'.repeat(40);
  const runner = createFakeProcessRunner([
    { ok: true, code: 0, stdout: `https://${githubHost}/${sampleRepository}.git\n`, stderr: '' },
    { ok: true, code: 0, stdout: `${revision}\n`, stderr: '' },
    { ok: true, code: 0, stdout: '', stderr: '' },
  ]);
  const adapter = createGitHubAdapter({
    owner: sampleOwner, repo: 'project-lifecycle', acceptedBranch: 'main', runner, ...roots,
  });

  const result = await adapter.pushCandidate('codex/project-lifecycle-v1');

  assert.deepEqual(result.value, { branch: 'codex/project-lifecycle-v1', revision });
  assert.deepEqual(runner.calls.map(({ command, args }) => [command, args]), [
    ['git', ['remote', 'get-url', '--push', '--all', 'origin']],
    ['git', ['rev-parse', '--verify', 'codex/project-lifecycle-v1^{commit}']],
    ['git', ['push', 'origin', `${revision}:refs/heads/codex/project-lifecycle-v1`]],
  ]);
  assert.equal(runner.calls.every(({ options }) => options.cwd === roots.repositoryRoot && options.timeoutMs === 30_000), true);
});

test('rejects an origin when any effective push URL targets another repository', async () => {
  const roots = await adapterRoots();
  const runner = {
    calls: [],
    runProcess: async (command, args, options) => {
      runner.calls.push({ command, args, options });
      if (args.join(' ') === 'remote get-url origin') {
        return { ok: true, code: 0, stdout: `https://${githubHost}/${sampleRepository}.git\n`, stderr: '' };
      }
      if (args.join(' ') === 'remote get-url --push --all origin') {
        return { ok: true, code: 0, stdout: `https://${githubHost}/${sampleRepository}.git\nhttps://${githubHost}/other/repository.git\n`, stderr: '' };
      }
      if (args[0] === 'rev-parse') return { ok: true, code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  };
  const adapter = createGitHubAdapter({
    owner: sampleOwner, repo: 'project-lifecycle', acceptedBranch: 'main', runner, ...roots,
  });

  const result = await adapter.pushCandidate('codex/project-lifecycle-v1');

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'GITHUB_REPOSITORY_MISMATCH');
  assert.equal(runner.calls.some(({ args }) => args[0] === 'push'), false);
});

test('rejects a PR body outside its configured regular-file root before invoking GitHub', async () => {
  const roots = await adapterRoots();
  const outside = join(await mkdtemp(join(tmpdir(), 'project-lifecycle-github-outside-')), 'body.md');
  await writeFile(outside, 'private local content\n');
  const runner = createFakeProcessRunner([
    { ok: true, code: 0, stdout: `https://${githubHost}/${sampleRepository}/pull/1\n`, stderr: '' },
  ]);
  const adapter = createGitHubAdapter({
    owner: sampleOwner, repo: 'project-lifecycle', acceptedBranch: 'main', runner, ...roots,
  });

  const result = await adapter.createDraftPullRequest({
    head: 'codex/project-lifecycle-v1', title: 'Candidate', bodyFile: outside,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'GITHUB_PR_INPUT_INVALID');
  assert.equal(runner.calls.length, 0);
});

const lease = (events) => ({
  acquire: async () => { events.push('lease:acquire'); return { ok: true, value: { lease: {} }, errors: [] }; },
  renew: async () => { events.push('lease:renew'); return { ok: true, value: { lease: {} }, errors: [] }; },
  release: async () => { events.push('lease:release'); return { ok: true, value: null, errors: [] }; },
});

test('publishes a validated reviewed candidate in shard-first order and always releases the lease', async () => {
  const events = [];
  const revision = 'c'.repeat(40);
  const shardRevision = 'd'.repeat(40);
  const shard = { pushCandidate: async () => { events.push('push:shard'); return { ok: true, value: { revision: shardRevision }, errors: [] }; } };
  const governance = {
    pushCandidate: async () => { events.push('push:governance'); return { ok: true, value: { revision }, errors: [] }; },
    createDraftPullRequest: async () => { events.push('pr:create'); return { ok: true, value: { number: 4, url: `https://${githubHost}/example/governance/pull/4`, head_revision: revision }, errors: [] }; },
  };
  const result = await publishReviewedCandidate({
    adapter: governance,
    lease: lease(events),
    ownerId: 'publication-owner',
    expectedGovernanceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    candidateBranch: 'codex/governance-candidate',
    validationResult: { ok: true, evidence_ref: 'validation:all-green', candidate_revision: revision },
    humanGate: { required: true, resolved: true, approval_ref: 'approval:governance-change', candidate_revision: revision },
    refreshAcceptedRevision: async () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    reconcileCandidate: async () => ({
      ok: true,
      value: { atomic_set: { expected_governance_revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', candidate_revision: revision } },
      errors: [],
    }),
    validateAtomicSet: async () => ({ ok: true, value: null, errors: [] }),
    shardCandidate: { adapter: shard, branch: 'codex/shard-candidate', candidate_revision: shardRevision },
    title: 'Governance candidate',
    bodyFile: '/private/tmp/governance-body.md',
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.current_truth_changed, false);
  assert.equal(result.value.pull_request.number, 4);
  assert.deepEqual(events, ['lease:acquire', 'lease:renew', 'push:shard', 'lease:renew', 'push:governance', 'lease:renew', 'pr:create', 'lease:release']);
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
    pushCandidate: async () => ({ ok: true, value: { revision: 'c'.repeat(40) }, errors: [] }),
    createDraftPullRequest: async () => ({ ok: true, value: { number: 1 }, errors: [] }),
  };
  const stale = await publishReviewedCandidate({
    adapter: noOpAdapter, lease: lease(events), ownerId: 'owner',
    expectedGovernanceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    candidateBranch: 'codex/candidate',
    validationResult: { ok: true, evidence_ref: 'validation:ok', candidate_revision: 'c'.repeat(40) },
    humanGate: { required: false, resolved: true, candidate_revision: 'c'.repeat(40) },
    refreshAcceptedRevision: async () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.errors[0].code, 'PUBLICATION_BASELINE_STALE');
  assert.deepEqual(events, ['lease:acquire', 'lease:release']);
});

test('binds validation, approval, reconciled state, and pushed commit to one revision', async () => {
  const revision = 'c'.repeat(40);
  const events = [];
  const result = await publishReviewedCandidate({
    adapter: {
      pushCandidate: async () => ({ ok: true, value: { branch: 'codex/candidate', revision }, errors: [] }),
      createDraftPullRequest: async () => ({ ok: true, value: { number: 1, url: `https://${githubHost}/example/repo/pull/1`, head_revision: revision }, errors: [] }),
    },
    lease: {
      acquire: async () => ({ ok: true, value: {}, errors: [] }),
      renew: async () => { events.push('renew'); return { ok: true, value: {}, errors: [] }; },
      release: async () => ({ ok: true, value: {}, errors: [] }),
    },
    ownerId: 'publisher', expectedGovernanceRevision: 'a'.repeat(40), candidateBranch: 'codex/candidate',
    validationResult: { ok: true, evidence_ref: 'validation:bound', candidate_revision: revision },
    humanGate: { required: true, resolved: true, approval_ref: 'approval:bound', candidate_revision: revision },
    refreshAcceptedRevision: async () => 'a'.repeat(40),
    reconcileCandidate: async () => ({ ok: true, value: { atomic_set: { expected_governance_revision: 'a'.repeat(40), candidate_revision: revision } }, errors: [] }),
    validateAtomicSet: async () => ({ ok: true, value: {}, errors: [] }),
    title: 'Candidate', bodyFile: '/tmp/body.md',
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(events, ['renew', 'renew']);

  const mismatch = await publishReviewedCandidate({
    adapter: {
      pushCandidate: async () => ({ ok: true, value: { branch: 'codex/candidate', revision: 'd'.repeat(40) }, errors: [] }),
      createDraftPullRequest: async () => ({ ok: true, value: { number: 1 }, errors: [] }),
    },
    lease: {
      acquire: async () => ({ ok: true, value: {}, errors: [] }),
      renew: async () => ({ ok: true, value: {}, errors: [] }),
      release: async () => ({ ok: true, value: {}, errors: [] }),
    },
    ownerId: 'publisher', expectedGovernanceRevision: 'a'.repeat(40), candidateBranch: 'codex/candidate',
    validationResult: { ok: true, evidence_ref: 'validation:bound', candidate_revision: revision },
    humanGate: { required: true, resolved: true, approval_ref: 'approval:bound', candidate_revision: revision },
    refreshAcceptedRevision: async () => 'a'.repeat(40),
    reconcileCandidate: async () => ({ ok: true, value: { atomic_set: { expected_governance_revision: 'a'.repeat(40), candidate_revision: revision } }, errors: [] }),
    validateAtomicSet: async () => ({ ok: true, value: {}, errors: [] }),
    title: 'Candidate', bodyFile: '/tmp/body.md',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.errors[0].code, 'PUBLICATION_CANDIDATE_MISMATCH');
});

test('rejects a failed shard push even when it reports the expected revision', async () => {
  const revision = 'c'.repeat(40);
  const shardRevision = 'd'.repeat(40);
  let governancePushes = 0;
  const result = await publishReviewedCandidate({
    adapter: {
      pushCandidate: async () => { governancePushes += 1; return { ok: true, value: { revision }, errors: [] }; },
      createDraftPullRequest: async () => ({ ok: true, value: { number: 1 }, errors: [] }),
    },
    lease: {
      acquire: async () => ({ ok: true, value: {}, errors: [] }),
      renew: async () => ({ ok: true, value: {}, errors: [] }),
      release: async () => ({ ok: true, value: {}, errors: [] }),
    },
    ownerId: 'publisher', expectedGovernanceRevision: 'a'.repeat(40), candidateBranch: 'codex/candidate',
    validationResult: { ok: true, evidence_ref: 'validation:bound', candidate_revision: revision },
    humanGate: { required: true, resolved: true, approval_ref: 'approval:bound', candidate_revision: revision },
    refreshAcceptedRevision: async () => 'a'.repeat(40),
    reconcileCandidate: async () => ({ ok: true, value: { atomic_set: { expected_governance_revision: 'a'.repeat(40), candidate_revision: revision } }, errors: [] }),
    validateAtomicSet: async () => ({ ok: true, value: {}, errors: [] }),
    shardCandidate: {
      branch: 'codex/shard', candidate_revision: shardRevision,
      adapter: { pushCandidate: async () => ({ ok: false, value: { revision: shardRevision }, errors: [] }) },
    },
    title: 'Candidate', bodyFile: '/tmp/body.md',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'PUBLICATION_SHARD_INCOMPLETE');
  assert.equal(governancePushes, 0);
});

test('validates every declared shard push before publishing governance', async () => {
  const revision = 'c'.repeat(40);
  const events = [];
  const result = await publishReviewedCandidate({
    adapter: {
      pushCandidate: async () => { events.push('push:governance'); return { ok: true, value: { revision }, errors: [] }; },
      createDraftPullRequest: async () => ({ ok: true, value: { number: 1, head_revision: revision }, errors: [] }),
    },
    lease: lease(events), ownerId: 'publisher', expectedGovernanceRevision: 'a'.repeat(40),
    candidateBranch: 'codex/candidate',
    validationResult: { ok: true, evidence_ref: 'validation:bound', candidate_revision: revision },
    humanGate: { required: true, resolved: true, approval_ref: 'approval:bound', candidate_revision: revision },
    refreshAcceptedRevision: async () => 'a'.repeat(40),
    reconcileCandidate: async () => ({ ok: true, value: { atomic_set: { expected_governance_revision: 'a'.repeat(40), candidate_revision: revision } }, errors: [] }),
    validateAtomicSet: async () => ({ ok: true, value: {}, errors: [] }),
    shardCandidate: { candidates: [
      {
        branch: 'codex/ui',
        candidate_revision: 'd'.repeat(40),
        adapter: {
          pushCandidate: async () => {
            events.push('push:ui');
            return { ok: true, value: { revision: 'd'.repeat(40) }, errors: [] };
          },
        },
      },
      {
        branch: 'codex/service',
        candidate_revision: 'e'.repeat(40),
        adapter: {
          pushCandidate: async () => {
            events.push('push:service');
            return { ok: true, value: { revision: 'f'.repeat(40) }, errors: [] };
          },
        },
      },
    ] },
    title: 'Candidate', bodyFile: '/tmp/body.md',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'PUBLICATION_SHARD_INCOMPLETE');
  assert.equal(events.includes('push:ui'), true);
  assert.equal(events.includes('push:service'), true);
  assert.equal(events.includes('push:governance'), false);
});
