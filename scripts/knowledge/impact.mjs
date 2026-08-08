import { createHash } from 'node:crypto';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const impactFailure = (code, path, message) => fail([createError(code, path, message)]);

export const hashProjectMap = (map) => (
  `sha256:${createHash('sha256').update(stableJson(map)).digest('hex')}`
);

const descendantsOf = (map, ancestorId) => {
  const children = new Map();
  for (const domain of map.domains) {
    if (!domain.parent_id) continue;
    const current = children.get(domain.parent_id) ?? [];
    current.push(domain.id);
    children.set(domain.parent_id, current);
  }
  const result = [];
  const queue = [...(children.get(ancestorId) ?? [])].sort(compareCodePoints);
  const seen = new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    queue.push(...(children.get(id) ?? []).sort(compareCodePoints));
  }
  return result.sort(compareCodePoints);
};

const uniqueSorted = (values) => [...new Set(values)].sort(compareCodePoints);
const domainById = (map, id) => map.domains.find((domain) => domain.id === id);
const constraintById = (map, id) => map.constraints.find((constraint) => constraint.id === id);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const changedIds = (currentEntries, candidateEntries) => {
  const current = new Map(currentEntries.map((entry) => [entry.id, entry]));
  const candidate = new Map(candidateEntries.map((entry) => [entry.id, entry]));
  return uniqueSorted([...new Set([...current.keys(), ...candidate.keys()])]
    .filter((id) => !same(current.get(id), candidate.get(id))));
};

const changedKeys = (current, candidate) => uniqueSorted([
  ...new Set([...Object.keys(current ?? {}), ...Object.keys(candidate ?? {})]),
].filter((key) => key !== 'id' && !same(current?.[key], candidate?.[key])));

const domainFieldForKey = (key) => ({
  baseline: 'boundary',
  domain_state: 'lifecycle',
  evidence_refs: 'boundary',
  kind: 'kind',
  known_gaps: 'boundary',
  label: 'label',
  paired_assets: 'boundary',
  parent_id: 'parentage',
  purpose: 'boundary',
  relationships: 'relationship',
  retirement_reason: 'lifecycle',
  scope: 'boundary',
  successor_id: 'lifecycle',
})[key];

const constraintFieldForKey = (key) => ({
  exceptions: 'exception',
  knowledge_refs: 'constraint_meaning',
  lifecycle_state: 'lifecycle',
  owner_id: 'constraint_owner',
  retirement_reason_ref: 'lifecycle',
  scope: 'constraint_scope',
  selected_descendants: 'constraint_scope',
  semantic_revision: 'constraint_meaning',
  successor_ids: 'lifecycle',
})[key];

const exactSet = (left, right) => same(uniqueSorted(left), uniqueSorted(right));

const operationFields = {
  ADD_CONSTRAINT: ['constraint_meaning', 'constraint_owner', 'constraint_scope'],
  ADD_DOMAIN: ['boundary', 'kind', 'lifecycle', 'parentage'],
  ADD_EXCEPTION: ['exception'],
  ADD_RELATIONSHIP: ['relationship'],
  MERGE_DOMAIN: ['lifecycle'],
  REPLACE_CONSTRAINT: ['constraint_meaning', 'lifecycle'],
};

