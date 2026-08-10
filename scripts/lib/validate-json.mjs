import { ERROR_CODES, createError } from './errors.mjs';
import { codePointOrderErrors, compareCodePoints } from './deterministic-order.mjs';
import { fail, ok } from './result.mjs';
import { getSchemaValidator } from './schema-registry.mjs';

const pointerToken = (token) => String(token).replaceAll('~', '~0').replaceAll('/', '~1');
const propertyPath = (instancePath, property) => `${instancePath}/${pointerToken(property)}`;

const schemaErrors = (kind, errors) => errors.map((error) => {
  const path = error.keyword === 'required' || error.keyword === 'dependentRequired'
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
  const constraintById = new Map();
  const lineagePredecessors = new Set();
  const repositoryAssetOwners = new Map();
  const domainRepositoryOwners = new Map();

  for (const entry of entries) {
    if (entriesById.has(entry.id)) {
      errors.push(createError(ERROR_CODES.ID_DUPLICATE, `${entry.path}/id`, `Duplicate ID: ${entry.id}`));
    } else {
      entriesById.set(entry.id, entry);
    }
  }

  for (const [index, lineage] of value.identity_lineage.entries()) {
    const path = `/identity_lineage/${index}`;
    if (lineagePredecessors.has(lineage.predecessor_project_id)) {
      errors.push(createError(ERROR_CODES.ID_DUPLICATE, `${path}/predecessor_project_id`, 'Project identity predecessors must be unique.'));
    }
    lineagePredecessors.add(lineage.predecessor_project_id);
    if (lineage.predecessor_project_id === value.project_id
      || (lineage.relationship === 'SUCCESSOR' && lineage.successor_project_ids.length !== 1)
      || (lineage.relationship === 'SPLIT' && lineage.successor_project_ids.length < 2)
      || (lineage.relationship === 'MERGE' && lineage.successor_project_ids.length !== 1)) {
      errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `${path}/successor_project_ids`, 'Identity lineage must describe one closed predecessor and the exact relationship cardinality.'));
    }
  }

  const knownDomainIds = new Set(value.domains.map(({ id }) => id));
  for (const [index, repository] of value.repositories.entries()) {
    for (const [domainIndex, domainId] of repository.domain_ids.entries()) {
      const path = `/repositories/${index}/domain_ids/${domainIndex}`;
      if (!knownDomainIds.has(domainId)) {
        errors.push(createError(ERROR_CODES.REFERENCE_MISSING, path, `Unknown repository domain ID: ${domainId}`));
      } else if (domainRepositoryOwners.has(domainId)) {
        errors.push(createError(ERROR_CODES.ID_DUPLICATE, path, `Domain already belongs to repository: ${domainRepositoryOwners.get(domainId)}`));
      } else {
        domainRepositoryOwners.set(domainId, repository.id);
      }
    }
    for (const [assetIndex, locator] of repository.knowledge_asset_locators.entries()) {
      const path = `/repositories/${index}/knowledge_asset_locators/${assetIndex}`;
      if (repositoryAssetOwners.has(locator)) {
        errors.push(createError(ERROR_CODES.ID_DUPLICATE, path, `Knowledge asset already belongs to: ${repositoryAssetOwners.get(locator)}`));
      } else {
        repositoryAssetOwners.set(locator, repository.id);
      }
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
    if (domain.paired_assets) {
      const expectedRepositoryId = domainRepositoryOwners.get(domain.id) ?? null;
      if (domain.paired_assets.repository_id !== expectedRepositoryId) {
        errors.push(createError(
          ERROR_CODES.SCHEMA_INVALID,
          `${path}/paired_assets/repository_id`,
          'Paired asset repository must match the domain canonical repository.',
        ));
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

  for (const constraint of value.constraints) {
    if (!constraintById.has(constraint.id)) constraintById.set(constraint.id, constraint);
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
    const path = `/constraints/${index}`;
    const owner = constraint.owner_id ? domainById.get(constraint.owner_id) : null;
    if (constraint.owner_id && !owner) {
      errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `${path}/owner_id`, `Unknown constraint owner ID: ${constraint.owner_id}`));
    }
    if (constraint.scope === 'selected_descendants') {
      for (const [selectedIndex, selectedId] of constraint.selected_descendants.entries()) {
        if (!domainById.has(selectedId)) {
          errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `${path}/selected_descendants/${selectedIndex}`, `Unknown selected descendant ID: ${selectedId}`));
        } else if (!isDescendant(domainById, constraint.owner_id, selectedId)) {
          errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `${path}/selected_descendants/${selectedIndex}`, 'Selected descendant must be below its constraint owner.'));
        }
      }
    }
    if (constraint.lifecycle_state === 'current' && constraint.successor_ids) {
      errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `${path}/successor_ids`, 'Current constraints cannot declare historical successors.'));
    }
    if (constraint.lifecycle_state === 'retired' && !constraint.successor_ids) {
      errors.push(createError(ERROR_CODES.STATE_REQUIREMENT_MISSING, `${path}/successor_ids`, 'Retired constraints require historical successors.'));
    }
    if (constraint.lifecycle_state === 'retired' && !constraint.retirement_reason_ref) {
      errors.push(createError(ERROR_CODES.STATE_REQUIREMENT_MISSING, `${path}/retirement_reason_ref`, 'Retired constraints require a reason reference.'));
    }
    for (const [successorIndex, successorId] of (constraint.successor_ids ?? []).entries()) {
      const successor = constraintById.get(successorId);
      if (!successor) {
        errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `${path}/successor_ids/${successorIndex}`, `Unknown constraint successor ID: ${successorId}`));
      } else if (successor.lifecycle_state === 'retired') {
        errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `${path}/successor_ids/${successorIndex}`, 'Constraint successor must remain current.'));
      }
    }
    const exceptionDomains = new Set();
    for (const [exceptionIndex, exception] of (constraint.exceptions ?? []).entries()) {
      if (exceptionDomains.has(exception.domain_id)) {
        errors.push(createError(ERROR_CODES.ID_DUPLICATE, `${path}/exceptions/${exceptionIndex}/domain_id`, `Duplicate exception domain ID: ${exception.domain_id}`));
      }
      exceptionDomains.add(exception.domain_id);
      if (!domainById.has(exception.domain_id)) {
        errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `${path}/exceptions/${exceptionIndex}/domain_id`, `Unknown exception domain ID: ${exception.domain_id}`));
      }
    }
    if (constraint.knowledge_refs) {
      for (const language of ['en', 'zh-CN']) {
        if (!constraint.knowledge_refs[language].endsWith(`#constraint-${constraint.id}`)) {
          errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `${path}/knowledge_refs/${language}`, 'Constraint knowledge anchor must match its immutable ID.'));
        }
      }
    }
  }

  for (const [index, marker] of (value.revalidation_required ?? []).entries()) {
    const path = `/revalidation_required/${index}`;
    if (!domainById.has(marker.domain_id)) {
      errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `${path}/domain_id`, `Unknown revalidation domain ID: ${marker.domain_id}`));
    }
    if (marker.constraint_id) {
      const constraint = constraintById.get(marker.constraint_id);
      if (!constraint) {
        errors.push(createError(ERROR_CODES.REFERENCE_MISSING, `${path}/constraint_id`, `Unknown revalidation constraint ID: ${marker.constraint_id}`));
      } else if (marker.to_revision !== constraint.semantic_revision
        || marker.to_revision <= marker.from_revision) {
        errors.push(createError(ERROR_CODES.SCHEMA_INVALID, `${path}/to_revision`, 'Constraint revalidation must advance exactly to the current semantic revision.'));
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

const validatePendingChanges = (value) => {
  const errors = [];
  const semanticTargets = new Set();
  const changeIds = new Set();
  for (const [index, change] of value.changes.entries()) {
    if (changeIds.has(change.change_id)) {
      errors.push(createError(
        ERROR_CODES.ID_DUPLICATE,
        `/changes/${index}/change_id`,
        `Duplicate change ID: ${change.change_id}`,
      ));
    }
    changeIds.add(change.change_id);
    const obligationIds = new Set();
    for (const [obligationIndex, obligation] of (change.obligations ?? []).entries()) {
      const validation = validateJson('obligation-instance', obligation);
      if (!validation.ok) {
        errors.push(...validation.errors.map((entry) => createError(
          entry.code,
          `/changes/${index}/obligations/${obligationIndex}${entry.path === '/' ? '' : entry.path}`,
          'Invalid pending-change obligation instance.',
        )));
      }
      if (obligationIds.has(obligation.obligation_id)) {
        errors.push(createError(
          ERROR_CODES.ID_DUPLICATE,
          `/changes/${index}/obligations/${obligationIndex}/obligation_id`,
          `Duplicate obligation ID: ${obligation.obligation_id}`,
        ));
      }
      obligationIds.add(obligation.obligation_id);
    }
    if (!change.semantic_target_key) continue;
    if (semanticTargets.has(change.semantic_target_key)) {
      errors.push(createError(
        ERROR_CODES.ID_DUPLICATE,
        `/changes/${index}/semantic_target_key`,
        `Duplicate open semantic target: ${change.semantic_target_key}`,
      ));
    }
    semanticTargets.add(change.semantic_target_key);
    const dispositionIds = new Set();
    for (const [dispositionIndex, disposition] of (change.child_dispositions ?? []).entries()) {
      if (dispositionIds.has(disposition.domain_id)) {
        errors.push(createError(
          ERROR_CODES.ID_DUPLICATE,
          `/changes/${index}/child_dispositions/${dispositionIndex}/domain_id`,
          `Duplicate child disposition ID: ${disposition.domain_id}`,
        ));
      }
      dispositionIds.add(disposition.domain_id);
    }
    const commitmentIds = new Set();
    for (const [commitmentIndex, commitment] of (change.knowledge_commitments ?? []).entries()) {
      if (commitmentIds.has(commitment.domain_id)) {
        errors.push(createError(
          ERROR_CODES.ID_DUPLICATE,
          `/changes/${index}/knowledge_commitments/${commitmentIndex}/domain_id`,
          `Duplicate knowledge commitment domain ID: ${commitment.domain_id}`,
        ));
      }
      commitmentIds.add(commitment.domain_id);
      const factIds = new Set();
      for (const [factIndex, fact] of commitment.facts.entries()) {
        if (factIds.has(fact.fact_id)) {
          errors.push(createError(
            ERROR_CODES.ID_DUPLICATE,
            `/changes/${index}/knowledge_commitments/${commitmentIndex}/facts/${factIndex}/fact_id`,
            `Duplicate committed fact ID: ${fact.fact_id}`,
          ));
        }
        factIds.add(fact.fact_id);
      }
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
    appendOrderErrors(errors, value.identity_lineage, '/identity_lineage', 'predecessor_project_id');
    appendOrderErrors(errors, value.repositories, '/repositories', 'id');
    appendOrderErrors(errors, value.constraints, '/constraints', 'id');
    appendOrderErrors(errors, value.domains, '/domains', 'id');
    for (const [index, constraint] of value.constraints.entries()) {
      if (constraint.selected_descendants) {
        appendOrderErrors(errors, constraint.selected_descendants, `/constraints/${index}/selected_descendants`);
      }
      if (constraint.successor_ids) {
        appendOrderErrors(errors, constraint.successor_ids, `/constraints/${index}/successor_ids`);
      }
      if (constraint.exceptions) {
        appendOrderErrors(errors, constraint.exceptions, `/constraints/${index}/exceptions`, 'domain_id');
      }
    }
    for (const [index, lineage] of value.identity_lineage.entries()) {
      appendOrderErrors(errors, lineage.successor_project_ids, `/identity_lineage/${index}/successor_project_ids`);
    }
    for (const [index, repository] of value.repositories.entries()) {
      appendOrderErrors(errors, repository.domain_ids, `/repositories/${index}/domain_ids`);
      appendOrderErrors(errors, repository.knowledge_asset_locators, `/repositories/${index}/knowledge_asset_locators`);
    }
    if (value.revalidation_required) {
      const markerKey = (marker) => `${marker.domain_id}\u0000${marker.fact_id}\u0000${marker.constraint_id ?? ''}`;
      for (let index = 1; index < value.revalidation_required.length; index += 1) {
        const previous = markerKey(value.revalidation_required[index - 1]);
        const current = markerKey(value.revalidation_required[index]);
        if (compareCodePoints(previous, current) >= 0) {
          errors.push(createError(
            previous === current ? ERROR_CODES.ID_DUPLICATE : ERROR_CODES.SCHEMA_INVALID,
            `/revalidation_required/${index}/fact_id`,
            previous === current
              ? 'Duplicate revalidation marker identity.'
              : 'Revalidation markers must use strict language-neutral identity order.',
          ));
        }
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
      if (change.trigger_refs) appendOrderErrors(errors, change.trigger_refs, `/changes/${index}/trigger_refs`);
      if (change.affected_refs) appendOrderErrors(errors, change.affected_refs, `/changes/${index}/affected_refs`);
      if (change.source_refs) appendOrderErrors(errors, change.source_refs, `/changes/${index}/source_refs`);
      if (change.proposed_patch) {
        appendOrderErrors(errors, change.proposed_patch.changed_fields, `/changes/${index}/proposed_patch/changed_fields`);
        appendOrderErrors(errors, change.proposed_patch.new_ids, `/changes/${index}/proposed_patch/new_ids`);
        appendOrderErrors(errors, change.proposed_patch.successor_ids, `/changes/${index}/proposed_patch/successor_ids`);
      }
      if (change.child_dispositions) {
        appendOrderErrors(errors, change.child_dispositions, `/changes/${index}/child_dispositions`, 'domain_id');
        for (const [dispositionIndex, disposition] of change.child_dispositions.entries()) {
          appendOrderErrors(errors, disposition.evidence_refs, `/changes/${index}/child_dispositions/${dispositionIndex}/evidence_refs`);
          appendOrderErrors(errors, disposition.unresolved_fact_ids, `/changes/${index}/child_dispositions/${dispositionIndex}/unresolved_fact_ids`);
        }
      }
      if (change.knowledge_commitments) {
        appendOrderErrors(errors, change.knowledge_commitments, `/changes/${index}/knowledge_commitments`, 'domain_id');
        for (const [commitmentIndex, commitment] of change.knowledge_commitments.entries()) {
          appendOrderErrors(errors, commitment.facts, `/changes/${index}/knowledge_commitments/${commitmentIndex}/facts`, 'fact_id');
        }
      }
      if (change.absorption_version === 1) {
        appendOrderErrors(errors, change.operations, `/changes/${index}/operations`, 'fact_id');
        appendOrderErrors(errors, change.affected_domain_ids, `/changes/${index}/affected_domain_ids`);
        appendOrderErrors(errors, change.affected_fact_ids, `/changes/${index}/affected_fact_ids`);
        appendOrderErrors(errors, change.affected_owner_ids, `/changes/${index}/affected_owner_ids`);
        appendOrderErrors(errors, change.constraint_refs, `/changes/${index}/constraint_refs`);
        appendOrderErrors(errors, change.relationship_refs, `/changes/${index}/relationship_refs`);
        appendOrderErrors(errors, change.topology_target_ids, `/changes/${index}/topology_target_ids`);
        appendOrderErrors(errors, change.evidence_refs, `/changes/${index}/evidence_refs`);
        for (const [operationIndex, operation] of change.operations.entries()) {
          appendOrderErrors(errors, operation.evidence_refs, `/changes/${index}/operations/${operationIndex}/evidence_refs`);
        }
      }
      if (change.obligations) {
        appendOrderErrors(errors, change.obligations, `/changes/${index}/obligations`, 'obligation_id');
        for (const [obligationIndex, obligation] of change.obligations.entries()) {
          for (const field of ['trigger_refs', 'scope_refs', 'responsible_refs', 'evidence_refs']) {
            appendOrderErrors(errors, obligation[field], `/changes/${index}/obligations/${obligationIndex}/${field}`);
          }
        }
      }
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
  if (kind === 'project-map' && value?.schema_version === 1) {
    return fail([createError(
      ERROR_CODES.KNOWLEDGE_LAYOUT_MIGRATION_REQUIRED,
      '/schema_version',
      'Project knowledge layout must be migrated to schema version 2 before a durable write.',
    )]);
  }
  if (!validate(value)) return fail(schemaErrors(kind, validate.errors));

  const errors = kind === 'project-map'
    ? validateProjectMap(value)
    : kind === 'project-extensions'
      ? validateProjectExtensions(value)
      : kind === 'context-receipt'
      ? validateContextReceipt(value)
      : kind === 'pending-changes'
        ? validatePendingChanges(value)
        : kind === 'delivery-frontmatter'
          ? validateDeliveryFrontmatter(value)
          : kind === 'project-pointer'
            ? validateProjectPointer(value, options)
            : [];
  errors.push(...validateDeterministicOrder(kind, value));
  return errors.length === 0 ? ok(value) : fail(errors);
};
