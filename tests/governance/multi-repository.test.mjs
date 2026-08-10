import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGitLocalStorage } from '../../scripts/adapters/git-local.mjs';
import { createGitHubAdapter } from '../../scripts/adapters/github.mjs';
import { createKnowledgeSet, knowledgeSetFromDiff } from '../../scripts/governance/knowledge-set.mjs';
import { publishReviewedCandidate } from '../../scripts/governance/publish.mjs';
import { reconcileKnowledgeCandidate } from '../../scripts/governance/reconcile.mjs';
import { resolveGovernanceRoot } from '../../scripts/governance/resolve-root.mjs';
import { pinTaskBaseline } from '../../scripts/governance/task-baseline.mjs';
import { createGovernanceWriteLease } from '../../scripts/governance/write-lease.mjs';
import { generateIndexes } from '../../scripts/knowledge/generate-indexes.mjs';
import { createFakeProcessRunner } from '../helpers/fake-process-runner.mjs';

const fixture = JSON.parse(await readFile(
  new URL('../fixtures/governance/multi-repository/cases.json', import.meta.url),
  'utf8',
));
const exec = promisify(execFile);
const git = async (root, args) => (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
const write = async (root, path, content) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};
const commitAll = async (root, message) => {
  await git(root, ['add', '--', '.']);
  await git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
};
const repository = async (context, prefix, files) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Project Lifecycle Tests']);
  await git(root, ['config', 'user.email', 'tests@example.invalid']);
  for (const [path, content] of Object.entries(files)) await write(root, path, content);
  const revision = await commitAll(root, 'initial');
  return { root, revision, storage: createGitLocalStorage({ repositoryRoot: root }) };
};
const domain = (id, relationships = []) => ({
  id,
  kind: 'domain',
  label: { en: id, 'zh-CN': id },
  purpose: { en: `Owns ${id}.`, 'zh-CN': `负责 ${id}。` },
  domain_state: 'confirmed',
  scope: { includes: [id], excludes: [] },
  parent_id: null,
  relationships,
  evidence_refs: ['repo:README.md'],
  known_gaps: [],
});
const registration = (id, domainId, locators, revision) => ({
  id,
  purpose: { en: `Owns ${id}.`, 'zh-CN': `负责 ${id}。` },
  portable_locator: `github:example/${id}`,
  integration_ref: 'refs/heads/main',
  domain_ids: [domainId],
  knowledge_asset_locators: locators,
  accepted_revision: revision,
});
const pointer = (projectId, repositoryId) => `${JSON.stringify({
  schema_version: 1,
  project_id: projectId,
  repository_id: repositoryId,
  governance_locator: 'github:example/wiki-governance',
}, null, 2)}\n`;

