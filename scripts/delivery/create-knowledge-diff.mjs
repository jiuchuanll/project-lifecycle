import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const failure = (code, path, message) => fail([createError(code, path, message)]);
const safeRefs = (values) => Array.isArray(values) && values.every(isSafeReference);

export const createKnowledgeDiffCandidate = (input = {}) => {
  if (Object.hasOwn(input, 'current_knowledge') || Object.hasOwn(input, 'current_knowledge_write')) {
    return failure('CURRENT_KNOWLEDGE_WRITE_FORBIDDEN', '/current_knowledge', 'Delivery closure cannot write current capability knowledge.');
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => key !== 'diff') || !input.diff) {
    return failure('KNOWLEDGE_DIFF_INPUT_INVALID', '/', 'Exactly one Knowledge Diff input is required.');
  }
  const validation = validateJson('knowledge-diff', input.diff);
  if (!validation.ok) return validation;
  const diff = input.diff;
  const references = [diff.knowledge_baseline, ...diff.entry_points, ...diff.evidence_refs];
  for (const operation of diff.operations) references.push(...operation.evidence_refs);
  for (const change of diff.domain_changes) {
    references.push(...change.evidence_refs, ...(change.relationship_refs ?? []));
  }
  if (!safeRefs(references)) {
    return failure('KNOWLEDGE_DIFF_REFERENCE_INVALID', '/', 'Knowledge Diff references must be safe and bounded.');
  }
  return ok({
    candidate_owner: 'run-prd-lifecycle',
    apply_authority: 'maintain-project-knowledge',
    current_knowledge_written: false,
    diff: structuredClone(diff),
  });
};
