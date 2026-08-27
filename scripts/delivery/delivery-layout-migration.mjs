import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseRestrictedYaml } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { inspectLifecycleTree } from '../knowledge/layout-transaction.mjs';
import { activeDeliveryPair, alignmentReviewPair, archivedDeliveryPair } from './delivery-layout.mjs';

const MAX_FILES = 2000;
const MAX_BYTES = 262_144;
const ID = /^[a-z][a-z0-9-]*$/u;
const LANGUAGES = ['en', 'zh-CN'];
const ROOT_KINDS = new Set(['prd', 'non-prd-delivery']);
const failure = (code, path, message) => fail([createError(code, path, message)]);
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};
const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const canonical = (value) => JSON.stringify(value);

const parseDocument = (source) => {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return null;
  const closing = normalized.indexOf('\n---\n', 4);
  if (closing === -1) return null;
  const parsed = parseRestrictedYaml(normalized.slice(4, closing), '/frontmatter');
  if (!parsed.ok || !validateJson('delivery-frontmatter', parsed.value).ok
    || parsed.value.schema_version !== 1) return null;
  return { frontmatter: parsed.value, source: normalized, body: normalized.slice(closing + 5) };
};

const rootsFor = async (rootValue) => {
  if (typeof rootValue !== 'string' || !isAbsolute(rootValue)) throw new Error('Absolute root required.');
  const projectState = await lstat(resolve(rootValue));
  const projectRoot = await realpath(resolve(rootValue));
  const docsState = await lstat(join(projectRoot, 'docs'));
  const docsRoot = await realpath(join(projectRoot, 'docs'));
  const lifecycleState = await lstat(join(docsRoot, 'project-lifecycle'));
  const lifecycleRoot = await realpath(join(docsRoot, 'project-lifecycle'));
  if (!projectState.isDirectory() || projectState.isSymbolicLink()
    || !docsState.isDirectory() || docsState.isSymbolicLink()
    || !lifecycleState.isDirectory() || lifecycleState.isSymbolicLink()
    || !inside(projectRoot, lifecycleRoot)) throw new Error('Bounded lifecycle root required.');
  return { projectRoot, lifecycleRoot };
};

