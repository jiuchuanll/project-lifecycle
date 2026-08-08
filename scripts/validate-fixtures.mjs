import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve } from 'node:path';

import { validateBilingualPair } from './lib/bilingual-pair.mjs';
import { validateJson } from './lib/validate-json.mjs';

const normalizePath = (path) => path.replaceAll('\\', '/').replace(/^\.\//, '');

const insideRoot = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

const resolveListedPath = async (root, path) => {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) return null;
  const resolved = resolve(root, path);
  if (!insideRoot(root, resolved)) return null;
  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(resolved)]);
    return insideRoot(realRoot, realCandidate) ? resolved : null;
  } catch (error) {
    return error.code === 'ENOENT' ? resolved : null;
  }
};

const listFixtureFiles = async (root, directory = root) => {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.gitkeep') continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await listFixtureFiles(root, absolute));
    } else if ((entry.isFile() || entry.isSymbolicLink())
      && absolute !== resolve(root, 'manifest.json')) {
      paths.push(normalizePath(relative(root, absolute)));
    }
  }
  return paths;
};

const declaredFiles = (entry) => {
  if (entry.validator.startsWith('json:')) return [normalizePath(entry.path)];
  if (entry.validator !== 'bilingual-pair' || !entry.inputs) return [];
  return Object.values(entry.inputs).map((path) => posix.normalize(posix.join(entry.path, path)));
};

const validateEntry = async (root, entry) => {
  if (entry.validator.startsWith('json:')) {
    const path = await resolveListedPath(root, entry.path);
    if (!path) return { ok: false, errors: [{ code: 'FIXTURE_PATH_INVALID' }] };
    const value = JSON.parse(await readFile(path, 'utf8'));
    return validateJson(entry.validator.slice('json:'.length), value);
  }

  if (entry.validator === 'bilingual-pair') {
    const fixtureDirectory = await resolveListedPath(root, entry.path);
    if (!fixtureDirectory || !entry.inputs) {
      return { ok: false, errors: [{ code: 'FIXTURE_PATH_INVALID' }] };
    }
    const enPath = await resolveListedPath(root, posix.join(entry.path, entry.inputs.en));
    const zhPath = await resolveListedPath(root, posix.join(entry.path, entry.inputs['zh-CN']));
    const mapPath = await resolveListedPath(root, posix.join(entry.path, entry.inputs.project_map));
    if (!enPath || !zhPath || !mapPath) {
      return { ok: false, errors: [{ code: 'FIXTURE_PATH_INVALID' }] };
    }
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    return validateBilingualPair(enPath, zhPath, map);
  }

  return { ok: false, errors: [{ code: 'FIXTURE_VALIDATOR_UNKNOWN' }] };
};

const failedResult = (code) => ({ ok: false, errors: [{ code }] });

export const validateFixtures = async (rootValue) => {
  const root = resolve(rootValue);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  } catch {
    return {
      ok: false,
      results: [],
      errors: [{ code: 'FIXTURE_MANIFEST_INVALID', path: 'manifest.json' }],
    };
  }

  const fixtures = Array.isArray(manifest.fixtures) ? manifest.fixtures : [];
  const seen = new Set();
  const duplicateErrors = [];
  for (const entry of fixtures) {
    const path = normalizePath(entry.path ?? '');
    if (seen.has(path)) duplicateErrors.push({ code: 'FIXTURE_MANIFEST_DUPLICATE', path });
    seen.add(path);
  }
  if (duplicateErrors.length > 0) {
    return { ok: false, results: [], errors: duplicateErrors };
  }

  const declared = new Set(fixtures.flatMap(declaredFiles));
  const actual = await listFixtureFiles(root);
  const errors = actual
    .filter((path) => !declared.has(path))
    .map((path) => ({ code: 'FIXTURE_UNLISTED', path }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const results = [];
  for (const entry of fixtures.toSorted((left, right) => left.path.localeCompare(right.path))) {
    let result;
    try {
      result = await validateEntry(root, entry);
    } catch {
      result = failedResult('FIXTURE_READ_ERROR');
    }
    const actualCode = result.ok ? 'OK' : result.errors[0]?.code ?? 'FIXTURE_VALIDATION_ERROR';
    results.push({
      path: entry.path,
      validator: entry.validator,
      expected_code: entry.expected_code,
      actual_code: actualCode,
      matched: actualCode === entry.expected_code,
    });
  }

  return {
    ok: errors.length === 0 && results.every(({ matched }) => matched),
    results,
    errors,
  };
};
