import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { compareCodePoints } from '../lib/deterministic-order.mjs';

const HARD_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024,
  maxRecentEvolutionEntries: 20,
  maxTopologyEntries: 256,
});

const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024,
  maxRecentEvolutionEntries: 5,
  maxTopologyEntries: 128,
});

const instructionFiles = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md']);
const overviewFiles = Object.freeze(['README', 'README.md', 'README.txt']);
const manifestFiles = Object.freeze([
  'CMakeLists.txt',
  'Cargo.toml',
  'Dockerfile',
  'Gemfile',
  'Makefile',
  'Package.swift',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'docker-compose.yaml',
  'docker-compose.yml',
  'go.mod',
  'package.json',
  'pnpm-workspace.yaml',
  'pom.xml',
  'pubspec.yaml',
  'pyproject.toml',
  'settings.gradle',
  'settings.gradle.kts',
]);
const indexFiles = Object.freeze([
  'docs/INDEX-en.md',
  'docs/INDEX.md',
  'docs/architecture/INDEX-en.md',
  'docs/architecture/INDEX.md',
  'docs/design/INDEX-en.md',
  'docs/design/INDEX.md',
  'docs/knowledge/INDEX-en.md',
  'docs/knowledge/INDEX.md',
  'docs/product/INDEX-en.md',
  'docs/product/INDEX.md',
  'docs/test/INDEX-en.md',
  'docs/test/INDEX.md',
  'docs/tests/INDEX-en.md',
  'docs/tests/INDEX.md',
]);
const changelogFiles = Object.freeze(['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md']);
const topologyRoots = Object.freeze(['apps', 'core', 'modules', 'packages', 'ports', 'src', 'test', 'tests']);
const topologyContainers = new Set(['apps', 'core', 'modules', 'packages', 'ports']);
const ignoredSegments = new Set([
  '.cache',
  '.git',
  '.gradle',
  '.idea',
  '.project-lifecycle',
  '.runtime',
  '.superpowers',
  '.vscode',
  'archive',
  'archives',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const evidenceError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const normalizeLimits = (provided = {}) => {
  if (provided === null || typeof provided !== 'object' || Array.isArray(provided)) {
    throw evidenceError('EVIDENCE_LIMIT_INVALID', 'Evidence limits must be an object.');
  }
  const unknown = Object.keys(provided).filter((key) => !Object.hasOwn(DEFAULT_LIMITS, key));
  if (unknown.length > 0) {
    throw evidenceError('EVIDENCE_LIMIT_INVALID', 'Evidence limits contain an unknown field.');
  }
  const limits = { ...DEFAULT_LIMITS, ...provided };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[name]) {
      throw evidenceError('EVIDENCE_LIMIT_INVALID', 'Evidence limit is outside the bounded range.');
    }
  }
  return limits;
};

const portableLocator = (relativePath, fragment = '') => `repo:${relativePath}${fragment}`;

const contentHash = (observed) => `sha256:${createHash('sha256')
  .update(JSON.stringify(observed))
  .digest('hex')}`;

const makeEntry = (kind, locator, observed) => ({
  kind,
  locator,
  observed,
  content_hash: contentHash(observed),
});

const pathSegmentsAreApproved = (relativePath) => relativePath
  .split('/')
  .every((segment) => segment && !segment.startsWith('.') && !ignoredSegments.has(segment));

const safeStat = async (root, relativePath) => {
  if (!pathSegmentsAreApproved(relativePath)) return null;
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return null;
  }
  return lstat(current);
};

const readBoundedFile = async (root, relativePath, maxFileBytes) => {
  const stat = await safeStat(root, relativePath);
  if (!stat?.isFile()) return null;
  const handle = await open(join(root, ...relativePath.split('/')), 'r');
  try {
    const buffer = Buffer.alloc(maxFileBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      content: buffer.subarray(0, Math.min(bytesRead, maxFileBytes)).toString('utf8'),
      truncated: bytesRead > maxFileBytes,
    };
  } finally {
    await handle.close();
  }
};

const addContentFile = async (entries, root, relativePath, kind, maxFileBytes) => {
  const observed = await readBoundedFile(root, relativePath, maxFileBytes);
  if (observed) entries.push(makeEntry(kind, portableLocator(relativePath), observed));
  return observed;
};

