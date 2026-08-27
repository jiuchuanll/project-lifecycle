import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseRestrictedYaml } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';

export const DELIVERY_LAYOUT = Object.freeze({ schema_version: 1, layout_version: 2 });

const ID = /^[a-z][a-z0-9-]*$/u;
const ROOT_KINDS = new Set(['prd', 'non-prd-delivery']);
const CHILD_DIRECTORIES = Object.freeze({
  architecture: 'architecture',
  guidance: 'guidance',
  batch: 'batches',
  'test-report': 'test-reports',
  'closure-summary': 'closure',
});
const V2_DIRECTORIES = new Set(['feedback', 'non-prd', 'prds', 'views']);
const V2_ROOT_FILES = new Set(['INDEX-en.md', 'INDEX.md', 'layout.json']);
const failure = (code, path, message) => fail([createError(code, path, message)]);

const inside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};

const languagePair = (directory, artifactId) => ({
  en: `${directory}/${artifactId}-en.md`,
  'zh-CN': `${directory}/${artifactId}.md`,
});

const ownerRoot = (ownerKind, ownerId) => {
  if (ownerKind === 'prd') return `delivery/prds/${ownerId}`;
  if (ownerKind === 'non-prd-delivery') return `delivery/non-prd/${ownerId}`;
  throw Object.assign(new Error('Invalid physical owner kind.'), { code: 'DELIVERY_OWNER_MISMATCH' });
};

const activeDirectory = (frontmatter, ownerKind) => {
  if (frontmatter.artifact_kind === 'feedback') return 'delivery/feedback';
  const root = ownerRoot(ownerKind, frontmatter.owner_artifact_id);
  const child = CHILD_DIRECTORIES[frontmatter.artifact_kind];
  return child ? `${root}/${child}` : root;
};

const regularDirectory = async (path, parentReal = null) => {
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Regular directory required.');
  const physical = await realpath(path);
  if (parentReal !== null && !inside(parentReal, physical)) throw new Error('Directory escapes parent.');
  return physical;
};

const existingDirectory = async (path, parentReal) => {
  try {
    return await regularDirectory(path, parentReal);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const ownerFrontmatter = async (path, ownerRootReal) => {
  const state = await lstat(path);
  const physical = await realpath(path);
  if (!state.isFile() || state.isSymbolicLink() || !inside(ownerRootReal, physical)) throw new Error('Unsafe owner document.');
  const source = (await readFile(physical, 'utf8')).replaceAll('\r\n', '\n');
  const closing = source.indexOf('\n---\n', 4);
  if (!source.startsWith('---\n') || closing === -1) throw new Error('Owner Frontmatter is missing.');
  const parsed = parseRestrictedYaml(source.slice(4, closing), '/frontmatter');
  if (!parsed.ok || !validateJson('delivery-frontmatter', parsed.value).ok
    || parsed.value.schema_version !== 2) throw new Error('Owner Frontmatter is invalid.');
  return parsed.value;
};

const resolveDeliveryRoot = async (root, { allowMissing = false } = {}) => {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Absolute project root required.');
  const projectRoot = await regularDirectory(resolve(root));
  const docsRoot = await regularDirectory(join(projectRoot, 'docs'), projectRoot);
  const lifecycleRoot = await regularDirectory(join(docsRoot, 'project-lifecycle'), docsRoot);
  const deliveryRoot = await existingDirectory(join(lifecycleRoot, 'delivery'), lifecycleRoot);
  if (deliveryRoot === null && !allowMissing) throw new Error('Delivery root required.');
  return { lifecycleRoot, deliveryRoot };
};

export const deliveryLayoutContent = () => `${JSON.stringify(DELIVERY_LAYOUT, null, 2)}\n`;

export const validatePhysicalOwner = (frontmatter) => {
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)
    || !ID.test(frontmatter.artifact_id ?? '') || typeof frontmatter.artifact_kind !== 'string') {
    return failure('DELIVERY_OWNER_INVALID', '/', 'A bounded delivery artifact identity is required.');
  }
  if (frontmatter.artifact_kind === 'feedback') {
    return Object.hasOwn(frontmatter, 'owner_artifact_id')
      ? failure('DELIVERY_OWNER_FORBIDDEN', '/owner_artifact_id', 'Feedback has no physical delivery owner.')
      : ok(frontmatter);
  }
  if (!ID.test(frontmatter.owner_artifact_id ?? '')) {
    return failure('DELIVERY_OWNER_REQUIRED', '/owner_artifact_id', 'A physical delivery owner is required.');
  }
  if (ROOT_KINDS.has(frontmatter.artifact_kind)
    && frontmatter.owner_artifact_id !== frontmatter.artifact_id) {
    return failure('DELIVERY_OWNER_MISMATCH', '/owner_artifact_id', 'A root delivery owner must own itself.');
  }
  return ok(frontmatter);
};

export const activeDeliveryPair = (frontmatter, { ownerKind = null } = {}) => languagePair(
  activeDirectory(frontmatter, ownerKind),
  frontmatter.artifact_id,
);

