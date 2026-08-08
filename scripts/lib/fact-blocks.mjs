import { createError } from './errors.mjs';
import { fail, ok } from './result.mjs';
import { parseRestrictedYaml } from './markdown.mjs';

const OPEN = '<!-- project-lifecycle:fact';
const CLOSE = '<!-- /project-lifecycle:fact -->';
const MACHINE_FIELDS = ['fact_id', 'revision', 'evidence_refs', 'last_verified_baseline'];

const malformed = (path, message) => createError('FACT_BLOCK_MALFORMED', path, message);

const validateMachineFields = (value, index) => {
  const path = `/facts/${index}`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [malformed(path, 'Fact metadata must be a restricted YAML mapping.')];
  }
  const errors = [];
  for (const key of Object.keys(value)) {
    if (!MACHINE_FIELDS.includes(key)) errors.push(malformed(`${path}/${key}`, `Unsupported fact field: ${key}`));
  }
  for (const field of MACHINE_FIELDS) {
    if (!(field in value)) errors.push(malformed(`${path}/${field}`, `Missing fact field: ${field}`));
  }
  if (typeof value.fact_id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value.fact_id)) {
    errors.push(malformed(`${path}/fact_id`, 'fact_id must be lowercase kebab-case.'));
  }
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    errors.push(malformed(`${path}/revision`, 'revision must be a positive integer.'));
  }
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.some((item) => typeof item !== 'string' || item.length === 0)) {
    errors.push(malformed(`${path}/evidence_refs`, 'evidence_refs must be an array of non-empty references.'));
  } else if (new Set(value.evidence_refs).size !== value.evidence_refs.length) {
    errors.push(malformed(`${path}/evidence_refs`, 'evidence_refs must be unique.'));
  }
  if (typeof value.last_verified_baseline !== 'string' || value.last_verified_baseline.length === 0) {
    errors.push(malformed(`${path}/last_verified_baseline`, 'last_verified_baseline must be non-empty.'));
  }
  return errors;
};

const parseHumanContent = (source, index) => {
  const path = `/facts/${index}`;
  const limitsMatch = /^(#{1,6})[ \t]+(?:Known limits|已知限制)[ \t]*$/m.exec(source);
  if (!limitsMatch) return { errors: [malformed(`${path}/known_limits`, 'A localized known-limits section is required.')] };
  const statement = source.slice(0, limitsMatch.index).trim();
  const knownLimits = source.slice(limitsMatch.index + limitsMatch[0].length).trim();
  const errors = [];
  if (!statement) errors.push(malformed(`${path}/statement`, 'A localized fact statement is required.'));
  if (!knownLimits) errors.push(malformed(`${path}/known_limits`, 'Known limits must be explicit.'));
  return { statement, knownLimits, errors };
};

export const parseFactBlocks = (source) => {
  const normalized = source.replaceAll('\r\n', '\n');
  const facts = [];
  const errors = [];
  const seen = new Set();
  let cursor = 0;

  while (cursor < normalized.length) {
    const openIndex = normalized.indexOf(OPEN, cursor);
    const strayCloseIndex = normalized.indexOf(CLOSE, cursor);
    if (strayCloseIndex !== -1 && (openIndex === -1 || strayCloseIndex < openIndex)) {
      errors.push(malformed(`/facts/${facts.length}`, 'Unmatched fact closing delimiter.'));
      break;
    }
    if (openIndex === -1) break;
    const index = facts.length;
    const path = `/facts/${index}`;
    const opensOnOwnLine = (openIndex === 0 || normalized[openIndex - 1] === '\n')
      && normalized.startsWith(`${OPEN}\n`, openIndex);
    if (!opensOnOwnLine) {
      errors.push(malformed(path, 'Fact opening delimiter must use the exact canonical form.'));
      break;
    }
    const metadataEnd = normalized.indexOf('\n-->', openIndex + OPEN.length + 1);
    if (metadataEnd === -1) {
      errors.push(malformed(path, 'Fact metadata delimiter is unmatched.'));
      break;
    }
    const closeIndex = normalized.indexOf(CLOSE, metadataEnd + 4);
    if (closeIndex === -1) {
      errors.push(malformed(path, 'Fact closing delimiter is missing.'));
      break;
    }
    const closeEnd = closeIndex + CLOSE.length;
    const closesOnOwnLine = normalized[closeIndex - 1] === '\n'
      && (closeEnd === normalized.length || normalized[closeEnd] === '\n');
    if (!closesOnOwnLine) {
      errors.push(malformed(path, 'Fact closing delimiter must use the exact canonical form.'));
      break;
    }
    const nestedIndex = normalized.indexOf(OPEN, metadataEnd + 4);
    if (nestedIndex !== -1 && nestedIndex < closeIndex) {
      errors.push(malformed(path, 'Fact blocks cannot nest.'));
      break;
    }

    const yaml = normalized.slice(openIndex + OPEN.length + 1, metadataEnd);
    const parsed = parseRestrictedYaml(yaml, path);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      cursor = closeIndex + CLOSE.length;
      continue;
    }
    const machineErrors = validateMachineFields(parsed.value, index);
    const human = parseHumanContent(normalized.slice(metadataEnd + 4, closeIndex), index);
    errors.push(...machineErrors, ...human.errors);
    if (seen.has(parsed.value.fact_id)) {
      errors.push(createError('FACT_ID_DUPLICATE', `${path}/fact_id`, `Duplicate fact_id: ${parsed.value.fact_id}`));
    }
    seen.add(parsed.value.fact_id);
    facts.push({
      ...parsed.value,
      statement: human.statement,
      known_limits: human.knownLimits,
    });
    cursor = closeEnd;
  }

  return errors.length > 0 ? fail(errors) : ok(facts);
};