const setup = async (context) => {
  const frontendLocators = ['knowledge/wiki-interface-en.md', 'knowledge/wiki-interface.md'];
  const backendLocators = ['knowledge/wiki-service-en.md', 'knowledge/wiki-service.md'];
  const commonLocators = ['knowledge/common-contract-en.md', 'knowledge/common-contract.md'];
  const frontend = await repository(context, 'phase4-frontend-', {
    'docs/project-lifecycle/project-pointer.json': pointer(fixture.legacy_project_id, 'frontend-repository'),
    [`docs/project-lifecycle/${frontendLocators[0]}`]: `# Wiki interface\n\n${fixture.bodies.frontend}\n`,
    [`docs/project-lifecycle/${frontendLocators[1]}`]: `# Wiki 界面\n\n${fixture.bodies.frontend}\n`,
  });
  const backend = await repository(context, 'phase4-backend-', {
    'docs/project-lifecycle/project-pointer.json': pointer(fixture.project_id, 'backend-repository'),
    [`docs/project-lifecycle/${backendLocators[0]}`]: `# Wiki service\n\n${fixture.bodies.backend}\n`,
    [`docs/project-lifecycle/${backendLocators[1]}`]: `# Wiki 服务\n\n${fixture.bodies.backend}\n`,
  });
  const governance = await repository(context, 'phase4-governance-', {
    [`docs/project-lifecycle/${commonLocators[0]}`]: `# Common contract\n\n${fixture.bodies.common}\n`,
    [`docs/project-lifecycle/${commonLocators[1]}`]: `# 公共契约\n\n${fixture.bodies.common}\n`,
    'docs/project-lifecycle/delivery/prd-wiki-refinement-en.md': '# Wiki refinement PRD\n\nTwo bounded Delivery Units.\n',
    'docs/project-lifecycle/delivery/prd-wiki-refinement.md': '# Wiki 精细化 PRD\n\n两个有边界的交付单元。\n',
  });
  const map = {
    schema_version: 2,
    project_id: fixture.project_id,
    knowledge_baseline: 'baseline:phase4-start',
    project_identity: {
      label: { en: 'Wiki suite', 'zh-CN': 'Wiki 套件' },
      purpose: { en: 'Owns the Wiki product.', 'zh-CN': '负责 Wiki 产品。' },
      calibration_ref: 'calibration:accepted',
    },
    identity_lineage: [{
      predecessor_project_id: fixture.legacy_project_id,
      relationship: 'SUCCESSOR',
      successor_project_ids: [fixture.project_id],
      effective_baseline: 'baseline:phase4-start',
      approval_ref: 'approval:identity-successor',
    }],
    repositories: [
      registration('backend-repository', fixture.backend_domain_id, backendLocators, backend.revision),
      registration('frontend-repository', fixture.frontend_domain_id, frontendLocators, frontend.revision),
      registration('governance-repository', fixture.common_domain_id, commonLocators, governance.revision),
    ],
    constraints: [{ id: fixture.shared_constraint_id, scope: 'self', owner_id: fixture.common_domain_id }],
    domains: [
      domain(fixture.common_domain_id),
      domain(fixture.frontend_domain_id, [
        { kind: 'depends_on', target_id: fixture.common_domain_id },
        { kind: 'coordinates_with', target_id: fixture.backend_domain_id },
      ]),
      domain(fixture.backend_domain_id, [{ kind: 'depends_on', target_id: fixture.common_domain_id }]),
    ],
  };
  await write(governance.root, 'docs/project-lifecycle/project-map.json', `${JSON.stringify(map, null, 2)}\n`);
  const governanceRevision = await commitAll(governance.root, 'add governance map');
  return { backend, frontend, governance, governanceRevision, map };
};

