import coreVocabulary from '../vocabularies/core.json' with { type: 'json' };

import { ERROR_CODES, createError } from './errors.mjs';
import { fail, ok } from './result.mjs';

const vocabulary = Object.freeze(
  Object.fromEntries(
    Object.entries(coreVocabulary).map(([kind, values]) => [kind, Object.freeze([...values])]),
  ),
);

export const loadCoreVocabulary = () => vocabulary;

export const assertVocabularyValue = (kind, value, path) => {
  if (!Object.hasOwn(vocabulary, kind)) {
    return fail([
      createError(
        ERROR_CODES.VOCAB_UNKNOWN_KIND,
        path,
        `Unknown vocabulary kind: ${JSON.stringify(kind)}`,
      ),
    ]);
  }

  if (!vocabulary[kind].includes(value)) {
    return fail([
      createError(
        ERROR_CODES.VOCAB_UNKNOWN_VALUE,
        path,
        `Unknown value for vocabulary kind ${JSON.stringify(kind)}: ${JSON.stringify(value)}`,
      ),
    ]);
  }

  return ok(value);
};
