import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const hosts = ['codex', 'claude', 'cursor', 'dsh', 'kimi', 'zcode'];
const operations = [
  'ASK_USER', 'CREATE_REVIEW_REQUEST', 'FETCH_REMOTE', 'READ_FILE',
  'RUN_COMMAND', 'RUN_VALIDATOR', 'SEARCH_FILES', 'WRITE_FILE',
];
const read = (path) => readFile(new URL(path, root), 'utf8');
const supportMatrix = JSON.parse(await read('tests/harnesses/support-matrix.json'));

test('defines the eight host-neutral harness operations exactly once', async () => {
  const contract = await read('references/harness-tool-contract.md');
  assert.deepEqual(
    [...contract.matchAll(/^### ([A-Z_]+)$/gmu)].map(([, id]) => id).sort(),
    operations,
  );
  assert.doesNotMatch(contract, /Codex|Claude|Cursor|Kimi|ZCode/u);
});

test('maps every operation once for each host without copying lifecycle semantics', async () => {
  for (const host of hosts) {
    const map = await read(`integrations/${host}/tool-map.md`);
    const mapped = [...map.matchAll(/^- ([A-Z_]+): `([^`]+)`$/gmu)];
    assert.deepEqual(mapped.map(([, id]) => id).sort(), operations, host);
    assert.equal(new Set(mapped.map(([, id]) => id)).size, operations.length, host);
    assert.match(map, /skills\/maintain-project-knowledge\/SKILL\.md/u, host);
    assert.match(map, /skills\/run-prd-lifecycle\/SKILL\.md/u, host);
    assert.match(map, /bin\/project-lifecycle/u, host);
    assert.match(map, /^## Unsupported operations$/mu, host);
    assert.doesNotMatch(map, /FEEDBACK_ONLY|PRD_DELIVERY|KNOWLEDGE_ONLY|QUICK_TASK|schema_version/iu, host);
  }
});

test('keeps install guides native, version-pinned, and honest about support', async () => {
  for (const host of hosts) {
    const guide = await read(`integrations/${host}/README.md`);
    assert.match(guide, /0\.1\.0/u, host);
    assert.match(
      guide,
      new RegExp(`Evidence status: \`${supportMatrix.hosts[host].status}\``),
      `${host} guide must match the retained support matrix`,
    );
    assert.match(guide, /maintain-project-knowledge/u, host);
    assert.match(guide, /run-prd-lifecycle/u, host);
    assert.match(guide, /bin\/project-lifecycle/u, host);
    assert.doesNotMatch(guide, /\/Users\/|[A-Za-z]:\\/u, host);
    assert.doesNotMatch(guide, /SUPPORTED/u, host);
  }
  assert.match(await read('integrations/codex/README.md'), /codex plugin add project-lifecycle@project-lifecycle/u);
  assert.match(await read('integrations/claude/README.md'), /claude --plugin-dir <absolute-repository-path>/u);
  assert.match(await read('integrations/kimi/README.md'), /\/plugins install/u);
  assert.match(await read('integrations/zcode/README.md'), /marketplace/u);
  assert.match(await read('integrations/dsh/README.md'), /dsh plugin/u);
});
