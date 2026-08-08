import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseFactBlocks } from '../../scripts/lib/fact-blocks.mjs';
import { parseFrontmatter } from '../../scripts/lib/markdown.mjs';
import { getSchemaValidator } from '../../scripts/lib/schema-registry.mjs';

const validSource = async () => readFile(
  new URL('../fixtures/contracts/knowledge-pairs/valid/wiki-workspace-en.md', import.meta.url),
  'utf8',
);

const hasError = (result, code, path) => result.errors.some((error) => (
  error.code === code && error.path === path
));

test('parses strict capability Frontmatter and its canonical fact block', async () => {
  const source = await validSource();
  const frontmatter = parseFrontmatter(source);
  const facts = parseFactBlocks(source);

  assert.equal(frontmatter.ok, true);
  assert.deepEqual(frontmatter.value.data, {
    id: 'wiki-workspace',
    knowledge_state: 'current',
    paired_asset: 'wiki-workspace.md',
    last_verified_baseline: 'abc123',
    implementation_refs: ['repo:src/wiki'],
    verification_refs: ['test:wiki-layout'],
  });
  assert.equal(facts.ok, true);
  assert.deepEqual(facts.value, [{
    fact_id: 'fact-wiki-layout-model',
    revision: 4,
    evidence_refs: ['code-ref', 'test-ref'],
    last_verified_baseline: 'abc123',
    statement: 'Wiki workspace currently uses a three-column layout.',
    known_limits: '- Small-window mode still falls back to two columns.',
  }]);
});

test('rejects malformed fact YAML at a stable fact path', async () => {
  const source = (await validSource()).replace('revision: 4', 'revision: [');
  const result = parseFactBlocks(source);

  assert.equal(result.ok, false);
  assert.equal(hasError(result, 'FACT_BLOCK_MALFORMED', '/facts/0'), true);
});

test('rejects a fact metadata terminator with trailing content', async () => {
  const source = (await validSource()).replace('\n-->\n', '\n--> trailing\n');
  const result = parseFactBlocks(source);

  assert.equal(result.ok, false);
  assert.equal(hasError(result, 'FACT_BLOCK_MALFORMED', '/facts/0'), true);
});

test('rejects nested fact blocks', async () => {
  const source = (await validSource()).replace(
    'Wiki workspace currently uses a three-column layout.',
    '<!-- project-lifecycle:fact\nfact_id: nested\nrevision: 1\nevidence_refs:\n  - evidence\nlast_verified_baseline: abc123\n-->',
  );
  const result = parseFactBlocks(source);

  assert.equal(hasError(result, 'FACT_BLOCK_MALFORMED', '/facts/0'), true);
});

test('rejects unmatched opening and closing delimiters', async () => {
  const source = await validSource();
  const unmatchedOpen = parseFactBlocks(source.replace('<!-- /project-lifecycle:fact -->', ''));
  const unmatchedClose = parseFactBlocks(source.replace('<!-- project-lifecycle:fact', '<!-- project-lifecycle:not-a-fact'));

  assert.equal(hasError(unmatchedOpen, 'FACT_BLOCK_MALFORMED', '/facts/0'), true);
  assert.equal(hasError(unmatchedClose, 'FACT_BLOCK_MALFORMED', '/facts/0'), true);
});

test('rejects a closing delimiter with trailing content', async () => {
  const source = (await validSource()).replace(
    '<!-- /project-lifecycle:fact -->',
    '<!-- /project-lifecycle:fact --> trailing',
  );
  const result = parseFactBlocks(source);

  assert.equal(hasError(result, 'FACT_BLOCK_MALFORMED', '/facts/0'), true);
});

test('rejects duplicate fact IDs at the second fact path', async () => {
  const source = await validSource();
  const fact = source.slice(
    source.indexOf('### Wiki workspace layout'),
    source.indexOf('## Verification'),
  );
  const result = parseFactBlocks(`${source}\n${fact}`);

  assert.equal(hasError(result, 'FACT_ID_DUPLICATE', '/facts/1/fact_id'), true);
});

