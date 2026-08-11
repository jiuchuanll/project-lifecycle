import {
  lstat,
  mkdir,
  readFile,
  rmdir,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { generateIndexes } from './generate-indexes.mjs';
import { applyLayoutTransaction } from './layout-transaction.mjs';

const projectMapAsset = new URL(
  '../../skills/maintain-project-knowledge/assets/project-map.json',
  import.meta.url,
);
const pendingChangesAsset = new URL(
  '../../skills/maintain-project-knowledge/assets/pending-changes.json',
  import.meta.url,
);

const bootstrapFailure = (code, path, message) => fail([createError(code, path, message)]);

const localizedTextIsComplete = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === 2
  && typeof value.en === 'string'
  && value.en.trim().length > 0
  && typeof value['zh-CN'] === 'string'
  && value['zh-CN'].trim().length > 0;

const fileState = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const jsonContent = (value) => `${JSON.stringify(value, null, 2)}\n`;

const canonicalizeDomains = (domains, calibrationRef) => clone(domains)
  .map((domain) => ({
    ...domain,
    relationships: [...domain.relationships]
      .sort((left, right) => compareCodePoints(left.target_id, right.target_id)),
    evidence_refs: [...new Set([...domain.evidence_refs, calibrationRef])].sort(compareCodePoints),
  }))
  .sort((left, right) => compareCodePoints(left.id, right.id));

const validateIndex = (source, expected) => {
  const valid = typeof source === 'string' && source === expected;
  return valid ? ok(source) : bootstrapFailure(
    'BOOTSTRAP_INDEX_INVALID',
    '/',
    'Generated index is invalid.',
  );
};

const readAsset = async (url, kind) => {
  const value = JSON.parse(await readFile(url, 'utf8'));
  const validation = validateJson(kind, value);
  if (!validation.ok) {
    const error = new Error(`Invalid bootstrap asset: ${kind}`);
    error.code = 'BOOTSTRAP_ASSET_INVALID';
    error.errors = validation.errors;
    throw error;
  }
  return value;
};

const stableBootstrapErrorCodes = new Set([
  'BOOTSTRAP_ASSET_INVALID',
  'BOOTSTRAP_WRITE_FAILED',
  'PATH_SYMLINK_ESCAPE',
]);

const asFailure = (error) => bootstrapFailure(
  stableBootstrapErrorCodes.has(error?.code) ? error.code : 'BOOTSTRAP_WRITE_FAILED',
  '/',
  'Bootstrap could not be completed.',
);

const existingConflict = (path = '/') => bootstrapFailure(
  'BOOTSTRAP_EXISTING_PROJECT',
  path,
  'A different project lifecycle root already exists.',
);

const inspectCompleteBootstrap = async ({
  lifecycleRoot,
  expectedMap,
  expectedPending,
  expectedFiles,
  expectedDirectories,
}) => {
  try {
    const rootStat = await fileState(lifecycleRoot);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, path: '/' };

    for (const directory of expectedDirectories) {
      const stat = await fileState(join(lifecycleRoot, directory));
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        return { ok: false, path: `/${directory}` };
      }
    }

    const requiredFiles = ['project-map.json', 'pending-changes.json', ...expectedFiles.map(({ locator }) => locator)];
    const fileStats = await Promise.all(requiredFiles.map(async (name) => ({
      name,
      stat: await fileState(join(lifecycleRoot, name)),
    })));
    for (const { name, stat } of fileStats) {
      if (!stat?.isFile() || stat.isSymbolicLink()) return { ok: false, path: `/${name}` };
    }

    const [mapSource, pendingSource] = await Promise.all([
      readFile(join(lifecycleRoot, 'project-map.json'), 'utf8'),
      readFile(join(lifecycleRoot, 'pending-changes.json'), 'utf8'),
    ]);
    const existingMap = JSON.parse(mapSource);
    const existingPending = JSON.parse(pendingSource);
    if (!validateJson('project-map', existingMap).ok
      || !validateJson('pending-changes', existingPending).ok
      || !isDeepStrictEqual(existingMap, expectedMap)
      || !isDeepStrictEqual(existingPending, expectedPending)) {
      return { ok: false, path: '/' };
    }
    for (const file of expectedFiles) {
      if (await readFile(join(lifecycleRoot, file.locator), 'utf8') !== file.content) {
        return { ok: false, path: `/${file.locator}` };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, path: '/' };
  }
};

const existingBootstrap = async (expected) => {
  const inspection = await inspectCompleteBootstrap(expected);
  return inspection.ok ? ok({ status: 'existing' }) : existingConflict(inspection.path);
};

const requireCompleteBootstrap = async (expected) => {
  const inspection = await inspectCompleteBootstrap(expected);
  if (inspection.ok) return;
  const error = new Error('Bootstrap postcondition validation failed.');
  error.code = 'BOOTSTRAP_WRITE_FAILED';
  throw error;
};