const validateOperationDiff = ({
  currentMap,
  candidateMap,
  changeClass,
  operation,
  targetId,
  changedFields,
  childDispositions,
}) => {
  const domainChanges = changedIds(currentMap.domains, candidateMap.domains);
  const constraintChanges = changedIds(currentMap.constraints, candidateMap.constraints);
  const currentDomain = domainById(currentMap, targetId);
  const candidateDomain = domainById(candidateMap, targetId);
  const currentConstraint = constraintById(currentMap, targetId);
  const candidateConstraint = constraintById(candidateMap, targetId);

  if (operation === 'ADD_RELATIONSHIP') {
    if (!currentDomain || !candidateDomain
      || !exactSet(domainChanges, [targetId]) || constraintChanges.length > 0
      || !exactSet(changedKeys(currentDomain, candidateDomain), ['relationships'])
      || !exactSet(changedFields, ['relationship'])) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map', 'ADD_RELATIONSHIP may add only one declared horizontal edge.');
    }
    const currentEdges = currentDomain.relationships.map((edge) => JSON.stringify(edge));
    const candidateEdges = candidateDomain.relationships.map((edge) => JSON.stringify(edge));
    const added = candidateEdges.filter((edge) => !currentEdges.includes(edge));
    const removed = currentEdges.filter((edge) => !candidateEdges.includes(edge));
    if (added.length !== 1 || removed.length !== 0) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/domains', 'ADD_RELATIONSHIP requires exactly one added edge.');
    }
  } else if (operation === 'ADD_DOMAIN') {
    if (currentDomain || !candidateDomain || !exactSet(domainChanges, [targetId])
      || constraintChanges.length > 0 || candidateDomain.relationships.length > 0
      || !exactSet(changedFields, operationFields.ADD_DOMAIN)) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/domains', 'ADD_DOMAIN may add exactly one evidenced target node.');
    }
  } else if (operation === 'UPDATE_DOMAIN') {
    const actualFields = changedKeys(currentDomain, candidateDomain).map(domainFieldForKey);
    if (!currentDomain || !candidateDomain
      || !exactSet(domainChanges, [targetId]) || constraintChanges.length > 0
      || actualFields.includes(undefined) || !exactSet(actualFields, changedFields)) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/domains', 'UPDATE_DOMAIN must match its declared semantic fields.');
    }
  } else if (operation === 'MERGE_DOMAIN') {
    const allowed = [targetId, ...childDispositions.map(({ domain_id: id }) => id)];
    const parentKeys = changedKeys(currentDomain, candidateDomain);
    if (!currentDomain || !candidateDomain
      || domainChanges.some((id) => !allowed.includes(id)) || constraintChanges.length > 0
      || !exactSet(parentKeys, ['domain_state', 'successor_id'])
      || !exactSet(changedFields, operationFields.MERGE_DOMAIN)) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/domains', 'MERGE_DOMAIN may change only the parent and reviewed children.');
    }
  } else if (operation === 'ADD_CONSTRAINT') {
    if (currentConstraint || !candidateConstraint || domainChanges.length > 0
      || !exactSet(constraintChanges, [targetId])
      || !exactSet(changedFields, operationFields.ADD_CONSTRAINT)) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/constraints', 'ADD_CONSTRAINT may add exactly one new identity.');
    }
  } else if (operation === 'ADD_EXCEPTION') {
    if (!currentConstraint || !candidateConstraint
      || domainChanges.length > 0 || !exactSet(constraintChanges, [targetId])
      || !exactSet(changedKeys(currentConstraint, candidateConstraint), ['exceptions', 'semantic_revision'])
      || !exactSet(changedFields, operationFields.ADD_EXCEPTION)) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/constraints', 'ADD_EXCEPTION may change only the exact reviewed exception set.');
    }
    const currentExceptions = currentConstraint.exceptions.map((entry) => JSON.stringify(entry));
    const candidateExceptions = candidateConstraint.exceptions.map((entry) => JSON.stringify(entry));
    const added = candidateExceptions.filter((entry) => !currentExceptions.includes(entry));
    const removed = currentExceptions.filter((entry) => !candidateExceptions.includes(entry));
    const isAddition = added.length === 1 && removed.length === 0;
    const isUpdate = added.length === 1 && removed.length === 1
      && JSON.parse(added[0]).domain_id === JSON.parse(removed[0]).domain_id;
    if (!isAddition && !isUpdate) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/constraints', 'ADD_EXCEPTION requires exactly one added or updated reviewed exception.');
    }
  } else if (operation === 'UPDATE_CONSTRAINT') {
    if (!currentConstraint || !candidateConstraint) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/constraints', 'UPDATE_CONSTRAINT requires one existing reviewed constraint target.');
    }
    if (changeClass === 'WORDING') {
      return domainChanges.length === 0 && constraintChanges.length === 0
        && exactSet(changedFields, ['label'])
        ? ok(null)
        : impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/constraints', 'Constraint WORDING may change only paired wording content.');
    }
    const constraintKeys = changedKeys(currentConstraint, candidateConstraint);
    const actualFields = constraintKeys
      .filter((key) => key !== 'semantic_revision')
      .map(constraintFieldForKey);
    if (actualFields.length === 0 && constraintKeys.includes('semantic_revision')) {
      actualFields.push('constraint_meaning');
    }
    if (domainChanges.length > 0 || !exactSet(constraintChanges, [targetId])
      || actualFields.includes(undefined) || !exactSet(actualFields, changedFields)) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/constraints', 'Constraint update must match its declared semantic fields.');
    }
  } else if (operation === 'REPLACE_CONSTRAINT') {
    const allowed = [targetId, ...(candidateConstraint?.successor_ids ?? [])];
    const retiredKeys = changedKeys(currentConstraint, candidateConstraint);
    if (!currentConstraint || !candidateConstraint
      || domainChanges.length > 0 || !exactSet(constraintChanges, allowed)
      || !exactSet(retiredKeys, ['lifecycle_state', 'retirement_reason_ref', 'successor_ids'])
      || !exactSet(changedFields, operationFields.REPLACE_CONSTRAINT)) {
      return impactFailure('CHANGE_NOT_BOUNDED', '/candidate_map/constraints', 'REPLACE_CONSTRAINT may change only the retired identity and reviewed successors.');
    }
  }
  return ok(null);
};

