import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { maskFencedMarkdown, parseRestrictedYaml } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { isSafeTask5Reference } from './generate-indexes.mjs';

const failure = (code, path, message) => fail([createError(code, path, message)]);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uniqueSorted = (values) => [...new Set(values)].sort(compareCodePoints);
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
    || /[\s<>#()]/u.test(locator) || locator.split('/').includes('..')) {
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
    const delimiters = [Buffer.from('\n---\n'), Buffer.from('\r\n---\r\n')];
    for (let position = 0; position < maxBytes; position += 1) {
      const { bytesRead } = await handle.read(prefix, position, 1, position);
      if (bytesRead === 0) break;
      const length = position + 1;
      if (delimiters.some((delimiter) => (
        length >= delimiter.length
        && prefix.subarray(length - delimiter.length, length).equals(delimiter)
      ))) {
        return prefix.subarray(0, length).toString('utf8');
      }
    }
    throw Object.assign(new Error('Frontmatter boundary is missing or too large.'), { code: 'CONTEXT_FRONTMATTER_INVALID' });
  } finally {
    await handle.close();
  }
};

const constraintReadFailure = (message) => Object.assign(new Error(message), {
  code: 'CONTEXT_CONSTRAINT_INVALID',
});

const inspectConstraintPrefix = (source, constraintId, revision, eof = false) => {
  const normalized = source.replaceAll('\r\n', '\n');
  const masked = maskFencedMarkdown(normalized);
  const completeLines = masked.endsWith('\n') || eof
    ? masked.split('\n')
    : masked.split('\n').slice(0, -1);
  const anchor = `<a id="constraint-${constraintId}"></a>`;
  const marker = `<!-- project-lifecycle:constraint id=${constraintId} revision=${revision} -->`;
  const close = '<!-- /project-lifecycle:constraint -->';
  const markerPrefix = `<!-- project-lifecycle:constraint id=${constraintId} revision=`;
  let state = 'seeking-anchor';
  for (const line of completeLines) {
    if (state === 'seeking-anchor') {
      if (line === anchor) {
        state = 'expecting-marker';
      } else if (line.startsWith(markerPrefix)) {
        throw constraintReadFailure('Constraint marker appears before its exact anchor.');
      }
      continue;
    }
    if (state === 'expecting-marker') {
      if (line !== marker) {
        throw constraintReadFailure('Constraint semantic revision marker is missing or stale.');
      }
      state = 'inside-section';
      continue;
    }
    if (line === close) return { complete: true };
    if (line.startsWith('<a id="constraint-')
      || line.startsWith('<!-- project-lifecycle:constraint id=')) {
      throw constraintReadFailure('Constraint section contains a duplicate or nested opening.');
    }
  }
  return { complete: false };
};

