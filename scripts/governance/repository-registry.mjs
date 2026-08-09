import { isDeepStrictEqual } from 'node:util';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeLocator, isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const ID = /^[a-z][a-z0-9-]*$/u;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const localized = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2
  && typeof value.en === 'string' && value.en.trim().length > 0
  && typeof value['zh-CN'] === 'string' && value['zh-CN'].trim().length > 0;

const validRegistration = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [
    'accepted_revision', 'domain_ids', 'id', 'integration_ref', 'knowledge_asset_locators',
    'portable_locator', 'purpose',
  ].join('\0')
  && ID.test(value.id ?? '') && localized(value.purpose)
  && isSafeReference(value.portable_locator) && isSafeReference(value.integration_ref)
  && isSafeReference(value.accepted_revision)
  && Array.isArray(value.domain_ids) && new Set(value.domain_ids).size === value.domain_ids.length
  && value.domain_ids.every((id) => ID.test(id))
  && Array.isArray(value.knowledge_asset_locators)
  && new Set(value.knowledge_asset_locators).size === value.knowledge_asset_locators.length
  && value.knowledge_asset_locators.every(isSafeLocator);

export function registerRepository({ projectMap, registration, approvalRef } = {}) {
  const mapValidation = validateJson('project-map', projectMap);
  if (!mapValidation.ok) return failure('GOVERNANCE_MAP_INVALID', '/projectMap', 'Repository registration requires a valid project map.');
  if (!validRegistration(registration) || !isSafeReference(approvalRef)) {
    return failure('REPOSITORY_REGISTRATION_INVALID', '/registration', 'Repository registration must use exact portable metadata and an approval reference.');
  }
  const existing = projectMap.repositories.find(({ id }) => id === registration.id);
  if (existing) {
    return isDeepStrictEqual(existing, registration)
      ? ok({ status: 'already_registered', review_required: false, candidate_map: clone(projectMap) })
      : failure('REPOSITORY_ID_CONFLICT', '/registration/id', 'Repository ID already identifies different metadata.');
  }
  const candidate = clone(projectMap);
  candidate.repositories.push(clone(registration));
  candidate.repositories.sort((left, right) => compareCodePoints(left.id, right.id));
  const candidateValidation = validateJson('project-map', candidate);
  if (!candidateValidation.ok) {
    return failure('REPOSITORY_REGISTRATION_INVALID', '/registration', 'Repository registration does not match the current project map.');
  }
  return ok({
    status: 'registration_candidate',
    review_required: true,
    approval_ref: approvalRef,
    candidate_map: candidate,
  });
}
