import { isDeepStrictEqual } from 'node:util';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { maskFencedMarkdown, parseRestrictedYaml } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const failure = (code, path, message) => fail([createError(code, path, message)]);
const MARKER = /<!-- project-lifecycle:alignment\n([\s\S]*?)\n-->/gu;
const sectionPattern = (id) => new RegExp(
  `<!-- project-lifecycle:section ${id} -->\\n([\\s\\S]*?)\\n<!-- /project-lifecycle:section -->`,
  'gu',
);

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
  const matches = [...body.matchAll(sectionPattern('marking'))];
  if (matches.length !== 1) {
    return failure('ALIGNMENT_MARKER_INVALID', `/body/${language}/marking`, 'Feedback requires one marking section.');
  }
  const marker = extractAlignmentMarker(matches[0][1], `/body/${language}/marking`);
  if (!marker.ok) return marker;
  const title = /^#[ \t]+(.+)$/mu.exec(maskFencedMarkdown(body))?.[1]?.trim();
  if (!title || title.length > 200 || /[\p{Cc}\p{Cf}]/u.test(title)) {
    return failure('ALIGNMENT_MARKER_INVALID', `/body/${language}/title`, 'Feedback requires one safe bounded H1 title.');
  }
  return ok({ marker: marker.value, title });
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
  if (en.value.marker && !frontmatter.domain_ids.includes(en.value.marker.primary_domain_id)) {
    return failure('ALIGNMENT_DOMAIN_INVALID', '/body', 'Alignment primary domain must belong to Feedback domain_ids.');
  }
  return ok({
    marker: en.value.marker,
    titles: { en: en.value.title, 'zh-CN': zh.value.title },
  });
};

const sameSorted = (left, right) => isDeepStrictEqual(
  [...left].sort(compareCodePoints),
  [...right].sort(compareCodePoints),
);

export const validateAlignmentExit = ({ feedbackId, resolution, owners = [], closures = [] } = {}) => {
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
  const linkedOwners = owners.filter((owner) => owner?.relationships?.feedback_ids?.includes(feedbackId));
  const requiredOwnerRefs = linkedOwners.map(({ artifact_id: artifactId }) => artifactId);
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
  const closureByOwner = new Map();
  for (const closure of closures) {
    if (typeof closure?.owner_artifact_id !== 'string' || closureByOwner.has(closure.owner_artifact_id)) {
      return failure('ALIGNMENT_RESOLUTION_INVALID', '/alignment_closures', 'Closure summaries require unique owner references.');
    }
    closureByOwner.set(closure.owner_artifact_id, closure);
  }
  const requiredClosureRefs = [];
  for (const ownerId of requiredOwnerRefs) {
    const closure = closureByOwner.get(ownerId);
    if (typeof closure?.artifact_id !== 'string' || closure.outcome?.status !== 'ACCEPTED'
      || closure.acceptance?.claimed !== true
      || !closure.feedback_coverage?.some((entry) => entry?.feedback_id === feedbackId && entry.status === 'COVERED')) {
      return failure('ALIGNMENT_RESOLUTION_INCOMPLETE', '/alignment_closures', 'Every linked owner requires accepted closure and Feedback coverage.');
    }
    requiredClosureRefs.push(closure.artifact_id);
  }
  if (!sameSorted(resolution.closure_refs, requiredClosureRefs)
    || resolution.knowledge_resolution_refs.length < requiredOwnerRefs.length) {
    return failure('ALIGNMENT_RESOLUTION_INCOMPLETE', '/alignment_resolution', 'Every accepted owner requires closure and knowledge resolution.');
  }
  return ok(resolution);
};