const validateBoundedCandidate = ({ currentMap, candidateMap, changeClass, operation, targetId, changedFields, childDispositions }) => {
  if (!operation) return ok(null);
  for (const field of ['schema_version', 'project_id', 'knowledge_baseline', 'project_identity', 'identity_lineage', 'repositories']) {
    if (!same(currentMap[field], candidateMap[field])) {
      return impactFailure('CHANGE_NOT_BOUNDED', `/candidate_map/${field}`, 'One proposal cannot bundle an unrelated governance mutation.');
    }
  }

  const constraintOperation = operation.includes('CONSTRAINT') || operation === 'ADD_EXCEPTION';
  const allowedDomains = new Set();
  const allowedConstraints = new Set();
  if (constraintOperation) {
    allowedConstraints.add(targetId);
    const target = constraintById(candidateMap, targetId);
    for (const successorId of target?.successor_ids ?? []) allowedConstraints.add(successorId);
    const predecessor = candidateMap.constraints.find(({ successor_ids: ids }) => ids?.includes(targetId));
    if (predecessor) allowedConstraints.add(predecessor.id);
  } else {
    allowedDomains.add(targetId);
    for (const disposition of childDispositions) allowedDomains.add(disposition.domain_id);
  }

  const unboundedDomain = changedIds(currentMap.domains, candidateMap.domains)
    .find((id) => !allowedDomains.has(id));
  if (unboundedDomain) {
    return impactFailure('CHANGE_NOT_BOUNDED', `/candidate_map/domains/${unboundedDomain}`, 'One proposal cannot bundle an unrelated domain mutation.');
  }
  const unboundedConstraint = changedIds(currentMap.constraints, candidateMap.constraints)
    .find((id) => !allowedConstraints.has(id));
  if (unboundedConstraint) {
    return impactFailure('CHANGE_NOT_BOUNDED', `/candidate_map/constraints/${unboundedConstraint}`, 'One proposal cannot bundle an unrelated constraint mutation.');
  }
  return validateOperationDiff({ currentMap, candidateMap, changeClass, operation, targetId, changedFields, childDispositions });
};

const constraintTargets = (map, constraint) => {
  if (!constraint) return [];
  if (constraint.scope === 'self') return [constraint.owner_id];
  if (constraint.scope === 'selected_descendants') {
    return uniqueSorted([constraint.owner_id, ...(constraint.selected_descendants ?? [])]);
  }
  return uniqueSorted([constraint.owner_id, ...descendantsOf(map, constraint.owner_id)]);
};

const validateNewDomainEvidence = (currentMap, candidateMap, targetId) => {
  if (domainById(currentMap, targetId)) return ok(null);
  const candidate = domainById(candidateMap, targetId);
  if (!candidate) return ok(null);
  if (candidate.evidence_refs.length === 0) {
    return impactFailure(
      'TOPOLOGY_EVIDENCE_REQUIRED',
      `/domains/${targetId}/evidence_refs`,
      'A new child boundary requires authoritative evidence.',
    );
  }
  return ok(null);
};

const validateSemanticRevision = (current, candidate) => {
  if (!current || !candidate) {
    return impactFailure('REFERENCE_MISSING', '/target_id', 'Constraint target is missing.');
  }
  if (candidate.semantic_revision !== current.semantic_revision + 1) {
    return impactFailure(
      'CONSTRAINT_REVISION_INVALID',
      '/candidate_map/semantic_revision',
      'A semantic constraint change must increment exactly one revision.',
    );
  }
  return ok(null);
};

