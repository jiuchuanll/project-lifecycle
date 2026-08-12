#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { atomicWriteValidated } from '../lib/atomic-write.mjs';
import { ERROR_CODES, createError } from '../lib/errors.mjs';
import { validateBilingualPair } from '../lib/bilingual-pair.mjs';
import { parseFactBlocks } from '../lib/fact-blocks.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { collectEvidence } from '../knowledge/collect-evidence.mjs';
import { validateFixtures } from '../validate-fixtures.mjs';
import { validateAlignmentFeedbackDocuments } from '../delivery/alignment-marker.mjs';
import { syncAlignmentReview } from '../delivery/alignment-review.mjs';

const version = '0.4.0';
const MAX_ALIGNMENT_DOCUMENT_BYTES = 262_144;
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

const readInput = async (file, path = '/file', maximumBytes = null) => {
  try {
    if (maximumBytes === null) return { ok: true, value: await readFile(file, 'utf8') };
    const pathState = await stat(file);
    if (!pathState.isFile()) return cliFailure('CLI_READ_ERROR', path, 'Bounded input must be a regular file.');
    const handle = await open(file, 'r');
    try {
      const state = await handle.stat();
      if (!state.isFile()) return cliFailure('CLI_READ_ERROR', path, 'Bounded input must be a regular file.');
      if (state.size > maximumBytes) {
        return cliFailure('CLI_INPUT_TOO_LARGE', path, 'Input file exceeds the bounded size limit.');
      }
      const buffer = Buffer.allocUnsafe(maximumBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > maximumBytes) {
        return cliFailure('CLI_INPUT_TOO_LARGE', path, 'Input file exceeds the bounded size limit.');
      }
      return { ok: true, value: buffer.subarray(0, total).toString('utf8') };
    } finally {
      await handle.close();
    }
  } catch {
    return cliFailure('CLI_READ_ERROR', path, 'Unable to read input file.');
  }
};

const samePhysicalFile = async (left, right) => {
  try {
    const [leftReal, rightReal] = await Promise.all([realpath(left), realpath(right)]);
    if (leftReal === rightReal) return { ok: true, value: true };
    const [leftState, rightState] = await Promise.all([stat(leftReal), stat(rightReal)]);
    return {
      ok: true,
      value: leftState.dev === rightState.dev && leftState.ino === rightState.ino,
    };
  } catch {
    return cliFailure('CLI_READ_ERROR', '/documents', 'Unable to identify bilingual input files.');
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

const parseNamedOptions = (args, names) => {
  const allowed = new Set(names);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name) || typeof value !== 'string' || value.startsWith('--')
      || Object.hasOwn(values, name)) {
      return null;
    }
    values[name] = value;
  }
  return Object.keys(values).length === names.length ? values : null;
};

const isInside = (base, candidate) => {
  const fromBase = relative(base, candidate);
  return fromBase === '' || (!fromBase.startsWith(`..${sep}`) && fromBase !== '..' && !isAbsolute(fromBase));
};

const validAlignmentState = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === 3
  && ['feedbacks', 'owners', 'closures'].every((field) => (
    Array.isArray(value[field]) && value[field].length <= 1000
  ));

