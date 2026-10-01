import { lstat, readFile, realpath } from 'node:fs/promises';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import {
  archiveContentHash,
  archiveFrontmatter,
  archiveLifecycleRoot,
  archiveLocatorMatchesFrontmatter,
  resolveArchiveLocator,
  validateArchiveCatalog,
} from './archive-catalog.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[a-z][a-z0-9-]*$/u;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const sameReturned = (left, right) => left.length === right.length
  && left.every((entry, index) => (
    entry.artifact_id === right[index]?.artifact_id
    && entry.content_hash === right[index]?.content_hash
  ));

const validateReuseRecord = (value) => {
  if (!record(value) || !isSafeReference(value.task_ref)
    || !ID.test(value.receipt_id ?? '')
    || !Number.isInteger(value.receipt_revision) || value.receipt_revision < 1
    || !record(value.scope) || !Array.isArray(value.scope.domain_ids)
    || value.scope.domain_ids.length < 1 || value.scope.domain_ids.length > 8
    || Object.keys(value.scope).some((key) => key !== 'domain_ids')
    || !Array.isArray(value.returned_artifacts) || value.returned_artifacts.length > 20
    || Object.keys(value).some((key) => ![
      'task_ref', 'receipt_id', 'receipt_revision', 'scope', 'returned_artifacts',
    ].includes(key))) {
    return false;
  }
  const seen = new Set();
  let previous = null;
  for (const entry of value.returned_artifacts) {
    if (!record(entry) || !ID.test(entry.artifact_id ?? '') || !HASH.test(entry.content_hash ?? '')
      || seen.has(entry.artifact_id)
      || (previous !== null && compareCodePoints(previous, entry.artifact_id) >= 0)
      || Object.keys(entry).some((key) => !['artifact_id', 'content_hash'].includes(key))) return false;
    seen.add(entry.artifact_id);
    previous = entry.artifact_id;
  }
  return value.scope.domain_ids.every((id, index, domains) => ID.test(id)
    && (index === 0 || compareCodePoints(domains[index - 1], id) < 0));
};

const receiptTextValid = (value) => typeof value === 'string'
  && value.trim().length > 0
  && !/[\p{Cc}\p{Cf}]/u.test(value);

const validateReceiptBoundary = (receipt) => {
  const validation = validateJson('archive-access-receipt', receipt);
  if (!validation.ok) return failure('ARCHIVE_RECEIPT_INVALID', '/receipt', 'Archive access requires the bounded shared receipt contract.');
  if (!isSafeReference(receipt.task_ref)
    || !receiptTextValid(receipt.question) || !receiptTextValid(receipt.insufficiency_reason)
    || (receipt.approval_ref !== undefined && !isSafeReference(receipt.approval_ref))) {
    return failure('ARCHIVE_RECEIPT_INVALID', '/receipt', 'Archive receipt reasons and confirmations must be bounded non-empty references.');
  }
  const seenReturned = new Set();
  for (const returned of receipt.returned_artifacts) {
    if (seenReturned.has(returned.artifact_id)) {
      return failure('ARCHIVE_RECEIPT_INVALID', '/receipt/returned_artifacts', 'Archive returned artifact IDs must be unique.');
    }
    seenReturned.add(returned.artifact_id);
  }
  return ok(receipt);
};

const loadMap = async (root) => {
  const lifecycleRoot = await archiveLifecycleRoot(root);
  const lexical = await resolveInside(lifecycleRoot, 'project-map.json');
  const state = await lstat(lexical);
  const physical = await realpath(lexical);
  if (!state.isFile() || state.isSymbolicLink()) {
    throw Object.assign(new Error('Regular project map required.'), { code: 'PATH_SYMLINK_ESCAPE' });
  }
  const map = JSON.parse(await readFile(physical, 'utf8'));
  const validation = validateJson('project-map', map);
  if (!validation.ok) throw Object.assign(new Error('Validated project map required.'), { code: 'ARCHIVE_PROJECT_INVALID' });
  return { lifecycleRoot, map };
};

