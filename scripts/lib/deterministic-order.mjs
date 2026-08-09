import { ERROR_CODES, createError } from './errors.mjs';

export const compareCodePoints = (left, right) => {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
};

export const codePointOrderErrors = (
  items,
  {
    code = ERROR_CODES.SCHEMA_INVALID,
    pathAt,
    valueAt = (item) => item,
  },
) => {
  const errors = [];
  for (let index = 1; index < items.length; index += 1) {
    if (compareCodePoints(valueAt(items[index - 1]), valueAt(items[index])) > 0) {
      errors.push(createError(
        code,
        pathAt(index),
        'Language-neutral IDs must use Unicode code-point lexical order.',
      ));
    }
  }
  return errors;
};