const storages = (state) => new Map([
  ['backend-repository', state.backend.storage],
  ['frontend-repository', state.frontend.storage],
  ['governance-repository', state.governance.storage],
]);
const knowledgeDiff = (baseline, id, deliveryId, domainId, factId) => ({
  schema_version: 1,
  diff_id: id,
  owner_delivery_id: deliveryId,
  knowledge_baseline: baseline,
  operations: [{ kind: 'ADD', fact_id: factId, owner_domain_id: domainId, evidence_refs: [`test:${id}`] }],
  domain_changes: [],
  entry_points: [`repo:${domainId}`],
  evidence_refs: [`test:${id}`],
  remaining_limits: [],
  outcome: 'CHANGE',
});
const semanticFact = (factId, ownerDomainId, valueHash) => ({
  factId,
  ownerDomainId,
  valueHash,
  evidenceRevision: 'evidence:1',
  evidenceRefs: [`test:${factId}`],
  changeKind: 'VALUE',
});
const reconcile = (baseline, diff, fact, latestAcceptedSet = createKnowledgeSet({}), shardCandidate) => (
  reconcileKnowledgeCandidate({
    startingBaseline: baseline,
    latestBaseline: baseline,
    knowledgeDiff: diff,
    candidateSet: knowledgeSetFromDiff(diff, { facts: [fact] }),
    latestAcceptedSet,
    candidateRef: `candidate:${diff.diff_id}`,
    latestAcceptedRef: 'accepted:governance-main',
    createdAt: '2026-08-09T00:00:00.000Z',
    localShardCandidate: shardCandidate,
  })
);
const candidateCommit = async (context, repositoryState, branch, path, content) => {
  const candidate = await repositoryState.storage.createCandidate({
    baseRevision: repositoryState.revision,
    branchName: branch,
  });
  assert.equal(candidate.ok, true, JSON.stringify(candidate));
  context.after(() => rm(candidate.value.candidateRoot, { recursive: true, force: true }));
  await write(candidate.value.candidateRoot, path, content);
  const committed = await repositoryState.storage.commitCandidate({
    candidateRoot: candidate.value.candidateRoot,
    paths: [path],
    message: `update ${path}`,
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  return committed.value;
};

test('pins three repositories and prepares one reviewed governance PR without copying shard fact bodies', async (context) => {
  const state = await setup(context);
  assert.deepEqual(fixture.prd.delivery_units, ['wiki-interface-unit', 'wiki-service-unit']);
  assert.equal(fixture.prd.shared_contract_revision, 'contract-revision-2');
  const pinned = await pinTaskBaseline({
    governanceStorage: state.governance.storage,
    acceptedGovernanceRef: 'refs/heads/main',
    localRepositoryId: 'frontend-repository',
    groundedDependencyIds: [fixture.common_domain_id, fixture.backend_domain_id],
    shardStorages: storages(state),
  });
  assert.equal(pinned.ok, true, JSON.stringify(pinned));
  assert.equal(pinned.value.knowledge_baseline.completeness, 'COMPLETE');
  assert.deepEqual(pinned.value.knowledge_baseline.shardRevisions.map(({ repositoryId }) => repositoryId), [
    'backend-repository', 'frontend-repository', 'governance-repository',
  ]);

  const uiCandidate = await candidateCommit(
    context,
    state.frontend,
    'codex/wiki-interface-unit',
    'docs/project-lifecycle/knowledge/wiki-interface-en.md',
    `# Wiki interface\n\n${fixture.bodies.frontend}\n\nAccepted layout refinement.\n`,
  );
  const serviceCandidate = await candidateCommit(
    context,
    state.backend,
    'codex/wiki-service-unit',
    'docs/project-lifecycle/knowledge/wiki-service-en.md',
    `# Wiki service\n\n${fixture.bodies.backend}\n\nAccepted query refinement.\n`,
  );
  const uiDiff = knowledgeDiff(
    state.governanceRevision,
    'wiki-interface-diff',
    fixture.prd.delivery_units[0],
    fixture.frontend_domain_id,
    fixture.frontend_fact_id,
  );
  const serviceDiff = knowledgeDiff(
    state.governanceRevision,
    'wiki-service-diff',
    fixture.prd.delivery_units[1],
    fixture.backend_domain_id,
    fixture.backend_fact_id,
  );
  const uiReconciled = reconcile(
    pinned.value.knowledge_baseline,
    uiDiff,
    semanticFact(fixture.frontend_fact_id, fixture.frontend_domain_id, `sha256:${'1'.repeat(64)}`),
    createKnowledgeSet({}),
    {
      repositoryId: 'frontend-repository',
      expectedPreviousRevision: state.frontend.revision,
      candidateRevision: uiCandidate.revision,
    },
  );
  const serviceReconciled = reconcile(
    pinned.value.knowledge_baseline,
    serviceDiff,
    semanticFact(fixture.backend_fact_id, fixture.backend_domain_id, `sha256:${'2'.repeat(64)}`),
    createKnowledgeSet({}),
    {
      repositoryId: 'backend-repository',
      expectedPreviousRevision: state.backend.revision,
      candidateRevision: serviceCandidate.revision,
    },
  );
  assert.equal(uiReconciled.value.status, 'replay_ready');
  assert.equal(serviceReconciled.value.status, 'replay_ready');
  assert.equal((await state.frontend.storage.compareAndSwap({
    acceptedRef: 'refs/heads/main', expectedRevision: state.frontend.revision, candidateRevision: uiCandidate.revision,
  })).ok, true);
  assert.equal((await state.backend.storage.compareAndSwap({
    acceptedRef: 'refs/heads/main', expectedRevision: state.backend.revision, candidateRevision: serviceCandidate.revision,
  })).ok, true);

  const candidateMap = structuredClone(state.map);
  candidateMap.knowledge_baseline = 'baseline:phase4-candidate';
  candidateMap.repositories.find(({ id }) => id === 'frontend-repository').accepted_revision = uiCandidate.revision;
  candidateMap.repositories.find(({ id }) => id === 'backend-repository').accepted_revision = serviceCandidate.revision;
  const indexes = generateIndexes({ map: candidateMap });
  assert.equal(indexes.ok, true, JSON.stringify(indexes));
  for (const source of [indexes.value.en, indexes.value['zh-CN']]) {
    for (const body of Object.values(fixture.bodies)) assert.doesNotMatch(source, new RegExp(body, 'u'));
  }

  const githubHost = ['github', 'com'].join('.');
  const governanceCandidateRevision = 'e'.repeat(40);
  const frontendBodyRoot = join(state.frontend.root, '.project-lifecycle/runtime/publication');
  const backendBodyRoot = join(state.backend.root, '.project-lifecycle/runtime/publication');
  const governanceBodyRoot = join(state.governance.root, '.project-lifecycle/runtime/publication');
  await Promise.all([frontendBodyRoot, backendBodyRoot, governanceBodyRoot].map((path) => mkdir(path, { recursive: true })));
  const governanceBodyFile = join(governanceBodyRoot, 'wiki-governance-pr.md');
  await writeFile(governanceBodyFile, 'Reviewed Wiki governance candidate.\n');
  const runner = createFakeProcessRunner([
    { ok: true, code: 0, stdout: `https://${githubHost}/example/wiki-frontend.git\n`, stderr: '' },
    { ok: true, code: 0, stdout: `${uiCandidate.revision}\n`, stderr: '' },
    { ok: true, code: 0, stdout: '', stderr: '' },
    { ok: true, code: 0, stdout: `https://${githubHost}/example/wiki-backend.git\n`, stderr: '' },
    { ok: true, code: 0, stdout: `${serviceCandidate.revision}\n`, stderr: '' },
    { ok: true, code: 0, stdout: '', stderr: '' },
    { ok: true, code: 0, stdout: `https://${githubHost}/example/wiki-governance.git\n`, stderr: '' },
    { ok: true, code: 0, stdout: `${governanceCandidateRevision}\n`, stderr: '' },
    { ok: true, code: 0, stdout: '', stderr: '' },
    { ok: true, code: 0, stdout: `https://${githubHost}/example/wiki-governance/pull/9\n`, stderr: '' },
    { ok: true, code: 0, stdout: `${JSON.stringify({ headRefOid: governanceCandidateRevision })}\n`, stderr: '' },
  ]);
  const frontendRemote = createGitHubAdapter({ owner: 'example', repo: 'wiki-frontend', acceptedBranch: 'main', runner, repositoryRoot: state.frontend.root, bodyRoot: frontendBodyRoot });
  const backendRemote = createGitHubAdapter({ owner: 'example', repo: 'wiki-backend', acceptedBranch: 'main', runner, repositoryRoot: state.backend.root, bodyRoot: backendBodyRoot });
  const governanceRemote = createGitHubAdapter({ owner: 'example', repo: 'wiki-governance', acceptedBranch: 'main', runner, repositoryRoot: state.governance.root, bodyRoot: governanceBodyRoot });
  const leaseEvents = [];
  const result = await publishReviewedCandidate({
    adapter: governanceRemote,
    lease: {
      acquire: async () => { leaseEvents.push('acquire'); return { ok: true, value: null, errors: [] }; },
      renew: async () => { leaseEvents.push('renew'); return { ok: true, value: null, errors: [] }; },
      release: async () => { leaseEvents.push('release'); return { ok: true, value: null, errors: [] }; },
    },
    ownerId: 'phase-four-publication',
    expectedGovernanceRevision: state.governanceRevision,
    candidateBranch: 'codex/wiki-governance-pin',
    validationResult: { ok: true, evidence_ref: 'validation:phase-four', candidate_revision: governanceCandidateRevision },
    humanGate: { required: true, resolved: true, approval_ref: 'approval:phase-four', candidate_revision: governanceCandidateRevision },
    refreshAcceptedRevision: async () => state.governanceRevision,
    reconcileCandidate: async () => ({
      ok: true,
      value: { atomic_set: { expected_governance_revision: state.governanceRevision, candidate_revision: governanceCandidateRevision } },
      errors: [],
    }),
    validateAtomicSet: async () => ({ ok: true, value: null, errors: [] }),
    shardCandidate: { candidates: [
      {
        branch: 'codex/wiki-interface-unit',
        candidate_revision: uiCandidate.revision,
        adapter: frontendRemote,
      },
      {
        branch: 'codex/wiki-service-unit',
        candidate_revision: serviceCandidate.revision,
        adapter: backendRemote,
      },
    ] },
    title: 'Wiki multi-repository candidate',
    bodyFile: governanceBodyFile,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.current_truth_changed, false);
  assert.deepEqual(leaseEvents, ['acquire', 'renew', 'renew', 'renew', 'release']);
  assert.deepEqual(runner.calls.filter(({ args }) => args[0] === 'push').map(({ args }) => args[2]), [
    `${uiCandidate.revision}:refs/heads/codex/wiki-interface-unit`,
    `${serviceCandidate.revision}:refs/heads/codex/wiki-service-unit`,
    `${governanceCandidateRevision}:refs/heads/codex/wiki-governance-pin`,
  ]);
  assert.equal(runner.calls.some(({ args }) => args.includes('merge') || args.at(-1) === 'main'), false);
});

test('stops shared-contract conflicts, incomplete shards, stale pointers, and ambiguous identity', async (context) => {
  const state = await setup(context);
  const baseline = (await pinTaskBaseline({
    governanceStorage: state.governance.storage,
    acceptedGovernanceRef: 'refs/heads/main',
    localRepositoryId: 'frontend-repository',
    groundedDependencyIds: [fixture.common_domain_id],
    shardStorages: storages(state),
  })).value.knowledge_baseline;
  const contractDiff = {
    ...knowledgeDiff(state.governanceRevision, 'shared-contract-diff', fixture.prd.id, fixture.common_domain_id, 'contract-outcome'),
    operations: [],
    domain_changes: [{
      domain_id: fixture.common_domain_id,
      change: 'Advance the shared Wiki contract.',
      evidence_refs: ['test:shared-contract'],
    }],
  };
  const conflict = reconcileKnowledgeCandidate({
    startingBaseline: baseline,
    latestBaseline: baseline,
    knowledgeDiff: contractDiff,
    candidateSet: createKnowledgeSet({ constraints: [fixture.shared_constraint_id] }),
    latestAcceptedSet: createKnowledgeSet({ constraints: [fixture.shared_constraint_id] }),
    candidateRef: 'candidate:shared-contract',
    latestAcceptedRef: 'accepted:shared-contract',
    createdAt: '2026-08-09T00:00:00.000Z',
  });
  assert.equal(conflict.value.status, 'conflict');
  assert.equal(conflict.value.atomic_set, null);

  const incomplete = await pinTaskBaseline({
    governanceStorage: state.governance.storage,
    acceptedGovernanceRef: 'refs/heads/main',
    localRepositoryId: 'frontend-repository',
    groundedDependencyIds: [fixture.backend_domain_id],
    shardStorages: new Map([['frontend-repository', state.frontend.storage]]),
  });
  assert.equal(incomplete.value.status, 'needs_evidence');
  assert.equal(incomplete.value.knowledge_baseline.completeness, 'LOCAL_ONLY');

  const stale = await resolveGovernanceRoot({
    repositoryRoot: state.frontend.root,
    resolvePortableLocator: async () => ({ project_map: state.map, governance_locator: 'github:example/wiki-governance' }),
  });
  assert.equal(stale.value.status, 'rebind_required');
  assert.equal(stale.value.shared_publication_allowed, false);
  const splitMap = structuredClone(state.map);
  splitMap.identity_lineage = [{
    predecessor_project_id: fixture.legacy_project_id,
    relationship: 'SPLIT',
    successor_project_ids: [fixture.project_id, 'wiki-suite-alt'],
    effective_baseline: 'baseline:phase4-start',
    approval_ref: 'approval:identity-split',
  }];
  const ambiguous = await resolveGovernanceRoot({
    repositoryRoot: state.frontend.root,
    resolvePortableLocator: async () => ({ project_map: splitMap, governance_locator: 'github:example/wiki-governance' }),
  });
  assert.equal(ambiguous.value.status, 'needs_user');

  const unavailable = await resolveGovernanceRoot({
    repositoryRoot: state.frontend.root,
    resolvePortableLocator: async () => null,
  });
  assert.equal(unavailable.value.status, 'unavailable');
  assert.equal(unavailable.value.local_read_allowed, true);
  assert.equal(unavailable.value.shared_publication_allowed, false);
});

test('expired leases, concurrent accepted advances, and failed shard pushes publish no current truth', async (context) => {
  const state = await setup(context);
  let now = Date.parse('2026-08-09T00:00:00.000Z');
  const lease = createGovernanceWriteLease({
    root: state.frontend.root,
    clock: () => now,
    ttlMs: 1_000,
    verifyGovernanceRevision: async () => false,
  });
  assert.equal((await lease.acquire({ ownerId: 'first-owner', expectedGovernanceRevision: state.governanceRevision })).ok, true);
  now += 2_000;
  const expired = await lease.acquire({ ownerId: 'second-owner', expectedGovernanceRevision: state.governanceRevision });
  assert.equal(expired.errors[0].code, 'GOVERNANCE_LEASE_RECOVERY_UNVERIFIED');
  assert.equal((await lease.release({ ownerId: 'first-owner' })).ok, true);

  const events = [];
  const publicationLease = {
    acquire: async () => { events.push('lease:acquire'); return { ok: true, value: null, errors: [] }; },
    renew: async () => { events.push('lease:renew'); return { ok: true, value: null, errors: [] }; },
    release: async () => { events.push('lease:release'); return { ok: true, value: null, errors: [] }; },
  };
  const candidateRevision = 'c'.repeat(40);
  const governanceAdapter = {
    pushCandidate: async () => { events.push('push:governance'); return { ok: true, value: { revision: candidateRevision }, errors: [] }; },
    createDraftPullRequest: async () => { events.push('pr:create'); return { ok: true, value: { number: 1 }, errors: [] }; },
  };
  const baseInput = {
    adapter: governanceAdapter,
    lease: publicationLease,
    ownerId: 'publication-owner',
    expectedGovernanceRevision: state.governanceRevision,
    candidateBranch: 'codex/governance-candidate',
    validationResult: { ok: true, evidence_ref: 'validation:phase-four', candidate_revision: candidateRevision },
    humanGate: { required: true, resolved: true, approval_ref: 'approval:phase-four', candidate_revision: candidateRevision },
    reconcileCandidate: async () => ({
      ok: true,
      value: { atomic_set: { expected_governance_revision: state.governanceRevision, candidate_revision: candidateRevision } },
      errors: [],
    }),
    validateAtomicSet: async () => ({ ok: true, value: null, errors: [] }),
    title: 'Candidate',
    bodyFile: '/private/tmp/candidate.md',
  };
  const stale = await publishReviewedCandidate({
    ...baseInput,
    refreshAcceptedRevision: async () => 'f'.repeat(40),
  });
  assert.equal(stale.errors[0].code, 'PUBLICATION_BASELINE_STALE');
  assert.deepEqual(events, ['lease:acquire', 'lease:release']);

  events.length = 0;
  const failedShard = await publishReviewedCandidate({
    ...baseInput,
    refreshAcceptedRevision: async () => state.governanceRevision,
    shardCandidate: {
      branch: 'codex/backend-delayed',
      candidate_revision: 'd'.repeat(40),
      adapter: { pushCandidate: async () => { events.push('push:shard'); return { ok: false, errors: [] }; } },
    },
  });
  assert.equal(failedShard.errors[0].code, 'PUBLICATION_SHARD_INCOMPLETE');
  assert.deepEqual(events, ['lease:acquire', 'lease:renew', 'push:shard', 'lease:release']);
  assert.equal(events.includes('push:governance'), false);
  assert.equal(events.includes('pr:create'), false);
});
