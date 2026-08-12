import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { stringify as stringifyYaml } from 'yaml';

import { atomicWriteValidated } from '../lib/atomic-write.mjs';
import { createError } from '../lib/errors.mjs';
import { maskFencedMarkdown, parseRestrictedYaml } from '../lib/markdown.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { validateAlignmentExit, validateAlignmentFeedbackPair } from './alignment-marker.mjs';
import { validateClosureSummary } from './close-delivery.mjs';

const MAX_BODY_BYTES = 131_072;
const MAX_DOCUMENT_BYTES = MAX_BODY_BYTES * 2;
const FEEDBACK_SOURCE_SECTIONS = ['original_problem', 'scenario', 'expectation'];
const FEEDBACK_MUTABLE_SECTIONS = ['marking', 'coverage'];
const FEEDBACK_HASH_MARKER = /^<!-- project-lifecycle:feedback-source-hashes [^\n]+ -->\n?/u;
const CLOSURE_SUMMARY_MARKER = /^<!-- project-lifecycle:closure-summary sha256=([0-9a-f]{64}) -->\n?/u;
const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const closureSummaryHash = (summary) => hash(JSON.stringify(canonicalize(summary)));
const boundedText = (value) => typeof value === 'string'
  && value.trim().length > 0
  && value.length <= 500
  && !/[\p{Cc}\p{Cf}]/u.test(value);

const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const requireRegularDirectory = async (path, rootReal = null) => {
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Unsafe delivery directory.');
  const physical = await realpath(path);
  if (rootReal !== null && !inside(rootReal, physical)) throw new Error('Delivery directory escapes project root.');
  return physical;
};

const resolveLifecycleRoot = async (root) => {
  const projectRoot = await requireRegularDirectory(root);
  const docsRoot = await requireRegularDirectory(join(root, 'docs'), projectRoot);
  const lifecycleRoot = await requireRegularDirectory(join(root, 'docs', 'project-lifecycle'), projectRoot);
  if (!inside(docsRoot, lifecycleRoot)) throw new Error('Lifecycle root escapes docs root.');
  const deliveryRoot = await requireRegularDirectory(join(root, 'docs', 'project-lifecycle', 'delivery'), lifecycleRoot);
  if (!inside(lifecycleRoot, deliveryRoot)) throw new Error('Delivery root escapes lifecycle root.');
  return lifecycleRoot;
};

