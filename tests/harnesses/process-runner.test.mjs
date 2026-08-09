import assert from 'node:assert/strict';
import test from 'node:test';

import { createProcessRunner } from '../../scripts/adapters/process-runner.mjs';

test('terminates a native process at the declared timeout', async () => {
  const started = Date.now();
  const result = await createProcessRunner().runProcess(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 2_000)'],
    { timeoutMs: 25 },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, 'PROCESS_TIMEOUT');
  assert.ok(Date.now() - started < 1_000);
});
