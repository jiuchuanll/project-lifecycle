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
import { closeDelivery } from '../delivery/close-delivery.mjs';
import { collectDeliveryInventory } from '../delivery/delivery-inventory.mjs';
import { generateDeliveryIndexes } from '../delivery/delivery-indexes.mjs';
import { detectDeliveryLayout } from '../delivery/delivery-layout.mjs';
import {
  inspectLegacyDeliveryLayout,
  migrateDeliveryLayout,
} from '../delivery/delivery-layout-migration.mjs';
import { materializeAsset } from '../delivery/materialize-asset.mjs';
import { applyLayoutTransaction, inspectLifecycleTree } from '../knowledge/layout-transaction.mjs';

const version = '0.7.0';
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

const readBoundedEnvelope = async (file) => {
  const source = await readInput(file, '/input', 1_048_576);
  if (!source.ok) return source;
  const parsed = parseJsonInput(source.value, '/input');
  return parsed.ok && (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value))
    ? cliFailure('CLI_INPUT_INVALID', '/input', 'Input envelope must be one JSON object.')
    : parsed;
};

const deliveryOptions = () => {
  const options = parseNamedOptions(process.argv.slice(3), ['--root', '--input']);
  return options && isAbsolute(options['--root']) && isAbsolute(options['--input']) ? options : null;
};

if (command === 'help') {
  emit(ok({
    version,
    commands: [
      'collect-evidence',
      'close-delivery',
      'generate-delivery-indexes',
      'inspect-delivery-layout',
      'materialize-delivery-asset',
      'migrate-delivery-layout',
      'parse-facts',
      'preview-delivery-layout-migration',
      'sync-alignment-review',
      'validate-alignment-feedback',
      'validate-delivery-layout',
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
} else if (command === 'inspect-delivery-layout') {
  const options = parseNamedOptions(process.argv.slice(3), ['--root']);
  if (!options || !isAbsolute(options['--root'])) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: inspect-delivery-layout --root <absolute-project-root>.'), 2);
  } else emit(await detectDeliveryLayout({ root: options['--root'] }));
} else if (command === 'preview-delivery-layout-migration') {
  const options = deliveryOptions();
  if (!options) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: preview-delivery-layout-migration --root <absolute-project-root> --input <absolute-json-envelope>.'), 2);
  } else {
    const input = await readBoundedEnvelope(options['--input']);
    emit(input.ok
      ? await inspectLegacyDeliveryLayout({ root: options['--root'], owner_mappings: input.value.owner_mappings })
      : input, input.ok ? undefined : 2);
  }
} else if (command === 'migrate-delivery-layout') {
  const options = deliveryOptions();
  if (!options) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: migrate-delivery-layout --root <absolute-project-root> --input <absolute-json-envelope>.'), 2);
  } else {
    const input = await readBoundedEnvelope(options['--input']);
    emit(input.ok ? await migrateDeliveryLayout({ ...input.value, root: options['--root'] }) : input, input.ok ? undefined : 2);
  }
} else if (command === 'validate-delivery-layout') {
  const options = parseNamedOptions(process.argv.slice(3), ['--root']);
  if (!options || !isAbsolute(options['--root'])) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: validate-delivery-layout --root <absolute-project-root>.'), 2);
  } else {
    const layout = await detectDeliveryLayout({ root: options['--root'] });
    if (!layout.ok || layout.value.kind !== 'V2') {
      emit(layout.ok ? cliFailure('DELIVERY_LAYOUT_MIGRATION_REQUIRED', '/root', 'Delivery layout v2 is required.') : layout);
    } else {
      const inventory = await collectDeliveryInventory({ lifecycleRoot: resolve(options['--root'], 'docs/project-lifecycle') });
      emit(inventory.ok ? ok({
        layout_version: inventory.value.layout_version,
        feedback_count: inventory.value.feedbacks.length,
        owner_count: inventory.value.owners.length,
        archived_owner_count: Object.keys(inventory.value.archived_by_owner).length,
      }) : inventory);
    }
  }
} else if (command === 'materialize-delivery-asset') {
  const options = deliveryOptions();
  if (!options) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: materialize-delivery-asset --root <absolute-project-root> --input <absolute-json-envelope>.'), 2);
  } else {
    const input = await readBoundedEnvelope(options['--input']);
    emit(input.ok ? await materializeAsset({ ...input.value, root: options['--root'] }) : input, input.ok ? undefined : 2);
  }
} else if (command === 'close-delivery') {
  const options = deliveryOptions();
  if (!options) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: close-delivery --root <absolute-project-root> --input <absolute-json-envelope>.'), 2);
  } else {
    const input = await readBoundedEnvelope(options['--input']);
    emit(input.ok ? closeDelivery(input.value) : input, input.ok ? undefined : 2);
  }
} else if (command === 'generate-delivery-indexes') {
  const options = parseNamedOptions(process.argv.slice(3), ['--root']);
  if (!options || !isAbsolute(options['--root'])) {
    emit(cliFailure('CLI_USAGE', '/arguments', 'Usage: generate-delivery-indexes --root <absolute-project-root>.'), 2);
  } else {
    const lifecycleRoot = resolve(options['--root'], 'docs/project-lifecycle');
    const [inventory, tree] = await Promise.all([
      collectDeliveryInventory({ lifecycleRoot }),
      inspectLifecycleTree({ repositoryRoot: options['--root'] }),
    ]);
    if (!inventory.ok || !tree.ok) emit(!inventory.ok ? inventory : tree);
    else {
      const indexes = await generateDeliveryIndexes({ inventory: inventory.value });
      if (!indexes.ok) emit(indexes);
      else {
        const published = await applyLayoutTransaction({
          repositoryRoot: options['--root'],
          expectedFingerprint: tree.value.fingerprint,
          candidateFiles: indexes.value.files.map(({ locator, content }) => ({
            repository_id: null,
            locator,
            content,
            validate: async (candidate) => candidate === content ? ok(candidate) : cliFailure('DELIVERY_INDEX_INVALID', `/${locator}`, 'Generated index changed.'),
          })),
          candidateDirectories: [],
          deleteLocators: [],
          validateCandidate: ({ lifecycleRoot: candidateRoot }) => collectDeliveryInventory({ lifecycleRoot: candidateRoot }),
        });
        emit(published.ok ? ok({
          layout_version: 2,
          locators: indexes.value.files.map(({ locator }) => locator),
          changed: published.value.changed,
        }) : published);
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
