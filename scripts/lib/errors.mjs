export const ERROR_CODES = Object.freeze({
  VOCAB_UNKNOWN_KIND: 'VOCAB_UNKNOWN_KIND',
  VOCAB_UNKNOWN_VALUE: 'VOCAB_UNKNOWN_VALUE',
});

export const createError = (code, path, message) => ({ code, path, message });
