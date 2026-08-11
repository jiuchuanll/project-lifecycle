import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

test('help lists only implemented phase-one commands', () => {
  const output = execFileSync(process.execPath, ['scripts/bin/project-lifecycle.mjs', 'help'], {
    encoding: 'utf8',
  });
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(output.trimEnd().split('\n').length, 1);
  assert.match(output, /validate-json/);
  assert.match(output, /validate-pair/);
  assert.match(output, /parse-facts/);
  assert.match(output, /validate-fixtures/);
  assert.doesNotMatch(output, /bootstrap-project/);
});

test('version emits one JSON result envelope', () => {
  const output = execFileSync(process.execPath, ['scripts/bin/project-lifecycle.mjs', 'version'], {
    encoding: 'utf8',
  });

  assert.deepEqual(JSON.parse(output), { ok: true, value: { version: '0.3.0' }, errors: [] });
  assert.equal(output.trimEnd().split('\n').length, 1);
});

test('unknown commands report the CLI error code and exit 2', () => {
  const result = spawnSync(process.execPath, ['scripts/bin/project-lifecycle.mjs', 'unsupported-command'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    value: null,
    errors: [{
      code: 'CLI_UNKNOWN_COMMAND',
      path: '/command',
      message: 'Unknown command.',
    }],
  });
});
