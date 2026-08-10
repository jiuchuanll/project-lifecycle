import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { atomicWriteValidated } from '../lib/atomic-write.mjs';
import { fail, ok } from '../lib/result.mjs';
import { assertBoundedRelativePath, resolveInside } from '../lib/safe-path.mjs';

const hash = (content) => createHash('sha256').update(content).digest('hex');
const failure = (code, path, message) => fail([createError(code, path, message)]);
const inside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};
const fileState = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const pathError = (code) => Object.assign(new Error(code), { code });

const lifecyclePaths = async (repositoryRoot, { allowMissing = false } = {}) => {
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot)) throw pathError('LAYOUT_ROOT_INVALID');
  const lexicalRoot = resolve(repositoryRoot);
  const rootState = await lstat(lexicalRoot);
  const physicalRoot = await realpath(lexicalRoot);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw pathError('PATH_SYMLINK_ESCAPE');
  const docsLexical = join(physicalRoot, 'docs');
  const docsState = await lstat(docsLexical);
  const docsRoot = await realpath(docsLexical);
  if (!docsState.isDirectory() || docsState.isSymbolicLink() || !inside(physicalRoot, docsRoot)) {
    throw pathError('PATH_SYMLINK_ESCAPE');
  }
  const lifecycleLexical = join(docsRoot, 'project-lifecycle');
  const lifecycleState = await fileState(lifecycleLexical);
  if (lifecycleState === null && allowMissing) {
    return {
      projectRoot: physicalRoot,
      docsRoot,
      lifecycleRoot: lifecycleLexical,
      exists: false,
    };
  }
  if (lifecycleState === null) throw pathError('LAYOUT_ROOT_INVALID');
  const lifecycleRoot = await realpath(lifecycleLexical);
  if (!lifecycleState.isDirectory() || lifecycleState.isSymbolicLink() || !inside(physicalRoot, lifecycleRoot)) {
    throw pathError('PATH_SYMLINK_ESCAPE');
  }
  return { projectRoot: physicalRoot, docsRoot, lifecycleRoot, exists: true };
};

const snapshotTree = async (lifecycleRoot) => {
  const rootState = await lstat(lifecycleRoot);
  const rootReal = await realpath(lifecycleRoot);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw pathError('PATH_SYMLINK_ESCAPE');
  const entries = [];
  const visit = async (directory, prefix = '') => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const child of children) {
      const absolute = join(directory, child.name);
      const locator = prefix ? `${prefix}/${child.name}` : child.name;
      const state = await lstat(absolute);
      if (state.isDirectory() && !state.isSymbolicLink()) {
        const physical = await realpath(absolute);
        if (!inside(rootReal, physical)) throw pathError('PATH_SYMLINK_ESCAPE');
        entries.push({ locator: `${locator}/`, type: 'directory' });
        await visit(physical, locator);
      } else if (state.isFile()) {
        entries.push({ locator, type: 'file', hash: hash(await readFile(absolute)) });
      } else if (state.isSymbolicLink()) {
        let physical;
        try {
          physical = await realpath(absolute);
        } catch {
          throw pathError('PATH_SYMLINK_ESCAPE');
        }
        if (!inside(rootReal, physical)) throw pathError('PATH_SYMLINK_ESCAPE');
        entries.push({ locator, type: 'symlink', target: await readlink(absolute) });
      } else {
        throw pathError('LAYOUT_ROOT_INVALID');
      }
    }
  };
  await visit(rootReal);
  const fingerprint = hash(JSON.stringify(entries));
  return { fingerprint, entries };
};

export const inspectLifecycleTree = async ({ repositoryRoot } = {}) => {
  try {
    const { lifecycleRoot } = await lifecyclePaths(repositoryRoot);
    return ok(await snapshotTree(lifecycleRoot));
  } catch (error) {
    return failure(
      error?.code ?? 'LAYOUT_ROOT_INVALID',
      '/',
      'The lifecycle tree must be a bounded regular directory.',
    );
  }
};

const entryHash = (entry) => entry.hash ?? (entry.content === undefined ? null : hash(entry.content));

