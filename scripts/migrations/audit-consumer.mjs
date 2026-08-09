import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { createProcessRunner } from '../adapters/process-runner.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';

const MAX_ENTRIES = 5_000;
const MAX_DEPTH = 20;
const MAX_DIRECTIVE_BYTES = 1_048_576;
const LEGACY_SKILLS = Object.freeze([
  '.agents/skills/docs-workflow/SKILL.md',
  '.zcode/skills/docs-workflow/SKILL.md',
]);
const DIRECTIVE_FILES = Object.freeze(['AGENTS.md', 'docs/product/README.md']);
const SCANNED_ROOTS = Object.freeze([
  ...LEGACY_SKILLS,
  'AGENTS.md',
  'docs/product',
  'docs/superpowers/plans',
  'docs/superpowers/specs',
]);
const INVENTORY_DIRECTORIES = Object.freeze([
  'docs/product',
  'docs/superpowers/plans',
  'docs/superpowers/specs',
]);

const failure = (path, message) => fail([
  createError('CONSUMER_AUDIT_INVALID', path, message),
]);

const sortLocators = (values) => [...new Set(values)].sort(compareCodePoints);

const safeLocator = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 1_024
  && !value.includes('\0')
  && !value.includes('\\')
  && !isAbsolute(value)
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

const isInside = (root, candidate) => {
  const locator = relative(root, candidate);
  return locator === '' || (!locator.startsWith(`..${sep}`) && locator !== '..' && !isAbsolute(locator));
};

const inventoryFiles = async (root) => {
  const files = [];
  let entries = 0;

  const visit = async (directory, prefix, depth) => {
    if (depth > MAX_DEPTH) throw new Error('DEPTH_LIMIT');
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error('ENTRY_LIMIT');
      if (entry.name === '.git' || entry.isSymbolicLink()) continue;
      const locator = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), locator, depth + 1);
      else if (entry.isFile()) files.push(locator);
    }
  };

  const addKnownFile = async (locator) => {
    const path = join(root, ...locator.split('/'));
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) return;
      if (!isInside(root, await realpath(path))) throw new Error('PATH_ESCAPE');
      files.push(locator);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };

  for (const locator of [...LEGACY_SKILLS, 'AGENTS.md']) await addKnownFile(locator);
  for (const locator of INVENTORY_DIRECTORIES) {
    const path = join(root, ...locator.split('/'));
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
      if (!isInside(root, await realpath(path))) throw new Error('PATH_ESCAPE');
      await visit(path, locator, 0);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return sortLocators(files);
};

const readDirectiveLines = async (root, locator) => {
  const path = join(root, ...locator.split('/'));
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > MAX_DIRECTIVE_BYTES) throw new Error('DIRECTIVE_INVALID');
  const text = await readFile(path, 'utf8');
  const lines = [];
  text.split(/\r?\n/u).forEach((line, index) => {
    if (line.includes('docs-workflow')) lines.push(index + 1);
  });
  return lines;
};

const defaultDirtyPaths = async (root) => {
  const process = await createProcessRunner().runProcess(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: root, timeoutMs: 10_000 },
  );
  if (!process.ok) throw new Error('GIT_STATUS_FAILED');
  const paths = [];
  const records = process.stdout.split('\0').filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    let locator = record.slice(3);
    if (status.includes('R') || status.includes('C')) {
      index += 1;
      locator = records[index] ?? '';
    }
    if (!safeLocator(locator)) throw new Error('DIRTY_PATH_INVALID');
    paths.push(locator);
  }
  return sortLocators(paths);
};

const classifyBilingualAssets = (fileSet) => {
  const bilingualPairs = [];
  const unpaired = [];
  for (const locator of fileSet) {
    if (!locator.startsWith('docs/product/')
      || !locator.endsWith('-en.md')
      || locator.endsWith('/INDEX-en.md')) continue;
    const zh = `${locator.slice(0, -6)}.md`;
    if (fileSet.has(zh)) bilingualPairs.push({ en: locator, zh });
    else unpaired.push(locator);
  }
  bilingualPairs.sort((left, right) => compareCodePoints(left.en, right.en));
  return { bilingualPairs, unpaired: sortLocators(unpaired) };
};

export const auditConsumer = async (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !isAbsolute(input.root ?? '') || input.root === sep) {
    return failure('/root', 'Consumer audit requires one explicit absolute directory root.');
  }

  try {
    const rootMetadata = await lstat(input.root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      return failure('/root', 'Consumer root must be a real directory.');
    }
    const root = await realpath(input.root);

    const files = await inventoryFiles(root);
    const fileSet = new Set(files);
    const legacySkillCopies = LEGACY_SKILLS.filter((locator) => fileSet.has(locator));
    const instructionCallSites = [];
    for (const locator of DIRECTIVE_FILES) {
      if (!fileSet.has(locator)) continue;
      const lines = await readDirectiveLines(root, locator);
      if (lines.length > 0) instructionCallSites.push({ locator, lines });
    }

    const productIndexes = files.filter((locator) => (
      locator.startsWith('docs/product/') && locator.endsWith('/INDEX.md')
    ));
    const { bilingualPairs, unpaired } = classifyBilingualAssets(fileSet);
    const superpowersAssets = files.filter((locator) => (
      locator.startsWith('docs/superpowers/plans/')
      || locator.startsWith('docs/superpowers/specs/')
    ));

    const dirtyReader = input.readDirtyPaths ?? defaultDirtyPaths;
    const dirtyPaths = await dirtyReader(root);
    if (!Array.isArray(dirtyPaths) || dirtyPaths.some((locator) => !safeLocator(locator))) {
      return failure('/unrelated_dirty_paths', 'Dirty paths must be safe repository-relative locators.');
    }

    const hosts = input.supportMatrix?.hosts;
    const supported = hosts && typeof hosts === 'object'
      && Object.values(hosts).some((host) => host?.status === 'SUPPORTED');
    const discovered = input.pluginDiscovery?.maintain_project_knowledge === true
      && input.pluginDiscovery?.run_prd_lifecycle === true;
    const migrationStatus = !supported
      ? 'BLOCKED_UPSTREAM_SUPPORT'
      : !discovered
        ? 'BLOCKED_PLUGIN_DISCOVERY'
        : 'READY_FOR_SEPARATE_CONSUMER_PR';

    return ok({
      audit_only: true,
      migration_status: migrationStatus,
      bootstrap_candidate: 'docs/project-lifecycle/',
      legacy_skill_copies: legacySkillCopies,
      instruction_call_sites: instructionCallSites,
      product_indexes: productIndexes,
      bilingual_pairs: bilingualPairs,
      unpaired_bilingual_assets: unpaired,
      superpowers_assets: superpowersAssets,
      unrelated_dirty_paths: sortLocators(dirtyPaths),
      scanned_roots: [...SCANNED_ROOTS],
      deletion_candidates: migrationStatus === 'READY_FOR_SEPARATE_CONSUMER_PR'
        ? legacySkillCopies
        : [],
    });
  } catch {
    return failure('/', 'Consumer audit could not complete within its bounded read-only contract.');
  }
};
