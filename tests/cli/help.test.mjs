import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('help lists only implemented phase-one commands', () => {
  const output = execFileSync(process.execPath, ['scripts/bin/project-lifecycle.mjs', 'help'], {
    encoding: 'utf8',
  });
  assert.match(output, /validate-json/);
  assert.match(output, /validate-pair/);
  assert.match(output, /parse-facts/);
  assert.doesNotMatch(output, /bootstrap-project/);
});