export const diffLayout = ({ current, candidate }) => {
  const currentFiles = new Map((current?.entries ?? [])
    .filter(({ type }) => type === 'file')
    .map((entry) => [entry.locator, entry]));
  const candidateFiles = new Map((candidate?.entries ?? [])
    .filter(({ type }) => type === 'file')
    .map((entry) => [entry.locator, entry]));
  const unchanged = [];
  const pendingWrites = [];
  const pendingDeletes = [];
  for (const [locator, entry] of candidateFiles) {
    const existing = currentFiles.get(locator);
    if (existing && entryHash(existing) === entryHash(entry)) unchanged.push(locator);
    else pendingWrites.push(locator);
  }
  for (const locator of currentFiles.keys()) {
    if (!candidateFiles.has(locator)) pendingDeletes.push(locator);
  }
  pendingWrites.sort(compareCodePoints);
  pendingDeletes.sort(compareCodePoints);
  unchanged.sort(compareCodePoints);
  const moves = [];
  const movedWrites = new Set();
  const movedDeletes = new Set();
  for (const from of pendingDeletes) {
    const sourceHash = entryHash(currentFiles.get(from));
    const to = pendingWrites.find((locator) => (
      !movedWrites.has(locator) && entryHash(candidateFiles.get(locator)) === sourceHash
    ));
    if (to) {
      moves.push({ from, to });
      movedWrites.add(to);
      movedDeletes.add(from);
    }
  }
  return {
    writes: pendingWrites.filter((locator) => !movedWrites.has(locator)),
    moves,
    deletes: pendingDeletes.filter((locator) => !movedDeletes.has(locator)),
    unchanged,
  };
};

const validateInputs = ({
  repositoryRoot,
  candidateFiles,
  candidateDirectories = [],
  deleteLocators,
  validateCandidate,
}) => {
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot)
    || !Array.isArray(candidateFiles) || !Array.isArray(candidateDirectories)
    || !Array.isArray(deleteLocators)
    || typeof validateCandidate !== 'function') {
    return failure('LAYOUT_INPUT_INVALID', '/', 'A bounded repository transaction input is required.');
  }
  const locators = new Set();
  const repositoryIds = new Set();
  try {
    for (const [index, entry] of candidateFiles.entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !(entry.repository_id === null || typeof entry.repository_id === 'string')
        || typeof entry.content !== 'string' || typeof entry.validate !== 'function') {
        return failure('LAYOUT_INPUT_INVALID', `/candidateFiles/${index}`, 'Every candidate file requires repository ownership, content, and validation.');
      }
      assertBoundedRelativePath(entry.locator);
      if (locators.has(entry.locator)) return failure('LAYOUT_INPUT_INVALID', `/candidateFiles/${index}/locator`, 'Candidate locators must be unique.');
      locators.add(entry.locator);
      repositoryIds.add(entry.repository_id ?? '<governance>');
    }
    for (const [index, locator] of deleteLocators.entries()) {
      assertBoundedRelativePath(locator);
      if (locators.has(locator)) return failure('LAYOUT_INPUT_INVALID', `/deleteLocators/${index}`, 'A locator cannot be written and deleted together.');
      if (deleteLocators.indexOf(locator) !== index) return failure('LAYOUT_INPUT_INVALID', `/deleteLocators/${index}`, 'Delete locators must be unique.');
    }
    for (const [index, locator] of candidateDirectories.entries()) {
      assertBoundedRelativePath(locator);
      if (candidateDirectories.indexOf(locator) !== index) return failure('LAYOUT_INPUT_INVALID', `/candidateDirectories/${index}`, 'Candidate directories must be unique.');
      if (locators.has(locator) || deleteLocators.includes(locator)) {
        return failure('LAYOUT_INPUT_INVALID', `/candidateDirectories/${index}`, 'Candidate directories cannot overlap file writes or deletes.');
      }
    }
  } catch {
    return failure('PATH_ESCAPE', '/', 'Every layout locator must be a bounded portable relative path.');
  }
  if (repositoryIds.size > 1) {
    return failure('LAYOUT_INPUT_INVALID', '/candidateFiles', 'One transaction may publish only one repository shard.');
  }
  return ok();
};

