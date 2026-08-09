import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { atomicWriteValidated } from '../lib/atomic-write.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const ID = /^prd-[a-z0-9-]+$/u;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const selectionKeys = new Set([
  'knowledge_baseline',
  'intent_summary',
  'route',
  'selected_context',
  'material_exclusions',
  'open_questions',
  'stop',
]);

const outside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
};

const safeDirectory = async (path, rootReal, create) => {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await mkdir(path);
    stats = await lstat(path);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw Object.assign(new Error('Unsafe runtime directory.'), { code: 'CONTEXT_PATH_INVALID' });
  }
  const physical = await realpath(path);
  if (outside(rootReal, physical)) {
    throw Object.assign(new Error('Runtime directory escapes the worktree.'), { code: 'CONTEXT_PATH_INVALID' });
  }
  return physical;
};

export const resolveContextReceiptPaths = async ({ root, prd_id: prdId, create = false }) => {
  if (typeof root !== 'string' || !isAbsolute(root) || !ID.test(prdId ?? '')) {
    throw Object.assign(new Error('Invalid runtime root or PRD ID.'), { code: 'CONTEXT_PATH_INVALID' });
  }
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw Object.assign(new Error('Worktree root must be a real directory.'), { code: 'CONTEXT_PATH_INVALID' });
  }
  const rootReal = await realpath(root);
  let current = rootReal;
  for (const segment of ['.project-lifecycle', 'runtime', 'prds', prdId]) {
    current = join(current, segment);
    current = await safeDirectory(current, rootReal, create);
  }
  return {
    rootReal,
    prdDirectory: current,
    receiptPath: join(current, 'context-receipt.json'),
    locator: `.project-lifecycle/runtime/prds/${prdId}/context-receipt.json`,
  };
};

const dedupeById = (entries, path) => {
  if (!Array.isArray(entries)) return failure('CONTEXT_SELECTION_INVALID', path, 'Selection entries must be arrays.');
  const byId = new Map();
  for (const entry of entries) {
    if (!record(entry) || typeof entry.id !== 'string') {
      return failure('CONTEXT_SELECTION_INVALID', path, 'Selection entries require stable IDs.');
    }
    const existing = byId.get(entry.id);
    if (existing && !isDeepStrictEqual(existing, entry)) {
      return failure('CONTEXT_SELECTION_CONFLICT', `${path}/${entry.id}`, 'Duplicate selected IDs disagree on their machine fields.');
    }
    byId.set(entry.id, entry);
  }
  return ok([...byId.values()].sort((left, right) => compareCodePoints(left.id, right.id)));
};

const normalizeSelection = (selection, prdId, revision, updatedAt) => {
  if (!record(selection) || Object.keys(selection).some((key) => !selectionKeys.has(key))
    || !record(selection.route)) {
    return failure('CONTEXT_SELECTION_INVALID', '/selection', 'A closed accepted selection shape is required.');
  }
  const selected = dedupeById(selection.selected_context, '/selection/selected_context');
  if (!selected.ok) return selected;
  const excluded = dedupeById(selection.material_exclusions, '/selection/material_exclusions');
  if (!excluded.ok) return excluded;
  if (!isSafeReference(selection.knowledge_baseline)
    || selected.value.some(({ version_ref: versionRef }) => !isSafeReference(versionRef))) {
    return failure('CONTEXT_REFERENCE_INVALID', '/selection', 'Context selection references must be safe bounded references.');
  }
  if (!Array.isArray(selection.route.affected_domain_ids) || !Array.isArray(selection.open_questions)) {
    return failure('CONTEXT_SELECTION_INVALID', '/selection', 'Route and question arrays are required.');
  }
  const receipt = {
    schema_version: 1,
    prd_id: prdId,
    receipt_revision: revision,
    updated_at: updatedAt,
    knowledge_baseline: selection.knowledge_baseline,
    intent_summary: selection.intent_summary,
    route: {
      primary_domain_id: selection.route.primary_domain_id,
      affected_domain_ids: [...new Set(selection.route.affected_domain_ids)].sort(compareCodePoints),
    },
    selected_context: selected.value,
    material_exclusions: excluded.value,
    open_questions: [...new Set(selection.open_questions)].sort(compareCodePoints),
    stop: selection.stop,
  };
  const validation = validateJson('context-receipt', receipt);
  return validation.ok
    ? ok(receipt)
    : failure('CONTEXT_SELECTION_INVALID', '/selection', 'Selection cannot produce a valid shared Context Receipt.');
};

