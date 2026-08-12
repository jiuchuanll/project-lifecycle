import { isDeepStrictEqual } from 'node:util';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { maskFencedMarkdown, parseRestrictedYaml } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { validateClosureSummary } from './close-delivery.mjs';

const failure = (code, path, message) => fail([createError(code, path, message)]);
const MARKER = /<!-- project-lifecycle:alignment\n([\s\S]*?)\n-->/gu;
const FEEDBACK_SECTIONS = ['original_problem', 'scenario', 'expectation', 'marking', 'coverage'];
const sectionPattern = (id) => new RegExp(
  `<!-- project-lifecycle:section ${id} -->\\n([\\s\\S]*?)\\n<!-- /project-lifecycle:section -->`,
  'gu',
);

const splitDeliveryDocument = (source) => {
  if (typeof source !== 'string') return null;
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return null;
  const closing = normalized.indexOf('\n---\n', 4);
  if (closing === -1) return null;
  const parsed = parseRestrictedYaml(normalized.slice(4, closing), '/frontmatter');
  if (!parsed.ok || !validateJson('delivery-frontmatter', parsed.value).ok) return null;
  return { frontmatter: parsed.value, body: normalized.slice(closing + 5) };
};

export const extractAlignmentMarker = (marking, path = '/marking') => {
  if (typeof marking !== 'string') {
    return failure('ALIGNMENT_MARKER_INVALID', path, 'Alignment marking must be bounded text.');
  }
  const visible = maskFencedMarkdown(marking);
  const matches = [...visible.matchAll(MARKER)];
  if (matches.length === 0) return ok(null);
  if (matches.length !== 1) {
    return failure('ALIGNMENT_MARKER_DUPLICATE', path, 'Feedback may contain at most one alignment marker.');
  }
  const parsed = parseRestrictedYaml(matches[0][1], path);
  if (!parsed.ok || !validateJson('alignment-marker', parsed.value).ok) {
    return failure('ALIGNMENT_MARKER_INVALID', path, 'Alignment marker must satisfy the closed contract.');
  }
  return ok(parsed.value);
};