test('rejects a fact without a known-limits section', async () => {
  const source = (await validSource()).replace('#### Known limits\n\n', '');
  const result = parseFactBlocks(source);

  assert.equal(hasError(result, 'FACT_BLOCK_MALFORMED', '/facts/0/known_limits'), true);
});

test('rejects duplicate evidence references inside a fact', async () => {
  const source = (await validSource()).replace('  - test-ref', '  - code-ref');
  const result = parseFactBlocks(source);

  assert.equal(hasError(result, 'FACT_BLOCK_MALFORMED', '/facts/0/evidence_refs'), true);
});

for (const [name, edit, path] of [
  ['aliases', (source) => source.replace('fact_id: fact-wiki-layout-model', 'anchor: &fact fact-wiki-layout-model\nfact_id: *fact'), '/facts/0'],
  ['custom tags', (source) => source.replace('revision: 4', 'revision: !integer 4'), '/facts/0'],
  ['merge keys', (source) => source.replace('revision: 4', 'defaults: &defaults\n  revision: 4\n<<: *defaults'), '/facts/0'],
  ['unknown fields', (source) => source.replace('revision: 4', 'revision: 4\nunexpected: true'), '/facts/0/unexpected'],
  ['duplicate keys', (source) => source.replace('revision: 4', 'revision: 4\nrevision: 5'), '/facts/0'],
]) {
  test(`rejects fact YAML ${name}`, async () => {
    const result = parseFactBlocks(edit(await validSource()));

    assert.equal(hasError(result, 'FACT_BLOCK_MALFORMED', path), true);
  });
}

for (const [name, edit] of [
  ['malformed YAML', (source) => source.replace('knowledge_state: current', 'knowledge_state: [')],
  ['aliases', (source) => source.replace('id: wiki-workspace', 'id: &id wiki-workspace\npaired_id: *id')],
  ['custom tags', (source) => source.replace('id: wiki-workspace', 'id: !identifier wiki-workspace')],
  ['merge keys', (source) => source.replace('id: wiki-workspace', 'defaults: &defaults\n  id: wiki-workspace\n<<: *defaults')],
  ['duplicate keys', (source) => source.replace('id: wiki-workspace', 'id: wiki-workspace\nid: duplicate')],
]) {
  test(`rejects Frontmatter ${name}`, async () => {
    const result = parseFrontmatter(edit(await validSource()));

    assert.equal(hasError(result, 'FACT_BLOCK_MALFORMED', '/frontmatter'), true);
  });
}

test('registers a pending ledger that permits only complete open entries', () => {
  const validate = getSchemaValidator('pending-changes');
  const entry = {
    change_id: 'change-wiki-owner',
    kind: 'fact_ownership',
    trigger_refs: ['feedback:42'],
    affected_refs: ['fact:fact-wiki-layout-model'],
    proposed_disposition: 'REVALIDATE',
    risks: ['Owner may change routing.'],
    evidence_gaps: ['Approval is pending.'],
    review_state: 'open',
    created_at: '2026-08-08T10:00:00Z',
  };

  assert.equal(validate({ schema_version: 1, changes: [entry] }), true);

  for (const [field, value] of [
    ['kind', 'wording'],
    ['review_state', 'accepted'],
  ]) {
    const candidate = { schema_version: 1, changes: [{ ...entry, [field]: value }] };
    assert.equal(validate(candidate), false);
    assert.ok(validate.errors.some((error) => error.instancePath === `/changes/0/${field}`));
  }

  const incomplete = { schema_version: 1, changes: [{ ...entry }] };
  delete incomplete.changes[0].affected_refs;
  assert.equal(validate(incomplete), false);
  assert.ok(validate.errors.some((error) => (
    error.keyword === 'required' && error.params.missingProperty === 'affected_refs'
  )));
});

test('rejects current Frontmatter without verification evidence', async () => {
  const source = (await validSource()).replace(
    'verification_refs:\n  - test:wiki-layout',
    'verification_refs: []',
  );
  const result = parseFrontmatter(source);

  assert.equal(hasError(result, 'FACT_BLOCK_MALFORMED', '/frontmatter/verification_refs'), true);
});
