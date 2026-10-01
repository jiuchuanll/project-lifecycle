import { createHash } from 'node:crypto';
import { lstat, mkdir, opendir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProcessRunner } from './adapters/process-runner.mjs';
import { compareCodePoints } from './lib/deterministic-order.mjs';
import { createError } from './lib/errors.mjs';
import { fail, ok } from './lib/result.mjs';

const HOST_ORDER = Object.freeze(['codex', 'claude', 'cursor', 'dsh', 'kimi', 'zcode']);
const RELEASE_FILES = Object.freeze([
  ['.agents/plugins/marketplace.json', '.agents/plugins/marketplace.json'],
  ['.claude-plugin/marketplace.json', '.claude-plugin/marketplace.json'],
  ['.claude-plugin/plugin.json', '.claude-plugin/plugin.json'],
  ['.codex-plugin/plugin.json', '.codex-plugin/plugin.json'],
  ['.cursor-plugin/plugin.json', '.cursor-plugin/plugin.json'],
  ['.kimi-plugin/plugin.json', '.kimi-plugin/plugin.json'],
  ['.zcode-plugin/plugin.json', '.zcode-plugin/plugin.json'],
  ['cordis.patch.yml', 'cordis.patch.yml'],
  ['dsh/index.js', 'dsh/index.js'],
  ['README.md', 'README.md'],
  ['README.zh-CN.md', 'README.zh-CN.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING.md'],
  ['CONTRIBUTING.zh-CN.md', 'CONTRIBUTING.zh-CN.md'],
  ['RELEASE-NOTES.md', 'RELEASE-NOTES.md'],
  ['LICENSE', 'LICENSE'],
  ['package.json', 'package.json'],
  ['bin/project-lifecycle', 'bin/project-lifecycle'],
  ['dist/project-lifecycle.mjs', 'dist/project-lifecycle.mjs'],
  ['docs/migrations/knowledgevault-agent-app.md', 'docs/migrations/knowledgevault-agent-app.md'],
  ['references/harness-tool-contract.md', 'references/harness-tool-contract.md'],
  ['tests/harnesses/support-matrix.json', 'support-matrix.json'],
  ['tests/harnesses/targeted-regression.json', 'targeted-regression.json'],
]);
const RELEASE_DIRECTORIES = Object.freeze(['integrations', 'skills']);
const MAX_RELEASE_FILES = 500;
const SAFE_VERSION = /^(?!.*\.\.)(?!.*[.-]$)[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/u;

const failure = (code, path, message) => fail([createError(code, path, message)]);
const cleanCell = (value) => String(value ?? '—').replaceAll('|', '\\|').replace(/[\r\n]/gu, ' ');

export const renderSupportMatrix = (matrix, language = 'en') => {
  const header = language === 'zh'
    ? ['宿主', '状态', '实测版本', '证据']
    : ['Host', 'Status', 'Observed version', 'Evidence'];
  const rows = HOST_ORDER.map((host) => {
    const evidence = matrix?.hosts?.[host] ?? {};
    return [host, evidence.status, evidence.observed_version, (evidence.evidence_refs ?? []).join(', ')];
  });
  return [header, header.map(() => '---'), ...rows]
    .map((row) => `| ${row.map(cleanCell).join(' | ')} |`)
    .join('\n');
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const makeZip = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.content;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.executable ? 0o100755 : 0o100644) * 65_536) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

export const inspectReleaseZip = (archive) => {
  try {
    const entries = new Map();
    let offset = 0;
    while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
      if (offset + 30 > archive.length || archive.readUInt16LE(offset + 8) !== 0) throw new Error('ZIP_FORMAT');
      const size = archive.readUInt32LE(offset + 18);
      const nameLength = archive.readUInt16LE(offset + 26);
      const extraLength = archive.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const dataStart = nameStart + nameLength + extraLength;
      const dataEnd = dataStart + size;
      if (dataEnd > archive.length) throw new Error('ZIP_BOUNDS');
      const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
      if (entries.has(name)) throw new Error('ZIP_DUPLICATE');
      entries.set(name, archive.subarray(dataStart, dataEnd));
      offset = dataEnd;
    }
    if (entries.size === 0 || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP_EMPTY');
    return ok(entries);
  } catch {
    return failure('RELEASE_ARCHIVE_INVALID', '/archive', 'Release archive is not a bounded stored ZIP.');
  }
};

const listDirectory = async (repositoryRoot, locator) => {
  const results = [];
  const visit = async (directory, prefix) => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (entry.name === '.DS_Store') continue;
      if (entry.isSymbolicLink()) throw new Error('RELEASE_SYMLINK');
      const child = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), child);
      else if (entry.isFile()) results.push([child, child]);
      if (results.length > MAX_RELEASE_FILES) throw new Error('RELEASE_FILE_LIMIT');
    }
  };
  await visit(join(repositoryRoot, locator), locator);
  return results;
};