if (command === 'help') {
  emit(ok({
    version,
    commands: [
      'collect-evidence',
      'parse-facts',
      'sync-alignment-review',
      'validate-alignment-feedback',
      'validate-fixtures',
      'validate-json',
      'validate-pair',
    ],
  }));
} else if (command === 'version') {
  emit(ok({ version }));
} else if (command === 'collect-evidence') {
  const options = parseNamedOptions(process.argv.slice(3), ['--root', '--output']);
  if (!options) {
    emit(cliFailure(
      'CLI_USAGE',
      '/arguments',
      'Usage: collect-evidence --root <absolute-path> --output <absolute-path>.',
    ), 2);
  } else if (!isAbsolute(options['--root']) || !isAbsolute(options['--output'])) {
    emit(cliFailure('CLI_PATH_INVALID', '/arguments', 'Root and output paths must be absolute.'), 2);
  } else {
    try {
      const lexicalLifecycleRoot = resolve(options['--root'], 'docs/project-lifecycle');
      const lexicalOutput = resolve(options['--output']);
      if (isInside(lexicalLifecycleRoot, lexicalOutput)) {
        emit(cliFailure(
          'CLI_OUTPUT_FORBIDDEN',
          '/output',
          'Evidence output must remain outside docs/project-lifecycle.',
        ), 2);
      } else {
        const root = await realpath(options['--root']);
        const outputParent = await realpath(dirname(options['--output']));
        const outputName = basename(options['--output']);
        const output = resolve(outputParent, outputName);
        const lifecycleRoot = resolve(root, 'docs/project-lifecycle');
        const physicalLifecycleRoots = [lifecycleRoot];
        try {
          physicalLifecycleRoots.push(await realpath(lifecycleRoot));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (physicalLifecycleRoots.some((candidate) => isInside(candidate, output))) {
          emit(cliFailure(
            'CLI_OUTPUT_FORBIDDEN',
            '/output',
            'Evidence output must remain outside docs/project-lifecycle.',
          ), 2);
        } else {
          const pack = await collectEvidence({ root });
          const content = `${JSON.stringify(pack, null, 2)}\n`;
          await atomicWriteValidated({
            root: outputParent,
            target: outputName,
            content,
            validate: async (candidate) => candidate === content
              ? ok(candidate)
              : cliFailure('CLI_WRITE_ERROR', '/output', 'Evidence output validation failed.'),
          });
          emit(ok({
            entry_count: pack.entries.length,
            content_hash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
          }));
        }
      }
    } catch (error) {
      const scanOverflow = error?.code === 'EVIDENCE_SCAN_LIMIT_EXCEEDED';
      emit(cliFailure(
        scanOverflow ? error.code : 'CLI_COLLECTION_ERROR',
        '/',
        scanOverflow
          ? 'Evidence scan limit exceeded.'
          : 'Evidence collection could not be completed.',
      ), 2);
    }
  }
} else if (command === 'validate-alignment-feedback') {
  const [enPath, zhPath, mapPath] = process.argv.slice(3);
  if (!enPath || !zhPath || !mapPath || process.argv.length !== 6) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: validate-alignment-feedback <en-path> <zh-path> <project-map>.'), 2);
  } else {
    const [en, zh, mapSource] = await Promise.all([
      readInput(enPath, '/documents/en', MAX_ALIGNMENT_DOCUMENT_BYTES),
      readInput(zhPath, '/documents/zh-CN', MAX_ALIGNMENT_DOCUMENT_BYTES),
      readInput(mapPath, '/project_map', 1_048_576),
    ]);
    if (!en.ok || !zh.ok || !mapSource.ok) {
      emit(!en.ok ? en : !zh.ok ? zh : mapSource, 2);
    } else {
      const sameInput = await samePhysicalFile(enPath, zhPath);
      const map = parseJsonInput(mapSource.value, '/project_map');
      if (!sameInput.ok) emit(sameInput, 2);
      else if (sameInput.value) {
        emit(cliFailure('PAIR_MACHINE_MISMATCH', '/documents', 'Bilingual inputs must be distinct physical files.'));
      } else if (!map.ok) emit(map, 2);
      else {
        const result = validateAlignmentFeedbackDocuments({
          documents: { en: en.value, 'zh-CN': zh.value },
          projectMap: map.value,
        });
        emit(result.ok ? ok({
          feedback_id: result.value.feedback_id,
          primary_domain_id: result.value.primary_domain_id,
          routing_disposition: result.value.routing_disposition,
        }) : result);
      }
    }
  }
} else if (command === 'sync-alignment-review') {
  const options = parseNamedOptions(process.argv.slice(3), ['--root', '--input']);
  if (!options || !isAbsolute(options['--root']) || !isAbsolute(options['--input'])) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: sync-alignment-review --root <absolute-project-root> --input <absolute-json-envelope>.'), 2);
  } else {
    const source = await readInput(options['--input'], '/input', 1_048_576);
    if (!source.ok) emit(source, 2);
    else {
      const state = parseJsonInput(source.value, '/input');
      if (!state.ok) emit(state, 2);
      else if (!validAlignmentState(state.value)) {
        emit(cliFailure('CLI_INPUT_INVALID', '/input', 'Alignment state must contain only bounded feedbacks, owners, and closures arrays.'), 2);
      } else {
        const result = await syncAlignmentReview({ ...state.value, root: options['--root'] });
        emit(result.ok ? ok({
          row_count: result.value.row_count,
          phases: result.value.phases,
          locators: result.value.locators,
        }) : result);
      }
    }
  }
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