const rollbackInitialization = async ({ lifecycleRoot, stagingRoot, candidateFingerprint }) => {
  try {
    if (await fingerprintAt(lifecycleRoot, candidateFingerprint)) {
      if (await fileState(stagingRoot)) return recoveryFailure({ lifecycleRoot, stagingRoot });
      try {
        await rename(lifecycleRoot, stagingRoot);
      } catch {
        if (await fileState(lifecycleRoot) || !await fingerprintAt(stagingRoot, candidateFingerprint)) {
          return recoveryFailure({ lifecycleRoot, stagingRoot });
        }
      }
    } else if (await fileState(lifecycleRoot)) {
      return recoveryFailure({ lifecycleRoot, stagingRoot });
    }
    await cleanupStage(stagingRoot);
    return ok();
  } catch {
    return recoveryFailure({ lifecycleRoot, stagingRoot });
  }
};

const ensureParentDirectories = async (root, locator) => {
  const parent = dirname(locator);
  if (parent === '.') return;
  let current = root;
  for (const segment of parent.split('/')) {
    current = join(current, segment);
    const state = await fileState(current);
    if (state === null) await mkdir(current);
    else if (!state.isDirectory() || state.isSymbolicLink()) throw pathError('PATH_SYMLINK_ESCAPE');
    const physical = await realpath(current);
    if (!inside(root, physical)) throw pathError('PATH_SYMLINK_ESCAPE');
  }
};

const fingerprintAt = async (path, expected) => {
  try {
    return (await snapshotTree(path)).fingerprint === expected;
  } catch {
    return false;
  }
};

const cleanupStage = async (stage) => {
  if (stage && await fileState(stage)) await rm(stage, { recursive: true, force: true });
};

const preserveTreeTimestamps = async (sourceRoot, targetRoot, entries) => {
  const ordinary = entries
    .filter(({ type }) => type === 'file' || type === 'directory')
    .sort((left, right) => right.locator.length - left.locator.length);
  for (const entry of ordinary) {
    const locator = entry.type === 'directory' ? entry.locator.slice(0, -1) : entry.locator;
    const source = await stat(join(sourceRoot, locator), { bigint: true });
    await utimes(
      join(targetRoot, locator),
      Number(source.atimeNs) / 1_000_000_000,
      Number(source.mtimeNs) / 1_000_000_000,
    );
  }
};

const recoveryFailure = async ({ lifecycleRoot, stagingRoot, backupRoot }) => {
  const labels = [];
  for (const [label, path] of [['backup', backupRoot], ['live', lifecycleRoot], ['stage', stagingRoot]]) {
    if (path && await fileState(path).catch(() => true)) labels.push(label);
  }
  return failure(
    'LAYOUT_RESTORE_FAILED',
    '/recovery',
    `Recovery required; preserved artifacts: ${labels.join(', ') || 'unknown'}.`,
  );
};

const restoreOriginal = async ({
  lifecycleRoot,
  stagingRoot,
  backupRoot,
  originalFingerprint,
  candidateFingerprint,
  restoreRename,
}) => {
  try {
    if (await fingerprintAt(lifecycleRoot, originalFingerprint)) {
      await cleanupStage(stagingRoot);
      return ok();
    }
    if (!backupRoot || !await fingerprintAt(backupRoot, originalFingerprint)) {
      return recoveryFailure({ lifecycleRoot, stagingRoot, backupRoot });
    }
    if (await fingerprintAt(lifecycleRoot, candidateFingerprint)) {
      if (await fileState(stagingRoot)) return recoveryFailure({ lifecycleRoot, stagingRoot, backupRoot });
      await rename(lifecycleRoot, stagingRoot);
      if (await fileState(lifecycleRoot) || !await fingerprintAt(stagingRoot, candidateFingerprint)) {
        return recoveryFailure({ lifecycleRoot, stagingRoot, backupRoot });
      }
    } else if (await fileState(lifecycleRoot)) {
      return recoveryFailure({ lifecycleRoot, stagingRoot, backupRoot });
    }
    try {
      await restoreRename(backupRoot, lifecycleRoot);
    } catch {
      if (!await fingerprintAt(lifecycleRoot, originalFingerprint) || await fileState(backupRoot)) {
        return recoveryFailure({ lifecycleRoot, stagingRoot, backupRoot });
      }
    }
    if (!await fingerprintAt(lifecycleRoot, originalFingerprint) || await fileState(backupRoot)) {
      return recoveryFailure({ lifecycleRoot, stagingRoot, backupRoot });
    }
    await cleanupStage(stagingRoot);
    return ok();
  } catch {
    return recoveryFailure({ lifecycleRoot, stagingRoot, backupRoot });
  }
};

