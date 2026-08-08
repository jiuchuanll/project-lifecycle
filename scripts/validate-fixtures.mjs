import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

import { validateBilingualPair } from './lib/bilingual-pair.mjs';
import { ERROR_CODES } from './lib/errors.mjs';
import { getSchemaValidator } from './lib/schema-registry.mjs';
import { validateJson } from './lib/validate-json.mjs';

const JSON_PREFIX = 'json:';
const PAIR_VALIDATOR = 'bilingual-pair';
const PAIR_INPUTS = ['en', 'zh-CN', 'project_map'];
const ENTRY_FIELDS = ['expected_code', 'inputs', 'path', 'validator'];
const MANIFEST_FIELDS = ['fixtures', 'schema_version'];
const EXPECTED_CODES = new Set([
  'OK',
  ...Object.values(ERROR_CODES),
  'CURRENT_EVIDENCE_MISSING',
  'FACT_BLOCK_MALFORMED',
  'FACT_ID_DUPLICATE',
  'PAIR_MACHINE_MISMATCH',
  'PAIR_SECTION_MISMATCH',
]);

const compareCodePoints = (left, right) => {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
};
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const manifestError = (path) => ({ code: 'FIXTURE_MANIFEST_INVALID', path });
const suiteError = () => ({
  ok: false,
  results: [],
  errors: [{ code: 'FIXTURE_SUITE_ERROR', path: '/' }],
});

const insideRoot = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const canonicalPath = (path) => {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\\')) return null;
  if (posix.isAbsolute(path) || /^[A-Za-z]:/.test(path)) return null;
  const canonical = posix.normalize(path);
  if (canonical === '.' || canonical === '..' || canonical.startsWith('../')) return null;
  return canonical;
};

const canonicalInputPath = (fixturePath, input) => {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\\')) return null;
  if (posix.isAbsolute(input) || /^[A-Za-z]:/.test(input)) return null;
  return canonicalPath(posix.join(fixturePath, input));
};

const sortedManifestErrors = (errors) => errors.sort((left, right) => (
  compareCodePoints(left.path, right.path) || compareCodePoints(left.code, right.code)
));

const validateManifest = (manifest) => {
  if (!isRecord(manifest)) return { errors: [manifestError('/')], fixtures: [] };
  const errors = [];
  for (const field of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.includes(field)) errors.push(manifestError(`/${field}`));
  }
  if (manifest.schema_version !== 1) errors.push(manifestError('/schema_version'));
  if (!Array.isArray(manifest.fixtures)) {
    errors.push(manifestError('/fixtures'));
    return { errors: sortedManifestErrors(errors), fixtures: [] };
  }

  const fixtures = [];
  for (const [index, entry] of manifest.fixtures.entries()) {
    const entryPath = `/fixtures/${index}`;
    if (!isRecord(entry)) {
      errors.push(manifestError(entryPath));
      continue;
    }
    const entryErrors = [];
    for (const field of Object.keys(entry)) {
      if (!ENTRY_FIELDS.includes(field)) entryErrors.push(manifestError(`${entryPath}/${field}`));
    }

    const path = canonicalPath(entry.path);
    if (!path) entryErrors.push(manifestError(`${entryPath}/path`));

    let validatorValid = false;
    if (entry.validator === PAIR_VALIDATOR) {
      validatorValid = true;
    } else if (typeof entry.validator === 'string' && entry.validator.startsWith(JSON_PREFIX)) {
      const kind = entry.validator.slice(JSON_PREFIX.length);
      validatorValid = Boolean(kind && getSchemaValidator(kind));
    }
    if (!validatorValid) entryErrors.push(manifestError(`${entryPath}/validator`));

    if (typeof entry.expected_code !== 'string' || !EXPECTED_CODES.has(entry.expected_code)) {
      entryErrors.push(manifestError(`${entryPath}/expected_code`));
    }

    let inputs;
    if (entry.validator === PAIR_VALIDATOR) {
      if (!isRecord(entry.inputs)) {
        entryErrors.push(manifestError(`${entryPath}/inputs`));
      } else {
        inputs = {};
        for (const field of Object.keys(entry.inputs)) {
          if (!PAIR_INPUTS.includes(field)) entryErrors.push(manifestError(`${entryPath}/inputs/${field}`));
        }
        for (const field of PAIR_INPUTS) {
          const canonical = path ? canonicalInputPath(path, entry.inputs[field]) : null;
          if (!canonical) entryErrors.push(manifestError(`${entryPath}/inputs/${field}`));
          else inputs[field] = canonical;
        }
      }
    } else if ('inputs' in entry) {
      entryErrors.push(manifestError(`${entryPath}/inputs`));
    }

    errors.push(...entryErrors);
    if (entryErrors.length === 0) fixtures.push({
      path,
      validator: entry.validator,
      expected_code: entry.expected_code,
      ...(inputs ? { inputs } : {}),
    });
  }

  return { errors: sortedManifestErrors(errors), fixtures };
};

