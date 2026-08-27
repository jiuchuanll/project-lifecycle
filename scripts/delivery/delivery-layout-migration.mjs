import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';

import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseRestrictedYaml } from '../lib/markdown.mjs';
import { rewriteMarkdownOutsideCode } from '../lib/markdown-links.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import {
  applyLayoutTransaction,
  finalizeRetainedLayout,
  inspectLifecycleTree,
  rollbackRetainedLayout,
} from '../knowledge/layout-transaction.mjs';
import { collectDeliveryInventory } from './delivery-inventory.mjs';
import { generateDeliveryIndexes } from './delivery-indexes.mjs';
import {
  activeDeliveryPair,
  alignmentReviewPair,
  archivedDeliveryPair,
  deliveryLayoutContent,
} from './delivery-layout.mjs';

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
const renderDocument = (frontmatter, body) => `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;

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

const replaceManagedLinks = (source, rewrites) => rewriteMarkdownOutsideCode(source, (text) => {
  const byHref = new Map(rewrites.map(({ href, rewritten_href: target }) => [href, target]));
  return text.replace(
    /(\[[^\]]*\]\()([^)\s]+)((?:\s+[^)]*)?\))/gu,
    (whole, prefix, href, suffix) => byHref.has(href)
      ? `${prefix}${byHref.get(href)}${suffix}`
      : whole,
  );
});

const inventoryForCandidate = (items) => {
  const active = items.filter(({ archived }) => !archived);
  const archived = items.filter(({ archived: value }) => value);
  const owners = active.filter(({ artifact_kind: kind }) => ROOT_KINDS.has(kind))
    .sort((left, right) => compareCodePoints(left.artifact_id, right.artifact_id));
  const byOwner = {};
  const archivedByOwner = {};
  for (const owner of owners) byOwner[owner.artifact_id] = { owner, assets: [] };
  for (const item of active) {
    if (item.owner_artifact_id && byOwner[item.owner_artifact_id]) byOwner[item.owner_artifact_id].assets.push(item);
  }
  for (const item of archived) {
    if (!item.owner_artifact_id) continue;
    archivedByOwner[item.owner_artifact_id] ??= { owner_artifact_id: item.owner_artifact_id, assets: [] };
    archivedByOwner[item.owner_artifact_id].assets.push(item);
  }
  for (const value of [...Object.values(byOwner), ...Object.values(archivedByOwner)]) {
    value.assets.sort((left, right) => compareCodePoints(left.artifact_id, right.artifact_id));
  }
  return {
    layout_version: 2,
    feedbacks: active.filter(({ artifact_kind: kind }) => kind === 'feedback'),
    owners,
    closed_summaries: [...active, ...archived].filter(({ artifact_kind: kind }) => kind === 'closure-summary'),
    views: [],
    by_owner: byOwner,
    archived_by_owner: archivedByOwner,
    pairs: [],
    archived_pairs: [],
  };
};

export const buildDeliveryMigrationCandidate = async ({ root, preview } = {}) => {
  if (!preview || preview.route !== 'NON_PRD_DELIVERY' || !Array.isArray(preview.moves)) {
    return failure('DELIVERY_MIGRATION_INPUT_INVALID', '/preview', 'One complete migration preview is required.');
  }
  let lifecycleRoot;
  let tree;
  try {
    ({ lifecycleRoot } = await rootsFor(root));
    tree = await inspectLifecycleTree({ repositoryRoot: root });
    if (!tree.ok || `sha256:${tree.value.fingerprint}` !== preview.source_fingerprint) {
      return failure('DELIVERY_MIGRATION_STALE', '/source_fingerprint', 'Migration preview no longer matches the source tree.');
    }
  } catch {
    return failure('DELIVERY_MIGRATION_ROOT_INVALID', '/root', 'Migration candidate requires one bounded regular project root.');
  }

  const files = [];
  const items = [];
  try {
    for (const move of preview.moves) {
      for (const language of LANGUAGES) {
        const source = await readFile(join(lifecycleRoot, move.from[language]));
        if (hash(source) !== move.body_hashes[language]) {
          return failure('DELIVERY_MIGRATION_STALE', `/moves/${move.artifact_id}`, 'A migration source changed after preview.');
        }
        let content = source.toString('utf8').replaceAll('\r\n', '\n');
        if (move.artifact_kind !== 'generated-view') {
          const document = parseDocument(content);
          if (!document) return failure('DELIVERY_MIGRATION_CANDIDATE_INVALID', `/moves/${move.artifact_id}`, 'A migration source document is invalid.');
          const frontmatter = {
            ...document.frontmatter,
            schema_version: 2,
            ...(move.owner_artifact_id === null ? {} : { owner_artifact_id: move.owner_artifact_id }),
          };
          const rewrites = preview.managed_reference_rewrites.filter(({ source: locator }) => locator === move.from[language]);
          content = renderDocument(frontmatter, replaceManagedLinks(document.body, rewrites));
          if (language === 'en') {
            items.push({
              artifact_id: move.artifact_id,
              artifact_kind: move.artifact_kind,
              ...(move.owner_artifact_id === null ? {} : { owner_artifact_id: move.owner_artifact_id }),
              retention_tier: frontmatter.retention_tier,
              frontmatter,
              locators: move.to,
              archived: move.to.en.startsWith('archive/'),
            });
          }
        }
        files.push({
          repository_id: null,
          locator: move.to[language],
          content,
          validate: async (candidate) => candidate === content
            ? ok(candidate)
            : failure('DELIVERY_MIGRATION_CANDIDATE_INVALID', `/${move.to[language]}`, 'Staged migration content changed.'),
        });
      }
    }
    const indexes = await generateDeliveryIndexes({ inventory: inventoryForCandidate(items) });
    if (!indexes.ok) return indexes;
    files.push(...indexes.value.files.map(({ locator, content }) => ({
      repository_id: null,
      locator,
      content,
      validate: async (candidate) => candidate === content
        ? ok(candidate)
        : failure('DELIVERY_MIGRATION_CANDIDATE_INVALID', `/${locator}`, 'Staged delivery index changed.'),
    })));
    const marker = deliveryLayoutContent();
    files.push({
      repository_id: null,
      locator: 'delivery/layout.json',
      content: marker,
      validate: async (candidate) => candidate === marker
        ? ok(candidate)
        : failure('DELIVERY_MIGRATION_CANDIDATE_INVALID', '/delivery/layout.json', 'Staged delivery marker changed.'),
    });
  } catch {
    return failure('DELIVERY_MIGRATION_CANDIDATE_INVALID', '/', 'Migration candidate could not be built safely.');
  }

  const targetLocators = new Set(files.map(({ locator }) => locator));
  const deleteLocators = [...new Set(preview.moves.flatMap(({ from }) => Object.values(from)))]
    .filter((locator) => !targetLocators.has(locator))
    .sort(compareCodePoints);
  const candidateDirectories = [...new Set([
    ...preview.candidate_directories,
    ...files.map(({ locator }) => dirname(locator)),
  ])].filter((locator) => locator !== '.').sort(compareCodePoints);
  return ok({
    transaction: {
      repositoryRoot: root,
      expectedFingerprint: preview.source_fingerprint.replace(/^sha256:/u, ''),
      candidateDirectories,
      candidateFiles: files.sort((left, right) => compareCodePoints(left.locator, right.locator)),
      deleteLocators,
      validateCandidate: async ({ lifecycleRoot: candidateRoot }) => {
        const inventory = await collectDeliveryInventory({ lifecycleRoot: candidateRoot });
        if (!inventory.ok) return inventory;
        const present = new Set([
          ...inventory.value.pairs,
          ...inventory.value.archived_pairs,
        ].map(({ locator }) => locator));
        return preview.moves.every(({ to }) => Object.values(to).every((locator) => (
          locator.includes('/views/') || present.has(locator)
        ))) ? ok(inventory.value) : failure('DELIVERY_MIGRATION_CANDIDATE_INVALID', '/', 'Candidate inventory is incomplete.');
      },
    },
  });
};

export const validatePublishedDeliveryV2 = async ({ root, preview } = {}) => {
  let lifecycleRoot;
  try {
    ({ lifecycleRoot } = await rootsFor(root));
  } catch {
    return failure('DELIVERY_MIGRATION_ROOT_INVALID', '/root', 'Published delivery validation requires one bounded regular project root.');
  }
  const inventory = await collectDeliveryInventory({ lifecycleRoot });
  if (!inventory.ok) return inventory;
  const present = new Set([
    ...inventory.value.pairs,
    ...inventory.value.archived_pairs,
    ...inventory.value.views.flatMap(({ locators }) => Object.values(locators)),
  ].map((entry) => typeof entry === 'string' ? entry : entry.locator));
  for (const move of preview?.moves ?? []) {
    if (!Object.values(move.to).every((locator) => present.has(locator))) {
      return failure('DELIVERY_MIGRATION_VALIDATION_FAILED', `/moves/${move.artifact_id}`, 'A published migration target is missing.');
    }
    for (const locator of Object.values(move.from)) {
      if (Object.values(move.to).includes(locator)) continue;
      try {
        await lstat(join(lifecycleRoot, locator));
        return failure('DELIVERY_MIGRATION_VALIDATION_FAILED', `/moves/${move.artifact_id}`, 'A legacy migration source remains published.');
      } catch (error) {
        if (error.code !== 'ENOENT') return failure('DELIVERY_MIGRATION_VALIDATION_FAILED', '/', 'Published migration paths could not be verified.');
      }
    }
  }
  return ok({
    layout_version: 2,
    validation_ref: hash(canonical({
      moves: preview?.moves ?? [],
      owners: inventory.value.owners.map(({ artifact_id: id }) => id),
      feedbacks: inventory.value.feedbacks.map(({ artifact_id: id }) => id),
    })),
  });
};

export const migrateDeliveryLayout = async (input = {}, operations = {}) => {
  if (!isSafeReference(input.approval_ref) || !isSafeReference(input.backup_ref)) {
    return failure('DELIVERY_MIGRATION_APPROVAL_REQUIRED', '/approval_ref', 'Migration requires explicit approval and a recoverable backup reference.');
  }
  const inspection = await inspectLegacyDeliveryLayout(input);
  if (!inspection.ok) return inspection;
  if (inspection.value.route === 'NEEDS_USER') {
    return failure('DELIVERY_MIGRATION_NEEDS_USER', '/owner_mappings', 'Migration ownership must be resolved before publication.');
  }
  if (inspection.value.plan_hash !== input.plan_hash
    || inspection.value.source_fingerprint !== input.source_fingerprint) {
    return failure('DELIVERY_MIGRATION_STALE', '/plan_hash', 'Migration preview no longer matches the source tree.');
  }
  const candidate = await buildDeliveryMigrationCandidate({ root: input.root, preview: inspection.value });
  if (!candidate.ok) return candidate;
  const publication = await applyLayoutTransaction(candidate.value.transaction, {
    ...operations,
    retainBackup: true,
  });
  if (!publication.ok) return publication;
  const validation = await (operations.validatePublished ?? validatePublishedDeliveryV2)({ root: input.root, preview: inspection.value });
  if (!validation.ok) {
    const rollback = await rollbackRetainedLayout(publication.value, operations);
    return rollback.ok ? validation : rollback;
  }
  const finalized = await finalizeRetainedLayout(publication.value, operations);
  if (!finalized.ok) {
    const rollback = await rollbackRetainedLayout(publication.value, operations);
    return rollback.ok ? finalized : rollback;
  }
  return ok({
    layout_version: 2,
    backup_ref: input.backup_ref,
    moved_locators: inspection.value.moves,
    validation_ref: validation.value.validation_ref,
  });
};