const extractBody = (body, language) => {
  if (typeof body !== 'string') {
    return failure('ALIGNMENT_MARKER_INVALID', `/body/${language}`, 'Feedback body must be text.');
  }
  const normalized = body.replaceAll('\r\n', '\n').replace(/^\n/u, '');
  const visible = maskFencedMarkdown(normalized);
  const sections = {};
  for (const id of FEEDBACK_SECTIONS) {
    const matches = [...visible.matchAll(sectionPattern(id))];
    if (matches.length !== 1 || matches[0][1].trim().length === 0) {
      return failure('ALIGNMENT_MARKER_INVALID', `/body/${language}/${id}`, 'Feedback requires one complete bounded section set.');
    }
    sections[id] = matches[0][1];
  }
  const marker = extractAlignmentMarker(sections.marking, `/body/${language}/marking`);
  if (!marker.ok) return marker;
  const documentTitles = [...visible.matchAll(/^#[ \t]+(.+)$/gmu)];
  const title = documentTitles[0]?.[1]?.trim() ?? null;
  if (marker.value && (documentTitles.length !== 1 || documentTitles[0]?.index !== 0
    || !title || title.length > 200 || /[\p{Cc}\p{Cf}]/u.test(title))) {
    return failure('ALIGNMENT_MARKER_INVALID', `/body/${language}/title`, 'Feedback requires one safe bounded H1 title.');
  }
  return ok({
    marker: marker.value,
    title,
    heading_levels: [...visible.matchAll(/^(#{1,6})[ \t]+\S.*$/gmu)]
      .map((match) => match[1].length),
  });
};

export const validateAlignmentFeedbackPair = ({ frontmatter, bodies } = {}) => {
  if (frontmatter?.artifact_kind !== 'feedback' || !Array.isArray(frontmatter.domain_ids)
    || typeof bodies?.en !== 'string' || typeof bodies?.['zh-CN'] !== 'string') {
    return failure('ALIGNMENT_MARKER_INVALID', '/', 'Alignment validation requires one bilingual Feedback pair.');
  }
  const en = extractBody(bodies.en, 'en');
  if (!en.ok) return en;
  const zh = extractBody(bodies['zh-CN'], 'zh-CN');
  if (!zh.ok) return zh;
  if (!isDeepStrictEqual(en.value.marker, zh.value.marker)) {
    return failure('ALIGNMENT_PAIR_MISMATCH', '/body', 'Localized Feedback must share one alignment marker.');
  }
  if (!isDeepStrictEqual(en.value.heading_levels, zh.value.heading_levels)) {
    return failure('ALIGNMENT_PAIR_MISMATCH', '/body', 'Localized Feedback requires matching heading structure.');
  }
  if (en.value.marker && !frontmatter.domain_ids.includes(en.value.marker.primary_domain_id)) {
    return failure('ALIGNMENT_DOMAIN_INVALID', '/body', 'Alignment primary domain must belong to Feedback domain_ids.');
  }
  return ok({
    marker: en.value.marker,
    titles: { en: en.value.title, 'zh-CN': zh.value.title },
  });
};

export const validateAlignmentFeedbackDocuments = ({ documents, projectMap } = {}) => {
  const map = validateJson('project-map', projectMap);
  if (!map.ok) return failure('ALIGNMENT_PROJECT_MAP_INVALID', '/project_map', 'Alignment validation requires a valid project map.');
  const en = splitDeliveryDocument(documents?.en);
  const zh = splitDeliveryDocument(documents?.['zh-CN']);
  if (!en || !zh || !isDeepStrictEqual(en.frontmatter, zh.frontmatter)) {
    return failure('ALIGNMENT_PAIR_MISMATCH', '/documents', 'Alignment Feedback documents require identical valid Frontmatter.');
  }
  const pair = validateAlignmentFeedbackPair({
    frontmatter: en.frontmatter,
    bodies: { en: en.body, 'zh-CN': zh.body },
  });
  if (!pair.ok) return pair;
  if (!pair.value.marker) {
    return failure('ALIGNMENT_MARKER_REQUIRED', '/documents', 'Alignment validation requires one active marker.');
  }
  const domain = projectMap.domains.find(({ id }) => id === pair.value.marker.primary_domain_id);
  if (!domain || !['confirmed', 'materialized'].includes(domain.domain_state)
    || en.frontmatter.current_project_id !== projectMap.project_id) {
    return failure('ALIGNMENT_DOMAIN_INVALID', '/documents', 'Alignment marker must reference one current routable project domain.');
  }
  return ok({
    feedback_id: en.frontmatter.artifact_id,
    primary_domain_id: pair.value.marker.primary_domain_id,
    routing_disposition: pair.value.marker.routing_disposition ?? null,
    record: {
      frontmatter: en.frontmatter,
      marker: pair.value.marker,
      titles: pair.value.titles,
    },
  });
};

const sameSorted = (left, right) => isDeepStrictEqual(
  [...left].sort(compareCodePoints),
  [...right].sort(compareCodePoints),
);

export const validateAlignmentExit = ({
  feedbackId,
  resolution,
  owners = [],
  closures = [],
  ownerInventoryComplete = false,
} = {}) => {
  if (resolution === undefined || resolution === null) {
    return failure('ALIGNMENT_RESOLUTION_REQUIRED', '/alignment_resolution', 'Active alignment removal requires a resolution envelope.');
  }
  if (!validateJson('alignment-resolution', resolution).ok
    || resolution.feedback_id !== feedbackId
    || !resolution.closure_refs.every(isSafeReference)
    || !resolution.knowledge_resolution_refs.every(isSafeReference)
    || (resolution.human_approval_ref !== undefined && !isSafeReference(resolution.human_approval_ref))) {
    return failure('ALIGNMENT_RESOLUTION_INVALID', '/alignment_resolution', 'Alignment resolution must satisfy the closed safe contract.');
  }
  if (!Array.isArray(owners) || !Array.isArray(closures)) {
    return failure('ALIGNMENT_RESOLUTION_INVALID', '/alignment_resolution', 'Alignment resolution requires bounded owner and closure inputs.');
  }
  if (ownerInventoryComplete !== true) {
    return failure('ALIGNMENT_OWNER_INVENTORY_INCOMPLETE', '/alignment_owners', 'Marker exit requires a complete owner inventory derived from authoritative delivery assets.');
  }
  const closureByOwner = new Map();
  for (const closure of closures) {
    if (!validateClosureSummary(closure).ok
      || closureByOwner.has(closure.owner_artifact_id)) {
      return failure('ALIGNMENT_RESOLUTION_INVALID', '/alignment_closures', 'Closure summaries require unique validated owner references.');
    }
    closureByOwner.set(closure.owner_artifact_id, closure);
  }
  const linkedOwners = owners.filter((owner) => owner?.relationships?.feedback_ids?.includes(feedbackId));
  const requiredOwnerRefs = linkedOwners
    .filter(({ artifact_id: artifactId }) => !['ABANDONED', 'CANCELLED', 'REJECTED']
      .includes(closureByOwner.get(artifactId)?.outcome?.status))
    .map(({ artifact_id: artifactId }) => artifactId);
  if (new Set(requiredOwnerRefs).size !== requiredOwnerRefs.length
    || requiredOwnerRefs.some((ownerId) => !/^[a-z][a-z0-9-]*$/u.test(ownerId))) {
    return failure('ALIGNMENT_RESOLUTION_INVALID', '/alignment_owners', 'Alignment owners require unique safe identities.');
  }
  if (resolution.disposition === 'NO_REMEDIATION_ACCEPTED') {
    return requiredOwnerRefs.length === 0
      ? ok(resolution)
      : failure('ALIGNMENT_RESOLUTION_INCOMPLETE', '/alignment_resolution/owner_refs', 'No-remediation exit cannot omit linked delivery owners.');
  }
  if (!sameSorted(resolution.owner_refs, requiredOwnerRefs)) {
    return failure('ALIGNMENT_RESOLUTION_INCOMPLETE', '/alignment_resolution/owner_refs', 'Resolution must cover every linked delivery owner.');
  }
  const requiredClosureRefs = [];
  for (const ownerId of requiredOwnerRefs) {
    const closure = closureByOwner.get(ownerId);
    if (!validateClosureSummary(closure).ok || closure.owner_artifact_id !== ownerId
      || closure.outcome.status !== 'ACCEPTED'
      || !closure.feedback_coverage?.some((entry) => entry?.feedback_id === feedbackId && entry.status === 'COVERED')) {
      return failure('ALIGNMENT_RESOLUTION_INCOMPLETE', '/alignment_closures', 'Every linked owner requires accepted closure and Feedback coverage.');
    }
    requiredClosureRefs.push(closure.artifact_id);
  }
  const requiredKnowledgeResolutionRefs = requiredOwnerRefs.map((ownerId) => (
    `knowledge-resolution:${closureByOwner.get(ownerId).knowledge_handoff.diff_id}`
  ));
  if (!sameSorted(resolution.closure_refs, requiredClosureRefs)
    || !sameSorted(resolution.knowledge_resolution_refs, requiredKnowledgeResolutionRefs)) {
    return failure('ALIGNMENT_RESOLUTION_INCOMPLETE', '/alignment_resolution', 'Every accepted owner requires closure and knowledge resolution.');
  }
  return ok(resolution);
};