const gitOutput = async (repositoryRoot, args) => createProcessRunner().runProcess(
  'git', args, { cwd: repositoryRoot, timeoutMs: 10_000 },
);

const defaultDirtyPaths = async (repositoryRoot) => {
  const result = await gitOutput(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!result.ok) throw new Error('GIT_STATUS');
  return result.stdout.split('\0').filter(Boolean);
};

const trackedFiles = async (repositoryRoot) => {
  const result = await gitOutput(repositoryRoot, ['ls-files', '-z']);
  if (!result.ok) throw new Error('GIT_LS_FILES');
  return new Set(result.stdout.split('\0').filter(Boolean));
};

const collectEntries = async (repositoryRoot, version, requireTracked) => {
  const pairs = [...RELEASE_FILES];
  for (const directory of RELEASE_DIRECTORIES) pairs.push(...await listDirectory(repositoryRoot, directory));
  const tracked = requireTracked ? await trackedFiles(repositoryRoot) : null;
  const entries = [];
  for (const [source, destination] of pairs) {
    if (tracked && !tracked.has(source)) throw new Error('RELEASE_UNTRACKED_INPUT');
    const path = join(repositoryRoot, source);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('RELEASE_INPUT_INVALID');
    entries.push({
      name: `project-lifecycle-${version}/${destination}`,
      content: await readFile(path),
      executable: destination === 'bin/project-lifecycle',
    });
  }
  entries.sort((left, right) => compareCodePoints(left.name, right.name));
  return entries;
};

export const buildReleasePackage = async (options = {}) => {
  const repositoryRoot = resolve(options.repositoryRoot ?? fileURLToPath(new URL('..', import.meta.url)));
  try {
    if (!options.allowDirty) {
      const dirty = await (options.readDirtyPaths ?? defaultDirtyPaths)(repositoryRoot);
      if (!Array.isArray(dirty) || dirty.length > 0) {
        return failure('RELEASE_TREE_DIRTY', '/', 'Release packaging requires a clean repository tree.');
      }
    }
    const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
    const version = options.filenameVersion ?? packageJson.version;
    if (!SAFE_VERSION.test(packageJson.version ?? '') || !SAFE_VERSION.test(version ?? '')) {
      return failure('RELEASE_VERSION_INVALID', '/version', 'Release version must be one bounded path-safe component.');
    }
    if (version !== packageJson.version) {
      return failure('RELEASE_VERSION_MISMATCH', '/version', 'Archive filename version must equal package.json.');
    }
    const matrix = JSON.parse(await readFile(join(repositoryRoot, 'tests/harnesses/support-matrix.json'), 'utf8'));
    if (matrix.plugin_version !== version) {
      return failure('RELEASE_VERSION_MISMATCH', '/support_matrix/plugin_version', 'Support evidence version must equal package.json.');
    }
    const english = await readFile(join(repositoryRoot, 'README.md'), 'utf8');
    const chinese = await readFile(join(repositoryRoot, 'README.zh-CN.md'), 'utf8');
    if (!english.includes(renderSupportMatrix(matrix, 'en'))
      || !chinese.includes(renderSupportMatrix(matrix, 'zh'))) {
      return failure('RELEASE_SUPPORT_DOC_MISMATCH', '/README', 'README support tables must derive from retained evidence.');
    }

    const entries = await collectEntries(repositoryRoot, version, options.requireTracked !== false);
    const archive = makeZip(entries);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const outputDirectory = resolve(options.outputDirectory ?? join(repositoryRoot, 'dist'));
    if (relative(repositoryRoot, outputDirectory).startsWith('..') && options.outputDirectory === undefined) {
      return failure('RELEASE_OUTPUT_INVALID', '/output_directory', 'Default release output must remain in the repository.');
    }
    await mkdir(outputDirectory, { recursive: true });
    const archivePath = join(outputDirectory, `project-lifecycle-${version}.zip`);
    const checksumPath = `${archivePath}.sha256`;
    for (const path of [archivePath, checksumPath]) {
      try {
        const state = await lstat(path);
        if (!state.isFile() || state.isSymbolicLink()) {
          return failure('RELEASE_OUTPUT_INVALID', '/output_directory', 'Release outputs must be regular files or absent.');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await writeFile(archivePath, archive);
    await writeFile(checksumPath, `${sha256}  project-lifecycle-${version}.zip\n`, 'utf8');
    const supported = HOST_ORDER.every((host) => matrix.hosts?.[host]?.status === 'SUPPORTED');
    return ok({
      archive_path: archivePath,
      checksum_path: checksumPath,
      sha256,
      entry_count: entries.length,
      release_status: supported ? 'RELEASE_CANDIDATE' : 'NON_RELEASE_CANDIDATE',
    });
  } catch {
    return failure('RELEASE_PACKAGE_FAILED', '/', 'Release package could not be built from the explicit tracked allowlist.');
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildReleasePackage();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
