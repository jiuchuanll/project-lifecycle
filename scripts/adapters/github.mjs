import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;
const BRANCH = /^codex\/[a-z0-9](?:[a-z0-9._/-]{0,199})$/u;
const ACCEPTED = /^[a-z0-9](?:[a-z0-9._/-]{0,199})$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_048_576;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const validBranch = (value) => BRANCH.test(value ?? '')
  && !value.includes('..') && !value.endsWith('/') && !value.includes('//');
const validBodyFile = (value) => typeof value === 'string' && isAbsolute(value)
  && value.length <= 500 && !/[\p{Cc}\p{Cf}\\]/u.test(value)
  && !value.split('/').includes('..');
const validTitle = (value) => typeof value === 'string' && value.trim().length > 0
  && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value);

const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const regularRoot = async (path) => {
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Unsafe GitHub root.');
  return realpath(path);
};

const approvedBodyFile = async (bodyRoot, bodyFile) => {
  const rootReal = await regularRoot(bodyRoot);
  const state = await lstat(bodyFile);
  if (!state.isFile() || state.isSymbolicLink() || state.size > MAX_BODY_BYTES) throw new Error('Unsafe PR body.');
  const physical = await realpath(bodyFile);
  if (!inside(rootReal, physical)) throw new Error('PR body escapes its approved root.');
  return physical;
};

export function createGitHubAdapter({ owner, repo, acceptedBranch, runner, repositoryRoot, bodyRoot } = {}) {
  if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '') || repo.includes('..')
    || !ACCEPTED.test(acceptedBranch ?? '') || acceptedBranch.includes('..')
    || typeof runner?.runProcess !== 'function'
    || typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot)
    || typeof bodyRoot !== 'string' || !isAbsolute(bodyRoot)) {
    throw new TypeError('GitHub adapter requires safe repository identity, fixed roots, and process runner.');
  }
  const repository = `${owner}/${repo}`;
  const run = async (command, args) => runner.runProcess(command, args, {
    cwd: repositoryRoot,
    timeoutMs: PROCESS_TIMEOUT_MS,
  });
  const processFailure = (code, path) => failure(code, path, 'GitHub command did not complete successfully.');

  return Object.freeze({
    pushCandidate: async (branch) => {
      if (!validBranch(branch) || branch === acceptedBranch) {
        return failure('GITHUB_BRANCH_INVALID', '/branch', 'Candidate branch must use a distinct safe codex namespace.');
      }
      try { await regularRoot(repositoryRoot); } catch {
        return failure('GITHUB_REPOSITORY_INVALID', '/repository', 'Configured GitHub repository root is unsafe.');
      }
      const remote = await run('git', ['remote', 'get-url', '--push', '--all', 'origin']);
      const expectedRemotes = new Set([
        `https://github.com/${repository}.git`,
        `https://github.com/${repository}`,
        `git@github.com:${repository}.git`,
        `ssh://git@github.com/${repository}.git`,
      ]);
      const pushUrls = remote.stdout.split(/\r?\n/u).filter(Boolean);
      if (!remote.ok || pushUrls.length === 0 || pushUrls.some((url) => !expectedRemotes.has(url))) {
        return failure('GITHUB_REPOSITORY_MISMATCH', '/repository', 'Git origin does not match the configured GitHub repository.');
      }
      const resolved = await run('git', ['rev-parse', '--verify', `${branch}^{commit}`]);
      const revision = resolved.stdout.trim();
      if (!resolved.ok || !REVISION.test(revision)) return processFailure('GITHUB_PUSH_FAILED', '/branch');
      const result = await run('git', ['push', 'origin', `${revision}:refs/heads/${branch}`]);
      return result.ok ? ok({ branch, revision }) : processFailure('GITHUB_PUSH_FAILED', '/branch');
    },
    createDraftPullRequest: async ({ head, expectedRevision, title, bodyFile } = {}) => {
      if (!validBranch(head) || head === acceptedBranch || !REVISION.test(expectedRevision ?? '')
        || !validTitle(title) || !validBodyFile(bodyFile)) {
        return failure('GITHUB_PR_INPUT_INVALID', '/pull_request', 'Draft PR input must be safe and bounded.');
      }
      let approvedBody;
      try { approvedBody = await approvedBodyFile(bodyRoot, bodyFile); } catch {
        return failure('GITHUB_PR_INPUT_INVALID', '/pull_request', 'Draft PR body must be a bounded regular file under its approved root.');
      }
      const result = await run('gh', [
        'pr', 'create', '--repo', repository, '--base', acceptedBranch, '--head', head,
        '--draft', '--title', title, '--body-file', approvedBody,
      ]);
      if (!result.ok) return processFailure('GITHUB_PR_CREATE_FAILED', '/pull_request');
      const url = result.stdout.trim();
      const match = new RegExp(`^https://github\\.com/${owner}/${repo}/pull/([1-9][0-9]*)$`, 'u').exec(url);
      if (!match || !isSafeReference(url)) return failure('GITHUB_OUTPUT_INVALID', '/pull_request', 'GitHub returned an invalid pull request reference.');
      const number = Number(match[1]);
      const headResult = await run('gh', [
        'pr', 'view', String(number), '--repo', repository, '--json', 'headRefOid',
      ]);
      if (!headResult.ok) return processFailure('GITHUB_PR_VIEW_FAILED', '/pull_request');
      try {
        const head = JSON.parse(headResult.stdout);
        if (head?.headRefOid !== expectedRevision) throw new Error('Unexpected pull request head.');
      } catch {
        return failure('GITHUB_PR_HEAD_MISMATCH', '/pull_request', 'Draft pull request head does not match the reviewed revision.');
      }
      return ok({ number, url, head_revision: expectedRevision });
    },
    viewPullRequest: async (number) => {
      if (!Number.isInteger(number) || number < 1) return failure('GITHUB_PR_INPUT_INVALID', '/number', 'Pull request number must be positive.');
      const result = await run('gh', [
        'pr', 'view', String(number), '--repo', repository,
        '--json', 'state,mergeStateStatus,reviewDecision,statusCheckRollup',
      ]);
      if (!result.ok) return processFailure('GITHUB_PR_VIEW_FAILED', '/number');
      try {
        const value = JSON.parse(result.stdout);
        if (value === null || typeof value !== 'object' || Array.isArray(value)
          || !['state', 'mergeStateStatus', 'reviewDecision', 'statusCheckRollup'].every((field) => Object.hasOwn(value, field))) {
          throw new Error('Invalid GitHub status.');
        }
        return ok({ number, ...value });
      } catch {
        return failure('GITHUB_OUTPUT_INVALID', '/pull_request', 'GitHub returned invalid status metadata.');
      }
    },
    mergePullRequest: async () => failure(
      'GITHUB_MERGE_FORBIDDEN',
      '/pull_request',
      'The publication adapter cannot merge or write the accepted line.',
    ),
  });
}