export const archivedDeliveryPair = (frontmatter, { ownerKind = null } = {}) => {
  const active = activeDirectory(frontmatter, ownerKind);
  return languagePair(active.replace(/^delivery\//u, 'archive/delivery/'), frontmatter.artifact_id);
};

export const alignmentReviewPair = () => languagePair('delivery/views', 'alignment-review');

export const resolvePhysicalOwner = async ({ lifecycleRoot, frontmatter } = {}) => {
  const ownership = validatePhysicalOwner(frontmatter);
  if (!ownership.ok) return ownership;
  if (frontmatter.artifact_kind === 'feedback') return ok({ artifact_kind: null, artifact_id: null });
  if (ROOT_KINDS.has(frontmatter.artifact_kind)) {
    return ok({ artifact_kind: frontmatter.artifact_kind, artifact_id: frontmatter.artifact_id });
  }
  try {
    const root = await regularDirectory(lifecycleRoot);
    const delivery = await regularDirectory(join(root, 'delivery'), root);
    const candidates = [];
    for (const [kind, directory] of [['prd', 'prds'], ['non-prd-delivery', 'non-prd']]) {
      const owner = await existingDirectory(
        join(delivery, directory, frontmatter.owner_artifact_id),
        delivery,
      );
      if (owner !== null) {
        const base = join(owner, frontmatter.owner_artifact_id);
        const [en, zh] = await Promise.all([
          ownerFrontmatter(`${base}-en.md`, owner),
          ownerFrontmatter(`${base}.md`, owner),
        ]);
        if (!isDeepStrictEqual(en, zh) || en.artifact_id !== frontmatter.owner_artifact_id
          || en.artifact_kind !== kind || en.owner_artifact_id !== en.artifact_id
          || en.retention_tier !== 'active') throw new Error('Physical owner pair is invalid.');
        candidates.push({ artifact_kind: kind, artifact_id: frontmatter.owner_artifact_id });
      }
    }
    return candidates.length === 1
      ? ok(candidates[0])
      : failure('DELIVERY_OWNER_MISMATCH', '/owner_artifact_id', 'Exactly one physical delivery owner must exist.');
  } catch {
    return failure('DELIVERY_OWNER_MISMATCH', '/owner_artifact_id', 'The physical delivery owner could not be resolved safely.');
  }
};

export const detectDeliveryLayout = async ({ root } = {}) => {
  let deliveryRoot;
  try {
    ({ deliveryRoot } = await resolveDeliveryRoot(root, { allowMissing: true }));
  } catch {
    return failure('DELIVERY_LAYOUT_PATH_INVALID', '/root', 'Delivery layout inspection requires a bounded regular project root.');
  }
  if (deliveryRoot === null) return ok({ kind: 'EMPTY', marker: null, evidence_locators: [] });

  try {
    const entries = await readdir(deliveryRoot, { withFileTypes: true });
    const evidenceLocators = entries.map(({ name }) => `delivery/${name}`).sort(compareCodePoints);
    if (entries.some((entry) => entry.isSymbolicLink())) {
      return failure('DELIVERY_LAYOUT_PATH_INVALID', '/delivery', 'Managed delivery entries cannot be symbolic links.');
    }
    const markerEntry = entries.find(({ name }) => name === 'layout.json');
    let marker = null;
    if (markerEntry) {
      if (!markerEntry.isFile()) {
        return failure('DELIVERY_LAYOUT_MARKER_INVALID', '/delivery/layout.json', 'Delivery layout marker must be a regular file.');
      }
      try {
        marker = JSON.parse(await readFile(join(deliveryRoot, 'layout.json'), 'utf8'));
      } catch {
        return failure('DELIVERY_LAYOUT_MARKER_INVALID', '/delivery/layout.json', 'Delivery layout marker must be valid JSON.');
      }
      if (!validateJson('delivery-layout', marker).ok) {
        return failure('DELIVERY_LAYOUT_MARKER_INVALID', '/delivery/layout.json', 'Delivery layout marker is invalid.');
      }
    }

    const flatMarkdown = entries.filter(({ name }) => name.endsWith('.md') && !['INDEX-en.md', 'INDEX.md'].includes(name));
    const hierarchy = entries.filter((entry) => entry.isDirectory() && V2_DIRECTORIES.has(entry.name));
    const unknown = entries.filter((entry) => (
      entry.isDirectory() ? !V2_DIRECTORIES.has(entry.name) : !V2_ROOT_FILES.has(entry.name)
    ));
    if (marker !== null) {
      return ok({
        kind: flatMarkdown.length > 0 || unknown.length > 0 ? 'INVALID_MIXED' : 'V2',
        marker,
        evidence_locators: evidenceLocators,
      });
    }
    if (hierarchy.length > 0 || unknown.some((entry) => !entry.name.endsWith('.md'))) {
      return ok({ kind: 'INVALID_MIXED', marker: null, evidence_locators: evidenceLocators });
    }
    return ok({
      kind: flatMarkdown.length > 0 ? 'LEGACY_FLAT' : 'EMPTY',
      marker: null,
      evidence_locators: evidenceLocators,
    });
  } catch {
    return failure('DELIVERY_LAYOUT_PATH_INVALID', '/delivery', 'Delivery layout could not be inspected safely.');
  }
};