const readLegacyRoot = async (lifecycleRoot, rootLocator, issues) => {
  const path = join(lifecycleRoot, rootLocator);
  try {
    const state = await lstat(path);
    const physical = await realpath(path);
    if (!state.isDirectory() || state.isSymbolicLink() || !inside(lifecycleRoot, physical)) throw new Error();
    const files = [];
    for (const entry of await readdir(physical, { withFileTypes: true })) {
      const locator = `${rootLocator}/${entry.name}`;
      if (entry.isDirectory() || entry.isSymbolicLink() || !entry.isFile()) {
        issues.push({ code: 'MIXED_LAYOUT', artifact_id: null, locator });
        continue;
      }
      files.push({ path: join(physical, entry.name), locator, name: entry.name, archived: rootLocator.startsWith('archive/') });
    }
    return files;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const linksFrom = (body, source) => [...body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu)]
  .map((match) => match[1])
  .filter((href) => /^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('//'))
  .map((href) => ({ source, href }));

export const inspectLegacyDeliveryLayout = async ({ root, owner_mappings: mappings = [] } = {}) => {
  if (!Array.isArray(mappings) || mappings.length > 200) {
    return failure('DELIVERY_MIGRATION_INPUT_INVALID', '/owner_mappings', 'Owner mappings must be one bounded array.');
  }
  let projectRoot;
  let lifecycleRoot;
  let tree;
  try {
    ({ projectRoot, lifecycleRoot } = await rootsFor(root));
    tree = await inspectLifecycleTree({ repositoryRoot: projectRoot });
    if (!tree.ok) throw new Error();
  } catch {
    return failure('DELIVERY_MIGRATION_ROOT_INVALID', '/root', 'Migration preview requires one bounded regular project root.');
  }
  const needsUser = [];
  let files;
  try {
    files = [
      ...await readLegacyRoot(lifecycleRoot, 'delivery', needsUser),
      ...await readLegacyRoot(lifecycleRoot, 'archive/delivery', needsUser),
    ];
  } catch {
    return failure('DELIVERY_MIGRATION_INVENTORY_INVALID', '/delivery', 'Legacy delivery inventory is unsafe.');
  }
  if (files.length > MAX_FILES) needsUser.push({ code: 'INVENTORY_LIMIT', artifact_id: null, locator: 'delivery' });

  const grouped = new Map();
  const views = {};
  for (const file of files.slice(0, MAX_FILES + 1).sort((a, b) => compareCodePoints(a.locator, b.locator))) {
    const state = await lstat(file.path);
    if (state.size > MAX_BYTES) {
      needsUser.push({ code: 'DOCUMENT_TOO_LARGE', artifact_id: null, locator: file.locator });
      continue;
    }
    if (['alignment-review-en.md', 'alignment-review.md'].includes(file.name)) {
      views[file.name.endsWith('-en.md') ? 'en' : 'zh-CN'] = file;
      continue;
    }
    if (!file.name.endsWith('.md')) {
      needsUser.push({ code: 'MIXED_LAYOUT', artifact_id: null, locator: file.locator });
      continue;
    }
    const bytes = await readFile(file.path);
    const document = parseDocument(bytes.toString('utf8'));
    if (!document) {
      needsUser.push({ code: 'FRONTMATTER_INVALID', artifact_id: null, locator: file.locator });
      continue;
    }
    const id = document.frontmatter.artifact_id;
    const language = file.name === `${id}-en.md` ? 'en' : file.name === `${id}.md` ? 'zh-CN' : null;
    if (language === null) {
      needsUser.push({ code: 'LOCATOR_INVALID', artifact_id: id, locator: file.locator });
      continue;
    }
    const key = `${file.archived ? 'archive' : 'active'}:${id}`;
    const pair = grouped.get(key) ?? {};
    if (pair[language]) needsUser.push({ code: 'DUPLICATE_ID', artifact_id: id, locator: file.locator });
    pair[language] = { ...file, ...document, body_hash: hash(bytes) };
    grouped.set(key, pair);
  }

  const supplied = new Map();
  for (const mapping of mappings) {
    if (!mapping || Object.keys(mapping).sort().join(',') !== 'artifact_id,owner_artifact_id'
      || !ID.test(mapping.artifact_id ?? '') || !ID.test(mapping.owner_artifact_id ?? '')
      || (supplied.has(mapping.artifact_id) && supplied.get(mapping.artifact_id) !== mapping.owner_artifact_id)) {
      needsUser.push({ code: 'OWNER_MAPPING_CONTRADICTORY', artifact_id: mapping?.artifact_id ?? null, locator: null });
    } else supplied.set(mapping.artifact_id, mapping.owner_artifact_id);
  }

  const complete = [];
  const ownerKinds = new Map();
  const completeIds = new Set();
  for (const [key, pair] of grouped) {
    const id = key.slice(key.indexOf(':') + 1);
    if (!pair.en || !pair['zh-CN'] || !isDeepStrictEqual(pair.en.frontmatter, pair['zh-CN'].frontmatter)) {
      needsUser.push({ code: 'PAIR_INCOMPLETE', artifact_id: id, locator: pair.en?.locator ?? pair['zh-CN']?.locator ?? null });
      continue;
    }
    if (completeIds.has(id)) {
      needsUser.push({ code: 'DUPLICATE_ID', artifact_id: id, locator: pair.en.locator });
      continue;
    }
    completeIds.add(id);
    complete.push({ key, pair, archived: key.startsWith('archive:') });
    if (ROOT_KINDS.has(pair.en.frontmatter.artifact_kind)) ownerKinds.set(id, pair.en.frontmatter.artifact_kind);
  }

  const moves = [];
  const unresolvedExternalLinks = [];
  for (const { pair, archived } of complete) {
    const frontmatter = pair.en.frontmatter;
    const id = frontmatter.artifact_id;
    let ownerId = null;
    if (ROOT_KINDS.has(frontmatter.artifact_kind)) ownerId = id;
    else if (frontmatter.artifact_kind !== 'feedback') {
      const candidates = frontmatter.relationships.prd_ids.filter((candidate) => ownerKinds.has(candidate));
      if (candidates.length === 1) ownerId = candidates[0];
      const mapped = supplied.get(id);
      if (mapped !== undefined) {
        if (!ownerKinds.has(mapped) || (ownerId !== null && ownerId !== mapped)) {
          needsUser.push({ code: 'OWNER_MAPPING_CONTRADICTORY', artifact_id: id, locator: pair.en.locator });
          continue;
        }
        ownerId = mapped;
      }
      if (ownerId === null) {
        needsUser.push({ code: candidates.length > 1 ? 'OWNER_AMBIGUOUS' : 'OWNER_MISSING', artifact_id: id, locator: pair.en.locator });
        continue;
      }
    }
    const next = {
      ...frontmatter,
      schema_version: 2,
      ...(ownerId === null ? {} : { owner_artifact_id: ownerId }),
    };
    const ownerKind = ownerId === null ? null : ownerKinds.get(ownerId);
    const to = archived
      ? archivedDeliveryPair(next, { ownerKind })
      : activeDeliveryPair(next, { ownerKind });
    moves.push({
      artifact_id: id,
      artifact_kind: frontmatter.artifact_kind,
      owner_artifact_id: ownerId,
      from: { en: pair.en.locator, 'zh-CN': pair['zh-CN'].locator },
      to,
      body_hashes: { en: pair.en.body_hash, 'zh-CN': pair['zh-CN'].body_hash },
    });
    unresolvedExternalLinks.push(...linksFrom(pair.en.body, pair.en.locator), ...linksFrom(pair['zh-CN'].body, pair['zh-CN'].locator));
  }
  if (views.en || views['zh-CN']) {
    if (!views.en || !views['zh-CN']) needsUser.push({ code: 'PAIR_INCOMPLETE', artifact_id: 'alignment-review', locator: views.en?.locator ?? views['zh-CN']?.locator });
    else moves.push({
      artifact_id: 'alignment-review', artifact_kind: 'generated-view', owner_artifact_id: null,
      from: { en: views.en.locator, 'zh-CN': views['zh-CN'].locator }, to: alignmentReviewPair(),
      body_hashes: { en: hash(await readFile(views.en.path)), 'zh-CN': hash(await readFile(views['zh-CN'].path)) },
    });
  }
  moves.sort((a, b) => compareCodePoints(a.artifact_id, b.artifact_id));
  const targetBySource = new Map(moves.flatMap(({ from, to }) => LANGUAGES.map((language) => [from[language], to[language]])));
  const managedReferenceRewrites = [];
  for (const { pair } of complete) {
    for (const language of LANGUAGES) {
      for (const match of pair[language].body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu)) {
        const href = match[1];
        if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('//') || href.startsWith('#')) continue;
        const [path, fragment] = href.split('#');
        const resolved = posix.normalize(posix.join(posix.dirname(pair[language].locator), path));
        if (resolved.startsWith('../') || posix.isAbsolute(resolved)) {
          needsUser.push({ code: 'LINK_UNSAFE', artifact_id: pair[language].frontmatter.artifact_id, locator: pair[language].locator });
          continue;
        }
        const target = targetBySource.get(resolved);
        if (!target) continue;
        const rewritten = posix.relative(posix.dirname(targetBySource.get(pair[language].locator)), target);
        managedReferenceRewrites.push({
          source: pair[language].locator,
          href,
          rewritten_href: `${rewritten || '.'}${fragment ? `#${fragment}` : ''}`,
        });
      }
    }
  }
  managedReferenceRewrites.sort((a, b) => compareCodePoints(`${a.source}:${a.href}`, `${b.source}:${b.href}`));
  needsUser.sort((a, b) => compareCodePoints(`${a.code}:${a.artifact_id ?? ''}:${a.locator ?? ''}`, `${b.code}:${b.artifact_id ?? ''}:${b.locator ?? ''}`));
  unresolvedExternalLinks.sort((a, b) => compareCodePoints(`${a.source}:${a.href}`, `${b.source}:${b.href}`));
  const candidateDirectories = [...new Set(moves.flatMap(({ to }) => LANGUAGES.map((language) => dirname(to[language]))))]
    .sort(compareCodePoints);
  const result = {
    route: needsUser.length > 0 ? 'NEEDS_USER' : 'NON_PRD_DELIVERY',
    selected_solution_id: 'solution-owner-centric-delivery-layout-v2',
    source_fingerprint: hash(canonical(tree.value.entries)),
    moves,
    managed_reference_rewrites: managedReferenceRewrites,
    unresolved_external_links: unresolvedExternalLinks,
    needs_user: needsUser,
    candidate_directories: candidateDirectories,
  };
  result.plan_hash = hash(canonical(result));
  return ok(freeze(result));
};
