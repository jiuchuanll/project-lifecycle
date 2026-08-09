import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { getSchemaValidator } from '../lib/schema-registry.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { derivePointerRebind } from './rebind-pointer.mjs';

const LIFECYCLE_LOCATOR = 'docs/project-lifecycle/project-map.json';
const failure = (code, path, message) => fail([createError(code, path, message)]);
const state = async (path) => {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const fixedLifecycleRoot = async (repositoryRoot) => {
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot)) return null;
  const rootState = await state(repositoryRoot);
  if (!rootState?.isDirectory() || rootState.isSymbolicLink()) return null;
  const root = await realpath(repositoryRoot);
  const docs = join(root, 'docs');
  const docsState = await state(docs);
  if (docsState === null) return { root: join(docs, 'project-lifecycle'), exists: false };
  if (!docsState.isDirectory() || docsState.isSymbolicLink()) return null;
  const lifecycle = join(docs, 'project-lifecycle');
  const lifecycleState = await state(lifecycle);
  if (lifecycleState === null) return { root: lifecycle, exists: false };
  if (!lifecycleState.isDirectory() || lifecycleState.isSymbolicLink()) return null;
  return { root: lifecycle, exists: true };
};

const regularFile = async (path) => {
  const fileState = await state(path);
  if (fileState === null) return false;
  if (!fileState.isFile() || fileState.isSymbolicLink()) throw Object.assign(new Error('Unsafe fixed lifecycle asset.'), { code: 'GOVERNANCE_PATH_INVALID' });
  return true;
};

export async function resolveGovernanceRoot({ repositoryRoot, resolvePortableLocator } = {}) {
  let fixed;
  try { fixed = await fixedLifecycleRoot(repositoryRoot); } catch { fixed = null; }
  if (!fixed) return failure('GOVERNANCE_ROOT_INVALID', '/repositoryRoot', 'Repository root and fixed lifecycle namespace must be safe directories.');
  if (!fixed.exists) return ok({ status: 'bootstrap_required', local_read_allowed: false, shared_publication_allowed: false });

  const mapPath = join(fixed.root, 'project-map.json');
  const pointerPath = join(fixed.root, 'project-pointer.json');
  try {
    if (await regularFile(mapPath)) {
      const map = await readJson(mapPath);
      const validation = validateJson('project-map', map);
      if (!validation.ok) return failure('GOVERNANCE_MAP_INVALID', '/project-map.json', 'Local governance map is invalid.');
      return ok({
        status: 'resolved',
        source: 'local-map',
        governance_locator: LIFECYCLE_LOCATOR,
        repository_id: null,
        project_map: map,
        local_read_allowed: true,
        shared_publication_allowed: true,
      });
    }
    if (!await regularFile(pointerPath)) {
      return ok({ status: 'bootstrap_required', local_read_allowed: false, shared_publication_allowed: false });
    }
  } catch {
    return failure('GOVERNANCE_PATH_INVALID', '/', 'Fixed lifecycle assets must be regular non-symlink files.');
  }

  let pointer;
  try { pointer = await readJson(pointerPath); } catch {
    return failure('PROJECT_POINTER_INVALID', '/project-pointer.json', 'Project pointer must be valid JSON.');
  }
  const pointerSchema = getSchemaValidator('project-pointer');
  if (!pointerSchema(pointer) || !isSafeReference(pointer.governance_locator)
    || (pointer.identity_migration_ref !== undefined && !isSafeReference(pointer.identity_migration_ref))) {
    return failure('PROJECT_POINTER_INVALID', '/project-pointer.json', 'Project pointer must satisfy the compact portable contract.');
  }
  if (typeof resolvePortableLocator !== 'function') {
    return ok({
      status: 'unavailable', stop: { code: 'NEEDS_EVIDENCE' }, repository_id: pointer.repository_id,
      local_read_allowed: true, shared_publication_allowed: false,
    });
  }

  let resolved;
  try { resolved = await resolvePortableLocator(pointer.governance_locator); } catch { resolved = null; }
  if (!resolved) {
    return ok({
      status: 'unavailable', stop: { code: 'NEEDS_EVIDENCE' }, repository_id: pointer.repository_id,
      local_read_allowed: true, shared_publication_allowed: false,
    });
  }
  const projectMap = resolved.project_map ?? resolved;
  const governanceLocator = resolved.governance_locator ?? pointer.governance_locator;
  if (!isSafeReference(governanceLocator) || !validateJson('project-map', projectMap).ok) {
    return failure('GOVERNANCE_MAP_INVALID', '/governance_locator', 'Resolved governance target must be one valid project map.');
  }
  if (pointer.project_id === projectMap.project_id) {
    const validation = validateJson('project-pointer', pointer, { resolvedProjectMap: projectMap });
    if (!validation.ok) return validation;
    return ok({
      status: 'resolved',
      source: 'project-pointer',
      governance_locator: governanceLocator,
      repository_id: pointer.repository_id,
      project_map: projectMap,
      local_read_allowed: true,
      shared_publication_allowed: true,
    });
  }
  const rebind = derivePointerRebind({ pointer, governanceMap: projectMap, governanceLocator });
  return rebind.ok ? ok({ ...rebind.value, project_map: projectMap }) : rebind;
}
