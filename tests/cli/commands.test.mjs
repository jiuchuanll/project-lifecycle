import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const validFacts = fileURLToPath(new URL(
  '../fixtures/contracts/knowledge-pairs/valid/knowledge/wiki-workspace-en.md',
  import.meta.url,
));
const validMap = fileURLToPath(new URL(
  '../fixtures/contracts/project-map/valid.json',
  import.meta.url,
));

const runCli = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/bin/project-lifecycle.mjs', ...args], {
    cwd: repositoryRoot,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stderr, stdout }));
});

const assertSingleEnvelope = (result) => {
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(envelope), ['ok', 'value', 'errors']);
  return envelope;
};

test('dispatches parse-facts and emits one JSON result envelope', async () => {
  const result = await runCli(['parse-facts', validFacts]);
  const envelope = assertSingleEnvelope(result);

  assert.equal(result.status, 0);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.value.map(({ fact_id: id }) => id), ['fact-wiki-layout-model']);
});

test('parse-facts reports malformed Markdown in one JSON result envelope', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-cli-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const file = join(directory, 'malformed.md');
  await writeFile(file, '<!-- /project-lifecycle:fact -->\nprivate-input-marker\n');

  const result = await runCli(['parse-facts', file]);
  const envelope = assertSingleEnvelope(result);

  assert.equal(result.status, 1);
  assert.equal(envelope.errors[0].code, 'FACT_BLOCK_MALFORMED');
  assert.equal(result.stdout.includes('private-input-marker'), false);
});

test('parse-facts reports a missing file with stable redacted diagnostics', async () => {
  const missing = join(tmpdir(), 'project-lifecycle-missing-private-name.md');
  const result = await runCli(['parse-facts', missing]);
  const envelope = assertSingleEnvelope(result);

  assert.equal(result.status, 2);
  assert.deepEqual(envelope.errors, [{
    code: 'CLI_READ_ERROR',
    path: '/file',
    message: 'Unable to read input file.',
  }]);
  assert.equal(result.stdout.includes(missing), false);
  assert.equal(result.stdout.includes('ENOENT'), false);
});

test('parse-facts reports usage errors in one JSON result envelope', async () => {
  const result = await runCli(['parse-facts']);
  const envelope = assertSingleEnvelope(result);

  assert.equal(result.status, 2);
  assert.deepEqual(envelope.errors, [{
    code: 'CLI_USAGE',
    path: '/arguments',
    message: 'Usage: parse-facts <file>.',
  }]);
});

test('validate-json reports malformed JSON with stable redacted diagnostics', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-cli-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const file = join(directory, 'private-map.json');
  await writeFile(file, '{"private-input-marker":');

  const result = await runCli(['validate-json', 'project-map', file]);
  const envelope = assertSingleEnvelope(result);

  assert.equal(result.status, 2);
  assert.deepEqual(envelope.errors, [{
    code: 'CLI_JSON_INVALID',
    path: '/file',
    message: 'Input file is not valid JSON.',
  }]);
  assert.equal(result.stdout.includes('private-input-marker'), false);
});

test('validate-json redacts input values from semantic validation diagnostics', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-cli-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const file = join(directory, 'project-map.json');
  const value = JSON.parse(await readFile(validMap, 'utf8'));
  value.domains[0].parent_id = 'private-parent-marker';
  await writeFile(file, JSON.stringify(value));

  const result = await runCli(['validate-json', 'project-map', file]);
  const envelope = assertSingleEnvelope(result);

  assert.equal(result.status, 1);
  assert.deepEqual(envelope.errors.find(({ path }) => path === '/domains/0/parent_id'), {
    code: 'REFERENCE_MISSING',
    path: '/domains/0/parent_id',
    message: 'Required reference is missing.',
  });
  assert.equal(result.stdout.includes('private-parent-marker'), false);
});
