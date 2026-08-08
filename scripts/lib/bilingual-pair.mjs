import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createError } from './errors.mjs';
import { parseFactBlocks } from './fact-blocks.mjs';
import { parseFrontmatter } from './markdown.mjs';
import { fail, ok } from './result.mjs';

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
const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

const headingLevels = (body) => [...body.matchAll(/^(#{1,6})[ \t]+.+$/gm)]
  .map((match) => match[1].length);

const commonDirectory = (left, right) => {
  let root = dirname(left);
  while (!inside(root, right)) {
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return root;
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
  const root = commonDirectory(enPath, zhPath);
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

  const domain = map?.domains?.find((entry) => entry.id === enFrontmatter.value.data.id);
  if (!domain) {
    errors.push(createError('PAIR_MACHINE_MISMATCH', '/frontmatter/id', 'Capability ID is absent from the project map.'));
  } else {
    if (domain.baseline !== enFrontmatter.value.data.last_verified_baseline) {
      errors.push(createError('PAIR_MACHINE_MISMATCH', '/frontmatter/last_verified_baseline', 'Capability baseline differs from the project map.'));
    }
    const expectedAssets = { en: relative(root, enPath), 'zh-CN': relative(root, zhPath) };
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