const readBoundedConstraintSection = async (
  path,
  constraintId,
  revision,
  { maxBytes = 65_536, chunkBytes = 256 } = {},
) => {
  const handle = await open(path, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    let source = '';
    let bytesReadTotal = 0;
    while (bytesReadTotal < maxBytes) {
      const remaining = maxBytes - bytesReadTotal;
      const buffer = Buffer.alloc(Math.min(chunkBytes, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytesReadTotal);
      if (bytesRead === 0) {
        source += decoder.end();
        const inspected = inspectConstraintPrefix(source, constraintId, revision, true);
        if (inspected.complete) return { bytesRead: bytesReadTotal };
        throw constraintReadFailure('Constraint section is missing its exact anchor or closing marker.');
      }
      bytesReadTotal += bytesRead;
      source += decoder.write(buffer.subarray(0, bytesRead));
      if (inspectConstraintPrefix(source, constraintId, revision).complete) {
        return { bytesRead: bytesReadTotal };
      }
    }
    throw constraintReadFailure('Constraint section exceeds the bounded read limit before completion.');
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
  if (!isSafeTask5Reference(input.knowledge_baseline)) {
    return failure('CONTEXT_REFERENCE_INVALID', '/knowledge_baseline', 'Context references must be portable single-line tokens.');
  }
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
  const globalBaseline = map.knowledge_baseline ?? map.project_identity?.calibration_ref;
  if (globalBaseline !== undefined && !isSafeTask5Reference(globalBaseline)) {
    return failure('CONTEXT_REFERENCE_INVALID', '/knowledge_baseline', 'The canonical global baseline is not a safe portable reference.');
  }
  const byId = new Map(map.domains.map((domain) => [domain.id, domain]));
  const candidates = uniqueSorted(input.candidate_domain_ids);
  if (candidates.length !== input.candidate_domain_ids.length
    || !byId.has(input.primary_domain_id) || candidates.some((id) => !byId.has(id))
    || !candidates.includes(input.primary_domain_id)) {
    return failure('CONTEXT_DOMAIN_INVALID', '/candidate_domain_ids', 'Primary and candidate domains must be explicit canonical map IDs.');
  }
  if (candidates.some((id) => ['merged', 'retired'].includes(byId.get(id).domain_state))) {
    return failure('CONTEXT_DOMAIN_INVALID', '/candidate_domain_ids', 'Merged or retired domains are not current routing candidates.');
  }

  const edgeKeys = new Set();
  for (const [index, edge] of input.applicable_relationships.entries()) {
    if (!isRecord(edge) || !['depends_on', 'governed_by', 'coordinates_with'].includes(edge.kind)
      || !byId.has(edge.source_id) || !byId.has(edge.target_id)) {
      return failure('CONTEXT_RELATIONSHIP_INVALID', `/applicable_relationships/${index}`, 'Applicable relationships must reference canonical map domains.');
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
  const selectedDomainIds = new Set(candidates);
  while (true) {
    let changed = false;
    for (const edge of applicableEdges) {
      if (edge.kind !== 'depends_on' || !selectedDomainIds.has(edge.source_id)
        || selectedDomainIds.has(edge.target_id)) continue;
      selectedDomainIds.add(edge.target_id);
      changed = true;
    }
    if (!changed) break;
  }
  const governingOwnerIds = new Set();
  for (const [index, edge] of applicableEdges.entries()) {
    if (!selectedDomainIds.has(edge.source_id)) {
      return failure('CONTEXT_RELATIONSHIP_INVALID', `/applicable_relationships/${index}`, 'Applicable relationship source is not task-selected or dependency-grounded.');
    }
    if (edge.kind === 'coordinates_with' && !candidates.includes(edge.target_id)) {
      return failure('CONTEXT_RELATIONSHIP_INVALID', `/applicable_relationships/${index}`, 'Coordinated domains require independent caller applicability.');
    }
    if (edge.kind === 'governed_by') governingOwnerIds.add(edge.target_id);
  }
  const selectedDomains = [...selectedDomainIds].map((id) => byId.get(id));
  if (selectedDomains.some((domain) => ['merged', 'retired'].includes(domain.domain_state))) {
    return failure('CONTEXT_DOMAIN_INVALID', '/applicable_relationships', 'Dependency-grounded domains must remain current routing domains.');
  }
  const domainOrder = [
    input.primary_domain_id,
    ...candidates.filter((id) => id !== input.primary_domain_id),
    ...uniqueSorted([...selectedDomainIds].filter((id) => !candidates.includes(id))),
  ];

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
  if (input.knowledge_baseline !== globalBaseline) evidenceGaps.push(`baseline:${input.knowledge_baseline}`);
  const derivedConflicts = [...input.conflicts];
  const selected = [];
  const verticalConstraints = map.constraints.filter((constraint) => domainOrder.some((domainId) => applicableConstraint(
      constraint,
      domainId,
      lineageOf(map.domains, domainId),
    )));
  const governingConstraints = map.constraints.filter((constraint) => (
    constraint.lifecycle_state === 'current'
    && governingOwnerIds.has(constraint.owner_id)
    && applicableEdges.some((edge) => edge.kind === 'governed_by'
      && edge.target_id === constraint.owner_id
      && !(constraint.exceptions ?? []).some(({ domain_id: exceptionId }) => exceptionId === edge.source_id))
  ));
  const constraints = [...new Map(
    [...verticalConstraints, ...governingConstraints].map((constraint) => [constraint.id, constraint]),
  ).values()].sort((left, right) => compareCodePoints(left.id, right.id));
  for (const constraint of constraints) {
    const owner = byId.get(constraint.owner_id);
    const expectedAnchor = `constraint-${constraint.id}`;
    if (!owner || owner.domain_state !== 'materialized' || !owner.paired_assets
      || constraint.knowledge_refs.en !== `${owner.paired_assets.en}#${expectedAnchor}`
      || constraint.knowledge_refs['zh-CN'] !== `${owner.paired_assets['zh-CN']}#${expectedAnchor}`) {
      return failure('CONTEXT_CONSTRAINT_INVALID', `/constraints/${constraint.id}`, 'Constraint knowledge reference must resolve to its exact current owner asset and anchor.');
    }
    try {
      const path = await resolveReadable(lifecycleRoot, owner.paired_assets.en);
      const section = await readBoundedConstraintSection(path, constraint.id, constraint.semantic_revision);
      onRead({
        level: 'L1', locator: owner.paired_assets.en, section: 'constraint-anchor', bytes_read: section.bytesRead,
      });
    } catch (error) {
      return failure(error?.code ?? 'CONTEXT_CONSTRAINT_INVALID', `/constraints/${constraint.id}`, 'Constraint owner section could not be read safely.');
    }
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
    if (!isSafeTask5Reference(frontmatter.last_verified_baseline)) {
      return failure('CONTEXT_REFERENCE_INVALID', `/domains/${domainId}/baseline`, 'Capability baseline is not a safe portable reference.');
    }
    if (frontmatter.knowledge_state !== 'current') evidenceGaps.push(`domain:${domainId}`);
    selected.push({
      kind: 'domain_asset', id: domainId,
      version_ref: `${domain.paired_assets.en}@${frontmatter.last_verified_baseline}`,
      reason: index === 0 ? 'PRIMARY' : candidates.includes(domainId) ? 'USER_EXPLICIT' : 'DEPENDENCY',
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
      const code = ['PATH_SYMLINK_ESCAPE', 'CONTEXT_TARGET_INVALID'].includes(error?.code)
        ? error.code : 'CONTEXT_TARGET_INVALID';
      return failure(code, `/task_delivery_refs/${index}`, 'Delivery Frontmatter could not be read safely.');
    }
    if (frontmatter.artifact_id !== reference.artifact_id
      || !frontmatter.domain_ids.some((id) => selectedDomainIds.has(id))
      || frontmatter.project_id_at_creation !== map.project_id
      || (frontmatter.retention_tier === 'active' && frontmatter.current_project_id !== map.project_id)) {
      return failure('CONTEXT_DELIVERY_INVALID', `/task_delivery_refs/${index}`, 'Task-linked delivery must match its ID and selected domains.');
    }
    if (!isSafeTask5Reference(frontmatter.knowledge_baseline)) {
      return failure('CONTEXT_REFERENCE_INVALID', `/task_delivery_refs/${index}/knowledge_baseline`, 'Delivery baseline is not a safe portable reference.');
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
    if (frontmatter.retention_tier === 'closed-summary') {
      if (!exclusionIds.has(reference.artifact_id)) {
        exclusions.push({
          id: reference.artifact_id,
          reason: 'OUT_OF_SCOPE',
          explanation: 'Closed summaries are locators, not active task context.',
        });
        exclusionIds.add(reference.artifact_id);
      }
      continue;
    }
    if (frontmatter.retention_tier !== 'active') continue;
    if (frontmatter.knowledge_baseline !== input.knowledge_baseline
      || frontmatter.knowledge_baseline !== globalBaseline) {
      if (!exclusionIds.has(reference.artifact_id)) {
        exclusions.push({
          id: reference.artifact_id,
          reason: 'STALE',
          explanation: 'Active delivery is pinned to a different knowledge baseline.',
        });
        exclusionIds.add(reference.artifact_id);
      }
      derivedConflicts.push(`delivery-baseline:${reference.artifact_id}`);
      continue;
    }
    selected.push({
      kind: 'active_delivery', id: reference.artifact_id,
      version_ref: `${reference.locator}@${frontmatter.knowledge_baseline}`,
      reason: 'ACTIVE_CHANGE',
    });
  }

  const openQuestions = uniqueSorted(input.open_questions);
  const conflicts = uniqueSorted(derivedConflicts);
  const sortedEvidenceGaps = uniqueSorted(evidenceGaps);
  const materialExclusions = [...exclusions]
    .sort((left, right) => compareCodePoints(left.id, right.id));
  if (selected.length > 100 || materialExclusions.length > 100) {
    return failure('CONTEXT_SELECTION_LIMIT', '/', 'Bounded context selection exceeds the shared receipt limits.');
  }
  const selectedContext = selected.sort((left, right) => compareCodePoints(left.id, right.id));
  const selectedIds = new Set();
  for (const selection of selectedContext) {
    if (selectedIds.has(selection.id)) {
      return failure('CONTEXT_SELECTION_CONFLICT', '/selected_context', 'Selected context IDs must be unique across all kinds.');
    }
    selectedIds.add(selection.id);
  }
  const stop = stopFor({ conflicts, openQuestions, evidenceGaps: sortedEvidenceGaps });
  const value = {
    knowledge_baseline: input.knowledge_baseline,
    primary_domain_id: input.primary_domain_id,
    affected_domain_ids: uniqueSorted([...selectedDomainIds]),
    selected_context: selectedContext,
    material_exclusions: materialExclusions,
    open_questions: openQuestions,
    stop,
  };
  const receiptValidation = validateJson('context-receipt', {
    schema_version: 1,
    prd_id: 'prd-context-selection',
    receipt_revision: 1,
    updated_at: '2000-01-01T00:00:00Z',
    knowledge_baseline: value.knowledge_baseline,
    intent_summary: 'Bounded task context selection.',
    route: { primary_domain_id: value.primary_domain_id, affected_domain_ids: value.affected_domain_ids },
    selected_context: value.selected_context,
    material_exclusions: value.material_exclusions,
    open_questions: value.open_questions,
    stop: value.stop,
  });
  if (!receiptValidation.ok) {
    return failure('CONTEXT_SELECTION_CONFLICT', '/selected_context', 'Selected context violates the shared Context Receipt invariants.');
  }
  return ok(value);
}