export const applyLayoutTransaction = async (input = {}, operations = {}) => {
  const inputValidation = validateInputs(input);
  if (!inputValidation.ok) return inputValidation;
  const write = operations.atomicWriteValidated ?? atomicWriteValidated;
  const publishRename = operations.rename ?? rename;
  const restoreRename = operations.restoreRename ?? rename;
  const copyTree = operations.copy ?? cp;
  const afterPublish = operations.afterPublish ?? (async () => {});
  const inspectTransition = operations.inspectTransition ?? (async () => ({ ok: true }));
  const removeBackup = operations.removeBackup ?? ((path) => rm(path, { recursive: true, force: true }));
  let paths;
  let current;
  try {
    paths = await lifecyclePaths(input.repositoryRoot, { allowMissing: input.initialize === true });
    current = paths.exists
      ? await snapshotTree(paths.lifecycleRoot)
      : { fingerprint: hash(JSON.stringify([])), entries: [] };
  } catch (error) {
    return failure(error?.code ?? 'LAYOUT_ROOT_INVALID', '/', 'The lifecycle tree could not be inspected safely.');
  }
  if (input.expectedFingerprint && input.expectedFingerprint !== current.fingerprint) {
    return failure('LAYOUT_FINGERPRINT_STALE', '/expectedFingerprint', 'The lifecycle tree changed before publication.');
  }
  const currentByLocator = new Map(current.entries.map((entry) => [entry.locator, entry]));
  const candidateDirectories = input.candidateDirectories ?? [];
  const writes = input.candidateFiles
    .filter((entry) => currentByLocator.get(entry.locator)?.hash !== hash(entry.content))
    .sort((left, right) => compareCodePoints(left.locator, right.locator));
  const deletes = input.deleteLocators
    .filter((locator) => currentByLocator.has(locator) || currentByLocator.has(`${locator}/`))
    .sort(compareCodePoints);
  const directoriesToCreate = candidateDirectories
    .filter((locator) => currentByLocator.get(`${locator}/`)?.type !== 'directory')
    .sort(compareCodePoints);
  const unchanged = [
    ...input.candidateFiles.filter((entry) => !writes.includes(entry)).map(({ locator }) => locator),
    ...input.deleteLocators.filter((locator) => !deletes.includes(locator)),
    ...candidateDirectories.filter((locator) => !directoriesToCreate.includes(locator)).map((locator) => `${locator}/`),
  ].sort(compareCodePoints);
  if (writes.length === 0 && deletes.length === 0 && directoriesToCreate.length === 0) {
    try {
      const validation = await input.validateCandidate({ lifecycleRoot: paths.lifecycleRoot });
      if (validation?.ok !== true) return failure('LAYOUT_CANDIDATE_INVALID', '/', 'The complete lifecycle candidate is invalid.');
      return ok({ changed: [], unchanged, cleanup_pending: false, recovery_artifacts: [] });
    } catch {
      return failure('LAYOUT_CANDIDATE_INVALID', '/', 'The complete lifecycle candidate is invalid.');
    }
  }

  let stagingRoot;
  let backupRoot;
  let candidateFingerprint;
  let publicationStarted = false;
  let initializationPublished = false;
  try {
    stagingRoot = await mkdtemp(join(paths.docsRoot, '.project-lifecycle-layout-stage-'));
    if (paths.exists) {
      await copyTree(paths.lifecycleRoot, stagingRoot, {
        recursive: true,
        dereference: false,
      preserveTimestamps: true,
      force: false,
      verbatimSymlinks: true,
      });
      await preserveTreeTimestamps(paths.lifecycleRoot, stagingRoot, current.entries);
    }
    await snapshotTree(stagingRoot);
    for (const locator of directoriesToCreate) {
      await ensureParentDirectories(stagingRoot, `${locator}/placeholder`);
      const target = join(stagingRoot, locator);
      const state = await fileState(target);
      if (state === null) await mkdir(target);
      else if (!state.isDirectory() || state.isSymbolicLink()) throw pathError('PATH_SYMLINK_ESCAPE');
    }
    for (const locator of deletes) {
      const target = await resolveInside(stagingRoot, locator);
      await rm(target, { recursive: true, force: true });
    }
    for (const entry of writes) {
      await ensureParentDirectories(stagingRoot, entry.locator);
      await write({ root: stagingRoot, target: entry.locator, content: entry.content, validate: entry.validate });
    }
    const candidateValidation = await input.validateCandidate({ lifecycleRoot: stagingRoot });
    if (candidateValidation?.ok !== true) {
      await cleanupStage(stagingRoot);
      return failure('LAYOUT_CANDIDATE_INVALID', '/', 'The complete lifecycle candidate is invalid.');
    }
    candidateFingerprint = (await snapshotTree(stagingRoot)).fingerprint;
    const originalIsCurrent = paths.exists
      ? await fingerprintAt(paths.lifecycleRoot, current.fingerprint)
      : await fileState(paths.lifecycleRoot) === null;
    if (!originalIsCurrent) {
      await cleanupStage(stagingRoot);
      return failure('LAYOUT_FINGERPRINT_STALE', '/expectedFingerprint', 'The lifecycle tree changed before publication.');
    }

    if (!paths.exists) {
      try {
        await publishRename(stagingRoot, paths.lifecycleRoot);
      } catch {
        if (await fileState(stagingRoot) || !await fingerprintAt(paths.lifecycleRoot, candidateFingerprint)) {
          throw pathError('LAYOUT_TRANSACTION_FAILED');
        }
      }
      publicationStarted = true;
      initializationPublished = true;
      const liveValidation = await input.validateCandidate({ lifecycleRoot: paths.lifecycleRoot });
      if (liveValidation?.ok !== true || !await fingerprintAt(paths.lifecycleRoot, candidateFingerprint)) {
        throw pathError('LAYOUT_TRANSACTION_FAILED');
      }
      return ok({
        changed: [...writes.map(({ locator }) => locator), ...directoriesToCreate.map((locator) => `${locator}/`), ...deletes].sort(compareCodePoints),
        unchanged,
        cleanup_pending: false,
        recovery_artifacts: [],
      });
    }

    backupRoot = await mkdtemp(join(paths.docsRoot, '.project-lifecycle-layout-backup-'));
    await rmdir(backupRoot);
    try {
      await publishRename(paths.lifecycleRoot, backupRoot);
    } catch {
      if (await fileState(paths.lifecycleRoot) || !await fingerprintAt(backupRoot, current.fingerprint)) throw pathError('LAYOUT_TRANSACTION_FAILED');
    }
    publicationStarted = true;
    if (await fileState(paths.lifecycleRoot) || !await fingerprintAt(backupRoot, current.fingerprint)) {
      throw pathError('LAYOUT_TRANSACTION_FAILED');
    }
    if ((await inspectTransition({
      phase: 'backup-moved',
      lifecycleRoot: paths.lifecycleRoot,
      stagingRoot,
      backupRoot,
    }))?.ok !== true) throw pathError('LAYOUT_TRANSACTION_FAILED');
    try {
      await publishRename(stagingRoot, paths.lifecycleRoot);
    } catch {
      if (await fileState(stagingRoot) || !await fingerprintAt(paths.lifecycleRoot, candidateFingerprint)) throw pathError('LAYOUT_TRANSACTION_FAILED');
    }
    if ((await inspectTransition({
      phase: 'candidate-moved',
      lifecycleRoot: paths.lifecycleRoot,
      stagingRoot,
      backupRoot,
    }))?.ok !== true) throw pathError('LAYOUT_TRANSACTION_FAILED');
    const liveValidation = await input.validateCandidate({ lifecycleRoot: paths.lifecycleRoot });
    if (liveValidation?.ok !== true || !await fingerprintAt(paths.lifecycleRoot, candidateFingerprint)) {
      throw pathError('LAYOUT_TRANSACTION_FAILED');
    }
    await afterPublish({ lifecycleRoot: paths.lifecycleRoot });
    if (operations.retainBackup === true) {
      return ok({
        changed: [...writes.map(({ locator }) => locator), ...directoriesToCreate.map((locator) => `${locator}/`), ...deletes].sort(compareCodePoints),
        unchanged,
        cleanup_pending: true,
        recovery_artifacts: ['backup'],
        retained_publication: {
          lifecycle_root: paths.lifecycleRoot,
          backup_root: backupRoot,
          original_fingerprint: current.fingerprint,
          candidate_fingerprint: candidateFingerprint,
        },
      });
    }
    try {
      await removeBackup(backupRoot);
    } catch {}
    if (await fileState(backupRoot)) {
      return ok({
        changed: [...writes.map(({ locator }) => locator), ...directoriesToCreate.map((locator) => `${locator}/`), ...deletes].sort(compareCodePoints),
        unchanged,
        cleanup_pending: true,
        recovery_artifacts: ['backup'],
      });
    }
    backupRoot = null;
    return ok({
      changed: [...writes.map(({ locator }) => locator), ...directoriesToCreate.map((locator) => `${locator}/`), ...deletes].sort(compareCodePoints),
      unchanged,
      cleanup_pending: false,
      recovery_artifacts: [],
    });
  } catch (error) {
    if (publicationStarted) {
      const restored = initializationPublished
        ? await rollbackInitialization({
          lifecycleRoot: paths.lifecycleRoot,
          stagingRoot,
          candidateFingerprint,
        })
        : await restoreOriginal({
          lifecycleRoot: paths.lifecycleRoot,
          stagingRoot,
          backupRoot,
          originalFingerprint: current.fingerprint,
          candidateFingerprint,
          restoreRename,
        });
      if (!restored.ok) return restored;
    } else {
      await cleanupStage(stagingRoot).catch(() => {});
    }
    return failure(
      error?.code === 'PATH_ESCAPE' || error?.code === 'PATH_SYMLINK_ESCAPE'
        ? error.code
        : 'LAYOUT_TRANSACTION_FAILED',
      '/',
      'The lifecycle layout transaction could not be completed.',
    );
  }
};

