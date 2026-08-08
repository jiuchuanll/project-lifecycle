import { ERROR_CODES, createError } from './errors.mjs';
import { codePointOrderErrors } from './deterministic-order.mjs';
import { fail, ok } from './result.mjs';
import { getSchemaValidator } from './schema-registry.mjs';

const pointerToken = (token) => String(token).replaceAll('~', '~0').replaceAll('/', '~1');
const propertyPath = (instancePath, property) => `${instancePath}/${pointerToken(property)}`;

const schemaErrors = (kind, errors) => errors.map((error) => {
  const path = error.keyword === 'required'
    ? propertyPath(error.instancePath, error.params.missingProperty)
    : error.keyword === 'additionalProperties'
      ? propertyPath(error.instancePath, error.params.additionalProperty)
      : error.instancePath || '/';
  return createError(ERROR_CODES.SCHEMA_INVALID, path, `Invalid ${kind}: ${error.message}`);
});

const namedEntries = (value) => [
  ...value.repositories.map((entry, index) => ({ ...entry, path: `/repositories/${index}` })),
  ...value.constraints.map((entry, index) => ({ ...entry, path: `/constraints/${index}` })),
  ...value.domains.map((entry, index) => ({ ...entry, path: `/domains/${index}` })),
];

const isStrictScope = (parent, child) => child.every((item) => parent.includes(item))
  && child.length < parent.length;

const isDescendant = (domainById, ancestorId, candidateId) => {
  let current = domainById.get(candidateId);
  const visited = new Set();
  while (current?.parent_id) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (current.parent_id === ancestorId) return true;
    current = domainById.get(current.parent_id);
  }
  return false;
};

const validateProjectMap = (value) => {
  const errors = [];
  const entries = namedEntries(value);
  const entriesById = new Map();
  const domainById = new Map();

  for (const entry of entries) {
    if (entriesById.has(entry.id)) {
      errors.push(createError(ERROR_CODES.ID_DUPLICATE, `${entry.path}/id`, `Duplicate ID: ${entry.id}`));
    } else {
      entriesById.set(entry.id, entry);
    }
  }

  for (const [index, domain] of value.domains.entries()) {
    if (!domainById.has(domain.id)) domainById.set(domain.id, domain);
    const path = `/domains/${index}`;

    if (domain.domain_state === 'materialized') {
      if (!domain.paired_assets) {
        errors.push(createError(ERROR_CODES.STATE_REQUIREMENT_MISSING, `${path}/paired_assets`, 'Materialized domains require paired_assets.'));
      }
      if (!domain.baseline) {
        errors.push(createError(ERROR_CODES.STATE_REQUIREMENT_MISSING, `${path}/baseline`, 'Materialized domains require a baseline.'));
      }
    }
    if (domain.domain_state === 'retired' && !domain.retirement_reason) {
      errors.push(createError(ERROR_CODES.STATE_REQUIREMENT_MISSING, `${path}/retirement_reason`, 'Retired domains require a retirement_reason.'));
    }
    if (domain.domain_state === 'merged' && !domain.successor_id) {
      errors.push(createError(ERROR_CODES.STATE_REQUIREMENT_MISSING, `${path}/successor_id`, 'Merged domains require a successor redirect.'));
    }
    if (domain.domain_state !== 'merged' && domain.successor_id) {
      errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `${path}/successor_id`, 'Only merged domains may declare a successor redirect.'));
    }
  }

  for (const [index, domain] of value.domains.entries()) {
    const path = `/domains/${index}`;
    if (domain.parent_id) {
      const parent = domainById.get(domain.parent_id);
      if (!parent) {
        errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `${path}/parent_id`, `Unknown parent ID: ${domain.parent_id}`));
      } else if (!isStrictScope(parent.scope.includes, domain.scope.includes)) {
        errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `${path}/scope/includes`, 'Child scope must be a strict subset of its parent scope.'));
      }
    }
    for (const [relationshipIndex, relationship] of domain.relationships.entries()) {
      if (!entriesById.has(relationship.target_id)) {
        errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `${path}/relationships/${relationshipIndex}/target_id`, `Unknown relationship target ID: ${relationship.target_id}`));
      }
    }
    if (domain.domain_state === 'merged' && domain.successor_id) {
      const successor = domainById.get(domain.successor_id);
      if (domain.successor_id === domain.id) {
        errors.push(createError(
          ERROR_CODES.SCHEMA_INVALID,
          `${path}/successor_id`,
          'Merged domain successor must differ from its own ID.',
        ));
      } else if (!successor) {
        errors.push(createError(
          ERROR_CODES.REFERENCE_MISSING,
          `${path}/successor_id`,
          'Merged domain successor is absent from the project map.',
        ));
      } else if (!['confirmed', 'materialized'].includes(successor.domain_state)) {
        errors.push(createError(
          ERROR_CODES.SCHEMA_INVALID,
          `${path}/successor_id`,
          'Merged domain successor must be routable.',
        ));
      }
    }
  }

  for (const [index, constraint] of value.constraints.entries()) {
    if (constraint.scope !== 'selected_descendants') continue;
    const path = `/constraints/${index}`;
    const owner = domainById.get(constraint.owner_id);
    if (!owner) {
      errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `${path}/owner_id`, `Unknown constraint owner ID: ${constraint.owner_id}`));
      continue;
    }
    for (const [selectedIndex, selectedId] of constraint.selected_descendants.entries()) {
      if (!domainById.has(selectedId)) {
        errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `${path}/selected_descendants/${selectedIndex}`, `Unknown selected descendant ID: ${selectedId}`));
      } else if (!isDescendant(domainById, constraint.owner_id, selectedId)) {
        errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `${path}/selected_descendants/${selectedIndex}`, 'Selected descendant must be below its constraint owner.'));
      }
    }
  }

  return errors;
};