const addPackageEntryPoints = (entries, manifestPath, observed) => {
  if (!observed || observed.truncated || manifestPath !== 'package.json') return;
  let manifest;
  try {
    manifest = JSON.parse(observed.content);
  } catch {
    return;
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return;
  if (manifest.scripts === null || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) return;
  const names = Object.keys(manifest.scripts).sort(compareCodePoints);
  for (const name of names) {
    const command = manifest.scripts[name];
    if (!/^(build|deploy|dev|serve|start|test)(?::|$)/u.test(name) || typeof command !== 'string') continue;
    entries.push(makeEntry(
      'declared_entry_point',
      portableLocator(manifestPath, `#scripts/${name}`),
      { name, command },
    ));
  }
};

const isRecognizedTopologyFile = (relativePath, name) => {
  const isTestRoot = relativePath === 'test' || relativePath === 'tests';
  if (isTestRoot) return /(?:^|[.-])(test|spec)(?:[.-]|$)/u.test(name);
  return /^(?:app|application|main)\.(?:go|js|jsx|kt|kts|mjs|py|rs|swift|ts|tsx)$/iu.test(name);
};

const approvedDirectoryEntries = async (root, relativePath) => {
  const stat = await safeStat(root, relativePath);
  if (!stat?.isDirectory()) return [];
  const entries = await readdir(join(root, ...relativePath.split('/')), { withFileTypes: true });
  return entries
    .filter((entry) => !entry.isSymbolicLink()
      && !entry.name.startsWith('.')
      && !ignoredSegments.has(entry.name))
    .sort((left, right) => compareCodePoints(left.name, right.name));
};

const collectTopology = async (root, maxTopologyEntries) => {
  const candidates = [];
  for (const topologyRoot of topologyRoots) {
    const stat = await safeStat(root, topologyRoot);
    if (!stat?.isDirectory()) continue;
    candidates.push(makeEntry('topology', portableLocator(topologyRoot), { entry_type: 'directory' }));
    const children = await approvedDirectoryEntries(root, topologyRoot);
    for (const child of children) {
      const childPath = `${topologyRoot}/${child.name}`;
      if (child.isDirectory()) {
        candidates.push(makeEntry('topology', portableLocator(childPath), { entry_type: 'directory' }));
        if (topologyContainers.has(child.name)) {
          const modules = await approvedDirectoryEntries(root, childPath);
          for (const module of modules.filter((entry) => entry.isDirectory())) {
            candidates.push(makeEntry(
              'topology',
              portableLocator(`${childPath}/${module.name}`),
              { entry_type: 'directory' },
            ));
          }
        }
      } else if (child.isFile() && isRecognizedTopologyFile(topologyRoot, child.name)) {
        candidates.push(makeEntry('topology', portableLocator(childPath), { entry_type: 'file' }));
      }
    }
  }
  candidates.sort((left, right) => compareCodePoints(left.locator, right.locator));
  return candidates.slice(0, maxTopologyEntries);
};

const parseRecentEvolution = (relativePath, observed, limit) => {
  if (!observed) return [];
  const matches = [...observed.content.matchAll(/^##\s+(.+?)\s*$/gmu)];
  return matches.slice(0, limit).map((match, index) => {
    const next = matches[index + 1];
    const content = observed.content.slice(match.index + match[0].length, next?.index).trim();
    const heading = match[1].trim();
    return makeEntry(
      'recent_evolution',
      portableLocator(relativePath, `#${encodeURIComponent(heading)}`),
      { heading, content },
    );
  });
};

export async function collectEvidence({ root, limits: providedLimits = {} }) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw evidenceError('EVIDENCE_ROOT_ABSOLUTE_REQUIRED', 'Evidence root must be absolute.');
  }
  const limits = normalizeLimits(providedLimits);
  let rootPath;
  try {
    rootPath = await realpath(root);
  } catch {
    throw evidenceError('EVIDENCE_ROOT_INVALID', 'Evidence root is unavailable.');
  }
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory()) {
    throw evidenceError('EVIDENCE_ROOT_INVALID', 'Evidence root is not a directory.');
  }

  const entries = [];
  for (const relativePath of instructionFiles) {
    await addContentFile(entries, rootPath, relativePath, 'project_instruction', limits.maxFileBytes);
  }
  for (const relativePath of overviewFiles) {
    await addContentFile(entries, rootPath, relativePath, 'project_overview', limits.maxFileBytes);
  }
  for (const relativePath of manifestFiles) {
    const observed = await addContentFile(
      entries,
      rootPath,
      relativePath,
      'manifest',
      limits.maxFileBytes,
    );
    addPackageEntryPoints(entries, relativePath, observed);
  }
  entries.push(...await collectTopology(rootPath, limits.maxTopologyEntries));
  for (const relativePath of indexFiles) {
    await addContentFile(entries, rootPath, relativePath, 'knowledge_index', limits.maxFileBytes);
  }

  let remainingEvolutionEntries = limits.maxRecentEvolutionEntries;
  for (const relativePath of changelogFiles) {
    if (remainingEvolutionEntries === 0) break;
    const observed = await readBoundedFile(rootPath, relativePath, limits.maxFileBytes);
    const evolutionEntries = parseRecentEvolution(relativePath, observed, remainingEvolutionEntries);
    entries.push(...evolutionEntries);
    remainingEvolutionEntries -= evolutionEntries.length;
  }

  entries.sort((left, right) => {
    const locatorOrder = compareCodePoints(left.locator, right.locator);
    return locatorOrder || compareCodePoints(left.kind, right.kind);
  });
  return { schema_version: 1, entries };
}
