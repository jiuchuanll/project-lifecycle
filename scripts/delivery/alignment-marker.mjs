import { isDeepStrictEqual } from 'node:util';

import { createError } from '../lib/errors.mjs';
import { maskFencedMarkdown, parseRestrictedYaml } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
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
  if (!title || title.length > 200 || /[\p{Cc}\p{Cf}|]/u.test(title)) {
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
