import coreVocabulary from '../vocabularies/core.json' with { type: 'json' };

import { ERROR_CODES, createError } from './errors.mjs';
import { fail, ok } from './result.mjs';

const vocabulary = Object.freeze(
  Object.fromEntries(
    Object.entries(coreVocabulary).map(([kind, values]) => [kind, Object.freeze([...values])]),
  ),
);

const MAX_DIAGNOSTIC_VALUE_LENGTH = 120;

const formatDiagnosticValue = (value) => {
  try {
    const serialized = JSON.stringify(value);
    const displayValue = serialized ?? `[${typeof value}]`;

    return displayValue.length > MAX_DIAGNOSTIC_VALUE_LENGTH
      ? `${displayValue.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH)}…`
      : displayValue;
  } catch {
    return `[${typeof value}]`;
  }
};

export const loadCoreVocabulary = () => vocabulary;

export const assertVocabularyValue = (kind, value, path) => {
  if (typeof kind !== 'string' || !Object.hasOwn(vocabulary, kind)) {
    return fail([
      createError(
        ERROR_CODES.VOCAB_UNKNOWN_KIND,
        path,
        `Unknown vocabulary kind: ${formatDiagnosticValue(kind)}`,
      ),
    ]);
  }

  if (!vocabulary[kind].includes(value)) {
    return fail([
      createError(
        ERROR_CODES.VOCAB_UNKNOWN_VALUE,
        path,
        `Unknown value for vocabulary kind ${formatDiagnosticValue(kind)}: ${formatDiagnosticValue(value)}`,
      ),
    ]);
  }

  return ok(value);
};