const parseReceipt = (source) => {
  try {
    const value = JSON.parse(source);
    return validateJson('context-receipt', value).ok ? value : null;
  } catch {
    return null;
  }
};

const readExisting = async (receiptPath) => {
  try {
    const stats = await lstat(receiptPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw Object.assign(new Error('Receipt target is unsafe.'), { code: 'CONTEXT_PATH_INVALID' });
    }
    const source = await readFile(receiptPath, 'utf8');
    return { exists: true, source, value: parseReceipt(source) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, source: null, value: null };
    throw error;
  }
};

export async function writeContextReceipt(input = {}, operations = {}) {
  if (!record(input) || input.writer !== 'run-prd-lifecycle') {
    return failure('CONTEXT_WRITER_FORBIDDEN', '/writer', 'Only run-prd-lifecycle may write the PRD Context Receipt.');
  }
  let paths;
  let existing;
  try {
    paths = await resolveContextReceiptPaths({ root: input.root, prd_id: input.prd_id, create: true });
    existing = await readExisting(paths.receiptPath);
  } catch {
    return failure('CONTEXT_PATH_INVALID', '/root', 'The Context Receipt path must remain inside the explicit worktree runtime root.');
  }

  const revision = existing.value ? existing.value.receipt_revision + 1 : 1;
  const updatedAt = (operations.now ?? (() => new Date().toISOString()))();
  const receipt = normalizeSelection(input.selection, input.prd_id, revision, updatedAt);
  if (!receipt.ok) return receipt;
  const content = `${JSON.stringify(receipt.value, null, 2)}\n`;
  const write = operations.atomicWriteValidated ?? atomicWriteValidated;
  try {
    await write({
      root: paths.prdDirectory,
      target: 'context-receipt.json',
      content,
      validate: async (source) => {
        const value = parseReceipt(source);
        return value && isDeepStrictEqual(value, receipt.value)
          ? ok(value)
        : failure('CONTEXT_RECEIPT_INVALID', '/', 'Written receipt did not preserve the accepted snapshot.');
      },
    });
    const published = await readExisting(paths.receiptPath);
    if (!published.value || !isDeepStrictEqual(published.value, receipt.value)) {
      throw new Error('Context Receipt publication postcondition failed.');
    }
  } catch {
    return failure('CONTEXT_RECEIPT_WRITE_FAILED', '/receipt', 'Context Receipt refresh failed; the last valid snapshot remains authoritative.');
  }
  return ok({
    locator: paths.locator,
    receipt: receipt.value,
    status: existing.exists ? (existing.value ? 'refreshed' : 'regenerated') : 'created',
  });
}

export async function readContextReceipt({ root, prd_id: prdId, expected_knowledge_baseline: baseline } = {}) {
  let paths;
  let existing;
  try {
    paths = await resolveContextReceiptPaths({ root, prd_id: prdId, create: false });
    existing = await readExisting(paths.receiptPath);
  } catch {
    return failure('CONTEXT_RECEIPT_MISSING', '/receipt', 'No valid current PRD Context Receipt is available.');
  }
  if (!existing.value) return failure('CONTEXT_RECEIPT_INVALID', '/receipt', 'The current PRD Context Receipt is malformed.');
  if (baseline !== undefined && existing.value.knowledge_baseline !== baseline) {
    return failure('CONTEXT_RECEIPT_STALE', '/knowledge_baseline', 'The Context Receipt must be refreshed against the accepted baseline.');
  }
  return ok({ locator: paths.locator, receipt: existing.value });
}
