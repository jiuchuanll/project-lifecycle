import { compareCodePoints } from '../../../scripts/lib/deterministic-order.mjs';
import { createError } from '../../../scripts/lib/errors.mjs';
import { isSafeReference } from '../../../scripts/lib/reference-safety.mjs';
import { fail, ok } from '../../../scripts/lib/result.mjs';
import { createKnowledgeDiffCandidate } from '../../../scripts/delivery/create-knowledge-diff.mjs';
import { validateRoute } from '../../../scripts/delivery/validate-route.mjs';

const ID = /^[a-z][a-z0-9-]*$/u;
const ROUTES = new Set(['KNOWLEDGE_UPDATE', 'NON_PRD_DELIVERY', 'OUTSIDE_PLUGIN', 'PRD_DELIVERY']);
const ASSET_KINDS = new Set(['closure-summary', 'feedback', 'non-prd-delivery', 'prd']);
const HUMAN_GATES = new Set([
  'BUSINESS_DISPOSITION_CONFIRMATION',
  'CONFLICT_RESOLUTION',
  'KNOWLEDGE_APPROVAL',
  'MULTI_REPOSITORY_ACCEPTANCE',
  'NONE',
  'PRD_CREATION_APPROVAL',
  'ROUTE_CLARIFICATION',
]);
const OBLIGATIONS = new Set([
  'CONFLICT_RESOLUTION_REQUIRED',
  'CROSS_DOMAIN_COORDINATION_REQUIRED',
  'DEPENDENCY_RESOLUTION_REQUIRED',
  'KNOWLEDGE_CHANGE_HANDOFF_REQUIRED',
  'KNOWLEDGE_READINESS_REQUIRED',
  'MULTI_REPOSITORY_COORDINATION_REQUIRED',
]);
const CLOSURES = new Set(['ALLOWED', 'BLOCKED', 'OUTSIDE_DELIVERY']);
const CLEANUP = new Set(['AUTHORIZED', 'NOT_APPLICABLE', 'NOT_AUTHORIZED']);
const FIELDS = new Set([
  'allowed_context_ids', 'allowed_durable_asset_kinds', 'closure_expectation', 'expected_archive_reads',
  'expected_cleanup', 'expected_obligation_kinds', 'expected_primary_route', 'expected_stop',
  'forbidden_outcomes', 'human_gate_satisfied', 'input_summary', 'prd_creation_origin',
  'proposed_artifact_kind', 'required_human_gate', 'route_candidate', 'scenario_id',
]);