const validateReplacement = (currentMap, candidateMap, targetId) => {
  const current = constraintById(currentMap, targetId);
  const retired = constraintById(candidateMap, targetId);
  if (!current || !retired || retired.lifecycle_state !== 'retired'
    || !Array.isArray(retired.successor_ids) || retired.successor_ids.length === 0) {
    return impactFailure(
      'CONSTRAINT_REPLACEMENT_INVALID',
      '/candidate_map/constraints',
      'Replacement must retain the old ID as a retired historical redirect.',
    );
  }
  for (const successorId of retired.successor_ids) {
    if (constraintById(currentMap, successorId)) {
      return impactFailure(
        'CONSTRAINT_ID_REUSE',
        '/candidate_map/constraints',
        'Replacement IDs must be new and retired IDs are never reusable.',
      );
    }
    const successor = constraintById(candidateMap, successorId);
    if (!successor || successor.lifecycle_state !== 'current' || successor.semantic_revision !== 1) {
      return impactFailure(
        'CONSTRAINT_REPLACEMENT_INVALID',
        '/candidate_map/constraints',
        'Every replacement successor must start as a new current identity.',
      );
    }
  }
  return ok(null);
};

const validateParentClosure = ({ currentMap, candidateMap, targetId, childDispositions }) => {
  const current = domainById(currentMap, targetId);
  const candidate = domainById(candidateMap, targetId);
  if (!current || !candidate || !['merged', 'retired'].includes(candidate.domain_state)) return ok(null);
  const activeChildren = currentMap.domains
    .filter((domain) => domain.parent_id === targetId && ['confirmed', 'materialized'].includes(domain.domain_state))
    .map(({ id }) => id)
    .sort(compareCodePoints);
  const dispositions = new Map((childDispositions ?? []).map((entry) => [entry.domain_id, entry]));
  if (activeChildren.some((id) => !dispositions.has(id))) {
    return impactFailure(
      'TOPOLOGY_CHILD_DISPOSITION_REQUIRED',
      '/child_dispositions',
      'Every active child requires an explicit reviewed disposition.',
    );
  }
  for (const childId of activeChildren) {
    const disposition = dispositions.get(childId);
    const currentChild = domainById(currentMap, childId);
    const child = domainById(candidateMap, childId);
    if (!child) {
      return impactFailure('TOPOLOGY_ORPHAN_REJECTED', `/child_dispositions/${childId}`, 'A child cannot disappear during parent closure.');
    }
    if (disposition.disposition === 'REPARENT') {
      if (!disposition.target_id) {
        return impactFailure('TOPOLOGY_DISPOSITION_MISMATCH', `/child_dispositions/${childId}`, 'REPARENT requires an explicit reviewed target.');
      }
      const expectedParent = disposition.target_id === childId ? null : disposition.target_id;
      const parent = domainById(candidateMap, expectedParent);
      if (!exactSet(changedKeys(currentChild, child), ['parent_id'])
        || child.parent_id !== expectedParent
        || (expectedParent && !['confirmed', 'materialized'].includes(parent?.domain_state))) {
        return impactFailure('CHANGE_NOT_BOUNDED', `/child_dispositions/${childId}`, 'REPARENT may change only the reviewed parent ID.');
      }
    } else if (disposition.disposition === 'MERGE') {
      const expectedSuccessor = disposition.target_id;
      if (!exactSet(changedKeys(currentChild, child), ['domain_state', 'successor_id'])) {
        return impactFailure('CHANGE_NOT_BOUNDED', `/child_dispositions/${childId}`, 'MERGE may change only lifecycle and successor fields.');
      }
      if (child.domain_state !== 'merged'
        || !expectedSuccessor
        || child.successor_id !== expectedSuccessor
        || (candidate.successor_id && expectedSuccessor !== candidate.successor_id)) {
        return impactFailure('TOPOLOGY_DISPOSITION_MISMATCH', `/child_dispositions/${childId}`, 'Candidate merge must redirect to the reviewed parent successor.');
      }
    } else if (disposition.disposition === 'RETIRE') {
      if (!exactSet(changedKeys(currentChild, child), ['domain_state', 'retirement_reason'])) {
        return impactFailure('CHANGE_NOT_BOUNDED', `/child_dispositions/${childId}`, 'RETIRE may change only lifecycle and retirement-reason fields.');
      }
      if (child.domain_state !== 'retired') {
        return impactFailure('TOPOLOGY_DISPOSITION_MISMATCH', `/child_dispositions/${childId}`, 'Candidate retirement does not match the reviewed disposition.');
      }
    } else if (disposition.disposition === 'SPLIT') {
      const splitTarget = domainById(candidateMap, disposition.target_id);
      if (child.domain_state !== 'merged'
        || child.successor_id !== disposition.target_id
        || !['confirmed', 'materialized'].includes(splitTarget?.domain_state)
        || splitTarget.parent_id === targetId) {
        return impactFailure('TOPOLOGY_DISPOSITION_MISMATCH', `/child_dispositions/${childId}`, 'Candidate split must retire the prior child and route to a reviewed active target.');
      }
      if (!exactSet(changedKeys(currentChild, child), ['domain_state', 'successor_id'])) {
        return impactFailure('CHANGE_NOT_BOUNDED', `/child_dispositions/${childId}`, 'SPLIT may change only lifecycle and the reviewed successor redirect.');
      }
    } else if (['NO_CHANGE', 'REVALIDATE', 'EXCEPTION'].includes(disposition.disposition)) {
      if (changedKeys(currentChild, child).length > 0) {
        return impactFailure('CHANGE_NOT_BOUNDED', `/child_dispositions/${childId}`, 'A non-mutating disposition cannot hide child changes.');
      }
      return impactFailure('TOPOLOGY_DISPOSITION_MISMATCH', `/child_dispositions/${childId}`, 'An active child cannot remain below a closed parent.');
    }
    if (!['merged', 'retired'].includes(child.domain_state) && child.parent_id === targetId) {
      return impactFailure('TOPOLOGY_DISPOSITION_MISMATCH', `/child_dispositions/${childId}`, 'A closed parent cannot retain active children.');
    }
  }
  return ok(null);
};