export async function resolveArchiveArtifacts(input = {}, operations = {}) {
  if (typeof input.current_context_sufficient !== 'boolean'
    || typeof input.closed_summary_sufficient !== 'boolean'
    || typeof input.material_decision_changed !== 'boolean') {
    return failure('ARCHIVE_INPUT_INVALID', '/arguments', 'Explicit current and closed-summary sufficiency decisions are required.');
  }
  if (input.current_context_sufficient || input.closed_summary_sufficient) {
    return ok({
      artifacts: [],
      read_log: [],
      reuse_record: null,
      durable_evidence_recommendation: null,
    });
  }

  const catalogValidation = validateArchiveCatalog(input.catalog);
  if (!catalogValidation.ok) return catalogValidation;
  const receiptValidation = validateReceiptBoundary(input.receipt);
  if (!receiptValidation.ok) return receiptValidation;
  const receipt = input.receipt;
  const previous = input.previous_record;
  if (previous !== undefined && !validateReuseRecord(previous)) {
    return failure('ARCHIVE_REUSE_INVALID', '/previous_record', 'Task-local archive reuse state is malformed.');
  }
  if (previous === undefined && receipt.returned_artifacts.length > 0) {
    return failure('ARCHIVE_REUSE_INVALID', '/receipt/returned_artifacts', 'Returned archive hashes require their exact task-local reuse record.');
  }
  if (previous !== undefined && (previous.task_ref !== receipt.task_ref
    || !sameReturned(previous.returned_artifacts, receipt.returned_artifacts))) {
    return failure('ARCHIVE_REUSE_INVALID', '/previous_record', 'Receipt returns must match the exact task-local reuse record.');
  }

  const catalogById = new Map(input.catalog.artifacts.map((entry) => [entry.artifact_id, entry]));
  const selected = [];
  for (const [index, artifactId] of receipt.artifact_ids.entries()) {
    const entry = catalogById.get(artifactId);
    if (!entry || entry.retention_tier !== 'archive') {
      return failure('ARCHIVE_ARTIFACT_INVALID', `/artifact_ids/${index}`, 'Receipt artifact IDs must resolve to exact archived catalog entries.');
    }
    if (entry.domain_ids.some((id) => !receipt.scope.domain_ids.includes(id))) {
      return failure('ARCHIVE_SCOPE_INVALID', `/artifact_ids/${index}`, 'Archive artifacts must remain inside the exact receipt domain scope.');
    }
    selected.push(entry);
  }

  const previousHashes = new Map((previous?.returned_artifacts ?? []).map((entry) => [entry.artifact_id, entry.content_hash]));
  const expansion = selected.some((entry) => !previousHashes.has(entry.artifact_id))
    || receipt.scope.domain_ids.some((id) => !(previous?.scope.domain_ids ?? []).includes(id));
  const changed = selected.some((entry) => (
    previousHashes.has(entry.artifact_id) && previousHashes.get(entry.artifact_id) !== entry.content_hash
  ));
  const crossDomain = receipt.scope.domain_ids.length > 1;
  if ((previous !== undefined && (expansion || changed)) || crossDomain) {
    if (receipt.approval_ref === undefined
      || (previous !== undefined && receipt.receipt_id === previous.receipt_id)) {
      return failure(
        'ARCHIVE_CONFIRMATION_REQUIRED',
        '/receipt',
        'Archive expansion, changed content, or cross-domain scope requires a new explicitly confirmed receipt.',
      );
    }
  }

  let lifecycleRoot;
  let map;
  try {
    ({ lifecycleRoot, map } = await loadMap(input.root));
  } catch (error) {
    return failure(error?.code ?? 'ARCHIVE_ROOT_INVALID', '/', 'A bounded validated lifecycle root is required.');
  }
  if (map.project_id !== input.catalog.project_id
    || selected.some((entry) => entry.current_project_id !== map.project_id
      || entry.project_id_at_creation !== map.project_id)
    || receipt.scope.domain_ids.some((id) => !map.domains.some((domain) => domain.id === id))) {
    return failure('ARCHIVE_PROJECT_INVALID', '/catalog', 'Archive catalog, receipt scope, and current project identity must agree.');
  }

  const onRead = typeof operations?.onRead === 'function' ? operations.onRead : () => {};
  const readLog = [];
  const artifacts = [];
  for (const [index, entry] of selected.entries()) {
    if (previousHashes.get(entry.artifact_id) === entry.content_hash) {
      artifacts.push({
        artifact_id: entry.artifact_id,
        locator: entry.locator,
        content_hash: entry.content_hash,
        content: null,
        reused: true,
      });
      continue;
    }
    let content;
    let actualHash;
    try {
      const physical = await resolveArchiveLocator(lifecycleRoot, entry.locator);
      const bytes = await readFile(physical);
      actualHash = archiveContentHash(bytes);
      const event = {
        artifact_id: entry.artifact_id,
        locator: entry.locator,
        content_hash: actualHash,
        outcome: actualHash === entry.content_hash ? 'returned' : 'hash-mismatch',
      };
      readLog.push(event);
      onRead(event);
      if (actualHash !== entry.content_hash) {
        return failure('ARCHIVE_HASH_MISMATCH', `/artifact_ids/${index}`, 'Archive content no longer matches the approved catalog hash.');
      }
      const frontmatter = archiveFrontmatter(bytes);
      if (!frontmatter || frontmatter.artifact_id !== entry.artifact_id
        || frontmatter.retention_tier !== 'archive'
        || !archiveLocatorMatchesFrontmatter(frontmatter, entry.locator)
        || frontmatter.project_id_at_creation !== entry.project_id_at_creation
        || JSON.stringify(frontmatter.domain_ids) !== JSON.stringify(entry.domain_ids)) {
        return failure('ARCHIVE_CATALOG_MISMATCH', `/artifact_ids/${index}`, 'Archive content metadata no longer matches the approved catalog entry.');
      }
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      if (error?.code === 'ARCHIVE_HASH_MISMATCH') throw error;
      return failure(error?.code ?? 'ARCHIVE_READ_INVALID', `/artifact_ids/${index}`, 'Approved archive content could not be read safely.');
    }
    artifacts.push({
      artifact_id: entry.artifact_id,
      locator: entry.locator,
      content_hash: actualHash,
      content,
      reused: false,
    });
  }

  const returnedArtifacts = selected.map((entry) => ({
    artifact_id: entry.artifact_id,
    content_hash: entry.content_hash,
  }));
  const reuseRecord = {
    task_ref: receipt.task_ref,
    receipt_id: receipt.receipt_id,
    receipt_revision: (previous?.receipt_revision ?? 0) + 1,
    scope: { domain_ids: [...receipt.scope.domain_ids] },
    returned_artifacts: returnedArtifacts,
  };
  const recommendation = input.material_decision_changed ? {
    disposition: 'candidate-evidence-only',
    artifact_refs: selected.map((entry) => ({
      artifact_id: entry.artifact_id,
      content_hash: entry.content_hash,
      locator: entry.locator,
    })),
    auto_promote_current: false,
  } : null;

  return ok({
    artifacts,
    read_log: readLog,
    reuse_record: reuseRecord,
    durable_evidence_recommendation: recommendation,
  });
}
