import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { stringify as stringifyYaml } from 'yaml';

import { atomicWriteValidated } from '../lib/atomic-write.mjs';
import { createError } from '../lib/errors.mjs';
import { parseRestrictedYaml } from '../lib/markdown.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const MAX_BODY_BYTES = 131_072;
const FEEDBACK_SOURCE_SECTIONS = ['original_problem', 'scenario', 'expectation'];
const FEEDBACK_MUTABLE_SECTIONS = ['marking', 'coverage'];
const failure = (code, path, message) => fail([createError(code, path, message)]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
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
  const sections = {};
  for (const id of [...FEEDBACK_SOURCE_SECTIONS, ...FEEDBACK_MUTABLE_SECTIONS]) {
    const matches = [...body.matchAll(new RegExp(sectionPattern(id).source, 'gu'))];
    if (matches.length !== 1 || matches[0][1].trim().length === 0) return null;
    sections[id] = matches[0][1].replaceAll('\r\n', '\n').trim();
  }
  return sections;
};

const sourceHashes = (sections) => Object.fromEntries(
  FEEDBACK_SOURCE_SECTIONS.map((id) => [id, hash(sections[id])]),
);

const feedbackHashMarker = (hashes) => `<!-- project-lifecycle:feedback-source-hashes ${FEEDBACK_SOURCE_SECTIONS
  .map((id) => `${id}=${hashes[id]}`).join(' ')} -->`;

const addFeedbackHashes = (body, hashes) => {
  const withoutMarker = body.replace(/^<!-- project-lifecycle:feedback-source-hashes [^\n]+ -->\n?/mu, '');
  const firstBreak = withoutMarker.indexOf('\n');
  if (firstBreak === -1) return `${withoutMarker}\n\n${feedbackHashMarker(hashes)}\n`;
  return `${withoutMarker.slice(0, firstBreak + 1)}\n${feedbackHashMarker(hashes)}\n${withoutMarker.slice(firstBreak + 1).replace(/^\n/u, '')}`;
};

const feedbackSkeleton = (body) => {
  let output = body.replace(/^<!-- project-lifecycle:feedback-source-hashes [^\n]+ -->\n?/gmu, '');
  for (const id of FEEDBACK_MUTABLE_SECTIONS) {
    output = output.replace(sectionPattern(id), `<!-- project-lifecycle:section ${id} -->\n[MUTABLE]\n<!-- /project-lifecycle:section -->`);
  }
  return output.replaceAll('\r\n', '\n').replace(/^\n/u, '');
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
  if (['KNOWLEDGE_UPDATE', 'OUTSIDE_PLUGIN'].includes(route)) return false;
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
  if (!compatibleRoute(input.frontmatter)) {
    return failure('ROUTE_ASSET_MISMATCH', '/frontmatter/primary_route', 'The supplied route cannot own this durable asset kind.');
  }
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
  if (input.frontmatter.artifact_kind === 'feedback') {
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
        if (!priorSections || !nextSections
          || !isDeepStrictEqual(sourceHashes(priorSections), sourceHashes(nextSections))
          || feedbackSkeleton(prior.body) !== feedbackSkeleton(bodies[language])) {
          return failure('HISTORY_BODY_CHANGED', `/body/${language}`, 'Feedback source history cannot change without an erratum or successor.');
        }
      }
    }
  }

  const documents = {
    en: renderDocument(input.frontmatter, bodies.en),
    'zh-CN': renderDocument(input.frontmatter, bodies['zh-CN']),
  };
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
