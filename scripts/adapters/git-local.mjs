import { lstat, mkdtemp, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { createError } from '../lib/errors.mjs';
import { isSafeLocator } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { createProcessRunner } from './process-runner.mjs';
import { createVersionedStorage } from './versioned-storage.mjs';

const HASH = /^[0-9a-f]{40,64}$/u;
const BRANCH = /^codex\/[a-z0-9][a-z0-9._/-]*$/u;
const FULL_REF = /^refs\/(heads|tags)\/[a-z0-9][a-z0-9._/-]*$/u;
const PROCESS_TIMEOUT_MS = 30_000;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const inside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};
const validRevisionRef = (value) => value === 'HEAD' || HASH.test(value ?? '') || FULL_REF.test(value ?? '');
const normalizedLines = (value) => value.split(/\r?\n/u).filter(Boolean).sort();
const validMessage = (value) => typeof value === 'string' && value.trim().length > 0
  && value.length <= 500 && !/[\p{Cc}\p{Cf}]/u.test(value);

export const createGitLocalStorage = ({ repositoryRoot, runner = createProcessRunner() } = {}) => {
  const candidates = new Map();
  const runProcess = runner?.runProcess;
  if (typeof runProcess !== 'function') throw new TypeError('Git adapter requires a process runner.');

  const rootPromise = (async () => {
    if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot)) return null;
    try {
      const stats = await lstat(repositoryRoot);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
      return await realpath(repositoryRoot);
    } catch {
      return null;
    }
  })();
  const git = async (args, cwd) => runProcess('git', args, { cwd, timeoutMs: PROCESS_TIMEOUT_MS });
  const rootOrFailure = async () => {
    const root = await rootPromise;
    return root ? ok(root) : failure('GIT_ROOT_INVALID', '/repositoryRoot', 'Repository root must be one absolute regular directory.');
  };
  const resolveAt = async (root, ref) => {
    if (!validRevisionRef(ref)) return failure('GIT_REVISION_INVALID', '/ref', 'Revision reference is not portable.');
    const result = await git(['rev-parse', '--verify', `${ref}^{commit}`], root);
    const revision = result.stdout.trim();
    return result.ok && HASH.test(revision)
      ? ok(revision)
      : failure('GIT_REVISION_MISSING', '/ref', 'Revision could not be resolved.');
  };
  const validatePath = (value, { rootAllowed = false } = {}) => {
    if (rootAllowed && value === '.') return ok('.');
    return isSafeLocator(value) && value !== '.'
      ? ok(value)
      : failure('GIT_PATH_INVALID', '/relativePath', 'Git paths must be canonical repository-relative locators.');
  };
  const rejectTreeSymlink = async (root, revision, path) => {
    const tree = await git(['ls-tree', revision, '--', path], root);
    if (!tree.ok || tree.stdout.trim().length === 0) return failure('GIT_PATH_MISSING', '/relativePath', 'Path does not exist at the pinned revision.');
    return tree.stdout.startsWith('120000 ')
      ? failure('GIT_SYMLINK_FORBIDDEN', '/relativePath', 'Git symlink entries cannot be read as governed files.')
      : ok(null);
  };
  const validateCandidateFile = async (candidateRoot, path) => {
    const target = join(candidateRoot, path);
    if (!inside(candidateRoot, target)) return failure('GIT_PATH_INVALID', '/paths', 'Commit paths must remain inside the candidate.');
    let cursor = candidateRoot;
    for (const segment of path.split('/')) {
      cursor = join(cursor, segment);
      try {
        const stats = await lstat(cursor);
        if (stats.isSymbolicLink()) return failure('GIT_SYMLINK_FORBIDDEN', '/paths', 'Candidate commit paths cannot traverse symlinks.');
        if (cursor === target && !stats.isFile()) return failure('GIT_PATH_INVALID', '/paths', 'Candidate commit targets must be regular files.');
      } catch {
        return failure('GIT_PATH_MISSING', '/paths', 'Candidate commit target does not exist.');
      }
    }
    return ok(target);
  };

  return createVersionedStorage({
    resolveRevision: async (ref) => {
      const root = await rootOrFailure();
      return root.ok ? resolveAt(root.value, ref) : root;
    },
    readAtRevision: async (revision, relativePath) => {
      const root = await rootOrFailure();
      if (!root.ok) return root;
      const resolved = await resolveAt(root.value, revision);
      if (!resolved.ok) return resolved;
      const path = validatePath(relativePath);
      if (!path.ok) return path;
      const symlink = await rejectTreeSymlink(root.value, resolved.value, path.value);
      if (!symlink.ok) return symlink;
      const result = await git(['show', `${resolved.value}:${path.value}`], root.value);
      return result.ok
        ? ok({ revision: resolved.value, path: path.value, content: result.stdout })
        : failure('GIT_READ_FAILED', '/relativePath', 'Pinned Git content could not be read.');
    },
    listAtRevision: async (revision, relativeRoot) => {
      const root = await rootOrFailure();
      if (!root.ok) return root;
      const resolved = await resolveAt(root.value, revision);
      if (!resolved.ok) return resolved;
      const path = validatePath(relativeRoot, { rootAllowed: true });
      if (!path.ok) return path;
      const args = ['ls-tree', '-r', '--name-only', resolved.value];
      if (path.value !== '.') args.push('--', path.value);
      const result = await git(args, root.value);
      return result.ok
        ? ok({ revision: resolved.value, root: path.value, paths: normalizedLines(result.stdout) })
        : failure('GIT_LIST_FAILED', '/relativeRoot', 'Pinned Git tree could not be listed.');
    },
    createCandidate: async ({ baseRevision, branchName } = {}) => {
      const root = await rootOrFailure();
      if (!root.ok) return root;
      if (!BRANCH.test(branchName ?? '') || branchName.includes('..') || branchName.endsWith('/')) {
        return failure('GIT_BRANCH_INVALID', '/branchName', 'Candidate branches require the codex/ portable namespace.');
      }
      const base = await resolveAt(root.value, baseRevision);
      if (!base.ok) return base;
      const status = await git(['status', '--porcelain'], root.value);
      if (!status.ok || status.stdout.length > 0) return failure('GIT_WORKTREE_DIRTY', '/repositoryRoot', 'Candidate creation requires a clean source worktree.');
      const candidateRoot = await mkdtemp(join(dirname(root.value), '.project-lifecycle-candidate-'));
      const added = await git(['worktree', 'add', '-b', branchName, candidateRoot, base.value], root.value);
      if (!added.ok) return failure('GIT_CANDIDATE_CREATE_FAILED', '/branchName', 'Isolated candidate worktree could not be created.');
      const canonical = await realpath(candidateRoot);
      candidates.set(canonical, { branchName, baseRevision: base.value });
      return ok({ candidateRoot: canonical, branchName, baseRevision: base.value });
    },
    commitCandidate: async ({ candidateRoot, paths, message } = {}) => {
      let canonical;
      try { canonical = await realpath(candidateRoot); } catch { canonical = null; }
      if (!canonical || !candidates.has(canonical)) return failure('GIT_CANDIDATE_INVALID', '/candidateRoot', 'Candidate must be created by this adapter instance.');
      if (!Array.isArray(paths) || paths.length === 0 || new Set(paths).size !== paths.length
        || paths.some((path) => !isSafeLocator(path) || path === '.') || !validMessage(message)) {
        return failure('GIT_COMMIT_INPUT_INVALID', '/paths', 'Commit requires explicit unique files and a bounded message.');
      }
      const preStaged = await git(['diff', '--cached', '--name-only'], canonical);
      if (!preStaged.ok || normalizedLines(preStaged.stdout).length > 0) {
        return failure('GIT_STAGED_SCOPE_INVALID', '/paths', 'Candidate has staged files outside this commit request.');
      }
      for (const path of paths) {
        const safe = await validateCandidateFile(canonical, path);
        if (!safe.ok) return safe;
      }
      const ordered = [...paths].sort();
      const staged = await git(['add', '--', ...ordered], canonical);
      if (!staged.ok) return failure('GIT_STAGE_FAILED', '/paths', 'Explicit candidate files could not be staged.');
      const stagedNames = await git(['diff', '--cached', '--name-only'], canonical);
      if (!stagedNames.ok || !Object.is(normalizedLines(stagedNames.stdout).join('\0'), ordered.join('\0'))) {
        return failure('GIT_STAGED_SCOPE_INVALID', '/paths', 'Staged files do not exactly match the explicit commit set.');
      }
      const committed = await git(['commit', '-m', message], canonical);
      if (!committed.ok) return failure('GIT_COMMIT_FAILED', '/paths', 'Candidate commit could not be created.');
      const revision = await resolveAt(canonical, 'HEAD');
      return revision.ok ? ok({ candidateRoot: canonical, revision: revision.value, paths: ordered }) : revision;
    },
    compareAndSwap: async ({ acceptedRef, expectedRevision, candidateRevision } = {}) => {
      const root = await rootOrFailure();
      if (!root.ok) return root;
      if (!FULL_REF.test(acceptedRef ?? '') || !acceptedRef.startsWith('refs/heads/')) {
        return failure('GIT_REF_INVALID', '/acceptedRef', 'Accepted ref must be one full branch reference.');
      }
      const expected = await resolveAt(root.value, expectedRevision);
      const candidate = await resolveAt(root.value, candidateRevision);
      if (!expected.ok || !candidate.ok) return failure('GIT_REVISION_MISSING', '/revision', 'CAS revisions must resolve in the repository.');
      const current = await resolveAt(root.value, acceptedRef);
      if (!current.ok || current.value !== expected.value) {
        return failure('GIT_COMPARE_AND_SWAP_FAILED', '/acceptedRef', 'Accepted ref advanced beyond the expected revision.');
      }
      const updated = await git(['update-ref', acceptedRef, candidate.value, expected.value], root.value);
      return updated.ok
        ? ok({ acceptedRef, previousRevision: expected.value, revision: candidate.value })
        : failure('GIT_COMPARE_AND_SWAP_FAILED', '/acceptedRef', 'Accepted ref changed before publication.');
    },
  });
};
