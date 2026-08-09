import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createError } from '../lib/errors.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';
import { fail, ok } from '../lib/result.mjs';
import { validateTrace } from './trace.mjs';

const failure = () => fail([createError('NATIVE_RUN_INVALID', '/', 'Native harness input or output is invalid.')]);
const forbidden = /(?:^|[-_])(danger|bypass|skip[-_]?approval)(?:$|[-_])/iu;
const redactOwnedPaths = (value, roots) => roots
  .filter((root) => typeof root === 'string' && root.length > 0)
  .sort((left, right) => right.length - left.length)
  .reduce((result, root) => result.replaceAll(root, '<native-fixture>'), String(value ?? ''));

export async function runNativeScenario(input = {}) {
  const { host, executable, fixtureRoot, runner } = input;
  if (!isSafeReference(host) || !isSafeReference(executable)
    || typeof fixtureRoot !== 'string' || !isAbsolute(fixtureRoot)
    || typeof runner?.resolveExecutable !== 'function' || typeof runner?.runProcess !== 'function') return failure();
  const resolved = await runner.resolveExecutable(executable);
  if (!resolved) return ok({ status: 'UNAVAILABLE', host, trace: null });
  const required = ['version', 'scenarioId', 'fixtureHash', 'knowledgeBaseline', 'pluginCommit', 'prompt'];
  if (required.some((key) => typeof input[key] !== 'string')
    || !Number.isInteger(input.runNumber) || typeof input.buildArgs !== 'function'
    || !isAbsolute(input.traceRoot) || !Array.isArray(input.allowedContextIds)
    || typeof input.clock !== 'function') return failure();
  const args = input.buildArgs(input.prompt);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || forbidden.test(arg))) return failure();
  const workingRoot = await mkdtemp(join(tmpdir(), 'project-lifecycle-native-'));
  try {
    const fixtureCopy = join(workingRoot, 'fixture');
    await cp(fixtureRoot, fixtureCopy, { recursive: true });
    const startedAt = input.clock();
    const processResult = await runner.runProcess(resolved, args, { cwd: fixtureCopy, timeoutMs: 120_000 });
    const endedAt = input.clock();
    const traceDirectory = join(input.traceRoot, host, input.scenarioId);
    await mkdir(traceDirectory, { recursive: true });
    const rawOutputLocator = `traces/${host}/${input.scenarioId}/${input.runNumber}.raw.json`;
    const ownedRoots = [fixtureRoot, fixtureCopy, workingRoot];
    await writeFile(join(traceDirectory, `${input.runNumber}.raw.json`), `${JSON.stringify({
      stdout: redactOwnedPaths(processResult.stdout, ownedRoots),
      stderr: redactOwnedPaths(processResult.stderr, ownedRoots),
      exit_code: processResult.code ?? null,
    })}\n`);
    const candidate = {
      run_id: `${host}-${input.scenarioId}-${input.runNumber}`,
      scenario_id: input.scenarioId,
      run_number: input.runNumber,
      plugin: { version: '0.1.0', commit: input.pluginCommit },
      host: { id: host, version: input.version },
      model: input.model,
      parameters: input.parameters,
      fixture_hash: input.fixtureHash,
      knowledge_baseline: input.knowledgeBaseline,
      started_at: startedAt,
      ended_at: endedAt,
      allowed_context_ids: [...input.allowedContextIds],
      result: processResult.ok ? 'NEEDS_REVIEW' : 'FAIL',
      raw_output_locator: rawOutputLocator,
      invariant_evaluation: { status: 'PENDING', evidence_refs: [] },
      semantic_review: { status: 'PENDING', reviewer_ref: null, reason_ref: null, evidence_refs: [] },
    };
    const trace = validateTrace(candidate);
    if (!trace.ok) return trace;
    await writeFile(join(traceDirectory, `${input.runNumber}.jsonl`), `${JSON.stringify(trace.value)}\n`);
    return ok({ status: 'captured', trace: trace.value });
  } catch {
    return failure();
  } finally {
    await rm(workingRoot, { recursive: true, force: true });
  }
}

const hostExecutables = Object.freeze({ claude: 'claude', codex: 'codex', cursor: 'cursor', kimi: 'kimi', zcode: 'zcode' });
const resolveExecutable = async (name) => {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  return null;
};

export async function inspectNativeAvailability() {
  const hosts = {};
  for (const [host, executable] of Object.entries(hostExecutables)) {
    hosts[host] = { status: await resolveExecutable(executable) ? 'AVAILABLE_UNTESTED' : 'UNAVAILABLE' };
  }
  return ok({ hosts });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(await inspectNativeAvailability()));
}
