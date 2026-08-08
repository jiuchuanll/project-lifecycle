import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseRestrictedYaml } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const failure = (code, path, message) => fail([createError(code, path, message)]);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uniqueSorted = (values) => [...new Set(values)].sort(compareCodePoints);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const ID = /^[a-z][a-z0-9-]*$/u;

const inside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};

const normalizeInput = (input) => {
  if (!isRecord(input) || typeof input.root !== 'string' || !isAbsolute(input.root)
    || typeof input.knowledge_baseline !== 'string' || input.knowledge_baseline.length === 0 || input.knowledge_baseline.length > 500
    || typeof input.primary_domain_id !== 'string'
    || !Array.isArray(input.candidate_domain_ids)
    || !Array.isArray(input.applicable_relationships)
    || !Array.isArray(input.task_delivery_refs)
    || !Array.isArray(input.material_exclusions)
    || !Array.isArray(input.evidence_gaps)
    || !Array.isArray(input.open_questions)
    || !Array.isArray(input.conflicts)
    || input.candidate_domain_ids.length > 50
    || input.applicable_relationships.length > 100
    || input.task_delivery_refs.length > 100
    || input.material_exclusions.length > 100
    || input.evidence_gaps.length > 50
    || input.open_questions.length > 50
    || input.conflicts.length > 50
    || Object.hasOwn(input, 'confidence')) {
    return failure('CONTEXT_INPUT_INVALID', '/arguments', 'Explicit bounded routing inputs are required; confidence inference is not accepted.');
  }
  const strings = [
    ...input.candidate_domain_ids,
    ...input.evidence_gaps,
    ...input.open_questions,
    ...input.conflicts,
  ];
  if (strings.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 500)
    || !ID.test(input.primary_domain_id)) {
    return failure('CONTEXT_INPUT_INVALID', '/arguments', 'Routing identifiers and explicit stop data must be non-empty strings.');
  }
  return ok(input);
};