export async function bootstrap({
  root,
  project_id: projectId,
  label,
  purpose,
  calibration_ref: calibrationRef,
  calibration_approved: calibrationApproved,
  domains,
}, operations = {}) {
  if (typeof calibrationRef !== 'string' || calibrationRef.trim().length === 0
    || calibrationApproved !== true) {
    return bootstrapFailure(
      'BOOTSTRAP_CALIBRATION_REQUIRED',
      '/calibration_ref',
      'Initial calibration approval is required.',
    );
  }
  if (typeof root !== 'string' || !isAbsolute(root)
    || typeof projectId !== 'string' || projectId.trim().length === 0
    || !localizedTextIsComplete(label)
    || !localizedTextIsComplete(purpose)
    || !Array.isArray(domains)
    || domains.length === 0) {
    return bootstrapFailure(
      'BOOTSTRAP_INPUT_INVALID',
      '/arguments',
      'Explicit project identity, bilingual label and purpose, and a domain skeleton are required.',
    );
  }
  if (domains.some((domain) => domain?.domain_state !== 'confirmed')) {
    return bootstrapFailure(
      'BOOTSTRAP_DOMAIN_NOT_CONFIRMED',
      '/domains',
      'Every bootstrap domain must be explicitly confirmed.',
    );
  }

  let map;
  let pending;
  try {
    const mapBase = await readAsset(projectMapAsset, 'project-map');
    pending = await readAsset(pendingChangesAsset, 'pending-changes');
    map = {
      ...mapBase,
      project_id: projectId,
      knowledge_baseline: calibrationRef,
      project_identity: { label: clone(label), purpose: clone(purpose), calibration_ref: calibrationRef },
      domains: canonicalizeDomains(domains, calibrationRef),
    };
  } catch (error) {
    return asFailure(error);
  }

  const mapValidation = validateJson('project-map', map);
  if (!mapValidation.ok) return mapValidation;
  const pendingValidation = validateJson('pending-changes', pending);
  if (!pendingValidation.ok) return pendingValidation;

  const generatedIndexes = generateIndexes({ map });
  if (!generatedIndexes.ok) return generatedIndexes;
  const expectedFiles = generatedIndexes.value.files.filter(({ repository_id: repositoryId }) => repositoryId === null);
  const expectedDirectories = [...new Set([
    'delivery',
    ...generatedIndexes.value.layout.directories
      .filter(({ repository_id: repositoryId }) => repositoryId === null)
      .map(({ locator }) => locator),
  ])].sort(compareCodePoints);
  const expectedPostcondition = { expectedMap: map, expectedPending: pending, expectedFiles, expectedDirectories };
  const candidateFiles = [
    {
      repository_id: null,
      locator: 'project-map.json',
      content: jsonContent(map),
      validate: async (source) => {
        try {
          return validateJson('project-map', JSON.parse(source));
        } catch {
          return bootstrapFailure('SCHEMA_INVALID', '/', 'Invalid project-map.');
        }
      },
    },
    {
      repository_id: null,
      locator: 'pending-changes.json',
      content: jsonContent(pending),
      validate: async (source) => {
        try {
          return validateJson('pending-changes', JSON.parse(source));
        } catch {
          return bootstrapFailure('SCHEMA_INVALID', '/', 'Invalid pending-changes.');
        }
      },
    },
    ...expectedFiles.map((file) => ({
      repository_id: null,
      locator: file.locator,
      content: file.content,
      validate: async (source) => validateIndex(source, file.content),
    })),
  ];

  let docsPath;
  let lifecycleRoot;
  let createdDocs = false;
  try {
    docsPath = await resolveInside(root, 'docs');
    const docsStat = await fileState(docsPath);
    if (docsStat?.isSymbolicLink()) {
      const error = new Error('Docs parent must not be a symlink.');
      error.code = 'PATH_SYMLINK_ESCAPE';
      throw error;
    }
    if (docsStat && !docsStat.isDirectory()) {
      return bootstrapFailure('BOOTSTRAP_WRITE_FAILED', '/docs', 'Bootstrap could not be completed.');
    }
    if (docsStat) {
      lifecycleRoot = join(docsPath, 'project-lifecycle');
      const lifecycleStat = await fileState(lifecycleRoot);
      if (lifecycleStat) {
        return await existingBootstrap({
          lifecycleRoot,
          ...expectedPostcondition,
        });
      }
    }

    if (!docsStat) {
      await mkdir(docsPath);
      createdDocs = true;
    }
    lifecycleRoot = join(docsPath, 'project-lifecycle');
    const published = await applyLayoutTransaction({
      repositoryRoot: root,
      initialize: true,
      candidateFiles,
      candidateDirectories: expectedDirectories,
      deleteLocators: [],
      validateCandidate: async ({ lifecycleRoot: candidateRoot }) => {
        const inspection = await inspectCompleteBootstrap({
          lifecycleRoot: candidateRoot,
          ...expectedPostcondition,
        });
        return inspection.ok ? ok() : bootstrapFailure('BOOTSTRAP_WRITE_FAILED', inspection.path, 'Bootstrap candidate is incomplete.');
      },
    }, operations);
    if (!published.ok) {
      if (createdDocs) await rmdir(docsPath).catch(() => {});
      const first = published.errors[0];
      return bootstrapFailure(
        first.code === 'PATH_SYMLINK_ESCAPE' ? first.code : 'BOOTSTRAP_WRITE_FAILED',
        '/',
        'Bootstrap could not be completed.',
      );
    }
    await requireCompleteBootstrap({
      lifecycleRoot,
      ...expectedPostcondition,
    });
    return ok({ status: 'created', changed: published.value.changed });
  } catch (error) {
    if (createdDocs && docsPath) await rmdir(docsPath).catch(() => {});
    if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
      return bootstrapFailure(
        'BOOTSTRAP_EXISTING_PROJECT',
        '/project-map.json',
        'A different project lifecycle root already exists.',
      );
    }
    return asFailure(error);
  }
}
