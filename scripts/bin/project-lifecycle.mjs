#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { ERROR_CODES, createError } from '../lib/errors.mjs';
import { validateBilingualPair } from '../lib/bilingual-pair.mjs';
import { parseFactBlocks } from '../lib/fact-blocks.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { validateFixtures } from '../validate-fixtures.mjs';

const version = '0.1.0';
const command = process.argv[2] ?? 'help';

const cliFailure = (code, path, message) => fail([createError(code, path, message)]);

const publicDiagnosticMessages = Object.freeze({
  [ERROR_CODES.CURRENT_EVIDENCE_MISSING]: 'Current fact evidence is missing.',
  [ERROR_CODES.FACT_BLOCK_MALFORMED]: 'Fact Markdown validation failed.',
  [ERROR_CODES.FACT_ID_DUPLICATE]: 'Duplicate fact identifier.',
  [ERROR_CODES.ID_DUPLICATE]: 'Duplicate identifier.',
  [ERROR_CODES.PAIR_MACHINE_MISMATCH]: 'Bilingual pair validation failed.',
  [ERROR_CODES.PAIR_SECTION_MISMATCH]: 'Bilingual section validation failed.',
  [ERROR_CODES.REFERENCE_MISSING]: 'Required reference is missing.',
  [ERROR_CODES.SCHEMA_INVALID]: 'Schema validation failed.',
  [ERROR_CODES.STATE_REQUIREMENT_MISSING]: 'State requirement is missing.',
  [ERROR_CODES.VOCAB_UNKNOWN_KIND]: 'Unknown vocabulary kind.',
  [ERROR_CODES.VOCAB_UNKNOWN_VALUE]: 'Unknown vocabulary value.',
});

const redactFailureDiagnostics = (result) => {
  if (result.ok || !Object.hasOwn(result, 'value')) return result;
  return {
    ...result,
    errors: result.errors.map((error) => ({
      ...error,
      message: error.code.startsWith('CLI_')
        || (error.code === ERROR_CODES.REFERENCE_MISSING
          && error.path === '/governance_locator'
          && error.message === 'Unable to resolve governance locator.')
        ? error.message
        : (publicDiagnosticMessages[error.code] ?? 'Validation failed.'),
    })),
  };
};

const emit = (result, status = result.ok ? 0 : 1) => {
  console.log(JSON.stringify(redactFailureDiagnostics(result)));
  process.exitCode = status;
};

const readInput = async (file, path = '/file') => {
  try {
    return { ok: true, value: await readFile(file, 'utf8') };
  } catch {
    return cliFailure('CLI_READ_ERROR', path, 'Unable to read input file.');
  }
};

const parseJsonInput = (source, path = '/file') => {
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return cliFailure('CLI_JSON_INVALID', path, 'Input file is not valid JSON.');
  }
};

const readJsonInput = async (file, path = '/file') => {
  const source = await readInput(file, path);
  return source.ok ? parseJsonInput(source.value, path) : source;
};

const resolvePointerMap = async (pointerFile, locator) => {
  if (locator.includes('://')) {
    return cliFailure(
      ERROR_CODES.REFERENCE_MISSING,
      '/governance_locator',
      'Unable to resolve governance locator.',
    );
  }
  const mapFile = resolve(dirname(resolve(pointerFile)), locator);
  let source;
  try {
    source = await readFile(mapFile, 'utf8');
  } catch {
    return cliFailure(
      ERROR_CODES.REFERENCE_MISSING,
      '/governance_locator',
      'Unable to resolve governance locator.',
    );
  }
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return cliFailure(
      ERROR_CODES.SCHEMA_INVALID,
      '/governance_locator',
      'Resolved governance target is not valid JSON.',
    );
  }
};

const hasStringGovernanceLocator = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && typeof value.governance_locator === 'string'
  && value.governance_locator.length > 0;

if (command === 'help') {
  emit(ok({
    version,
    commands: ['validate-json', 'validate-pair', 'parse-facts', 'validate-fixtures'],
  }));
} else if (command === 'version') {
  emit(ok({ version }));
} else if (command === 'validate-pair') {
  const [enPath, zhPath, mapPath] = process.argv.slice(3);
  if (!enPath || !zhPath || !mapPath) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: validate-pair <en-path> <zh-path> <project-map>.'), 2);
  } else {
    try {
      const map = await readJsonInput(mapPath);
      if (!map.ok) emit(map, 2);
      else emit(await validateBilingualPair(enPath, zhPath, map.value));
    } catch {
      emit(cliFailure('CLI_VALIDATION_ERROR', '/', 'Validation could not be completed.'), 2);
    }
  }
} else if (command === 'validate-json') {
  const [kind, file] = process.argv.slice(3);
  if (!kind || !file) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: validate-json <kind> <file>.'), 2);
  } else {
    try {
      const input = await readJsonInput(file);
      if (!input.ok) {
        emit(input, 2);
      } else {
        const value = input.value;
        let result;
        if (kind === 'project-pointer' && hasStringGovernanceLocator(value)) {
          const unresolvedResult = validateJson(kind, value);
          if (unresolvedResult.errors.some(({ code }) => code === ERROR_CODES.SCHEMA_INVALID)) {
            result = unresolvedResult;
          } else {
            const resolved = await resolvePointerMap(file, value.governance_locator);
            result = resolved.ok
              ? validateJson(kind, value, { resolvedProjectMap: resolved.value })
              : resolved;
          }
        } else {
          result = validateJson(kind, value);
        }
        emit(result);
      }
    } catch {
      emit(cliFailure('CLI_VALIDATION_ERROR', '/', 'Validation could not be completed.'), 2);
    }
  }
} else if (command === 'parse-facts') {
  const [file] = process.argv.slice(3);
  if (!file) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: parse-facts <file>.'), 2);
  } else {
    const source = await readInput(file);
    if (!source.ok) emit(source, 2);
    else emit(parseFactBlocks(source.value));
  }
} else if (command === 'validate-fixtures') {
  const [root] = process.argv.slice(3);
  if (!root) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: validate-fixtures <fixture-root>.'), 2);
  } else {
    emit(await validateFixtures(root));
  }
} else {
  emit(cliFailure('CLI_UNKNOWN_COMMAND', '/command', 'Unknown command.'), 2);
}
