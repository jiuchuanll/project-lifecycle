import { isAbsolute } from 'node:path';

import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;
const BRANCH = /^codex\/[a-z0-9](?:[a-z0-9._/-]{0,199})$/u;
const ACCEPTED = /^[a-z0-9](?:[a-z0-9._/-]{0,199})$/u;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const validBranch = (value) => BRANCH.test(value ?? '')
  && !value.includes('..') && !value.endsWith('/') && !value.includes('//');
const validBodyFile = (value) => typeof value === 'string' && isAbsolute(value)
  && value.length <= 500 && !/[\p{Cc}\p{Cf}\\]/u.test(value)
  && !value.split('/').includes('..');
const validTitle = (value) => typeof value === 'string' && value.trim().length > 0
  && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value);

export function createGitHubAdapter({ owner, repo, acceptedBranch, runner } = {}) {
  if (!NAME.test(owner ?? '') || !NAME.test(repo ?? '') || repo.includes('..')
    || !ACCEPTED.test(acceptedBranch ?? '') || acceptedBranch.includes('..')
    || typeof runner?.runProcess !== 'function') {
    throw new TypeError('GitHub adapter requires safe repository identity, accepted branch, and process runner.');
  }
  const repository = `${owner}/${repo}`;
  const run = async (command, args) => runner.runProcess(command, args);
  const processFailure = (code, path) => failure(code, path, 'GitHub command did not complete successfully.');

  return Object.freeze({
    pushCandidate: async (branch) => {
      if (!validBranch(branch) || branch === acceptedBranch) {
        return failure('GITHUB_BRANCH_INVALID', '/branch', 'Candidate branch must use a distinct safe codex namespace.');
      }
      const result = await run('git', ['push', 'origin', branch]);
      return result.ok
        ? ok({ branch })
        : processFailure('GITHUB_PUSH_FAILED', '/branch');
    },
    createDraftPullRequest: async ({ head, title, bodyFile } = {}) => {
      if (!validBranch(head) || head === acceptedBranch || !validTitle(title) || !validBodyFile(bodyFile)) {
        return failure('GITHUB_PR_INPUT_INVALID', '/pull_request', 'Draft PR input must be safe and bounded.');
      }
      const result = await run('gh', [
        'pr', 'create', '--repo', repository, '--base', acceptedBranch, '--head', head,
        '--draft', '--title', title, '--body-file', bodyFile,
      ]);
      if (!result.ok) return processFailure('GITHUB_PR_CREATE_FAILED', '/pull_request');
      const url = result.stdout.trim();
      const match = new RegExp(`^https://github\\.com/${owner}/${repo}/pull/([1-9][0-9]*)$`, 'u').exec(url);
      if (!match || !isSafeReference(url)) return failure('GITHUB_OUTPUT_INVALID', '/pull_request', 'GitHub returned an invalid pull request reference.');
      return ok({ number: Number(match[1]), url });
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