const headingLevels = (source) => [...source.matchAll(/^(#{1,6})[ \t]+\S.*$/gm)]
  .map((match) => match[1].length);

const sectionPattern = (id) => new RegExp(
  `<!-- project-lifecycle:section ${id} -->\\n([\\s\\S]*?)\\n<!-- /project-lifecycle:section -->`,
  'u',
);

const extractFeedbackSections = (body) => {
  const normalized = withoutManagedFeedbackHash(body);
  const visible = maskFencedMarkdown(normalized);
  const sections = {};
  for (const id of [...FEEDBACK_SOURCE_SECTIONS, ...FEEDBACK_MUTABLE_SECTIONS]) {
    const matches = [...visible.matchAll(new RegExp(sectionPattern(id).source, 'gu'))];
    if (matches.length !== 1 || matches[0][1].trim().length === 0) return null;
    const opening = `<!-- project-lifecycle:section ${id} -->\n`;
    const closing = '\n<!-- /project-lifecycle:section -->';
    const start = matches[0].index + opening.length;
    const end = matches[0].index + matches[0][0].length - closing.length;
    sections[id] = normalized.slice(start, end).trim();
  }
  return sections;
};

const sourceHashes = (sections) => Object.fromEntries(
  FEEDBACK_SOURCE_SECTIONS.map((id) => [id, hash(sections[id])]),
);

const feedbackHashMarker = (hashes) => `<!-- project-lifecycle:feedback-source-hashes ${FEEDBACK_SOURCE_SECTIONS
  .map((id) => `${id}=${hashes[id]}`).join(' ')} -->`;

const withoutManagedFeedbackHash = (body) => {
  const normalized = body.replaceAll('\r\n', '\n').replace(/^\n/u, '');
  if (FEEDBACK_HASH_MARKER.test(normalized)) return normalized.replace(FEEDBACK_HASH_MARKER, '');
  const title = /^(#[ \t]+[^\n]+\n(?:\n)?)/u.exec(normalized);
  if (title) {
    const rest = normalized.slice(title[0].length);
    return FEEDBACK_HASH_MARKER.test(rest)
      ? `${title[0]}${rest.replace(FEEDBACK_HASH_MARKER, '')}`
      : normalized;
  }
  const legacyPrefix = /^(<!-- project-lifecycle:section original_problem -->\n\n)/u.exec(normalized);
  if (!legacyPrefix) return normalized;
  const rest = normalized.slice(legacyPrefix[0].length);
  return FEEDBACK_HASH_MARKER.test(rest)
    ? `${legacyPrefix[0]}${rest.replace(FEEDBACK_HASH_MARKER, '')}`
    : normalized;
};

const addFeedbackHashes = (body, hashes) => {
  const withoutMarker = withoutManagedFeedbackHash(body);
  const title = /^(#[ \t]+[^\n]+\n(?:\n)?)/u.exec(withoutMarker);
  if (!title) return `${feedbackHashMarker(hashes)}\n${withoutMarker}`;
  return `${title[0]}${feedbackHashMarker(hashes)}\n${withoutMarker.slice(title[0].length)}`;
};

const closureSummaryMarker = (digest) => `<!-- project-lifecycle:closure-summary sha256=${digest} -->`;

const withoutManagedClosureSummaryHash = (body) => {
  const normalized = body.replaceAll('\r\n', '\n').replace(/^\n/u, '');
  if (CLOSURE_SUMMARY_MARKER.test(normalized)) return normalized.replace(CLOSURE_SUMMARY_MARKER, '');
  const title = /^(#[ \t]+[^\n]+\n(?:\n)?)/u.exec(normalized);
  if (!title) return normalized;
  const rest = normalized.slice(title[0].length);
  return CLOSURE_SUMMARY_MARKER.test(rest)
    ? `${title[0]}${rest.replace(CLOSURE_SUMMARY_MARKER, '')}`
    : normalized;
};

const addClosureSummaryHash = (body, digest) => {
  const withoutMarker = withoutManagedClosureSummaryHash(body);
  const title = /^(#[ \t]+[^\n]+\n(?:\n)?)/u.exec(withoutMarker);
  if (!title) return `${closureSummaryMarker(digest)}\n${withoutMarker}`;
  return `${title[0]}${closureSummaryMarker(digest)}\n${withoutMarker.slice(title[0].length)}`;
};

const extractClosureSummaryHash = (body) => {
  const normalized = body.replaceAll('\r\n', '\n').replace(/^\n/u, '');
  const direct = CLOSURE_SUMMARY_MARKER.exec(normalized);
  if (direct) return direct[1];
  const title = /^(#[ \t]+[^\n]+\n(?:\n)?)/u.exec(normalized);
  return title ? CLOSURE_SUMMARY_MARKER.exec(normalized.slice(title[0].length))?.[1] ?? null : null;
};

const feedbackSkeleton = (body) => {
  let output = withoutManagedFeedbackHash(body);
  for (const id of FEEDBACK_MUTABLE_SECTIONS) {
    output = output.replace(sectionPattern(id), `<!-- project-lifecycle:section ${id} -->\n[MUTABLE]\n<!-- /project-lifecycle:section -->`);
  }
  return output.replaceAll('\r\n', '\n').replace(/^\n/u, '');
};

const withoutDocumentTitle = (body) => body.replaceAll('\r\n', '\n').replace(/^\n/u, '')
  .replace(/^#[ \t]+[^\n]+\n(?:\n)?/u, '');

const hasExactCoverageReference = (coverage, reference) => {
  const tokens = coverage.split(/[\s;,；，]+/u).filter((token) => token.length > 0);
  return tokens.includes(reference);
};

const feedbackFrame = (body) => {
  let output = withoutManagedFeedbackHash(withoutDocumentTitle(body));
  for (const id of [...FEEDBACK_SOURCE_SECTIONS, ...FEEDBACK_MUTABLE_SECTIONS]) {
    output = output.replace(sectionPattern(id), `<!-- project-lifecycle:section-frame ${id} -->`);
  }
  return output.replace(/\s+/gu, ' ').trim();
};

const splitDocument = (source) => {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return null;
  const closing = normalized.indexOf('\n---\n', 4);
  if (closing === -1) return null;
  const parsed = parseRestrictedYaml(normalized.slice(4, closing), '/frontmatter');
  if (!parsed.ok) return null;
  return { frontmatter: parsed.value, body: normalized.slice(closing + 5) };
};

const renderDocument = (frontmatter, body) => `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;

const validateRendered = (source, expectedFrontmatter, expectedBody) => {
  const parsed = splitDocument(source);
  if (!parsed || !isDeepStrictEqual(parsed.frontmatter, expectedFrontmatter)
    || parsed.body !== (expectedBody.startsWith('\n') ? expectedBody : `\n${expectedBody}`)) {
    return failure('DELIVERY_DOCUMENT_INVALID', '/', 'Rendered delivery document does not match its validated request.');
  }
  return validateJson('delivery-frontmatter', parsed.frontmatter);
};

const compatibleRoute = ({ artifact_kind: kind, primary_route: route }) => {
  if (route === 'KNOWLEDGE_UPDATE') return kind === 'feedback';
  if (route === 'OUTSIDE_PLUGIN') return false;
  if (kind === 'prd') return route === 'PRD_DELIVERY';
  if (kind === 'non-prd-delivery') return route === 'NON_PRD_DELIVERY';
  return ['PRD_DELIVERY', 'NON_PRD_DELIVERY'].includes(route);
};

export const validateMaterializationRequest = (input = {}) => {
  if (!record(input) || !record(input.frontmatter) || !record(input.body)
    || typeof input.body.en !== 'string' || typeof input.body['zh-CN'] !== 'string'
    || !boundedText(input.reason)) {
    return failure('ASSET_REQUEST_INVALID', '/', 'A bounded explicit delivery asset request is required.');
  }
  const frontmatter = validateJson('delivery-frontmatter', input.frontmatter);
  if (!frontmatter.ok) return failure('ASSET_FRONTMATTER_INVALID', '/frontmatter', 'Delivery Frontmatter must satisfy the shared contract.');
  if (input.canonical_purpose_satisfied === true) {
    return failure('ASSET_REDUNDANT', '/canonical_purpose_satisfied', 'An active owner already satisfies this canonical purpose.');
  }
  if (input.frontmatter.artifact_kind === 'prd') {
    if (!['explicit_user', 'agent_inferred'].includes(input.creation_origin)) {
      return failure('ASSET_REQUEST_INVALID', '/creation_origin', 'PRD creation origin must be explicit.');
    }
    if (input.creation_origin === 'agent_inferred' && !isSafeReference(input.creation_approval_ref)) {
      return failure('PRD_APPROVAL_REQUIRED', '/creation_approval_ref', 'Agent-inferred PRD creation requires explicit confirmation.');
    }
  }
  if (input.frontmatter.artifact_kind === 'architecture' && !isSafeReference(input.changed_contract_ref)) {
    return failure('ARCHITECTURE_DECLARATION_REQUIRED', '/changed_contract_ref', 'Architecture requires an exact changed-contract declaration.');
  }
  for (const language of ['en', 'zh-CN']) {
    const body = input.body[language];
    if (body.trim().length === 0 || Buffer.byteLength(body) > MAX_BODY_BYTES) {
      return failure('ASSET_BODY_INVALID', `/body/${language}`, 'Localized delivery body must be non-empty and bounded.');
    }
    if (Buffer.byteLength(renderDocument(input.frontmatter, body)) > MAX_DOCUMENT_BYTES) {
      return failure('ASSET_BODY_INVALID', `/body/${language}`, 'Complete localized delivery document must remain bounded.');
    }
  }
  if (!isDeepStrictEqual(headingLevels(input.body.en), headingLevels(input.body['zh-CN']))) {
    return failure('PAIR_SECTION_MISMATCH', '/body', 'Localized delivery bodies require matching heading structure.');
  }
  if (input.frontmatter.artifact_kind === 'feedback') {
    for (const language of ['en', 'zh-CN']) {
      if (!extractFeedbackSections(input.body[language])) {
        return failure('FEEDBACK_STRUCTURE_INVALID', `/body/${language}`, 'Feedback requires exact source, marking, and coverage sections.');
      }
    }
    const alignment = validateAlignmentFeedbackPair({
      frontmatter: input.frontmatter,
      bodies: input.body,
    });
    if (!alignment.ok) return alignment;
  }
  if (input.frontmatter.artifact_kind === 'closure-summary') {
    const managedHashes = ['en', 'zh-CN'].map((language) => extractClosureSummaryHash(input.body[language]));
    if (input.closure_summary === undefined && managedHashes.some((digest) => digest !== null)) {
      return failure('CLOSURE_SUMMARY_INVALID', '/closure_summary', 'Managed closure proof cannot be supplied as body text.');
    }
    const summary = input.closure_summary;
    const feedbackIds = summary?.feedback_coverage?.map(({ feedback_id: feedbackId }) => feedbackId).sort();
    if (summary !== undefined
      && (!validateClosureSummary(summary).ok
        || summary.artifact_id !== input.frontmatter.artifact_id
        || !isDeepStrictEqual(feedbackIds, [...input.frontmatter.relationships.feedback_ids].sort())
        || (summary.owner_artifact_id.startsWith('prd-')
          && !input.frontmatter.relationships.prd_ids.includes(summary.owner_artifact_id)))) {
      return failure('CLOSURE_SUMMARY_INVALID', '/closure_summary', 'Persisted closure proof must match the closure-summary asset identity.');
    }
  } else if (input.closure_summary !== undefined) {
    return failure('CLOSURE_SUMMARY_INVALID', '/closure_summary', 'Persisted closure proof requires a closure-summary asset.');
  }
  if (!compatibleRoute(input.frontmatter)) {
    return failure('ROUTE_ASSET_MISMATCH', '/frontmatter/primary_route', 'The supplied route cannot own this durable asset kind.');
  }
  return ok(input);
};

const existingFile = async (path) => {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw Object.assign(new Error('Unsafe existing delivery target.'), { code: 'ASSET_PATH_INVALID' });
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const discoverAlignmentResolutionInventory = async (lifecycleRoot, feedbackId) => {
  const roots = [await requireRegularDirectory(join(lifecycleRoot, 'delivery'), lifecycleRoot)];
  try {
    roots.push(await requireRegularDirectory(join(lifecycleRoot, 'archive', 'delivery'), lifecycleRoot));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const entries = [];
  for (const root of roots) {
    for (const name of await readdir(root)) {
      if (name.endsWith('.md')
        && !['alignment-review-en.md', 'alignment-review.md'].includes(name)) {
        entries.push({ root, name });
      }
    }
  }
  if (entries.length > 2000) throw new Error('Delivery owner inventory is unbounded.');
  const pairs = new Map();
  for (const { root, name } of entries) {
    const source = await existingFile(join(root, name));
    if (source === null || Buffer.byteLength(source) > MAX_BODY_BYTES * 2) {
      throw new Error('Delivery owner inventory contains an invalid file.');
    }
    const document = splitDocument(source);
    if (!document || !validateJson('delivery-frontmatter', document.frontmatter).ok) {
      throw new Error('Delivery owner inventory contains invalid Frontmatter.');
    }
    const linkedOwner = ['prd', 'non-prd-delivery'].includes(document.frontmatter.artifact_kind)
      && document.frontmatter.relationships.feedback_ids.includes(feedbackId);
    const closureSummary = document.frontmatter.artifact_kind === 'closure-summary'
      && document.frontmatter.relationships.feedback_ids.includes(feedbackId);
    if (!linkedOwner && !closureSummary) continue;
    const id = document.frontmatter.artifact_id;
    const language = name === `${id}-en.md`
      ? 'en'
      : name === `${id}.md`
        ? 'zh-CN'
        : null;
    if (language === null) throw new Error('Linked delivery owner uses a non-canonical locator.');
    const pair = pairs.get(id) ?? {};
    if (pair[language]) throw new Error('Linked delivery owner language is duplicated.');
    pair[language] = {
      frontmatter: document.frontmatter,
      closureHash: closureSummary ? extractClosureSummaryHash(document.body) : null,
    };
    pairs.set(id, pair);
  }
  const owners = [];
  const closureIds = new Set();
  for (const pair of pairs.values()) {
    if (!pair.en || !pair['zh-CN'] || !isDeepStrictEqual(pair.en, pair['zh-CN'])) {
      throw new Error('Linked delivery evidence pair is incomplete or divergent.');
    }
    const frontmatter = pair.en.frontmatter;
    if (['prd', 'non-prd-delivery'].includes(frontmatter.artifact_kind)
      && frontmatter.relationships.feedback_ids.includes(feedbackId)) {
      owners.push(frontmatter);
    } else if (frontmatter.artifact_kind === 'closure-summary' && pair.en.closureHash !== null) {
      closureIds.add(`${frontmatter.artifact_id}:${pair.en.closureHash}`);
    }
  }
  return { owners, closureIds };
};

const rollbackFirstWrite = async ({ write, lifecycleRoot, locator, original }) => {
  const path = join(lifecycleRoot, locator);
  if (original === null) {
    await unlink(path);
    try {
      await lstat(path);
      throw new Error('New delivery file still exists after rollback.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return;
  }
  await write({
    root: lifecycleRoot,
    target: locator,
    content: original,
    validate: async (source) => {
      const parsed = splitDocument(source);
      return parsed ? ok(source) : failure('DELIVERY_DOCUMENT_INVALID', '/', 'Original delivery document could not be restored.');
    },
  });
  if (await readFile(path, 'utf8') !== original) throw new Error('Original delivery file was not restored.');
};

export async function materializeAsset(input = {}, operations = {}) {
  const request = validateMaterializationRequest(input);
  if (!request.ok) return request;
  if (typeof input.root !== 'string' || !isAbsolute(input.root)) {
    return failure('ASSET_ROOT_INVALID', '/root', 'Delivery materialization requires an absolute project root.');
  }

  let lifecycleRoot;
  try {
    lifecycleRoot = await resolveLifecycleRoot(input.root);
  } catch {
    return failure('ASSET_PATH_INVALID', '/root', 'Delivery targets must be regular files beneath the fixed lifecycle root.');
  }
  const id = input.frontmatter.artifact_id;
  const locators = { en: `delivery/${id}-en.md`, 'zh-CN': `delivery/${id}.md` };
  const paths = Object.fromEntries(Object.entries(locators).map(([language, locator]) => [language, join(lifecycleRoot, locator)]));
  let existing;
  try {
    existing = {
      en: await existingFile(paths.en),
      'zh-CN': await existingFile(paths['zh-CN']),
    };
  } catch {
    return failure('ASSET_PATH_INVALID', '/root', 'Delivery targets must be regular files beneath the fixed lifecycle root.');
  }
  if ((existing.en === null) !== (existing['zh-CN'] === null)) {
    return failure('PAIR_INCOMPLETE', '/delivery', 'Delivery asset pairs must be created and updated together.');
  }
  const updating = existing.en !== null;
  if (updating && input.frontmatter.artifact_kind !== 'feedback') {
    return failure('ASSET_REDUNDANT', '/frontmatter/artifact_id', 'An existing delivery owner cannot be recreated by materialization.');
  }

  const bodies = { ...input.body };
  if (input.frontmatter.artifact_kind === 'closure-summary' && input.closure_summary !== undefined) {
    const digest = closureSummaryHash(input.closure_summary);
    for (const language of ['en', 'zh-CN']) bodies[language] = addClosureSummaryHash(bodies[language], digest);
  }
  if (input.frontmatter.artifact_kind === 'feedback') {
    const nextAlignment = validateAlignmentFeedbackPair({
      frontmatter: input.frontmatter,
      bodies,
    });
    if (!nextAlignment.ok) return nextAlignment;
    let priorAlignment = null;
    if (updating) {
      const priorDocuments = {
        en: splitDocument(existing.en),
        'zh-CN': splitDocument(existing['zh-CN']),
      };
      if (!priorDocuments.en || !priorDocuments['zh-CN']) {
        return failure('HISTORY_BODY_CHANGED', '/body', 'Existing Feedback pair is malformed.');
      }
      priorAlignment = validateAlignmentFeedbackPair({
        frontmatter: priorDocuments.en.frontmatter,
        bodies: {
          en: priorDocuments.en.body,
          'zh-CN': priorDocuments['zh-CN'].body,
        },
      });
      if (!priorAlignment.ok) return priorAlignment;
    }
    const removingAlignment = priorAlignment?.value.marker !== null
      && priorAlignment?.value.marker !== undefined
      && nextAlignment.value.marker === null;
    if (Object.hasOwn(input, 'alignment_resolution') && !removingAlignment) {
      return failure('ALIGNMENT_RESOLUTION_UNEXPECTED', '/alignment_resolution', 'Resolution is allowed only while removing an active marker.');
    }
    if (removingAlignment) {
      const suppliedOwners = input.alignment_owners ?? [];
      if (!Array.isArray(suppliedOwners) || suppliedOwners.some((owner) => {
        const validation = validateJson('delivery-frontmatter', owner);
        return !validation.ok || !['prd', 'non-prd-delivery'].includes(owner.artifact_kind);
      })) {
        return failure('ALIGNMENT_RESOLUTION_INVALID', '/alignment_owners', 'Marker exit requires validated delivery owners.');
      }
      let inventory;
      try {
        inventory = await discoverAlignmentResolutionInventory(lifecycleRoot, input.frontmatter.artifact_id);
      } catch {
        return failure('ALIGNMENT_OWNER_INVENTORY_INCOMPLETE', '/alignment_owners', 'Marker exit requires a complete valid owner inventory from authoritative delivery assets.');
      }
      const linkedOwnerIds = new Set(inventory.owners.map(({ artifact_id: ownerId }) => ownerId));
      const suppliedClosures = input.alignment_closures ?? [];
      if (!Array.isArray(suppliedClosures)
        || suppliedClosures.some((closure) => !validateClosureSummary(closure).ok)) {
        return failure('ALIGNMENT_RESOLUTION_INVALID', '/alignment_closures', 'Marker exit requires validated closure summaries.');
      }
      const suppliedClosureIds = new Set(Array.isArray(suppliedClosures)
        ? suppliedClosures
          .map(({ artifact_id: closureId }) => closureId)
        : []);
      let suppliedClosureProofs;
      try {
        suppliedClosureProofs = new Set(suppliedClosures
          .map((closure) => `${closure.artifact_id}:${closureSummaryHash(closure)}`));
      } catch {
        return failure('ALIGNMENT_RESOLUTION_INVALID', '/alignment_closures', 'Marker exit requires serializable closure summaries.');
      }
      const authoritativeClosureProofs = new Set([...inventory.closureIds].filter((proof) => {
        const closureId = proof.slice(0, proof.indexOf(':'));
        return closureId.startsWith('closure-')
          && linkedOwnerIds.has(closureId.slice('closure-'.length));
      }));
      if (suppliedClosureIds.size !== suppliedClosureProofs.size
        || suppliedClosureProofs.size !== authoritativeClosureProofs.size
        || [...suppliedClosureProofs].some((proof) => !authoritativeClosureProofs.has(proof))) {
        return failure('ALIGNMENT_CLOSURE_INVENTORY_INCOMPLETE', '/alignment_closures', 'Marker exit requires exact persisted bilingual closure-summary evidence.');
      }
      const exit = validateAlignmentExit({
        feedbackId: input.frontmatter.artifact_id,
        feedbackProjectId: input.frontmatter.current_project_id ?? input.frontmatter.project_id_at_creation,
        resolution: input.alignment_resolution,
        owners: inventory.owners,
        closures: suppliedClosures,
        knowledgeResults: input.alignment_knowledge_results ?? [],
        ownerInventoryComplete: true,
      });
      if (!exit.ok) return exit;
      const requiredEvidence = exit.value.disposition === 'NO_REMEDIATION_ACCEPTED'
        ? [exit.value.disposition,
          exit.value.human_approval_ref,
          ...exit.value.knowledge_resolution_refs]
        : [exit.value.disposition,
          ...exit.value.closure_refs,
          ...exit.value.knowledge_resolution_refs];
      for (const language of ['en', 'zh-CN']) {
        const coverage = extractFeedbackSections(bodies[language])?.coverage;
        if (!coverage || requiredEvidence.some((reference) => !hasExactCoverageReference(coverage, reference))) {
          return failure(
            'ALIGNMENT_RESOLUTION_EVIDENCE_MISSING',
            `/body/${language}/coverage`,
            'Alignment exit must retain its disposition, closure or approval, and knowledge resolution references in Feedback coverage.',
          );
        }
      }
    } else if (!updating && input.frontmatter.primary_route === 'KNOWLEDGE_UPDATE' && nextAlignment.value.marker === null) {
      return failure('ROUTE_ASSET_MISMATCH', '/frontmatter/primary_route', 'Knowledge-controlled Feedback requires an active alignment marker.');
    }
    for (const language of ['en', 'zh-CN']) {
      const sections = extractFeedbackSections(bodies[language]);
      bodies[language] = addFeedbackHashes(bodies[language], sourceHashes(sections));
      if (updating) {
        const prior = splitDocument(existing[language]);
        if (!prior || !isDeepStrictEqual(prior.frontmatter, input.frontmatter)) {
          return failure('HISTORY_BODY_CHANGED', `/body/${language}`, 'Feedback identity and source history cannot be rewritten.');
        }
        const priorSections = extractFeedbackSections(prior.body);
        const nextSections = extractFeedbackSections(bodies[language]);
        const titleMigration = priorAlignment.value.marker === null
          && nextAlignment.value.marker !== null
          && priorAlignment.value.titles[language] === null;
        const priorSkeleton = feedbackSkeleton(prior.body);
        const nextSkeleton = feedbackSkeleton(
          titleMigration ? withoutDocumentTitle(bodies[language]) : bodies[language],
        );
        const skeletonMatches = titleMigration
          ? feedbackFrame(prior.body) === feedbackFrame(bodies[language])
          : priorSkeleton === nextSkeleton;
        if (!priorSections || !nextSections
          || !isDeepStrictEqual(sourceHashes(priorSections), sourceHashes(nextSections))
          || !skeletonMatches) {
          return failure('HISTORY_BODY_CHANGED', `/body/${language}`, 'Feedback source history cannot change without an erratum or successor.');
        }
      }
    }
  }

  const documents = {
    en: renderDocument(input.frontmatter, bodies.en),
    'zh-CN': renderDocument(input.frontmatter, bodies['zh-CN']),
  };
  for (const language of ['en', 'zh-CN']) {
    if (Buffer.byteLength(documents[language]) > MAX_DOCUMENT_BYTES) {
      return failure('ASSET_BODY_INVALID', `/body/${language}`, 'Complete localized delivery document must remain bounded.');
    }
  }
  const write = operations.atomicWriteValidated ?? atomicWriteValidated;
  try {
    await write({
      root: lifecycleRoot,
      target: locators.en,
      content: documents.en,
      validate: (source) => validateRendered(source, input.frontmatter, bodies.en),
    });
    try {
      await write({
        root: lifecycleRoot,
        target: locators['zh-CN'],
        content: documents['zh-CN'],
        validate: (source) => validateRendered(source, input.frontmatter, bodies['zh-CN']),
      });
    } catch (error) {
      try {
        await rollbackFirstWrite({
          write,
          lifecycleRoot,
          locator: locators.en,
          original: existing.en,
        });
      } catch {
        return failure('ASSET_ROLLBACK_FAILED', '/delivery', 'Delivery pair rollback failed; manual recovery is required.');
      }
      throw error;
    }
  } catch {
    return failure('ASSET_WRITE_FAILED', '/delivery', 'Delivery pair could not be written and validated.');
  }

  return ok({
    artifact_id: id,
    locators,
    status: updating ? 'updated' : 'created',
  });
}