export const analyzeImpact = ({
  current_map: currentMap,
  candidate_map: candidateMap,
  change_class: changeClass,
  changed_fields: changedFields,
  target_id: targetId,
  child_dispositions: childDispositions = [],
  operation,
}) => {
  const currentValidation = validateJson('project-map', currentMap);
  if (!currentValidation.ok) return currentValidation;
  const candidateValidation = validateJson('project-map', candidateMap);
  if (!candidateValidation.ok) return candidateValidation;

  if (operation === 'ADD_EXCEPTION' && changeClass === 'SEMANTIC') {
    const revision = validateSemanticRevision(
      constraintById(currentMap, targetId),
      constraintById(candidateMap, targetId),
    );
    if (!revision.ok) return revision;
  }

  if (operation === 'ADD_CONSTRAINT'
    && constraintById(currentMap, targetId)?.lifecycle_state === 'retired') {
    return impactFailure('CONSTRAINT_ID_REUSE', '/candidate_map/constraints', 'A retired constraint ID cannot be reused.');
  }

  const bounded = validateBoundedCandidate({
    currentMap,
    candidateMap,
    changeClass,
    operation,
    targetId,
    changedFields,
    childDispositions,
  });
  if (!bounded.ok) return bounded;

  const evidence = validateNewDomainEvidence(currentMap, candidateMap, targetId);
  if (!evidence.ok) return evidence;

  const currentConstraint = constraintById(currentMap, targetId);
  const candidateConstraint = constraintById(candidateMap, targetId);
  if (changeClass === 'WORDING') {
    const machineFields = new Set(['boundary', 'constraint_meaning', 'constraint_owner', 'constraint_scope', 'exception', 'kind', 'lifecycle', 'parentage', 'relationship']);
    if (changedFields.some((field) => machineFields.has(field))) {
      return impactFailure(
        'CONSTRAINT_CHANGE_CLASS_INVALID',
        '/change_class',
        'WORDING cannot alter routing or semantic machine fields.',
      );
    }
    if (currentConstraint || candidateConstraint) {
      if (!same(currentConstraint, candidateConstraint)) {
        return impactFailure(
          'CONSTRAINT_CHANGE_CLASS_INVALID',
          '/change_class',
          'WORDING must leave constraint routing metadata and semantic revision unchanged.',
        );
      }
    } else {
      const currentDomain = clone(domainById(currentMap, targetId));
      const candidateDomain = clone(domainById(candidateMap, targetId));
      if (currentDomain && candidateDomain) {
        delete currentDomain.label;
        delete candidateDomain.label;
        if (!same(currentDomain, candidateDomain)) {
          return impactFailure(
            'CONSTRAINT_CHANGE_CLASS_INVALID',
            '/change_class',
            'A label-only wording change cannot alter domain routing metadata.',
          );
        }
      }
    }
    return ok({
      affected_domain_ids: [currentConstraint?.owner_id ?? targetId],
      horizontal_target_ids: [],
      lineage_descendant_ids: [],
      requires_descendant_review: false,
    });
  }

  if (currentConstraint || candidateConstraint) {
    if (operation === 'ADD_CONSTRAINT') {
      if (currentConstraint?.lifecycle_state === 'retired') {
        return impactFailure(
          'CONSTRAINT_ID_REUSE',
          '/candidate_map/constraints',
          'A retired constraint ID cannot be reused.',
        );
      }
      if (currentConstraint || !candidateConstraint
        || candidateConstraint.lifecycle_state !== 'current'
        || candidateConstraint.semantic_revision !== 1) {
        return impactFailure(
          'CONSTRAINT_NEW_ID_INVALID',
          '/candidate_map/constraints',
          'A new constraint ID must be unused and start at semantic revision one.',
        );
      }
    } else if (changeClass === 'SEMANTIC') {
      const revision = validateSemanticRevision(currentConstraint, candidateConstraint);
      if (!revision.ok) return revision;
    } else if (changeClass === 'REPLACEMENT') {
      const replacement = validateReplacement(currentMap, candidateMap, targetId);
      if (!replacement.ok) return replacement;
    }
    let affected = uniqueSorted([
      ...constraintTargets(currentMap, currentConstraint),
      ...constraintTargets(candidateMap, candidateConstraint),
    ]);
    if (changedFields.includes('exception')) {
      const currentExceptions = new Map((currentConstraint?.exceptions ?? [])
        .map((entry) => [entry.domain_id, entry]));
      const changedExceptions = (candidateConstraint?.exceptions ?? [])
        .filter((entry) => !same(currentExceptions.get(entry.domain_id), entry))
        .map(({ domain_id: id }) => id);
      affected = uniqueSorted([candidateConstraint?.owner_id ?? currentConstraint.owner_id, ...changedExceptions]);
      for (const exceptionId of changedExceptions) {
        const disposition = childDispositions.find(({ domain_id: id }) => id === exceptionId);
        if (disposition?.disposition !== 'EXCEPTION' || !disposition.exception_ref) {
          return impactFailure('CONSTRAINT_EXCEPTION_APPROVAL_REQUIRED', '/child_dispositions', 'A constraint exception requires an explicit reviewed disposition.');
        }
      }
    }
    return ok({
      affected_domain_ids: affected,
      horizontal_target_ids: [],
      lineage_descendant_ids: affected.filter((id) => id !== (candidateConstraint?.owner_id ?? currentConstraint.owner_id)),
      requires_descendant_review: affected.length > 1,
    });
  }

  const currentDomain = domainById(currentMap, targetId);
  const candidateDomain = domainById(candidateMap, targetId);
  const domain = candidateDomain ?? currentDomain;
  if (!domain) return impactFailure('REFERENCE_MISSING', '/target_id', 'Topology target is missing.');

  const parentClosure = validateParentClosure({ currentMap, candidateMap, targetId, childDispositions });
  if (!parentClosure.ok) return parentClosure;
  const lineageDescendants = descendantsOf(currentMap, targetId);
  const relationshipTargets = operation === 'ADD_RELATIONSHIP'
    ? uniqueSorted((candidateDomain.relationships ?? [])
      .filter((edge) => !(currentDomain.relationships ?? []).some((currentEdge) => same(currentEdge, edge)))
      .map(({ target_id: id }) => id))
    : uniqueSorted((domain.relationships ?? []).map(({ target_id: id }) => id));
  const horizontalOnly = changedFields.length === 1 && changedFields[0] === 'relationship';
  const propagating = changedFields.some((field) => ['boundary', 'kind', 'lifecycle', 'parentage'].includes(field));
  return ok({
    affected_domain_ids: horizontalOnly
      ? uniqueSorted([targetId, ...relationshipTargets])
      : uniqueSorted([targetId, ...(propagating ? lineageDescendants : [])]),
    horizontal_target_ids: horizontalOnly ? relationshipTargets : [],
    lineage_descendant_ids: propagating ? lineageDescendants : [],
    requires_descendant_review: propagating && lineageDescendants.length > 0,
  });
};

export const cloneProjectMap = clone;
