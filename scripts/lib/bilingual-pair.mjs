import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createError } from './errors.mjs';
import { parseFactBlocks } from './fact-blocks.mjs';
import { parseFrontmatter } from './markdown.mjs';
import { fail, ok } from './result.mjs';
import { validateJson } from './validate-json.mjs';

const MACHINE_FIELDS = [
  'id',
  'knowledge_state',
  'paired_asset',
  'last_verified_baseline',
  'implementation_refs',
  'verification_refs',
];
const FACT_FIELDS = ['fact_id', 'revision', 'evidence_refs', 'last_verified_baseline'];

const toPath = (value) => value instanceof URL ? fileURLToPath(value) : resolve(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const relativeAssetLocator = (root, asset, pathApi = { relative, sep }) => (
  pathApi.relative(root, asset).split(pathApi.sep).join('/')
);
const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

const headingLevels = (body) => [...body.matchAll(/^(#{1,6})[ \t]+.+$/gm)]
  .map((match) => match[1].length);

const commonAssetRoot = (left, right) => {
  let root = dirname(left);
  while (!inside(root, right)) root = dirname(root);
  return root;
};

const locatorSegments = (locator) => normalize(locator).split(sep).filter(Boolean);

const safeLocator = (locator) => typeof locator === 'string'
  && locator.length > 0
  && !isAbsolute(locator)
  && !/^[A-Za-z]:[\\/]/.test(locator)
  && !locator.includes('\\')
  && !locator.includes('://')
  && !locator.split('/').includes('..')
  && locatorSegments(locator).length > 0;

const rootFromLocator = (assetPath, locator) => {
  let root = assetPath;
  for (const _segment of locatorSegments(locator)) root = dirname(root);
  return resolve(root, locator) === assetPath ? root : null;
};

const establishTrustedPair = (enPath, zhPath, map) => {
  for (const domain of map.domains) {
    if (!domain.paired_assets) continue;
    for (const language of ['en', 'zh-CN']) {
      if (!safeLocator(domain.paired_assets[language])) {
        return fail([createError(
          'PAIR_MACHINE_MISMATCH',
          `/map/paired_assets/${language}`,
          `Project-map paired asset escapes the trusted knowledge root for ${language}.`,
        )]);
      }
    }
  }

  for (const domain of map.domains) {
    if (!domain.paired_assets) continue;
    const enRoot = rootFromLocator(enPath, domain.paired_assets.en);
    const zhRoot = rootFromLocator(zhPath, domain.paired_assets['zh-CN']);
    if (!enRoot || enRoot !== zhRoot) continue;
    const enAsset = resolve(enRoot, domain.paired_assets.en);
    const zhAsset = resolve(enRoot, domain.paired_assets['zh-CN']);
    if (enAsset !== enPath || zhAsset !== zhPath) continue;
    if (!inside(enRoot, enAsset) || !inside(enRoot, zhAsset)) continue;
    return ok({
      domain,
      projectRoot: enRoot,
      root: commonAssetRoot(enAsset, zhAsset),
    });
  }

  return fail([createError(
    'PAIR_MACHINE_MISMATCH',
    '/paths',
    'Supplied bilingual assets do not resolve under one trusted project-map root.',
  )]);
};

const readDocument = async (path) => {
  try {
    return { source: await readFile(path, 'utf8') };
  } catch {
    return { error: createError('PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset', 'Paired capability asset is missing.') };
  }
};

export const validateBilingualPair = async (enPathValue, zhPathValue, map) => {
  const enPath = toPath(enPathValue);
  const zhPath = toPath(zhPathValue);
  const mapResult = validateJson('project-map', map);
  if (!mapResult.ok) return mapResult;
  const trustedPair = establishTrustedPair(enPath, zhPath, map);
  if (!trustedPair.ok) return trustedPair;
  const { domain, projectRoot, root } = trustedPair.value;

  const enDocument = await readDocument(enPath);
  const zhDocument = await readDocument(zhPath);
  if (enDocument.error || zhDocument.error) return fail([enDocument.error ?? zhDocument.error]);

  const enFrontmatter = parseFrontmatter(enDocument.source);
  const zhFrontmatter = parseFrontmatter(zhDocument.source);
  const enFacts = parseFactBlocks(enDocument.source);
  const zhFacts = parseFactBlocks(zhDocument.source);
  const parseErrors = [enFrontmatter, zhFrontmatter, enFacts, zhFacts]
    .filter((result) => !result.ok)
    .flatMap((result) => result.errors);
  if (parseErrors.length > 0) return fail(parseErrors);

  const errors = [];
  for (const field of MACHINE_FIELDS) {
    if (!same(enFrontmatter.value.data[field], zhFrontmatter.value.data[field])) {
      errors.push(createError('PAIR_MACHINE_MISMATCH', `/frontmatter/${field}`, `Bilingual Frontmatter field differs: ${field}`));
    }
  }

  for (const [path, frontmatter] of [[enPath, enFrontmatter], [zhPath, zhFrontmatter]]) {
    const pairedPath = resolve(dirname(path), frontmatter.value.data.paired_asset);
    if (!inside(root, pairedPath)) {
      errors.push(createError('PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset', 'paired_asset escapes the allowed knowledge root.'));
      continue;
    }
    try {
      await access(pairedPath);
    } catch {
      errors.push(createError('PAIR_MACHINE_MISMATCH', '/frontmatter/paired_asset', 'paired_asset does not exist.'));
    }
  }

  if (!same(headingLevels(enFrontmatter.value.body), headingLevels(zhFrontmatter.value.body))) {
    errors.push(createError('PAIR_SECTION_MISMATCH', '/sections', 'Bilingual heading-level sequences differ.'));
  }

  if (enFacts.value.length !== zhFacts.value.length) {
    errors.push(createError('PAIR_SECTION_MISMATCH', '/facts', 'Bilingual fact-block counts differ.'));
  }
  const pairedFactCount = Math.min(enFacts.value.length, zhFacts.value.length);
  for (let index = 0; index < pairedFactCount; index += 1) {
    for (const field of FACT_FIELDS) {
      if (!same(enFacts.value[index][field], zhFacts.value[index][field])) {
        errors.push(createError('PAIR_MACHINE_MISMATCH', `/facts/${index}/${field}`, `Bilingual fact field differs: ${field}`));
      }
    }
    const isCurrent = enFrontmatter.value.data.knowledge_state === 'current'
      || zhFrontmatter.value.data.knowledge_state === 'current';
    const evidenceMissing = enFacts.value[index].evidence_refs.length === 0
      || zhFacts.value[index].evidence_refs.length === 0;
    if (isCurrent && evidenceMissing) {
      errors.push(createError('CURRENT_EVIDENCE_MISSING', `/facts/${index}/evidence_refs`, 'Current facts require evidence.'));
    }
    const baselineMismatch = enFacts.value[index].last_verified_baseline
        !== enFrontmatter.value.data.last_verified_baseline
      || zhFacts.value[index].last_verified_baseline
        !== zhFrontmatter.value.data.last_verified_baseline;
    if (baselineMismatch) {
      errors.push(createError(
        'PAIR_MACHINE_MISMATCH',
        `/facts/${index}/last_verified_baseline`,
        'Fact baseline differs from its owning capability document.',
      ));
    }
  }

  if (domain.id !== enFrontmatter.value.data.id) {
    errors.push(createError('PAIR_MACHINE_MISMATCH', '/frontmatter/id', 'Capability ID is absent from the project map.'));
  } else {
    if (domain.baseline !== enFrontmatter.value.data.last_verified_baseline) {
      errors.push(createError('PAIR_MACHINE_MISMATCH', '/frontmatter/last_verified_baseline', 'Capability baseline differs from the project map.'));
    }
    const expectedAssets = {
      en: relativeAssetLocator(projectRoot, enPath),
      'zh-CN': relativeAssetLocator(projectRoot, zhPath),
    };
    for (const language of ['en', 'zh-CN']) {
      if (domain.paired_assets?.[language] !== expectedAssets[language]) {
        errors.push(createError('PAIR_MACHINE_MISMATCH', `/map/paired_assets/${language}`, `Project-map paired asset differs for ${language}.`));
      }
    }
  }

  return errors.length > 0
    ? fail(errors)
    : ok({ fact_ids: enFacts.value.map((fact) => fact.fact_id) });
};