const validateProjectExtensions = (value) => {
  const errors = [];
  const extensionId = new RegExp(`^PROJECT::${value.project_id}::[A-Z][A-Z0-9_]*_REQUIRED$`);

  for (const [index, entry] of value.secondary_obligation_kinds.entries()) {
    const path = `/secondary_obligation_kinds/${index}`;
    if (!extensionId.test(entry)) {
      errors.push(createError(ERROR_CODES.SCHEMA_INVALID, path, 'Extension ID must use the current project namespace and REQUIRED suffix.'));
    }
  }

  return errors;
};

const validateContextReceipt = (value) => {
  const errors = [];
  const selectedIds = new Set();

  for (const [index, selection] of value.selected_context.entries()) {
    const path = `/selected_context/${index}/id`;
    if (selectedIds.has(selection.id)) {
      errors.push(createError(ERROR_CODES.ID_DUPLICATE, path, `Duplicate selected context ID: ${selection.id}`));
    } else {
      selectedIds.add(selection.id);
    }
  }

  return errors;
};

const appendOrderErrors = (errors, items, basePath, field) => {
  errors.push(...codePointOrderErrors(items, {
    valueAt: field ? (item) => item[field] : (item) => item,
    pathAt: (index) => `${basePath}/${index}${field ? `/${field}` : ''}`,
  }));
};

