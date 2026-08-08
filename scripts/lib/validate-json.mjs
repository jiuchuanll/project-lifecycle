import { ERROR_CODES, createError } from './errors.mjs';
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
    if (index > 0 && value.secondary_obligation_kinds[index - 1] > entry) {
      errors.push(createError(ERROR_CODES.SCHEMA_INVALID, path, 'Extension IDs must be sorted by ID.'));
    }
  }

  return errors;
};

const validateProjectPointer = (value, options) => {
  if (options.allowUnresolvedProjectMap) return [];
  if (!options.resolvedProjectMap) {
    return [createError(
      ERROR_CODES.REFERENCE_MISSING,
      '/governance_locator',
      'Project pointer validation requires a resolved project map.',
    )];
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
      : validateProjectPointer(value, options);
  return errors.length === 0 ? ok(value) : fail(errors);
};
