import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

test('help lists all implemented commands in deterministic order', () => {
  const output = execFileSync(process.execPath, ['scripts/bin/project-lifecycle-source.mjs', 'help'], {
    encoding: 'utf8',
  });
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(output.trimEnd().split('\n').length, 1);
  assert.match(output, /validate-json/);
  assert.match(output, /validate-pair/);
  assert.match(output, /parse-facts/);
  assert.match(output, /validate-fixtures/);
  assert.deepEqual(result.value.commands, [
    'collect-evidence',
    'close-delivery',
    'generate-delivery-indexes',
    'inspect-delivery-layout',
    'materialize-delivery-asset',
    'migrate-delivery-layout',
    'parse-facts',
    'preview-delivery-layout-migration',
    'sync-alignment-review',
    'validate-alignment-feedback',
    'validate-delivery-layout',
    'validate-fixtures',
    'validate-json',
    'validate-pair',
  ]);
  assert.doesNotMatch(output, /bootstrap-project/);
});

test('version emits one JSON result envelope', () => {
  const output = execFileSync(process.execPath, ['scripts/bin/project-lifecycle-source.mjs', 'version'], {
    encoding: 'utf8',
  });

  assert.deepEqual(JSON.parse(output), { ok: true, value: { version: '0.4.0' }, errors: [] });
  assert.equal(output.trimEnd().split('\n').length, 1);
});

test('unknown commands report the CLI error code and exit 2', () => {
  const result = spawnSync(process.execPath, ['scripts/bin/project-lifecycle-source.mjs', 'unsupported-command'], {
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
