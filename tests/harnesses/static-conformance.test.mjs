import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runNativeScenario } from '../../scripts/harnesses/run-native.mjs';
import { runStaticConformance } from '../../scripts/harnesses/static-conformance.mjs';
import { validateTrace } from '../../scripts/harnesses/trace.mjs';
import { createFakeProcessRunner } from '../helpers/fake-process-runner.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('../fixtures/harnesses/smoke-project', import.meta.url));
const validTrace = () => ({
  run_id: 'codex-smoke-1',
  scenario_id: 'smoke-project',
  run_number: 1,
  plugin: { version: '0.1.0', commit: 'a'.repeat(40) },
  host: { id: 'codex', version: '1.0.0' },
  model: { identity: 'test-model', revision: 'model-revision-1' },
  parameters: { temperature: 0 },
  fixture_hash: `sha256:${'b'.repeat(64)}`,
  knowledge_baseline: 'baseline:smoke',
  started_at: '2026-08-09T00:00:00.000Z',
  ended_at: '2026-08-09T00:01:00.000Z',
  allowed_context_ids: ['smoke-domain'],
  result: 'PASS',
  raw_output_locator: 'traces/codex/smoke-project/1.raw.txt',
  invariant_evaluation: { status: 'PASS', evidence_refs: ['trace:smoke'] },
  semantic_review: {
    status: 'PASS', reviewer_ref: 'reviewer:human', reason_ref: 'review:smoke', evidence_refs: ['trace:smoke'],
  },
});

test('passes static package conformance without host-local Skill copies', async () => {
  const result = await runStaticConformance({ root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.skill_ids, ['maintain-project-knowledge', 'run-prd-lifecycle']);
  assert.deepEqual(result.value.host_ids, ['claude', 'codex', 'cursor', 'kimi', 'zcode']);
  assert.equal(result.value.bundle_version, '0.1.0');
});

test('requires complete auditable PASS trace metadata', () => {
  assert.equal(validateTrace(validTrace()).ok, true);
  for (const field of ['raw_output_locator', 'invariant_evaluation']) {
    const candidate = validTrace();
    delete candidate[field];
    const result = validateTrace(candidate);
    assert.equal(result.ok, false, field);
    assert.equal(result.errors[0].code, 'TRACE_INVALID');
  }
});

test('runs one prompt in a copied fixture with argv-only fake process evidence', async (context) => {
  const traceRoot = await mkdtemp(join(tmpdir(), 'project-lifecycle-trace-'));
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  const processRunner = createFakeProcessRunner([{ ok: true, code: 0, stdout: '{"route":"smoke"}\n', stderr: '' }]);
  const runner = { ...processRunner, resolveExecutable: async (name) => name === 'fake-host' ? '/opt/fake-host' : null };

  const result = await runNativeScenario({
    host: 'codex',
    executable: 'fake-host',
    version: '1.0.0',
    model: { identity: 'test-model', revision: 'model-revision-1' },
    parameters: { temperature: 0 },
    fixtureRoot,
    fixtureHash: `sha256:${'b'.repeat(64)}`,
    knowledgeBaseline: 'baseline:smoke',
    scenarioId: 'smoke-project',
    runNumber: 1,
    pluginCommit: 'a'.repeat(40),
    prompt: 'Inspect the bounded smoke fixture.',
    buildArgs: (prompt) => ['run', '--prompt', prompt],
    allowedContextIds: ['smoke-domain'],
    traceRoot,
    runner,
    clock: (() => {
      const values = ['2026-08-09T00:00:00.000Z', '2026-08-09T00:01:00.000Z'];
      return () => values.shift();
    })(),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.status, 'captured');
  assert.equal(result.value.trace.result, 'NEEDS_REVIEW');
  assert.deepEqual(runner.calls[0].args, ['run', '--prompt', 'Inspect the bounded smoke fixture.']);
  assert.equal(runner.calls[0].options.timeoutMs, 120_000);
  assert.notEqual(runner.calls[0].options.cwd, fixtureRoot);
  assert.doesNotMatch(runner.calls[0].args.join(' '), /danger|bypass|skip.*approval/iu);
});

test('reports a missing native executable honestly without creating support evidence', async () => {
  const processRunner = createFakeProcessRunner();
  const runner = { ...processRunner, resolveExecutable: async () => null };
  const result = await runNativeScenario({
    host: 'zcode', executable: 'zcode', fixtureRoot, runner,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { status: 'UNAVAILABLE', host: 'zcode', trace: null });
  assert.equal(runner.calls.length, 0);
});

test('redacts owned fixture paths before retaining raw native output', async (context) => {
  const traceRoot = await mkdtemp(join(tmpdir(), 'project-lifecycle-trace-'));
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  const runner = {
    resolveExecutable: async () => '/opt/fake-host',
    runProcess: async (_command, _args, options) => ({
      ok: true, code: 0, stdout: `copied=${options.cwd}`, stderr: `source=${fixtureRoot}`,
    }),
  };
  const result = await runNativeScenario({
    host: 'codex', executable: 'fake-host', fixtureRoot, runner,
    version: '1.0.0', scenarioId: 'smoke-project', runNumber: 1,
    fixtureHash: `sha256:${'b'.repeat(64)}`, knowledgeBaseline: 'baseline:smoke',
    pluginCommit: 'a'.repeat(40), prompt: 'Inspect the bounded smoke fixture.',
    buildArgs: (prompt) => ['run', '--prompt', prompt], allowedContextIds: ['smoke-domain'],
    traceRoot, model: { identity: 'test-model', revision: 'model-revision-1' },
    parameters: { temperature: 0 }, clock: (() => {
      const values = ['2026-08-09T00:00:00.000Z', '2026-08-09T00:01:00.000Z'];
      return () => values.shift();
    })(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const raw = await readFile(join(traceRoot, 'codex', 'smoke-project', '1.raw.json'), 'utf8');
  assert.doesNotMatch(raw, new RegExp(fixtureRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(raw, /<native-fixture>/u);
});
