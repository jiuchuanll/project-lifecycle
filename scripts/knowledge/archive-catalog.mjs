import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseRestrictedYaml } from '../lib/markdown.mjs';
import { isSafeLocator } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const ID = /^[a-z][a-z0-9-]*$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const DELIVERY_LOCATOR = /^delivery\/[a-z][a-z0-9-]*-en\.md$/u;
const RETAINED = new Set(['archive', 'closed-summary']);
const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const inside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};

const hashOf = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

const parseDeliveryFrontmatter = (content) => {
  const normalized = content.toString('utf8').replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return null;
  const closing = normalized.indexOf('\n---\n', 4);
  if (closing === -1) return null;
  const parsed = parseRestrictedYaml(normalized.slice(4, closing), '/frontmatter');
  if (!parsed.ok) return null;
  const validation = validateJson('delivery-frontmatter', parsed.value);
  return validation.ok ? parsed.value : null;
};

const resolveLifecycleRoot = async (rootValue) => {
  if (typeof rootValue !== 'string' || !isAbsolute(rootValue)) {
    throw Object.assign(new Error('Absolute project root required.'), { code: 'ARCHIVE_ROOT_INVALID' });
  }
  const lexicalRoot = resolve(rootValue);
  const rootState = await lstat(lexicalRoot);
  const root = await realpath(lexicalRoot);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw Object.assign(new Error('Regular project root required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  const lexicalLifecycle = await resolveInside(root, 'docs/project-lifecycle');
  const lifecycleState = await lstat(lexicalLifecycle);
  const lifecycleRoot = await realpath(lexicalLifecycle);
  if (!lifecycleState.isDirectory() || lifecycleState.isSymbolicLink() || !inside(root, lifecycleRoot)) {
    throw Object.assign(new Error('Regular lifecycle root required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  return lifecycleRoot;
};

export const resolveArchiveLocator = async (lifecycleRoot, locator) => {
  if (typeof locator !== 'string' || !DELIVERY_LOCATOR.test(locator) || !isSafeLocator(locator)) {
    throw Object.assign(new Error('Canonical archive locator required.'), { code: 'ARCHIVE_LOCATOR_INVALID' });
  }
  const lexical = await resolveInside(lifecycleRoot, locator);
  const state = await lstat(lexical);
  const physical = await realpath(lexical);
  if (!state.isFile() || state.isSymbolicLink() || !inside(lifecycleRoot, physical)) {
    throw Object.assign(new Error('Regular archive file required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  return physical;
};

export const validateArchiveCatalog = (value) => {
  if (!record(value) || value.schema_version !== 1 || !ID.test(value.project_id ?? '')
    || !Array.isArray(value.artifacts)) {
    return failure('ARCHIVE_CATALOG_INVALID', '/', 'Archive catalog must use the bounded metadata-only contract.');
  }
  const ids = new Set();
  const locators = new Set();
  let previousId = null;
  for (const [index, artifact] of value.artifacts.entries()) {
    const path = `/artifacts/${index}`;
    if (!record(artifact)
      || !ID.test(artifact.artifact_id ?? '')
      || !RETAINED.has(artifact.retention_tier)
      || !HASH.test(artifact.content_hash ?? '')
      || !ID.test(artifact.project_id_at_creation ?? '')
      || artifact.current_project_id !== value.project_id
      || !Array.isArray(artifact.domain_ids)
      || artifact.domain_ids.length < 1
      || artifact.domain_ids.length > 50
      || artifact.domain_ids.some((id) => !ID.test(id))
      || !DELIVERY_LOCATOR.test(artifact.locator ?? '')
      || !isSafeLocator(artifact.locator)
      || Object.keys(artifact).some((key) => ![
        'artifact_id', 'retention_tier', 'content_hash', 'project_id_at_creation',
        'current_project_id', 'domain_ids', 'locator',
      ].includes(key))) {
      return failure('ARCHIVE_CATALOG_INVALID', path, 'Archive catalog entries contain only bounded retained-artifact metadata.');
    }
    if (ids.has(artifact.artifact_id) || locators.has(artifact.locator)) {
      return failure('ARCHIVE_CATALOG_DUPLICATE', path, 'Archive catalog artifact IDs and locators must be unique.');
    }
    if (previousId !== null && compareCodePoints(previousId, artifact.artifact_id) >= 0) {
      return failure('ARCHIVE_CATALOG_ORDER_INVALID', `${path}/artifact_id`, 'Archive catalog artifacts must use strict ID order.');
    }
    for (let domainIndex = 1; domainIndex < artifact.domain_ids.length; domainIndex += 1) {
      if (compareCodePoints(artifact.domain_ids[domainIndex - 1], artifact.domain_ids[domainIndex]) >= 0) {
        return failure('ARCHIVE_CATALOG_ORDER_INVALID', `${path}/domain_ids/${domainIndex}`, 'Archive domain IDs must use strict ID order.');
      }
    }
    ids.add(artifact.artifact_id);
    locators.add(artifact.locator);
    previousId = artifact.artifact_id;
  }
  if (Object.keys(value).some((key) => !['schema_version', 'project_id', 'artifacts'].includes(key))) {
    return failure('ARCHIVE_CATALOG_INVALID', '/', 'Archive catalog contains unknown metadata.');
  }
  return ok(value);
};

export async function buildArchiveCatalog({ root, delivery_locators: locators, operations = {} } = {}) {
  if (!Array.isArray(locators) || locators.some((locator) => (
    typeof locator !== 'string' || !DELIVERY_LOCATOR.test(locator) || !isSafeLocator(locator)
  )) || new Set(locators).size !== locators.length) {
    return failure('ARCHIVE_LOCATOR_INVALID', '/delivery_locators', 'Exact canonical English delivery locators are required.');
  }
  const onRead = typeof operations?.onRead === 'function' ? operations.onRead : () => {};
  let lifecycleRoot;
  let map;
  try {
    lifecycleRoot = await resolveLifecycleRoot(root);
    const lexicalMap = await resolveInside(lifecycleRoot, 'project-map.json');
    const mapState = await lstat(lexicalMap);
    const physicalMap = await realpath(lexicalMap);
    if (!mapState.isFile() || mapState.isSymbolicLink() || !inside(lifecycleRoot, physicalMap)) {
      throw Object.assign(new Error('Regular project map required.'), { code: 'PATH_SYMLINK_ESCAPE' });
    }
    map = JSON.parse(await readFile(physicalMap, 'utf8'));
  } catch (error) {
    return failure(error?.code ?? 'ARCHIVE_ROOT_INVALID', '/', 'A bounded validated lifecycle root is required.');
  }
  const mapValidation = validateJson('project-map', map);
  if (!mapValidation.ok) return failure('ARCHIVE_PROJECT_INVALID', '/project-map.json', 'The archive catalog requires a validated current project map.');
  const domainIds = new Set(map.domains.map(({ id }) => id));
  const artifacts = [];
  try {
    for (const locator of [...locators].sort(compareCodePoints)) {
      const physical = await resolveArchiveLocator(lifecycleRoot, locator);
      const content = await readFile(physical);
      onRead({ locator, section: 'artifact-hash' });
      const frontmatter = parseDeliveryFrontmatter(content);
      if (!frontmatter || !RETAINED.has(frontmatter.retention_tier)) {
        return failure('ARCHIVE_FRONTMATTER_INVALID', '/delivery_locators', 'Catalog sources require validated retained delivery Frontmatter.');
      }
      if (frontmatter.project_id_at_creation !== map.project_id
        || frontmatter.domain_ids.some((id) => !domainIds.has(id))) {
        return failure('ARCHIVE_PROJECT_INVALID', '/delivery_locators', 'Retained delivery metadata must bind to the current project map.');
      }
      artifacts.push({
        artifact_id: frontmatter.artifact_id,
        retention_tier: frontmatter.retention_tier,
        content_hash: hashOf(content),
        project_id_at_creation: frontmatter.project_id_at_creation,
        current_project_id: map.project_id,
        domain_ids: [...frontmatter.domain_ids].sort(compareCodePoints),
        locator,
      });
    }
  } catch (error) {
    return failure(error?.code ?? 'ARCHIVE_LOCATOR_INVALID', '/delivery_locators', 'Catalog sources could not be read through exact bounded locators.');
  }
  artifacts.sort((left, right) => compareCodePoints(left.artifact_id, right.artifact_id));
  const catalog = { schema_version: 1, project_id: map.project_id, artifacts };
  return validateArchiveCatalog(catalog);
}

export const archiveContentHash = hashOf;
export const archiveFrontmatter = parseDeliveryFrontmatter;
export const archiveLifecycleRoot = resolveLifecycleRoot;
