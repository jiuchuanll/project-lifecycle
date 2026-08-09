import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { getSchemaValidator } from '../lib/schema-registry.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const failure = (code, path, message) => fail([createError(code, path, message)]);
const needsUser = () => ok({
  status: 'needs_user',
  stop: { code: 'NEEDS_USER' },
  local_read_allowed: true,
  shared_publication_allowed: false,
});

const pointerIsStructurallyValid = (pointer) => {
  const validate = getSchemaValidator('project-pointer');
  return validate(pointer) && isSafeReference(pointer.governance_locator)
    && (pointer.identity_migration_ref === undefined || isSafeReference(pointer.identity_migration_ref));
};

export function derivePointerRebind({ pointer, governanceMap, governanceLocator } = {}) {
  if (!pointerIsStructurallyValid(pointer)) {
    return failure('PROJECT_POINTER_INVALID', '/pointer', 'Project pointer must satisfy the compact portable contract.');
  }
  const mapValidation = validateJson('project-map', governanceMap);
  if (!mapValidation.ok) {
    return failure('GOVERNANCE_MAP_INVALID', '/governanceMap', 'Governance target must be a valid project map.');
  }
  if (!isSafeReference(governanceLocator)) {
    return failure('GOVERNANCE_LOCATOR_INVALID', '/governanceLocator', 'Governance locator must be one safe portable reference.');
  }
  if (pointer.project_id === governanceMap.project_id) {
    const validation = validateJson('project-pointer', pointer, { resolvedProjectMap: governanceMap });
    return validation.ok ? ok({
      status: 'current',
      local_read_allowed: true,
      shared_publication_allowed: true,
      pointer,
    }) : validation;
  }

  const byPredecessor = new Map(
    governanceMap.identity_lineage.map((entry) => [entry.predecessor_project_id, entry]),
  );
  const visited = new Set();
  let currentId = pointer.project_id;
  let migrationRef;
  while (currentId !== governanceMap.project_id) {
    if (visited.has(currentId)) return needsUser();
    visited.add(currentId);
    const transition = byPredecessor.get(currentId);
    if (!transition || transition.relationship !== 'SUCCESSOR'
      || transition.successor_project_ids.length !== 1) return needsUser();
    [currentId] = transition.successor_project_ids;
    migrationRef = transition.approval_ref;
  }

  const candidate = {
    schema_version: 1,
    project_id: governanceMap.project_id,
    repository_id: pointer.repository_id,
    governance_locator: governanceLocator,
    identity_migration_ref: migrationRef,
  };
  const validation = validateJson('project-pointer', candidate, { resolvedProjectMap: governanceMap });
  if (!validation.ok) return validation;
  return ok({
    status: 'rebind_required',
    review_required: true,
    local_read_allowed: true,
    shared_publication_allowed: false,
    candidate_pointer: candidate,
  });
}