const validateDeterministicOrder = (kind, value) => {
  const errors = [];

  if (kind === 'project-map') {
    appendOrderErrors(errors, value.constraints, '/constraints', 'id');
    appendOrderErrors(errors, value.domains, '/domains', 'id');
    for (const [index, constraint] of value.constraints.entries()) {
      if (constraint.selected_descendants) {
        appendOrderErrors(errors, constraint.selected_descendants, `/constraints/${index}/selected_descendants`);
      }
    }
    for (const [index, domain] of value.domains.entries()) {
      appendOrderErrors(errors, domain.relationships, `/domains/${index}/relationships`, 'target_id');
      appendOrderErrors(errors, domain.evidence_refs, `/domains/${index}/evidence_refs`);
    }
  } else if (kind === 'project-extensions') {
    appendOrderErrors(errors, value.secondary_obligation_kinds, '/secondary_obligation_kinds');
  } else if (kind === 'context-receipt') {
    appendOrderErrors(errors, value.route.affected_domain_ids, '/route/affected_domain_ids');
    appendOrderErrors(errors, value.selected_context, '/selected_context', 'id');
    appendOrderErrors(errors, value.material_exclusions, '/material_exclusions', 'id');
  } else if (kind === 'archive-access-receipt') {
    appendOrderErrors(errors, value.artifact_ids, '/artifact_ids');
    appendOrderErrors(errors, value.scope.domain_ids, '/scope/domain_ids');
    appendOrderErrors(errors, value.returned_artifacts, '/returned_artifacts', 'artifact_id');
  } else if (kind === 'delivery-frontmatter') {
    appendOrderErrors(errors, value.domain_ids, '/domain_ids');
    appendOrderErrors(errors, value.relationships.feedback_ids, '/relationships/feedback_ids');
    appendOrderErrors(errors, value.relationships.prd_ids, '/relationships/prd_ids');
    appendOrderErrors(errors, value.relationships.legacy_artifact_refs, '/relationships/legacy_artifact_refs');
    appendOrderErrors(errors, value.reclassified_from_refs, '/reclassified_from_refs');
    appendOrderErrors(errors, value.obligations, '/obligations', 'obligation_id');
    for (const [index, obligation] of value.obligations.entries()) {
      for (const field of ['trigger_refs', 'scope_refs', 'responsible_refs', 'evidence_refs']) {
        appendOrderErrors(errors, obligation[field], `/obligations/${index}/${field}`);
      }
    }
  } else if (kind === 'obligation-instance') {
    for (const field of ['trigger_refs', 'scope_refs', 'responsible_refs', 'evidence_refs']) {
      appendOrderErrors(errors, value[field], `/${field}`);
    }
  } else if (kind === 'knowledge-diff') {
    appendOrderErrors(errors, value.operations, '/operations', 'fact_id');
    appendOrderErrors(errors, value.domain_changes, '/domain_changes', 'domain_id');
    appendOrderErrors(errors, value.entry_points, '/entry_points');
    appendOrderErrors(errors, value.evidence_refs, '/evidence_refs');
    for (const [index, operation] of value.operations.entries()) {
      appendOrderErrors(errors, operation.evidence_refs, `/operations/${index}/evidence_refs`);
    }
    for (const [index, change] of value.domain_changes.entries()) {
      if (change.relationship_refs) {
        appendOrderErrors(errors, change.relationship_refs, `/domain_changes/${index}/relationship_refs`);
      }
      appendOrderErrors(errors, change.evidence_refs, `/domain_changes/${index}/evidence_refs`);
    }
  } else if (kind === 'pending-changes') {
    appendOrderErrors(errors, value.changes, '/changes', 'change_id');
    for (const [index, change] of value.changes.entries()) {
      appendOrderErrors(errors, change.trigger_refs, `/changes/${index}/trigger_refs`);
      appendOrderErrors(errors, change.affected_refs, `/changes/${index}/affected_refs`);
    }
  } else if (kind === 'capability-frontmatter') {
    appendOrderErrors(errors, value.implementation_refs, '/implementation_refs');
    appendOrderErrors(errors, value.verification_refs, '/verification_refs');
  }

  return errors;
};

const validateDeliveryFrontmatter = (value) => {
  const errors = [];
  const obligationIds = new Set();

  for (const [index, obligation] of value.obligations.entries()) {
    if (obligationIds.has(obligation.obligation_id)) {
      errors.push(createError(
        ERROR_CODES.ID_DUPLICATE,
        `/obligations/${index}/obligation_id`,
        `Duplicate obligation ID: ${obligation.obligation_id}`,
      ));
    } else {
      obligationIds.add(obligation.obligation_id);
    }
  }

  return errors;
};

const validateProjectPointer = (value, options) => {
  if (!options.resolvedProjectMap) {
    return [createError(
      ERROR_CODES.REFERENCE_MISSING,
      '/governance_locator',
      'Project pointer validation requires a resolved project map.',
    )];
  }
  const mapResult = validateJson('project-map', options.resolvedProjectMap);
  if (!mapResult.ok) {
    return mapResult.errors.map((error) => createError(
      error.code,
      `/governance_locator${error.path === '/' ? '' : error.path}`,
      'Resolved governance target is not a valid project map.',
    ));
  }
  if (value.project_id === options.resolvedProjectMap.project_id) return [];
  return [createError(
    ERROR_CODES.REFERENCE_MISSING,
    '/project_id',
    `Pointer project_id does not match resolved project map: ${options.resolvedProjectMap.project_id}`,
  )];
};

export const validateJson = (kind, value, options = {}) => {
  const validate = getSchemaValidator(kind);
  if (!validate) {
    return fail([createError(ERROR_CODES.SCHEMA_INVALID, '/', `Unknown schema kind: ${kind}`)]);
  }
  if (!validate(value)) return fail(schemaErrors(kind, validate.errors));

  const errors = kind === 'project-map'
    ? validateProjectMap(value)
    : kind === 'project-extensions'
      ? validateProjectExtensions(value)
      : kind === 'context-receipt'
        ? validateContextReceipt(value)
        : kind === 'delivery-frontmatter'
          ? validateDeliveryFrontmatter(value)
          : kind === 'project-pointer'
            ? validateProjectPointer(value, options)
            : [];
  errors.push(...validateDeterministicOrder(kind, value));
  return errors.length === 0 ? ok(value) : fail(errors);
};