const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (values) => Array.isArray(values) && new Set(values).size === values.length;
const safeList = (values, maximum = 50) => unique(values) && values.length <= maximum && values.every(isSafeReference);
const closedList = (values, vocabulary) => unique(values) && values.every((value) => vocabulary.has(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sorted = (values) => [...values].sort(compareCodePoints);

const validateScenario = (scenario, index) => {
  const path = `/scenarios/${index}`;
  if (!record(scenario) || Object.keys(scenario).some((key) => !FIELDS.has(key))) {
    return failure('SCENARIO_SHAPE_INVALID', path, 'Scenario uses a closed deterministic shape.');
  }
  const required = [...FIELDS];
  if (required.some((field) => !Object.hasOwn(scenario, field))) {
    return failure('SCENARIO_FIELD_MISSING', path, 'Every expected and forbidden scenario field is required.');
  }
  if (!ID.test(scenario.scenario_id ?? '') || typeof scenario.input_summary !== 'string'
    || scenario.input_summary.length === 0 || scenario.input_summary.length > 500) {
    return failure('SCENARIO_IDENTITY_INVALID', path, 'Scenario identity and summary must be bounded.');
  }
  if (!safeList(scenario.allowed_context_ids)) {
    return failure('SCENARIO_CONTEXT_UNBOUNDED', `${path}/allowed_context_ids`, 'Allowed context IDs must be explicit, unique, and bounded to 50.');
  }
  const hasRoute = scenario.expected_primary_route !== null;
  const hasStop = scenario.expected_stop !== null;
  if (hasRoute === hasStop || (hasRoute && !ROUTES.has(scenario.expected_primary_route))
    || (hasStop && scenario.expected_stop !== 'NEEDS_USER')) {
    return failure('SCENARIO_ROUTE_INVALID', path, 'Scenario must expect exactly one route or NEEDS_USER stop.');
  }
  if (!closedList(scenario.allowed_durable_asset_kinds, ASSET_KINDS)
    || !same(scenario.allowed_durable_asset_kinds, sorted(scenario.allowed_durable_asset_kinds))
    || !HUMAN_GATES.has(scenario.required_human_gate)
    || !closedList(scenario.expected_obligation_kinds, OBLIGATIONS)
    || !same(scenario.expected_obligation_kinds, sorted(scenario.expected_obligation_kinds))
    || !CLOSURES.has(scenario.closure_expectation)
    || !safeList(scenario.forbidden_outcomes)
    || typeof scenario.human_gate_satisfied !== 'boolean'
    || !CLEANUP.has(scenario.expected_cleanup)
    || !Number.isInteger(scenario.expected_archive_reads) || scenario.expected_archive_reads < 0) {
    return failure('SCENARIO_EXPECTATION_INVALID', path, 'Scenario expectations must use closed bounded values.');
  }
  if (scenario.proposed_artifact_kind !== null && !ASSET_KINDS.has(scenario.proposed_artifact_kind)) {
    return failure('SCENARIO_ASSET_INVALID', `${path}/proposed_artifact_kind`, 'Unsupported proposed asset kind.');
  }
  if (scenario.prd_creation_origin !== null && !['agent_inferred', 'explicit_user'].includes(scenario.prd_creation_origin)) {
    return failure('SCENARIO_ORIGIN_INVALID', `${path}/prd_creation_origin`, 'Unsupported PRD creation origin.');
  }
  const route = validateRoute(scenario.route_candidate);
  if (!route.ok || route.value.primary_route !== scenario.expected_primary_route
    || (route.value.stop?.code ?? null) !== scenario.expected_stop) {
    return failure('SCENARIO_ROUTE_MISMATCH', `${path}/route_candidate`, 'Route candidate must produce the declared route or stop.');
  }
  return ok({ ...structuredClone(scenario), allowed_context_ids: sorted(scenario.allowed_context_ids) });
};

export const validateDeliveryScenarios = (scenarios) => {
  if (!Array.isArray(scenarios) || scenarios.length === 0 || scenarios.length > 50) {
    return failure('SCENARIO_SET_INVALID', '/scenarios', 'Behavior scenario set must be explicit and bounded.');
  }
  const ids = new Set();
  const normalized = [];
  for (const [index, scenario] of scenarios.entries()) {
    const result = validateScenario(scenario, index);
    if (!result.ok) return result;
    if (ids.has(scenario.scenario_id)) return failure('SCENARIO_ID_DUPLICATE', `/scenarios/${index}/scenario_id`, 'Scenario IDs must be unique.');
    ids.add(scenario.scenario_id);
    normalized.push(result.value);
  }
  normalized.sort((left, right) => compareCodePoints(left.scenario_id, right.scenario_id));
  return ok(normalized);
};

const artifactIdFor = (scenario) => scenario.proposed_artifact_kind === 'prd'
  ? `prd-${scenario.scenario_id}`
  : scenario.proposed_artifact_kind === 'feedback'
    ? `feedback-${scenario.scenario_id}`
    : `${scenario.scenario_id}-delivery`;

export const evaluateDeliveryScenario = (scenario) => {
  const validated = validateDeliveryScenarios([scenario]);
  if (!validated.ok) return validated;
  const route = validateRoute(scenario.route_candidate);
  if (!route.ok) return route;
  const stopped = route.value.stop !== null;
  const outsideDelivery = ['KNOWLEDGE_UPDATE', 'OUTSIDE_PLUGIN'].includes(route.value.primary_route);
  const gateBlocked = scenario.required_human_gate !== 'NONE' && !scenario.human_gate_satisfied;
  const obligationBlocked = scenario.expected_obligation_kinds.length > 0;
  const closure = outsideDelivery ? 'OUTSIDE_DELIVERY' : (stopped || gateBlocked || obligationBlocked ? 'BLOCKED' : 'ALLOWED');
  const feedbackOnlyCapture = route.value.primary_route === 'KNOWLEDGE_UPDATE'
    && scenario.proposed_artifact_kind === 'feedback'
    && scenario.required_human_gate === 'BUSINESS_DISPOSITION_CONFIRMATION'
    && scenario.human_gate_satisfied;

  let durableKinds = [];
  if (feedbackOnlyCapture) {
    durableKinds = ['feedback'];
  } else if (!outsideDelivery && !stopped && !(scenario.proposed_artifact_kind === 'prd'
    && scenario.prd_creation_origin === 'agent_inferred' && !scenario.human_gate_satisfied)) {
    durableKinds = [scenario.proposed_artifact_kind];
    if (closure === 'ALLOWED') durableKinds.push('closure-summary');
    durableKinds = sorted(durableKinds);
  }
  if (!same(durableKinds, scenario.allowed_durable_asset_kinds)
    || closure !== scenario.closure_expectation
    || scenario.expected_archive_reads !== 0
    || (closure === 'ALLOWED' ? 'AUTHORIZED' : outsideDelivery ? 'NOT_APPLICABLE' : 'NOT_AUTHORIZED') !== scenario.expected_cleanup) {
    return failure('SCENARIO_EXPECTATION_MISMATCH', '/', 'Declared scenario expectations do not match deterministic lifecycle invariants.');
  }

  let candidate = null;
  if (closure === 'ALLOWED') {
    const ownerId = artifactIdFor(scenario);
    const result = createKnowledgeDiffCandidate({
      diff: {
        schema_version: 1,
        diff_id: `diff-${scenario.scenario_id}`,
        owner_delivery_id: ownerId,
        knowledge_baseline: 'behavior-baseline',
        operations: [],
        domain_changes: [],
        entry_points: [`delivery:${ownerId}`],
        evidence_refs: [`behavior:${scenario.scenario_id}`],
        remaining_limits: [],
        outcome: 'NO_CHANGE',
      },
    });
    if (!result.ok) return result;
    candidate = result.value;
  }

  const allowedFiles = [];
  const ownerId = scenario.proposed_artifact_kind ? artifactIdFor(scenario) : null;
  for (const kind of durableKinds) {
    const id = kind === 'closure-summary' ? `closure-${ownerId}` : ownerId;
    allowedFiles.push(`delivery/${id}-en.md`, `delivery/${id}.md`);
  }
  const outcomes = [];
  if (route.value.stop) outcomes.push('NEEDS_USER');
  if (gateBlocked) outcomes.push('HUMAN_GATE_BLOCKED');
  if (obligationBlocked) outcomes.push('OBLIGATION_OPEN');

  return ok({
    scenario_id: scenario.scenario_id,
    primary_route: route.value.primary_route,
    stop: route.value.stop?.code ?? null,
    allowed_context_ids: sorted(scenario.allowed_context_ids),
    durable_asset_kinds: durableKinds,
    allowed_files: sorted(allowedFiles),
    obligation_kinds: structuredClone(scenario.expected_obligation_kinds),
    closure,
    cleanup: scenario.expected_cleanup,
    archive_reads: 0,
    knowledge_candidate_owner: candidate?.candidate_owner ?? null,
    knowledge_apply_authority: candidate?.apply_authority ?? null,
    current_knowledge_written: false,
    global_obligations_file: false,
    outcomes,
  });
};