const resolveLifecycleRoot = async (rootValue) => {
  const lexicalRoot = resolve(rootValue);
  const rootState = await lstat(lexicalRoot);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw Object.assign(new Error('Regular project root required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  const root = await realpath(lexicalRoot);
  const lifecycle = await resolveInside(root, 'docs/project-lifecycle');
  const lifecycleState = await lstat(lifecycle);
  const realLifecycle = await realpath(lifecycle);
  if (!lifecycleState.isDirectory() || lifecycleState.isSymbolicLink() || !inside(root, realLifecycle)) {
    throw Object.assign(new Error('Bounded lifecycle root required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  return realLifecycle;
};

const resolveReadable = async (lifecycleRoot, locator) => {
  if (typeof locator !== 'string' || locator.length === 0 || isAbsolute(locator)
    || /^[A-Za-z]:[\\/]/u.test(locator) || locator.includes('\\') || locator.includes('://')
    || /[\s<>]/u.test(locator) || locator.split('/').includes('..')) {
    throw Object.assign(new Error('Bounded locator required.'), { code: 'CONTEXT_TARGET_INVALID' });
  }
  const lexical = await resolveInside(lifecycleRoot, locator);
  const state = await lstat(lexical);
  const physical = await realpath(lexical);
  if (!state.isFile() || state.isSymbolicLink() || !inside(lifecycleRoot, physical)) {
    throw Object.assign(new Error('Bounded regular file required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  return physical;
};

// Read only through the exact closing Frontmatter delimiter. This deliberately
// avoids reading capability or delivery body bytes during routing validation.
const readFrontmatterPrefix = async (path, maxBytes = 65_536) => {
  const handle = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(maxBytes);
    const delimiter = Buffer.from('\n---\n');
    for (let position = 0; position < maxBytes; position += 1) {
      const { bytesRead } = await handle.read(prefix, position, 1, position);
      if (bytesRead === 0) break;
      const length = position + 1;
      if (length > 4 && prefix.subarray(length - delimiter.length, length).equals(delimiter)) {
        return prefix.subarray(0, length).toString('utf8');
      }
    }
    throw Object.assign(new Error('Frontmatter boundary is missing or too large.'), { code: 'CONTEXT_FRONTMATTER_INVALID' });
  } finally {
    await handle.close();
  }
};

const parseFrontmatter = (source, schema) => {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n') || !normalized.endsWith('\n---\n')) {
    return failure('CONTEXT_FRONTMATTER_INVALID', '/frontmatter', 'Exact bounded Frontmatter is required.');
  }
  const parsed = parseRestrictedYaml(normalized.slice(4, -5), '/frontmatter');
  if (!parsed.ok) return failure('CONTEXT_FRONTMATTER_INVALID', '/frontmatter', 'Frontmatter must be restricted YAML.');
  const validation = validateJson(schema, parsed.value);
  return validation.ok ? ok(parsed.value) : failure(
    'CONTEXT_FRONTMATTER_INVALID',
    '/frontmatter',
    'Frontmatter does not satisfy its shared contract.',
  );
};

const applicableConstraint = (constraint, domainId, ancestors) => {
  if (constraint.lifecycle_state !== 'current' || !constraint.owner_id) return false;
  if ((constraint.exceptions ?? []).some(({ domain_id: exceptionId }) => exceptionId === domainId)) return false;
  if (constraint.scope === 'self') return constraint.owner_id === domainId;
  if (!ancestors.includes(constraint.owner_id)) return false;
  if (constraint.scope === 'descendants') return true;
  return constraint.scope === 'selected_descendants'
    && constraint.selected_descendants.includes(domainId);
};

const lineageOf = (domains, domainId) => {
  const byId = new Map(domains.map((domain) => [domain.id, domain]));
  const lineage = [];
  let node = byId.get(domainId);
  const seen = new Set([domainId]);
  while (node?.parent_id) {
    if (seen.has(node.parent_id)) break;
    seen.add(node.parent_id);
    lineage.push(node.parent_id);
    node = byId.get(node.parent_id);
  }
  return lineage;
};

const routeOrder = (primaryId, edges) => {
  const order = [primaryId];
  const seen = new Set(order);
  while (true) {
    let changed = false;
    for (const edge of edges) {
      if (!seen.has(edge.source_id) || seen.has(edge.target_id)) continue;
      seen.add(edge.target_id);
      order.push(edge.target_id);
      changed = true;
    }
    if (!changed) break;
  }
  return order;
};

const stopFor = ({ conflicts, openQuestions, evidenceGaps }) => {
  if (conflicts.length > 0) return { code: 'CONFLICT', reason: 'Explicit current-context conflicts require semantic review.' };
  if (openQuestions.length > 0) return { code: 'NEEDS_USER', reason: 'A material routing question requires user confirmation.' };
  if (evidenceGaps.length > 0) return { code: 'NEEDS_EVIDENCE', reason: 'Selected context lacks an explicit current evidence basis.' };
  return { code: 'SUFFICIENT', reason: 'The explicit bounded selection is current enough for this task.' };
};

export async function selectContext(inputValue, operations = {}) {
  const normalized = normalizeInput(inputValue);
  if (!normalized.ok) return normalized;
  const input = normalized.value;
  const onRead = operations.onRead ?? (() => {});

  let lifecycleRoot;
  let map;
  try {
    lifecycleRoot = await resolveLifecycleRoot(input.root);
    const mapPath = await resolveReadable(lifecycleRoot, 'project-map.json');
    map = JSON.parse(await readFile(mapPath, 'utf8'));
    onRead({ level: 'L0', locator: 'project-map.json', section: 'document' });
  } catch (error) {
    return failure(error?.code ?? 'CONTEXT_ROOT_INVALID', '/', 'A bounded validated project map is required.');
  }
  const mapValidation = validateJson('project-map', map);
  if (!mapValidation.ok) return mapValidation;
  const byId = new Map(map.domains.map((domain) => [domain.id, domain]));
  const candidates = uniqueSorted(input.candidate_domain_ids);
  if (!byId.has(input.primary_domain_id) || candidates.some((id) => !byId.has(id))
    || !candidates.includes(input.primary_domain_id)) {
    return failure('CONTEXT_DOMAIN_INVALID', '/candidate_domain_ids', 'Primary and candidate domains must be explicit canonical map IDs.');
  }
  if (candidates.some((id) => ['merged', 'retired'].includes(byId.get(id).domain_state))) {
    return failure('CONTEXT_DOMAIN_INVALID', '/candidate_domain_ids', 'Merged or retired domains are not current routing candidates.');
  }

  const edgeKeys = new Set();
  for (const [index, edge] of input.applicable_relationships.entries()) {
    if (!isRecord(edge) || !['depends_on', 'governed_by', 'coordinates_with'].includes(edge.kind)
      || !candidates.includes(edge.source_id) || !candidates.includes(edge.target_id)) {
      return failure('CONTEXT_RELATIONSHIP_INVALID', `/applicable_relationships/${index}`, 'Applicable relationships must remain within caller-supplied candidate domains.');
    }
    const declared = byId.get(edge.source_id).relationships.some(({ kind, target_id: targetId }) => (
      kind === edge.kind && targetId === edge.target_id
    ));
    const key = `${edge.source_id}:${edge.kind}:${edge.target_id}`;
    if (!declared || edgeKeys.has(key)) {
      return failure('CONTEXT_RELATIONSHIP_INVALID', `/applicable_relationships/${index}`, 'Only one exact declared horizontal edge may be followed.');
    }
    edgeKeys.add(key);
  }
  const applicableEdges = [...input.applicable_relationships].sort((left, right) => compareCodePoints(
    `${left.source_id}:${left.kind}:${left.target_id}`,
    `${right.source_id}:${right.kind}:${right.target_id}`,
  ));
  const domainOrder = routeOrder(input.primary_domain_id, applicableEdges);
  if (!same(uniqueSorted(domainOrder), candidates)) {
    return failure('CONTEXT_RELATIONSHIP_INVALID', '/candidate_domain_ids', 'Every non-primary candidate requires an explicitly applicable path from the primary domain.');
  }

  const exclusionIds = new Set();
  for (const [index, exclusion] of input.material_exclusions.entries()) {
    if (!isRecord(exclusion) || !ID.test(exclusion.id)
      || !['OUT_OF_SCOPE', 'REDUNDANT', 'UNCONFIRMED', 'STALE', 'ARCHIVE_GATED'].includes(exclusion.reason)
      || typeof exclusion.explanation !== 'string' || exclusion.explanation.length === 0
      || exclusionIds.has(exclusion.id)) {
      return failure('CONTEXT_EXCLUSION_INVALID', `/material_exclusions/${index}`, 'Material exclusions must use the bounded shared contract.');
    }
    exclusionIds.add(exclusion.id);
  }

  const evidenceGaps = [...input.evidence_gaps];
  const selected = [];
  const constraints = map.constraints
    .filter((constraint) => domainOrder.some((domainId) => applicableConstraint(
      constraint,
      domainId,
      lineageOf(map.domains, domainId),
    )))
    .sort((left, right) => compareCodePoints(left.id, right.id));
  for (const constraint of constraints) {
    selected.push({
      kind: 'constraint', id: constraint.id,
      version_ref: `${constraint.knowledge_refs.en}@revision-${constraint.semantic_revision}`,
      reason: 'CONSTRAINT',
    });
  }

  for (const [index, domainId] of domainOrder.entries()) {
    const domain = byId.get(domainId);
    if (domain.domain_state !== 'materialized' || !domain.paired_assets || !domain.baseline) {
      evidenceGaps.push(`domain:${domainId}`);
      continue;
    }
    let frontmatter;
    try {
      const path = await resolveReadable(lifecycleRoot, domain.paired_assets.en);
      const source = await readFrontmatterPrefix(path);
      onRead({ level: index === 0 ? 'L2' : 'L3', locator: domain.paired_assets.en, section: 'frontmatter' });
      const parsed = parseFrontmatter(source, 'capability-frontmatter');
      if (!parsed.ok) return parsed;
      frontmatter = parsed.value;
    } catch (error) {
      return failure(error?.code ?? 'CONTEXT_FRONTMATTER_INVALID', `/domains/${domainId}`, 'Capability Frontmatter could not be read safely.');
    }
    if (frontmatter.id !== domainId || frontmatter.last_verified_baseline !== domain.baseline
      || frontmatter.paired_asset !== domain.paired_assets['zh-CN'].split('/').at(-1)) {
      return failure('CONTEXT_VERSION_INVALID', `/domains/${domainId}`, 'Capability version and ownership must match the current map.');
    }
    if (frontmatter.knowledge_state !== 'current') evidenceGaps.push(`domain:${domainId}`);
    selected.push({
      kind: 'domain_asset', id: domainId,
      version_ref: `${domain.paired_assets.en}@${frontmatter.last_verified_baseline}`,
      reason: index === 0 ? 'PRIMARY' : 'DEPENDENCY',
    });
  }

  const exclusions = [...input.material_exclusions];
  const deliveryIds = new Set();
  for (const [index, reference] of input.task_delivery_refs.entries()) {
    if (!isRecord(reference) || !ID.test(reference.artifact_id) || deliveryIds.has(reference.artifact_id)) {
      return failure('CONTEXT_DELIVERY_INVALID', `/task_delivery_refs/${index}`, 'Task delivery references must be unique stable IDs and locators.');
    }
    deliveryIds.add(reference.artifact_id);
    let frontmatter;
    try {
      const path = await resolveReadable(lifecycleRoot, reference.locator);
      const source = await readFrontmatterPrefix(path);
      const parsed = parseFrontmatter(source, 'delivery-frontmatter');
      if (!parsed.ok) return parsed;
      frontmatter = parsed.value;
      onRead({ level: frontmatter.retention_tier === 'archive' ? 'L5' : 'L4', locator: reference.locator, section: 'frontmatter' });
    } catch (error) {
      return failure(error?.code ?? 'CONTEXT_TARGET_INVALID', `/task_delivery_refs/${index}`, 'Delivery Frontmatter could not be read safely.');
    }
    if (frontmatter.artifact_id !== reference.artifact_id
      || !frontmatter.domain_ids.some((id) => candidates.includes(id))) {
      return failure('CONTEXT_DELIVERY_INVALID', `/task_delivery_refs/${index}`, 'Task-linked delivery must match its ID and selected domains.');
    }
    if (frontmatter.retention_tier === 'archive') {
      if (!exclusionIds.has(reference.artifact_id)) {
        exclusions.push({
          id: reference.artifact_id,
          reason: 'ARCHIVE_GATED',
          explanation: 'Archive content requires a separate Archive Access Receipt.',
        });
        exclusionIds.add(reference.artifact_id);
      }
      continue;
    }
    if (frontmatter.retention_tier !== 'active') continue;
    selected.push({
      kind: 'active_delivery', id: reference.artifact_id,
      version_ref: `${reference.locator}@${frontmatter.knowledge_baseline}`,
      reason: 'ACTIVE_CHANGE',
    });
  }

  const openQuestions = uniqueSorted(input.open_questions);
  const conflicts = uniqueSorted(input.conflicts);
  const sortedEvidenceGaps = uniqueSorted(evidenceGaps);
  const materialExclusions = [...exclusions]
    .sort((left, right) => compareCodePoints(left.id, right.id));
  if (selected.length > 100 || materialExclusions.length > 100) {
    return failure('CONTEXT_SELECTION_LIMIT', '/', 'Bounded context selection exceeds the shared receipt limits.');
  }
  return ok({
    knowledge_baseline: input.knowledge_baseline,
    primary_domain_id: input.primary_domain_id,
    affected_domain_ids: candidates,
    selected_context: selected.sort((left, right) => compareCodePoints(left.id, right.id)),
    material_exclusions: materialExclusions,
    open_questions: openQuestions,
    stop: stopFor({ conflicts, openQuestions, evidenceGaps: sortedEvidenceGaps }),
  });
}
