import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

test('help lists only implemented phase-one commands', () => {
  const output = execFileSync(process.execPath, ['scripts/bin/project-lifecycle.mjs', 'help'], {
    encoding: 'utf8',
  });
  assert.match(output, /validate-json/);
  assert.match(output, /validate-pair/);
  assert.match(output, /parse-facts/);
  assert.match(output, /validate-fixtures/);
  assert.doesNotMatch(output, /bootstrap-project/);
});

test('unknown commands report the CLI error code and exit 2', () => {
  const result = spawnSync(process.execPath, ['scripts/bin/project-lifecycle.mjs', 'unsupported-command'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLI_UNKNOWN_COMMAND/);
});