const resolveListedPath = async (root, path) => {
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
      paths.push(posix.normalize(relative(root, absolute).split(sep).join('/')));
    }
  }
  return paths;
};

const declaredFiles = (entry) => entry.validator.startsWith(JSON_PREFIX)
  ? [entry.path]
  : Object.values(entry.inputs);

const validateEntry = async (root, entry) => {
  if (entry.validator.startsWith(JSON_PREFIX)) {
    const path = await resolveListedPath(root, entry.path);
    if (!path) return { ok: false, errors: [{ code: 'FIXTURE_PATH_INVALID' }] };
    const value = JSON.parse(await readFile(path, 'utf8'));
    return validateJson(entry.validator.slice(JSON_PREFIX.length), value);
  }

  const enPath = await resolveListedPath(root, entry.inputs.en);
  const zhPath = await resolveListedPath(root, entry.inputs['zh-CN']);
  const mapPath = await resolveListedPath(root, entry.inputs.project_map);
  if (!enPath || !zhPath || !mapPath) {
    return { ok: false, errors: [{ code: 'FIXTURE_PATH_INVALID' }] };
  }
  const map = JSON.parse(await readFile(mapPath, 'utf8'));
  return validateBilingualPair(enPath, zhPath, map);
};

const validateFixturesUnchecked = async (rootValue) => {
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

  const declaration = validateManifest(manifest);
  if (declaration.errors.length > 0) {
    return { ok: false, results: [], errors: declaration.errors };
  }
  const { fixtures } = declaration;

  const seen = new Set();
  const duplicateErrors = [];
  for (const entry of fixtures) {
    if (seen.has(entry.path)) duplicateErrors.push({
      code: 'FIXTURE_MANIFEST_DUPLICATE',
      path: entry.path,
    });
    seen.add(entry.path);
  }
  if (duplicateErrors.length > 0) {
    duplicateErrors.sort((left, right) => compareCodePoints(left.path, right.path));
    return { ok: false, results: [], errors: duplicateErrors };
  }

  const declared = new Set(fixtures.flatMap(declaredFiles));
  const actual = await listFixtureFiles(root);
  const errors = actual
    .filter((path) => !declared.has(path))
    .map((path) => ({ code: 'FIXTURE_UNLISTED', path }))
    .sort((left, right) => compareCodePoints(left.path, right.path));

  const results = [];
  for (const entry of fixtures.toSorted((left, right) => compareCodePoints(left.path, right.path))) {
    let result;
    try {
      result = await validateEntry(root, entry);
    } catch {
      result = { ok: false, errors: [{ code: 'FIXTURE_READ_ERROR' }] };
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

export const validateFixtures = async (rootValue) => {
  try {
    return await validateFixturesUnchecked(rootValue);
  } catch {
    return suiteError();
  }
};