export const finalizeRetainedLayout = async ({ retained_publication: publication } = {}, operations = {}) => {
  if (!publication?.backup_root) return failure('LAYOUT_INPUT_INVALID', '/retained_publication', 'A retained publication is required.');
  try {
    const removeBackup = operations.removeBackup ?? ((path) => rm(path, { recursive: true, force: true }));
    if (!await fingerprintAt(publication.lifecycle_root, publication.candidate_fingerprint)) {
      return failure('LAYOUT_FINGERPRINT_STALE', '/retained_publication', 'The published candidate changed before finalization.');
    }
    await removeBackup(publication.backup_root);
    return await fileState(publication.backup_root)
      ? failure('LAYOUT_TRANSACTION_FAILED', '/retained_publication', 'The retained backup could not be finalized.')
      : ok(null);
  } catch {
    return failure('LAYOUT_TRANSACTION_FAILED', '/retained_publication', 'The retained backup could not be finalized.');
  }
};

export const rollbackRetainedLayout = async ({ retained_publication: publication } = {}, operations = {}) => {
  if (!publication?.backup_root) return failure('LAYOUT_INPUT_INVALID', '/retained_publication', 'A retained publication is required.');
  let stagingRoot;
  try {
    stagingRoot = await mkdtemp(join(dirname(publication.lifecycle_root), '.project-lifecycle-layout-rollback-'));
    await rmdir(stagingRoot);
  } catch {
    return failure('LAYOUT_RESTORE_FAILED', '/recovery', 'Recovery staging could not be initialized.');
  }
  return restoreOriginal({
    lifecycleRoot: publication.lifecycle_root,
    stagingRoot,
    backupRoot: publication.backup_root,
    originalFingerprint: publication.original_fingerprint,
    candidateFingerprint: publication.candidate_fingerprint,
    restoreRename: operations.restoreRename ?? rename,
  });
};
