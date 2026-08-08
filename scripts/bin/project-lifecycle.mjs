#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { ERROR_CODES, createError } from '../lib/errors.mjs';
import { validateBilingualPair } from '../lib/bilingual-pair.mjs';
import { fail } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { validateFixtures } from '../validate-fixtures.mjs';

const version = '0.1.0';
const command = process.argv[2] ?? 'help';

const resolvePointerMap = async (pointerFile, locator) => {
  if (locator.includes('://')) throw new Error('governance_locator must resolve to a local project map.');
  const mapFile = resolve(dirname(resolve(pointerFile)), locator);
  return JSON.parse(await readFile(mapFile, 'utf8'));
};

const hasStringGovernanceLocator = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && typeof value.governance_locator === 'string'
  && value.governance_locator.length > 0;

if (command === 'help') {
  console.log(`Project Lifecycle ${version}

Commands:
  validate-json
  validate-pair
  parse-facts
  validate-fixtures`);
} else if (command === 'version') {
  console.log(version);
} else if (command === 'validate-pair') {
  const [enPath, zhPath, mapPath] = process.argv.slice(3);
  if (!enPath || !zhPath || !mapPath) {
    console.error('CLI_VALIDATE_PAIR_USAGE: validate-pair <en-path> <zh-path> <project-map>');
    process.exitCode = 2;
  } else {
    try {
      const map = JSON.parse(await readFile(mapPath, 'utf8'));
      const result = await validateBilingualPair(enPath, zhPath, map);
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(`CLI_VALIDATE_PAIR_ERROR: ${error.message}`);
      process.exitCode = 2;
    }
  }
} else if (command === 'validate-json') {
  const [kind, file] = process.argv.slice(3);
  if (!kind || !file) {
    console.error('CLI_VALIDATE_JSON_USAGE: validate-json <kind> <file>');
    process.exitCode = 2;
  } else {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      let result;
      if (kind === 'project-pointer' && hasStringGovernanceLocator(value)) {
        try {
          const resolvedProjectMap = await resolvePointerMap(file, value.governance_locator);
          result = validateJson(kind, value, { resolvedProjectMap });
        } catch (error) {
          const unresolvedResult = validateJson(kind, value);
          result = unresolvedResult.errors.some(({ code }) => code === ERROR_CODES.SCHEMA_INVALID)
            ? unresolvedResult
            : fail([
              createError(ERROR_CODES.REFERENCE_MISSING, '/governance_locator', 'Unable to resolve governance locator.'),
            ]);
        }
      } else {
        result = validateJson(kind, value);
      }
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(`CLI_VALIDATE_JSON_ERROR: ${error.message}`);
      process.exitCode = 2;
    }
  }
} else if (command === 'validate-fixtures') {
  const [root] = process.argv.slice(3);
  if (!root) {
    console.error('CLI_VALIDATE_FIXTURES_USAGE: validate-fixtures <fixture-root>');
    process.exitCode = 2;
  } else {
    const result = await validateFixtures(root);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }
} else {
  console.error(`CLI_UNKNOWN_COMMAND: ${command}`);
  process.exitCode = 2;
}
